/**
 * gemini-core.ts — Aether v2 backend powered by @google/gemini-cli-core
 *
 * Instead of spawning a CLI subprocess,
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
  PolicyDecision,
  GeminiEventType,
  MessageBusType,
  ToolConfirmationOutcome,
  Scheduler,
  ROOT_SCHEDULER_ID,
  type ServerGeminiStreamEvent,
  type ToolCallRequestInfo,
  type CompletedToolCall,
  type ToolCall,
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
import { getSetting, updateSessionProjectTag, updateTurnProjectTag, getRecentSaveCellEdits } from './db';
import { processAetherInitDirectives } from './aether-init';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lightweight turn context for preamble injection */
export interface TurnContext {
  prompt: string;
  response: string | null;
  project_tag: string | null;
  created_at: string;
}

export interface GeminiStreamOptions {
  prompt: string;
  workingDirectory?: string;
  model?: string;
  systemPrompt?: string;
  abortController?: AbortController;
  permissionMode?: string;
  files?: FileAttachment[];
  projectTag?: string;
  /** True when the projectTag was inherited from the most recent turn (not explicitly set) */
  tagInherited?: boolean;
  /** Recent turns for context injection into the preamble */
  recentTurns?: TurnContext[];
}

/**
 * Pending tool confirmation from the Scheduler.
 * When the Scheduler sets a tool to `awaiting_approval`, we store
 * the correlationId here so that when the browser user responds
 * via POST /api/chat/permission, we can publish a
 * TOOL_CONFIRMATION_RESPONSE to the MessageBus.
 */
interface PendingConfirmation {
  correlationId: string;
  toolName: string;
  createdAt: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bus: any; // MessageBus reference — survives HMR alongside globalThis pendingMap
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

// ---------------------------------------------------------------------------
// Process crash prevention
// ---------------------------------------------------------------------------
// Unhandled promise rejections (e.g. from Gemini Core internals, MessageBus,
// Scheduler) crash Node.js by default. This catches them so they're logged
// instead of killing the entire Next.js dev server.

const REJECTION_HANDLER_KEY = '__geminiRejectionHandler__' as const;
if (!(globalThis as Record<string, unknown>)[REJECTION_HANDLER_KEY]) {
  (globalThis as Record<string, unknown>)[REJECTION_HANDLER_KEY] = true;
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[gemini-core] ⚠ Unhandled promise rejection (caught, server NOT crashing):', reason);
    if (reason instanceof Error && reason.stack) {
      console.error('[gemini-core] Stack:', reason.stack);
    }
    // Prevent the process from crashing — the error is logged but contained.
    // The specific stream/turn that caused it will fail naturally via its
    // own try-catch or the SSE connection will close.
  });
}

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
    const model = getSetting('default_model') || 'gemini-3-pro';

    // Process aether:init directives from GEMINI.md files.
    // This runs exec: commands (e.g. git pull) and pre-reads files
    // for injection into the preamble — BEFORE Core loads GEMINI.md.
    const initResult = processAetherInitDirectives(cwd);
    preReadContent = initResult.preReadContent;
    if (initResult.execCount > 0 || initResult.readCount > 0) {
      console.log(
        `[gemini-core] Processed aether:init directives: ${initResult.execCount} exec, ${initResult.readCount} read`,
      );
    } else {
      console.warn(
        `[gemini-core] No aether:init directives found. preReadContent length: ${preReadContent.length}`,
      );
    }
    const knownProjects = _extractKnownProjectNames(preReadContent);
    console.log(`[gemini-core] Known projects from projects.md: ${knownProjects.length > 0 ? knownProjects.join(', ') : '(none — fallback will be used)'}`);


    // Shell inactivity timeout: configurable via Aether settings, default 120s
    const shellTimeoutSetting = getSetting('shell_inactivity_timeout');
    const shellInactivityTimeoutSeconds = shellTimeoutSetting
      ? parseInt(shellTimeoutSetting, 10) || 120
      : 120;

    config = new Config({
      sessionId: randomUUID(),
      clientVersion: '2.0.0-aether',
      targetDir: cwd,
      cwd,
      model,
      debugMode: false,
      interactive: true,
      approvalMode: ApprovalMode.DEFAULT,
      shellToolInactivityTimeout: shellInactivityTimeoutSeconds,
    });

    await config.initialize();

    // Use API key auth if GEMINI_API_KEY is set, otherwise OAuth
    const authType = process.env.GEMINI_API_KEY
      ? AuthType.USE_GEMINI
      : AuthType.LOGIN_WITH_GOOGLE;
    await config.refreshAuth(authType);
    console.log(`[gemini-core] Auth method: ${authType}`);

    // -----------------------------------------------------------------
    // Auto-approve policy rules (user tier 2.x — overrides defaults)
    // Common read-only actions, file edits, dev tools, and memory-repo
    // operations are auto-approved to reduce friction.
    // -----------------------------------------------------------------
    _addAutoApproveRules(config);

    isInitialized = true;
    console.log('[gemini-core] Initialized successfully');
  } catch (err) {
    initPromise = null;
    config = null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Auto-approve policy rules
// ---------------------------------------------------------------------------

/**
 * Add user-tier policy rules that auto-approve common safe operations.
 * Priority 2.5 (user tier) — higher than default tier 1.x rules,
 * so these reliably override the built-in ASK_USER defaults for
 * write.toml tools we consider safe in Aether's context.
 *
 * Auto-approved categories:
 *   - Read-only tools (glob, grep_search, list_directory, read_file,
 *     google_web_search) — reinforced at higher priority
 *   - File edits (write_file, replace) — Aether is an IDE
 *   - Dev tool shell commands (npm, python, cargo, etc.)
 *   - Safe git operations (status, log, diff, add, commit, etc.)
 *   - Constructive file ops (mkdir, cp, curl, etc.)
 *   - Git operations on memory/skills repos
 *   - web_fetch (for web search results)
 *   - write_todos (native Gemini Google Tasks tool)
 *
 * Still ASK_USER: rm, git push (non-memory), chmod, sudo, save_memory
 */
function _addAutoApproveRules(cfg: InstanceType<typeof Config>): void {
  const pe = cfg.getPolicyEngine();
  const PRIORITY = 2.5; // User tier, above defaults
  const SOURCE = 'Aether Auto-Approve';
  let ruleCount = 0;

  // ── 1. Read-only tools ─────────────────────────────────────────────
  const readOnlyTools = [
    'glob',
    'grep_search',
    'list_directory',
    'read_file',
    'google_web_search',
  ];
  for (const toolName of readOnlyTools) {
    pe.addRule({
      toolName,
      decision: PolicyDecision.ALLOW,
      priority: PRIORITY,
      source: SOURCE,
    });
    ruleCount++;
  }

  // ── 2. Write tools — allow unconditionally ─────────────────────────
  //    The model's primary editing tools. Aether is an IDE-like
  //    environment; file writes/edits are expected workflow.
  for (const toolName of ['write_file', 'replace']) {
    pe.addRule({
      toolName,
      decision: PolicyDecision.ALLOW,
      priority: PRIORITY,
      source: `${SOURCE} (file edits)`,
    });
    ruleCount++;
  }

  // ── 3. web_fetch — for retrieving web content ──────────────────────
  pe.addRule({
    toolName: 'web_fetch',
    decision: PolicyDecision.ALLOW,
    priority: PRIORITY,
    source: SOURCE,
  });
  ruleCount++;

  // ── 4. Native Gemini tools ──────────────────────────────────────────
  for (const toolName of ['write_todos', 'ask_user']) {
    pe.addRule({
      toolName,
      decision: PolicyDecision.ALLOW,
      priority: PRIORITY,
      source: `${SOURCE} (native tools)`,
    });
    ruleCount++;
  }

  // ── 5. save_memory — ASK_USER ──────────────────────────────────────
  //    Gemini's built-in memory tool writes to ~/.gemini/GEMINI.md which
  //    is separate from Aether's memory repo. Prompt the user so they
  //    can gate what goes into GEMINI.md vs the memory folder.
  pe.addRule({
    toolName: 'save_memory',
    decision: PolicyDecision.ASK_USER,
    priority: PRIORITY,
    source: SOURCE,
  });
  ruleCount++;

  // ── 6. Shell commands ──────────────────────────────────────────────
  //    argsPattern is matched against JSON.stringify(args), e.g.:
  //    {"command":"git status"} or {"command":"npm run dev"}
  //    Strategy: explicit allowlist of safe command prefixes.
  //    Anything not matched falls through to default ASK_USER.

  // 6a. Memory/skills git operations — uses configured memory_repo_path
  const safeGitOps = [
    'pull', 'fetch', 'status', 'log', 'diff', 'add', 'commit', 'push',
    'rev-parse', 'branch', 'remote',
  ].join('|');
  const memoryRepoPath = getSetting('memory_repo_path');
  if (memoryRepoPath) {
    // Build patterns for both forward-slash and backslash variants
    const memDir = path.dirname(memoryRepoPath);
    const repoPatterns = [
      memoryRepoPath,
      memoryRepoPath.replace(/\//g, '\\\\'),
      path.join(memDir, 'skills'),
      path.join(memDir, 'skills').replace(/\//g, '\\\\'),
    ].map(p => p.replace(/[/\\]/g, '[\\\\/\\\\\\\\]')).join('|');

    pe.addRule({
      toolName: 'run_shell_command',
      decision: PolicyDecision.ALLOW,
      priority: PRIORITY,
      argsPattern: new RegExp(`git\\s+-C\\s+(${repoPatterns})\\s+(${safeGitOps})`),
      source: `${SOURCE} (memory/skills git)`,
    });
    ruleCount++;
  }

  // 6b. Read-only shell commands
  const readOnlyCmds = [
    'ls', 'dir', 'pwd', 'which', 'where', 'echo', 'cat', 'head', 'tail',
    'wc', 'sort', 'diff', 'file', 'stat', 'du', 'df', 'env', 'whoami',
    'hostname', 'uname', 'date', 'tree', 'find', 'type', 'printenv',
    'realpath', 'dirname', 'basename',
  ].join('|');
  pe.addRule({
    toolName: 'run_shell_command',
    decision: PolicyDecision.ALLOW,
    priority: PRIORITY,
    argsPattern: new RegExp(`"command":"(${readOnlyCmds})[\\s"]`),
    source: `${SOURCE} (read-only shell)`,
  });
  ruleCount++;

  // 6c. Dev tool commands (npm, python, node, etc.)
  const devToolCmds = [
    'npm', 'npx', 'node', 'python', 'python3', 'pip', 'pip3',
    'tsc', 'tsx', 'eslint', 'prettier', 'jest', 'vitest', 'pytest',
    'cargo', 'go', 'make', 'cmake', 'dotnet', 'java', 'javac', 'mvn',
    'gradle', 'ruby', 'gem', 'bundle', 'pnpm', 'yarn', 'bun', 'deno',
    'powershell', 'pwsh',
  ].join('|');
  pe.addRule({
    toolName: 'run_shell_command',
    decision: PolicyDecision.ALLOW,
    priority: PRIORITY,
    argsPattern: new RegExp(`"command":"(${devToolCmds})[\\s"]`),
    source: `${SOURCE} (dev tools)`,
  });
  ruleCount++;

  // 6d. Git operations (read-only + safe local ops)
  //     Excludes: push (to non-memory repos), reset --hard, clean -f,
  //     rebase, force-push — those stay ASK_USER.
  const safeGitSubcmds = [
    'status', 'log', 'diff', 'branch', 'remote', 'rev-parse', 'show',
    'blame', 'tag', 'stash', 'config', 'ls-files', 'ls-tree',
    'shortlog', 'describe', 'cherry', 'reflog',
    'add', 'commit', 'checkout', 'switch', 'merge', 'fetch', 'pull',
    'init', 'clone',
  ].join('|');
  pe.addRule({
    toolName: 'run_shell_command',
    decision: PolicyDecision.ALLOW,
    priority: PRIORITY,
    argsPattern: new RegExp(`"command":"git\\s+(${safeGitSubcmds})[\\s"]`),
    source: `${SOURCE} (git ops)`,
  });
  ruleCount++;

  // 6e. Constructive file operations (non-destructive)
  const constructiveCmds = [
    'mkdir', 'touch', 'cp', 'mv', 'ln', 'tar', 'zip', 'unzip', 'gzip',
    'gunzip', 'curl', 'wget',
  ].join('|');
  pe.addRule({
    toolName: 'run_shell_command',
    decision: PolicyDecision.ALLOW,
    priority: PRIORITY,
    argsPattern: new RegExp(`"command":"(${constructiveCmds})[\\s"]`),
    source: `${SOURCE} (file ops)`,
  });
  ruleCount++;

  // 6f. Compound commands starting with cd
  //     e.g., "cd /path && npm run dev", "cd src && python script.py"
  pe.addRule({
    toolName: 'run_shell_command',
    decision: PolicyDecision.ALLOW,
    priority: PRIORITY,
    argsPattern: new RegExp(`"command":"cd\\s`),
    source: `${SOURCE} (cd compound)`,
  });
  ruleCount++;

  // 6g. Full-path executables for known safe commands
  //     e.g., C:/Python312/python.exe, /usr/bin/node, etc.
  const safeExeNames = [
    'python', 'python3', 'python\\.exe', 'python3\\.exe',
    'node', 'node\\.exe', 'npm', 'npm\\.cmd',
    'npx', 'npx\\.cmd', 'pip', 'pip3',
    'git', 'git\\.exe',
    'powershell\\.exe', 'pwsh', 'pwsh\\.exe',
  ].join('|');
  pe.addRule({
    toolName: 'run_shell_command',
    decision: PolicyDecision.ALLOW,
    priority: PRIORITY,
    argsPattern: new RegExp(`"command":"[^"]*[\\\\/](${safeExeNames})[\\s"]`),
    source: `${SOURCE} (full-path exec)`,
  });
  ruleCount++;

  // ── Stays ASK_USER (falls through to default write.toml) ──────────
  //    rm, rmdir, del — destructive deletion
  //    git push (non-memory) — affects remote
  //    git reset --hard, git clean -f — destructive
  //    chmod, chown, sudo — permission/privilege escalation
  //    activate_skill — explicit user action

  console.log(`[gemini-core] Added ${ruleCount} auto-approve policy rules`);
}

// ---------------------------------------------------------------------------
// Fallback safe-command check (used by the MessageBus auto-approve intercept)
// ---------------------------------------------------------------------------

/**
 * Check if a shell command is known safe. Used as a fallback when the
 * PolicyEngine's checkShellCommand() forces ASK_USER due to parser failure.
 *
 * This mirrors the regex rules in _addAutoApproveRules but works on
 * the raw command string without JSON serialization or tree-sitter parsing.
 */
function _isKnownSafeShellCommand(cmd: string): boolean {
  const trimmed = cmd.trim();

  // Deny-listed commands (never auto-approve)
  const denyPatterns = [
    /^rm\s/i, /^rmdir\s/i, /^del\s/i, /^erase\s/i,
    /^sudo\s/i, /^chmod\s/i, /^chown\s/i,
    /\bgit\s+push\b/i, /\bgit\s+reset\s+--hard\b/i, /\bgit\s+clean\s+-f\b/i,
    /^format\s/i, /^shutdown\s/i, /^reboot\b/i,
  ];
  for (const deny of denyPatterns) {
    if (deny.test(trimmed)) return false;
  }

  // Read-only commands
  const readOnlyCmds = /^(ls|dir|cat|head|tail|less|more|wc|sort|uniq|diff|file|stat|which|where|whoami|pwd|cd|echo|set|env|printenv|hostname|uname|date|tree|find|type|realpath|dirname|basename|Get-ChildItem|Get-Content|Get-Location|Write-Output)\b/i;
  if (readOnlyCmds.test(trimmed)) return true;

  // Dev tool commands
  const devToolCmds = /^(npm|npx|node|python|python3|python\.exe|pip|pip3|tsc|tsx|jest|vitest|mocha|pytest|eslint|prettier|cargo|rustc|go|java|javac|gradle|ruby|gem|bundle|pnpm|yarn|bun|deno|powershell|pwsh|dotnet|code)\b/i;
  if (devToolCmds.test(trimmed)) return true;

  // Git commands (non-push, non-destructive)
  const safeGitOps = /^git\s+(status|log|diff|show|branch|tag|describe|rev-parse|remote|config|stash|rebase|add|commit|checkout|switch|merge|fetch|pull|init|clone|ls-files|reflog|shortlog|blame)\b/i;
  if (safeGitOps.test(trimmed)) return true;

  // Constructive file ops
  const fileOps = /^(mkdir|touch|cp|mv|ln|tar|zip|unzip|gzip|gunzip|curl|wget)\b/i;
  if (fileOps.test(trimmed)) return true;

  // Compound commands starting with cd
  if (/^cd\s/i.test(trimmed)) return true;

  // Full-path executables for known safe commands
  const fullPathSafe = /[\\/](python|python3|python\.exe|node|node\.exe|npm|npm\.cmd|npx|npx\.cmd|pip|pip3|git|git\.exe|powershell\.exe|pwsh|pwsh\.exe|tsc|tsx|code|dotnet|cargo)\s/i;
  if (fullPathSafe.test(trimmed)) return true;

  // Memory/skills repo operations — match configured memory repo path
  const memRepo = getSetting('memory_repo_path');
  if (memRepo) {
    const escapedRepo = memRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parentDir = path.dirname(memRepo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(${escapedRepo}|${parentDir}[\\\\/]skills)`, 'i').test(trimmed)) return true;
  }

  return false;
}

/**
 * Subscribe to TOOL_CALLS_UPDATE on the MessageBus to detect tools
 * awaiting confirmation. When a tool is in `awaiting_approval` status,
 * we emit an SSE `permission_request` to the browser and store the
 * correlationId so resolveConfirmation() can respond.
 *
 * Returns an unsubscribe function.
 */
/**
 * Track the last emitted liveOutput per tool call so we only send deltas.
 * Uses globalThis to survive module reloads in Next.js dev (Turbopack).
 */
const LIVE_OUTPUT_KEY = '__geminiLiveOutputTracker__' as const;

function getLiveOutputTracker(): Map<string, string> {
  if (!(globalThis as Record<string, unknown>)[LIVE_OUTPUT_KEY]) {
    (globalThis as Record<string, unknown>)[LIVE_OUTPUT_KEY] = new Map<string, string>();
  }
  return (globalThis as Record<string, unknown>)[LIVE_OUTPUT_KEY] as Map<string, string>;
}

/**
 * Track the last emitted status per tool call to avoid duplicate status SSEs.
 */
const STATUS_TRACKER_KEY = '__geminiToolStatusTracker__' as const;

function getStatusTracker(): Map<string, string> {
  if (!(globalThis as Record<string, unknown>)[STATUS_TRACKER_KEY]) {
    (globalThis as Record<string, unknown>)[STATUS_TRACKER_KEY] = new Map<string, string>();
  }
  return (globalThis as Record<string, unknown>)[STATUS_TRACKER_KEY] as Map<string, string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _subscribeToolCallsUpdate(bus: any): () => void {
  const liveOutputTracker = getLiveOutputTracker();
  const statusTracker = getStatusTracker();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (rawMsg: any) => {
    const msg = rawMsg as {
      type: string;
      toolCalls: ToolCall[];
      schedulerId: string;
    };

    const pendingMap = getPendingMap();

    for (const tc of msg.toolCalls) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolCall = tc as any;
      const callId: string = toolCall.request?.callId;
      const toolName: string = toolCall.request?.name || 'unknown';
      const status: string = toolCall.status;

      // --- Emit tool status transitions as SSE status events ---
      if (callId && status) {
        const lastStatus = statusTracker.get(callId);
        if (lastStatus !== status) {
          statusTracker.set(callId, status);
          console.log(`[approval-debug] Tool ${toolName} (${callId.slice(0, 8)}) status: ${lastStatus || 'init'} → ${status}`);
          // Emit a status SSE for the tool state transition
          if (activeController) {
            try {
              activeController.enqueue(formatSSE({
                type: 'status',
                data: JSON.stringify({
                  tool_status: status,
                  tool_name: toolName,
                  tool_call_id: callId,
                }),
              }));
            } catch (e) {
              console.warn('[gemini-core] SSE status enqueue failed (controller closed?):', e);
            }
          }

          // Clean up trackers when tool reaches terminal state
          if (status === 'success' || status === 'error' || status === 'cancelled') {
            statusTracker.delete(callId);
            liveOutputTracker.delete(callId);
          }
        }
      }

      // --- Stream live tool output during execution ---
      if (status === 'executing' && toolCall.liveOutput && callId) {
        const currentOutput = String(toolCall.liveOutput);
        const lastOutput = liveOutputTracker.get(callId) || '';

        // Only emit the delta (new content since last emission)
        if (currentOutput.length > lastOutput.length) {
          const delta = currentOutput.slice(lastOutput.length);
          liveOutputTracker.set(callId, currentOutput);

          if (activeController && delta.trim()) {
            try {
              activeController.enqueue(formatSSE({
                type: 'tool_output',
                data: delta,
              }));
            } catch (e) {
              console.warn('[gemini-core] SSE tool_output enqueue failed:', e);
            }
          }
        }
      }

      // --- Handle awaiting_approval (permission request) ---
      if (status !== 'awaiting_approval') continue;
      console.log(`[approval-debug] Tool ${toolName} entered awaiting_approval`);
      const waiting = toolCall as unknown as {
        request: { callId: string; name: string; args: Record<string, unknown> };
        correlationId?: string;
        confirmationDetails?: Record<string, unknown>;
      };

      const correlationId = waiting.correlationId;
      if (!correlationId) {
        console.warn(`[approval-debug] ⚠ No correlationId on waiting tool call — skipping permission_request`);
        continue;
      }
      console.log(`[approval-debug] correlationId=${correlationId.slice(0, 8)}...`);

      // Skip if we already emitted this confirmation
      if (pendingMap.has(correlationId)) {
        console.log(`[approval-debug] Skipping duplicate correlationId ${correlationId.slice(0, 8)}...`);
        continue;
      }

      // Store the pending confirmation (with bus ref for HMR resilience)
      pendingMap.set(correlationId, {
        correlationId,
        toolName: waiting.request.name,
        createdAt: Date.now(),
        bus,
      });

      // Auto-expire after timeout — use the stored bus ref (HMR-safe)
      setTimeout(() => {
        const expired = pendingMap.get(correlationId);
        if (expired) {
          pendingMap.delete(correlationId);
          // Publish a cancel response to unblock the scheduler
          if (expired.bus) {
            expired.bus.publish({
              type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
              correlationId,
              confirmed: false,
              outcome: ToolConfirmationOutcome.Cancel,
            });
          }
        }
      }, CONFIRMATION_TIMEOUT_MS);

      // Build the SSE permission event
      const permEvent: PermissionRequestEvent = {
        permissionRequestId: correlationId,
        toolName: waiting.request.name,
        toolInput: waiting.request.args || {},
        toolUseId: waiting.request.callId,
        description: _extractConfirmationTitle(waiting.confirmationDetails),
      };

      // Push to the active SSE stream
      console.log(`[approval-debug] activeController=${activeController ? 'PRESENT' : 'NULL'}`);
      if (activeController) {
        try {
          const permSSE = formatSSE({
            type: 'permission_request',
            data: JSON.stringify(permEvent),
          });
          console.log(`[approval-debug] ✅ Enqueuing permission_request SSE (${permSSE.length} bytes) for ${toolName}`);
          activeController.enqueue(permSSE);
        } catch (e) {
          console.warn('[gemini-core] Failed to deliver permission_request SSE:', e);
          // Auto-cancel to prevent scheduler from blocking for 5 minutes
          pendingMap.delete(correlationId);
          bus.publish({
            type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
            correlationId,
            confirmed: false,
            outcome: ToolConfirmationOutcome.Cancel,
          });
        }
      } else {
        // No active SSE stream — auto-cancel to avoid blocking
        console.warn('[gemini-core] No active SSE controller for permission_request, auto-cancelling');
        pendingMap.delete(correlationId);
        bus.publish({
          type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
          correlationId,
          confirmed: false,
          outcome: ToolConfirmationOutcome.Cancel,
        });
      }
    }
  };

  bus.subscribe(MessageBusType.TOOL_CALLS_UPDATE, handler);
  return () => {
    bus.unsubscribe(MessageBusType.TOOL_CALLS_UPDATE, handler);
    // Clean up trackers when stream ends
    liveOutputTracker.clear();
    statusTracker.clear();
  };
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
 * Publishes a TOOL_CONFIRMATION_RESPONSE to the MessageBus so the
 * Scheduler can continue processing the tool.
 * Returns true if found and resolved.
 */
export async function resolveConfirmation(
  correlationId: string,
  approved: boolean,
): Promise<boolean> {
  console.log(`[approval-debug] resolveConfirmation called: id=${correlationId.slice(0, 8)}... approved=${approved}`);
  const pendingMap = getPendingMap();
  const entry = pendingMap.get(correlationId);
  if (!entry) {
    console.warn(`[approval-debug] ⚠ correlationId not found in pendingMap (already resolved or expired)`);
    return false;
  }
  // Use the bus captured when the pending entry was created —
  // this survives HMR module reloads (config resets to null but
  // the bus in the closure/Scheduler is still alive).
  const bus = entry.bus;
  if (!bus) {
    console.warn(`[approval-debug] ⚠ no bus on pending entry — cannot publish confirmation response`);
    return false;
  }

  await bus.publish({
    type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
    correlationId,
    confirmed: approved,
    requiresUserConfirmation: false,
    outcome: approved
      ? ToolConfirmationOutcome.ProceedOnce
      : ToolConfirmationOutcome.Cancel,
  });
  pendingMap.delete(correlationId);
  console.log(`[approval-debug] ✅ Confirmation response published, tool should unblock now`);
  return true;
}

// ---------------------------------------------------------------------------
// Aether preamble construction
// ---------------------------------------------------------------------------

/**
 * Returns known project names extracted from the projects.md section of pre-read content.
 * Used by the turns/projects API to populate tag picker suggestions.
 */
export function getKnownProjectNames(): string[] {
  return _extractKnownProjectNames(preReadContent);
}

/**
 * Extract known project names from pre-read content.
 * Only parses the projects.md section — ignores me.md, workflows.md, etc.
 * Pre-read format: "## Contents of <path>\n<content>" per file, separated by \n\n.
 */
function _extractKnownProjectNames(content: string): string[] {
  if (!content) return [];

  // Find the projects.md section within the pre-read content
  const sectionRe = /## Contents of [^\n]*projects\.md\n([\s\S]*?)(?=\n## Contents of |\n*$)/i;
  const sectionMatch = sectionRe.exec(content);
  const projectsSection = sectionMatch ? sectionMatch[1] : '';
  if (!projectsSection) return [];

  const names: string[] = [];
  // Match ## headings like "## Startup: M3T Research" or "## Aether (formerly ...)"
  const headingRe = /^##\s+(?:[^:\n]+:\s*)?(.+?)(?:\s*\(.*\))?\s*$/gm;
  let match;
  while ((match = headingRe.exec(projectsSection)) !== null) {
    const name = match[1].trim();
    if (name && name !== 'Active Projects') {
      names.push(name);
    }
  }
  return names;
}

const RESPONSE_TRUNCATION_LIMIT = 4000;

function formatTurnContext(turns: TurnContext[]): string {
  if (turns.length === 0) return '';

  const lines: string[] = [
    '## Recent conversation context (last ' + turns.length + ' turns)',
    'These are the most recent turns for continuity. Refer to them for context but do not repeat information the user already knows.',
    '',
  ];

  for (const turn of turns) {
    const timestamp = turn.created_at.replace('T', ' ').replace(/\.\d+Z?$/, '');
    const tagLabel = turn.project_tag || 'untagged';
    lines.push(`[${timestamp} | ${tagLabel}]`);
    lines.push(`User: ${turn.prompt}`);

    if (turn.response) {
      // Strip JSON tool blocks — only include text content
      let responseText = turn.response;
      try {
        const parsed = JSON.parse(responseText);
        if (Array.isArray(parsed)) {
          responseText = parsed
            .filter((b: { type: string }) => b.type === 'text')
            .map((b: { text: string }) => b.text)
            .join('');
        }
      } catch {
        // Plain text response — use as-is
      }

      if (responseText.length > RESPONSE_TRUNCATION_LIMIT) {
        const originalLen = responseText.length;
        responseText = responseText.slice(0, RESPONSE_TRUNCATION_LIMIT)
          + `... [truncated, original was ~${originalLen.toLocaleString()} chars]`;
      }
      lines.push(`Assistant: ${responseText}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function buildAetherPreamble(currentProjectTag?: string, recentTurns?: TurnContext[], tagInherited?: boolean): string {
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

    const consolidationThreshold = parseInt(getSetting('memory_consolidation_threshold') || '15', 10);

    // Build trigger description from enabled categories
    const triggerDescriptions: string[] = [];
    if (enabledTriggers.includes('explicit_rules')) triggerDescriptions.push('User states "always/never X" → record the rule');
    if (enabledTriggers.includes('corrections')) triggerDescriptions.push('User corrects your output → record the correction pattern');
    if (enabledTriggers.includes('error_recovery')) triggerDescriptions.push('Tool call fails, retry succeeds with modified approach → record the fix');
    if (enabledTriggers.includes('project_status')) triggerDescriptions.push('Project status changes (task completed, phase transition) → record the update');
    if (enabledTriggers.includes('project_shift')) triggerDescriptions.push('Conversation shifts between projects → scan completed turns for lessons before moving on');

    lines.push(
      '',
      '## Memory System',
      `Aether has a memory system that uses Python scripts. You must use these scripts via the \`run_shell_command\` tool to record information.`,
      `The memory repository is at: \`${normPath}\``,
      '',
      '### `update_memory.py`',
      '- **Purpose**: Records a new piece of information (a preference, fact, workflow, or status update) to the memory files.',
      '- **Important**: New observations should go to the **Staging** section of the relevant project file. Use `--category "Staging"` for project observations. Only write directly to named sections (e.g., "Status", "Key Decisions") when the information is a definitive status update, not an observation.',
      '- **Command**:',
      '  ```bash',
      `  python ${normPath}/../skills/memory/update_memory.py --file [file_target] --category "[Category Name]" --content "[Content to remember]"`,
      '  ```',
      '- **Arguments**:',
      '  - `--file`: One of `me.md`, `workflows.md`, `project`, `environment`.',
      '  - `--category`: The heading to place the memory under. Use `"Staging"` for new project observations.',
      '  - `--content`: The single bullet point of text to add.',
      '  - `--project-name`: Required if `--file` is `project`.',
      '  - `--environment-name`: Required if `--file` is `environment`.',
      '  - `--source-turn-id`: The ID of the current turn.',
      '',
      '- **Examples**:',
      '  - User says "I prefer my plot titles to be larger" → You call `run_shell_command` with:',
      `    \`python ${normPath}/../skills/memory/update_memory.py --file me.md --category "Data Analysis Style" --content "Prefers plot titles to be larger." --source-turn-id [id]\``,
      '  - A new pattern observed during a project → You call `run_shell_command` with:',
      `    \`python ${normPath}/../skills/memory/update_memory.py --file project --project-name "Aether" --category "Staging" --content "BaseLlmClient from Core is the right tool for utility LLM calls." --source-turn-id [id]\``,
      '',
    );

    lines.push(
      '### Consolidation',
      `When a project's Staging section reaches ${consolidationThreshold} observations, Aether will prompt the user to consolidate. The consolidation process compacts staging observations into structured sections and promotes generally useful patterns to global files (me.md, workflows.md). You do not need to manage this — Aether handles it automatically.`,
    );

    if (triggerDescriptions.length > 0) {
      lines.push(
        '',
        '### Active memory triggers',
        'Watch for these patterns and record observations when they occur:',
        ...triggerDescriptions.map(t => `- ${t}`),
      );
    }

    if (customRules) {
      lines.push(
        '',
        '### Custom memorization rules (from user settings):',
        customRules,
      );
    }
  }

  // Per-turn project tagging (independent of memory system)
  const knownProjects = _extractKnownProjectNames(preReadContent);
  const projectListStr = knownProjects.length > 0
    ? knownProjects.map(p => `"${p}"`).join(', ')
    : '"Aether", "Fledgling", "M3T Research"';

  const tagStatus = currentProjectTag
    ? (tagInherited
      ? `Current project tag: "${currentProjectTag}" (inherited from previous turn — verify it still applies).`
      : `Current project tag: "${currentProjectTag}".`)
    : 'Current project tag: none.';

  lines.push(
    '',
    '## Per-turn project tagging (IMPORTANT)',
    tagStatus,
    `Known projects: ${projectListStr}.`,
    'RULES:',
    '1. If no tag is set, you MUST emit `<!-- project: TagName -->` at the very start of your response (before any other text).',
    '2. If the current tag is wrong for this turn\'s topic, emit the marker with the correct project name.',
    '3. If the current tag is correct, do NOT emit any marker.',
    '4. The marker is invisible in rendered markdown and will be stripped from the saved response.',
    '5. ONLY use project names from the known projects list above. Do NOT invent new names or use working directory basenames.',
  );

  // Recent conversation context
  if (recentTurns && recentTurns.length > 0) {
    lines.push('', formatTurnContext(recentTurns));
  }

  // Recent user edits (from Save actions on editable cells)
  try {
    const recentEdits = getRecentSaveCellEdits(5, currentProjectTag);
    if (recentEdits.length > 0) {
      lines.push('', '## Recent user edits');
      lines.push('The user has finalized the following edits to assistant outputs. These reflect approved changes:');
      for (const edit of recentEdits) {
        const preview = edit.delta.length > 300 ? edit.delta.slice(0, 300) + '...' : edit.delta;
        lines.push(`- Cell ${edit.cell_index} in turn ${edit.turn_id.slice(0, 8)}... (v${edit.version}): \`\`\`\n${preview}\n\`\`\``);
      }
    }
  } catch {
    // Non-critical — skip if DB not ready
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

  const normalizedMemoryPath = memoryRepoPath.replace(/\\/g, '/').toLowerCase();
  let isMemoryWrite = false;
  let observationDetails: Record<string, unknown> | null = null;

  // 1. Check for direct file edits to the memory repo
  if (toolName === 'edit' || toolName === 'write_file') {
    const filePath = String(toolInput.file_path || toolInput.filePath || '');
    const normalizedFilePath = filePath.replace(/\\/g, '/').toLowerCase();

    if (normalizedFilePath.startsWith(normalizedMemoryPath)) {
      isMemoryWrite = true;
      observationDetails = {
        file: filePath,
        tool: toolName,
        content: String(toolInput.content || ''),
      };
    }
  }

  // 2. Check for shell commands running the update_memory.py script
  if (toolName === 'run_shell_command') {
    const command = String(toolInput.command || '');
    if (command.includes('update_memory.py')) {
      isMemoryWrite = true;
      // Naive parsing of the command string to extract arguments
      const fileMatch = /--file\s+(\S+)/.exec(command);
      const categoryMatch = /--category\s+"([^"]+)"/.exec(command);
      const contentMatch = /--content\s+"([^"]+)"/.exec(command);
      const projectMatch = /--project-name\s+"([^"]+)"/.exec(command);

      observationDetails = {
        tool: 'update_memory.py',
        file: fileMatch ? fileMatch[1] : 'unknown',
        category: categoryMatch ? categoryMatch[1] : 'unknown',
        content: contentMatch ? contentMatch[1] : '',
        project: projectMatch ? projectMatch[1] : undefined,
      };
    }
  }

  if (isMemoryWrite && observationDetails) {
    const autoApprove = getSetting('memory_auto_approve') === 'true';
    try {
      controller.enqueue(formatSSE({
        type: 'memory_observation' as SSEEvent['type'],
        data: JSON.stringify({
          ...observationDetails,
          auto_approve: autoApprove,
        }),
      }));
    } catch {
      // Controller may be closed
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Project tag detection transform
// ---------------------------------------------------------------------------

const TAG_MARKER_RE = /<!--\s*project:\s*(.+?)\s*-->/;
const TAG_SCAN_LIMIT = 300; // chars of text content to scan before giving up

/**
 * TransformStream that scans the first ~300 chars of text events for a
 * `<!-- project: TagName -->` marker. When found:
 *   1. Strips the marker from the text
 *   2. Emits a `project_tag` SSE event
 *   3. Updates the DB with the inferred tag
 *
 * When `enabled` is false, acts as a passthrough.
 */
export function createTagDetectionTransform(
  entityId: string,
  enabled: boolean,
  entityType: 'session' | 'turn' = 'session',
): TransformStream<string, string> {
  if (!enabled) {
    console.log(`[tag-detect] DISABLED for ${entityType} ${entityId.slice(0, 8)}… (source=manual)`);
    return new TransformStream(); // passthrough
  }

  console.log(`[tag-detect] ENABLED for ${entityType} ${entityId.slice(0, 8)}… — scanning first ${TAG_SCAN_LIMIT} chars`);

  let textSoFar = '';
  let scanning = true;
  let bufferedChunks: string[] = [];

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      if (!scanning) {
        controller.enqueue(chunk);
        return;
      }

      // Parse SSE lines from chunk to accumulate text content
      const lines = chunk.split('\n');
      let hasToolUse = false;

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event: { type: string; data: string } = JSON.parse(line.slice(6));
            if (event.type === 'text') {
              textSoFar += event.data;
            } else if (event.type === 'tool_use' || event.type === 'error' || event.type === 'done') {
              hasToolUse = true; // flush immediately on tool_use, error, or done
            }
          } catch {
            // skip malformed
          }
        }
      }

      bufferedChunks.push(chunk);

      // Check for marker in accumulated text
      const match = TAG_MARKER_RE.exec(textSoFar);
      if (match) {
        const detectedTag = match[1].trim();
        scanning = false;
        console.log(`[tag-detect] FOUND marker for ${entityType} ${entityId.slice(0, 8)}… → "${detectedTag}" (at char ${match.index})`);

        // Update DB — route to correct table based on entity type
        try {
          if (entityType === 'turn') {
            updateTurnProjectTag(entityId, detectedTag, 'inferred');
          } else {
            updateSessionProjectTag(entityId, detectedTag, 'inferred');
          }
        } catch {
          // best effort
        }

        // Rebuild buffered chunks with the marker stripped from text events
        const markerStr = match[0];
        let stripped = false;
        for (const buffered of bufferedChunks) {
          if (!stripped) {
            // Strip the marker from text events in this chunk
            const rewritten = _stripMarkerFromChunk(buffered, markerStr);
            // Prepend the project_tag SSE event
            const tagEvent = formatSSE({
              type: 'project_tag' as SSEEvent['type'],
              data: JSON.stringify({ tag: detectedTag }),
            });
            controller.enqueue(tagEvent + rewritten);
            stripped = true;
          } else {
            controller.enqueue(buffered);
          }
        }
        bufferedChunks = [];
        return;
      }

      // No marker yet — flush if we've scanned enough text or hit a tool_use
      if (textSoFar.length >= TAG_SCAN_LIMIT || hasToolUse) {
        scanning = false;
        const reason = hasToolUse ? 'tool_use event' : `text limit (${textSoFar.length} chars)`;
        console.log(`[tag-detect] NO marker for ${entityType} ${entityId.slice(0, 8)}… — gave up after ${reason}. First 120 chars: "${textSoFar.slice(0, 120).replace(/\n/g, '\\n')}"`);
        for (const buffered of bufferedChunks) {
          controller.enqueue(buffered);
        }
        bufferedChunks = [];
        return;
      }

      // Continue buffering
    },

    flush(controller) {
      // Flush any remaining buffered chunks
      if (scanning && bufferedChunks.length > 0) {
        console.log(`[tag-detect] Stream ended while still scanning for ${entityType} ${entityId.slice(0, 8)}… (${textSoFar.length} chars scanned). First 120 chars: "${textSoFar.slice(0, 120).replace(/\n/g, '\\n')}"`);
      }
      for (const buffered of bufferedChunks) {
        controller.enqueue(buffered);
      }
      bufferedChunks = [];
    },
  });
}

/**
 * Strip a marker string from text events within an SSE chunk.
 * Rewrites `data: {"type":"text","data":"...marker..."}` lines.
 */
function _stripMarkerFromChunk(chunk: string, marker: string): string {
  const lines = chunk.split('\n');
  const result: string[] = [];
  let markerRemoved = false;

  for (const line of lines) {
    if (!markerRemoved && line.startsWith('data: ')) {
      try {
        const event: { type: string; data: string } = JSON.parse(line.slice(6));
        if (event.type === 'text' && event.data.includes(marker)) {
          const cleaned = event.data.replace(marker, '');
          if (cleaned) {
            result.push(`data: ${JSON.stringify({ type: 'text', data: cleaned })}`);
          }
          // else: entire text event was just the marker — skip the line
          markerRemoved = true;
          continue;
        }
      } catch {
        // not parseable, pass through
      }
    }
    result.push(line);
  }

  return result.join('\n');
}

// ---------------------------------------------------------------------------
// Main streaming function
// ---------------------------------------------------------------------------

/**
 * Stream a Gemini response using Core's agent loop.
 * Returns a ReadableStream of SSE-formatted strings.
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

      // Track the bus subscription so we can clean up
      let unsubscribeToolCallsUpdate: (() => void) | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let autoApproveHandler: ((req: any) => void) | null = null;

      try {
        // Ensure Core is initialized
        await initGeminiCore(workingDirectory || process.cwd());

        if (!config) {
          throw new Error('Gemini Core failed to initialize');
        }

        // If a different model is requested, update config via Core's setModel API.
        // This updates both the persistent and active model, emits a change event
        // (which resets GeminiClient.currentSequenceModel), and clears availability tracking.
        if (model) {
          config.setModel(model, false);
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
        const preamble = buildAetherPreamble(options.projectTag, options.recentTurns, options.tagInherited);
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
            model: model || getSetting('default_model') || 'gemini-3-pro',
            backend: 'gemini-core',
          }),
        }));

        // Get the client and set up the agent loop
        const client = config.getGeminiClient();
        const promptId = randomUUID();
        const signal = abortController?.signal || new AbortController().signal;
        const bus = config.getMessageBus();

        // Subscribe to TOOL_CALLS_UPDATE for confirmation forwarding to SSE
        unsubscribeToolCallsUpdate = _subscribeToolCallsUpdate(bus);

        // ── Auto-approve intercept ──────────────────────────────────
        // The PolicyEngine's checkShellCommand() can force ASK_USER when
        // splitCommands() (tree-sitter) fails to parse the command, even
        // if an auto-approve regex rule matched. This listener fires
        // BEFORE the Scheduler's default "requiresUserConfirmation" listener
        // (because we subscribe before creating the Scheduler), and
        // auto-approves known safe commands at the MessageBus level.
        autoApproveHandler = (request: {
          correlationId: string;
          toolCall?: { name: string; args?: Record<string, unknown> };
        }) => {
          if (request.toolCall?.name !== 'run_shell_command') return;
          const cmd = String(request.toolCall.args?.command || '');
          if (!cmd) return;
          if (_isKnownSafeShellCommand(cmd)) {
            console.log(`[approval-debug] 🟢 Auto-approving via MessageBus intercept: ${cmd.slice(0, 80)}`);
            try {
              void bus.publish({
                type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
                correlationId: request.correlationId,
                confirmed: true,
              });
            } catch (e) {
              console.warn('[approval-debug] ⚠ bus.publish failed in auto-approve handler:', e);
            }
          } else {
            console.log(`[approval-debug] 🔴 Command NOT auto-approved, needs user confirmation: ${cmd.slice(0, 80)}`);
          }
        };
        bus.subscribe(MessageBusType.TOOL_CONFIRMATION_REQUEST, autoApproveHandler);

        // Create the Scheduler for tool execution
        const scheduler = new Scheduler({
          config,
          messageBus: bus,
          getPreferredEditor: () => undefined, // Aether is web-based, no terminal editor
          schedulerId: ROOT_SCHEDULER_ID,
        });

        // ---------------------------------------------------------------
        // Agent loop: stream → collect tool requests → execute → continue
        // ---------------------------------------------------------------
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let queryParts: any = [{ text: finalPromptText }];
        let turnCount = 0;
        const MAX_AGENT_TURNS = 25; // Safety limit

        while (turnCount < MAX_AGENT_TURNS) {
          turnCount++;
          if (signal.aborted) break;

          // Stream a single model turn
          console.log(`[gemini-core] Starting sendMessageStream for turn ${turnCount}...`);
          const toolCallRequests: ToolCallRequestInfo[] = [];
          const stream = client.sendMessageStream(queryParts, signal, promptId);

          for await (const event of stream) {
            if (signal.aborted) break;

            // Collect tool call requests for scheduling after the stream
            if (event.type === GeminiEventType.ToolCallRequest) {
              const req = (event as { value: ToolCallRequestInfo }).value;
              toolCallRequests.push(req);
              // Check for memory writes
              checkMemoryWrite(controller, req.name, req.args);
            }

            // Map and emit SSE event to the browser
            const sseEvent = mapEventToSSE(event);
            if (sseEvent) {
              controller.enqueue(formatSSE(sseEvent));
            }
          }

          // If no tool calls were requested, the model is done
          if (toolCallRequests.length === 0 || signal.aborted) {
            break;
          }

          // Schedule tool execution — blocks until all tools in the
          // batch are done (including any user confirmations)
          console.log(`[gemini-core] Scheduling ${toolCallRequests.length} tool call(s)...`);
          const completedTools: CompletedToolCall[] = await scheduler.schedule(
            toolCallRequests,
            signal,
          );

          // Emit tool results as SSE events
          for (const tc of completedTools) {
            const resp = tc.response;
            if (!resp) continue;

            const textParts: string[] = [];
            if (resp.responseParts) {
              for (const part of resp.responseParts) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const p = part as any;
                if (p.text) textParts.push(p.text as string);
              }
            }

            controller.enqueue(formatSSE({
              type: 'tool_result',
              data: JSON.stringify({
                tool_use_id: tc.request.callId,
                content: textParts.join('\n') || (resp.error ? resp.error.message : '(no output)'),
                is_error: tc.status === 'error' || tc.status === 'cancelled',
              }),
            }));
          }

          // If all tools were cancelled, stop the loop
          if (completedTools.every(tc => tc.status === 'cancelled')) {
            console.log('[gemini-core] All tools cancelled, ending agent loop');
            break;
          }

          // Build continuation query from tool response parts
          const responseParts = completedTools
            .filter(tc => tc.response?.responseParts)
            .flatMap(tc => tc.response.responseParts);

          if (responseParts.length === 0) {
            console.log('[gemini-core] No response parts from tools, ending agent loop');
            break;
          }

          // Continue the conversation with tool results
          queryParts = responseParts;
          // Log shape of continuation parts for debugging network errors
          console.log(`[gemini-core] Continuing with ${responseParts.length} response part(s), turn ${turnCount}`);
          for (let i = 0; i < Math.min(responseParts.length, 3); i++) {
            const rp = responseParts[i];
            const keys = rp && typeof rp === 'object' ? Object.keys(rp) : ['(primitive)'];
            console.log(`[gemini-core]   part[${i}] keys: ${keys.join(', ')}, type: ${typeof rp}`);
          }
        }

        if (turnCount >= MAX_AGENT_TURNS) {
          console.warn(`[gemini-core] Hit max agent turns (${MAX_AGENT_TURNS})`);
          controller.enqueue(formatSSE({
            type: 'status',
            data: JSON.stringify({ warning: 'Max agent turns reached' }),
          }));
        }

        // Stream complete — mark model as healthy
        setModelHealthOk();
        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : 'Unknown error';
        setModelHealthError(rawMessage);
        console.error('[gemini-core] Stream error:', rawMessage);
        // Log full error details for network error diagnosis
        if (error instanceof Error) {
          console.error('[gemini-core] Error name:', error.name);
          if (error.stack) console.error('[gemini-core] Stack:', error.stack);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const anyErr = error as any;
          if (anyErr.code) console.error('[gemini-core] Error code:', anyErr.code);
          if (anyErr.status) console.error('[gemini-core] HTTP status:', anyErr.status);
          if (anyErr.cause) console.error('[gemini-core] Cause:', anyErr.cause);
        } else {
          console.error('[gemini-core] Raw error object:', error);
        }

        let errorMessage = rawMessage;

        // Add context-specific hints
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const errAny = error as any;
        if (rawMessage.includes('not initialized') || rawMessage.includes('auth')) {
          errorMessage += '\n\nGemini authentication may have expired. Run `gemini auth login` in a terminal to re-authenticate.';
        } else if (rawMessage.includes('quota') || rawMessage.includes('capacity') || errAny?.name === 'TerminalQuotaError') {
          // Format the retry delay if available
          const retryMs = errAny?.retryDelayMs;
          if (retryMs && typeof retryMs === 'number') {
            const mins = Math.ceil(retryMs / 60000);
            errorMessage = `API quota exhausted. Try again in ~${mins} minute${mins === 1 ? '' : 's'}.`;
          }
        }

        try {
          controller.enqueue(formatSSE({ type: 'error', data: errorMessage }));
          controller.enqueue(formatSSE({ type: 'done', data: '' }));
          controller.close();
        } catch (closeErr) {
          console.warn('[gemini-core] Failed to send error SSE (controller may already be closed):', closeErr);
        }
      } finally {
        // Unsubscribe from bus
        if (unsubscribeToolCallsUpdate) {
          unsubscribeToolCallsUpdate();
        }
        // Unsubscribe auto-approve intercept
        if (autoApproveHandler && config) {
          config.getMessageBus().unsubscribe(
            MessageBusType.TOOL_CONFIRMATION_REQUEST,
            autoApproveHandler,
          );
        }
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
 * Get the BaseLlmClient for stateless, utility-focused LLM calls (no agent loop).
 * Used for consolidation, summarization, and other one-shot tasks.
 * Triggers lazy initialization if Core hasn't been started yet.
 */
export async function getBaseLlmClient() {
  if (!config) {
    await initGeminiCore();
  }
  if (!config) throw new Error('Gemini Core failed to initialize');
  return config.getBaseLlmClient();
}

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
  const method = process.env.GEMINI_API_KEY ? 'api-key' : 'google-oauth';
  return { authenticated: true, method };
}

// ---------------------------------------------------------------------------
// Model health tracking — reflects actual model responsiveness
// ---------------------------------------------------------------------------

interface ModelHealth {
  /** idle = no requests yet, ok = last request succeeded, error = last request failed */
  status: 'idle' | 'ok' | 'error';
  /** Error message from the most recent failure */
  error?: string;
  /** Timestamp of last status change (ms since epoch) */
  timestamp: number;
}

let modelHealth: ModelHealth = { status: 'idle', timestamp: Date.now() };

function setModelHealthOk() {
  modelHealth = { status: 'ok', timestamp: Date.now() };
}

function setModelHealthError(error: string) {
  modelHealth = { status: 'error', error, timestamp: Date.now() };
}

/**
 * Get the current model health for the connection status UI.
 */
export function getModelHealth(): ModelHealth {
  return { ...modelHealth };
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
