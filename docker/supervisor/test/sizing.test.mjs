// Web process count, ports, database pool division and startup warnings (docker/supervisor/sizing.mjs).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { childEnv, generateKeyRing, resolveEnv } from '../env.mjs';
import {
  allocateWebPorts,
  parseWebProcesses,
  readCgroupCpuLimit,
  readCgroupMemoryLimit,
  resolveWebProcessCount,
  sizingWarnings,
  budgetWebPool,
  webPoolPerProcess,
} from '../sizing.mjs';

const files = (map) => (file) => {
  if (file in map) return map[file];
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

test('TIX_WEB_PROCESSES: default 1, integer 1..16 or auto, everything else is an error', () => {
  assert.deepEqual(parseWebProcesses(undefined), { value: 1 });
  assert.deepEqual(parseWebProcesses(''), { value: 1 });
  assert.deepEqual(parseWebProcesses(' 3 '), { value: 3 });
  assert.deepEqual(parseWebProcesses('AUTO'), { value: 'auto' });
  for (const bad of ['0', '17', '-1', '2.5', 'many', '0x2', '1e1']) {
    assert.match(parseWebProcesses(bad).error, /TIX_WEB_PROCESSES/, bad);
  }
});

test('auto: min(visible CPUs, container quota, cap 8), at least 1, reason names the inputs', () => {
  assert.equal(resolveWebProcessCount('auto', { cpus: 4, cgroupCpus: null }).n, 4);
  assert.equal(resolveWebProcessCount('auto', { cpus: 16, cgroupCpus: 2 }).n, 2);
  assert.equal(resolveWebProcessCount('auto', { cpus: 2, cgroupCpus: 6 }).n, 2);
  assert.equal(resolveWebProcessCount('auto', { cpus: 64, cgroupCpus: null }).n, 8);
  assert.equal(resolveWebProcessCount('auto', { cpus: 0, cgroupCpus: null }).n, 1);
  const r = resolveWebProcessCount('auto', { cpus: 16, cgroupCpus: 2 });
  assert.match(r.reason, /16 CPU/);
  assert.match(r.reason, /CPU limit 2/);
  assert.match(r.reason, /cap 8/);
  assert.deepEqual(resolveWebProcessCount(5), { n: 5, reason: 'TIX_WEB_PROCESSES' });
  assert.equal(resolveWebProcessCount(1).n, 1);
});

test('cgroup CPU limit: v2 cpu.max, v1 cfs files, unlimited and unreadable', () => {
  assert.equal(readCgroupCpuLimit(files({ '/sys/fs/cgroup/cpu.max': '200000 100000\n' })), 2);
  assert.equal(readCgroupCpuLimit(files({ '/sys/fs/cgroup/cpu.max': '150000 100000' })), 2);
  assert.equal(readCgroupCpuLimit(files({ '/sys/fs/cgroup/cpu.max': '50000 100000' })), 1);
  assert.equal(readCgroupCpuLimit(files({ '/sys/fs/cgroup/cpu.max': 'max 100000' })), null);
  assert.equal(
    readCgroupCpuLimit(
      files({
        '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '300000',
        '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
      }),
    ),
    3,
  );
  assert.equal(
    readCgroupCpuLimit(
      files({
        '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1',
        '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
      }),
    ),
    null,
  );
  assert.equal(readCgroupCpuLimit(files({})), null);
});

test('cgroup memory limit: v2, v1, "max" and the v1 no-limit sentinel', () => {
  assert.equal(
    readCgroupMemoryLimit(files({ '/sys/fs/cgroup/memory.max': '2147483648\n' })),
    2147483648,
  );
  assert.equal(readCgroupMemoryLimit(files({ '/sys/fs/cgroup/memory.max': 'max' })), null);
  assert.equal(
    readCgroupMemoryLimit(files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '1073741824' })),
    1073741824,
  );
  assert.equal(
    readCgroupMemoryLimit(
      files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' }),
    ),
    null,
  );
  assert.equal(readCgroupMemoryLimit(files({})), null);
});

test('ports: one process keeps TIX_WEB_PORT, more count upwards and skip reserved ports', () => {
  assert.deepEqual(allocateWebPorts(1, 3000, [3001, 8081, 8080]).ports, [3000]);
  assert.deepEqual(allocateWebPorts(3, 3000, [3001, 8081, 8080]).ports, [3000, 3002, 3003]);
  assert.deepEqual(allocateWebPorts(3, 8079, [3001, 8081, 8080]).ports, [8079, 8082, 8083]);
  const ports = allocateWebPorts(16, 3000, [3001, 8081, 8080]).ports;
  assert.equal(new Set(ports).size, 16);
  for (const reserved of [3001, 8081, 8080]) assert.ok(!ports.includes(reserved));
  assert.match(allocateWebPorts(3, 65534, []).error, /no room/);
});

test('database pool: budget 20 divided by the process count (min 4); explicit value is per process', () => {
  assert.equal(webPoolPerProcess(1), 20);
  assert.equal(webPoolPerProcess(2), 10);
  assert.equal(webPoolPerProcess(3), 6);
  assert.equal(webPoolPerProcess(4), 5);
  assert.equal(webPoolPerProcess(8), 4);
  assert.equal(webPoolPerProcess(16), 4);
  assert.equal(webPoolPerProcess(4, 12), 12);
  assert.equal(webPoolPerProcess(1, 3), 3);
});

const warn = (extra) =>
  sizingWarnings({
    hasWeb: true,
    hasWorker: true,
    processes: 1,
    webPool: 20,
    workerPool: 8,
    toolsPool: 4,
    webHeapMb: 768,
    otherHeapMb: 1280,
    memoryLimitBytes: null,
    ...extra,
  });

test('connection total counts side pools, worker and tools', () => {
  assert.equal(warn({}).total, 20 + 2 + 8 + 4);
  assert.equal(warn({ processes: 3, webPool: 6 }).total, 3 * 8 + 8 + 4);
  assert.equal(warn({ hasWeb: false, processes: 8 }).total, 12);
  assert.deepEqual(warn({ processes: 8, webPool: 12 }).warnings, []);
});

const fit = (extra) =>
  budgetWebPool({
    hasWeb: true,
    hasWorker: true,
    processes: 1,
    webPool: 20,
    workerPool: 8,
    toolsPool: 4,
    ...extra,
  });

test('connection budget: within the budget nothing changes', () => {
  const r = fit({ processes: 3, webPool: 6 });
  assert.equal(r.webPool, 6);
  assert.equal(r.warning, undefined);
  assert.equal(fit({}).webPool, 20);
  assert.equal(fit({ hasWeb: false, processes: 16 }).webPool, 20);
});

test('connection budget: 16 processes are clamped to fit 90, with a warning', () => {
  const r = fit({ processes: 16, webPool: 4 });
  assert.equal(r.webPool, 2);
  assert.ok(r.total <= 90, `total ${r.total}`);
  assert.match(r.warning, /reduced from 4 to 2/);
  assert.equal(r.error, undefined);
});

test('connection budget: an explicit per-process pool is clamped, a custom budget is honoured', () => {
  const r = fit({ processes: 8, webPool: 20 });
  assert.equal(r.webPool, Math.floor((90 - 12) / 8) - 2);
  assert.ok(r.total <= 90);
  assert.match(r.warning, /8 web x \(20 \+ 2\)/);
  assert.equal(fit({ processes: 8, webPool: 20, budget: 200 }).webPool, 20);
});

test('connection budget: refuses when even the minimum cannot fit', () => {
  const r = fit({ processes: 16, webPool: 4, budget: 60 });
  assert.match(r.error, /TIX_WEB_PROCESSES/);
  assert.match(r.error, /budget of 60/);
});

test('memory warning only for several processes above the container limit', () => {
  const gb = 1024 ** 3;
  assert.deepEqual(warn({ processes: 3, webPool: 6, memoryLimitBytes: 8 * gb }).warnings, []);
  const w = warn({ processes: 3, webPool: 6, memoryLimitBytes: 2 * gb });
  assert.equal(w.warnings.length, 1);
  assert.match(w.warnings[0], /3 web processes x 768 MB/);
  assert.match(w.warnings[0], /container memory limit of 2048 MB/);
  // one process keeps today's silence, even in a small container
  assert.deepEqual(warn({ processes: 1, memoryLimitBytes: gb }).warnings, []);
});

const KEYS = generateKeyRing();
const env = (extra = {}, opts = {}) =>
  resolveEnv(
    {
      APP_ENCRYPTION_KEYS: KEYS,
      POSTGRES_PASSWORD: 'x',
      TIX_SECRETS_DIR: mkdtempSync(path.join(tmpdir(), 'tix-size-')),
      ...extra,
    },
    { hardware: { cpus: 4, cgroupCpus: null }, memoryLimitBytes: null, ...opts },
  );

test('resolveEnv: defaults are unchanged (one process, port 3000, pool 20)', () => {
  const resolved = env();
  const { settings, errors } = resolved;
  assert.deepEqual(errors, []);
  assert.equal(settings.webProcesses, 1);
  assert.deepEqual(settings.webPorts, [3000]);
  assert.equal(settings.webPool, 20);
  const child = childEnv(resolved.env, settings, 'web');
  assert.equal(child.PORT, '3000');
  assert.equal(child.DATABASE_POOL_MAX, '20');
});

test('resolveEnv: several processes get ports, a divided pool and a note', () => {
  const resolved = env({ TIX_WEB_PROCESSES: '3' });
  assert.deepEqual(resolved.errors, []);
  assert.deepEqual(resolved.settings.webPorts, [3000, 3002, 3003]);
  assert.equal(resolved.settings.webPool, 6);
  const child1 = childEnv(resolved.env, resolved.settings, 'web', 1);
  assert.equal(child1.PORT, '3002');
  assert.equal(child1.TIX_WEB_INDEX, undefined);
  assert.equal(child1.DATABASE_POOL_MAX, '6');
  assert.equal(childEnv(resolved.env, resolved.settings, 'web', 2).PORT, '3003');
});

test('resolveEnv: auto uses the injected hardware; explicit pool is per process', () => {
  const a = env({ TIX_WEB_PROCESSES: 'auto' }, { hardware: { cpus: 16, cgroupCpus: 2 } });
  assert.equal(a.settings.webProcesses, 2);
  assert.match(a.settings.webProcessesReason, /auto/);
  const p = env({ TIX_WEB_PROCESSES: '2', WEB_DATABASE_POOL_MAX: '15' });
  assert.equal(p.settings.webPool, 15);
  assert.equal(p.settings.dbConnectionsTotal, 2 * 17 + 8 + 4);
});

test('resolveEnv: invalid values and warnings are reported', () => {
  assert.match(env({ TIX_WEB_PROCESSES: '99' }).errors[0], /TIX_WEB_PROCESSES/);
  const w = env({ TIX_WEB_PROCESSES: '4' }, { memoryLimitBytes: 1024 ** 3 }).settings
    .sizingWarnings;
  assert.match(w[0], /memory/);
  const many = env({ TIX_WEB_PROCESSES: '8', WEB_DATABASE_POOL_MAX: '20' }).settings;
  assert.match(many.sizingWarnings[0], /database connections/);
  assert.equal(many.webPool, 7);
  assert.ok(many.dbConnectionsTotal <= 90);
});

test('resolveEnv: 16 processes are clamped; too small a budget refuses to start', () => {
  const sixteen = env({ TIX_WEB_PROCESSES: '16' });
  assert.deepEqual(sixteen.errors, []);
  assert.equal(sixteen.settings.webPool, 2);
  assert.ok(sixteen.settings.dbConnectionsTotal <= 90);
  assert.match(sixteen.settings.sizingWarnings[0], /reduced from 4 to 2/);
  const tight = env({ TIX_WEB_PROCESSES: '16', TIX_DB_CONNECTION_BUDGET: '50' });
  assert.match(tight.errors.join(), /Reduce TIX_WEB_PROCESSES/);
  const roomy = env({ TIX_WEB_PROCESSES: '16', TIX_DB_CONNECTION_BUDGET: '200' });
  assert.equal(roomy.settings.webPool, 4);
});

test('resolveEnv: TIX_WEB_PORT must not collide with other ports (web role only)', () => {
  assert.match(env({ TIX_WEB_PORT: '8080' }).errors.join(), /TIX_WEB_PORT.*PORT/);
  assert.match(env({ TIX_WEB_PORT: '3001' }).errors.join(), /TIX_REALTIME_PORT/);
  assert.match(env({ TIX_WEB_PORT: '8081' }).errors.join(), /WORKER_HEALTH_PORT/);
  assert.deepEqual(env({ TIX_WEB_PORT: '8080', TIX_ROLE: 'worker' }).errors, []);
});
