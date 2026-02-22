# Aether

**A web-based GUI powered by Gemini CLI Core, for scientific and development workflows.** Rich inline rendering of images, plots, tables, LaTeX, and code — like a dynamic Jupyter Notebook, but where the "kernel" is an LLM with full tool use.

Built on [Gemini CLI Core](https://github.com/anthropics/gemini-cli) (`@google/gemini-cli-core`, Apache 2.0). Originally forked from [CodePilot](https://github.com/op7418/CodePilot) (MIT license) — Electron shell stripped, backend rebuilt from Claude SDK to Gemini Core (in-process agent loop).

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## Features

- **Project-based workspace** — turns organized by project with auto-tagging via LLM inference. Sidebar shows project tabs, not sessions
- **Streaming responses** — real-time token streaming with Markdown, syntax-highlighted code blocks, and tool-call visualization
- **Inline images** — figures saved by the agent (matplotlib, seaborn, etc.) render directly in the conversation via markdown image syntax
- **Rich text rendering** — LaTeX (KaTeX), tables (GFM), Mermaid diagrams, all via Streamdown
- **Tool execution** — full agent loop with tool scheduling, live shell output streaming, and configurable auto-approve policies
- **Permission controls** — approve, deny, or auto-allow tool use per action. Read-only tools, file edits, and dev tool commands auto-approved by default
- **Message queue & interrupt** — type follow-ups while streaming, interrupt with Escape to force immediate handover
- **Model selector** — switch between Gemini models (3.1 Pro, 2.5 Pro/Flash, etc.) mid-conversation
- **MCP server management** — configure Model Context Protocol servers (stdio, sse, http)
- **Custom skills** — reusable prompt-based skills invoked as slash commands
- **Memory system** (phase 1) — auto-learn from conversations with trigger detection, project-scoped observations, and consolidation
- **Settings editor** — visual and JSON editors for `~/.gemini/settings.json`
- **Dark / Light theme** — one-click toggle
- **Legacy session import** — import old Claude Code CLI sessions (`.jsonl`) into Aether's turn model

---

## Prerequisites

| Requirement | Minimum version |
|---|---|
| **Node.js** | 18+ |
| **Gemini CLI** | Authenticated (`gemini auth login`) |
| **npm** | 9+ (ships with Node 18) |

> Aether uses `@google/gemini-cli-core` in-process — no subprocess spawning. Auth is shared with the Gemini CLI via `gemini auth login`.

---

## Quick Start

```bash
git clone https://github.com/m3t-research/Aether.git
cd Aether
git checkout gemini-migration

npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

---

## Aether v1.1 Roadmap: Gemini Thought Persistence

The current implementation has a bug where Gemini's thought processes are displayed as raw JSON and disappear after the stream ends. The next version will parse, display, and persist these thoughts correctly.

- **New SSE Event Type**: A dedicated `'thought'` event will be emitted from the backend.
- **Frontend Accumulation**: Thoughts will be collected in the UI and displayed in a collapsible "Reasoning" component during and after streaming.
- **Data Persistence**: Thoughts will be saved as part of the message content in the database, ensuring they are available across sessions.

This involves changes across the stack: updating TypeScript types, modifying the backend SSE mapping, enhancing the frontend SSE handler, and adapting the `StreamingMessage` and `MessageItem` components to render the `Reasoning` component.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Next.js 16](https://nextjs.org/) (App Router) |
| UI components | [Radix UI](https://www.radix-ui.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| Styling | [Tailwind CSS 4](https://tailwindcss.com/) |
| LLM backend | [@google/gemini-cli-core](https://www.npmjs.com/package/@google/gemini-cli-core) (in-process agent loop) |
| Database | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (embedded, per-user) |
| Markdown | [Streamdown](https://github.com/nicholasgasior/streamdown) + KaTeX + Shiki + Mermaid |
| Streaming | Server-Sent Events (SSE) |
| Icons | [Hugeicons](https://hugeicons.com/) + [Lucide](https://lucide.dev/) |

---

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
│   ├── components/
│   │   ├── ai-elements/     # Message bubbles, code blocks, tool calls
│   │   ├── chat/            # ProjectFeedView, MessageList, MessageInput
│   │   ├── layout/          # AppShell, NavRail, ChatListPanel
│   │   ├── plugins/         # MCP server list & editor
│   │   ├── project/         # FileTree, FilePreview, TaskList
│   │   ├── skills/          # SkillsManager, SkillEditor
│   │   └── ui/              # Radix-based primitives
│   ├── hooks/               # Custom React hooks
│   ├── lib/                 # Core logic (gemini-core, DB, files, permissions)
│   └── types/               # TypeScript interfaces
├── docs/                    # Architecture docs (migration notes)
├── public/                  # Static assets (logo, etc.)
├── assets/                  # Source assets
├── package.json
└── tsconfig.json
```

---

## Development

```bash
npm run dev       # Development server on localhost:3000
npm run build     # Production build
npm start         # Start production server
```

### Notes

- Chat data stored in `~/.codepilot/codepilot.db` (SQLite, WAL mode for concurrent reads during streaming)
- Configuration at `~/.gemini/settings.json` (shared with Gemini CLI)
- `GEMINI.md` files loaded hierarchically: `~/.gemini/GEMINI.md` + project-level
- `<!-- aether:init -->` directive blocks in GEMINI.md for startup commands (`exec:`) and file pre-loading (`read:`)

---

## Architecture

Aether imports `@google/gemini-cli-core` as a library — no subprocess spawning. The agent loop runs in the Next.js server process:

1. **Frontend** sends user prompt via POST to `/api/chat`
2. **gemini-core.ts** creates a `Turn`, streams events from `GeminiClient.sendMessageStream()`
3. **Tool execution** via Core's `Scheduler` class — handles tool calls, confirmations, and multi-turn loops
4. **SSE stream** maps Core events to frontend-compatible format (text, tool_use, tool_result, permission_request, etc.)
5. **PolicyEngine** controls auto-approve rules — read-only tools, file edits, dev commands auto-approved; destructive ops require confirmation

---

## License

MIT — forked from [CodePilot](https://github.com/op7418/CodePilot) by op7418.
