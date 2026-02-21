# CLAUDE.md

## Project Overview

Aether — a web-based GUI powered by Gemini CLI Core (`@google/gemini-cli-core`), optimized for scientific and development workflows. Rich inline rendering (images, plots, tables, LaTeX) like a dynamic notebook, with the LLM as the kernel.

## Architecture

- **Frontend**: React 19 + Next.js 16 (App Router) + Tailwind CSS 4 + Radix UI
- **Backend**: Next.js API routes (src/app/api/) + Gemini CLI Core (in-process)
- **LLM**: @google/gemini-cli-core — agent loop runs in-process, no subprocess
- **Database**: SQLite (better-sqlite3)
- **No Electron** — pure web app, runs via `npm run dev` or `npm run build && npm start`

## Development

```
npm install
npm run dev       # Development server on localhost:3000
npm run build     # Production build
npm start         # Start production server
```

## Key Directories

- `src/app/api/` — All backend logic (API routes)
- `src/lib/` — Core server-side logic (gemini-core, DB, files, permissions)
- `src/components/` — React components (ai-elements, chat, layout, plugins, project, settings, skills, ui)
- `src/hooks/` — Custom React hooks
- `src/types/` — TypeScript interfaces
