import { verifyMetricsToken } from '@tix/core';
import { pingDb } from '@tix/db';
import { APP_VERSION } from '@tix/shared';
import { listLiveWorkers, pingRedis } from '@tix/redis';
import { NextResponse, type NextRequest } from 'next/server';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { getDbHandle } from '@/server/db';
import { logger } from '@/server/logger';
import { getRedis } from '@/server/redis';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type CheckResult =
  { status: 'ok'; latencyMs?: number; detail?: unknown } | { status: 'error'; error: string };

async function check(
  name: string,
  fn: () => Promise<{ latencyMs?: number; detail?: unknown }>,
): Promise<CheckResult> {
  try {
    return { status: 'ok', ...(await fn()) };
  } catch (err) {
    logger.error({ err, check: name }, '[health] check failed');
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Details (worker ids, latencies, error messages) only for the metrics token or an admin session. */
async function maySeeDetails(request: NextRequest): Promise<boolean> {
  try {
    const presented = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (presented && (await verifyMetricsToken(getCore(), presented)) === 'ok') return true;
    return (await adminForApi()) !== null;
  } catch {
    return false;
  }
}

/**
 * GET /api/health?probe=live  → liveness (process is up, no dependency checks)
 * GET /api/health             → readiness (PostgreSQL + Redis must answer; worker presence
 *                               is reported but does not fail readiness). The public answer
 *                               is only `status` + HTTP code; the per-check details need
 *                               `Authorization: Bearer <metrics token>` or an admin session.
 */
export async function GET(request: NextRequest) {
  const headers = { 'cache-control': 'no-store' };

  if (request.nextUrl.searchParams.get('probe') === 'live') {
    return NextResponse.json({ status: 'ok', version: APP_VERSION }, { headers });
  }

  const [database, redis, workers] = await Promise.all([
    check('database', async () => ({ latencyMs: await pingDb(getDbHandle().pool) })),
    check('redis', async () => ({ latencyMs: await pingRedis(getRedis().connections.command) })),
    check('workers', async () => {
      const { connections, keys } = getRedis();
      const live = await listLiveWorkers(connections.command, keys, 60);
      return { detail: { count: live.length, ids: live.map((w) => w.workerId) } };
    }),
  ]);

  const ready = database.status === 'ok' && redis.status === 'ok';
  const workerCount =
    workers.status === 'ok' ? ((workers.detail as { count: number }).count ?? 0) : 0;
  const status = ready ? (workerCount > 0 ? 'ok' : 'degraded') : 'error';
  const code = ready ? 200 : 503;

  if (!(await maySeeDetails(request))) {
    return NextResponse.json({ status }, { status: code, headers });
  }
  return NextResponse.json(
    {
      status,
      version: APP_VERSION,
      checks: { database, redis, workers },
      time: new Date().toISOString(),
    },
    { status: code, headers },
  );
}
