import { exportSeatMap, getSeatMapMeta } from '@tix/core';
import { SEAT_MAP_FILE_EXTENSION } from '@tix/shared';
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
    if (!(await getSeatMapMeta(core.db, id)))
      return apiError('NOT_FOUND', 'Seat map not found', 404);
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
