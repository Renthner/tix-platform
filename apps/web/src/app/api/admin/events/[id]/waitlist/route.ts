import { buildWaitlistCsv, getEventById, listWaitlistEntries } from '@tix/core';
import { audit } from '@/server/admin/audit';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET – waiting list of an event as CSV (UTF-8 BOM, `;`). The export is audited. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(['EVENT_MANAGER']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const core = getCore();
    const event = await getEventById(core, uuidParam.parse((await params).id));
    const rows = await listWaitlistEntries(core, event.id);
    await audit(core.db, session, 'waitlist.export', 'event', event.id, { rows: rows.length });
    return new Response(buildWaitlistCsv(rows), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="waitlist-${event.slug}.csv"`,
        'cache-control': 'private, no-store',
      },
    });
  });
}
