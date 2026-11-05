import { claimPass } from '@tix/core';
import { NextResponse } from 'next/server';
import { handle } from '@/server/http';
import { ensureSessionId } from '@/server/session';
import { loadShopEvent, respondWithDecision } from '@/server/shop';

export const dynamic = 'force-dynamic';

/** Turns an admission from the waiting room into a QueuePassToken cookie. */
export async function POST(_req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  return handle(async () => {
    const { core, event } = await loadShopEvent((await params).eventId);
    const decision = await claimPass(core, event, await ensureSessionId());
    return NextResponse.json(await respondWithDecision(event.id, decision));
  });
}
