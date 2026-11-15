import { buildOccupancyPdf, loadOccupancy } from '@tix/core';
import { z } from 'zod';
import { audit } from '@/server/admin/audit';
import { adminForApi } from '@/server/auth';
import { apiError, handle, uuidParam } from '@/server/http';
import { occupancyLabels, reportContext } from '../_labels';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  holders: z.enum(['0', '1']).optional(),
  locale: z.string().max(10).optional(),
});

/**
 * GET – seating occupancy of an event as A4 PDF for the door staff (sold / reserved / blocked /
 * free per seat, optionally with the holder names). Test and cancelled orders are excluded.
 * Every export is audited.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(['EVENT_MANAGER', 'DOOR_STAFF']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const eventId = uuidParam.parse((await params).id);
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const includeHolders = query.holders === '1';
    const { core, event, t, info } = await reportContext(eventId, query.locale);
    const occupancy = await loadOccupancy(core.db, event.seatMapId);
    const pdf = await buildOccupancyPdf(occupancy, info, occupancyLabels(t), { includeHolders });
    await audit(core.db, session, 'report.occupancy.export', 'event', event.id, {
      includeHolders,
      ...occupancy.totals,
    });
    return new Response(new Uint8Array(pdf), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="occupancy-${event.slug}.pdf"`,
        'cache-control': 'private, no-store',
      },
    });
  });
}
