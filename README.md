# Aether

**A web-based GUI for Claude Code, optimized for scientific workflows.** Rich inline rendering of images, plots, tables, LaTeX, and code — like a dynamic Jupyter Notebook, but where the "kernel" is Claude with full tool use.

Forked from [CodePilot](https://github.com/op7418/CodePilot) (MIT license). Aether strips the Electron desktop shell and rebuilds the interface around scientific computing: inline figure rendering, labeled output blocks, and a stateless execution model designed for research workflows.

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## What's different from CodePilot?

- **No Electron** — runs as a standalone Next.js web app (`npm run dev`)
- **Inline figure rendering** — matplotlib/seaborn plots appear directly in the conversation flow with lightbox preview
- **Labeled output blocks** — assistant messages get `Out[N]` numbering (Jupyter-style) for easy reference
- **Scientific workflow focus** — designed for researchers who need rich output (plots, tables, LaTeX) alongside code execution
- **Flat-rate billing** — wraps the Claude Code CLI (not the API), so it works with a Max subscription at no extra per-token cost

---

## Features

- **Conversational coding** — stream responses from Claude in real time with Markdown rendering, syntax-highlighted code blocks, and tool-call visualization
- **Inline images** — figures saved by Claude (matplotlib, seaborn, etc.) render directly in the conversation
- **Session management** — create, rename, and resume chat sessions, persisted in SQLite
- **Project-aware context** — set a working directory per session with live file tree and file previews
- **Permission controls** — approve, deny, or auto-allow tool use per action
- **Multiple interaction modes** — switch between Code, Plan, and Ask modes
- **Model selector** — switch between Claude models (Opus, Sonnet, Haiku) mid-conversation (defaults to Opus 4.6)
- **MCP server management** — add and configure Model Context Protocol servers (stdio, sse, http)
- **Custom skills** — reusable prompt-based skills invoked as slash commands
- **Settings editor** — visual and JSON editors for `~/.claude/settings.json`
- **Token usage tracking** — input/output token counts and estimated cost per response
- **Dark / Light theme** — one-click toggle

---

## Prerequisites

| Requirement | Minimum version |
|---|---|
| **Node.js** | 18+ |
| **Claude Code CLI** | Installed and authenticated (`claude --version`) |
| **npm** | 9+ (ships with Node 18) |

> Aether calls the Claude Code CLI under the hood. Make sure `claude` is on your `PATH` and authenticated (`claude login`) before starting.

---

## Quick Start

```bash
git clone https://github.com/tomasbrodybarre/CodePilot.git
cd CodePilot

npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Next.js 16](https://nextjs.org/) (App Router) |
| UI components | [Radix UI](https://www.radix-ui.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| Styling | [Tailwind CSS 4](https://tailwindcss.com/) |
| AI integration | [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) |
| Database | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (embedded, per-user) |
| Markdown | react-markdown + remark-gfm + rehype-raw + [Shiki](https://shiki.style/) |
| Streaming | [Vercel AI SDK](https://sdk.vercel.ai/) helpers + Server-Sent Events |
| Icons | [Hugeicons](https://hugeicons.com/) + [Lucide](https://lucide.dev/) |

---

## Project Structure

```
aether/
├── src/
│   ├── app/                 # Next.js App Router pages & API routes
│   │   ├── chat/            # New-chat page & [id] session page
│   │   ├── extensions/      # Skills + MCP server management
│   │   ├── settings/        # Settings editor
│   │   └── api/             # REST + SSE endpoints
│   ├── components/
│   │   ├── ai-elements/     # Message bubbles, code blocks, tool calls
│   │   ├── chat/            # ChatView, MessageList, MessageInput, streaming
│   │   ├── layout/          # AppShell, NavRail, ResizeHandle, panels
│   │   ├── plugins/         # MCP server list & editor
│   │   ├── project/         # FileTree, FilePreview, TaskList
│   │   ├── skills/          # SkillsManager, SkillEditor
│   │   └── ui/              # Radix-based primitives
│   ├── hooks/               # Custom React hooks
│   ├── lib/                 # Core logic (Claude client, DB, files, permissions)
│   └── types/               # TypeScript interfaces
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

- Chat data is stored in `~/.codepilot/codepilot.db` (or `./data/codepilot.db` in dev mode).
- SQLite uses WAL mode for fast concurrent reads during streaming.
- The app detects image paths in Claude's Bash tool output and renders them inline.

---

## License

MIT — forked from [CodePilot](https://github.com/op7418/CodePilot) by op7418.
