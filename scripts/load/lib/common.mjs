// Shared helpers of the load generator: HTTP "virtual user" with cookie jar, latency metrics,
// bounded concurrency, and lazy access to the pg / ioredis / socket.io-client packages of the
// monorepo (no extra dependencies, no docker image for the generator).
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const root = new URL('../../../', import.meta.url);
const requireFrom = (pkg) => createRequire(new URL(`${pkg}/package.json`, root));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.now();

/** Deterministic PRNG (mulberry32) so runs are repeatable with --seed. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = (rand, list) => list[Math.floor(rand() * list.length)];
export function shuffle(rand, list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

// ── metrics ───────────────────────────────────────────────────────────────────────
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
const round = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

export class Metrics {
  constructor() {
    this.labels = new Map();
    this.counters = new Map();
  }
  record(label, status, code, ms) {
    let m = this.labels.get(label);
    if (!m) {
      m = { n: 0, statuses: {}, codes: {}, lat: [], fiveXX: 0 };
      this.labels.set(label, m);
    }
    m.n++;
    m.statuses[status] = (m.statuses[status] ?? 0) + 1;
    if (code) m.codes[`${status}:${code}`] = (m.codes[`${status}:${code}`] ?? 0) + 1;
    if (status === 0 || status >= 500) m.fiveXX++;
    m.lat.push(ms);
  }
  count(name, by = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }
  summary(durationMs) {
    const endpoints = {};
    let total = 0;
    let bad = 0;
    for (const [label, m] of [...this.labels].sort()) {
      const s = [...m.lat].sort((a, b) => a - b);
      total += m.n;
      bad += m.fiveXX;
      endpoints[label] = {
        requests: m.n,
        p50: round(percentile(s, 50)),
        p95: round(percentile(s, 95)),
        p99: round(percentile(s, 99)),
        max: round(s.at(-1)),
        statuses: m.statuses,
        codes: m.codes,
        failures5xxOrNetwork: m.fiveXX,
      };
    }
    return {
      durationMs: round(durationMs),
      requests: total,
      requestsPerSecond: round(total / (durationMs / 1000)),
      failures5xxOrNetwork: bad,
      failureRate: total ? bad / total : 0,
      endpoints,
      counters: Object.fromEntries(this.counters),
    };
  }
}

// ── virtual user ──────────────────────────────────────────────────────────────────
/** Distinct, public-looking client address per virtual user (see Caddyfile.load). */
export function fakeIp(index) {
  const i = index + 1;
  return `100.${64 + ((i >> 16) & 0x3f)}.${(i >> 8) & 255}.${i & 255}`;
}

export class Vu {
  constructor(cfg, id, metrics) {
    this.cfg = cfg;
    this.id = id;
    this.metrics = metrics;
    this.jar = new Map();
    this.ip = fakeIp(id);
  }
  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get sid() {
    // Signed cookie "<base64url(json {sid,...})>.<signature>" (apps/web/src/server/session-token.ts).
    const token = this.jar.get('tix_sid');
    if (!token) return null;
    try {
      return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).sid;
    } catch {
      return null;
    }
  }
  /** One HTTP call; never throws. Returns {status, body, code, ms}. */
  async call(label, method, path, json) {
    const headers = { cookie: this.cookieHeader(), origin: this.cfg.origin };
    if (this.cfg.fakeIp) headers['x-forwarded-for'] = this.ip;
    if (json !== undefined) headers['content-type'] = 'application/json';
    const t0 = now();
    let status = 0;
    let body = null;
    let code = '';
    try {
      const res = await fetch(this.cfg.base + path, {
        method,
        headers,
        body: json !== undefined ? JSON.stringify(json) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      status = res.status;
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        if (/max-age=0/i.test(c) || /expires=thu, 01 jan 1970/i.test(c))
          this.jar.delete(pair.slice(0, eq));
        else this.jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      code = body?.error?.code ?? '';
    } catch (err) {
      code =
        err?.name === 'TimeoutError' ? 'TIMEOUT' : `NETWORK:${err?.cause?.code ?? err?.message}`;
    }
    const ms = now() - t0;
    this.metrics.record(label, status, code, ms);
    return { status, body, code, ms };
  }
}

/** Runs fn(item, index) for all items with at most `limit` in flight. */
export async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

// ── infrastructure access ─────────────────────────────────────────────────────────
export async function openDb(url) {
  const { Client } = requireFrom('packages/db')('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}
export function openRedis(url) {
  const Redis = requireFrom('packages/redis')('ioredis');
  return new Redis(url, { maxRetriesPerRequest: 3 });
}
export function socketIo() {
  return requireFrom('apps/web')('socket.io-client').io;
}

/** Redis key helpers mirroring packages/redis/src/keys.ts (kept tiny on purpose). */
export function keyspace(prefix, eventId) {
  const ev = `${prefix}:{ev:${eventId}}`;
  return {
    ev,
    seatLockPattern: `${ev}:seat:*`,
    taken: `${ev}:seat:taken`,
    cartSeatsPattern: `${ev}:cart:*:seats`,
    gaHeld: `${ev}:ga:held`,
    gaAvailable: `${ev}:ga:available`,
    queueState: `${ev}:queue:state`,
    queuePattern: `${ev}:queue:*`,
  };
}
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function scanKeys(redis, pattern) {
  const out = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    cursor = next;
    out.push(...keys);
  } while (cursor !== '0');
  return out;
}

/** Common run configuration derived from CLI args / environment. */
export function buildConfig(args) {
  const base = String(args.target ?? process.env.LOAD_TARGET ?? 'http://localhost:18080').replace(
    /\/$/,
    '',
  );
  return {
    base,
    origin: String(args.origin ?? process.env.LOAD_ORIGIN ?? base),
    fakeIp: args['fake-ip'] === true || process.env.LOAD_FAKE_IP === '1',
    timeoutMs: Number(args.timeout ?? 30_000),
    vus: Number(args.vus ?? process.env.LOAD_VUS ?? 1200),
    seed: Number(args.seed ?? 42),
    warmupConcurrency: Number(args['warmup-concurrency'] ?? 150),
    observers: Number(args.observers ?? 200),
    hot: Number(args.hot ?? 20),
    prefix: String(args['redis-prefix'] ?? process.env.REDIS_KEY_PREFIX ?? 'tix'),
    databaseUrl: args['database-url'] ?? process.env.LOAD_DATABASE_URL ?? null,
    redisUrl: args['redis-url'] ?? process.env.LOAD_REDIS_URL ?? null,
  };
}
