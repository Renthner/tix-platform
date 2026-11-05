import { enterShop, redeemAccessCode } from '@tix/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { clientIp, enforceRateLimit, handle, parseBody } from '@/server/http';
import { ensureSessionId } from '@/server/session';
import { loadShopEvent, respondWithDecision } from '@/server/shop';

export const dynamic = 'force-dynamic';

const body = z.object({ code: z.string().min(1).max(80) });

/** Redeems a VIP / presale code and re-evaluates shop access. */
export async function POST(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  return handle(async () => {
    const { core, event } = await loadShopEvent((await params).eventId);
    const sid = await ensureSessionId();
    // Brute-force protection against code guessing.
    await enforceRateLimit('code-ip', await clientIp(), 20, 10 * 60_000);
    await enforceRateLimit('code-session', sid, 10, 10 * 60_000);
    const { code } = await parseBody(request, body);
    await redeemAccessCode(core, event, sid, code);
    const decision = await enterShop(core, event, sid);
    return NextResponse.json(await respondWithDecision(event.id, decision));
  });
}
