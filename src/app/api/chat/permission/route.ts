import { NextRequest } from 'next/server';
import { resolveConfirmation } from '@/lib/gemini-core';
import type { PermissionResponseRequest } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body: PermissionResponseRequest = await request.json();
    const { permissionRequestId, decision } = body;

    if (!permissionRequestId || !decision) {
      return new Response(
        JSON.stringify({ error: 'permissionRequestId and decision are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const approved = decision.behavior === 'allow';
    const found = resolveConfirmation(permissionRequestId, approved);

    if (!found) {
      return new Response(
        JSON.stringify({ error: 'Permission request not found or already resolved' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
