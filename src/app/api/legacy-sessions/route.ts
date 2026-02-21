import { listLegacySessions } from '@/lib/legacy-session-parser';

export async function GET() {
  try {
    const sessions = listLegacySessions();
    return Response.json({ sessions });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[GET /api/legacy-sessions] Error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
