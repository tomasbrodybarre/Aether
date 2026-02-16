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

export interface ClaudeMdResult {
  /** CLAUDE.md content with aether:init blocks stripped */
  instructions: string;
  /** Contents of files from read: directives */
  preReadContent: string;
}

/**
 * Parse aether:init directive blocks from CLAUDE.md content.
 * Executes read: and exec: directives, returns cleaned content
 * and pre-read file contents.
 */
function processDirectives(
  content: string,
  workingDirectory: string,
  totalSize: { value: number },
): { cleaned: string; preRead: string[] } {
  const preRead: string[] = [];

  const cleaned = content.replace(INIT_BLOCK_RE, (_match, block: string) => {
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

    return ''; // strip the directive block from content
  });

  return { cleaned, preRead };
}

/**
 * Read CLAUDE.md files from the filesystem hierarchy, replicating
 * the Claude CLI's behavior. Collects user-level and project-level
 * instructions in order from general to specific.
 *
 * Also parses <!-- aether:init --> directives:
 *   read: /path/to/file.md   — pre-reads file into system prompt
 *   exec: git pull            — runs command server-side (silent)
 */
export function readClaudeMdFiles(workingDirectory: string): ClaudeMdResult {
  const instructionSections: string[] = [];
  const allPreRead: string[] = [];
  const totalSize = { value: 0 };
  const seen = new Set<string>();

  function tryRead(filePath: string): string | null {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return null;
    seen.add(resolved);
    try {
      if (!fs.existsSync(resolved)) return null;
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return null;
      if (stat.size > MAX_SINGLE_FILE_SIZE) return null;
      if (totalSize.value + stat.size > MAX_TOTAL_SIZE) return null;
      const content = fs.readFileSync(resolved, 'utf-8').trim();
      if (!content) return null;
      totalSize.value += content.length;
      return content;
    } catch {
      return null;
    }
  }

  function addClaudeMd(filePath: string, content: string) {
    const { cleaned, preRead } = processDirectives(content, workingDirectory, totalSize);
    const trimmed = cleaned.trim();
    if (trimmed) {
      instructionSections.push(`# Instructions from ${filePath}\n${trimmed}`);
    }
    allPreRead.push(...preRead);
  }

  // 1. User-level: ~/.claude/CLAUDE.md
  const userLevelPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  const userContent = tryRead(userLevelPath);
  if (userContent) {
    addClaudeMd(userLevelPath, userContent);
  }

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
      path.join(dir, 'CLAUDE.md'),
      path.join(dir, '.claude', 'CLAUDE.md'),
    ];
    for (const candidate of candidates) {
      const content = tryRead(candidate);
      if (content) {
        addClaudeMd(candidate, content);
      }
    }
  }

  const instructions = instructionSections.join('\n\n');
  const preReadContent = allPreRead.length > 0
    ? `# Pre-loaded files (from CLAUDE.md startup directives)\n\n${allPreRead.join('\n\n')}`
    : '';

  return { instructions, preReadContent };
}
