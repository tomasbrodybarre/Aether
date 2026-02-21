import { NextRequest, NextResponse } from 'next/server';
import { getTurn, updateTurnProjectTag, deleteTurn } from '@/lib/db';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const turn = getTurn(id);
    if (!turn) {
      return NextResponse.json({ error: 'Turn not found' }, { status: 404 });
    }
    return NextResponse.json({ turn });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get turn' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const turn = getTurn(id);
    if (!turn) {
      return NextResponse.json({ error: 'Turn not found' }, { status: 404 });
    }

    const body = await request.json();

    if ('project_tag' in body) {
      // Explicit null or empty string clears the tag
      const source = body.project_tag_source ?? (body.project_tag ? 'manual' : null);
      updateTurnProjectTag(id, body.project_tag || null, source);
    }

    const updated = getTurn(id);
    return NextResponse.json({ turn: updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update turn' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const turn = getTurn(id);
    if (!turn) {
      return NextResponse.json({ error: 'Turn not found' }, { status: 404 });
    }

    deleteTurn(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete turn' },
      { status: 500 }
    );
  }
}
