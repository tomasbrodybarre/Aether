import { execFileSync, execFile } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

/**
 * Whether the given binary path requires shell execution.
 * On Windows, .cmd/.bat files cannot be executed directly by execFileSync.
 */
function needsShell(binPath: string): boolean {
  return isWindows && /\.(cmd|bat)$/i.test(binPath);
}

/**
 * Extra PATH directories to search for Claude CLI and other tools.
 */
export function getExtraPathDirs(): string[] {
  const home = os.homedir();
  if (isWindows) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(appData, 'npm'),
      path.join(localAppData, 'npm'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.claude', 'bin'),
      path.join(home, '.local', 'bin'),
      path.join(home, '.nvm', 'current', 'bin'),
    ];
  }
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.nvm', 'current', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'bin'),
  ];
}

/**
 * Claude CLI candidate installation paths.
 */
export function getClaudeCandidatePaths(): string[] {
  const home = os.homedir();
  if (isWindows) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const exts = ['.cmd', '.exe', '.bat', ''];
    const baseDirs = [
      path.join(appData, 'npm'),
      path.join(localAppData, 'npm'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.claude', 'bin'),
      path.join(home, '.local', 'bin'),
    ];
    const candidates: string[] = [];
    for (const dir of baseDirs) {
      for (const ext of exts) {
        candidates.push(path.join(dir, 'claude' + ext));
      }
    }
    return candidates;
  }
  return [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'bin', 'claude'),
  ];
}

/**
 * Build an expanded PATH string with extra directories, deduped and filtered.
 */
export function getExpandedPath(): string {
  const current = process.env.PATH || '';
  const parts = current.split(path.delimiter).filter(Boolean);
  const seen = new Set(parts);
  for (const p of getExtraPathDirs()) {
    if (p && !seen.has(p)) {
      parts.push(p);
      seen.add(p);
    }
  }
  return parts.join(path.delimiter);
}

/**
 * On Windows, npm installs global packages as .cmd wrappers that cannot be
 * spawned by child_process.spawn without shell:true. The Claude Agent SDK
 * does not set shell:true, so spawning claude.cmd fails with EINVAL.
 *
 * However, the SDK checks if the path ends in .js/.mjs — if so, it runs
 * `node <path>` instead of spawning directly. So we resolve .cmd wrappers
 * to the underlying cli.js entry point.
 */
function resolveCliEntryPoint(cmdPath: string): string | undefined {
  if (!isWindows || !/\.(cmd|bat)$/i.test(cmdPath)) return undefined;
  // The .cmd is in e.g. <npm_prefix>/claude.cmd
  // The cli.js is at <npm_prefix>/node_modules/@anthropic-ai/claude-code/cli.js
  const dir = path.dirname(cmdPath);
  const cliJs = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  if (fs.existsSync(cliJs)) return cliJs;
  return undefined;
}

/**
 * Find and validate the Claude CLI binary.
 * Tests each candidate with --version before returning.
 * On Windows, resolves .cmd wrappers to the underlying cli.js so the SDK
 * can spawn via `node cli.js` instead of failing on .cmd execution.
 */
export function findClaudeBinary(): string | undefined {
  // Try known candidate paths first
  for (const p of getClaudeCandidatePaths()) {
    try {
      execFileSync(p, ['--version'], {
        timeout: 3000,
        stdio: 'pipe',
        shell: needsShell(p),
      });
      // On Windows, resolve .cmd to cli.js for SDK compatibility
      return resolveCliEntryPoint(p) || p;
    } catch {
      // not found, try next
    }
  }

  // Fallback: use `where` (Windows) or `which` (Unix) with expanded PATH
  try {
    const cmd = isWindows ? 'where' : '/usr/bin/which';
    const args = isWindows ? ['claude'] : ['claude'];
    const result = execFileSync(cmd, args, {
      timeout: 3000,
      stdio: 'pipe',
      env: { ...process.env, PATH: getExpandedPath() },
      shell: isWindows,
    });
    // where.exe may return multiple lines; try each with --version validation
    const lines = result.toString().trim().split(/\r?\n/);
    for (const line of lines) {
      const candidate = line.trim();
      if (!candidate) continue;
      try {
        execFileSync(candidate, ['--version'], {
          timeout: 3000,
          stdio: 'pipe',
          shell: needsShell(candidate),
        });
        // On Windows, resolve .cmd to cli.js for SDK compatibility
        return resolveCliEntryPoint(candidate) || candidate;
      } catch {
        continue;
      }
    }
  } catch {
    // not found
  }

  return undefined;
}

/**
 * Execute claude --version and return the version string.
 * Handles .cmd shell execution on Windows.
 */
export async function getClaudeVersion(claudePath: string): Promise<string | null> {
  try {
    // If the path is a .js file (resolved from .cmd on Windows), run via node
    const isJs = /\.m?js$/i.test(claudePath);
    const file = isJs ? process.execPath : claudePath;
    const args = isJs ? [claudePath, '--version'] : ['--version'];
    const { stdout } = await execFileAsync(file, args, {
      timeout: 5000,
      env: { ...process.env, PATH: getExpandedPath() },
      shell: needsShell(claudePath),
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Auth info from the Claude CLI credentials file (~/.claude/.credentials.json).
 */
export interface ClaudeAuthInfo {
  /** 'cli' = Max subscription via `claude login`, 'api_key' = provider/env key, 'none' = nothing configured */
  method: 'cli' | 'api_key' | 'none';
  /** e.g. 'max', 'pro', or null */
  subscriptionType: string | null;
  /** e.g. 'default_claude_max_5x' or null */
  rateLimitTier: string | null;
  /** Whether the CLI OAuth token is expired */
  expired: boolean;
  /** ISO string of token expiry, or null */
  expiresAt: string | null;
}

/**
 * Read ~/.claude/.credentials.json to detect CLI login status and subscription.
 * Falls back gracefully — returns method:'none' if file doesn't exist.
 */
export function getClaudeAuthInfo(): ClaudeAuthInfo {
  const none: ClaudeAuthInfo = { method: 'none', subscriptionType: null, rateLimitTier: null, expired: false, expiresAt: null };
  try {
    const home = os.homedir();
    const credPath = path.join(home, '.claude', '.credentials.json');
    if (!fs.existsSync(credPath)) return none;
    const raw = fs.readFileSync(credPath, 'utf-8');
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;
    if (!oauth || !oauth.accessToken) return none;
    const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null;
    const expired = expiresAt ? Date.now() > expiresAt : false;
    return {
      method: 'cli',
      subscriptionType: oauth.subscriptionType || null,
      rateLimitTier: oauth.rateLimitTier || null,
      expired,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    };
  } catch {
    return none;
  }
}

/**
 * Find Git Bash (bash.exe) on Windows.
 * Returns the path to bash.exe or null if not found.
 */
export function findGitBash(): string | null {
  // 1. Check user-specified environment variable
  const envPath = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  // 2. Check common installation paths
  const commonPaths = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // 3. Try to locate git.exe via `where git` and derive bash.exe path
  try {
    const result = execFileSync('where', ['git'], {
      timeout: 3000,
      stdio: 'pipe',
      shell: true,
    });
    const lines = result.toString().trim().split(/\r?\n/);
    for (const line of lines) {
      const gitExe = line.trim();
      if (!gitExe) continue;
      // git.exe is typically at <GitDir>\cmd\git.exe or <GitDir>\bin\git.exe
      const gitDir = path.dirname(path.dirname(gitExe));
      const bashPath = path.join(gitDir, 'bin', 'bash.exe');
      if (fs.existsSync(bashPath)) {
        return bashPath;
      }
    }
  } catch {
    // where git failed or timed out
  }

  return null;
}
