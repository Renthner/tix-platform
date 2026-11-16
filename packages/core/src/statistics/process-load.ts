import { monitorEventLoopDelay } from 'node:perf_hooks';

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

/**
 * Load figures of THIS web process: database pool occupancy, event loop lag and CPU time. They
 * answer "is this process the bottleneck" during a load test: pool waiting > 0 means requests queue
 * for a database connection, a high event loop lag means the (single-threaded) process is CPU bound.
 * Everything is in-memory and cheap; nothing here queries a database.
 */

export interface WebProcessLoad {
  pid: number;
  /** User + system CPU time of the process since start (seconds). */
  cpuSecondsTotal: number;
  /** Event loop delay above the sampling resolution, seconds (window of the last ~10-20 s). */
  eventLoop: { p50: number; p99: number; max: number };
  /** Pool of the web database handle; null when no pool could be found. */
  dbPool: { total: number; idle: number; waiting: number; max: number } | null;
}

const RESOLUTION_MS = 10;
const WINDOW_MS = 10_000;

interface PoolLike {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  options?: { max?: number };
}

const isPool = (v: unknown): v is PoolLike =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as PoolLike).totalCount === 'number' &&
  typeof (v as PoolLike).idleCount === 'number' &&
  typeof (v as PoolLike).waitingCount === 'number';

/** Occupancy of the node-postgres pool behind a drizzle database (`$client`), null if unknown. */
export function readDbPool(db: unknown): WebProcessLoad['dbPool'] {
  const client = (db as { $client?: unknown } | null)?.$client;
  if (!isPool(client)) return null;
  return {
    total: client.totalCount,
    idle: client.idleCount,
    waiting: client.waitingCount,
    max: Number(client.options?.max ?? 0) || 0,
  };
}

interface Monitor {
  histogram: IntervalHistogram;
  last: { p50: number; p99: number; max: number } | null;
}

const globalMonitor = globalThis as typeof globalThis & { __tixLoopMonitor?: Monitor };

const toSeconds = (ns: number) => Math.max(0, ns / 1e6 - RESOLUTION_MS) / 1000;
const readHistogram = (h: IntervalHistogram) =>
  h.count === 0
    ? null
    : {
        p50: toSeconds(h.percentile(50)),
        p99: toSeconds(h.percentile(99)),
        max: toSeconds(h.max),
      };

/** Starts the event loop monitor once per process (unref'd, rotates its window every 10 s). */
function loopMonitor(): Monitor {
  if (!globalMonitor.__tixLoopMonitor) {
    const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    histogram.enable();
    const monitor: Monitor = { histogram, last: null };
    setInterval(() => {
      monitor.last = readHistogram(histogram);
      histogram.reset();
    }, WINDOW_MS).unref();
    globalMonitor.__tixLoopMonitor = monitor;
  }
  return globalMonitor.__tixLoopMonitor;
}

/** Starts the monitor early (so the first scrape already has a window). Safe to call repeatedly. */
export function startWebProcessMonitor(): void {
  loopMonitor();
}

export function collectWebProcess(db: unknown): WebProcessLoad {
  const monitor = loopMonitor();
  const now = readHistogram(monitor.histogram);
  const last = monitor.last;
  const eventLoop = {
    p50: (now ?? last)?.p50 ?? 0,
    p99: Math.max(now?.p99 ?? 0, last?.p99 ?? 0),
    max: Math.max(now?.max ?? 0, last?.max ?? 0),
  };
  const cpu = process.cpuUsage();
  return {
    pid: process.pid,
    cpuSecondsTotal: (cpu.user + cpu.system) / 1e6,
    eventLoop,
    dbPool: readDbPool(db),
  };
}
