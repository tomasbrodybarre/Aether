import { NextRequest, NextResponse } from 'next/server';
import { getTurn, insertCellEdit, getLatestCellVersion, getDb, getProjectDocMapping, getSetting } from '@/lib/db';
import {
  parseResponseSegments,
  replaceSegmentContent,
  extractDisplayText,
  updateResponseContent,
} from '@/lib/parse-segments';
import { appendToDocument, isGoogleDocsConfigured } from '@/lib/google-docs';

/**
 * POST /api/turns/[id]/cell-edit
 *
 * Saves a cell edit (discuss or save action).
 * - Inserts a version record into cell_edits
 * - Updates turns.response with the new content
 *
 * Body: { cellIndex: number, newContent: string, delta: string, action: 'discuss' | 'save' }
 * Returns: { version: number, cellEditId: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: turnId } = await params;
    const turn = getTurn(turnId);
    if (!turn) {
      return NextResponse.json({ error: 'Turn not found' }, { status: 404 });
    }
    if (!turn.response) {
      return NextResponse.json({ error: 'Turn has no response' }, { status: 400 });
    }

    const body = await request.json();
    const { cellIndex, newContent, delta, action } = body as {
      cellIndex: number;
      newContent: string;
      delta: string;
      action: 'discuss' | 'save';
    };

    if (typeof cellIndex !== 'number' || typeof newContent !== 'string' || typeof delta !== 'string') {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    if (action !== 'discuss' && action !== 'save') {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    // Compute next version
    const currentVersion = getLatestCellVersion(turnId, cellIndex);
    const nextVersion = currentVersion + 1;

    // Insert the cell edit record
    const cellEdit = insertCellEdit(turnId, cellIndex, nextVersion, delta, action);

    // Update the turn's response with the new content
    const displayText = extractDisplayText(turn.response);
    const segments = parseResponseSegments(displayText);

    if (cellIndex < 0 || cellIndex >= segments.length || segments[cellIndex].type !== 'code') {
      return NextResponse.json({ error: 'Invalid cell index' }, { status: 400 });
    }

    const updatedDisplayText = replaceSegmentContent(segments, cellIndex, newContent);
    const updatedResponse = updateResponseContent(turn.response, updatedDisplayText);

    // Write back to DB
    const db = getDb();
    db.prepare('UPDATE turns SET response = ? WHERE id = ?').run(updatedResponse, turnId);

    // Non-blocking Google Docs push on save
    let gdocsPush = false;
    if (action === 'save' && isGoogleDocsConfigured()) {
      const mapping = turn.project_tag ? getProjectDocMapping(turn.project_tag) : null;
      if (mapping && getSetting('gdocs_enabled') !== 'false') {
        gdocsPush = true;
        appendToDocument(mapping.doc_id, newContent).catch(err => {
          console.warn('[cell-edit] Google Docs push failed:', err);
        });
      }
    }

    return NextResponse.json({
      version: nextVersion,
      cellEditId: cellEdit.id,
      gdocsPush,
    });
  } catch (error) {
    console.error('[cell-edit] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save cell edit' },
      { status: 500 }
    );
  }
}
