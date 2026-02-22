import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { getBaseLlmClient } from '@/lib/gemini-core';
import { getSetting } from '@/lib/db';

const SYSTEM_INSTRUCTION = `You are a memory system analyst. Your task is to review a project-specific knowledge file and identify observations or patterns that should be promoted to global memory files (me.md or workflows.md).

## Global file purposes
- **me.md**: Personal profile, communication preferences, working style, cognitive patterns, recurring preferences. Things that are true about the user regardless of project.
- **workflows.md**: Process patterns, tool preferences, environment-specific workarounds, development practices, research methods. Things about HOW to work regardless of what project.

## Promotion criteria
Only promote patterns that are **project-independent** — they would be useful in a project you haven't started yet.

### PROMOTE examples:
- "User prefers non-parametric tests over parametric ones" → me.md (Data Analysis Style)
- "Always run tsc --noEmit before committing TypeScript changes" → workflows.md (Software Development)
- "User wants errors acknowledged immediately, not minimized" → me.md (Communication Preferences)
- "On Windows, npm packages are .cmd wrappers that need special handling" → workflows.md (Shell & Environment)

### DO NOT PROMOTE examples:
- "Aether uses Streamdown for rendering" → project-specific implementation detail
- "The gambling dataset has 47,000 rows" → project-specific fact
- "Session 25 fixed the queue/interrupt bug" → project-specific history
- "The sidebar was rewritten to use flat navigation" → project-specific architecture

### When the global file already captures the principle:
- If me.md already says "Values first-principles thinking" and the project file says "Used first-principles analysis for the auth decision" → DO NOT promote (the global already has it)
- If workflows.md says "Use RAF throttle for streaming" and the project has "Applied RAF throttle to tool output streaming with 16ms debounce" → only promote if the specific detail (16ms) is genuinely useful across projects

## Conservative default
When uncertain whether something should be promoted, DO NOT promote it. False negatives (missing a promotion) are much cheaper than false positives (cluttering global files with project-specific noise).

## Output format
Return a JSON object with a "candidates" array. Each candidate has:
- text: the content to add or replace (one bullet point or short paragraph)
- targetFile: "me.md" or "workflows.md"
- targetSection: the heading where this belongs (must be an existing section in the target file)
- action: "add" (append new bullet) or "replace" (update existing entry)
- replaceTarget: (only for "replace") the existing text to find and replace
- rationale: one sentence explaining why this is project-independent

Return an empty candidates array if nothing qualifies for promotion.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The content to add or the replacement text' },
          targetFile: { type: 'string', enum: ['me.md', 'workflows.md'], description: 'Which global file to modify' },
          targetSection: { type: 'string', description: 'The section heading where this content belongs' },
          action: { type: 'string', enum: ['add', 'replace'], description: 'Whether to add new content or replace existing' },
          replaceTarget: { type: 'string', description: 'For replace action: the existing text to find and replace' },
          rationale: { type: 'string', description: 'One sentence explaining why this is project-independent' },
        },
        required: ['text', 'targetFile', 'targetSection', 'action', 'rationale'],
      },
    },
  },
  required: ['candidates'],
};

/**
 * POST /api/consolidate/promote
 * Reads a project file + global files, uses an LLM to identify promotion candidates.
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
      return NextResponse.json({ error: 'Project file not found' }, { status: 404 });
    }

    const projectContent = fs.readFileSync(projectFile, 'utf-8');

    // Read global files
    const mePath = path.join(memoryRepoPath, 'me.md');
    const workflowsPath = path.join(memoryRepoPath, 'workflows.md');
    const meContent = fs.existsSync(mePath) ? fs.readFileSync(mePath, 'utf-8') : '';
    const workflowsContent = fs.existsSync(workflowsPath) ? fs.readFileSync(workflowsPath, 'utf-8') : '';

    const projectName = path.basename(projectFile, '.md');

    // Call LLM with structured JSON output
    const baseLlm = await getBaseLlmClient();
    const result = await baseLlm.generateJson({
      modelConfigKey: { model: 'gemini-2.5-flash' },
      contents: [{
        role: 'user',
        parts: [{ text: `## Project file: ${projectName}\n\n${projectContent}\n\n---\n\n## Global file: me.md\n\n${meContent}\n\n---\n\n## Global file: workflows.md\n\n${workflowsContent}` }],
      }],
      schema: RESPONSE_SCHEMA,
      systemInstruction: SYSTEM_INSTRUCTION,
      abortSignal: AbortSignal.timeout(60_000),
      promptId: `promote-${randomUUID()}`,
    });

    const candidates = (result as { candidates: unknown[] }).candidates || [];

    return NextResponse.json({ candidates, projectName });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Promotion analysis failed';
    console.error('[consolidate/promote] Error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
