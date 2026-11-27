import {
  collectWebProcess,
  getSystemStats,
  renderPrometheus,
  renderProcessPrometheus,
  verifyMetricsToken,
} from '@tix/core';
import { DomainError } from '@tix/core';
import { logger } from '@/server/logger';
import { getCore } from '@/server/core';
import { clientIp, enforceRateLimit } from '@/server/http';
import { pageCacheStats, renderPageCachePrometheus } from '@/server/page-cache';

export const dynamic = 'force-dynamic';

const AUTH_FAIL_BUCKET = 'metrics-authfail';
const AUTH_FAIL_LIMIT = 20;
/** Beyond this the full collection is abandoned and only the process figures are answered. */
const FULL_COLLECTION_BUDGET_MS = 4_000;

const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });

/**
 * GET /api/metrics – Prometheus text exposition of the system status.
 *
 * Disabled (404) until a token is set in Settings → Security; then `Authorization: Bearer <token>`
 * is required. Wrong tokens are rate limited per client address. Not behind the maintenance gate,
 * but the token lookup needs the database: while a restore replaces it the endpoint answers 503
 * once the 10 s settings cache has expired (a failing scrape is the signal). When the database is
 * so busy that the full collection takes longer than 4 s, only the in-memory process figures
 * (pool occupancy, event loop lag, CPU) are returned with `tix_scrape_degraded 1`: they matter most
 * exactly then.
 */
export async function GET(request: Request) {
  try {
    const core = getCore();
    const ip = await clientIp();
    const key = core.keys.rateLimit(
      AUTH_FAIL_BUCKET,
      ip.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120),
    );
    const header = request.headers.get('authorization');
    const presented = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')?.[1] ?? null;
    const verdict = await verifyMetricsToken(core, presented);
    if (verdict === 'disabled') return text('Not found\n', 404);
    if (verdict === 'denied') {
      if (Number((await core.redis.get(key)) ?? 0) >= AUTH_FAIL_LIMIT) {
        return text('Too many failed attempts\n', 429, { 'retry-after': '60' });
      }
      await enforceRateLimit(AUTH_FAIL_BUCKET, ip, AUTH_FAIL_LIMIT, 60_000);
      return text('Unauthorized\n', 401, { 'www-authenticate': 'Bearer realm="metrics"' });
    }
    const headers = { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' };
    const full = getSystemStats(core);
    full.catch(() => undefined); // an abandoned collection must not become an unhandled rejection
    let timer: NodeJS.Timeout | undefined;
    const stats = await Promise.race([
      full,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), FULL_COLLECTION_BUDGET_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    // HTML page cache figures of this web process (in-memory, also in the degraded answer).
    const pageCache = renderPageCachePrometheus(pageCacheStats());
    if (!stats) {
      return text(renderProcessPrometheus(collectWebProcess(core.db)) + pageCache, 200, headers);
    }
    return text(renderPrometheus(stats) + pageCache, 200, headers);
  } catch (err) {
    if (err instanceof DomainError && err.status === 429) {
      return text('Too many failed attempts\n', 429, { 'retry-after': '60' });
    }
    logger.error({ err }, '[metrics] failed');
    return text('Metrics unavailable\n', 503);
  }
}
