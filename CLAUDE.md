# CLAUDE.md

## Project Overview

Claude Science Lab -- a web-based GUI for Claude Code, optimized for scientific workflows.
Forked from CodePilot (op7418), Electron shell stripped. Runs as a standalone Next.js app.

## Architecture

- **Frontend**: React 19 + Next.js 16 (App Router) + Tailwind CSS 4 + Radix UI
- **Backend**: Next.js API routes (src/app/api/)
- **Claude integration**: @anthropic-ai/claude-agent-sdk -- streams via SSE
- **Database**: SQLite (better-sqlite3) at ~/.codepilot/codepilot.db
- **No Electron** -- pure web app, runs via `npm run dev` or `npm run build && npm start`

## Development

```
npm install
npm run dev       # Development server on localhost:3000
npm run build     # Production build
npm start         # Start production server
```

## Key Directories

- `src/app/api/` -- All backend logic (API routes)
- `src/lib/` -- Core server-side logic (Claude client, DB, files, permissions)
- `src/components/` -- React components (ai-elements, chat, layout, plugins, project, settings, skills, ui)
- `src/hooks/` -- Custom React hooks
- `src/types/` -- TypeScript interfaces
