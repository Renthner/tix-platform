import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unlinkSync } from 'node:fs';
import { test } from 'node:test';
import {
  childEnv,
  generateKeyRing,
  parseRoles,
  readNameOrFile,
  resolveEnv,
  validateKeyRing,
  withVersionDefaults,
  writeSecretFileExclusive,
} from '../env.mjs';

const KEYS = generateKeyRing();
const base = (extra = {}) => ({
  APP_ENCRYPTION_KEYS: KEYS,
  POSTGRES_PASSWORD: 'p@ss/w:rd#?',
  TIX_SECRETS_DIR: mkdtempSync(path.join(tmpdir(), 'tix-sec-')),
  ...extra,
});

test('key ring: generated keys validate, bad ones are rejected', () => {
  assert.equal(validateKeyRing(KEYS), null);
  assert.equal(validateKeyRing(`${KEYS},k2:${Buffer.alloc(32, 1).toString('base64')}`), null);
  assert.match(validateKeyRing('abc'), /<id>:<base64>/);
  assert.match(validateKeyRing('k1:AAAA'), /32 bytes/);
  assert.match(validateKeyRing(`${KEYS},${KEYS}`), /duplicate/);
  assert.match(validateKeyRing(' '), /empty/);
});

test('key ring: the generated id is random (k + 6 hex) and valid for the app', () => {
  const ids = new Set();
  for (let i = 0; i < 20; i++) {
    const ring = generateKeyRing();
    const id = ring.slice(0, ring.indexOf(':'));
    assert.match(id, /^k[0-9a-f]{6}$/);
    assert.equal(validateKeyRing(ring), null);
    ids.add(id);
  }
  assert.ok(ids.size > 1);
  assert.match(generateKeyRing('k1'), /^k1:/);
});

test('missing APP_ENCRYPTION_KEYS fails with the keygen hint', () => {
  const { errors } = resolveEnv(base({ APP_ENCRYPTION_KEYS: '' }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /keygen/);
  assert.match(errors[0], /not set/);
});

test('invalid APP_ENCRYPTION_KEYS fails with the keygen hint', () => {
  const { errors } = resolveEnv(base({ APP_ENCRYPTION_KEYS: 'k1:short' }));
  assert.match(errors[0], /invalid/);
  assert.match(errors[0], /keygen/);
});

test('APP_ENCRYPTION_KEYS_FILE works', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tix-k-'));
  const file = path.join(dir, 'k');
  writeFileSync(file, KEYS + '\n');
  const { errors, env } = resolveEnv(
    base({ APP_ENCRYPTION_KEYS: '', APP_ENCRYPTION_KEYS_FILE: file }),
  );
  assert.deepEqual(errors, []);
  assert.equal(env.APP_ENCRYPTION_KEYS, KEYS);
});

test('SESSION_SECRET: generated once, persisted 0600, reused', () => {
  const src = base();
  const first = resolveEnv(src);
  assert.deepEqual(first.errors, []);
  assert.ok(first.env.SESSION_SECRET.length >= 32);
  assert.match(first.notes.join('\n'), /generated SESSION_SECRET/);
  const file = path.join(src.TIX_SECRETS_DIR, 'session_secret');
  assert.equal(readFileSync(file, 'utf8').trim(), first.env.SESSION_SECRET);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const second = resolveEnv(src);
  assert.equal(second.env.SESSION_SECRET, first.env.SESSION_SECRET);
  assert.equal(
    second.notes.some((n) => /generated/.test(n)),
    false,
  );
});

test('SESSION_SECRET precedence: NAME > NAME_FILE > persisted', () => {
  const src = base();
  const dir = mkdtempSync(path.join(tmpdir(), 'tix-s-'));
  const file = path.join(dir, 's');
  writeFileSync(file, 'f'.repeat(40));
  assert.equal(
    resolveEnv({ ...src, SESSION_SECRET: 'e'.repeat(40), SESSION_SECRET_FILE: file }).env
      .SESSION_SECRET,
    'e'.repeat(40),
  );
  const viaFile = resolveEnv({ ...src, SESSION_SECRET_FILE: file });
  assert.equal(viaFile.env.SESSION_SECRET, 'f'.repeat(40));
  assert.equal(viaFile.env.SESSION_SECRET_FILE, undefined);
  assert.throws(
    () => readNameOrFile('X', { X_FILE: path.join(dir, 'missing') }),
    /X_FILE: cannot read/,
  );
});

test('a too short SESSION_SECRET is rejected', () => {
  assert.match(resolveEnv(base({ SESSION_SECRET: 'short' })).errors.join(), /at least 32/);
});

test('DATABASE_URL is built from POSTGRES_PASSWORD (url-encoded, defaults)', () => {
  const { env, errors } = resolveEnv(base());
  assert.deepEqual(errors, []);
  assert.equal(env.DATABASE_URL, 'postgres://tix:p%40ss%2Fw%3Ard%23%3F@postgres:5432/tix');
  const custom = resolveEnv(
    base({ DB_HOST: 'db.internal', DB_PORT: '6543', DB_USER: 'u s', DB_NAME: 'n' }),
  ).env;
  assert.equal(custom.DATABASE_URL, 'postgres://u%20s:p%40ss%2Fw%3Ard%23%3F@db.internal:6543/n');
  assert.equal(decodeURIComponent(new URL(env.DATABASE_URL).password), 'p@ss/w:rd#?');
});

test('explicit DATABASE_URL wins; neither -> error', () => {
  assert.equal(
    resolveEnv(base({ DATABASE_URL: 'postgres://a:b@c/d' })).env.DATABASE_URL,
    'postgres://a:b@c/d',
  );
  assert.match(
    resolveEnv(base({ POSTGRES_PASSWORD: '' })).errors.join(),
    /DATABASE_URL, or POSTGRES_PASSWORD/,
  );
  assert.match(resolveEnv(base({ DATABASE_URL: 'mysql://x' })).errors.join(), /postgres:\/\//);
});

test('defaults: redis, prefix, ports, pools, memory', () => {
  const { env, settings } = resolveEnv(base());
  assert.equal(env.REDIS_URL, 'redis://redis:6379/0');
  assert.equal(env.REDIS_KEY_PREFIX, 'tix');
  assert.equal(settings.publicPort, 8080);
  assert.equal(settings.webPool + settings.workerPool, 28);
  assert.deepEqual(settings.memory, { web: 768, worker: 1024, realtime: 256 });
  assert.equal(env.WORKER_SHUTDOWN_TIMEOUT_MS, '33000');
  assert.equal(env.MIGRATIONS_DIR, '/app/migrations');
});

test('knobs are overridable and validated', () => {
  const { settings, errors } = resolveEnv(
    base({ WEB_DATABASE_POOL_MAX: '30', WORKER_MAX_OLD_SPACE_MB: '2048', PORT: '9000' }),
  );
  assert.deepEqual(errors, []);
  assert.equal(settings.webPool, 30);
  assert.equal(settings.memory.worker, 2048);
  assert.equal(settings.publicPort, 9000);
  assert.match(
    resolveEnv(base({ WEB_DATABASE_POOL_MAX: 'lots' })).errors.join(),
    /WEB_DATABASE_POOL_MAX/,
  );
});

test('children get their own port/pool and never the public PORT', () => {
  const { env, settings } = resolveEnv(
    base({ PORT: '9000', HOSTNAME: 'abc123', DATABASE_POOL_MAX: '99' }),
  );
  const web = childEnv(env, settings, 'web');
  assert.equal(web.PORT, '3000');
  assert.equal(web.HOSTNAME, 'localhost');
  assert.equal(web.KEEP_ALIVE_TIMEOUT, '65000');
  assert.equal(web.DATABASE_POOL_MAX, '20');
  assert.equal(childEnv(env, settings, 'worker').DATABASE_POOL_MAX, '8');
  assert.equal(childEnv(env, settings, 'worker').PORT, undefined);
  assert.equal(childEnv(env, settings, 'realtime').REALTIME_PORT, '3001');
  assert.equal(childEnv(env, settings, 'migrate').DATABASE_POOL_MAX, '4');
});

test('APP_URL falls back to PUBLIC_URL, then localhost with a note', () => {
  assert.equal(
    resolveEnv(base({ PUBLIC_URL: 'https://shop.example' })).env.APP_URL,
    'https://shop.example',
  );
  const r = resolveEnv(base());
  assert.equal(r.env.APP_URL, 'http://localhost:8080');
  assert.match(r.notes.join(), /APP_URL is not set/);
  assert.match(resolveEnv(base({ APP_URL: 'nope' })).errors.join(), /APP_URL/);
});

test('TIX_ROLE', () => {
  assert.deepEqual(parseRoles(undefined).roles, ['web', 'worker', 'realtime']);
  assert.deepEqual(parseRoles('web, worker').roles, ['web', 'worker']);
  assert.match(parseRoles('web,db').errors[0], /unknown role/);
});

test('withVersionDefaults: TIX_COMPOSE_VERSION falls back to the image version, an explicit one wins', () => {
  const unset = withVersionDefaults({}, '1.2.3');
  assert.equal(unset.APP_VERSION, '1.2.3');
  assert.equal(unset.TIX_COMPOSE_VERSION, '1.2.3');
  const explicit = withVersionDefaults(
    { TIX_COMPOSE_VERSION: '1.0.0', APP_VERSION: '1.2.3' },
    '9.9.9',
  );
  assert.equal(explicit.APP_VERSION, '1.2.3');
  assert.equal(explicit.TIX_COMPOSE_VERSION, '1.0.0');
  // Development (no /app/VERSION): nothing is invented.
  assert.equal(withVersionDefaults({}, undefined).TIX_COMPOSE_VERSION, undefined);
});

test('TIX_ALLOW_FOREIGN_BACKUP_KEYS: off by default, 1/true on, passed to web and worker', () => {
  const off = resolveEnv(base());
  assert.equal(off.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS, '0');
  assert.equal(
    resolveEnv(base({ TIX_ALLOW_FOREIGN_BACKUP_KEYS: 'yes' })).env.TIX_ALLOW_FOREIGN_BACKUP_KEYS,
    '0',
  );
  for (const v of ['1', 'true', 'TRUE']) {
    const { env, settings } = resolveEnv(base({ TIX_ALLOW_FOREIGN_BACKUP_KEYS: v }));
    assert.equal(env.TIX_ALLOW_FOREIGN_BACKUP_KEYS, '1');
    for (const role of ['web', 'worker', 'migrate']) {
      assert.equal(childEnv(env, settings, role).TIX_ALLOW_FOREIGN_BACKUP_KEYS, '1');
    }
  }
});

test('one-off subcommands neither generate nor persist SESSION_SECRET', () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'tix-oneoff-')), 'not', 'writable');
  const src = base({ TIX_SECRETS_DIR: dir });
  const { env, errors } = resolveEnv(src, { oneOff: true });
  assert.deepEqual(errors, []);
  assert.equal(env.SESSION_SECRET, undefined);
  assert.equal(existsSync(dir), false);
});

test('writeSecretFileExclusive falls back to an exclusive create when link() is unsupported', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tix-link-'));
  const file = path.join(dir, 'secret');
  const failing = (code) => () => {
    throw Object.assign(new Error('nope'), { code });
  };
  for (const code of ['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS']) {
    writeSecretFileExclusive(file, 'x'.repeat(40), { link: failing(code) });
    assert.equal(readFileSync(file, 'utf8').trim(), 'x'.repeat(40));
    // never clobbers
    assert.throws(() => writeSecretFileExclusive(file, 'y'.repeat(40), { link: failing(code) }), {
      code: 'EEXIST',
    });
    assert.equal(readFileSync(file, 'utf8').trim(), 'x'.repeat(40));
    writeFileSync(file, '');
    // other errors still propagate
    assert.throws(
      () => writeSecretFileExclusive(path.join(dir, 'b'), 'z', { link: failing('EACCES') }),
      {
        code: 'EACCES',
      },
    );
    writeFileSync(file, '');
    unlinkSync(file);
  }
});
