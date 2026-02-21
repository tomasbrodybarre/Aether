import { NextResponse } from 'next/server';
import { isGeminiReady, getGeminiAuthInfo } from '@/lib/gemini-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ready = isGeminiReady();
    const auth = getGeminiAuthInfo();

    return NextResponse.json({
      connected: ready,
      auth: {
        method: auth.method,
        authenticated: auth.authenticated,
      },
    });
  } catch {
    return NextResponse.json({
      connected: false,
      auth: { method: 'none', authenticated: false },
    });
  }
}
