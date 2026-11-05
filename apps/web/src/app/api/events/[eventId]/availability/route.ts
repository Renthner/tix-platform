import { getAvailability } from '@tix/core';
import { NextResponse } from 'next/server';
import { handle } from '@/server/http';
import { readSessionId } from '@/server/session';
import { loadShopEvent } from '@/server/shop';

export const dynamic = 'force-dynamic';

/** Snapshot of sold / locked / own seats and remaining standing capacity. */
export async function GET(_req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  return handle(async () => {
    const { core, event } = await loadShopEvent((await params).eventId);
    const availability = await getAvailability(core, await readSessionId(), event);
    return NextResponse.json(availability, { headers: { 'cache-control': 'no-store' } });
  });
}
