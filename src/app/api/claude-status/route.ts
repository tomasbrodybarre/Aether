import { NextResponse } from 'next/server';
import { findClaudeBinary, getClaudeVersion, getClaudeAuthInfo } from '@/lib/platform';
import { getActiveProvider } from '@/lib/db';

export async function GET() {
  try {
    const claudePath = findClaudeBinary();
    if (!claudePath) {
      return NextResponse.json({ connected: false, version: null, auth: null });
    }
    const version = await getClaudeVersion(claudePath);

    // Determine auth method: CLI login (Max subscription) takes priority,
    // then check for configured API provider, then env vars.
    const cliAuth = getClaudeAuthInfo();
    let auth: {
      method: string;
      subscriptionType: string | null;
      expired: boolean;
      expiresAt: string | null;
      providerName?: string;
    };

    if (cliAuth.method === 'cli') {
      auth = {
        method: 'cli',
        subscriptionType: cliAuth.subscriptionType,
        expired: cliAuth.expired,
        expiresAt: cliAuth.expiresAt,
      };
    } else {
      // Check for configured API provider
      const activeProvider = getActiveProvider();
      if (activeProvider?.api_key) {
        auth = {
          method: 'api_key',
          subscriptionType: null,
          expired: false,
          expiresAt: null,
          providerName: activeProvider.name,
        };
      } else if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
        auth = {
          method: 'env',
          subscriptionType: null,
          expired: false,
          expiresAt: null,
        };
      } else {
        auth = {
          method: 'none',
          subscriptionType: null,
          expired: false,
          expiresAt: null,
        };
      }
    }

    return NextResponse.json({ connected: !!version, version, auth });
  } catch {
    return NextResponse.json({ connected: false, version: null, auth: null });
  }
}
