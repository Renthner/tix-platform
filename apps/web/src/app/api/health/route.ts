import { pingDb } from '@tix/db';
import { APP_VERSION } from '@tix/shared';
import { listLiveWorkers, pingRedis } from '@tix/redis';
import { NextResponse, type NextRequest } from 'next/server';
import { getDbHandle } from '@/server/db';
import { getRedis } from '@/server/redis';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type CheckResult =
  { status: 'ok'; latencyMs?: number; detail?: unknown } | { status: 'error'; error: string };

async function check(
  fn: () => Promise<{ latencyMs?: number; detail?: unknown }>,
): Promise<CheckResult> {
  try {
    return { status: 'ok', ...(await fn()) };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * GET /api/health?probe=live  → liveness (process is up, no dependency checks)
 * GET /api/health             → readiness (PostgreSQL + Redis must answer; worker presence
 *                               is reported but does not fail readiness)
 */
export async function GET(request: NextRequest) {
  const headers = { 'cache-control': 'no-store' };

  if (request.nextUrl.searchParams.get('probe') === 'live') {
    return NextResponse.json({ status: 'ok', version: APP_VERSION }, { headers });
  }

  const [database, redis, workers] = await Promise.all([
    check(async () => ({ latencyMs: await pingDb(getDbHandle().pool) })),
    check(async () => ({ latencyMs: await pingRedis(getRedis().connections.command) })),
    check(async () => {
      const { connections, keys } = getRedis();
      const live = await listLiveWorkers(connections.command, keys, 60);
      return { detail: { count: live.length, ids: live.map((w) => w.workerId) } };
    }),
  ]);

  const ready = database.status === 'ok' && redis.status === 'ok';
  const workerCount =
    workers.status === 'ok' ? ((workers.detail as { count: number }).count ?? 0) : 0;

  return NextResponse.json(
    {
      status: ready ? (workerCount > 0 ? 'ok' : 'degraded') : 'error',
      version: APP_VERSION,
      checks: { database, redis, workers },
      time: new Date().toISOString(),
    },
    { status: ready ? 200 : 503, headers },
  );
}
