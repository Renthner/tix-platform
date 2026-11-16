// Sizing of the web tier: how many Next.js processes, on which loopback ports, with which database
// pool each, and the startup warnings about the resulting connection / memory budget.
// Everything here is pure (inputs are injected) so that it can be tested without a container.
import { readFileSync } from 'node:fs';
import os from 'node:os';

/** Upper bound of `auto` (more processes rarely help: the database and Redis become the limit). */
export const AUTO_WEB_PROCESSES_CAP = 8;
export const MAX_WEB_PROCESSES = 16;
/** Pool size of the single-process default (unchanged behaviour) = the budget that is divided. */
export const WEB_POOL_BUDGET = 20;
export const MIN_WEB_POOL = 4;
/**
 * Default TIX_DB_CONNECTION_BUDGET: Postgres ships with max_connections=100; staying at or below 90
 * leaves a few connections for admin tools (psql, a restore) next to the application.
 */
export const DB_CONNECTION_BUDGET = 90;
/** Smallest pool of one web process the budget may clamp down to. */
export const MIN_CLAMPED_WEB_POOL = 2;
/** Side pools every web process opens next to its main pool (default-locale + seo-indexing readers). */
export const WEB_SIDE_POOLS = 2;

const tryRead = (read, file) => {
  try {
    return String(read(file)).trim();
  } catch {
    return null;
  }
};

/**
 * CPU limit of the container from the cgroup quota (v2 `cpu.max`, v1 `cpu.cfs_*`), rounded UP like
 * libuv does (1.5 CPUs -> 2). Returns null when unlimited or unreadable.
 */
export function readCgroupCpuLimit(read = (p) => readFileSync(p, 'utf8')) {
  const v2 = tryRead(read, '/sys/fs/cgroup/cpu.max');
  if (v2 !== null) {
    const [quota, period] = v2.split(/\s+/);
    if (quota && quota !== 'max' && Number(quota) > 0 && Number(period) > 0) {
      return Math.max(1, Math.ceil(Number(quota) / Number(period)));
    }
    return null;
  }
  const quota = Number(tryRead(read, '/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
  const period = Number(tryRead(read, '/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
  if (quota > 0 && period > 0) return Math.max(1, Math.ceil(quota / period));
  return null;
}

/** Memory limit of the container in bytes (cgroup v2 `memory.max`, v1 limit), null when unlimited. */
export function readCgroupMemoryLimit(read = (p) => readFileSync(p, 'utf8')) {
  const candidates = ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'];
  for (const file of candidates) {
    const raw = tryRead(read, file);
    if (raw === null) continue;
    if (raw === 'max') return null;
    const n = Number(raw);
    // cgroup v1 reports "no limit" as a huge page-aligned number
    if (!Number.isFinite(n) || n <= 0 || n >= 2 ** 60) return null;
    return n;
  }
  return null;
}

/**
 * Parses TIX_WEB_PROCESSES. Empty/unset = 1. Returns { value: number | 'auto', error?: string }.
 */
export function parseWebProcesses(raw) {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (text === '') return { value: 1 };
  if (text === 'auto') return { value: 'auto' };
  const n = Number(text);
  if (!/^[0-9]+$/.test(text) || n < 1 || n > MAX_WEB_PROCESSES) {
    return {
      value: 1,
      error: `TIX_WEB_PROCESSES must be an integer between 1 and ${MAX_WEB_PROCESSES} or "auto" (got "${raw}")`,
    };
  }
  return { value: n };
}

/**
 * The number of web processes. `auto` = min(CPU parallelism, container CPU quota, cap), at least 1.
 * @param {number|'auto'} spec
 * @param {{ cpus?: number, cgroupCpus?: number|null }} [hw]
 * @returns {{ n: number, reason: string }}
 */
export function resolveWebProcessCount(spec, hw = {}) {
  if (spec !== 'auto') {
    return { n: spec, reason: spec === 1 ? 'default (one process)' : 'TIX_WEB_PROCESSES' };
  }
  const cpus = Math.max(1, hw.cpus ?? 1);
  const quota = hw.cgroupCpus ?? null;
  const available = quota !== null ? Math.min(cpus, quota) : cpus;
  const n = Math.max(1, Math.min(available, AUTO_WEB_PROCESSES_CAP));
  const parts = [`${cpus} CPU(s) visible`];
  if (quota !== null) parts.push(`container CPU limit ${quota}`);
  parts.push(`cap ${AUTO_WEB_PROCESSES_CAP}`);
  return { n, reason: `auto: ${parts.join(', ')}` };
}

/** Defaults for the hardware inputs of resolveWebProcessCount, read from this machine. */
export function detectHardware(read) {
  let cpus = 1;
  try {
    cpus =
      typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  } catch {
    cpus = 1;
  }
  return { cpus, cgroupCpus: readCgroupCpuLimit(read) };
}

/**
 * Loopback ports of the web processes: the first is `base` (TIX_WEB_PORT, so one process behaves
 * exactly as before), the next ones count upwards and skip every port another component uses.
 * @returns {{ ports: number[], error?: string }}
 */
export function allocateWebPorts(n, base, reserved = []) {
  const taken = new Set(reserved);
  const ports = [base];
  taken.add(base);
  let candidate = base;
  while (ports.length < n) {
    candidate += 1;
    if (candidate > 65535) {
      return {
        ports,
        error: `TIX_WEB_PORT ${base} leaves no room for ${n} web processes below 65535; use a lower TIX_WEB_PORT`,
      };
    }
    if (taken.has(candidate)) continue;
    taken.add(candidate);
    ports.push(candidate);
  }
  return { ports };
}

/**
 * Database pool of ONE web process. Not set explicitly: the single-process budget (20) is divided
 * by the number of processes (at least 4 each). Set explicitly: used as given, per process.
 */
export function webPoolPerProcess(n, explicit) {
  if (explicit !== undefined) return explicit;
  return Math.max(MIN_WEB_POOL, Math.floor(WEB_POOL_BUDGET / n));
}

/**
 * Total database connections the tier can open: every web process (pool + side pools), the worker
 * and the one-off tools.
 */
export function dbConnectionTotal(o) {
  const webs = o.hasWeb ? o.processes : 0;
  return (
    webs * (o.webPool + WEB_SIDE_POOLS) + (o.hasWorker ? o.workerPool : 0) + (o.toolsPool ?? 4)
  );
}

/**
 * Fits the web pool into the connection budget. When the total would exceed `budget`, the pool of
 * each web process is clamped down (at least MIN_CLAMPED_WEB_POOL); when even that does not fit the
 * result carries an `error`. Returns { webPool, total, warning?, error? }.
 */
export function budgetWebPool(o) {
  const budget = o.budget ?? DB_CONNECTION_BUDGET;
  const total = dbConnectionTotal(o);
  if (!o.hasWeb || total <= budget) return { webPool: o.webPool, total };
  const fixed = (o.hasWorker ? o.workerPool : 0) + (o.toolsPool ?? 4);
  const perProcess = Math.floor((budget - fixed) / o.processes) - WEB_SIDE_POOLS;
  if (perProcess < MIN_CLAMPED_WEB_POOL) {
    const need = o.processes * (MIN_CLAMPED_WEB_POOL + WEB_SIDE_POOLS) + fixed;
    return {
      webPool: o.webPool,
      total,
      error:
        `${o.processes} web processes cannot fit into the database connection budget of ${budget} ` +
        `(each needs at least ${MIN_CLAMPED_WEB_POOL + WEB_SIDE_POOLS}, worker ${o.hasWorker ? o.workerPool : 0}, tools ${o.toolsPool ?? 4}: ${need} needed). ` +
        `Reduce TIX_WEB_PROCESSES, or raise TIX_DB_CONNECTION_BUDGET together with PostgreSQL max_connections.`,
    };
  }
  const webPool = Math.min(o.webPool, perProcess);
  const clamped = dbConnectionTotal({ ...o, webPool });
  return {
    webPool,
    total: clamped,
    warning:
      `database connections: ${o.processes} web x (${o.webPool} + ${WEB_SIDE_POOLS}), worker ${o.hasWorker ? o.workerPool : 0}, tools ${o.toolsPool ?? 4} = ${total} exceeds the budget of ${budget} ` +
      `(TIX_DB_CONNECTION_BUDGET, PostgreSQL allows 100 by default): the pool of each web process is reduced from ${o.webPool} to ${webPool} (${clamped} connections). ` +
      `Lower WEB_DATABASE_POOL_MAX / TIX_WEB_PROCESSES, or raise TIX_DB_CONNECTION_BUDGET and max_connections.`,
  };
}

/**
 * Memory warnings. Returns { total, warnings }. `toolsPool` is the pool of one-off tools (migrate,
 * backup) that may run next to the application.
 */
export function sizingWarnings(o) {
  const warnings = [];
  const total = dbConnectionTotal(o);
  if (o.processes > 1 && o.memoryLimitBytes) {
    const mb = (o.hasWeb ? o.processes * o.webHeapMb : 0) + (o.otherHeapMb ?? 0);
    const limitMb = Math.floor(o.memoryLimitBytes / 1048576);
    if (mb > limitMb) {
      warnings.push(
        `memory: ${o.processes} web processes x ${o.webHeapMb} MB heap limit (plus the other processes) = ${mb} MB is above the container memory limit of ${limitMb} MB. ` +
          `Lower WEB_MAX_OLD_SPACE_MB or TIX_WEB_PROCESSES, or raise the container limit (the heap limit is a cap, not a reservation, but a busy process can reach it).`,
      );
    }
  }
  return { total, warnings };
}
