import { enterShop, verifyPass } from '@tix/core';
import { NextResponse } from 'next/server';
import { clientIp, enforceRateLimit, handle } from '@/server/http';
import { ensureSessionId, readPassToken } from '@/server/session';
import { loadShopEvent, respondWithDecision } from '@/server/shop';

export const dynamic = 'force-dynamic';

/** Enters the shop of an event: grants a pass, queues the visitor, or explains why not. */
export async function POST(_req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  return handle(async () => {
    const { core, event, actor } = await loadShopEvent((await params).eventId);
    const sid = await ensureSessionId();
    await enforceRateLimit('enter-ip', await clientIp(), 120, 60_000);
    if (await verifyPass(core, event.id, sid, await readPassToken(event.id))) {
      const ttl = await core.redis.pttl(core.keys.queuePass(event.id, sid));
      return NextResponse.json({ status: 'GRANTED', passExpiresAt: Date.now() + Math.max(0, ttl) });
    }
    const decision = await enterShop(core, event, sid, actor);
    return NextResponse.json(await respondWithDecision(event.id, decision), {
      headers: { 'cache-control': 'no-store' },
    });
  });
}
