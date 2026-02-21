import { NextRequest, NextResponse } from 'next/server';
import { getRecentTurns, getTurnsByProject, createTurn } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const projectTag = request.nextUrl.searchParams.get('project_tag');
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '50', 10);

    let turns;
    if (projectTag !== null) {
      // Filter by specific project tag (pass null string as actual null for untagged)
      turns = getTurnsByProject(projectTag === '__untagged__' ? null : projectTag);
    } else {
      turns = getRecentTurns(limit);
    }

    return NextResponse.json({ turns });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch turns' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { prompt, project_tag, model } = body as {
      prompt: string;
      project_tag?: string;
      model?: string;
    };

    if (!prompt) {
      return NextResponse.json(
        { error: 'prompt is required' },
        { status: 400 }
      );
    }

    const turn = createTurn(prompt, project_tag, model);
    return NextResponse.json({ turn }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create turn' },
      { status: 500 }
    );
  }
}
