/**
 * gemini-core.ts — Aether v2 backend powered by @google/gemini-cli-core
 *
 * Replaces claude-client.ts. Instead of spawning a CLI subprocess,
 * this module imports the Gemini CLI Core library directly and runs
 * the agent loop in-process. Events are mapped to the same SSE
 * format the frontend already understands.
 *
 * Key integration points:
 *   - Config singleton (initialized once per server lifecycle)
 *   - GeminiClient.sendMessageStream() → async generator of events
 *   - MessageBus for tool confirmation (permission) routing
 *   - PolicyEngine (TOML) for auto-approve rules
 */

import {
  Config,
  AuthType,
  ApprovalMode,
  GeminiEventType,
  MessageBusType,
  ToolConfirmationOutcome,
  type ServerGeminiStreamEvent,
} from '@google/gemini-cli-core';
import { randomUUID } from 'node:crypto';
import os from 'os';
import fs from 'fs';
import path from 'path';

import type {
  SSEEvent,
  TokenUsage,
  FileAttachment,
  PermissionRequestEvent,
} from '@/types';
import { isImageFile } from '@/types';
import { getSetting } from './db';
import { processAetherInitDirectives } from './aether-init';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeminiStreamOptions {
  prompt: string;
  workingDirectory?: string;
  model?: string;
  systemPrompt?: string;
  abortController?: AbortController;
  permissionMode?: string;
  files?: FileAttachment[];
  projectTag?: string;
}

/**
 * Pending confirmation request from the MessageBus.
 * Stored until the browser user responds via POST /api/chat/permission.
 */
interface PendingConfirmation {
  correlationId: string;
  details: unknown; // SerializableConfirmationDetails from bus
  createdAt: number;
  resolve: (response: {
    confirmed: boolean;
    outcome?: string;
  }) => void;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let config: InstanceType<typeof Config> | null = null;
let isInitialized = false;
let initPromise: Promise<void> | null = null;

/** Pre-read file content from aether:init directives — loaded once during init */
let preReadContent: string = '';

/**
 * Map of pending confirmation requests, keyed by correlationId.
 * Uses globalThis to survive module reloads in Next.js dev (Turbopack).
 */
const PENDING_KEY = '__geminiPendingConfirmations__' as const;

function getPendingMap(): Map<string, PendingConfirmation> {
  if (!(globalThis as Record<string, unknown>)[PENDING_KEY]) {
    (globalThis as Record<string, unknown>)[PENDING_KEY] = new Map<string, PendingConfirmation>();
  }
  return (globalThis as Record<string, unknown>)[PENDING_KEY] as Map<string, PendingConfirmation>;
}

const CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Active SSE controller — set during streamGemini(), used by the
 * MessageBus subscriber to push permission_request events to the browser.
 * Only one stream can be active at a time (Aether is single-user).
 */
let activeController: ReadableStreamDefaultController<string> | null = null;

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the Gemini Core singleton.
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * @param targetDir - default working directory (used for GEMINI.md discovery)
 */
export async function initGeminiCore(targetDir?: string): Promise<void> {
  if (isInitialized) return;
  if (initPromise) return initPromise;

  initPromise = _doInit(targetDir || process.cwd());
  await initPromise;
}

async function _doInit(targetDir: string): Promise<void> {
  try {
    const cwd = targetDir;
    const model = getSetting('default_model') || 'gemini-2.5-pro';

    // Process aether:init directives from GEMINI.md files.
    // This runs exec: commands (e.g. git pull) and pre-reads files
    // for injection into the preamble — BEFORE Core loads GEMINI.md.
    const initResult = processAetherInitDirectives(cwd);
    preReadContent = initResult.preReadContent;
    if (initResult.execCount > 0 || initResult.readCount > 0) {
      console.log(
        `[gemini-core] Processed aether:init directives: ${initResult.execCount} exec, ${initResult.readCount} read`,
      );
    }

    config = new Config({
      sessionId: randomUUID(),
      clientVersion: '2.0.0-aether',
      targetDir: cwd,
      cwd,
      model,
      debugMode: false,
      interactive: false,
      approvalMode: ApprovalMode.DEFAULT,
    });

    await config.initialize();
    await config.refreshAuth(AuthType.LOGIN_WITH_GOOGLE);

    // Subscribe to the confirmation bus for tool permission requests.
    // When the PolicyEngine decides ASK_USER, the bus emits a
    // TOOL_CONFIRMATION_REQUEST. We intercept it here and forward
    // it to the browser as an SSE event. The browser responds via
    // POST /api/chat/permission, which calls resolveConfirmation().
    const bus = config.getMessageBus();

    _subscribeConfirmationBus(bus);

    isInitialized = true;
    console.log('[gemini-core] Initialized successfully');
  } catch (err) {
    initPromise = null;
    config = null;
    throw err;
  }
}

/**
 * Subscribe to the MessageBus confirmation channel.
 * Extracted to a helper to keep _doInit() clean and avoid
 * TS generic inference issues with the Message union.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _subscribeConfirmationBus(bus: any): void {
  bus.subscribe(
    MessageBusType.TOOL_CONFIRMATION_REQUEST,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rawMsg: any) => {
      const msg = rawMsg as {
        type: string;
        correlationId: string;
        toolCall?: { name?: string; args?: Record<string, unknown> };
        details?: unknown;
      };
      const pendingMap = getPendingMap();

      // Create a promise that will be resolved when the user responds
      const confirmationPromise = new Promise<{
        confirmed: boolean;
        outcome?: string;
      }>((resolve) => {
        pendingMap.set(msg.correlationId, {
          correlationId: msg.correlationId,
          details: msg.details,
          createdAt: Date.now(),
          resolve,
        });

        // Auto-deny after timeout
        setTimeout(() => {
          if (pendingMap.has(msg.correlationId)) {
            resolve({ confirmed: false });
            pendingMap.delete(msg.correlationId);
          }
        }, CONFIRMATION_TIMEOUT_MS);
      });

      // Build a permission event matching the frontend's expected format
      const permEvent: PermissionRequestEvent = {
        permissionRequestId: msg.correlationId,
        toolName: msg.toolCall?.name || 'unknown',
        toolInput: (msg.toolCall?.args || {}) as Record<string, unknown>,
        toolUseId: msg.correlationId,
        description: _extractConfirmationTitle(msg.details),
      };

      // Push to the active SSE stream
      if (activeController) {
        try {
          activeController.enqueue(formatSSE({
            type: 'permission_request',
            data: JSON.stringify(permEvent),
          }));
        } catch {
          // Controller may be closed if the stream ended
        }
      }

      // Wait for user response, then publish back to the bus
      confirmationPromise.then((response) => {
        bus.publish({
          type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
          correlationId: msg.correlationId,
          confirmed: response.confirmed,
          outcome: response.confirmed
            ? (response.outcome || ToolConfirmationOutcome.ProceedOnce)
            : ToolConfirmationOutcome.Cancel,
        });
      });
    },
  );
}

/**
 * Extract a human-readable title from confirmation details.
 */
function _extractConfirmationTitle(details: unknown): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const d = details as Record<string, unknown>;
  if (typeof d.title === 'string') return d.title;

  // Build a title from the type
  switch (d.type) {
    case 'edit':
      return `Edit: ${d.filePath || d.fileName || 'file'}`;
    case 'exec':
      return `Run: ${d.command || 'command'}`;
    case 'mcp':
      return `MCP: ${d.toolDisplayName || d.toolName || 'tool'}`;
    case 'info':
      return `Info: ${d.prompt || ''}`;
    case 'ask_user':
      return 'Question from agent';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Permission resolution (called by POST /api/chat/permission)
// ---------------------------------------------------------------------------

/**
 * Resolve a pending confirmation request with the user's decision.
 * Returns true if found and resolved.
 */
export function resolveConfirmation(
  correlationId: string,
  approved: boolean,
): boolean {
  const pendingMap = getPendingMap();
  const entry = pendingMap.get(correlationId);
  if (!entry) return false;

  entry.resolve({
    confirmed: approved,
    outcome: approved
      ? ToolConfirmationOutcome.ProceedOnce
      : ToolConfirmationOutcome.Cancel,
  });
  pendingMap.delete(correlationId);
  return true;
}

// ---------------------------------------------------------------------------
// Aether preamble construction
// ---------------------------------------------------------------------------

function buildAetherPreamble(): string {
  const hostname = os.hostname();
  const platform = os.platform();
  const release = os.release();
  const envId =
    getSetting('memory_environment_id') ||
    `${hostname}-${platform}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  const lines: string[] = [
    '# Aether Environment',
    'This session is mediated by Aether, a web-based GUI wrapper around the Gemini CLI Core.',
    'You are NOT running in a raw CLI terminal. The user sees a rich web interface.',
    '',
    '## Machine environment',
    `- Environment ID: ${envId}`,
    `- Hostname: ${hostname}`,
    `- OS: ${platform} ${release}`,
    `- Shell: ${process.env.SHELL || process.env.COMSPEC || 'unknown'}`,
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
    '- The image must already exist on disk (e.g. saved by a previous tool call)',
    '- Do NOT call `plt.show()` — save figures with `plt.savefig()` and then embed them',
    '- Use `dpi=150, bbox_inches="tight"` for clean output',
  ];

  // GEMINI.md startup instructions
  lines.push(
    '',
    '## Startup behavior',
    'If your GEMINI.md contains startup instructions (e.g. "On Startup" section),',
    'execute them silently without narration, then address the user\'s request directly.',
  );

  // Pre-read content from aether:init directives
  if (preReadContent) {
    lines.push(
      '',
      'The files below were pre-loaded per GEMINI.md startup directives — do not re-read them.',
      'If GEMINI.md references additional startup actions not covered by the pre-loaded content,',
      'execute them silently.',
    );
  }

  // Memory system instructions
  const memoryEnabled = getSetting('memory_enabled') !== 'false';
  const memoryRepoPath = getSetting('memory_repo_path') || '';

  if (memoryEnabled && memoryRepoPath) {
    const enabledTriggers: string[] = [];
    if (getSetting('memory_trigger_explicit_rules') !== 'false') enabledTriggers.push('explicit_rules');
    if (getSetting('memory_trigger_corrections') !== 'false') enabledTriggers.push('corrections');
    if (getSetting('memory_trigger_error_recovery') !== 'false') enabledTriggers.push('error_recovery');
    if (getSetting('memory_trigger_project_status') !== 'false') enabledTriggers.push('project_status');
    if (getSetting('memory_trigger_project_shift') !== 'false') enabledTriggers.push('project_shift');

    const customRules = getSetting('memory_custom_rules') || '';
    const normPath = memoryRepoPath.replace(/\\/g, '/');

    lines.push(
      '',
      '## Memory System',
      `Aether has an automatic memory system. The memory repository is at: \`${normPath}\``,
      'You detect learnable moments during the conversation and write observations to the appropriate memory file using the edit tool (append a concise bullet point).',
      'Aether intercepts writes to the memory repo and shows them to the user as a toast notification for approval. Git commits are auto-approved for the memory repo.',
      '',
      '### Memory file targets',
      `- \`${normPath}/environments/${envId}.md\` — machine/environment-specific quirks (shell behavior, paths, OS workarounds)`,
      `- \`${normPath}/projects/<name>.md\` — project-specific learnings (default for most observations)`,
      `- \`${normPath}/projects/_general.md\` — null-project staging: observations not tied to any specific project`,
      `- \`${normPath}/me.md\` — user profile/communication preferences (rare, only for explicit user statements)`,
      `- \`${normPath}/workflows.md\` — cross-project workflow patterns (rare, only for explicitly stated general rules)`,
      '',
      '### Triggers — detect these and write observations:',
    );

    if (enabledTriggers.includes('explicit_rules')) {
      lines.push(
        '- **Explicit rule**: User states a preference or rule ("always do X", "never do Y", "I prefer...")',
        '  - Example: User says "Always use type annotations" → append `- Always use type annotations in Python code` to the project file',
      );
    }
    if (enabledTriggers.includes('corrections')) {
      lines.push(
        '- **User correction**: User corrects your output (factual, stylistic, or procedural)',
        '  - Example: User says "No, use pnpm not npm" → append `- Package manager: pnpm (not npm)` to the project file',
      );
    }
    if (enabledTriggers.includes('error_recovery')) {
      lines.push(
        `- **Error→recovery**: A tool call fails, you retry with a different approach, and it succeeds`,
        `  - Example: \`pip install\` fails, \`pip install --user\` works → append \`- pip requires --user flag on this machine\` to \`environments/${envId}.md\``,
      );
    }
    if (enabledTriggers.includes('project_status')) {
      lines.push(
        '- **Project status change**: A key decision, milestone, or direction shift occurs',
        '  - Example: "Let\'s switch from REST to GraphQL" → append `- [2024-02] Migrating API from REST to GraphQL` to the project file',
      );
    }
    if (enabledTriggers.includes('project_shift')) {
      lines.push(
        '- **Turn-project shift**: Conversation transitions between projects — scan the completed block for higher-order lessons before moving on',
        '  - Example: After 10 turns on project A, user switches to B → review A turns for any unrecorded patterns, emit observations, then proceed with B',
      );
    }

    lines.push(
      '',
      '### Per-turn project tagging',
      'As you work, mentally track which project each conversation turn relates to. This helps route observations to the correct project file.',
      '',
      '### Rules',
      '- Keep observations concise — append a single bullet point to the relevant file',
      '- Do NOT write noise — only genuinely learnable moments',
      '- The memory system runs silently. Do not mention memory writes to the user unless asked.',
      `- After writing observations, commit with: \`git -C ${normPath} add -A && git -C ${normPath} commit -m "auto: <brief description>"\``,
      '- Do NOT push — Aether handles push timing.',
    );

    const consolidationThreshold = parseInt(getSetting('memory_consolidation_threshold') || '15', 10);
    lines.push(
      '',
      '### Consolidation',
      `When a project file accumulates ${consolidationThreshold}+ observations, suggest a consolidation review:`,
      '"The [project] memory file has accumulated N observations. Would you like me to run a consolidation pass — reviewing observations, promoting generalizable patterns to me.md/workflows.md, and compacting the rest?"',
      'Only suggest this if you notice the file is large when reading it. Do not actively count or poll.',
    );

    if (customRules) {
      lines.push(
        '',
        '### Custom memorization rules (from user settings):',
        customRules,
      );
    }
  }

  // Append pre-read content at the end of the preamble
  if (preReadContent) {
    lines.push('', preReadContent);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// File attachment handling
// ---------------------------------------------------------------------------

/**
 * Save non-image file attachments to a temporary upload directory.
 * Returns the file paths on disk.
 */
function saveUploadedFiles(files: FileAttachment[], workDir: string): string[] {
  const uploadDir = path.join(workDir, '.aether-uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  const savedPaths: string[] = [];
  for (const file of files) {
    const safeName = path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const timestamp = Date.now();
    const filePath = path.join(uploadDir, `${timestamp}-${safeName}`);
    const buffer = Buffer.from(file.data, 'base64');
    fs.writeFileSync(filePath, buffer);
    savedPaths.push(filePath);
  }
  return savedPaths;
}

// ---------------------------------------------------------------------------
// Event mapping: Gemini → Aether SSE
// ---------------------------------------------------------------------------

/**
 * Map a ServerGeminiStreamEvent to an Aether SSEEvent.
 * Returns null for events we skip (e.g. model_info).
 */
function mapEventToSSE(event: ServerGeminiStreamEvent): SSEEvent | null {
  switch (event.type) {
    case GeminiEventType.Content:
      return {
        type: 'text',
        data: (event as { value: string }).value,
      };

    case GeminiEventType.Thought: {
      // ThoughtSummary — extract text. It may be a string or an object.
      const thought = (event as { value: unknown }).value;
      const text = typeof thought === 'string'
        ? thought
        : typeof thought === 'object' && thought !== null && 'thought' in thought
          ? String((thought as Record<string, unknown>).thought)
          : JSON.stringify(thought);
      // Emit thought as a status event (the frontend renders these inline)
      return {
        type: 'status',
        data: JSON.stringify({ thought: true, text }),
      };
    }

    case GeminiEventType.ToolCallRequest: {
      const req = (event as { value: {
        callId: string;
        name: string;
        args: Record<string, unknown>;
      } }).value;
      return {
        type: 'tool_use',
        data: JSON.stringify({
          id: req.callId,
          name: req.name,
          input: req.args,
        }),
      };
    }

    case GeminiEventType.ToolCallResponse: {
      const resp = (event as { value: {
        callId: string;
        responseParts?: Array<{ text?: string }>;
        error?: Error;
      } }).value;
      // Extract text from response parts
      const textParts: string[] = [];
      if (resp.responseParts) {
        for (const part of resp.responseParts) {
          if (part.text) textParts.push(part.text);
        }
      }
      return {
        type: 'tool_result',
        data: JSON.stringify({
          tool_use_id: resp.callId,
          content: textParts.join('\n') || (resp.error ? resp.error.message : ''),
          is_error: !!resp.error,
        }),
      };
    }

    case GeminiEventType.ToolCallConfirmation: {
      // The confirmation event fires when the bus emits a request.
      // We already handle this via the bus subscriber in _doInit(),
      // so we can skip emitting a duplicate SSE here.
      // But we emit a status update so the frontend knows a tool is pending.
      const conf = (event as { value: {
        request?: { name?: string; callId?: string };
        details?: { type?: string; title?: string };
      } }).value;
      return {
        type: 'status',
        data: JSON.stringify({
          pending_confirmation: true,
          tool_name: conf.request?.name,
          title: conf.details?.title,
        }),
      };
    }

    case GeminiEventType.Finished: {
      const fin = (event as { value: {
        reason?: string;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
          thoughtsTokenCount?: number;
        };
      } }).value;

      const usage: TokenUsage | null = fin.usageMetadata
        ? {
            input_tokens: fin.usageMetadata.promptTokenCount || 0,
            output_tokens: fin.usageMetadata.candidatesTokenCount || 0,
            // Gemini doesn't have cache tokens — zero them out
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          }
        : null;

      return {
        type: 'result',
        data: JSON.stringify({
          subtype: 'success',
          is_error: false,
          reason: fin.reason,
          usage,
        }),
      };
    }

    case GeminiEventType.Error: {
      const err = (event as { value: {
        error?: { message?: string; status?: number };
      } }).value;
      return {
        type: 'error',
        data: err.error?.message || 'Unknown Gemini error',
      };
    }

    case GeminiEventType.ChatCompressed: {
      const info = (event as { value: {
        originalTokenCount?: number;
        newTokenCount?: number;
      } | null }).value;
      return {
        type: 'status',
        data: JSON.stringify({
          chat_compressed: true,
          original_tokens: info?.originalTokenCount,
          new_tokens: info?.newTokenCount,
        }),
      };
    }

    case GeminiEventType.ContextWindowWillOverflow: {
      const overflow = (event as { value: {
        estimatedRequestTokenCount?: number;
        remainingTokenCount?: number;
      } }).value;
      return {
        type: 'status',
        data: JSON.stringify({
          context_overflow_warning: true,
          estimated_tokens: overflow.estimatedRequestTokenCount,
          remaining_tokens: overflow.remainingTokenCount,
        }),
      };
    }

    case GeminiEventType.Citation:
      return {
        type: 'status',
        data: JSON.stringify({
          citation: true,
          text: (event as { value: string }).value,
        }),
      };

    case GeminiEventType.AgentExecutionStopped:
    case GeminiEventType.AgentExecutionBlocked: {
      const agentEvt = (event as { value: {
        reason?: string;
        systemMessage?: string;
      } }).value;
      return {
        type: 'status',
        data: JSON.stringify({
          agent_stopped: true,
          reason: agentEvt.reason,
          message: agentEvt.systemMessage,
        }),
      };
    }

    // Events we don't need to forward
    case GeminiEventType.ModelInfo:
    case GeminiEventType.Retry:
    case GeminiEventType.UserCancelled:
    case GeminiEventType.LoopDetected:
    case GeminiEventType.MaxSessionTurns:
    case GeminiEventType.InvalidStream:
      return null;

    default:
      // Unknown event type — log and skip
      console.warn(`[gemini-core] Unknown event type: ${(event as { type: string }).type}`);
      return null;
  }
}

// ---------------------------------------------------------------------------
// Memory observation interception
// ---------------------------------------------------------------------------

/**
 * Check if a tool call targets the memory repo and emit an observation event.
 * Returns true if this was a memory write (to help with auto-approve decisions).
 */
function checkMemoryWrite(
  controller: ReadableStreamDefaultController<string>,
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  const memoryEnabled = getSetting('memory_enabled') !== 'false';
  const memoryRepoPath = getSetting('memory_repo_path') || '';
  if (!memoryEnabled || !memoryRepoPath) return false;

  // Check edit/write file tools
  if (toolName === 'edit' || toolName === 'write_file') {
    const filePath = String(toolInput.file_path || toolInput.filePath || '');
    const normalizedFilePath = filePath.replace(/\\/g, '/').toLowerCase();
    const normalizedMemoryPath = memoryRepoPath.replace(/\\/g, '/').toLowerCase();
    if (normalizedFilePath.startsWith(normalizedMemoryPath)) {
      const autoApprove = getSetting('memory_auto_approve') === 'true';
      try {
        controller.enqueue(formatSSE({
          type: 'memory_observation' as SSEEvent['type'],
          data: JSON.stringify({
            file: filePath,
            tool: toolName,
            auto_approve: autoApprove,
          }),
        }));
      } catch {
        // Controller may be closed
      }
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Main streaming function
// ---------------------------------------------------------------------------

/**
 * Stream a Gemini response using Core's agent loop.
 * Returns a ReadableStream of SSE-formatted strings — same contract as
 * the old streamClaude() so the chat route can plug it in directly.
 */
export function streamGemini(options: GeminiStreamOptions): ReadableStream<string> {
  const {
    prompt,
    workingDirectory,
    model,
    systemPrompt,
    abortController,
    files,
  } = options;

  return new ReadableStream<string>({
    async start(controller) {
      // Register this controller as the active SSE target
      activeController = controller;

      try {
        // Ensure Core is initialized
        await initGeminiCore(workingDirectory || process.cwd());

        if (!config) {
          throw new Error('Gemini Core failed to initialize');
        }

        // If a different model is requested, update config
        // (Core supports mid-session model switching)
        if (model) {
          // The Config object's model is set at construction, but
          // the client respects the model from config for each turn.
          // For now, note that model switching will be handled at
          // the Config level in a future iteration.
        }

        // Build the prompt text, incorporating file attachments
        let finalPromptText = prompt;

        if (files && files.length > 0) {
          const imageFiles = files.filter(f => isImageFile(f.type));
          const nonImageFiles = files.filter(f => !isImageFile(f.type));

          // Save non-image files to disk for read_file tool access
          if (nonImageFiles.length > 0) {
            const workDir = workingDirectory || process.cwd();
            const savedPaths = saveUploadedFiles(nonImageFiles, workDir);
            const fileReferences = savedPaths
              .map((p, i) => `[User attached file: ${p} (${nonImageFiles[i].name})]`)
              .join('\n');
            finalPromptText = `${fileReferences}\n\nPlease read the attached file(s) above using your read_file tool, then respond to the user's message:\n\n${prompt}`;
          }

          // Image files: Gemini supports inline images via Parts.
          // For now, save to disk and reference in prompt (same as non-images).
          // TODO: Switch to multimodal Parts once we verify the Part type.
          if (imageFiles.length > 0) {
            const workDir = workingDirectory || process.cwd();
            const savedPaths = saveUploadedFiles(imageFiles, workDir);
            const imageRefs = savedPaths
              .map((p, i) => `[User attached image: ${p} (${imageFiles[i].name})]`)
              .join('\n');
            finalPromptText = `${imageRefs}\n\n${finalPromptText}`;
          }
        }

        // Build the Aether preamble and inject it into the prompt.
        // Gemini Core loads GEMINI.md natively, but we prepend our
        // Aether-specific instructions as a system context block.
        const preamble = buildAetherPreamble();
        const contextParts = [preamble, systemPrompt].filter(Boolean);

        // If there's context to inject, prepend it to the prompt
        // wrapped in a system-context block.
        if (contextParts.length > 0) {
          const contextBlock = contextParts.join('\n\n');
          finalPromptText = `<system-context>\n${contextBlock}\n</system-context>\n\n${finalPromptText}`;
        }

        // Emit initial status
        controller.enqueue(formatSSE({
          type: 'status',
          data: JSON.stringify({
            model: model || getSetting('default_model') || 'gemini-2.5-pro',
            backend: 'gemini-core',
          }),
        }));

        // Get the client and start streaming
        const client = config.getGeminiClient();
        const promptId = randomUUID();
        const signal = abortController?.signal || new AbortController().signal;

        const stream = client.sendMessageStream(
          [{ text: finalPromptText }],
          signal,
          promptId,
        );

        for await (const event of stream) {
          if (abortController?.signal.aborted) break;

          // Check for memory writes on tool requests
          if (event.type === GeminiEventType.ToolCallRequest) {
            const req = (event as { value: {
              name: string;
              args: Record<string, unknown>;
            } }).value;
            checkMemoryWrite(controller, req.name, req.args);
          }

          const sseEvent = mapEventToSSE(event);
          if (sseEvent) {
            controller.enqueue(formatSSE(sseEvent));
          }
        }

        // Stream complete
        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('[gemini-core] Stream error:', rawMessage);
        if (error instanceof Error && error.stack) {
          console.error('[gemini-core] Stack:', error.stack);
        }

        let errorMessage = rawMessage;

        // Add auth context hints
        if (rawMessage.includes('not initialized') || rawMessage.includes('auth')) {
          errorMessage += '\n\nGemini authentication may have expired. Run `gemini auth login` in a terminal to re-authenticate.';
        }

        controller.enqueue(formatSSE({ type: 'error', data: errorMessage }));
        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      } finally {
        // Clear active controller
        if (activeController === controller) {
          activeController = null;
        }
      }
    },

    cancel() {
      abortController?.abort();
      if (activeController === arguments[0]) {
        activeController = null;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Utility exports
// ---------------------------------------------------------------------------

/**
 * Check if Gemini Core is initialized and authenticated.
 */
export function isGeminiReady(): boolean {
  return isInitialized && config !== null;
}

/**
 * Get current auth state for the connection status UI.
 */
export function getGeminiAuthInfo(): { authenticated: boolean; method: string } {
  if (!isInitialized || !config) {
    return { authenticated: false, method: 'none' };
  }
  return { authenticated: true, method: 'google-oauth' };
}

/**
 * Dispose the Core config (for graceful shutdown).
 */
export function disposeGeminiCore(): void {
  if (config) {
    try {
      const client = config.getGeminiClient();
      client.dispose();
    } catch {
      // Ignore — client may not be initialized
    }
    config = null;
    isInitialized = false;
    initPromise = null;
    preReadContent = '';
  }
}
