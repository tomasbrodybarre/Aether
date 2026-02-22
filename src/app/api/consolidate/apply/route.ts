import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getSetting } from '@/lib/db';

/**
 * POST /api/consolidate/apply
 * Writes the approved content to the file and commits + pushes to git.
 */
export async function POST(req: NextRequest) {
  try {
    const { filePath, content, commitMessage } = await req.json() as {
      filePath: string;
      content: string;
      commitMessage: string;
    };

    if (!filePath || content === undefined || !commitMessage) {
      return NextResponse.json({ error: 'filePath, content, and commitMessage are required' }, { status: 400 });
    }

    // Security: ensure file is within memory repo
    const memoryRepoPath = getSetting('memory_repo_path');
    if (!memoryRepoPath) {
      return NextResponse.json({ error: 'Memory repo path not configured' }, { status: 400 });
    }
    const normalizedFile = filePath.replace(/\\/g, '/');
    const normalizedRepo = memoryRepoPath.replace(/\\/g, '/');
    if (!normalizedFile.startsWith(normalizedRepo)) {
      return NextResponse.json({ error: 'File is outside memory repository' }, { status: 403 });
    }

    if (!fs.existsSync(path.dirname(filePath))) {
      return NextResponse.json({ error: 'Parent directory does not exist' }, { status: 404 });
    }

    // Write the file
    fs.writeFileSync(filePath, content, 'utf-8');

    // Git add, commit, push
    const repoPath = memoryRepoPath.replace(/\\/g, '/');
    try {
      execSync(`git -C "${repoPath}" add -A`, { timeout: 10_000 });
      execSync(`git -C "${repoPath}" commit -m "${commitMessage.replace(/"/g, '\\"')}"`, { timeout: 10_000 });
      execSync(`git -C "${repoPath}" push`, { timeout: 30_000 });
    } catch (gitError) {
      // File is already written — git failure is non-fatal but worth reporting
      const gitMsg = gitError instanceof Error ? gitError.message : 'git operation failed';
      console.warn('[consolidate/apply] Git error:', gitMsg);
      return NextResponse.json({ success: true, gitError: gitMsg });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Apply failed';
    console.error('[consolidate/apply] Error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
