import { getSystemStats, renderPrometheus, verifyMetricsToken } from '@tix/core';
import { DomainError } from '@tix/core';
import { logger } from '@/server/logger';
import { getCore } from '@/server/core';
import { clientIp, enforceRateLimit } from '@/server/http';

export const dynamic = 'force-dynamic';

const AUTH_FAIL_BUCKET = 'metrics-authfail';
const AUTH_FAIL_LIMIT = 20;

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
 * once the 10 s settings cache has expired (a failing scrape is the signal).
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
    return text(renderPrometheus(await getSystemStats(core)), 200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  } catch (err) {
    if (err instanceof DomainError && err.status === 429) {
      return text('Too many failed attempts\n', 429, { 'retry-after': '60' });
    }
    logger.error({ err }, '[metrics] failed');
    return text('Metrics unavailable\n', 503);
  }
}
