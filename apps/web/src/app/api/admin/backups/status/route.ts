import { getBackupFailure, getMaintenance, isStatusStale, readStatus } from '@tix/core';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET – progress of the running / last backup operation (polled by the backups page). */
export async function GET() {
  return handle(
    async () => {
      const session = await adminForApi(['SUPER_ADMIN']);
      if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
      const core = getCore();
      const [status, maintenance, failure] = await Promise.all([
        readStatus(core),
        getMaintenance(core),
        getBackupFailure(core),
      ]);
      return Response.json(
        {
          status: status ? { ...status, stale: isStatusStale(status) } : null,
          maintenance: Boolean(maintenance),
          failure,
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    },
    { allowIncompleteRestore: true },
  );
}
