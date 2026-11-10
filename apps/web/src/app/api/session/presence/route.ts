import { touchShopPresence } from '@tix/core';
import { NextResponse } from 'next/server';
import { getCore } from '@/server/core';
import { assertSameOrigin, enforceRateLimit, handle } from '@/server/http';
import { readSessionId } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * POST – heartbeat of a shop page without a realtime socket (cart, checkout …): counts the
 * session as "in the shop" for the events in its cart and shop-wide (dashboard figure only; the
 * waiting-room admission is not affected). Visitors without a session cookie are ignored.
 */
export async function POST(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const sid = await readSessionId();
    if (!sid) return new NextResponse(null, { status: 204 });
    await enforceRateLimit('presence', sid, 30, 60_000);
    await touchShopPresence(getCore(), sid);
    return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  });
}
