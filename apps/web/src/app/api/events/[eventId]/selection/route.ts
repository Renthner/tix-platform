import { validateSelection } from '@tix/core';
import { NextResponse } from 'next/server';
import { handle } from '@/server/http';
import { ensureSessionId } from '@/server/session';
import { loadShopEvent } from '@/server/shop';

export const dynamic = 'force-dynamic';

/** POST – "continue to cart": applies the orphan seat rule if enabled for the event. */
export async function POST(_req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  return handle(async () => {
    const { core, event } = await loadShopEvent((await params).eventId);
    return NextResponse.json(await validateSelection(core, await ensureSessionId(), event));
  });
}
