// Load-test orchestrator. Brings up an ISOLATED copy of the stack (compose project "tixload",
// own volumes, own host ports), seeds the demo event, runs the scenarios, checks the invariants,
// scans the container logs for deadlocks / errors and tears everything down again.
//
//   node scripts/load/run.mjs [--vus 1200] [--scenarios seat-rush,best-available,waiting-room,checkout-rush]
//        [--keep] [--web-pool-max 20] [--no-build] [--image-registry tixload] [--http-port 18080] [--queue-seconds 150]
//
// Against an existing (staging) server instead of the isolated stack - see docs/LOAD-TEST.md:
//   node scripts/load/run.mjs --target https://staging.example.org --event-id <uuid> \
//        --database-url <postgres url> --redis-url <redis url> --confirm-non-production
//
// Wrappers: scripts/load/run.ps1 (Windows PowerShell) and scripts/load/run.sh.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseArgs, sleep } from './lib/common.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const resultsDir = fileURLToPath(new URL('./results/', import.meta.url));
let stackUp = false;
const args = parseArgs(process.argv.slice(2));
const ALL = ['seat-rush', 'best-available', 'waiting-room', 'checkout-rush'];
const scenarios = String(args.scenarios ?? ALL.join(','))
  .split(',')
  .filter(Boolean);
for (const s of scenarios)
  if (!ALL.includes(s)) fail(`Unknown scenario "${s}" (known: ${ALL.join(', ')})`);
const vus = Number(args.vus ?? 1200);
const project = String(args.project ?? 'tixload');
if (project === 'tix') fail('Refusing to use the compose project "tix" (the real stack).');
const external = Boolean(args.target);
const keep = Boolean(args.keep);

function fail(message) {
  // once the stack is up, throw so the `finally` block can still tear it down
  if (stackUp) throw new Error(message);
  console.error(`ERROR: ${message}`);
  process.exit(2);
}
// pnpm is a .cmd shim on Windows and needs a shell; docker.exe does not.
const sh = (cmd, cmdArgs, opts = {}) =>
  spawnSync(cmd, cmdArgs, {
    cwd: repo,
    encoding: 'utf8',
    shell: cmd === 'pnpm' && process.platform === 'win32',
    ...opts,
  });

// ── ports / env ──────────────────────────────────────────────────────────────────
const base = Number(args['http-port'] ?? 18080);
const ports = {
  HTTP_PORT: base,
  HTTPS_PORT: Number(args['https-port'] ?? base + 363),
  POSTGRES_PORT: Number(args['postgres-port'] ?? 15432),
  REDIS_PORT: Number(args['redis-port'] ?? 16379),
  MINIO_API_PORT: Number(args['minio-port'] ?? 19000),
  MINIO_CONSOLE_PORT: Number(args['minio-console-port'] ?? 19001),
};
const envFile = `${resultsDir}load.env`;
const compose = (...a) =>
  sh('docker', [
    'compose',
    '-p',
    project,
    '--env-file',
    envFile,
    '-f',
    'docker-compose.yml',
    '-f',
    'scripts/load/docker-compose.load.yml',
    ...a,
  ]);

const portFree = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });

function writeEnv() {
  const hex = () => randomBytes(24).toString('hex');
  const lines = {
    COMPOSE_PROJECT_NAME: project,
    LOG_LEVEL: 'warn',
    IMAGE_REGISTRY: args['image-registry'] ?? 'tixload',
    PUBLIC_URL: `http://localhost:${ports.HTTP_PORT}`,
    SITE_ADDRESS: ':80',
    ...ports,
    POSTGRES_USER: 'tix',
    POSTGRES_PASSWORD: hex(),
    POSTGRES_DB: 'tix',
    POSTGRES_MAX_CONNECTIONS: 300,
    ...(args['web-pool-max'] ? { WEB_DATABASE_POOL_MAX: Number(args['web-pool-max']) } : {}),
    REDIS_PASSWORD: hex(),
    REDIS_KEY_PREFIX: 'tix',
    MINIO_ROOT_USER: 'loadadmin',
    MINIO_ROOT_PASSWORD: hex(),
    S3_PUBLIC_URL: `http://localhost:${ports.MINIO_API_PORT}`,
    S3_ACCESS_KEY_ID: 'loadapp',
    S3_SECRET_ACCESS_KEY: hex(),
    APP_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    SESSION_SECRET: randomBytes(48).toString('base64'),
  };
  writeFileSync(
    envFile,
    Object.entries(lines)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
  );
}
const readEnv = () =>
  Object.fromEntries(
    readFileSync(envFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

// ── resource sampling (docker stats) ─────────────────────────────────────────────
const peak = new Map();
let sampling = false;
async function sampleLoop() {
  sampling = true;
  while (sampling) {
    const r = sh('docker', [
      'stats',
      '--no-stream',
      '--format',
      '{{.Name}};{{.CPUPerc}};{{.MemUsage}}',
      ...['web', 'worker', 'realtime', 'proxy', 'postgres', 'redis'].map(
        (s) => `${project}-${s}-1`,
      ),
    ]);
    for (const line of (r.stdout ?? '').split('\n').filter(Boolean)) {
      const [name, cpu, mem] = line.split(';');
      const cur = peak.get(name) ?? { cpu: 0, mem: '' };
      const cpuN = parseFloat(cpu);
      if (cpuN > cur.cpu) cur.cpu = cpuN;
      cur.mem = mem.split('/')[0].trim();
      peak.set(name, cur);
    }
    await sleep(4000);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────────
let target;
let urls;
let eventId = args['event-id'];
let isolationToken = '';

async function teardown() {
  sampling = false;
  if (external || keep) return;
  console.log('\nTearing down the isolated stack ...');
  compose('down', '-v', '--remove-orphans');
  if (!args['no-build'] && !args['image-registry']) {
    // only the images this run built (tixload/*); never anything of the real stack (tix/*)
    for (const svc of ['web', 'worker', 'realtime'])
      sh('docker', ['image', 'rm', '-f', `tixload/${svc}:local`]);
  }
  rmSync(envFile, { force: true });
}

async function main() {
  mkdirSync(resultsDir, { recursive: true });
  if (external) {
    if (!args['confirm-non-production'])
      fail(
        'Running against an external target creates orders and locks seats. Pass --confirm-non-production to confirm this is NOT a production system with real payments.',
      );
    if (!args['database-url'] || !args['redis-url'] || !eventId)
      fail('External target needs --event-id, --database-url and --redis-url (invariant checks).');
    target = String(args.target);
    urls = { db: args['database-url'], redis: args['redis-url'] };
  } else {
    if (spawnSync('docker', ['version']).status !== 0) fail('Docker is not available.');
    for (const [name, p] of Object.entries(ports))
      if (!(await portFree(p)))
        fail(`Host port ${p} (${name}) is already in use - pass another --http-port etc.`);
    if (existsSync(envFile))
      fail(`${envFile} exists (stack still running?). Run: docker compose -p ${project} down -v`);
    writeEnv();
    const env = readEnv();
    target = `http://localhost:${ports.HTTP_PORT}`;
    urls = {
      db: `postgres://tix:${env.POSTGRES_PASSWORD}@127.0.0.1:${ports.POSTGRES_PORT}/tix`,
      redis: `redis://:${env.REDIS_PASSWORD}@127.0.0.1:${ports.REDIS_PORT}/0`,
    };
    console.log(`Starting isolated stack "${project}" (HTTP ${ports.HTTP_PORT}) ...`);
    stackUp = true;
    const up = compose('up', '-d', ...(args['no-build'] ? [] : ['--build']));
    if (up.status !== 0) {
      console.error(up.stdout, up.stderr);
      fail('docker compose up failed');
    }
    const deadline = Date.now() + 240_000;
    for (;;) {
      try {
        if ((await fetch(`${target}/api/health`)).ok) break;
      } catch {}
      if (Date.now() > deadline) fail('Shop did not become healthy in time');
      await sleep(2000);
    }
    // seed: migrations + reference data already ran in the `migrate` service; now the demo event.
    // DATABASE_URL is passed explicitly and VERIFIED before anything is written.
    const probe = await verifyDb(urls.db);
    if (probe.events !== 0)
      fail(`Target database already has ${probe.events} events - refusing to seed.`);
    console.log(`Seeding demo event into ${probe.database} @ ${new URL(urls.db).host} ...`);
    const demo = sh('pnpm', ['db:demo'], { env: { ...process.env, DATABASE_URL: urls.db } });
    if (demo.status !== 0) {
      console.error(demo.stdout, demo.stderr);
      fail('pnpm db:demo failed');
    }
    eventId = (await queryOne(urls.db, `SELECT id FROM events WHERE slug = 'demo-concert'`)).id;
    // Isolation marker: run-scenario.mjs --isolated only writes to a database AND a Redis that carry
    // this run's random token (never to anything that was not created by this script).
    isolationToken = randomBytes(16).toString('hex');
    await markIsolated(urls, isolationToken);
  }

  void sampleLoop();
  const results = [];
  for (const name of scenarios) {
    console.log(`\n################ ${name} ################`);
    const a = [
      'scripts/load/run-scenario.mjs',
      name,
      '--target',
      target,
      '--vus',
      String(vus),
      '--event-id',
      eventId,
      '--database-url',
      urls.db,
      '--redis-url',
      urls.redis,
      '--observers',
      String(args.observers ?? 200),
      ...(external
        ? ['--confirm-non-production']
        : ['--fake-ip', '--isolated', '--isolation-token', isolationToken]),
      ...(args['queue-seconds'] ? ['--queue-seconds', String(args['queue-seconds'])] : []),
    ];
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, a, { cwd: repo, stdio: 'inherit' });
      child.on('exit', (c) => resolve(c ?? 2));
    });
    results.push({ name, code });
  }
  sampling = false;

  const logs = external ? null : scanLogs();
  const summary = summarize(results, logs);
  writeFileSync(`${resultsDir}summary.txt`, summary);
  console.log(summary);
  const bad = results.some((r) => r.code !== 0) || (logs && logs.deadlocks > 0);
  return bad ? 1 : 0;
}

async function markIsolated(urls, token) {
  const { openDb, openRedis } = await import('./lib/common.mjs');
  const db = await openDb(urls.db);
  try {
    await db.query(
      `COMMENT ON DATABASE ${'"'}${(await db.query('SELECT current_database() AS n')).rows[0].n}${'"'} IS 'tix-load-isolated:${token}'`,
    );
  } finally {
    await db.end();
  }
  const redis = openRedis(urls.redis);
  try {
    await redis.set('tix-load-isolated', token);
  } finally {
    redis.disconnect();
  }
}

async function verifyDb(url) {
  const r = await queryOne(
    url,
    'SELECT current_database() AS database, (SELECT count(*)::int FROM events) AS events',
  );
  return r;
}
async function queryOne(url, sql) {
  const { openDb } = await import('./lib/common.mjs');
  const db = await openDb(url);
  try {
    return (await db.query(sql)).rows[0];
  } finally {
    await db.end();
  }
}

function scanLogs() {
  const grab = (svc) => compose('logs', '--no-color', svc).stdout ?? '';
  const pg = grab('postgres');
  const web = grab('web');
  const worker = grab('worker');
  const rt = grab('realtime');
  const count = (text, re) => (text.match(re) ?? []).length;
  return {
    deadlocks: count(pg, /deadlock detected/gi),
    lockWaits: count(pg, /still waiting for/gi),
    slowStatements: count(pg, /duration: \d+/gi),
    pgErrors: count(pg, /\bERROR:/g),
    uniqueViolations: count(pg, /duplicate key value violates unique constraint/gi),
    webErrors: count(web, /\b(error|unhandled|exception)\b/gi),
    workerErrors: count(worker, /\b(error|unhandled|exception)\b/gi),
    realtimeErrors: count(rt, /\b(error|unhandled|exception)\b/gi),
    pgSample: pg
      .split('\n')
      .filter((l) => /deadlock|still waiting|ERROR:/i.test(l))
      .slice(0, 8),
    webSample: web
      .split('\n')
      .filter((l) => /\b(error|unhandled|exception)\b/i.test(l))
      .slice(0, 6),
  };
}

function summarize(results, logs) {
  const out = ['\n================ LOAD TEST SUMMARY ================', `virtual users: ${vus}`];
  for (const r of results) {
    out.push(`  ${r.code === 0 ? 'PASS' : r.code === 1 ? 'FAIL' : 'ERROR'}  ${r.name}`);
  }
  if (logs) {
    out.push(
      '',
      `postgres: deadlocks ${logs.deadlocks}, lock waits ${logs.lockWaits}, ERROR lines ${logs.pgErrors} (unique violations ${logs.uniqueViolations}), statements > 500 ms ${logs.slowStatements}`,
      `log error lines: web ${logs.webErrors}, worker ${logs.workerErrors}, realtime ${logs.realtimeErrors}`,
    );
    for (const l of logs.pgSample) out.push(`  pg  | ${l.slice(0, 220)}`);
    for (const l of logs.webSample) out.push(`  web | ${l.slice(0, 220)}`);
  }
  if (peak.size) {
    out.push('', 'peak container CPU (100 % = one core) / last memory sample:');
    for (const [name, p] of peak)
      out.push(`  ${name.padEnd(22)} ${String(p.cpu).padStart(7)} %  ${p.mem}`);
  }
  out.push('', `details per scenario: scripts/load/results/<scenario>.json`);
  return out.join('\n');
}

let code = 2;
try {
  code = await main();
} catch (err) {
  console.error(err);
} finally {
  await teardown();
}
process.exit(code);
