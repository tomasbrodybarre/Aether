# Aether

**A web-based GUI powered by Gemini CLI Core, for scientific and development workflows.** Rich inline rendering of images, plots, tables, LaTeX, and code — like a dynamic Jupyter Notebook, but where the "kernel" is an LLM with full tool use.

Built on [Gemini CLI Core](https://github.com/anthropics/gemini-cli) (`@google/gemini-cli-core`, Apache 2.0). Originally forked from [CodePilot](https://github.com/op7418/CodePilot) (MIT license) — Electron shell stripped, backend rebuilt from Claude SDK to Gemini Core (in-process agent loop).

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## Features

### Core

- **Project-based workspace** — turns organized by project with auto-tagging via LLM inference. Tag inheritance from recent turns, with model override on topic change. Timeline, Untagged, and per-project views.
- **Streaming responses** — real-time token streaming with Markdown, syntax-highlighted code blocks, and tool-call visualization
- **Inline images** — figures saved by the agent (matplotlib, seaborn, etc.) render directly in the conversation via markdown image syntax
- **Rich text rendering** — LaTeX (KaTeX), tables (GFM with copy/download), Mermaid diagrams, all via Streamdown
- **Tool execution** — full agent loop with tool scheduling, live shell output streaming, and configurable auto-approve policies
- **Permission controls** — approve, deny, or auto-allow tool use per action. Read-only tools, file edits, and dev tool commands auto-approved by default. Serial queue with (N/M) badge for parallel tool requests.
- **Message queue & interrupt** — type follow-ups while streaming, interrupt with Escape to force immediate handover
- **Model selector** — switch between Gemini models (3.1 Pro, 2.5 Pro/Flash, etc.) mid-conversation. Model persisted per turn.
- **Context injection** — last 5 turns injected into preamble for continuity, project-scoped when tagged

### Memory & Consolidation

- **Memory observation system** — auto-learns from conversations: user corrections, error-recovery patterns, explicit rules, project status changes. Observations stored in project-scoped markdown files in a git-backed memory repo.
- **Two-phase consolidation** — triggered from the workspace panel:
  1. **Compact** — LLM folds staging observations into the project file's structured sections. Reviewed via per-section summary cards with "View full diff" dialog.
  2. **Promote** — LLM identifies project-independent patterns and proposes them as additions to global memory files (`me.md`, `workflows.md`). Per-item approve/skip review with target file, section, and rationale.
- **Git-backed persistence** — each approval step produces a git commit + push. Two commits per full consolidation cycle.

### Extensions

- **MCP server management** — configure Model Context Protocol servers (stdio, sse, http)
- **Custom skills** — reusable prompt-based skills invoked as slash commands
- **Settings editor** — visual and JSON editors for `~/.gemini/settings.json` and Aether-specific settings

### Status & Monitoring

- **Connection status** — pill indicator grounded to actual model health: green on successful responses, red on errors (quota, traffic, auth). Shows auth method (API Key / Google OAuth).
- **Dark / Light theme** — one-click toggle
- **Legacy session import** — import old Claude Code CLI sessions (`.jsonl`) into Aether's turn model

## Prerequisites

| Requirement | Minimum version |
|---|---|
| **Node.js** | 18+ |
| **npm** | 9+ (ships with Node 18) |

**Authentication** (one of):
- Gemini CLI authenticated via `gemini auth login`, or
- `GEMINI_API_KEY` environment variable set in `.env.local`

> Aether uses `@google/gemini-cli-core` in-process — no subprocess spawning. OAuth credentials are shared with the Gemini CLI.

## Quick Start

```bash
git clone https://github.com/m3t-research/Aether.git
cd Aether
git checkout gemini-migration

npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

### API Key Auth (alternative to OAuth)

Create `.env.local` in the project root:

```
GEMINI_API_KEY=your_api_key_here
```

This is auto-detected at startup. No other configuration needed.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Next.js 16](https://nextjs.org/) (App Router) + React 19 |
| UI components | [Radix UI](https://www.radix-ui.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| Styling | [Tailwind CSS 4](https://tailwindcss.com/) |
| LLM backend | [@google/gemini-cli-core](https://www.npmjs.com/package/@google/gemini-cli-core) (in-process agent loop) |
| Database | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (embedded, WAL mode) |
| Markdown | [Streamdown](https://github.com/nicholasgasior/streamdown) + KaTeX + Shiki + Mermaid |
| Streaming | Server-Sent Events (SSE) |
| Icons | [Hugeicons](https://hugeicons.com/) + [Lucide](https://lucide.dev/) |

## Project Structure

```
aether/
├── src/
│   ├── app/                 # Next.js App Router pages & API routes
│   │   ├── project/[tag]/   # Project feed page (primary view)
│   │   ├── chat/            # Legacy session page
│   │   ├── extensions/      # Skills + MCP server management
│   │   ├── settings/        # Settings editor
│   │   └── api/             # REST + SSE endpoints
│   │       ├── chat/        # Streaming chat + permission handling
│   │       ├── consolidate/ # Memory compaction + promotion
│   │       ├── turns/       # Turn CRUD + project listing
│   │       ├── memory/      # Memory status + observation counts
│   │       ├── files/       # File serving, browsing, preview
│   │       ├── tasks/       # Task persistence
│   │       └── ...          # Models, settings, skills, plugins
│   ├── components/
│   │   ├── ai-elements/     # Message bubbles, code blocks, tool calls
│   │   ├── chat/            # ProjectFeedView, MessageList, MessageInput
│   │   ├── layout/          # AppShell, NavRail, WorkspacePanel, ConnectionStatus
│   │   ├── plugins/         # MCP server list & editor
│   │   ├── project/         # FileTree, FilePreview, TaskList
│   │   ├── skills/          # SkillsManager, SkillEditor
│   │   └── ui/              # Radix-based primitives
│   ├── hooks/               # Custom React hooks
│   ├── lib/                 # Core logic (gemini-core, DB, files, permissions)
│   └── types/               # TypeScript interfaces
├── public/                  # Static assets
└── package.json
```

## Architecture

Aether imports `@google/gemini-cli-core` as a library — no subprocess spawning. The agent loop runs in the Next.js server process:

1. **Frontend** sends user prompt via POST to `/api/chat`
2. **gemini-core.ts** creates a `Turn`, builds a preamble (environment info, memory context, recent turns, tagging instructions), and streams events from `GeminiClient.sendMessageStream()`
3. **Tool execution** via Core's `Scheduler` class — handles tool calls, confirmations, and multi-turn loops (up to 25 turns)
4. **SSE stream** maps Core events to frontend-compatible format (text, tool_use, tool_result, permission_request, etc.)
5. **Tag detection transform** scans the first 300 chars of model output for `<!-- project: TagName -->` markers, updates the turn's project tag in the database
6. **PolicyEngine** controls auto-approve rules — read-only tools, file edits, dev commands auto-approved; destructive ops require confirmation
7. **Model health tracking** records success/failure of each streaming request, surfaced in the ConnectionStatus indicator

### Memory System

The memory system uses a git-backed repository of markdown files:

- **`projects/<name>.md`** — per-project files with structured sections (Status, Key Decisions, Session Log, TODO) and a `## Staging` area for new observations
- **`me.md`** — personal preferences and patterns (global)
- **`workflows.md`** — reusable workflow patterns (global)

The agent writes observations to staging via a `update_memory.py` tool. The consolidation pipeline (compact then promote) is triggered manually from the WorkspacePanel and uses `BaseLlmClient` (gemini-2.5-flash) for LLM analysis.

## Configuration

### Shared with Gemini CLI

- `~/.gemini/settings.json` — model selection, MCP servers, auth
- `~/.gemini/GEMINI.md` — system instructions (loaded hierarchically: global + project-level)
- `~/.gemini/skills/` — custom skills directory

### Aether-specific

Stored in SQLite (`~/.codepilot/codepilot.db`):

| Setting | Default | Description |
|---|---|---|
| `content_width` | 100% | Chat column width (50-100%) |
| `font_size` | 100% | Base font size (75-150%) |
| `default_working_directory` | cwd | Default for new turns |
| `memory_enabled` | false | Enable memory observation system |
| `memory_repo_path` | — | Path to git-backed memory repository |
| `consolidation_threshold` | 15 | Observations before nudge toast |

### `<!-- aether:init -->` Directives

GEMINI.md files can include Aether-specific startup directives:

```markdown
<!-- aether:init
exec: git -C /path/to/repo pull       # Run once per server lifecycle
read: /path/to/context.md             # Pre-load into system prompt
-->
```

- `exec:` commands run once (deduplicated across restarts within the same process)
- `read:` files are injected into the preamble as pre-loaded context

## Development

```bash
npm run dev       # Development server on localhost:3000
npm run build     # Production build
npm start         # Start production server
```

## License

MIT — forked from [CodePilot](https://github.com/op7418/CodePilot) by op7418.
