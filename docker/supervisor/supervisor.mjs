#!/usr/bin/env node
// Entry point of the `tix` image (PID 1 is tini, then this file).
//
//   serve (default)   migrate + seed, then web + realtime + worker behind the built-in proxy on :8080
//   migrate | seed    run the database step once and exit
//   create-admin ...  create/reset an administrator (arguments go to the CLI)
//   keygen            print a fresh APP_ENCRYPTION_KEYS value
//   healthcheck       exit 0 when the container is healthy (used by HEALTHCHECK)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ManagedChild, cachedAsync, createLogger, runOnce, stopRun } from './children.mjs';
import { childEnv, generateKeyRing, resolveEnv, withVersionDefaults } from './env.mjs';
import {
  buildAllowedHosts,
  createProxyServer,
  listenDualStack,
  parseTrustedProxies,
  trustWarnings,
} from './proxy.mjs';

const APP_DIR = process.env.TIX_APP_DIR || '/app';
const out = (line) => process.stdout.write(line + '\n');
const err = (line) => process.stderr.write(line + '\n');
const log = createLogger(out);

const [command = 'serve', ...rest] = process.argv.slice(2);

function fail(errors) {
  for (const e of errors) err(`[tix] ${e}`);
  process.exit(1);
}

function httpGet(port, urlPath, timeoutMs = 2_000, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: urlPath, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

/** resolveEnv + the image version (APP_VERSION) read from /app/VERSION when not set. */
function resolve(opts = {}) {
  const result = resolveEnv(process.env, opts);
  let imageVersion;
  try {
    imageVersion = readFileSync(path.join(APP_DIR, 'VERSION'), 'utf8').trim();
  } catch {
    // not an image build (development): the apps fall back to their built-in version
  }
  result.env = withVersionDefaults(result.env, imageVersion);
  return result;
}

const entries = {
  migrate: { file: 'worker/dist/migrate.mjs', cwd: 'worker' },
  seed: { file: 'worker/dist/seed.mjs', cwd: 'worker' },
  'create-admin': { file: 'worker/dist/create-admin.mjs', cwd: 'worker' },
  worker: { file: 'worker/dist/index.mjs', cwd: 'worker' },
  realtime: { file: 'realtime/dist/index.mjs', cwd: 'realtime' },
  web: { file: 'web/apps/web/server.js', cwd: 'web' },
};
const entryPath = (name) => path.join(APP_DIR, entries[name].file);
const entryCwd = (name) => path.join(APP_DIR, entries[name].cwd);

async function main() {
  switch (command) {
    case 'keygen':
      out(`APP_ENCRYPTION_KEYS=${generateKeyRing()}`);
      return;

    case 'healthcheck': {
      const port = Number(process.env.PORT) || 8080;
      process.exit((await httpGet(port, '/__tix/health', 4_000)) === 200 ? 0 : 1);
      return;
    }

    case 'migrate':
    case 'seed':
    case 'create-admin': {
      const { env, errors, notes, settings } = resolve({ oneOff: true });
      if (errors.length) fail(errors);
      const code = await new Promise((resolve) => {
        // Inherit stdio: interactive prompts and exit codes pass straight through.
        const args = [
          '--enable-source-maps',
          entryPath(command),
          ...(command === 'create-admin' ? rest : []),
        ];
        const child = spawn(process.execPath, args, {
          env: childEnv(env, settings, command),
          cwd: entryCwd(command),
          stdio: 'inherit',
        });
        for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
        child.on('close', (c, s) => resolve(c ?? (s ? 128 : 1)));
      });
      process.exit(code);
      return;
    }

    case 'serve':
      return serve();

    default:
      fail([
        `unknown command "${command}" (serve, migrate, seed, create-admin, keygen, healthcheck)`,
      ]);
  }
}

async function serve() {
  const { env, errors, notes, settings } = resolve();
  if (errors.length) {
    err('[tix] The configuration is incomplete, not starting:');
    fail(errors);
  }
  for (const n of notes) log.info(n);
  const parsedTrust = parseTrustedProxies(settings.trustedProxies);
  if (parsedTrust.invalid.length) {
    fail([
      `TRUSTED_PROXIES contains entries that are neither an IP, a CIDR nor private_ranges: ${parsedTrust.invalid.join(' ')}`,
    ]);
  }
  for (const w of trustWarnings(env.APP_URL, settings.trustedProxies)) log.warn(w);
  const allowedHosts = buildAllowedHosts(env.APP_URL, settings.allowedHosts);

  let mode = 'updating'; // null = proxy normally
  const { roles } = settings;
  const has = (r) => roles.includes(r);

  // Anyone can poll /__tix/health: probe the components at most every 1.5 s.
  const probe = cachedAsync(async () => {
    const components = {};
    const checks = [];
    if (has('web'))
      checks.push(
        httpGet(settings.webPort, '/api/health', 2_000, 'localhost').then(
          (s) => (components.web = s === 200 ? 'ok' : 'down'),
        ),
      );
    if (has('realtime'))
      checks.push(
        httpGet(settings.realtimePort, '/healthz').then(
          (s) => (components.realtime = s === 200 ? 'ok' : 'down'),
        ),
      );
    if (has('worker'))
      checks.push(
        httpGet(settings.workerHealthPort, '/healthz').then(
          (s) => (components.worker = s === 200 ? 'ok' : 'down'),
        ),
      );
    await Promise.all(checks);
    const ok = Object.values(components).every((v) => v === 'ok');
    return { ok, status: ok ? 'ok' : 'unhealthy', components };
  }, 1_500);
  const health = async () => {
    if (mode) return { ok: false, status: mode, components: {} };
    return probe();
  };

  const proxy = createProxyServer({
    trustedProxies: settings.trustedProxies,
    upstreamTimeoutMs: settings.proxyTimeoutMs,
    socketTimeoutMs: settings.socketTimeoutMs,
    requestTimeoutMs: settings.requestTimeoutMs,
    maxConnsPerIp: settings.maxConnsPerIp,
    allowedHosts,
    webPort: settings.webPort,
    realtimePort: settings.realtimePort,
    getMode: () => mode,
    log: (m) => log.warn(m),
    handleLocal: (req, res) => {
      if (req.url !== '/__tix/health' || (req.method !== 'GET' && req.method !== 'HEAD'))
        return false;
      health().then((h) => {
        res.writeHead(h.ok ? 200 : 503, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        res.end(
          req.method === 'HEAD'
            ? undefined
            : JSON.stringify({ status: h.status, components: h.components }),
        );
      });
      return true;
    },
  });

  // Listen first: during migrations users and health checks get the "updating" page.
  await new Promise((resolve, reject) => {
    listenDualStack(proxy.server, settings.publicPort).then(resolve, reject);
  }).catch((e) => fail([`cannot listen on port ${settings.publicPort}: ${e.message}`]));
  log.info('listening', {
    port: settings.publicPort,
    roles,
    trustedProxies: settings.trustedProxies || '(none: this proxy is the edge)',
  });

  const children = [];
  let shuttingDown = false;
  let migrateChild = null;
  let migrateRun = null;
  let migrateKilled = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    mode = 'shutdown';
    log.info('shutting down', { signal, drainMs: settings.drainMs });
    // A migration is stopped (SIGTERM, SIGKILL after the drain time) and awaited: exiting while it
    // still holds its advisory lock / a transaction would leave the orphan running.
    const migrateStop = migrateChild
      ? ((migrateKilled = true),
        stopRun(migrateChild, migrateRun, settings.drainMs, () =>
          log.warn('migration did not stop in time, killing', { drainMs: settings.drainMs }),
        ))
      : null;
    // Order: stop accepting, start the (long) worker drain right away, let in-flight proxied
    // requests finish, then stop web and realtime.
    const closing = proxy.close(Math.min(5_000, settings.drainMs));
    const worker = children.find((c) => c.name === 'worker');
    const workerStop = worker?.stop(settings.drainMs);
    await closing;
    await Promise.all(children.filter((c) => c !== worker).map((c) => c.stop(settings.drainMs)));
    await workerStop;
    await migrateStop;
    log.info('shutdown complete');
    process.exit(migrateKilled ? 143 : 0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // ── Database: migrate + seed (advisory-locked, safe in every instance) ────
  if (settings.migrate) {
    for (const step of ['migrate', 'seed']) {
      log.info(`${step}: running`);
      migrateRun = runOnce(step, ['--enable-source-maps', entryPath(step)], {
        env: childEnv(env, settings, step),
        cwd: entryCwd(step),
        out,
        err,
        onSpawn: (c) => (migrateChild = c),
      });
      const code = await migrateRun;
      migrateChild = null;
      migrateRun = null;
      if (shuttingDown) return;
      if (code !== 0) {
        log.error(
          `${step} FAILED (exit ${code}); the application was NOT started and no data was changed by later steps. See the lines above for the reason, fix it and restart the container.`,
        );
        process.exit(1);
      }
      log.info(`${step}: done`);
    }
  } else {
    log.info('migrate/seed skipped (TIX_MIGRATE=0)');
  }

  // ── Application processes ─────────────────────────────────────────────────
  const make = (name) =>
    new ManagedChild({
      name,
      args: [
        `--max-old-space-size=${settings.memory[name]}`,
        ...(name === 'web' ? [] : ['--enable-source-maps']),
        entryPath(name),
      ],
      env: childEnv(env, settings, name),
      cwd: entryCwd(name),
      out,
      err,
      log,
    });
  for (const role of ['web', 'realtime', 'worker']) {
    if (!has(role)) continue;
    const child = make(role);
    children.push(child);
    child.start();
  }
  mode = null;
  log.info('serving');
}

main().catch((e) => {
  err(`[tix] fatal: ${e instanceof Error ? e.stack : e}`);
  process.exit(1);
});
