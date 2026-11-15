// Secrets handling, child environments, health cache and migrate shutdown of the supervisor.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cachedAsync, stopRun } from '../children.mjs';
import { childEnv, generateKeyRing, resolveEnv, resolveOrGenerateSecret } from '../env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const envModule = pathToFileURL(path.join(here, '..', 'env.mjs')).href;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'tix-hard-'));

/** Runs resolveOrGenerateSecret in `n` real processes at the same time; returns their stdout. */
function concurrentResolve(dir, n) {
  const code = `
    import { resolveOrGenerateSecret } from ${JSON.stringify(envModule)};
    import { randomBytes } from 'node:crypto';
    const r = resolveOrGenerateSecret('SESSION_SECRET', {}, ${JSON.stringify(dir)}, () => randomBytes(48).toString('base64url'));
    process.stdout.write(r.value);`;
  return Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', code]);
          let out = '';
          let err = '';
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', (d) => (err += d));
          child.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(err))));
        }),
    ),
  );
}

test('session secret: concurrent first starts agree on one value, no temp files are left', async () => {
  const dir = tmp();
  const values = await concurrentResolve(dir, 8);
  assert.equal(new Set(values).size, 1);
  assert.ok(values[0].length >= 32);
  assert.deepEqual(readdirSync(dir), ['session_secret']);
  assert.equal(readFileSync(path.join(dir, 'session_secret'), 'utf8').trim(), values[0]);
  if (process.platform !== 'win32') {
    assert.equal(statSync(path.join(dir, 'session_secret')).mode & 0o777, 0o600);
  }
});

test('session secret: an existing empty or short file is regenerated, concurrent starts agree', async () => {
  for (const leftover of ['', '\n', 'short']) {
    const dir = tmp();
    writeFileSync(path.join(dir, 'session_secret'), leftover);
    const values = await concurrentResolve(dir, 6);
    assert.equal(new Set(values).size, 1, JSON.stringify(leftover));
    assert.ok(values[0].length >= 32);
    assert.equal(readFileSync(path.join(dir, 'session_secret'), 'utf8').trim(), values[0]);
    assert.deepEqual(readdirSync(dir), ['session_secret']); // no tmp, no stale lock
  }
});

test('session secret: a usable stored value is never replaced', () => {
  const dir = tmp();
  const good = 'g'.repeat(40);
  writeFileSync(path.join(dir, 'session_secret'), good + '\n');
  const r = resolveOrGenerateSecret('SESSION_SECRET', {}, dir, () => 'x'.repeat(64));
  assert.deepEqual(r, { value: good, source: 'file' });
});

test('session secret: a write failure names the volume problem', () => {
  const dir = tmp();
  assert.throws(
    () =>
      resolveOrGenerateSecret('SESSION_SECRET', {}, dir, () => 'x'.repeat(64), {
        writeExclusive: () => {
          throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
        },
      }),
    /cannot persist SESSION_SECRET.*Mount a writable volume/,
  );
  assert.equal(existsSync(path.join(dir, 'session_secret')), false);
});

const KEYS = generateKeyRing();
const baseEnv = () =>
  resolveEnv({
    APP_ENCRYPTION_KEYS: KEYS,
    POSTGRES_PASSWORD: 'pw',
    POSTGRES_PASSWORD_FILE: '/run/secrets/pg',
    S3_ACCESS_KEY_ID: 'ak',
    S3_SECRET_ACCESS_KEY: 'sk',
    S3_SECRET_ACCESS_KEY_FILE: '/run/secrets/sk',
    TIX_SECRETS_DIR: tmp(),
    TIX_ALLOWED_HOSTS: 'x.example',
  });

test('children only get the secrets they need', () => {
  const { env, settings } = baseEnv();
  assert.ok(env.APP_ENCRYPTION_KEYS && env.SESSION_SECRET && env.DATABASE_URL);

  const rt = childEnv(env, settings, 'realtime');
  for (const name of [
    'APP_ENCRYPTION_KEYS',
    'DATABASE_URL',
    'POSTGRES_PASSWORD',
    'POSTGRES_PASSWORD_FILE',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_SECRET_ACCESS_KEY_FILE',
  ]) {
    assert.equal(rt[name], undefined, name);
  }
  assert.equal(rt.SESSION_SECRET, env.SESSION_SECRET);
  assert.equal(rt.REDIS_URL, env.REDIS_URL);
  assert.equal(rt.REALTIME_HOST, '127.0.0.1');

  for (const role of ['web', 'worker']) {
    const c = childEnv(env, settings, role);
    assert.ok(c.APP_ENCRYPTION_KEYS && c.SESSION_SECRET && c.DATABASE_URL, role);
    assert.equal(c.S3_SECRET_ACCESS_KEY, 'sk');
    assert.equal(c.POSTGRES_PASSWORD, undefined);
    assert.equal(c.TIX_ALLOWED_HOSTS, undefined);
  }
  assert.equal(childEnv(env, settings, 'worker').WORKER_HEALTH_HOST, '127.0.0.1');

  const migrate = childEnv(env, settings, 'migrate');
  assert.ok(migrate.APP_ENCRYPTION_KEYS && migrate.DATABASE_URL && migrate.S3_SECRET_ACCESS_KEY);
  assert.equal(migrate.SESSION_SECRET, undefined);

  for (const role of ['seed', 'create-admin']) {
    const c = childEnv(env, settings, role);
    assert.ok(c.DATABASE_URL, role);
    assert.equal(c.SESSION_SECRET, undefined, role);
    assert.equal(c.APP_ENCRYPTION_KEYS, undefined, role);
    assert.equal(c.S3_SECRET_ACCESS_KEY, undefined, role);
  }
  // the resolved env itself is not modified
  assert.ok(env.APP_ENCRYPTION_KEYS && env.POSTGRES_PASSWORD);
});

test('proxy knobs: defaults and validation', () => {
  const { settings, errors } = baseEnv();
  assert.deepEqual(errors, []);
  assert.equal(settings.socketTimeoutMs, 120_000);
  assert.equal(settings.maxConnsPerIp, 200);
  assert.equal(settings.allowedHosts, 'x.example');
  const custom = resolveEnv({
    APP_ENCRYPTION_KEYS: KEYS,
    POSTGRES_PASSWORD: 'pw',
    TIX_SECRETS_DIR: tmp(),
    TIX_PROXY_SOCKET_TIMEOUT_MS: '5000',
    TIX_PROXY_MAX_CONNS_PER_IP: '0',
  });
  assert.equal(custom.settings.socketTimeoutMs, 5000);
  assert.equal(custom.settings.maxConnsPerIp, 0);
  const bad = resolveEnv({
    APP_ENCRYPTION_KEYS: KEYS,
    POSTGRES_PASSWORD: 'pw',
    TIX_SECRETS_DIR: tmp(),
    TIX_PROXY_SOCKET_TIMEOUT_MS: 'soon',
  });
  assert.match(bad.errors.join(), /TIX_PROXY_SOCKET_TIMEOUT_MS/);
});

test('cachedAsync: one probe per ttl, concurrent callers share it', async () => {
  let calls = 0;
  let clock = 0;
  const probe = cachedAsync(
    async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return calls;
    },
    1_500,
    () => clock,
  );
  const [a, b, c] = await Promise.all([probe(), probe(), probe()]);
  assert.deepEqual([a, b, c], [1, 1, 1]);
  clock = 1_000;
  assert.equal(await probe(), 1);
  clock = 1_600;
  assert.equal(await probe(), 2);
  assert.equal(calls, 2);
});

test('cachedAsync: a failing probe is not cached', async () => {
  let calls = 0;
  const probe = cachedAsync(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return 'ok';
    },
    1_000,
    () => 0,
  );
  await assert.rejects(probe(), /boom/);
  assert.equal(await probe(), 'ok');
});

function spawnHolder(ignoreTerm) {
  const src = `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000); process.stdout.write('up');`;
  const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
  const run = new Promise((resolve) =>
    child.on('close', (code, signal) => resolve({ code, signal })),
  );
  const ready = new Promise((resolve) => child.stdout.once('data', resolve));
  return { child, run, ready };
}

test('stopRun: SIGTERM and wait for the child to be gone', async () => {
  const { child, run, ready } = spawnHolder(false);
  await ready;
  const t0 = Date.now();
  const result = await stopRun(child, run, 5_000);
  assert.equal(result.forced, false);
  assert.ok(Date.now() - t0 < 4_000);
  assert.notEqual(child.exitCode ?? child.signalCode, null);
});

test('stopRun: a child that ignores SIGTERM is killed after the drain time', async (t) => {
  if (process.platform === 'win32') return t.skip('SIGTERM cannot be ignored on Windows');
  const { child, run, ready } = spawnHolder(true);
  await ready;
  let forced = false;
  const result = await stopRun(child, run, 300, () => (forced = true));
  assert.equal(result.forced, true);
  assert.equal(forced, true);
  assert.equal(child.signalCode, 'SIGKILL');
});
