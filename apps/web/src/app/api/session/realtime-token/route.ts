import { signToken } from '@tix/shared/server';
import { NextResponse } from 'next/server';
import { getEnv } from '@/server/env';
import { clientIp, enforceRateLimit, handle } from '@/server/http';
import { ensureSessionId } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Short-lived token authenticating the browser at the realtime gateway. `url` is null when
 * the gateway is served on the same origin (behind the reverse proxy at /socket.io).
 */
export async function GET() {
  return handle(async () => {
    // Shop pages mint one token per page load / reconnect; this only stops scripted floods.
    await enforceRateLimit('realtime-token-ip', await clientIp(), 120, 60_000);
    const env = getEnv();
    const sid = await ensureSessionId();
    return NextResponse.json(
      {
        token: signToken('rt', { sid }, 3600, env.SESSION_SECRET),
        url: env.REALTIME_PUBLIC_URL ?? null,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  });
}
