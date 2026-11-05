import { queueStatus } from '@tix/core';
import { NextResponse } from 'next/server';
import { handle } from '@/server/http';
import { ensureSessionId } from '@/server/session';
import { loadShopEvent, respondWithDecision } from '@/server/shop';

export const dynamic = 'force-dynamic';

/** Waiting-room status poll (fallback when the WebSocket connection is unavailable). */
export async function GET(_req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  return handle(async () => {
    const { core, event } = await loadShopEvent((await params).eventId);
    const decision = await queueStatus(core, event, await ensureSessionId());
    return NextResponse.json(await respondWithDecision(event.id, decision), {
      headers: { 'cache-control': 'no-store' },
    });
  });
}
