import { NextRequest, NextResponse } from 'next/server';
import {
  getAllProjectDocMappings,
  setProjectDocMapping,
  deleteProjectDocMapping,
} from '@/lib/db';
import {
  isGoogleDocsConfigured,
  verifyDocument,
  createDocument,
  getAccessToken,
} from '@/lib/google-docs';

/**
 * GET /api/gdocs
 * Returns all project-doc mappings and connection status.
 */
export async function GET() {
  try {
    const configured = isGoogleDocsConfigured();
    let connected = false;

    if (configured) {
      try {
        const token = await getAccessToken();
        connected = !!token;
      } catch {
        connected = false;
      }
    }

    const mappings = getAllProjectDocMappings();

    return NextResponse.json({ configured, connected, mappings });
  } catch (error) {
    console.error('[gdocs] GET error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get mappings' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/gdocs
 * Upsert a project-doc mapping.
 * Body: { project_tag: string, doc_id: string, doc_title?: string }
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { project_tag, doc_id, doc_title } = body as {
      project_tag: string;
      doc_id: string;
      doc_title?: string;
    };

    if (!project_tag || !doc_id) {
      return NextResponse.json({ error: 'project_tag and doc_id required' }, { status: 400 });
    }

    setProjectDocMapping(project_tag, doc_id, doc_title);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[gdocs] PUT error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save mapping' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/gdocs?project_tag=X
 * Remove a project-doc mapping.
 */
export async function DELETE(request: NextRequest) {
  try {
    const projectTag = request.nextUrl.searchParams.get('project_tag');
    if (!projectTag) {
      return NextResponse.json({ error: 'project_tag required' }, { status: 400 });
    }

    deleteProjectDocMapping(projectTag);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[gdocs] DELETE error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete mapping' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/gdocs
 * Actions: verify a doc or create a new one.
 * Body: { action: 'verify', doc_id: string } | { action: 'create', title: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body as { action: string };

    if (action === 'verify') {
      const { doc_id } = body as { doc_id: string };
      if (!doc_id) {
        return NextResponse.json({ error: 'doc_id required' }, { status: 400 });
      }
      const result = await verifyDocument(doc_id);
      return NextResponse.json(result);
    }

    if (action === 'create') {
      const { title } = body as { title: string };
      if (!title) {
        return NextResponse.json({ error: 'title required' }, { status: 400 });
      }
      const result = await createDocument(title);
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('[gdocs] POST error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Operation failed' },
      { status: 500 }
    );
  }
}
