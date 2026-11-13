import { getPublicSeatMapPayload } from '@tix/core';
import { apiError, handle, localeParam } from '@/server/http';
import { loadShopEvent } from '@/server/shop';

export const dynamic = 'force-dynamic';

/**
 * Public seating plan (static part). The same bytes for every visitor: built once per (event,
 * plan version, locale) in the shop data cache, which every price / tariff / plan change
 * invalidates. Browsers must revalidate on every load (`no-cache` + strong ETag → cheap 304), so
 * a price change is never hidden behind a browser cache.
 */
export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  return handle(async () => {
    const { core, event } = await loadShopEvent((await params).eventId);
    if (event.status !== 'PUBLISHED' && event.status !== 'POSTPONED') {
      return apiError('EVENT_NOT_FOUND', 'Event not found', 404);
    }
    const { json, etag } = await getPublicSeatMapPayload(core, event, localeParam(req));
    const headers = { 'cache-control': 'no-cache', etag };
    const ifNoneMatch = req.headers.get('if-none-match');
    if (ifNoneMatch && ifNoneMatch.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(json, {
      headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
    });
  });
}
