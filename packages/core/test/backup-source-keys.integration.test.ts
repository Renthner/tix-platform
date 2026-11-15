/**
 * Restoring a backup of ANOTHER system (different APP_ENCRYPTION_KEYS) against a real PostgreSQL
 * (throwaway database), real pg_dump / pg_restore, in-memory buckets + Redis.
 *
 * Opt-in: BACKUP_TEST_DATABASE_URL (SCRATCH server, e.g. postgres://postgres:x@127.0.0.1:25432/postgres).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDb, PgClient, type DbHandle } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createChannels, createKeyspace, type Redis } from '@tix/redis';
import {
  createReloadingSecretBox,
  createSecretBox,
  extraKeysPath,
  loadExtraKeys,
  loadKeyRing,
  parseKeyRing,
} from '@tix/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PG_BINARIES,
  S3Bucket,
  SourceKeysError,
  archiveKey,
  checkBackupKey,
  createBackup,
  createProgress,
  foreignBackupKeysAllowed,
  getSecretSetting,
  invalidateSettings,
  listCatalogue,
  restoreBackup,
  saveSecretSetting,
  stageSourceKeys,
  takeSourceKeys,
  validateRestore,
  withDatabase,
  withSourceKeys,
  type BackupRuntime,
  type CoreContext,
  type S3ObjectInfo,
} from '../src';

const ADMIN_URL = process.env.BACKUP_TEST_DATABASE_URL;
const hasPgDump = spawnSync('pg_dump', ['--version']).status === 0;
const run = ADMIN_URL && hasPgDump ? describe : describe.skip;

class MemoryBucket extends S3Bucket {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  constructor(name: string) {
    super({
      region: 'x',
      accessKeyId: 'x',
      secretAccessKey: 'x',
      forcePathStyle: true,
      bucket: name,
    });
  }
  override async *list(prefix: string): AsyncGenerator<S3ObjectInfo> {
    for (const [key, v] of [...this.objects].sort(([a], [b]) => a.localeCompare(b))) {
      if (key.startsWith(prefix)) yield { key, size: v.body.length, lastModified: new Date() };
    }
  }
  override async listDirectories(prefix: string): Promise<string[]> {
    const dirs = new Set<string>();
    for (const key of this.objects.keys()) {
      if (!key.startsWith(prefix)) continue;
      const slash = key.indexOf('/', prefix.length);
      if (slash >= 0) dirs.add(key.slice(0, slash + 1));
    }
    return [...dirs];
  }
  override async getStream(key: string) {
    const o = this.objects.get(key);
    if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    const body = o.body;
    return {
      stream: (async function* () {
        for (let i = 0; i < body.length; i += 100_000) yield body.subarray(i, i + 100_000);
      })(),
      size: body.length,
      contentType: o.contentType,
    };
  }
  override async getBytes(key: string) {
    const o = this.objects.get(key);
    if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    return o.body;
  }
  override async putBytes(key: string, body: Uint8Array | string, contentType: string) {
    this.objects.set(key, { body: Buffer.from(body), contentType });
  }
  override async putStream(key: string, source: AsyncIterable<Uint8Array>, contentType = 'x') {
    const parts: Buffer[] = [];
    for await (const p of source) parts.push(Buffer.from(p));
    const body = Buffer.concat(parts);
    this.objects.set(key, { body, contentType });
    return { sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  }
  override async checkAccess() {
    // always reachable
  }
  override async delete(key: string) {
    this.objects.delete(key);
  }
  override async deleteMany(keys: readonly string[]) {
    for (const k of keys) this.objects.delete(k);
  }
  override async deletePrefix(prefix: string) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix));
    keys.forEach((k) => this.objects.delete(k));
    return keys.length;
  }
}

function fakeRedis(): Redis {
  const store = new Map<string, string>();
  return {
    set: async (k: string, v: string) => (store.set(k, v), 'OK'),
    get: async (k: string) => store.get(k) ?? null,
    getdel: async (k: string) => {
      const v = store.get(k) ?? null;
      store.delete(k);
      return v;
    },
    del: async (...ks: string[]) => ks.filter((k) => store.delete(k)).length,
    expire: async () => 1,
    eval: async () => 1,
    scan: async (_cursor: string, _m: string, pattern: string) => {
      const re = new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
      );
      return ['0', [...store.keys()].filter((k) => re.test(k))];
    },
    _store: store,
  } as unknown as Redis;
}

const newKey = (id: string) => `${id}:${randomBytes(32).toString('base64')}`;

run('restoring a backup of another system (foreign encryption key)', () => {
  const dbName = `tix_fk_${randomBytes(4).toString('hex')}`;
  const migrationsDir = resolve(__dirname, '../../db/migrations');
  const specA = newKey('srcA'); // the SOURCE system
  const specB = newKey('curB'); // THIS system
  const ringA = parseKeyRing(specA);
  const ringB = parseKeyRing(specB);
  const keysDir = mkdtempSync(join(tmpdir(), 'tix-fk-'));
  const keysFile = join(keysDir, 'secrets', 'extra-encryption-keys');
  const savedEnv = process.env.TIX_EXTRA_KEYS_FILE;
  const savedAllow = process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS;
  let admin: PgClient;
  let handle: DbHandle;
  let url: string;
  let redis: Redis;
  let buckets: { assets: MemoryBucket; documents: MemoryBucket; backups: MemoryBucket };
  let ctx: CoreContext;
  let backupId: string;
  let directory: string;

  const query = async (text: string) => {
    const c = new PgClient({ connectionString: url });
    await c.connect();
    try {
      return await c.query(text);
    } finally {
      await c.end();
    }
  };
  const runtime = (spec: string, secrets = createSecretBox(parseKeyRing(spec))): BackupRuntime => ({
    ctx: { ...ctx, secrets } as CoreContext,
    buckets,
    get keyRing() {
      return loadKeyRing(spec);
    },
    databaseUrl: url,
    migrationsDir,
    appVersion: 'test',
    pg: DEFAULT_PG_BINARIES,
    drainGraceMs: 0,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const progress = (id: string | null = null) =>
    createProgress({ redis, keys: ctx.keys }, 'RESTORE', id);

  beforeAll(async () => {
    process.env.TIX_EXTRA_KEYS_FILE = keysFile;
    // Operator opt-in (default off): the feature under test.
    process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS = '1';
    admin = new PgClient({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    url = withDatabase(ADMIN_URL!, dbName);
    await runMigrations({
      connectionString: url,
      migrationsFolder: migrationsDir,
      log: () => undefined,
    });
    handle = createDb({ connectionString: url, poolMax: 3 });
    redis = fakeRedis();
    buckets = {
      assets: new MemoryBucket('assets'),
      documents: new MemoryBucket('documents'),
      backups: new MemoryBucket('backups'),
    };
    ctx = {
      db: handle.db,
      redis,
      keys: createKeyspace('t'),
      channels: createChannels('t'),
      publisher: { publish: async () => 1 },
    } as unknown as CoreContext;

    // SYSTEM A: stores a secret (external backup credentials) under ITS key and makes a backup.
    const a = runtime(specA);
    await saveSecretSetting(
      a.ctx as never,
      'backup.external.credentials',
      { accessKeyId: 'AKIA-SOURCE', secretAccessKey: 'source-secret' },
      null,
    );
    const made = await createBackup(a, { kind: 'MANUAL', userId: null, progress: progress() });
    backupId = made.manifest.id;
    directory = made.directory;
    // THIS system (B) later holds different live data.
    await query(`DELETE FROM system_settings WHERE key = 'backup.external.credentials'`);
  });

  afterAll(async () => {
    if (savedEnv === undefined) delete process.env.TIX_EXTRA_KEYS_FILE;
    else process.env.TIX_EXTRA_KEYS_FILE = savedEnv;
    if (savedAllow === undefined) delete process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS;
    else process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS = savedAllow;
    rmSync(keysDir, { recursive: true, force: true });
    await handle?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  it('without the source key the backup of the other system is rejected and nothing is stored', async () => {
    const b = runtime(specB);
    await expect(validateRestore(b, backupId)).rejects.toMatchObject({ code: 'KEY_UNKNOWN' });
    await expect(
      restoreBackup(b, { backupId, userId: null, progress: progress(backupId) }),
    ).rejects.toMatchObject({ code: 'KEY_UNKNOWN' });
    expect(existsSync(keysFile)).toBe(false);
  });

  it('the key check says match / unknown / mismatch without starting anything', async () => {
    const key = archiveKey(directory);
    expect(await checkBackupKey(buckets.backups, key, [...ringB, ...ringA])).toBe('MATCH');
    expect(await checkBackupKey(buckets.backups, key, ringB)).toBe('KEY_UNKNOWN');
    // Right id, wrong material.
    const impostor = parseKeyRing(newKey('srcA'));
    expect(await checkBackupKey(buckets.backups, key, [...ringB, ...impostor])).toBe('MISMATCH');
    expect(existsSync(keysFile)).toBe(false);
  });

  it('a wrong key (right id, other material) is rejected before anything is replaced or stored', async () => {
    const wrong = parseKeyRing(newKey('srcA'));
    const b = runtime(specB);
    await expect(
      restoreBackup(b, { backupId, userId: null, progress: progress(backupId), sourceKeys: wrong }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_INVALID' });
    expect(existsSync(keysFile)).toBe(false);
    expect((await query(`SELECT count(*) AS n FROM system_settings`)).rows[0].n).toBeDefined();
  });

  it('restores with the entered source key, persists it as additional key and keeps secrets readable', async () => {
    const b = runtime(specB);
    const result = await restoreBackup(b, {
      backupId,
      userId: null,
      progress: progress(backupId),
      sourceKeys: ringA,
    });
    expect(result.additionalKeyIds).toEqual(['srcA']);
    expect(loadExtraKeys(extraKeysPath()).map((k) => k.id)).toEqual(['srcA']);
    // The configured key still comes first (new data is encrypted with it).
    expect(loadKeyRing(specB).map((k) => k.id)).toEqual(['curB', 'srcA']);

    // "Restart": a fresh process builds its secret box from the env + the file.
    const afterRestart = createReloadingSecretBox(specB);
    invalidateSettings();
    const creds = await getSecretSetting(
      { db: handle.db, secrets: afterRestart } as never,
      'backup.external.credentials',
    );
    expect(creds).toEqual({ accessKeyId: 'AKIA-SOURCE', secretAccessKey: 'source-secret' });
    // New secrets use this system's own key.
    expect(afterRestart.encrypt('x', 'c').startsWith('v1.curB.')).toBe(true);
    // The safety backup made by the restore is encrypted with THIS system's key.
    const safety = (await listCatalogue(buckets.backups)).find(
      (e) => e.manifest.kind === 'PRE_RESTORE',
    );
    expect(safety).toBeDefined();
    expect(await checkBackupKey(buckets.backups, archiveKey(safety!.directory), ringB)).toBe(
      'MATCH',
    );
  });

  it('after the keys were persisted the same backup is readable without entering them again', async () => {
    const b = runtime(specB);
    await expect(validateRestore(b, backupId)).resolves.toBeDefined();
  });

  it('a source key whose id collides with this system but has other material is refused up front', async () => {
    const clash = newKey('curB');
    await expect(stageSourceKeys(ctxWithBox(specB), clash, ringB)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(stageSourceKeys(ctxWithBox(specB), 'garbage', ringB)).rejects.toMatchObject({
      code: 'INVALID',
    });
    await expect(stageSourceKeys(ctxWithBox(specB), '  ', ringB)).rejects.toBeInstanceOf(
      SourceKeysError,
    );
  });

  it('staged keys are encrypted at rest, single use and never appear in plain text', async () => {
    const c = ctxWithBox(specB);
    const token = await stageSourceKeys(c, `APP_ENCRYPTION_KEYS=${specA}`, ringB);
    const stored = [...(redis as unknown as { _store: Map<string, string> })._store.entries()].find(
      ([k]) => k.includes(token),
    );
    expect(stored).toBeDefined();
    expect(stored![1]).not.toContain(specA.split(':')[1]!);
    expect(stored![1].startsWith('v1.curB.')).toBe(true);
    const keys = await takeSourceKeys(c, token);
    expect(keys.map((k) => k.id)).toEqual(['srcA']);
    await expect(takeSourceKeys(c, token)).rejects.toMatchObject({ code: 'EXPIRED' });
    await expect(takeSourceKeys(c, 'short')).rejects.toMatchObject({ code: 'EXPIRED' });
  });

  it('with the operator switch off, staging, taking and restoring with foreign keys are refused', async () => {
    const c = ctxWithBox(specB);
    // A token staged while the switch was on must not be usable once it is off.
    const token = await stageSourceKeys(c, specA, ringB);
    const before = existsSync(keysFile) ? loadExtraKeys(extraKeysPath()).map((k) => k.id) : [];
    const was = process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS;
    try {
      for (const off of [undefined, '', '0', 'false', 'yes']) {
        if (off === undefined) delete process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS;
        else process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS = off;
        expect(foreignBackupKeysAllowed()).toBe(false);
        await expect(stageSourceKeys(c, specA, ringB)).rejects.toMatchObject({ code: 'DISABLED' });
        await expect(takeSourceKeys(c, token)).rejects.toMatchObject({ code: 'DISABLED' });
        await expect(
          restoreBackup(runtime(specB), {
            backupId,
            userId: null,
            progress: progress(backupId),
            sourceKeys: ringA,
          }),
        ).rejects.toMatchObject({ code: 'DISABLED' });
        expect(() => withSourceKeys(runtime(specB), ringA)).toThrow(SourceKeysError);
      }
      // No keys at all (a normal restore of an own backup) is unaffected.
      expect(withSourceKeys(runtime(specB), [])).toBeDefined();
      expect(existsSync(keysFile) ? loadExtraKeys(extraKeysPath()).map((k) => k.id) : []).toEqual(
        before,
      );
    } finally {
      process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS = was;
    }
    process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS = 'true';
    expect(foreignBackupKeysAllowed()).toBe(true);
    process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS = was;
  });

  function ctxWithBox(spec: string): CoreContext {
    return { ...ctx, secrets: createSecretBox(parseKeyRing(spec)) } as CoreContext;
  }
});
