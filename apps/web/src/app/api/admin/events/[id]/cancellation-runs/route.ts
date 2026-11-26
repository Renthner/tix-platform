import { listEventCancellationRuns } from '@tix/core';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * GET – the event's recent cancellation runs (newest first). Polled by the status page while a
 * run is RUNNING to show its progress and switch to the final state without a reload.
 */
export async function GET(_req: Request, { params }: Params) {
  return handle(async () => {
    const session = await adminForApi(['EVENT_MANAGER']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const id = uuidParam.parse((await params).id);
    const runs = await listEventCancellationRuns(getCore().db, id);
    return Response.json(
      {
        runs: runs.map((r) => ({
          id: r.id,
          status: r.status,
          refundFees: r.refundFees,
          totalOrders: r.totalOrders,
          cancelledOrders: r.cancelledOrders,
          manualOrders: r.manualOrders,
          failedOrders: r.failedOrders,
          lastError: r.lastError,
          createdAt: r.createdAt.toISOString(),
          finishedAt: r.finishedAt?.toISOString() ?? null,
        })),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  });
}
