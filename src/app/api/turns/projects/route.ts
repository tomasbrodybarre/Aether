import { NextResponse } from 'next/server';
import { getAllProjectTagsUnified } from '@/lib/db';
import { getKnownProjectNames } from '@/lib/gemini-core';

export async function GET() {
  try {
    const dbTags = getAllProjectTagsUnified();
    const knownNames = getKnownProjectNames();
    // Merge: known project names first, then any DB-only tags
    const merged = [...knownNames];
    for (const tag of dbTags) {
      if (!merged.includes(tag)) {
        merged.push(tag);
      }
    }
    return NextResponse.json({ tags: merged });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch project tags' },
      { status: 500 }
    );
  }
}
