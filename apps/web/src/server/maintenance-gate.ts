import { createKeyspace, createRedis, type Keyspace, type Redis } from '@tix/redis';
import de from '../../messages/de/backups.json';
import en from '../../messages/en/backups.json';

/**
 * Maintenance gate: while a restore replaces the database the shop answers 503 with a
 * maintenance page. Deliberately standalone (own tiny Redis connection, no `server-only`
 * imports, no database access) so it can run in `proxy.ts` and in route handlers.
 *
 * Wiring (see the backup report): `proxy.ts` calls `maintenanceGate(request)` first, and
 * `handle()` in `server/http.ts` calls `assertNotInMaintenance()` (maintenance-assert.ts) first.
 */

const PROBE_TTL_MS = 1_500;
const MESSAGES = { en: en.maintenance, de: de.maintenance } as const;
type MaintenanceLocale = keyof typeof MESSAGES;

/** Reachable while only the RESTORE_INCOMPLETE marker is set (to finish or undo the restore). */
const ADMIN_RECOVERY = /^\/(?:(?:de|en)\/)?admin\/(?:login|backups)(?:\/|$)/;
/** After sign-in the admin lands on /admin: with an unfinished restore that is the backups page. */
const ADMIN_HOME = /^\/((?:de|en)\/)?admin\/?$/;

/** Reachable during maintenance: container health check and the maintenance status poll. */
const EXEMPT = /^\/(?:api\/(?:health|maintenance)(?:\/|$)|_next\/|socket\.io)/;

interface Probe {
  redis: Redis;
  keys: Keyspace;
  cached: { at: number; value: ProbeResult } | null;
}
interface ProbeResult {
  active: boolean;
  /** Only the durable RESTORE_INCOMPLETE marker is set (no restore is running right now). */
  incompleteOnly?: boolean;
  since?: string;
  step?: string;
}

const globalForGate = globalThis as typeof globalThis & { __tixMaintenanceProbe?: Probe };

function probeState(): Probe | null {
  if (globalForGate.__tixMaintenanceProbe) return globalForGate.__tixMaintenanceProbe;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const redis = createRedis(url, 'command', { serviceName: 'web-gate', logger: silent });
  globalForGate.__tixMaintenanceProbe = {
    redis,
    keys: createKeyspace(process.env.REDIS_KEY_PREFIX ?? 'tix'),
    cached: null,
  };
  return globalForGate.__tixMaintenanceProbe;
}

/** Maintenance flag + current restore step (Redis only; cached for a moment). */
export async function readMaintenance(): Promise<ProbeResult> {
  const probe = probeState();
  if (!probe) return { active: false };
  const now = Date.now();
  if (probe.cached && now - probe.cached.at < PROBE_TTL_MS) return probe.cached.value;
  let value: ProbeResult = { active: false };
  try {
    // Never hold up page loads for long when Redis is slow or unreachable.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('probe timeout')), 1_000).unref?.(),
    );
    const [flag, status, marker] = await Promise.race([
      Promise.all([
        probe.redis.get(probe.keys.maintenance()),
        probe.redis.get(probe.keys.backupStatus()),
        probe.redis.exists(probe.keys.restoreIncomplete()),
      ]),
      timeout,
    ]);
    if (!flag && marker) value = { active: true, incompleteOnly: true, step: 'RESTORE_INCOMPLETE' };
    if (flag) {
      const parsed = JSON.parse(flag) as { since?: string };
      const progress = status
        ? (JSON.parse(status) as { step?: string; operation?: string })
        : null;
      value = {
        active: true,
        since: parsed.since,
        step: progress?.operation === 'RESTORE' ? progress.step : undefined,
      };
    }
  } catch {
    // Redis unreachable: never block the app on the probe itself.
  }
  probe.cached = { at: now, value };
  return value;
}

function localeOf(request: Request, pathname: string): MaintenanceLocale {
  const prefix = pathname.split('/')[1];
  if (prefix === 'de' || prefix === 'en') return prefix;
  return request.headers.get('accept-language')?.toLowerCase().startsWith('de') ? 'de' : 'en';
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(locale: MaintenanceLocale, step: string | undefined): string {
  const m = MESSAGES[locale];
  const steps = m.steps as Record<string, string>;
  const label = step ? (steps[step] ?? '') : '';
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(m.title)}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#18181b}
main{max-width:30rem;padding:2rem;text-align:center}h1{font-size:1.4rem}p{color:#52525b;line-height:1.5}#s{font-size:.85rem;color:#71717a}
@media (prefers-color-scheme:dark){body{background:#18181b;color:#fafafa}p,#s{color:#a1a1aa}}</style></head>
<body><main><h1>${escapeHtml(m.title)}</h1><p>${escapeHtml(m.text)}</p><p id="s">${escapeHtml(label)}</p></main>
<script>const L=${JSON.stringify(steps).replaceAll('<', '\u003c')};
setInterval(async()=>{try{const r=await fetch('/api/maintenance',{cache:'no-store'});const j=await r.json();
if(!j.active){location.reload();return}document.getElementById('s').textContent=L[j.step]||''}catch(e){}},3000);</script></body></html>`;
}

/** Response for requests that arrive during maintenance, or null when the shop is up. */
export async function maintenanceGate(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (EXEMPT.test(pathname)) return null;
  const state = await readMaintenance();
  if (!state.active) return null;
  // An unfinished restore must stay resolvable: sign-in and the backups page remain reachable.
  if (state.incompleteOnly && ADMIN_HOME.test(pathname)) {
    const locale = ADMIN_HOME.exec(pathname)?.[1] ?? '';
    return Response.redirect(new URL(`/${locale}admin/backups`, request.url), 307);
  }
  if (state.incompleteOnly && ADMIN_RECOVERY.test(pathname)) return null;
  const headers = { 'retry-after': '30', 'cache-control': 'no-store' };
  if (pathname.startsWith('/api/')) {
    return Response.json(
      {
        error: {
          code: 'MAINTENANCE',
          message: 'The system is being restored. Please try again shortly.',
        },
      },
      { status: 503, headers },
    );
  }
  return new Response(page(localeOf(request, pathname), state.step), {
    status: 503,
    headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
  });
}
