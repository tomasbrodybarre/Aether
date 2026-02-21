# Aether v2: Gemini CLI Migration Architecture

## Why

Anthropic's T&C explicitly prohibits using OAuth/Max credentials in third-party products. Aether wraps the Claude Code CLI and routes requests through Max subscription — this is a violation for distribution and gray-area for personal use. The entire billing model is blocked.

Gemini CLI (Apache 2.0) has no such restrictions. Fixed-rate subscriptions exist. The CLI's architecture is explicitly designed for custom frontends. Model quality (Gemini 3.1 Pro) is comparable to Opus 4.6 on most benchmarks, with trade-offs on expert-level reasoning.

## What changes, what stays

### Stays (frontend layer — ~80% of codebase)
- Next.js 16 + React 19 + Tailwind 4 + Radix UI app shell
- Streamdown rendering pipeline (markdown, LaTeX/KaTeX, code/Shiki, mermaid, tables)
- MarkdownImage component for inline figure rendering
- Content width system, font settings, display preferences
- Toast notification system
- Session list UI, editable titles, NavRail
- Message queueing and interrupt flow
- Tool action block rendering (collapsible tool calls)
- Expandable task details (TODO bar → tool correlation)
- Inline code block editing (when built)
- Settings pages (Display, Memory — minor key renames)

### Changes (backend integration layer — ~20% of codebase)

| Current (Claude Code) | New (Gemini CLI) |
|---|---|
| `claude-client.ts` — spawns CLI subprocess | `gemini-core.ts` — imports Core package as library |
| `--output-format stream-json` parsing | Same flag, adapted event field names |
| `--permission-prompt-tool` callback | `confirmation-bus` subscription |
| `--resume --session-id` | `--resume [UUID]` |
| `canUseTool()` auto-approve logic | Policy engine TOML rules + bus subscriber |
| CLAUDE.md loading (`claude-md.ts`) | GEMINI.md loading (Core handles natively) |
| `CLAUDECODE` env var stripping | Not needed (no nested session issue) |
| `.cmd` wrapper resolution on Windows | Not needed (Core is a library, not a subprocess) |
| SDK `streamClaude()` API | Core agent loop API (direct function call) |
| MCP config from `~/.claude/settings.json` | MCP config from `.mcp.json` |
| Auth via OAuth token (Max subscription) | Auth via API key or Google AI subscription |

### Removed (no longer needed)
- Subprocess spawning, stderr buffering, process management
- `.cmd` wrapper resolution (Windows-specific hack)
- `CLAUDECODE` env var stripping
- Zombie process cleanup script (`cleanup-port.mjs` — still useful for Next.js but not for agent process)

## Architecture

### Current: Subprocess model

```
┌─────────────┐    spawn     ┌──────────────┐     API      ┌───────────┐
│  Next.js    │ ──────────── │  Claude Code  │ ──────────── │ Anthropic │
│  Backend    │   stdin/out  │  CLI binary   │    OAuth     │   API     │
│  (SSE)      │ ◄──────────  │  (subprocess) │ ◄──────────  │           │
└─────────────┘   stream-json└──────────────┘              └───────────┘
```

Problems: process lifecycle management, .cmd wrappers on Windows, stderr buffering, env var conflicts, no direct access to tool execution internals.

### New: Library model

```
┌─────────────────────────────────────────────┐
│                Next.js Backend              │
│                                             │
│  ┌─────────────────────────────────────┐    │     API      ┌──────────┐
│  │       Gemini CLI Core (library)     │    │ ──────────── │  Google  │
│  │                                     │    │   API key    │  Gemini  │
│  │  ┌──────────┐  ┌─────────────────┐  │    │ ◄──────────  │  API     │
│  │  │  Agent    │  │  Confirmation   │  │    │              └──────────┘
│  │  │  Loop     │  │  Bus            │  │    │
│  │  │          │  │  (EventEmitter) │──│────│──► SSE to browser
│  │  │          │  │                 │◄─│────│─── User approval from browser
│  │  └──────────┘  └─────────────────┘  │    │
│  │                                     │    │
│  │  ┌──────────┐  ┌────────────────┐   │    │
│  │  │  Policy   │  │  Tool          │   │    │
│  │  │  Engine   │  │  Registry      │   │    │
│  │  │  (TOML)   │  │  (MCP + built) │   │    │
│  │  └──────────┘  └────────────────┘   │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  ┌──────────────┐  ┌───────────────────┐    │
│  │  Aether SSE   │  │  Memory System    │    │
│  │  Handler      │  │  (triggers, git,  │    │
│  │  (stream →    │  │   consolidation)  │    │
│  │   browser)    │  │                   │    │
│  └──────────────┘  └───────────────────┘    │
└─────────────────────────────────────────────┘
```

Key advantage: Core runs in-process. No serialization boundary. Direct access to the agent loop, tool registry, confirmation bus, and policy engine. Permission routing, tool interception, and memory observation all happen via function calls and event subscriptions, not stdout parsing.

## Integration Points (detail)

### 1. Agent loop → SSE stream

The Core package exposes the agent loop as an async iterable (or callback-based API — needs verification from source). Each iteration yields an event:

```typescript
// gemini-core.ts (new file, replaces claude-client.ts)
import { createAgent, type AgentEvent } from '@google/gemini-cli-core';

export async function* streamGemini(opts: SessionOpts): AsyncGenerator<SSEEvent> {
  const agent = createAgent({
    model: opts.model ?? 'gemini-3.1-pro',
    systemPrompt: await buildSystemPrompt(opts),
    tools: [...builtinTools, ...mcpTools],
    sessionId: opts.resumeSessionId,
  });

  const bus = agent.getMessageBus();

  // Permission routing
  bus.subscribe('TOOL_CONFIRMATION_REQUEST', (req) => {
    const decision = localPolicyCheck(req); // fast-path auto-approve
    if (decision === 'allow') {
      bus.publish('TOOL_CONFIRMATION_RESPONSE', {
        correlationId: req.correlationId,
        confirmed: true,
      });
    } else {
      // Route to web UI
      yield { type: 'permission', data: req };
    }
  });

  // Stream events
  for await (const event of agent.run(opts.prompt)) {
    yield mapEventToSSE(event);
  }
}
```

**Note**: exact API shape TBD — needs verification against Core source. The pattern is right; the method names may differ.

### 2. Permission routing

**Two-tier system** (mirrors current Aether approach):

**Tier 1 — Policy engine (TOML rules, no UI)**:
```toml
# ~/.gemini/policies/aether.toml

# Safe reads — always allow
[[rules]]
toolName = "read_file"
decision = "allow"

[[rules]]
toolName = "glob"
decision = "allow"

[[rules]]
toolName = "grep"
decision = "allow"

# Memory repo git operations — always allow
[[rules]]
toolName = "shell"
argsPattern = "git\\s+-C\\s+.*claude-hub[\\\\/]memory\\s+(pull|fetch|status|log|diff)"
decision = "allow"

# Memory file writes — always allow
[[rules]]
toolName = "write_file"
argsPattern = "claude-hub[\\\\/]memory[\\\\/]"
decision = "allow"

# Destructive patterns — always deny
[[rules]]
toolName = "shell"
argsPattern = "rm\\s+-rf|format\\s+|del\\s+/[sqf]"
decision = "deny"
message = "Destructive command blocked by policy"

# Everything else — ask the user
[[rules]]
decision = "ask_user"
```

**Tier 2 — Confirmation bus subscriber (web UI)**:
When the policy engine returns `ask_user`, the bus emits `TOOL_CONFIRMATION_REQUEST`. Aether's subscriber catches it and forwards to the browser via SSE. The browser shows the permission queue UI (already built). User clicks approve/reject. Response sent back via the bus.

This is architecturally identical to the current system but cleaner — the policy engine handles the fast path declaratively (no code), the bus handles the interactive path.

### 3. System prompt construction

```typescript
// system-prompt.ts (new file)
export async function buildSystemPrompt(opts: SessionOpts): string {
  const parts: string[] = [];

  // Aether preamble (capabilities, rendering instructions)
  parts.push(AETHER_PREAMBLE);

  // Memory preamble (triggers, consolidation, if enabled)
  if (opts.memoryEnabled) {
    parts.push(buildMemoryPreamble(opts.memorySettings));
  }

  // GEMINI.md files are loaded by Core automatically —
  // we only need to inject Aether-specific instructions here.
  // The hierarchical GEMINI.md walk (global → project → subdir)
  // is handled natively by Core, no custom code needed.

  return parts.join('\n\n');
}
```

**Migration note**: the current `claude-md.ts` utility that walks the directory tree loading CLAUDE.md files can be deleted — Gemini Core does this natively (and better, with dynamic discovery when tools access new directories).

**Preamble adaptation**: the Aether preamble and memory preamble need re-tuning for Gemini's instruction-following style:
- Simplify trigger descriptions — fewer words, more explicit
- Add few-shot examples for each trigger type
- Use structured JSON format for memory signals (not natural language)
- Test iteratively; budget 2-3 sessions of prompt engineering

### 4. Session management

```typescript
// sessions.ts (adapted from current implementation)

// Resume: pass session UUID to Core
const agent = createAgent({ sessionId: existingUuid, ... });

// List: use Core's session listing API or read ~/.gemini/tmp/<hash>/chats/
const sessions = await listSessions(projectPath);

// New session: omit sessionId, Core generates UUID
const agent = createAgent({ ... }); // new session
```

Session metadata (titles, project tags, custom fields) stored in Aether's SQLite database as before. Core's session storage handles conversation history and tool results. Aether's SQLite handles UI-layer metadata.

### 5. Memory system

The memory system is model-agnostic by design — it's a behavioral layer (trigger detection → observation → file write → git commit). The only model-dependent piece is the system prompt instructions.

**What ports directly**:
- Memory settings UI (Settings > Memory)
- Toast notification system
- Memory write interception (adapt `canUseTool` → policy engine TOML + bus subscriber)
- Consolidation logic
- Git operations
- `project_tag` column and SQLite schema
- `/api/memory` endpoint

**What needs adaptation**:
- Memory preamble (re-tune for Gemini instruction-following)
- `memory_observation` SSE event emission (hook into bus instead of `canUseTool`)

### 6. MCP servers

Current: Aether reads `~/.claude/settings.json` for MCP server configs and passes to SDK.
New: Gemini CLI reads `.mcp.json` natively. Aether's Settings > Extensions page adapts to write `.mcp.json` format instead.

## Migration plan

### Phase 0: Verify Core package API (1 day)
- ~~Determine: can Core be imported as an npm package?~~ YES — `@google/gemini-cli-core` on npm
- ~~Agent loop API shape?~~ Async generator via `Turn.run()`, yields `ServerGeminiStreamEvent`
- ~~Confirmation bus pattern?~~ Pub/sub EventEmitter, `TOOL_CONFIRMATION_REQUEST`/`RESPONSE` with correlation IDs
- Remaining: build a minimal Node.js script that imports Core, runs a prompt, and logs events (sanity check)

### Phase 1: Backend swap (3-5 days)
- Create `gemini-core.ts` replacing `claude-client.ts`
- Adapt SSE event mapping (field name changes)
- Wire confirmation bus → permission queue SSE
- Write policy TOML for auto-approve rules
- Adapt session create/resume/list
- Wire MCP config
- **Test**: basic conversation, tool execution, permission approval, session resume

### Phase 2: System prompt migration (2-3 days)
- Rename CLAUDE.md → GEMINI.md in memory repo and working directories
- Adapt Aether preamble for Gemini
- Adapt memory preamble (simplify triggers, add examples)
- Remove `aether:init` directive parsing (Gemini Core loads GEMINI.md natively; exec directives move to a startup hook or settings-based init)
- **Test**: memory trigger detection accuracy, observation quality

### Phase 3: Cleanup and Windows fixes (1 day)
- Remove `claude-client.ts`, `claude-md.ts`
- Remove `.cmd` wrapper resolution code
- Remove `CLAUDECODE` env var stripping
- Remove subprocess-specific error handling (stderr buffering)
- Update ConnectionStatus to show Gemini auth state
- Update Settings > General (model list, auth method)
- **Test**: full workflow on Windows

### Phase 4: Feature parity verification (2 days)
- Walk through all 10 MVP features, verify each works
- Walk through implemented v1.1 features (memory, parallel permissions, content width, etc.)
- Performance test: streaming responsiveness, RAF throttle still needed?
- Session migration: decide whether to support importing Claude-era sessions or start fresh

**Total estimate: 8-12 days**, with Phase 1 being the critical path.

## Open questions (RESOLVED)

1. **Core package distribution** — **Published to npm** as `@google/gemini-cli-core` (v0.28.2, actively maintained). `npm i @google/gemini-cli-core`. No vendoring needed.

2. **Agent loop API shape** — **Async generator.** The `Turn` class has a `run()` method yielding `ServerGeminiStreamEvent` (discriminated union). Event types: Content (text chunks), Thought (reasoning), ToolCallRequest/Response/Confirmation, UserCancelled, Error, Finished, Retry, ChatCompressed, LoopDetected, MaxSessionTurns, ContextWindowWillOverflow. Integration: `for await (const event of turn.run())`.

3. **Streaming granularity** — **Token-by-token.** `Turn.run()` calls `chat.sendMessageStream()` and iterates chunks, extracting text parts incrementally. RAF throttle will still be needed.

4. **Session storage compatibility** — **JSON/JSONL, readable.** Stored at `~/.gemini/tmp/<project_hash>/chats/`. Contains conversation history, tool executions, token stats, reasoning summaries. Transitioning from monolithic JSON to JSONL. Checkpoints via `/chat save`. Aether maintains SQLite for UI metadata (titles, project tags) — same dual-store pattern as current architecture.

5. **Extended thinking** — **Yes, with more granularity.** Three thinking levels: low, medium, high. High activates "Deep Think Mini." Controlled via `thinking_level` parameter. Thought events stream through the same `Turn.run()` generator (separate event type from text). Unlike Claude's extended thinking which breaks token-level streaming, Gemini's integrates into the event stream. **This is an upgrade.**

6. **Image in response** — **Same approach works.** Gemini API supports multimodal responses (inline base64 image data). For Aether's use case (save file → markdown reference), the preamble instruction `![desc](/api/files/raw?path=...)` ports directly — it's a convention we teach the model, not a model capability.

7. **Model switching** — **Yes, mid-session.** `/model` slash command implemented and shipped. Switch between Flash/Pro/etc. during conversation without losing context. **This is an upgrade** — Claude Code doesn't support mid-session model switching. Use case: Flash for cheap tasks, Pro for complex reasoning.

## Risk register

| Risk | Impact | Likelihood | Mitigation | Status |
|---|---|---|---|---|
| Core package API unstable | High | Medium | Pin to specific commit; vendor if needed | Open |
| Instruction-following quality insufficient for memory triggers | Medium | Medium | Simplify triggers; structured JSON signals; few-shot examples | Open |
| Gemini 3.1 Pro reasoning quality gap on hard agentic tasks | Medium | High (known) | Accept trade-off; mid-session model switching (Q7) helps; monitor model releases | Open |
| Google policy change restricts wrappers | High | Low | Apache 2.0 is irrevocable; pinned version always available | Open |
| ~~Core package not importable as library~~ | ~~Medium~~ | ~~Low~~ | Published to npm as `@google/gemini-cli-core` | **Resolved** |
| ~~Streaming performance different from Claude~~ | ~~Low~~ | ~~Medium~~ | Token-level streaming confirmed (Q3); RAF throttle is model-agnostic | **Resolved** |
