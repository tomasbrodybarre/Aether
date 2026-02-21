/**
 * aether-init.ts — Process Aether-specific startup directives from GEMINI.md files.
 *
 * Gemini CLI Core loads GEMINI.md content natively into the system instruction.
 * This module handles only the Aether-specific `<!-- aether:init -->` directive
 * blocks, which Core doesn't understand:
 *
 *   <!-- aether:init
 *   exec: git -C /path/to/repo pull      # run command server-side (once per lifecycle)
 *   read: /path/to/file.md               # pre-read file into the system prompt
 *   -->
 *
 * The module discovers GEMINI.md files from the same hierarchy Core uses:
 *   1. ~/.gemini/GEMINI.md (global)
 *   2. Walk from filesystem root to workingDirectory (project-level)
 *      checking GEMINI.md and .gemini/GEMINI.md at each level
 *
 * Core loads the full GEMINI.md content — we only extract and execute directives,
 * then return the pre-read file contents for injection into the Aether preamble.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

const MAX_SINGLE_FILE_SIZE = 50 * 1024; // 50KB per file
const MAX_TOTAL_SIZE = 200 * 1024;      // 200KB total
const EXEC_TIMEOUT = 10_000;            // 10s timeout for exec directives

// Matches <!-- aether:init ... --> blocks (multiline)
const INIT_BLOCK_RE = /<!--\s*aether:init\s*\n([\s\S]*?)-->/g;

// Track which exec commands have already run this app lifecycle
const executedCommands = new Set<string>();

export interface AetherInitResult {
  /** Contents of files from read: directives, formatted for system prompt */
  preReadContent: string;
  /** Number of exec commands that ran */
  execCount: number;
  /** Number of files pre-read */
  readCount: number;
}

/**
 * Process aether:init directive blocks from GEMINI.md content.
 * Executes exec: commands (once per lifecycle) and reads files from read: directives.
 */
function processDirectives(
  content: string,
  workingDirectory: string,
  totalSize: { value: number },
): { preRead: string[] } {
  const preRead: string[] = [];

  // We don't modify the content — Core loads it as-is.
  // We only extract and execute the directives.
  let match: RegExpExecArray | null;
  const re = new RegExp(INIT_BLOCK_RE.source, INIT_BLOCK_RE.flags);

  while ((match = re.exec(content)) !== null) {
    const block = match[1];
    const lines = block.split('\n').map((l: string) => l.trim()).filter(Boolean);

    for (const line of lines) {
      if (line.startsWith('read:')) {
        const filePath = line.slice(5).trim();
        try {
          const resolved = path.resolve(filePath);
          if (!fs.existsSync(resolved)) continue;
          const stat = fs.statSync(resolved);
          if (!stat.isFile() || stat.size > MAX_SINGLE_FILE_SIZE) continue;
          if (totalSize.value + stat.size > MAX_TOTAL_SIZE) continue;
          const fileContent = fs.readFileSync(resolved, 'utf-8').trim();
          if (fileContent) {
            totalSize.value += fileContent.length;
            preRead.push(`## Contents of ${resolved}\n${fileContent}`);
          }
        } catch {
          // skip unreadable files
        }
      } else if (line.startsWith('exec:')) {
        const command = line.slice(5).trim();
        // Only run each exec command once per app lifecycle
        if (!executedCommands.has(command)) {
          executedCommands.add(command);
          try {
            execSync(command, {
              cwd: workingDirectory,
              timeout: EXEC_TIMEOUT,
              stdio: 'pipe',
            });
          } catch {
            // exec failures are non-fatal
          }
        }
      }
    }
  }

  return { preRead };
}

/**
 * Discover GEMINI.md files from the filesystem hierarchy and process
 * any aether:init directives found in them.
 *
 * This mirrors the same discovery paths that Gemini CLI Core uses:
 *   1. ~/.gemini/GEMINI.md (global)
 *   2. Walk from filesystem root → workingDirectory:
 *      - GEMINI.md at each directory level
 *      - .gemini/GEMINI.md at each directory level
 *
 * Returns pre-read file contents and exec/read counts.
 */
export function processAetherInitDirectives(workingDirectory: string): AetherInitResult {
  const allPreRead: string[] = [];
  const totalSize = { value: 0 };
  const seen = new Set<string>();
  let execCount = 0;
  let readCount = 0;

  function tryProcess(filePath: string): void {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    seen.add(resolved);

    try {
      if (!fs.existsSync(resolved)) return;
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return;
      if (stat.size > MAX_SINGLE_FILE_SIZE) return;
      const content = fs.readFileSync(resolved, 'utf-8');
      if (!content.includes('aether:init')) return; // fast path: skip files without directives

      const prevExecCount = executedCommands.size;
      const { preRead } = processDirectives(content, workingDirectory, totalSize);
      execCount += executedCommands.size - prevExecCount;
      readCount += preRead.length;
      allPreRead.push(...preRead);
    } catch {
      // skip unreadable files
    }
  }

  // 1. Global: ~/.gemini/GEMINI.md
  const globalPath = path.join(os.homedir(), '.gemini', 'GEMINI.md');
  tryProcess(globalPath);

  // 2. Walk from filesystem root to working directory
  const resolved = path.resolve(workingDirectory);
  const ancestors: string[] = [];
  let current = resolved;
  while (true) {
    ancestors.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break; // reached root
    current = parent;
  }

  for (const dir of ancestors) {
    const candidates = [
      path.join(dir, 'GEMINI.md'),
      path.join(dir, '.gemini', 'GEMINI.md'),
    ];
    for (const candidate of candidates) {
      tryProcess(candidate);
    }
  }

  const preReadContent = allPreRead.length > 0
    ? `# Pre-loaded files (from GEMINI.md startup directives)\n\n${allPreRead.join('\n\n')}`
    : '';

  return { preReadContent, execCount, readCount };
}

/**
 * Reset the exec tracking (for testing or server restart).
 */
export function resetExecTracking(): void {
  executedCommands.clear();
}
