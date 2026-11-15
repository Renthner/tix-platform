import { buildGuestListCsv, buildGuestListPdf, loadGuestList } from '@tix/core';
import { z } from 'zod';
import { audit } from '@/server/admin/audit';
import { adminForApi } from '@/server/auth';
import { apiError, handle, uuidParam } from '@/server/http';
import { guestListLabels, reportContext } from '../_labels';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  format: z.enum(['csv', 'pdf']),
  sort: z.enum(['name', 'seat']).default('name'),
  locale: z.string().max(10).optional(),
});

/**
 * GET – guest list of an event as CSV (UTF-8 BOM, `;`, formula-injection safe) or A4 PDF.
 * Contains buyer/holder names, so every export is audited (format, sort, row count only).
 * Test orders are excluded.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(['EVENT_MANAGER', 'DOOR_STAFF']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const eventId = uuidParam.parse((await params).id);
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const { core, event, t, info, locale } = await reportContext(eventId, query.locale);
    const rows = await loadGuestList(core.db, event.id, query.sort, locale);
    const labels = guestListLabels(t);
    await audit(core.db, session, 'report.guestList.export', 'event', event.id, {
      format: query.format,
      sort: query.sort,
      rows: rows.length,
    });
    const headers = { 'cache-control': 'private, no-store' };
    if (query.format === 'csv') {
      return new Response(buildGuestListCsv(rows, labels, event.timeZone), {
        headers: {
          ...headers,
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="guests-${event.slug}.csv"`,
        },
      });
    }
    const pdf = await buildGuestListPdf(rows, info, labels);
    return new Response(new Uint8Array(pdf), {
      headers: {
        ...headers,
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="guests-${event.slug}.pdf"`,
      },
    });
  });
}
