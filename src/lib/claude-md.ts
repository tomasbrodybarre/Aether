import fs from 'fs';
import os from 'os';
import path from 'path';

const MAX_SINGLE_FILE_SIZE = 50 * 1024; // 50KB per file
const MAX_TOTAL_SIZE = 200 * 1024;      // 200KB total

/**
 * Read CLAUDE.md files from the filesystem hierarchy, replicating
 * the Claude CLI's behavior. Collects user-level and project-level
 * instructions in order from general to specific.
 */
export function readClaudeMdFiles(workingDirectory: string): string {
  const sections: string[] = [];
  let totalSize = 0;
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
      if (totalSize + stat.size > MAX_TOTAL_SIZE) return null;
      const content = fs.readFileSync(resolved, 'utf-8').trim();
      if (!content) return null;
      totalSize += content.length;
      return content;
    } catch {
      return null;
    }
  }

  // 1. User-level: ~/.claude/CLAUDE.md
  const userLevelPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  const userContent = tryRead(userLevelPath);
  if (userContent) {
    sections.push(`# Instructions from ${userLevelPath}\n${userContent}`);
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
        sections.push(`# Instructions from ${candidate}\n${content}`);
      }
    }
  }

  return sections.join('\n\n');
}
