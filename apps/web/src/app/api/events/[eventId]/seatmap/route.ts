import { getLocalizedPublicSeatMap } from '@tix/core';
import { NextResponse } from 'next/server';
import { apiError, handle, localeParam } from '@/server/http';
import { loadShopEvent } from '@/server/shop';

export const dynamic = 'force-dynamic';

/** Public seating plan (static part, cached per seat map version). */
export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  return handle(async () => {
    const { core, event } = await loadShopEvent((await params).eventId);
    if (event.status !== 'PUBLISHED' && event.status !== 'POSTPONED') {
      return apiError('EVENT_NOT_FOUND', 'Event not found', 404);
    }
    const map = await getLocalizedPublicSeatMap(core, event, localeParam(req));
    return NextResponse.json(map, { headers: { 'cache-control': 'private, max-age=30' } });
  });
}
