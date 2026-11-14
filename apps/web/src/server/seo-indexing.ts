import { createDb, systemSettings, type DbHandle } from '@tix/db';
import { createSwrCache, parseSetting } from '@tix/shared';
import { eq } from 'drizzle-orm';

/**
 * Whether search engines may index the shop (`seo.indexing`), read for the proxy that sets the
 * `X-Robots-Tag` header on every page. Same approach as the default-locale reader: standalone
 * (no `server-only`, no env module, own one-connection pool), stale-while-revalidate, never
 * throws, no database round trip per request. Cold-start timeouts fall back to "indexable".
 */

const TTL_MS = 5_000;
const COLD_TIMEOUT_MS = 1_000;
const LOAD_TIMEOUT_MS = 4_000;

interface Holder {
  handle?: DbHandle;
}
const g = globalThis as typeof globalThis & {
  __tixSeoIndexingReader?: ReturnType<typeof createSwrCache<boolean>>;
  __tixSeoIndexingHolder?: Holder;
};

function holder(): Holder {
  return (g.__tixSeoIndexingHolder ??= {});
}

async function query(h: Holder): Promise<boolean | undefined> {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  h.handle ??= createDb({
    connectionString: url,
    poolMax: 1,
    applicationName: 'web-seo',
    statementTimeoutMs: 3_000,
    connectionTimeoutMs: 3_000,
    onPoolError: () => undefined,
  });
  const [row] = await h.handle.db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, 'seo'));
  try {
    if (row?.value !== undefined && row.value !== null) {
      return parseSetting('seo', row.value).indexing;
    }
  } catch {
    // Invalid stored value: same fallback as the settings reader (schema default).
  }
  return true;
}

async function load(): Promise<boolean | undefined> {
  const h = holder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('seo indexing read timed out')), LOAD_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([query(h), timeout]);
  } catch (error) {
    const handle = h.handle;
    h.handle = undefined; // reconnect on the next attempt
    void handle?.close().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function cache() {
  return (g.__tixSeoIndexingReader ??= createSwrCache<boolean>({
    ttlMs: TTL_MS,
    coldTimeoutMs: COLD_TIMEOUT_MS,
    fallback: true,
    load,
  }));
}

export async function getSeoIndexing(): Promise<boolean> {
  return cache().get();
}

/** After the SEO settings were saved on this instance: effective immediately. */
export function applySeoIndexing(value: boolean): void {
  cache().apply(value);
}
