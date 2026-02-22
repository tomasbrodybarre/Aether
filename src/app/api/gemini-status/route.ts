import { NextResponse } from 'next/server';
import { isGeminiReady, getGeminiAuthInfo, getModelHealth } from '@/lib/gemini-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ready = isGeminiReady();
    const auth = getGeminiAuthInfo();
    const health = getModelHealth();

    return NextResponse.json({
      connected: ready,
      auth: {
        method: auth.method,
        authenticated: auth.authenticated,
      },
      health: {
        status: health.status,
        error: health.error,
        timestamp: health.timestamp,
      },
    });
  } catch {
    return NextResponse.json({
      connected: false,
      auth: { method: 'none', authenticated: false },
      health: { status: 'idle', timestamp: Date.now() },
    });
  }
}
