import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import type { ChatSession, Message, SettingsMap, TaskItem, TaskStatus, ApiProvider, CreateProviderRequest, UpdateProviderRequest, TurnToolCall, TurnThought, CellEdit, ProjectDocMapping } from '@/types';

const dataDir = process.env.CLAUDE_GUI_DATA_DIR || path.join(require('os').homedir(), '.codepilot');
const DB_PATH = path.join(dataDir, 'codepilot.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const fs = require('fs');
    const os = require('os');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Migrate from old locations if the new DB doesn't exist yet
    if (!fs.existsSync(DB_PATH)) {
      const home = os.homedir();
      const oldPaths = [
        // Old desktop app userData paths
        path.join(home, 'Library', 'Application Support', 'CodePilot', 'codepilot.db'),
        path.join(home, 'Library', 'Application Support', 'codepilot', 'codepilot.db'),
        path.join(home, 'Library', 'Application Support', 'Claude GUI', 'codepilot.db'),
        // Old dev-mode fallback
        path.join(process.cwd(), 'data', 'codepilot.db'),
        // Legacy name
        path.join(home, 'Library', 'Application Support', 'CodePilot', 'claude-gui.db'),
        path.join(home, 'Library', 'Application Support', 'codepilot', 'claude-gui.db'),
      ];
      for (const oldPath of oldPaths) {
        if (fs.existsSync(oldPath)) {
          try {
            fs.copyFileSync(oldPath, DB_PATH);
            // Also copy WAL/SHM if they exist
            if (fs.existsSync(oldPath + '-wal')) fs.copyFileSync(oldPath + '-wal', DB_PATH + '-wal');
            if (fs.existsSync(oldPath + '-shm')) fs.copyFileSync(oldPath + '-shm', DB_PATH + '-shm');
            console.log(`[db] Migrated database from ${oldPath}`);
            break;
          } catch (err) {
            console.warn(`[db] Failed to migrate from ${oldPath}:`, err);
          }
        }
      }
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initDb(db);
  }
  return db;
}

function initDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      model TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      working_directory TEXT NOT NULL DEFAULT '',
      sdk_session_id TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      token_usage TEXT,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS api_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'anthropic',
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      extra_env TEXT NOT NULL DEFAULT '{}',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON chat_sessions(updated_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);

    -- Turns table: project-based turn model (Gemini migration)
    -- Each turn is a single (prompt, response) pair tagged to a project.
    -- Replaces the session model for new conversations.
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      project_tag TEXT,
      prompt TEXT NOT NULL,
      response TEXT,
      model TEXT,
      usage_input INTEGER,
      usage_output INTEGER,
      tool_calls INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_turns_project ON turns(project_tag, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_turns_created_at ON turns(created_at DESC);

    -- Turn activity: persisted tool calls and thoughts
    CREATE TABLE IF NOT EXISTS turn_tool_calls (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      result_content TEXT,
      is_error INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_turn_tool_calls_turn ON turn_tool_calls(turn_id);

    CREATE TABLE IF NOT EXISTS turn_thoughts (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_turn_thoughts_turn ON turn_thoughts(turn_id);

    -- Cell edits: delta-based versioning for editable cells
    CREATE TABLE IF NOT EXISTS cell_edits (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      cell_index INTEGER NOT NULL,
      version INTEGER NOT NULL,
      delta TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('discuss', 'save')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cell_edits_turn ON cell_edits(turn_id, cell_index, version);

    -- Project-to-Google-Doc mappings
    CREATE TABLE IF NOT EXISTS project_doc_mappings (
      project_tag TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      doc_title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Run migrations for existing databases
  migrateDb(db);
}

function migrateDb(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(chat_sessions)").all() as { name: string }[];
  const colNames = columns.map(c => c.name);

  if (!colNames.includes('model')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('system_prompt')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('sdk_session_id')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN sdk_session_id TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('project_name')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN project_name TEXT NOT NULL DEFAULT ''");
    // Backfill project_name from working_directory for existing rows
    db.exec(`
      UPDATE chat_sessions
      SET project_name = CASE
        WHEN working_directory != '' THEN REPLACE(REPLACE(working_directory, RTRIM(working_directory, REPLACE(working_directory, '/', '')), ''), '/', '')
        ELSE ''
      END
      WHERE project_name = ''
    `);
  }
  if (!colNames.includes('status')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
  if (!colNames.includes('mode')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'code'");
  }
  if (!colNames.includes('project_tag')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN project_tag TEXT");
  }
  if (!colNames.includes('project_tag_source')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN project_tag_source TEXT");
  }

  const msgColumns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  const msgColNames = msgColumns.map(c => c.name);

  if (!msgColNames.includes('token_usage')) {
    db.exec("ALTER TABLE messages ADD COLUMN token_usage TEXT");
  }

  if (!msgColNames.includes('project_tag')) {
    db.exec("ALTER TABLE messages ADD COLUMN project_tag TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_messages_project_tag ON messages(project_tag)");
  }

  // Ensure tasks table exists for databases created before this migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
  `);

  // Ensure api_providers table exists for databases created before this migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'anthropic',
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      extra_env TEXT NOT NULL DEFAULT '{}',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Ensure turns table exists for databases created before the Gemini migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      project_tag TEXT,
      prompt TEXT NOT NULL,
      response TEXT,
      model TEXT,
      usage_input INTEGER,
      usage_output INTEGER,
      tool_calls INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_turns_project ON turns(project_tag, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_turns_created_at ON turns(created_at DESC);
  `);

  // Migrate turns table — add new columns for project-based model
  const turnCols = db.prepare("PRAGMA table_info(turns)").all() as { name: string }[];
  const turnColNames = turnCols.map(c => c.name);
  if (!turnColNames.includes('title')) {
    db.exec("ALTER TABLE turns ADD COLUMN title TEXT NOT NULL DEFAULT ''");
    // Backfill titles from existing prompt text
    db.exec("UPDATE turns SET title = SUBSTR(prompt, 1, 80) WHERE title = ''");
  }
  if (!turnColNames.includes('working_directory')) {
    db.exec("ALTER TABLE turns ADD COLUMN working_directory TEXT");
  }
  if (!turnColNames.includes('mode')) {
    db.exec("ALTER TABLE turns ADD COLUMN mode TEXT NOT NULL DEFAULT 'code'");
  }
  if (!turnColNames.includes('project_tag_source')) {
    db.exec("ALTER TABLE turns ADD COLUMN project_tag_source TEXT");
  }

  // Ensure turn activity tables exist for databases created before this migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_tool_calls (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      result_content TEXT,
      is_error INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_turn_tool_calls_turn ON turn_tool_calls(turn_id);

    CREATE TABLE IF NOT EXISTS turn_thoughts (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_turn_thoughts_turn ON turn_thoughts(turn_id);
  `);

  // Ensure cell_edits table exists for databases created before this migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS cell_edits (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      cell_index INTEGER NOT NULL,
      version INTEGER NOT NULL,
      delta TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('discuss', 'save')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cell_edits_turn ON cell_edits(turn_id, cell_index, version);
  `);

  // Ensure project_doc_mappings table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_doc_mappings (
      project_tag TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      doc_title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrate existing settings to a default provider if api_providers is empty
  const providerCount = db.prepare('SELECT COUNT(*) as count FROM api_providers').get() as { count: number };
  if (providerCount.count === 0) {
    const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_auth_token'").get() as { value: string } | undefined;
    const baseUrlRow = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_base_url'").get() as { value: string } | undefined;
    if (tokenRow || baseUrlRow) {
      const id = crypto.randomBytes(16).toString('hex');
      const now = new Date().toISOString().replace('T', ' ').split('.')[0];
      db.prepare(
        'INSERT INTO api_providers (id, name, provider_type, base_url, api_key, is_active, sort_order, extra_env, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, 'Default', 'anthropic', baseUrlRow?.value || '', tokenRow?.value || '', 1, 0, '{}', 'Migrated from settings', now, now);
    }
  }
}

// ==========================================
// Session Operations
// ==========================================

export function getAllSessions(): ChatSession[] {
  const db = getDb();
  return db.prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC').all() as ChatSession[];
}

export function getSession(id: string): ChatSession | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as ChatSession | undefined;
}

export function createSession(
  title?: string,
  model?: string,
  systemPrompt?: string,
  workingDirectory?: string,
  mode?: string,
): ChatSession {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const wd = workingDirectory || getSetting('default_working_directory') || process.cwd();
  const projectName = path.basename(wd);

  db.prepare(
    'INSERT INTO chat_sessions (id, title, created_at, updated_at, model, system_prompt, working_directory, sdk_session_id, project_name, status, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, title || 'New Chat', now, now, model || '', systemPrompt || '', wd, '', projectName, 'active', mode || 'code');

  return getSession(id)!;
}

export function deleteSession(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

export function updateSessionTimestamp(id: string): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, id);
}

export function updateSessionTitle(id: string, title: string): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(title, id);
}

export function updateSdkSessionId(id: string, sdkSessionId: string): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id);
}

export function updateSessionWorkingDirectory(id: string, workingDirectory: string): void {
  const db = getDb();
  const projectName = path.basename(workingDirectory);
  db.prepare('UPDATE chat_sessions SET working_directory = ?, project_name = ? WHERE id = ?').run(workingDirectory, projectName, id);
}

export function updateSessionMode(id: string, mode: string): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET mode = ? WHERE id = ?').run(mode, id);
}

export function updateSessionProjectTag(
  id: string,
  projectTag: string | null,
  source?: 'inferred' | 'manual' | null,
): void {
  const db = getDb();
  if (source !== undefined) {
    db.prepare('UPDATE chat_sessions SET project_tag = ?, project_tag_source = ? WHERE id = ?').run(projectTag, source, id);
  } else {
    db.prepare('UPDATE chat_sessions SET project_tag = ? WHERE id = ?').run(projectTag, id);
  }
}

/** Get all distinct project tags from both sessions and turns */
export function getAllProjectTagsUnified(): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT tag FROM (
      SELECT project_tag AS tag FROM chat_sessions WHERE project_tag IS NOT NULL AND project_tag != ''
      UNION
      SELECT project_name AS tag FROM chat_sessions WHERE project_name IS NOT NULL AND project_name != ''
      UNION
      SELECT project_tag AS tag FROM turns WHERE project_tag IS NOT NULL AND project_tag != ''
    )
    ORDER BY tag ASC
  `).all() as { tag: string }[];
  return rows.map(r => r.tag);
}

// ==========================================
// Message Operations
// ==========================================

export function getMessages(sessionId: string): Message[] {
  const db = getDb();
  return db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as Message[];
}

export function addMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  tokenUsage?: string | null,
): Message {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  db.prepare(
    'INSERT INTO messages (id, session_id, role, content, created_at, token_usage) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, sessionId, role, content, now, tokenUsage || null);

  updateSessionTimestamp(sessionId);

  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message;
}

export function clearSessionMessages(sessionId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  // Reset SDK session ID so next message starts fresh
  db.prepare('UPDATE chat_sessions SET sdk_session_id = ? WHERE id = ?').run('', sessionId);
}

// ==========================================
// Turn Operations (project-based turn model)
// ==========================================

export interface Turn {
  id: string;
  project_tag: string | null;
  project_tag_source: 'inferred' | 'manual' | null;
  title: string;
  prompt: string;
  response: string | null;
  model: string | null;
  working_directory: string | null;
  mode: string;
  usage_input: number | null;
  usage_output: number | null;
  tool_calls: number;
  created_at: string;
  duration_ms: number | null;
}

export function createTurn(
  prompt: string,
  projectTag?: string | null,
  model?: string | null,
  workingDirectory?: string | null,
  mode?: string | null,
): Turn {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const title = prompt.slice(0, 80) + (prompt.length > 80 ? '...' : '');

  db.prepare(
    'INSERT INTO turns (id, project_tag, title, prompt, model, working_directory, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, projectTag || null, title, prompt, model || null, workingDirectory || null, mode || 'code', now);

  return db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as Turn;
}

export function updateTurnResponse(
  id: string,
  response: string,
  usageInput?: number | null,
  usageOutput?: number | null,
  toolCalls?: number,
  durationMs?: number | null,
): void {
  const db = getDb();
  db.prepare(
    'UPDATE turns SET response = ?, usage_input = ?, usage_output = ?, tool_calls = ?, duration_ms = ? WHERE id = ?'
  ).run(
    response,
    usageInput ?? null,
    usageOutput ?? null,
    toolCalls ?? 0,
    durationMs ?? null,
    id,
  );
}

export function getTurn(id: string): Turn | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as Turn | undefined;
}

export function getTurnsByProject(projectTag: string | null): Turn[] {
  const db = getDb();
  if (projectTag === null) {
    return db.prepare('SELECT * FROM turns WHERE project_tag IS NULL ORDER BY created_at DESC').all() as Turn[];
  }
  return db.prepare('SELECT * FROM turns WHERE project_tag = ? ORDER BY created_at DESC').all(projectTag) as Turn[];
}

export function getRecentTurns(limit: number = 50): Turn[] {
  const db = getDb();
  return db.prepare('SELECT * FROM turns ORDER BY created_at DESC LIMIT ?').all(limit) as Turn[];
}

export function getAllProjectTags(): string[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT DISTINCT project_tag FROM turns WHERE project_tag IS NOT NULL ORDER BY project_tag ASC'
  ).all() as { project_tag: string }[];
  return rows.map(r => r.project_tag);
}

export function updateTurnProjectTag(
  id: string,
  projectTag: string | null,
  source?: 'inferred' | 'manual' | null,
): void {
  const db = getDb();
  if (source !== undefined) {
    db.prepare('UPDATE turns SET project_tag = ?, project_tag_source = ? WHERE id = ?').run(projectTag, source, id);
  } else {
    db.prepare('UPDATE turns SET project_tag = ? WHERE id = ?').run(projectTag, id);
  }
}

/** Get turns for a project in chronological order (oldest first) for feed display */
export function getTurnsByProjectAsc(projectTag: string | null): Turn[] {
  const db = getDb();
  if (projectTag === null) {
    return db.prepare('SELECT * FROM turns WHERE project_tag IS NULL ORDER BY created_at ASC').all() as Turn[];
  }
  return db.prepare('SELECT * FROM turns WHERE project_tag = ? ORDER BY created_at ASC').all(projectTag) as Turn[];
}

/** Get lightweight recent turn context for preamble injection */
export function getRecentTurnContext(limit: number = 5, projectTag?: string | null): {
  prompt: string; response: string | null; project_tag: string | null; created_at: string;
}[] {
  const db = getDb();
  if (projectTag !== undefined && projectTag !== null) {
    return db.prepare(
      'SELECT prompt, response, project_tag, created_at FROM turns WHERE project_tag = ? ORDER BY created_at DESC LIMIT ?'
    ).all(projectTag, limit) as { prompt: string; response: string | null; project_tag: string | null; created_at: string; }[];
  }
  return db.prepare(
    'SELECT prompt, response, project_tag, created_at FROM turns ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as { prompt: string; response: string | null; project_tag: string | null; created_at: string; }[];
}

export function deleteTurn(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM turns WHERE id = ?').run(id);
  return result.changes > 0;
}

// ==========================================
// Settings Operations
// ==========================================

export function getSetting(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function getAllSettings(): SettingsMap {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: SettingsMap = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

// ==========================================
// Session Status Operations
// ==========================================

export function updateSessionStatus(id: string, status: 'active' | 'archived'): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET status = ? WHERE id = ?').run(status, id);
}

// ==========================================
// Task Operations
// ==========================================

export function getTasksBySession(sessionId: string): TaskItem[] {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as TaskItem[];
}

export function getTask(id: string): TaskItem | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskItem | undefined;
}

export function createTask(sessionId: string, title: string, description?: string): TaskItem {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  db.prepare(
    'INSERT INTO tasks (id, session_id, title, status, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, sessionId, title, 'pending', description || null, now, now);

  return getTask(id)!;
}

export function updateTask(id: string, updates: { title?: string; status?: TaskStatus; description?: string }): TaskItem | undefined {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const existing = getTask(id);
  if (!existing) return undefined;

  const title = updates.title ?? existing.title;
  const status = updates.status ?? existing.status;
  const description = updates.description !== undefined ? updates.description : existing.description;

  db.prepare(
    'UPDATE tasks SET title = ?, status = ?, description = ?, updated_at = ? WHERE id = ?'
  ).run(title, status, description, now, id);

  return getTask(id);
}

export function deleteTask(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return result.changes > 0;
}

// ==========================================
// Turn Activity Operations (tool calls + thoughts)
// ==========================================

export function insertToolCall(
  turnId: string,
  toolCallId: string,
  toolName: string,
  toolInput?: string | null,
): TurnToolCall {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  db.prepare(
    'INSERT INTO turn_tool_calls (id, turn_id, tool_call_id, tool_name, tool_input, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, turnId, toolCallId, toolName, toolInput || null, now);

  return db.prepare('SELECT * FROM turn_tool_calls WHERE id = ?').get(id) as TurnToolCall;
}

export function updateToolCallResult(
  toolCallId: string,
  content: string,
  isError?: boolean,
): void {
  const db = getDb();
  db.prepare(
    'UPDATE turn_tool_calls SET result_content = ?, is_error = ? WHERE tool_call_id = ?'
  ).run(content, isError ? 1 : 0, toolCallId);
}

export function insertThought(turnId: string, text: string): TurnThought {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  db.prepare(
    'INSERT INTO turn_thoughts (id, turn_id, text, created_at) VALUES (?, ?, ?, ?)'
  ).run(id, turnId, text, now);

  return db.prepare('SELECT * FROM turn_thoughts WHERE id = ?').get(id) as TurnThought;
}

export function getToolCallsByTurn(turnId: string): TurnToolCall[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM turn_tool_calls WHERE turn_id = ? ORDER BY created_at ASC'
  ).all(turnId) as TurnToolCall[];
}

export function getThoughtsByTurn(turnId: string): TurnThought[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM turn_thoughts WHERE turn_id = ? ORDER BY created_at ASC'
  ).all(turnId) as TurnThought[];
}

// ==========================================
// Cell Edit Operations (delta-based versioning)
// ==========================================

export function insertCellEdit(
  turnId: string,
  cellIndex: number,
  version: number,
  delta: string,
  action: 'discuss' | 'save',
): CellEdit {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  db.prepare(
    'INSERT INTO cell_edits (id, turn_id, cell_index, version, delta, action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, turnId, cellIndex, version, delta, action, now);

  return db.prepare('SELECT * FROM cell_edits WHERE id = ?').get(id) as CellEdit;
}

export function getCellEdits(turnId: string, cellIndex: number): CellEdit[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM cell_edits WHERE turn_id = ? AND cell_index = ? ORDER BY version ASC'
  ).all(turnId, cellIndex) as CellEdit[];
}

export function getLatestCellVersion(turnId: string, cellIndex: number): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT MAX(version) as max_version FROM cell_edits WHERE turn_id = ? AND cell_index = ?'
  ).get(turnId, cellIndex) as { max_version: number | null };
  return row.max_version ?? 0;
}

/** Get recent save-type cell edits for preamble injection */
export function getRecentSaveCellEdits(limit: number = 10, projectTag?: string | null): CellEdit[] {
  const db = getDb();
  if (projectTag !== undefined && projectTag !== null) {
    return db.prepare(`
      SELECT ce.* FROM cell_edits ce
      JOIN turns t ON ce.turn_id = t.id
      WHERE ce.action = 'save' AND t.project_tag = ?
      ORDER BY ce.created_at DESC LIMIT ?
    `).all(projectTag, limit) as CellEdit[];
  }
  return db.prepare(`
    SELECT ce.* FROM cell_edits ce
    WHERE ce.action = 'save'
    ORDER BY ce.created_at DESC LIMIT ?
  `).all(limit) as CellEdit[];
}

// ==========================================
// Project-Doc Mapping Operations (Google Docs integration)
// ==========================================

export function getProjectDocMapping(projectTag: string): ProjectDocMapping | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM project_doc_mappings WHERE project_tag = ?').get(projectTag) as ProjectDocMapping | undefined;
}

export function setProjectDocMapping(projectTag: string, docId: string, docTitle?: string): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(
    'INSERT OR REPLACE INTO project_doc_mappings (project_tag, doc_id, doc_title, created_at) VALUES (?, ?, ?, ?)'
  ).run(projectTag, docId, docTitle || null, now);
}

export function deleteProjectDocMapping(projectTag: string): void {
  const db = getDb();
  db.prepare('DELETE FROM project_doc_mappings WHERE project_tag = ?').run(projectTag);
}

export function getAllProjectDocMappings(): ProjectDocMapping[] {
  const db = getDb();
  return db.prepare('SELECT * FROM project_doc_mappings ORDER BY project_tag ASC').all() as ProjectDocMapping[];
}

// ==========================================
// API Provider Operations
// ==========================================

export function getAllProviders(): ApiProvider[] {
  const db = getDb();
  return db.prepare('SELECT * FROM api_providers ORDER BY sort_order ASC, created_at ASC').all() as ApiProvider[];
}

export function getProvider(id: string): ApiProvider | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM api_providers WHERE id = ?').get(id) as ApiProvider | undefined;
}

export function getActiveProvider(): ApiProvider | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM api_providers WHERE is_active = 1 LIMIT 1').get() as ApiProvider | undefined;
}

export function createProvider(data: CreateProviderRequest): ApiProvider {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  // Get max sort_order to append at end
  const maxRow = db.prepare('SELECT MAX(sort_order) as max_order FROM api_providers').get() as { max_order: number | null };
  const sortOrder = (maxRow.max_order ?? -1) + 1;

  db.prepare(
    'INSERT INTO api_providers (id, name, provider_type, base_url, api_key, is_active, sort_order, extra_env, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    data.name,
    data.provider_type || 'anthropic',
    data.base_url || '',
    data.api_key || '',
    0,
    sortOrder,
    data.extra_env || '{}',
    data.notes || '',
    now,
    now,
  );

  return getProvider(id)!;
}

export function updateProvider(id: string, data: UpdateProviderRequest): ApiProvider | undefined {
  const db = getDb();
  const existing = getProvider(id);
  if (!existing) return undefined;

  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const name = data.name ?? existing.name;
  const providerType = data.provider_type ?? existing.provider_type;
  const baseUrl = data.base_url ?? existing.base_url;
  const apiKey = data.api_key ?? existing.api_key;
  const extraEnv = data.extra_env ?? existing.extra_env;
  const notes = data.notes ?? existing.notes;
  const sortOrder = data.sort_order ?? existing.sort_order;

  db.prepare(
    'UPDATE api_providers SET name = ?, provider_type = ?, base_url = ?, api_key = ?, extra_env = ?, notes = ?, sort_order = ?, updated_at = ? WHERE id = ?'
  ).run(name, providerType, baseUrl, apiKey, extraEnv, notes, sortOrder, now, id);

  return getProvider(id);
}

export function deleteProvider(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM api_providers WHERE id = ?').run(id);
  return result.changes > 0;
}

export function activateProvider(id: string): boolean {
  const db = getDb();
  const existing = getProvider(id);
  if (!existing) return false;

  const transaction = db.transaction(() => {
    db.prepare('UPDATE api_providers SET is_active = 0').run();
    db.prepare('UPDATE api_providers SET is_active = 1 WHERE id = ?').run(id);
  });
  transaction();
  return true;
}

export function deactivateAllProviders(): void {
  const db = getDb();
  db.prepare('UPDATE api_providers SET is_active = 0').run();
}

// ==========================================
// Graceful Shutdown
// ==========================================

/**
 * Close the database connection gracefully.
 * In WAL mode, this ensures the WAL is checkpointed and the
 * -wal/-shm files are cleaned up properly.
 */
export function closeDb(): void {
  if (db) {
    try {
      db.close();
      console.log('[db] Database closed gracefully');
    } catch (err) {
      console.warn('[db] Error closing database:', err);
    }
    db = null;
  }
}

// Register shutdown handlers to close the database when the process exits.
// This prevents WAL file accumulation and potential data loss.
function registerShutdownHandlers(): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[db] Received ${signal}, closing database...`);
    closeDb();
  };

  // 'exit' fires synchronously when the process is about to exit
  process.on('exit', () => shutdown('exit'));

  // Handle termination signals (Docker stop, systemd, Ctrl+C, etc.)
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
    process.exit(0);
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
    process.exit(0);
  });

  // Handle Windows-specific close events
  if (process.platform === 'win32') {
    process.on('SIGHUP', () => {
      shutdown('SIGHUP');
      process.exit(0);
    });
  }
}

registerShutdownHandlers();
