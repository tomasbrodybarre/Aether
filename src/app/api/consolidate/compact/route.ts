import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import fs from 'fs';
import { createTwoFilesPatch } from 'diff';
import { getBaseLlmClient } from '@/lib/gemini-core';
import { getSetting } from '@/lib/db';

const SYSTEM_INSTRUCTION = `You are a memory file editor for a structured knowledge base. Your task is to consolidate staged observations into the appropriate existing sections of a project file.

Rules:
1. Read the ## Staging section — these are new observations that need to be folded into the file's structured sections.
2. For each observation, determine the best existing section to place it in (e.g., Status, Key Decisions, Session Log, TODO, etc.).
3. Merge duplicate or overlapping observations. Preserve important details but remove redundancy.
4. Remove noise — observations that are purely transient or no longer relevant.
5. After processing, the ## Staging section must be empty (just the heading with no bullets).
6. Do NOT add new top-level sections. Only add content to existing sections.
7. Do NOT remove or rewrite existing structured content — only add the new observations to it.
8. Return the COMPLETE updated file content. Do not omit any sections.
9. Do not wrap the output in markdown code fences. Return the raw file content.`;

/**
 * POST /api/consolidate/compact
 * Reads a project memory file, uses an LLM to compact staging observations
 * into structured sections, and returns the diff.
 */
export async function POST(req: NextRequest) {
  try {
    const { projectFile } = await req.json() as { projectFile: string };

    if (!projectFile) {
      return NextResponse.json({ error: 'projectFile is required' }, { status: 400 });
    }

    // Security: ensure file is within memory repo
    const memoryRepoPath = getSetting('memory_repo_path');
    if (!memoryRepoPath) {
      return NextResponse.json({ error: 'Memory repo path not configured' }, { status: 400 });
    }
    const normalizedFile = projectFile.replace(/\\/g, '/');
    const normalizedRepo = memoryRepoPath.replace(/\\/g, '/');
    if (!normalizedFile.startsWith(normalizedRepo)) {
      return NextResponse.json({ error: 'File is outside memory repository' }, { status: 403 });
    }

    if (!fs.existsSync(projectFile)) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const original = fs.readFileSync(projectFile, 'utf-8');

    // Count staging bullets
    const lines = original.split('\n');
    let inStaging = false;
    let stagingCount = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '## Staging') { inStaging = true; continue; }
      if (inStaging && /^##\s/.test(trimmed)) break;
      if (inStaging && /^- /.test(trimmed)) stagingCount++;
    }

    if (stagingCount === 0) {
      return NextResponse.json({ noChanges: true, stagingCount: 0 });
    }

    // Call LLM
    const baseLlm = getBaseLlmClient();
    const response = await baseLlm.generateContent({
      modelConfigKey: { model: 'gemini-2.5-flash' },
      contents: [{
        role: 'user',
        parts: [{ text: `Here is the project memory file to consolidate:\n\n${original}` }],
      }],
      systemInstruction: SYSTEM_INSTRUCTION,
      abortSignal: AbortSignal.timeout(60_000),
      promptId: `compact-${randomUUID()}`,
    });

    const proposed = response.text;
    if (!proposed) {
      return NextResponse.json({ error: 'LLM returned empty response' }, { status: 500 });
    }

    // Compute unified diff
    const fileName = projectFile.replace(/\\/g, '/').split('/').pop() || 'file.md';
    const diff = createTwoFilesPatch(fileName, fileName, original, proposed, 'original', 'compacted');

    return NextResponse.json({ original, proposed, diff, stagingCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Compaction failed';
    console.error('[consolidate/compact] Error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
