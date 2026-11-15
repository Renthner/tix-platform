import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createKeyspace } from '@tix/redis';
import {
  LOAD_TEST_BYPASS_BUCKETS,
  LOAD_TEST_MAX_MINUTES,
  LOAD_TEST_MIN_MINUTES,
  clampLoadTestMinutes,
  disableLoadTest,
  enableLoadTest,
  getLoadTestStatus,
  noteLoadTestBypass,
  reapExpiredLoadTest,
  resetLoadTestCache,
  verifyLoadTestToken,
} from '../src/loadtest';

/** Minimal in-memory stand-in for the Redis commands the module uses (SET NX/EX, GET, DEL, INCR). */
function fakeCtx() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const audits: Array<Record<string, unknown>> = [];
  const failure = { audit: false };
  const redis = {
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async set(k: string, v: string | number, ...opts: Array<string | number>) {
      if (opts.includes('NX') && store.has(k)) return null;
      store.set(k, String(v));
      return 'OK';
    },
    async del(...ks: string[]) {
      for (const k of ks) store.delete(k);
      return ks.length;
    },
    async incr(k: string) {
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, String(n));
      return n;
    },
    async expire(k: string, seconds: number) {
      ttls.set(k, seconds);
      return 1;
    },
  };
  const db = {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        if (failure.audit) throw new Error('database is down');
        audits.push(row);
      },
    }),
  };
  return {
    ctx: { redis, db, keys: createKeyspace('t') } as never,
    store,
    audits,
    ttls,
    failure,
  };
}

describe('load test mode', () => {
  beforeEach(() => resetLoadTestCache());

  it('clamps the duration to 5 minutes .. 4 hours', () => {
    expect(clampLoadTestMinutes(1)).toBe(LOAD_TEST_MIN_MINUTES);
    expect(clampLoadTestMinutes(100000)).toBe(LOAD_TEST_MAX_MINUTES);
    expect(clampLoadTestMinutes(60)).toBe(60);
    expect(clampLoadTestMinutes(Number.NaN)).toBe(60);
  });

  it('ignores any header while the mode is off', async () => {
    const { ctx } = fakeCtx();
    expect(await verifyLoadTestToken(ctx, 'anything')).toBe(false);
    expect(await verifyLoadTestToken(ctx, '')).toBe(false);
    expect(await verifyLoadTestToken(ctx, null)).toBe(false);
  });

  it('accepts only the issued token, stores only its hash and audits without it', async () => {
    const { ctx, store, audits } = fakeCtx();
    const run = await enableLoadTest(ctx, { userId: 'u1', durationMinutes: 30 });
    expect(run.token.length).toBeGreaterThanOrEqual(40);
    expect(await verifyLoadTestToken(ctx, run.token)).toBe(true);
    expect(await verifyLoadTestToken(ctx, `${run.token}x`)).toBe(false);
    expect(await verifyLoadTestToken(ctx, 'a'.repeat(300))).toBe(false);
    const stored = [...store.values()].join('\n');
    expect(stored).not.toContain(run.token);
    expect(JSON.stringify(audits)).not.toContain(run.token);
    expect(audits.map((a) => a.action)).toEqual(['loadtest.enable']);
    const status = await getLoadTestStatus(ctx);
    expect(status.active).toBe(true);
    expect(status.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
  });

  it('refuses a second run while one is active', async () => {
    const { ctx } = fakeCtx();
    await enableLoadTest(ctx, { userId: 'u1', durationMinutes: 10 });
    await expect(enableLoadTest(ctx, { userId: 'u1', durationMinutes: 10 })).rejects.toMatchObject({
      code: 'LOADTEST_ACTIVE',
    });
  });

  it('stops accepting the token after the time is up and audits the expiry exactly once', async () => {
    const { ctx, audits } = fakeCtx();
    const run = await enableLoadTest(ctx, { userId: 'u1', durationMinutes: 5 });
    const later = Date.now() + 6 * 60_000;
    expect(await verifyLoadTestToken(ctx, run.token, later)).toBe(false);
    expect(await reapExpiredLoadTest(ctx, later)).toBe(true);
    expect(await reapExpiredLoadTest(ctx, later)).toBe(false);
    expect(audits.map((a) => a.action)).toEqual(['loadtest.enable', 'loadtest.expire']);
    expect(audits[1]!.actorType).toBe('SYSTEM');
  });

  it('disable ends the run at once, audits once and later reaping adds nothing', async () => {
    const { ctx, audits } = fakeCtx();
    const run = await enableLoadTest(ctx, { userId: 'u1', durationMinutes: 60 });
    expect(await disableLoadTest(ctx, { userId: 'u2' })).toBe(true);
    expect(await disableLoadTest(ctx, { userId: 'u2' })).toBe(false);
    resetLoadTestCache();
    expect(await verifyLoadTestToken(ctx, run.token)).toBe(false);
    expect(await reapExpiredLoadTest(ctx, Date.now() + 10 * 3600_000)).toBe(false);
    expect(audits.map((a) => a.action)).toEqual(['loadtest.enable', 'loadtest.disable']);
    expect(audits[1]!.actorUserId).toBe('u2');
  });

  it('rolls the activation back when the audit entry cannot be written', async () => {
    const { ctx, store, failure } = fakeCtx();
    failure.audit = true;
    await expect(enableLoadTest(ctx, { userId: 'u1', durationMinutes: 30 })).rejects.toThrow(
      'database is down',
    );
    expect(store.size).toBe(0); // no state, no counter: the mode is not active
    expect((await getLoadTestStatus(ctx)).active).toBe(false);
    failure.audit = false;
    expect((await enableLoadTest(ctx, { userId: 'u1', durationMinutes: 30 })).token).toBeTruthy();
  });

  it('keeps the run (and retries the audit entry) when ending it fails to audit', async () => {
    const { ctx, audits, failure } = fakeCtx();
    const run = await enableLoadTest(ctx, { userId: 'u1', durationMinutes: 30 });
    failure.audit = true;
    await expect(disableLoadTest(ctx, { userId: 'u1' })).rejects.toThrow('database is down');
    expect(await verifyLoadTestToken(ctx, run.token)).toBe(true); // still active, entry not lost
    failure.audit = false;
    expect(await disableLoadTest(ctx, { userId: 'u1' })).toBe(true);
    expect(audits.map((a) => a.action)).toEqual(['loadtest.enable', 'loadtest.disable']);
    resetLoadTestCache();
    expect(await verifyLoadTestToken(ctx, run.token)).toBe(false);
  });

  it('gives a counter that INCR had to re-create a TTL', async () => {
    const { ctx, ttls } = fakeCtx();
    noteLoadTestBypass(ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect([...ttls.values()]).toEqual([3600]);
    noteLoadTestBypass(ctx); // existing counter: no new TTL call
    await new Promise((r) => setTimeout(r, 0));
    expect(ttls.size).toBe(1);
  });

  it('fails closed when Redis errors', async () => {
    const { ctx } = fakeCtx();
    (ctx as { redis: { get: () => Promise<never> } }).redis.get = async () => {
      throw new Error('down');
    };
    expect(await verifyLoadTestToken(ctx, 'x')).toBe(false);
  });
});

describe('per-IP bypass call sites', () => {
  const webSrc = join(__dirname, '../../../apps/web/src');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  walk(webSrc);

  it('only the sanctioned per-IP throughput buckets use enforceIpThroughputLimit', () => {
    const used = new Set<string>();
    for (const file of files) {
      if (file.endsWith(join('server', 'http.ts'))) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/enforceIpThroughputLimit\(\s*'([^']+)'/g)) used.add(m[1]!);
    }
    expect([...used].sort()).toEqual([...LOAD_TEST_BYPASS_BUCKETS].sort());
  });

  it('nothing else reads the load test header', () => {
    const offenders = files.filter(
      (f) =>
        !f.endsWith(join('server', 'http.ts')) &&
        !f.endsWith(join('server', 'logger.ts')) && // redaction path only
        /x-tix-loadtest|LOAD_TEST_HEADER/i.test(readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => f.replace(webSrc, ''))).toEqual([]);
  });
});
