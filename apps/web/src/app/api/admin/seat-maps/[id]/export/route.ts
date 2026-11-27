import { exportSeatMap, getSeatMapMeta } from '@tix/core';
import { events } from '@tix/db';
import { SEAT_MAP_FILE_EXTENSION } from '@tix/shared';
import { eq } from 'drizzle-orm';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** GET – downloads the plan as a portable `.tixplan.json` file (no orders, no customer data). */
export async function GET(_req: Request, { params }: Params) {
  return handle(async () => {
    if (!(await adminForApi(['EVENT_MANAGER']))) return apiError('FORBIDDEN', 'Not allowed', 403);
    const id = uuidParam.parse((await params).id);
    const core = getCore();
    const meta = await getSeatMapMeta(core.db, id);
    if (!meta) return apiError('NOT_FOUND', 'Seat map not found', 404);
    // The hidden plan of an admission-only event holds its contingents, not a seating plan: it is
    // exported with the event (event export), never as a plan file.
    if (meta.eventId) {
      const [owner] = await core.db
        .select({ seatingMode: events.seatingMode })
        .from(events)
        .where(eq(events.id, meta.eventId));
      if (owner?.seatingMode === 'ADMISSION') {
        return apiError(
          'EVENT_ADMISSION_ONLY',
          'Admission-only events have no seating plan to export',
          409,
        );
      }
    }
    const file = await exportSeatMap(core, id, {
      appVersion: process.env.npm_package_version ?? 'unknown',
    });
    const base =
      file.plan.name
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
        .slice(0, 60) || 'seat-plan';
    return new Response(JSON.stringify(file), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${base}${SEAT_MAP_FILE_EXTENSION}"`,
        'cache-control': 'no-store',
      },
    });
  });
}
