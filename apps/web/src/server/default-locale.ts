import { createDb, systemSettings, type DbHandle } from '@tix/db';
import { createSwrCache, isAppLocale, parseSetting, type AppLocale } from '@tix/shared';
import { eq } from 'drizzle-orm';
import { rememberDefaultLocale } from '@/i18n/default-locale-state';

/**
 * Effective shop default language (`general.defaultLocale`), read for the proxy (URL prefix
 * rules) and the layout. Deliberately standalone – no `server-only`, no env module, a tiny own
 * pool created on first use – so `proxy.ts` can import it. Never throws. Stale-while-revalidate:
 * a known value is returned at once (refreshed in the background); only the very first read waits
 * (bounded), falling back to "en".
 */

const TTL_MS = 5_000;
const COLD_TIMEOUT_MS = 1_000;
/** Hard bound for one load, so a half-open connection can never hang the in-flight promise. */
const LOAD_TIMEOUT_MS = 4_000;

interface Holder {
  handle?: DbHandle;
}
const g = globalThis as typeof globalThis & {
  __tixDefaultLocaleReader?: ReturnType<typeof createSwrCache<AppLocale>>;
  __tixDefaultLocaleHolder?: Holder;
};

function holder(): Holder {
  return (g.__tixDefaultLocaleHolder ??= {});
}

function discardHandle(h: Holder): void {
  const handle = h.handle;
  h.handle = undefined;
  // pool.end() waits for checked-out clients: never await it, never let it throw.
  void handle?.close().catch(() => undefined);
}

async function query(h: Holder): Promise<AppLocale | undefined> {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  h.handle ??= createDb({
    connectionString: url,
    poolMax: 1,
    applicationName: 'web-locale',
    statementTimeoutMs: 3_000,
    connectionTimeoutMs: 3_000,
    onPoolError: () => undefined,
  });
  const [row] = await h.handle.db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, 'general'));
  try {
    if (row?.value !== undefined && row.value !== null) {
      return parseSetting('general', row.value).defaultLocale as AppLocale;
    }
  } catch {
    // Invalid stored value: same fallback as the settings reader (schema default).
  }
  return 'en';
}

async function load(): Promise<AppLocale | undefined> {
  const h = holder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('default locale read timed out')), LOAD_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([query(h), timeout]);
  } catch (error) {
    discardHandle(h); // reconnect on the next attempt
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** One log line per state change; no connection details (only the error message/code). */
function logHealth(ok: boolean, error?: unknown): void {
  const detail = error instanceof Error ? error.message.slice(0, 200) : undefined;
  void import('@tix/core')
    .then(({ coreLog }) => {
      if (ok) coreLog.info({}, 'default locale: settings database reachable again');
      else
        coreLog.warn(
          { err: detail },
          'default locale: cannot read settings, serving last known value',
        );
    })
    .catch(() => undefined);
}

function cache() {
  return (g.__tixDefaultLocaleReader ??= createSwrCache<AppLocale>({
    ttlMs: TTL_MS,
    coldTimeoutMs: COLD_TIMEOUT_MS,
    fallback: 'en',
    load,
    onValue: rememberDefaultLocale,
    onHealth: logHealth,
  }));
}

export async function getDefaultLocale(): Promise<AppLocale> {
  return cache().get();
}

/** After the General settings were saved on this instance: effective immediately. */
export function applyDefaultLocale(value: string): void {
  if (isAppLocale(value)) cache().apply(value);
}
