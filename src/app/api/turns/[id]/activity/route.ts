import { NextRequest, NextResponse } from 'next/server';
import { getToolCallsByTurn, getThoughtsByTurn } from '@/lib/db';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: turnId } = await params;

    const toolCalls = getToolCallsByTurn(turnId);
    const thoughts = getThoughtsByTurn(turnId);

    return NextResponse.json({ toolCalls, thoughts });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch activity' },
      { status: 500 },
    );
  }
}
