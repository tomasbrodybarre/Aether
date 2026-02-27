/**
 * edit-memory.ts — Automatic memory analysis for cell edits.
 *
 * When a user saves a cell edit, this module analyzes the full edit chain
 * (all discuss + save diffs, plus linked discuss conversation turns) to
 * determine if the edit reveals a learnable pattern. If so, it writes a
 * concise observation to the project file's ## Staging section.
 */

import { randomUUID } from 'node:crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getCellEdits, getTurn, getSetting } from '@/lib/db';
import { getBaseLlmClient } from '@/lib/gemini-core';
import type { Turn } from '@/lib/db';
import type { CellEdit } from '@/types';
import {
  parseResponseSegments,
  extractDisplayText,
  type CodeSegment,
} from '@/lib/parse-segments';

// ---------------------------------------------------------------------------
// LLM prompt and schema
// ---------------------------------------------------------------------------

const SYSTEM_INSTRUCTION = `You are an edit pattern analyst for an AI notebook. The user has edited an AI-generated cell (code or prose) through one or more rounds, then finalized with Save. Your task is to determine whether this editing sequence reveals a learnable pattern about the user's preferences or style.

## What counts as learnable:
- Consistent style preferences (e.g., "prefers snake_case for Python variables")
- Structural patterns (e.g., "always adds type annotations to function signatures")
- Communication/writing preferences revealed through prose edits (e.g., "removes hedging language")
- Code patterns (e.g., "prefers explicit error handling over catch-all")
- Formatting preferences (e.g., "adds blank lines between logical sections")

## What is NOT learnable:
- One-time factual corrections (fixing a wrong number or name)
- Content-specific additions that don't generalize (adding a project-specific import)
- Trivial typo fixes
- Changes that are clearly project-specific context the AI couldn't have known

## Output:
- learnable: true/false
- observation: If learnable, a concise (1-2 sentence) observation phrased as a reusable instruction for the AI. E.g., "When writing Python functions, always include type hints for parameters and return values." If not learnable, omit or leave empty.

Be conservative. If uncertain, return learnable: false. False negatives are cheap; false positives clutter the memory.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    learnable: {
      type: 'boolean',
      description: 'Whether this edit chain reveals a generalizable pattern',
    },
    observation: {
      type: 'string',
      description: 'If learnable, a concise reusable instruction (1-2 sentences). Empty if not learnable.',
    },
  },
  required: ['learnable'],
};

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

function buildEditChainContext(
  turn: Turn,
  cellIndex: number,
  originalContent: string,
  edits: CellEdit[],
  discussTurns: { prompt: string; response: string }[],
): string {
  const parts: string[] = [];

  parts.push('## Original turn context');
  parts.push(`Turn prompt: ${turn.prompt.slice(0, 500)}${turn.prompt.length > 500 ? '...' : ''}`);
  parts.push('');

  parts.push(`## Original cell content (cell ${cellIndex})`);
  parts.push('```');
  parts.push(originalContent.slice(0, 2000) + (originalContent.length > 2000 ? '\n...[truncated]' : ''));
  parts.push('```');
  parts.push('');

  parts.push(`## Edit chain (${edits.length} version${edits.length > 1 ? 's' : ''}):`);
  for (const edit of edits) {
    parts.push(`### Version ${edit.version} (${edit.action})`);
    parts.push('```diff');
    parts.push(edit.delta.slice(0, 3000) + (edit.delta.length > 3000 ? '\n...[truncated]' : ''));
    parts.push('```');
    parts.push('');
  }

  if (discussTurns.length > 0) {
    parts.push('## Agent feedback during discuss phase:');
    for (let i = 0; i < discussTurns.length; i++) {
      parts.push(`### Discuss round ${i + 1}`);
      parts.push(`User: ${discussTurns[i].prompt.slice(0, 300)}${discussTurns[i].prompt.length > 300 ? '...' : ''}`);
      parts.push(`Agent: ${discussTurns[i].response.slice(0, 500)}${discussTurns[i].response.length > 500 ? '...' : ''}`);
      parts.push('');
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

export async function analyzeCellEditChain(
  turnId: string,
  cellIndex: number,
  turn: Turn,
): Promise<{ learned: boolean; observation?: string }> {
  // Check if memory analysis is enabled
  const memoryEnabled = getSetting('memory_enabled') !== 'false';
  const memoryRepoPath = getSetting('memory_repo_path') || '';
  const cellEditTrigger = getSetting('memory_trigger_cell_edits') !== 'false';
  if (!memoryEnabled || !memoryRepoPath || !cellEditTrigger) {
    return { learned: false };
  }

  // 1. Get full edit chain for this cell (discuss + save, version order)
  const allEdits = getCellEdits(turnId, cellIndex);
  if (allEdits.length === 0) return { learned: false };

  // 2. For discuss edits with linked turns, fetch the conversation
  const discussTurns: { prompt: string; response: string }[] = [];
  for (const edit of allEdits) {
    if (edit.action === 'discuss' && edit.discuss_turn_id) {
      const discussTurn = getTurn(edit.discuss_turn_id);
      if (discussTurn?.response) {
        discussTurns.push({
          prompt: discussTurn.prompt,
          response: discussTurn.response,
        });
      }
    }
  }

  // 3. Extract original cell content from the turn's response (pre-edit)
  //    The turn.response has already been updated with the latest edit,
  //    so we reconstruct the original from the first diff's context.
  //    However, the diffs are sufficient for the LLM to understand the changes.
  //    We'll use the current content and note the chain of diffs tells the story.
  let originalContent = '';
  if (turn.response) {
    try {
      const displayText = extractDisplayText(turn.response);
      const segments = parseResponseSegments(displayText);
      if (cellIndex < segments.length && segments[cellIndex].type === 'code') {
        // Current content (post-edit) — the diffs describe how we got here
        originalContent = (segments[cellIndex] as CodeSegment).content;
      }
    } catch {
      // Non-fatal — proceed with empty original
    }
  }

  // 4. Build context for LLM
  const context = buildEditChainContext(turn, cellIndex, originalContent, allEdits, discussTurns);

  // 5. Call LLM
  const baseLlm = await getBaseLlmClient();
  const result = await baseLlm.generateJson({
    modelConfigKey: { model: 'gemini-2.5-flash' },
    contents: [{
      role: 'user',
      parts: [{ text: context }],
    }],
    schema: RESPONSE_SCHEMA,
    systemInstruction: SYSTEM_INSTRUCTION,
    abortSignal: AbortSignal.timeout(15_000),
    promptId: `cell-edit-analysis-${randomUUID()}`,
  }) as { learnable: boolean; observation?: string };

  if (!result.learnable || !result.observation) {
    return { learned: false };
  }

  // 6. Append observation to project staging
  const projectTag = turn.project_tag || '_general';
  const projectFileName = projectTag === '_general'
    ? '_general.md'
    : `${projectTag.toLowerCase().replace(/\s+/g, '-')}.md`;
  const projectFilePath = path.join(memoryRepoPath, 'projects', projectFileName);

  if (!fs.existsSync(projectFilePath)) {
    console.warn(`[edit-memory] Project file not found: ${projectFilePath}`);
    return { learned: true, observation: result.observation };
  }

  let fileContent = fs.readFileSync(projectFilePath, 'utf-8');
  const stagingIdx = fileContent.indexOf('## Staging');
  if (stagingIdx === -1) {
    console.warn(`[edit-memory] No ## Staging section in ${projectFilePath}`);
    return { learned: true, observation: result.observation };
  }

  // Insert after "## Staging\n"
  const stagingLineEnd = fileContent.indexOf('\n', stagingIdx);
  if (stagingLineEnd === -1) {
    fileContent += `\n- [${new Date().toISOString().slice(0, 10)}] [cell-edit] ${result.observation}\n`;
  } else {
    const insertPos = stagingLineEnd + 1;
    const bullet = `- [${new Date().toISOString().slice(0, 10)}] [cell-edit] ${result.observation}\n`;
    fileContent = fileContent.slice(0, insertPos) + bullet + fileContent.slice(insertPos);
  }

  // Security check: file must be within memory repo
  const normalizedFile = projectFilePath.replace(/\\/g, '/');
  const normalizedRepo = memoryRepoPath.replace(/\\/g, '/');
  if (!normalizedFile.startsWith(normalizedRepo)) {
    console.warn('[edit-memory] Path traversal rejected');
    return { learned: true, observation: result.observation };
  }

  fs.writeFileSync(projectFilePath, fileContent, 'utf-8');

  // 7. Git commit + push (non-fatal on failure)
  const repoPath = memoryRepoPath.replace(/\\/g, '/');
  try {
    execSync(`git -C "${repoPath}" add -A`, { timeout: 10_000 });
    execSync(`git -C "${repoPath}" commit -m "memory: cell-edit observation for ${projectTag}"`, { timeout: 10_000 });
    execSync(`git -C "${repoPath}" push`, { timeout: 30_000 });
  } catch (gitErr) {
    console.warn('[edit-memory] Git error (non-fatal):', gitErr instanceof Error ? gitErr.message : gitErr);
  }

  return { learned: true, observation: result.observation };
}
