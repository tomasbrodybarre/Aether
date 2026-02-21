import { NextResponse } from 'next/server';
import { getAllProjectTagsUnified } from '@/lib/db';

export async function GET() {
  try {
    const tags = getAllProjectTagsUnified();
    return NextResponse.json({ tags });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch project tags' },
      { status: 500 }
    );
  }
}
