import { assertSellable, getAvailability, getEventCached, getSeatMapForChannel } from '@tix/core';
import { NextResponse } from 'next/server';
import { BOX_OFFICE_ROLES } from '@/server/admin/box-office';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET – seating plan with the box-office tariffs plus the live availability snapshot. */
export async function GET(_req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  return handle(async () => {
    const session = await adminForApi(BOX_OFFICE_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const core = getCore();
    const event = await getEventCached(core, uuidParam.parse((await params).eventId));
    assertSellable(event);
    const [map, availability] = await Promise.all([
      getSeatMapForChannel(core, event, 'BOX_OFFICE'),
      getAvailability(core, null, event),
    ]);
    return NextResponse.json({ map, availability }, { headers: { 'cache-control': 'no-store' } });
  });
}
