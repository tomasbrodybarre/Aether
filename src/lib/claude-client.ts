import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  SDKSystemMessage,
  SDKToolProgressMessage,
  Options,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
  McpServerConfig,
  NotificationHookInput,
  PostToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeStreamOptions, SSEEvent, TokenUsage, MCPServerConfig, PermissionRequestEvent, FileAttachment } from '@/types';
import { isImageFile } from '@/types';
import { registerPendingPermission } from './permission-registry';
import { getSetting, getActiveProvider } from './db';
import { findClaudeBinary, findGitBash, getExpandedPath, getClaudeAuthInfo } from './platform';
import { readClaudeMdFiles } from './claude-md';
import os from 'os';
import fs from 'fs';
import path from 'path';

let cachedClaudePath: string | null | undefined;

function findClaudePath(): string | undefined {
  if (cachedClaudePath !== undefined) return cachedClaudePath || undefined;
  const found = findClaudeBinary();
  cachedClaudePath = found ?? null;
  return found;
}

/**
 * Convert our MCPServerConfig to the SDK's McpServerConfig format.
 * Supports stdio, sse, and http transport types.
 */
function toSdkMcpConfig(
  servers: Record<string, MCPServerConfig>
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    const transport = config.type || 'stdio';

    switch (transport) {
      case 'sse': {
        if (!config.url) {
          console.warn(`[mcp] SSE server "${name}" is missing url, skipping`);
          continue;
        }
        const sseConfig: McpSSEServerConfig = {
          type: 'sse',
          url: config.url,
        };
        if (config.headers && Object.keys(config.headers).length > 0) {
          sseConfig.headers = config.headers;
        }
        result[name] = sseConfig;
        break;
      }

      case 'http': {
        if (!config.url) {
          console.warn(`[mcp] HTTP server "${name}" is missing url, skipping`);
          continue;
        }
        const httpConfig: McpHttpServerConfig = {
          type: 'http',
          url: config.url,
        };
        if (config.headers && Object.keys(config.headers).length > 0) {
          httpConfig.headers = config.headers;
        }
        result[name] = httpConfig;
        break;
      }

      case 'stdio':
      default: {
        if (!config.command) {
          console.warn(`[mcp] stdio server "${name}" is missing command, skipping`);
          continue;
        }
        const stdioConfig: McpStdioServerConfig = {
          command: config.command,
          args: config.args,
          env: config.env,
        };
        result[name] = stdioConfig;
        break;
      }
    }
  }
  return result;
}

/**
 * Format an SSE line from an event object
 */
function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Extract text content from an SDK assistant message
 */
function extractTextFromMessage(msg: SDKAssistantMessage): string {
  const parts: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

/**
 * Extract token usage from an SDK result message
 */
function extractTokenUsage(msg: SDKResultMessage): TokenUsage | null {
  if (!msg.usage) return null;
  return {
    input_tokens: msg.usage.input_tokens,
    output_tokens: msg.usage.output_tokens,
    cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
    cost_usd: 'total_cost_usd' in msg ? msg.total_cost_usd : undefined,
  };
}

/**
 * Stream Claude responses using the Agent SDK.
 * Returns a ReadableStream of SSE-formatted strings.
 */
/**
 * Save non-image file attachments to a temporary upload directory
 * and return the file paths. The files are placed in .codepilot-uploads/
 * under the working directory so Claude's Read tool can access them.
 */
function saveUploadedFiles(files: FileAttachment[], workDir: string): string[] {
  const uploadDir = path.join(workDir, '.codepilot-uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  const savedPaths: string[] = [];
  for (const file of files) {
    // Sanitize filename to prevent directory traversal
    const safeName = path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const timestamp = Date.now();
    const filePath = path.join(uploadDir, `${timestamp}-${safeName}`);
    const buffer = Buffer.from(file.data, 'base64');
    fs.writeFileSync(filePath, buffer);
    savedPaths.push(filePath);
  }
  return savedPaths;
}

export function streamClaude(options: ClaudeStreamOptions): ReadableStream<string> {
  const {
    prompt,
    sdkSessionId,
    model,
    systemPrompt,
    workingDirectory,
    mcpServers,
    abortController,
    permissionMode,
    files,
    toolTimeoutSeconds = 0,
  } = options;

  return new ReadableStream<string>({
    async start(controller) {
      // Buffer stderr across try/catch so error handler can include CLI output
      let stderrBuffer = '';
      const STDERR_BUFFER_MAX = 2000;

      try {
        // Build env for the Claude Code subprocess.
        // Start with process.env.
        // Then overlay any API config the user set in CodePilot settings (optional).
        const sdkEnv: Record<string, string> = { ...process.env as Record<string, string> };

        // Force matplotlib to use non-interactive backend so figures save to files
        // instead of opening GUI windows. Our InlineFigures component picks up the
        // saved image paths from bash output and renders them inline.
        if (!sdkEnv.MPLBACKEND) {
          sdkEnv.MPLBACKEND = 'Agg';
        }

        // Prevent "nested session" detection — Aether is a wrapper, not a nested session
        delete sdkEnv.CLAUDECODE;

        // Ensure HOME/USERPROFILE are set so Claude Code can find ~/.claude/commands/
        if (!sdkEnv.HOME) sdkEnv.HOME = os.homedir();
        if (!sdkEnv.USERPROFILE) sdkEnv.USERPROFILE = os.homedir();
        // Ensure SDK subprocess has expanded PATH
        sdkEnv.PATH = getExpandedPath();

        // On Windows, auto-detect Git Bash if not already configured
        if (process.platform === 'win32' && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
          const gitBashPath = findGitBash();
          if (gitBashPath) {
            sdkEnv.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath;
          }
        }

        // Try to get config from active provider first
        const activeProvider = getActiveProvider();

        if (activeProvider && activeProvider.api_key) {
          // Clear all existing ANTHROPIC_* variables to prevent conflicts
          for (const key of Object.keys(sdkEnv)) {
            if (key.startsWith('ANTHROPIC_')) {
              delete sdkEnv[key];
            }
          }

          // Inject provider config — set both token variants so extra_env can clear the unwanted one
          sdkEnv.ANTHROPIC_AUTH_TOKEN = activeProvider.api_key;
          sdkEnv.ANTHROPIC_API_KEY = activeProvider.api_key;
          if (activeProvider.base_url) {
            sdkEnv.ANTHROPIC_BASE_URL = activeProvider.base_url;
          }

          // Inject extra environment variables
          // Empty string values mean "delete this variable" (e.g. clear ANTHROPIC_API_KEY for AUTH_TOKEN-only providers)
          try {
            const extraEnv = JSON.parse(activeProvider.extra_env || '{}');
            for (const [key, value] of Object.entries(extraEnv)) {
              if (typeof value === 'string') {
                if (value === '') {
                  delete sdkEnv[key];
                } else {
                  sdkEnv[key] = value;
                }
              }
            }
          } catch {
            // ignore malformed extra_env
          }
        } else {
          // No active provider — check legacy DB settings first, then fall back to
          // environment variables already present in process.env (copied into sdkEnv above).
          // This allows users who set ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL
          // in their shell environment to use them without configuring a provider in the UI.
          const appToken = getSetting('anthropic_auth_token');
          const appBaseUrl = getSetting('anthropic_base_url');
          if (appToken) {
            sdkEnv.ANTHROPIC_AUTH_TOKEN = appToken;
          }
          if (appBaseUrl) {
            sdkEnv.ANTHROPIC_BASE_URL = appBaseUrl;
          }
          // If neither legacy settings, env vars, nor CLI login provide auth, warn
          if (!appToken && !sdkEnv.ANTHROPIC_API_KEY && !sdkEnv.ANTHROPIC_AUTH_TOKEN) {
            const cliAuth = getClaudeAuthInfo();
            if (cliAuth.method !== 'cli') {
              console.warn('[claude-client] No authentication found: no active provider, no legacy settings, no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN in environment, and no CLI login (~/.claude/.credentials.json)');
            }
          }
        }

        // Check if dangerously_skip_permissions is enabled in app settings
        const skipPermissions = getSetting('dangerously_skip_permissions') === 'true';

        const queryOptions: Options = {
          cwd: workingDirectory || process.cwd(),
          abortController,
          includePartialMessages: true,
          permissionMode: skipPermissions
            ? 'bypassPermissions'
            : ((permissionMode as Options['permissionMode']) || 'acceptEdits'),
          env: sdkEnv,
        };

        if (skipPermissions) {
          queryOptions.allowDangerouslySkipPermissions = true;
        }

        // Find claude binary for packaged app where PATH is limited
        const claudePath = findClaudePath();
        if (claudePath) {
          queryOptions.pathToClaudeCodeExecutable = claudePath;
        }

        if (model) {
          queryOptions.model = model;
        }

        // Aether environment marker — tells Claude this is an Aether session and
        // what extra capabilities are available beyond raw CLI.
        const aetherPreamble = [
          '# Aether Environment',
          'This session is mediated by Aether, a web-based GUI wrapper around Claude Code.',
          'You are NOT running in a raw CLI terminal. The user sees a rich web interface.',
          '',
          '## Aether capabilities (not available in raw CLI):',
          '- **Inline image rendering**: You can embed images in your response text using markdown image syntax (see below). Supported: png, jpg, jpeg, gif, svg, webp, bmp, tiff.',
          '- **Rich text rendering**: Markdown, LaTeX ($...$ and $$...$$), syntax-highlighted code, and GFM tables all render natively in the chat. IMPORTANT: Single `$` is treated as a LaTeX delimiter. When writing currency amounts, always escape the dollar sign with a backslash (`\\$68,880` not `$68,880`) to prevent it from being parsed as math.',
          '- **Message queueing**: The user can queue a follow-up message while you are still streaming. They can also interrupt you (Escape or red Interrupt button) to force-send a message immediately.',
          '- **Labeled outputs**: Assistant messages are labeled Out[N] for easy reference.',
          '',
          '## How to render images inline:',
          'Embed images directly in your response text using markdown image syntax. This lets you place images exactly where they make sense in your narrative.',
          '- Syntax: `![description](/api/files/raw?path=ABSOLUTE_PATH&cwd=WORKING_DIR)`',
          '- Example: `![Correlation matrix](/api/files/raw?path=C%3A%2Fproject%2Ffigures%2Fcorr.png&cwd=C%3A%2Fproject)`',
          '- The path and cwd parameters must be URL-encoded (encodeURIComponent)',
          '- The image must already exist on disk (e.g. saved by a previous Bash tool call)',
          '- Do NOT call `plt.show()` — save figures with `plt.savefig()` and then embed them',
          '- Use `dpi=150, bbox_inches="tight"` for clean output',
        ].join('\n');

        // Read CLAUDE.md files from the working directory hierarchy,
        // execute aether:init directives (read: files, exec: commands)
        const cwd = workingDirectory || process.cwd();
        const { instructions: claudeMdInstructions, preReadContent } = readClaudeMdFiles(cwd);

        const silentStartupNote = preReadContent
          ? 'The files above were pre-loaded per CLAUDE.md startup directives — do not re-read them. If CLAUDE.md contains additional startup instructions not covered by the pre-loaded content, execute them silently without narration, then address the user\'s request directly.'
          : 'If CLAUDE.md contains startup instructions (e.g. "On Startup"), execute them silently without narration, then address the user\'s request directly.';

        const fullAppend = [
          aetherPreamble,
          claudeMdInstructions,
          preReadContent,
          silentStartupNote,
          systemPrompt,
        ].filter(Boolean).join('\n\n');

        queryOptions.systemPrompt = {
          type: 'preset',
          preset: 'claude_code',
          append: fullAppend,
        };

        if (mcpServers && Object.keys(mcpServers).length > 0) {
          queryOptions.mcpServers = toSdkMcpConfig(mcpServers);
        }

        // Resume session if we have an SDK session ID from a previous conversation turn
        if (sdkSessionId) {
          queryOptions.resume = sdkSessionId;
        }

        // Permission handler: sends SSE event and waits for user response
        queryOptions.canUseTool = async (toolName, input, opts) => {
          // Helper: SDK runtime Zod schema requires updatedInput (Record) even though .d.ts marks it optional
          const allow = () => ({ behavior: 'allow' as const, updatedInput: input });

          // --- Auto-approve read-only tools ---
          // These tools only read local filesystem state and are safe to run without user approval.
          // WebFetch/WebSearch are intentionally excluded — external content could contain prompt injection.
          if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
            return allow();
          }

          // Auto-approve read-only git operations on known safe repos
          if (toolName === 'Bash' && typeof input.command === 'string') {
            const cmd = input.command.trim();
            // Allow read-only git operations on claude-memory (relative path)
            if (/^git\s+(-C\s+\S*claude-memory\S*\s+)?(pull|fetch|status|log|diff)\b/.test(cmd) &&
                cmd.includes('claude-memory')) {
              return allow();
            }
            // Allow git pull/fetch/status on the shared memory and skills repos (absolute paths)
            if (/^git\s+-C\s+/.test(cmd) && /\b(pull|fetch|status|log|diff)\b/.test(cmd)) {
              const normalised = cmd.replace(/\\/g, '/').toLowerCase();
              if (normalised.includes('c:/claude-hub/memory') || normalised.includes('c:/claude-hub/skills')) {
                return allow();
              }
            }
          }

          const permissionRequestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          const permEvent: PermissionRequestEvent = {
            permissionRequestId,
            toolName,
            toolInput: input,
            suggestions: opts.suggestions as PermissionRequestEvent['suggestions'],
            decisionReason: opts.decisionReason,
            blockedPath: opts.blockedPath,
            toolUseId: opts.toolUseID,
            description: undefined,
          };

          // Send permission_request SSE event to the client
          controller.enqueue(formatSSE({
            type: 'permission_request',
            data: JSON.stringify(permEvent),
          }));

          // Wait for user response (resolved by POST /api/chat/permission)
          // Store original input so registry can inject updatedInput on allow
          return registerPendingPermission(permissionRequestId, input, opts.signal);
        };

        // Hooks: capture notifications and tool completion events
        queryOptions.hooks = {
          Notification: [{
            hooks: [async (input) => {
              const notif = input as NotificationHookInput;
              controller.enqueue(formatSSE({
                type: 'status',
                data: JSON.stringify({
                  notification: true,
                  title: notif.title,
                  message: notif.message,
                }),
              }));
              return {};
            }],
          }],
          PostToolUse: [{
            hooks: [async (input) => {
              const toolEvent = input as PostToolUseHookInput;
              controller.enqueue(formatSSE({
                type: 'tool_result',
                data: JSON.stringify({
                  tool_use_id: toolEvent.tool_use_id,
                  content: typeof toolEvent.tool_response === 'string'
                    ? toolEvent.tool_response
                    : JSON.stringify(toolEvent.tool_response),
                  is_error: false,
                }),
              }));
              return {};
            }],
          }],
        };

        // Capture real-time stderr output from Claude Code process
        queryOptions.stderr = (data: string) => {
          // Strip ANSI escape codes, OSC sequences, and control characters
          // but preserve tabs (\x09) and carriage returns (\x0D)
          const cleaned = data
            .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')   // CSI sequences (colors, cursor)
            .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '') // OSC sequences
            .replace(/\x1B\([A-Z]/g, '')               // Character set selection
            .replace(/\x1B[=>]/g, '')                   // Keypad mode
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // Control chars (keep \t \n \r)
            .replace(/\r\n/g, '\n')                    // Normalize CRLF
            .replace(/\r/g, '\n')                      // Convert remaining CR to LF
            .replace(/\n{3,}/g, '\n\n')                // Collapse multiple blank lines
            .trim();
          if (cleaned) {
            // Keep last N chars of stderr for error context
            stderrBuffer += (stderrBuffer ? '\n' : '') + cleaned;
            if (stderrBuffer.length > STDERR_BUFFER_MAX) {
              stderrBuffer = stderrBuffer.slice(-STDERR_BUFFER_MAX);
            }
            controller.enqueue(formatSSE({
              type: 'tool_output',
              data: cleaned,
            }));
          }
        };

        // Build the prompt with file attachments.
        // Images → sent as multimodal base64 content blocks (vision).
        // Non-image files → saved to disk and referenced via Read tool.
        let finalPrompt: string | AsyncIterable<SDKUserMessage> = prompt;

        if (files && files.length > 0) {
          const imageFiles = files.filter(f => isImageFile(f.type));
          const nonImageFiles = files.filter(f => !isImageFile(f.type));

          // Save non-image files to disk for Read tool access
          let textPrompt = prompt;
          if (nonImageFiles.length > 0) {
            const workDir = workingDirectory || process.cwd();
            const savedPaths = saveUploadedFiles(nonImageFiles, workDir);
            const fileReferences = savedPaths
              .map((p, i) => `[User attached file: ${p} (${nonImageFiles[i].name})]`)
              .join('\n');
            textPrompt = `${fileReferences}\n\nPlease read the attached file(s) above using your Read tool, then respond to the user's message:\n\n${prompt}`;
          }

          // If there are images, build a multimodal SDKUserMessage
          if (imageFiles.length > 0) {
            const contentBlocks: Array<
              | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
              | { type: 'text'; text: string }
            > = [];

            for (const img of imageFiles) {
              contentBlocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: img.type || 'image/png',
                  data: img.data,
                },
              });
            }

            contentBlocks.push({ type: 'text', text: textPrompt });

            const userMessage: SDKUserMessage = {
              type: 'user',
              message: {
                role: 'user',
                content: contentBlocks,
              },
              parent_tool_use_id: null,
              session_id: sdkSessionId || '',
            };

            // Create a single-message async iterable
            finalPrompt = (async function* () {
              yield userMessage;
            })();
          } else {
            finalPrompt = textPrompt;
          }
        }

        const conversation = query({
          prompt: finalPrompt,
          options: queryOptions,
        });

        let lastAssistantText = '';
        let tokenUsage: TokenUsage | null = null;

        for await (const message of conversation) {
          if (abortController?.signal.aborted) {
            break;
          }

          switch (message.type) {
            case 'assistant': {
              const assistantMsg = message as SDKAssistantMessage;
              // Text deltas are handled by stream_event for real-time streaming.
              // Only track lastAssistantText here and process tool_use blocks.
              const text = extractTextFromMessage(assistantMsg);
              if (text) {
                lastAssistantText = text;
              }

              // Check for tool use blocks
              for (const block of assistantMsg.message.content) {
                if (block.type === 'tool_use') {
                  controller.enqueue(formatSSE({
                    type: 'tool_use',
                    data: JSON.stringify({
                      id: block.id,
                      name: block.name,
                      input: block.input,
                    }),
                  }));
                }
              }
              break;
            }

            case 'user': {
              // Tool execution results come back as user messages with tool_result blocks
              const userMsg = message as SDKUserMessage;
              const content = userMsg.message.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'tool_result') {
                    const resultContent = typeof block.content === 'string'
                      ? block.content
                      : Array.isArray(block.content)
                        ? block.content
                            .filter((c: { type: string }) => c.type === 'text')
                            .map((c: { text: string }) => c.text)
                            .join('\n')
                        : String(block.content ?? '');
                    controller.enqueue(formatSSE({
                      type: 'tool_result',
                      data: JSON.stringify({
                        tool_use_id: block.tool_use_id,
                        content: resultContent,
                        is_error: block.is_error || false,
                      }),
                    }));
                  }
                }
              }
              break;
            }

            case 'stream_event': {
              const streamEvent = message as SDKPartialAssistantMessage;
              const evt = streamEvent.event;
              if (evt.type === 'content_block_delta' && 'delta' in evt) {
                const delta = evt.delta;
                if ('text' in delta && delta.text) {
                  controller.enqueue(formatSSE({ type: 'text', data: delta.text }));
                }
              }
              break;
            }

            case 'system': {
              const sysMsg = message as SDKSystemMessage;
              if ('subtype' in sysMsg) {
                if (sysMsg.subtype === 'init') {
                  controller.enqueue(formatSSE({
                    type: 'status',
                    data: JSON.stringify({
                      session_id: sysMsg.session_id,
                      model: sysMsg.model,
                      tools: sysMsg.tools,
                    }),
                  }));
                }
              }
              break;
            }

            case 'tool_progress': {
              const progressMsg = message as SDKToolProgressMessage;
              controller.enqueue(formatSSE({
                type: 'tool_output',
                data: JSON.stringify({
                  _progress: true,
                  tool_use_id: progressMsg.tool_use_id,
                  tool_name: progressMsg.tool_name,
                  elapsed_time_seconds: progressMsg.elapsed_time_seconds,
                }),
              }));
              // Auto-timeout: abort if tool runs longer than configured threshold
              if (toolTimeoutSeconds > 0 && progressMsg.elapsed_time_seconds >= toolTimeoutSeconds) {
                controller.enqueue(formatSSE({
                  type: 'tool_timeout',
                  data: JSON.stringify({
                    tool_name: progressMsg.tool_name,
                    elapsed_seconds: Math.round(progressMsg.elapsed_time_seconds),
                  }),
                }));
                abortController?.abort();
              }
              break;
            }

            case 'result': {
              const resultMsg = message as SDKResultMessage;
              tokenUsage = extractTokenUsage(resultMsg);
              controller.enqueue(formatSSE({
                type: 'result',
                data: JSON.stringify({
                  subtype: resultMsg.subtype,
                  is_error: resultMsg.is_error,
                  num_turns: resultMsg.num_turns,
                  duration_ms: resultMsg.duration_ms,
                  usage: tokenUsage,
                  session_id: resultMsg.session_id,
                }),
              }));
              break;
            }
          }
        }

        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : 'Unknown error';
        // Log full error details for server-side debugging
        console.error('[claude-client] Stream error:', rawMessage);
        if (error instanceof Error && error.stack) {
          console.error('[claude-client] Stack:', error.stack);
        }
        if (error && typeof error === 'object') {
          // Log any extra properties the SDK might attach (exitCode, stderr, cause, etc.)
          const extras = Object.keys(error).filter(k => k !== 'message' && k !== 'stack');
          if (extras.length > 0) {
            console.error('[claude-client] Extra error properties:', extras.map(k => `${k}=${JSON.stringify((error as Record<string, unknown>)[k])}`).join(', '));
          }
        }
        console.error('[claude-client] Stderr buffer:', stderrBuffer || '(empty)');

        // Enrich errors with stderr output and auth context
        let errorMessage = rawMessage;

        // Append buffered stderr — this is the actual reason the CLI failed
        if (stderrBuffer.trim()) {
          errorMessage += '\n\n**CLI output:**\n```\n' + stderrBuffer.trim() + '\n```';
        }

        // For exit code 1 errors, add auth context as a hint
        if (rawMessage.includes('exited with code 1') || rawMessage.includes('exit code 1')) {
          const authInfo = getClaudeAuthInfo();
          const activeProvider = getActiveProvider();
          if (authInfo.method === 'none' && !activeProvider?.api_key && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
            errorMessage += '\n\nNo authentication configured. Run `claude login` in a terminal to sign in with your Max subscription, or configure an API key in Settings > Providers.';
          } else if (authInfo.method === 'cli' && authInfo.expired) {
            errorMessage += '\n\nYour CLI login token has expired. Run `claude login` in a terminal to re-authenticate.';
          }
        }

        controller.enqueue(formatSSE({ type: 'error', data: errorMessage }));
        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      }
    },

    cancel() {
      abortController?.abort();
    },
  });
}
