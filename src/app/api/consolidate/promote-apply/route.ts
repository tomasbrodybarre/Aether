import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getSetting } from '@/lib/db';

interface PromotionCandidate {
  text: string;
  targetFile: 'me.md' | 'workflows.md';
  targetSection: string;
  action: 'add' | 'replace';
  replaceTarget?: string;
  rationale: string;
}

/**
 * Apply a single candidate to a file's content.
 * For "add": appends a bullet under the target section heading.
 * For "replace": finds replaceTarget text and swaps it.
 */
function applyCandidate(content: string, candidate: PromotionCandidate): string {
  const lines = content.split('\n');

  if (candidate.action === 'replace' && candidate.replaceTarget) {
    // Find and replace the target text
    const idx = content.indexOf(candidate.replaceTarget);
    if (idx !== -1) {
      return content.slice(0, idx) + candidate.text + content.slice(idx + candidate.replaceTarget.length);
    }
    // Fallback: if exact match not found, fall through to add
  }

  // "add" action: find the target section and append after its last content line
  const sectionPattern = candidate.targetSection.startsWith('#')
    ? candidate.targetSection
    : `## ${candidate.targetSection}`;

  let sectionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === sectionPattern || lines[i].trim() === `### ${candidate.targetSection}`) {
      sectionIdx = i;
      break;
    }
  }

  if (sectionIdx === -1) {
    // Section not found — append at end of file
    const bullet = candidate.text.startsWith('- ') ? candidate.text : `- ${candidate.text}`;
    return content.trimEnd() + '\n\n' + bullet + '\n';
  }

  // Find the end of this section (next heading of same or higher level, or EOF)
  const headingMatch = lines[sectionIdx].match(/^(#{1,6})\s/);
  const headingLevel = headingMatch ? headingMatch[1].length : 2;

  let insertIdx = lines.length; // default: end of file
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    const lineHeadingMatch = lines[i].match(/^(#{1,6})\s/);
    if (lineHeadingMatch && lineHeadingMatch[1].length <= headingLevel) {
      insertIdx = i;
      break;
    }
  }

  // Walk backwards from insertIdx to skip trailing blank lines
  let lastContentIdx = insertIdx - 1;
  while (lastContentIdx > sectionIdx && lines[lastContentIdx].trim() === '') {
    lastContentIdx--;
  }

  // Insert the new bullet after the last content line
  const bullet = candidate.text.startsWith('- ') ? candidate.text : `- ${candidate.text}`;
  lines.splice(lastContentIdx + 1, 0, bullet);

  return lines.join('\n');
}

/**
 * POST /api/consolidate/promote-apply
 * Applies approved promotion candidates to global memory files and commits.
 */
export async function POST(req: NextRequest) {
  try {
    const { candidates, projectName } = await req.json() as {
      candidates: PromotionCandidate[];
      projectName: string;
    };

    if (!candidates || candidates.length === 0) {
      return NextResponse.json({ error: 'No candidates provided' }, { status: 400 });
    }

    const memoryRepoPath = getSetting('memory_repo_path');
    if (!memoryRepoPath) {
      return NextResponse.json({ error: 'Memory repo path not configured' }, { status: 400 });
    }

    // Group candidates by target file
    const byFile = new Map<string, PromotionCandidate[]>();
    for (const c of candidates) {
      const filePath = path.join(memoryRepoPath, c.targetFile);
      const existing = byFile.get(filePath) || [];
      existing.push(c);
      byFile.set(filePath, existing);
    }

    // Apply candidates to each target file
    const modifiedFiles: string[] = [];
    for (const [filePath, fileCandidates] of byFile) {
      if (!fs.existsSync(filePath)) {
        console.warn(`[promote-apply] Target file not found: ${filePath}`);
        continue;
      }

      let content = fs.readFileSync(filePath, 'utf-8');
      for (const candidate of fileCandidates) {
        content = applyCandidate(content, candidate);
      }

      fs.writeFileSync(filePath, content, 'utf-8');
      modifiedFiles.push(path.basename(filePath));
    }

    if (modifiedFiles.length === 0) {
      return NextResponse.json({ error: 'No files were modified' }, { status: 400 });
    }

    // Git commit and push
    const repoPath = memoryRepoPath.replace(/\\/g, '/');
    const commitMessage = `memory: promote ${candidates.length} pattern${candidates.length !== 1 ? 's' : ''} from ${projectName}`;

    try {
      execSync(`git -C "${repoPath}" add -A`, { timeout: 10_000 });
      execSync(`git -C "${repoPath}" commit -m "${commitMessage.replace(/"/g, '\\"')}"`, { timeout: 10_000 });
      execSync(`git -C "${repoPath}" push`, { timeout: 30_000 });
    } catch (gitError) {
      const gitMsg = gitError instanceof Error ? gitError.message : 'git operation failed';
      console.warn('[promote-apply] Git error:', gitMsg);
      return NextResponse.json({
        success: true,
        modifiedFiles,
        candidateCount: candidates.length,
        gitError: gitMsg,
      });
    }

    return NextResponse.json({
      success: true,
      modifiedFiles,
      candidateCount: candidates.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Promote-apply failed';
    console.error('[promote-apply] Error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
