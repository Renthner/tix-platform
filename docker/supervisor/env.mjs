// Environment contract of the single `tix` image. Resolved ONCE by the supervisor; every child
// process (web, worker, realtime, migrate, seed, create-admin) receives the result.
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import {
  DB_CONNECTION_BUDGET,
  allocateWebPorts,
  budgetWebPool,
  detectHardware,
  parseWebProcesses,
  readCgroupMemoryLimit,
  resolveWebProcessCount,
  sizingWarnings,
  webPoolPerProcess,
} from './sizing.mjs';

export const ROLES = ['web', 'worker', 'realtime'];

/**
 * `k<6 hex>:<base64 of 32 random bytes>` - the format APP_ENCRYPTION_KEYS expects. The id is random
 * so that independently set-up systems rarely share an id (restoring a foreign backup rejects the
 * same id with a different key). Existing `k1` keys keep working.
 */
export function generateKeyRing(id = `k${randomBytes(3).toString('hex')}`) {
  return `${id}:${randomBytes(32).toString('base64')}`;
}

export const KEYGEN_HINT =
  'Generate one with:\n' +
  '    docker run --rm <your tix image> keygen\n' +
  '  (or: docker compose run --rm tix keygen)\n' +
  '  and put the printed line into your compose file / .env as APP_ENCRYPTION_KEYS.\n' +
  '  Keep it safe and unchanged: it encrypts the credentials stored in the database and your backups.\n' +
  '  Restoring a backup from another system needs the key ring that system used.';

/** Validates a key ring the same way the app does (`id:base64(32 bytes)[,...]`). */
export function validateKeyRing(spec) {
  const entries = String(spec)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return 'the key ring is empty';
  const ids = new Set();
  for (const entry of entries) {
    const sep = entry.indexOf(':');
    if (sep <= 0) return 'entries must look like "<id>:<base64>"';
    const id = entry.slice(0, sep);
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(id)) return `invalid key id "${id}"`;
    if (ids.has(id)) return 'duplicate key ids';
    ids.add(id);
    const b64 = entry.slice(sep + 1);
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) return `key "${id}" is not valid base64`;
    if (Buffer.from(b64, 'base64').length !== 32) {
      return `key "${id}" must decode to 32 bytes`;
    }
  }
  return null;
}

/** NAME, then NAME_FILE (file content trimmed). Throws on a configured but unreadable file. */
export function readNameOrFile(name, env, read = (p) => readFileSync(p, 'utf8')) {
  const direct = env[name];
  if (direct !== undefined && direct !== '') return direct;
  const file = env[`${name}_FILE`];
  if (file === undefined || file === '') return undefined;
  let content;
  try {
    content = read(file).trim();
  } catch (error) {
    throw new Error(`${name}_FILE: cannot read ${file} (${error.message})`);
  }
  if (content === '') throw new Error(`${name}_FILE: ${file} is empty`);
  return content;
}

const MIN_SECRET_LENGTH = 32;
const LOCK_STALE_MS = 15_000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function writeTemp(file, value) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, value + '\n');
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkQuiet(tmp);
    throw error;
  }
  closeSync(fd);
  chmodSync(tmp, 0o600);
  return tmp;
}

function unlinkQuiet(file) {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}

/**
 * Creates `file` with `value` atomically and without clobbering: the content is written to a
 * temporary file in the same directory, fsynced, then link()ed to the final name (fails with EEXIST
 * when another container won). A reader therefore never sees a partial/empty secret file.
 */
export function writeSecretFileExclusive(file, value, io = {}) {
  const link = io.link ?? linkSync;
  const tmp = writeTemp(file, value);
  try {
    try {
      link(tmp, file);
    } catch (error) {
      // Some volumes (CIFS/NFS/FUSE, certain overlay setups) do not support hard links: fall back
      // to an exclusive create (wx never clobbers). It is not atomic for readers, but those treat
      // an empty/short file as unusable and wait for / replace it under the lock (see below).
      if (!LINK_UNSUPPORTED.has(error.code)) throw error;
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeSync(fd, `${value}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  } finally {
    unlinkQuiet(tmp);
  }
}

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS']);

/** Replaces an unusable (empty/short) secret file atomically via rename. Caller holds the lock. */
function replaceSecretFile(file, value) {
  const tmp = writeTemp(file, value);
  try {
    renameSync(tmp, file);
  } catch (error) {
    unlinkQuiet(tmp);
    throw error;
  }
}

/**
 * NAME, then NAME_FILE, then the persisted file `<dir>/<lower name>`, else generate and persist it
 * (mode 0600, created atomically + exclusively so two containers sharing the volume agree on one
 * value). A persisted file that is empty or shorter than 32 characters (a crash with an older
 * version, a manual edit) is regenerated under a lock so concurrent starts still agree.
 */
export function resolveOrGenerateSecret(name, env, dir, generate, io = {}) {
  const read = io.read ?? ((p) => readFileSync(p, 'utf8'));
  const explicit = readNameOrFile(name, env, read);
  if (explicit !== undefined) return { value: explicit, source: 'env' };
  const file = path.join(dir, name.toLowerCase());
  const exists = io.exists ?? existsSync;
  const usable = (v) => v.length >= MIN_SECRET_LENGTH;
  const fail = (error) =>
    new Error(
      `cannot persist ${name} to ${file} (${error.message}). Mount a writable volume at /data or set ${name} explicitly.`,
    );
  if (exists(file)) {
    const stored = read(file).trim();
    if (usable(stored)) return { value: stored, source: 'file' };
  } else {
    const value = generate();
    (io.mkdir ?? ((d) => mkdirSync(d, { recursive: true, mode: 0o700 })))(dir);
    try {
      (io.writeExclusive ?? writeSecretFileExclusive)(file, value);
      return { value, source: 'generated', file };
    } catch (error) {
      if (error.code !== 'EEXIST') throw fail(error);
      // Lost a race: the winner's file is complete (link() is atomic) - unless it is a bad leftover.
      const stored = read(file).trim();
      if (usable(stored)) return { value: stored, source: 'file' };
    }
  }
  // The file exists but is empty/short: only one process at a time may replace it.
  const lock = `${file}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    let fd;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw fail(error);
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch {
        // vanished meanwhile
      }
      sleepSync(50);
      try {
        const stored = read(file).trim();
        if (usable(stored)) return { value: stored, source: 'file' };
      } catch {
        // not readable yet
      }
      if (Date.now() > deadline) throw fail(new Error('timed out waiting for the secret lock'));
      continue;
    }
    try {
      closeSync(fd);
      const stored = exists(file) ? read(file).trim() : '';
      if (usable(stored)) return { value: stored, source: 'file' };
      const value = generate();
      try {
        replaceSecretFile(file, value);
      } catch (error) {
        throw fail(error);
      }
      return { value, source: 'generated', file };
    } finally {
      unlinkQuiet(lock);
    }
  }
}

function intIn(env, name, fallback, min, max, errors) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
    return fallback;
  }
  return n;
}

export function parseRoles(spec) {
  const raw = String(spec ?? 'all')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((r) => r.toLowerCase());
  if (raw.length === 0 || raw.includes('all')) return { roles: [...ROLES], errors: [] };
  const bad = raw.filter((r) => !ROLES.includes(r));
  return {
    roles: ROLES.filter((r) => raw.includes(r)),
    errors: bad.length
      ? [`TIX_ROLE: unknown role(s) ${bad.join(', ')} (use all or a list of ${ROLES.join(', ')})`]
      : [],
  };
}

/**
 * Builds the effective environment. Pure apart from reading/writing the persisted secrets
 * (injectable for tests). `needsKeys` is false for subcommands that need no secrets.
 * @returns {{ env: object, errors: string[], notes: string[], settings: object }}
 */
export function resolveEnv(source, opts = {}) {
  const errors = [];
  const notes = [];
  const env = { ...source };
  const secretsDir = source.TIX_SECRETS_DIR || '/data/secrets';
  const read = opts.read;

  // ── APP_ENCRYPTION_KEYS: operator supplied, never generated ───────────────
  try {
    const keys = readNameOrFile('APP_ENCRYPTION_KEYS', source, read);
    if (keys === undefined) {
      errors.push(`APP_ENCRYPTION_KEYS is not set.\n  ${KEYGEN_HINT}`);
    } else {
      const problem = validateKeyRing(keys);
      if (problem) errors.push(`APP_ENCRYPTION_KEYS is invalid: ${problem}.\n  ${KEYGEN_HINT}`);
      else env.APP_ENCRYPTION_KEYS = keys;
    }
  } catch (error) {
    errors.push(error.message);
  }

  // ── SESSION_SECRET: env, file, persisted, generated ───────────────────────
  // One-off subcommands (migrate, seed, create-admin) never get it (see CHILD_DROPS): do not
  // generate/persist one and do not require a writable /data for them.
  if (!opts.oneOff) {
    try {
      const secret = resolveOrGenerateSecret(
        'SESSION_SECRET',
        source,
        secretsDir,
        () => randomBytes(48).toString('base64url'),
        opts.secretIo,
      );
      if (secret.value.length < 32) errors.push('SESSION_SECRET must be at least 32 characters.');
      env.SESSION_SECRET = secret.value;
      if (secret.source === 'generated')
        notes.push(`generated SESSION_SECRET and stored it in ${secret.file}`);
      // Children must not re-resolve (another file read or generation race): the value is final.
      delete env.SESSION_SECRET_FILE;
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (opts.oneOff) {
    delete env.SESSION_SECRET;
    delete env.SESSION_SECRET_FILE;
  }

  // Operator opt-in (default off): keys of another system when restoring a backup. Normalised so
  // web and worker always see the same value; the apps enforce it (packages/core backup).
  env.TIX_ALLOW_FOREIGN_BACKUP_KEYS = /^(1|true)$/i.test(
    String(source.TIX_ALLOW_FOREIGN_BACKUP_KEYS ?? '').trim(),
  )
    ? '1'
    : '0';

  // ── Database ──────────────────────────────────────────────────────────────
  if (!env.DATABASE_URL) {
    let password;
    try {
      password = readNameOrFile('POSTGRES_PASSWORD', source, read);
    } catch (error) {
      errors.push(error.message);
    }
    if (password === undefined) {
      if (!errors.some((e) => e.startsWith('POSTGRES_PASSWORD'))) {
        errors.push(
          'Set DATABASE_URL, or POSTGRES_PASSWORD (then DB_HOST=postgres, DB_PORT=5432, DB_USER=tix, DB_NAME=tix are the defaults).',
        );
      }
    } else {
      const host = source.DB_HOST || 'postgres';
      const port = source.DB_PORT || '5432';
      const user = source.DB_USER || 'tix';
      const name = source.DB_NAME || 'tix';
      const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
      env.DATABASE_URL = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${hostPart}:${port}/${encodeURIComponent(name)}`;
    }
  }
  if (env.DATABASE_URL && !/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) {
    errors.push('DATABASE_URL must be a postgres:// URL.');
  }

  // ── Redis / URLs / misc defaults ──────────────────────────────────────────
  env.REDIS_URL = source.REDIS_URL || 'redis://redis:6379/0';
  env.REDIS_KEY_PREFIX = source.REDIS_KEY_PREFIX || 'tix';
  env.NODE_ENV = source.NODE_ENV || 'production';
  if (!source.APP_URL) {
    if (source.PUBLIC_URL) env.APP_URL = source.PUBLIC_URL;
    else {
      env.APP_URL = 'http://localhost:8080';
      notes.push(
        'APP_URL is not set; using http://localhost:8080. Set APP_URL to the public address of your shop (used in e-mail links and the cross-site check).',
      );
    }
  }
  try {
    new URL(env.APP_URL);
  } catch {
    errors.push(`APP_URL is not a valid URL ("${env.APP_URL}").`);
  }

  // ── Ports and sizing ──────────────────────────────────────────────────────
  const publicPort = intIn(source, 'PORT', 8080, 1, 65535, errors);
  const webPort = intIn(source, 'TIX_WEB_PORT', 3000, 1, 65535, errors);
  const realtimePort = intIn(source, 'TIX_REALTIME_PORT', 3001, 1, 65535, errors);
  const workerHealthPort = intIn(source, 'WORKER_HEALTH_PORT', 8081, 1, 65535, errors);
  // Postgres budget: stock max_connections is 100. Web 20 + worker 8 (+ migrate/backup tools) stays
  // far below that and leaves room for admin tools and a few more instances.
  // Per web PROCESS. Not set: the budget of 20 is divided by TIX_WEB_PROCESSES (see sizing.mjs).
  const webPoolExplicit =
    source.WEB_DATABASE_POOL_MAX === undefined || source.WEB_DATABASE_POOL_MAX === ''
      ? undefined
      : intIn(source, 'WEB_DATABASE_POOL_MAX', 20, 1, 200, errors);
  const workerPool = intIn(source, 'WORKER_DATABASE_POOL_MAX', 8, 1, 100, errors);
  // Upper bound for all database connections of this container (see budgetWebPool).
  const dbBudget = intIn(
    source,
    'TIX_DB_CONNECTION_BUDGET',
    DB_CONNECTION_BUDGET,
    10,
    100_000,
    errors,
  );
  const memory = {
    web: intIn(source, 'WEB_MAX_OLD_SPACE_MB', 768, 64, 65536, errors),
    worker: intIn(source, 'WORKER_MAX_OLD_SPACE_MB', 1024, 64, 65536, errors),
    realtime: intIn(source, 'REALTIME_MAX_OLD_SPACE_MB', 256, 64, 65536, errors),
  };
  const proxyTimeoutMs = intIn(source, 'TIX_PROXY_TIMEOUT_MS', 900_000, 0, 86_400_000, errors);
  // Inactivity limit per client socket (resets on every byte, so big uploads still work).
  const socketTimeoutMs = intIn(
    source,
    'TIX_PROXY_SOCKET_TIMEOUT_MS',
    120_000,
    0,
    86_400_000,
    errors,
  );
  // Upper bound for receiving ONE request (headers + body); 1 h by default, 0 = unlimited.
  const requestTimeoutMs = intIn(
    source,
    'TIX_PROXY_REQUEST_TIMEOUT_MS',
    3_600_000,
    0,
    86_400_000,
    errors,
  );
  // Concurrent connections per (untrusted) client address; 0 = unlimited.
  const maxConnsPerIp = intIn(source, 'TIX_PROXY_MAX_CONNS_PER_IP', 200, 0, 1_000_000, errors);
  const drainMs = intIn(source, 'TIX_SHUTDOWN_TIMEOUT_MS', 35_000, 1_000, 600_000, errors);
  const { roles, errors: roleErrors } = parseRoles(source.TIX_ROLE);
  errors.push(...roleErrors);

  // ── Web processes: count, loopback ports, pool per process ───────────────
  const parsedProcesses = parseWebProcesses(source.TIX_WEB_PROCESSES);
  if (parsedProcesses.error) errors.push(parsedProcesses.error);
  const processes = resolveWebProcessCount(
    parsedProcesses.value,
    opts.hardware ?? detectHardware(opts.cgroupRead),
  );
  const allocation = allocateWebPorts(processes.n, webPort, [
    realtimePort,
    workerHealthPort,
    publicPort,
  ]);
  const hasWeb = roles.includes('web');
  // Port problems only matter when this container runs the web role.
  if (hasWeb) {
    if (allocation.error) errors.push(allocation.error);
    const taken = {
      PORT: publicPort,
      TIX_REALTIME_PORT: realtimePort,
      WORKER_HEALTH_PORT: workerHealthPort,
    };
    for (const [name, value] of Object.entries(taken)) {
      if (value === webPort) errors.push(`TIX_WEB_PORT (${webPort}) must differ from ${name}.`);
    }
  }
  const toolsPool = Number(source.DATABASE_POOL_MAX_TOOLS) || 4;
  const budget = budgetWebPool({
    hasWeb,
    hasWorker: roles.includes('worker'),
    processes: processes.n,
    webPool: webPoolPerProcess(processes.n, webPoolExplicit),
    workerPool,
    toolsPool,
    budget: dbBudget,
  });
  if (budget.error) errors.push(budget.error);
  const webPool = budget.webPool;
  const sizing = sizingWarnings({
    hasWeb: roles.includes('web'),
    hasWorker: roles.includes('worker'),
    processes: processes.n,
    webPool,
    workerPool,
    toolsPool,
    webHeapMb: memory.web,
    otherHeapMb:
      (roles.includes('worker') ? memory.worker : 0) +
      (roles.includes('realtime') ? memory.realtime : 0),
    memoryLimitBytes:
      opts.memoryLimitBytes !== undefined
        ? opts.memoryLimitBytes
        : readCgroupMemoryLimit(opts.cgroupRead),
  });

  // Worker shutdown must finish before the supervisor kills it.
  env.WORKER_SHUTDOWN_TIMEOUT_MS = String(
    source.WORKER_SHUTDOWN_TIMEOUT_MS || Math.max(1_000, drainMs - 2_000),
  );
  env.MIGRATIONS_DIR = source.MIGRATIONS_DIR || '/app/migrations';
  // The env block read by a child never contains the public port (the web server would bind to it).
  delete env.PORT;
  delete env.HOSTNAME;

  const settings = {
    roles,
    publicPort,
    webPort,
    webPorts: allocation.ports,
    webProcesses: processes.n,
    webProcessesReason: processes.reason,
    sizingWarnings: [...(budget.warning ? [budget.warning] : []), ...sizing.warnings],
    dbConnectionsTotal: sizing.total,
    realtimePort,
    workerHealthPort,
    webPool,
    workerPool,
    memory,
    drainMs,
    proxyTimeoutMs,
    socketTimeoutMs,
    requestTimeoutMs,
    maxConnsPerIp,
    allowedHosts: source.TIX_ALLOWED_HOSTS ?? '',
    trustedProxies: source.TRUSTED_PROXIES ?? '',
    migrate: !/^(0|false|no|off)$/i.test(source.TIX_MIGRATE ?? '1'),
  };
  return { env, errors, notes, settings };
}

/** Environment of one child process. */
export function childEnv(env, settings, role, index = 0) {
  const out = { ...env };
  // Least privilege: a child only gets the secrets it really reads (verified against the env
  // schemas of the apps). Everything is reachable through DATABASE_URL, so the raw password never is.
  for (const name of withFileVariants(['POSTGRES_PASSWORD'])) delete out[name];
  for (const name of withFileVariants(CHILD_DROPS[role] ?? [])) delete out[name];
  // TIX_* knobs of the supervisor are not for the children.
  delete out.TIX_ALLOWED_HOSTS;
  if (role === 'web') {
    out.PORT = String(settings.webPorts?.[index] ?? settings.webPort);
    out.HOSTNAME = 'localhost'; // 127.0.0.1 makes Next redirect `/` to itself (see proxy.mjs)
    // Longer than any idle timeout of the proxy's pooled connections (no sporadic ECONNRESET).
    out.KEEP_ALIVE_TIMEOUT = keepAliveFor(env);
    out.DATABASE_POOL_MAX = String(settings.webPool);
  } else if (role === 'realtime') {
    out.REALTIME_PORT = String(settings.realtimePort);
    out.REALTIME_HOST = '127.0.0.1'; // only the proxy talks to it
    delete out.DATABASE_POOL_MAX;
  } else if (role === 'worker') {
    out.WORKER_HEALTH_PORT = String(settings.workerHealthPort);
    out.WORKER_HEALTH_HOST = '127.0.0.1';
    out.DATABASE_POOL_MAX = String(settings.workerPool);
  } else {
    // migrate / seed / create-admin: one short-lived connection pool.
    out.DATABASE_POOL_MAX = out.DATABASE_POOL_MAX_TOOLS || '4';
  }
  return out;
}

const S3_SECRETS = ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
/**
 * Secrets a role does NOT need. realtime: only SESSION_SECRET + Redis (no database, no key ring, no
 * storage); migrate: pre-update backup needs key ring + database + storage but no session secret;
 * seed / create-admin: database only.
 */
const CHILD_DROPS = {
  realtime: ['APP_ENCRYPTION_KEYS', 'DATABASE_URL', ...S3_SECRETS],
  migrate: ['SESSION_SECRET'],
  seed: ['SESSION_SECRET', 'APP_ENCRYPTION_KEYS', ...S3_SECRETS],
  'create-admin': ['SESSION_SECRET', 'APP_ENCRYPTION_KEYS', ...S3_SECRETS],
};
const withFileVariants = (names) => names.flatMap((n) => [n, n + '_FILE']);

/** Variables that must never be echoed into logs. */
export const SECRET_NAMES = [
  'APP_ENCRYPTION_KEYS',
  'SESSION_SECRET',
  'DATABASE_URL',
  'POSTGRES_PASSWORD',
];

function keepAliveFor(env) {
  return env.KEEP_ALIVE_TIMEOUT || '65000';
}

/**
 * APP_VERSION (the image version, read from /app/VERSION by the caller) and TIX_COMPOSE_VERSION.
 * An unset compose version would mean "old docker-compose.yml without backup support" to the
 * pre-update backup policy and silently skip the safety net, so it defaults to the image version;
 * an explicit value (the release compose file sets its own) wins.
 */
export function withVersionDefaults(env, imageVersion) {
  const out = { ...env };
  if (!out.APP_VERSION && imageVersion) out.APP_VERSION = imageVersion;
  if (!out.TIX_COMPOSE_VERSION && out.APP_VERSION) out.TIX_COMPOSE_VERSION = out.APP_VERSION;
  return out;
}
