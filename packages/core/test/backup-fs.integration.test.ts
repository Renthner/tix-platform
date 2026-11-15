/**
 * Backup / verify / restore / pre-update backup with the FILESYSTEM storage driver (real
 * PostgreSQL + pg_dump / pg_restore, files in a temporary storage directory). Counterpart of
 * backup.integration.test.ts, which uses in-memory buckets.
 *
 * Opt-in like that suite: BACKUP_TEST_DATABASE_URL = postgres:// URL of a SCRATCH server.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createDb, PgClient, type DbHandle } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createKeyspace, type Redis } from '@tix/redis';
import { parseKeyRing } from '@tix/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PG_BINARIES,
  archiveKey,
  createBackup,
  createBackupBuckets,
  createPreUpdateBackup,
  createProgress,
  listCatalogue,
  restoreBackup,
  verifyBackup,
  withDatabase,
  type BackupBuckets,
  type BackupRuntime,
  type CoreContext,
} from '../src';

const ADMIN_URL = process.env.BACKUP_TEST_DATABASE_URL;
const hasPgDump = spawnSync('pg_dump', ['--version']).status === 0;
const run = ADMIN_URL && hasPgDump ? describe : describe.skip;

function fakeRedis(): Redis {
  const store = new Map<string, string>();
  return {
    set: async (k: string, v: string) => (store.set(k, v), 'OK'),
    get: async (k: string) => store.get(k) ?? null,
    del: async (...ks: string[]) => ks.filter((k) => store.delete(k)).length,
    expire: async () => 1,
    eval: async () => 1,
    scan: async (_cursor: string, _m: string, pattern: string) => {
      const re = new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
      );
      return ['0', [...store.keys()].filter((k) => re.test(k))];
    },
  } as unknown as Redis;
}

async function bytesOf(bucket: BackupBuckets['assets'], key: string): Promise<Buffer> {
  return bucket.getBytes(key);
}

run('backup, verify and restore on the filesystem driver (real PostgreSQL)', () => {
  const dbName = `tix_bakfs_${randomBytes(4).toString('hex')}`;
  const ring = parseKeyRing(`k1:${randomBytes(32).toString('base64')}`);
  const storageDir = mkdtempSync(join(tmpdir(), 'tix-fsbackup-'));
  let admin: PgClient;
  let handle: DbHandle;
  let url: string;
  let rt: BackupRuntime;
  let buckets: BackupBuckets;
  let redis: Redis;

  const query = async (text: string, values?: unknown[]) => {
    const c = new PgClient({ connectionString: url });
    await c.connect();
    try {
      return await c.query(text, values);
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    admin = new PgClient({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    url = withDatabase(ADMIN_URL!, dbName);
    const migrationsDir = resolve(__dirname, '../../db/migrations');
    await runMigrations({
      connectionString: url,
      migrationsFolder: migrationsDir,
      log: () => undefined,
    });
    handle = createDb({ connectionString: url, poolMax: 3 });
    redis = fakeRedis();
    buckets = createBackupBuckets({ driver: 'fs', dir: storageDir });
    rt = {
      ctx: { db: handle.db, redis, keys: createKeyspace('t') } as unknown as CoreContext,
      buckets,
      keyRing: ring,
      databaseUrl: url,
      migrationsDir,
      appVersion: 'test',
      pg: DEFAULT_PG_BINARIES,
      drainGraceMs: 0,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    await query(`INSERT INTO number_sequences (scope, last_value) VALUES ('invoice:2026', 100)`);
    await query(
      `INSERT INTO system_settings (key, value) VALUES ('general', '{"shopName":"Original"}')`,
    );
    await buckets.assets.putBytes('media/logo.png', randomBytes(1_000), 'image/png');
    await buckets.documents.putBytes(
      'invoices/2026/a.pdf',
      randomBytes(300_000),
      'application/pdf',
    );
    await buckets.documents.putBytes('tickets/2026/b.pdf', randomBytes(10), 'application/pdf');
  });

  afterAll(async () => {
    await handle?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
    rmSync(storageDir, { recursive: true, force: true });
  });

  const progress = () => createProgress({ redis, keys: rt.ctx.keys }, 'BACKUP', null);

  it('creates an encrypted archive below <dir>/backups and lists it', async () => {
    const result = await createBackup(rt, { kind: 'MANUAL', userId: null, progress: progress() });
    expect(result.manifest.files?.documents.objects).toBe(2);
    expect(result.manifest.files?.assets.objects).toBe(1);
    const raw = readFileSync(join(storageDir, 'backups', archiveKey(result.directory))).toString(
      'latin1',
    );
    expect(raw).not.toContain('Original');
    expect(raw).not.toContain('invoices/2026/a.pdf');
    const catalogue = await listCatalogue(buckets.backups);
    expect(catalogue.map((e) => e.manifest.id)).toEqual([result.manifest.id]);
  });

  it('verifies the backup and detects a corrupted archive on disk', async () => {
    const [entry] = await listCatalogue(buckets.backups);
    expect(await verifyBackup(rt, entry!.manifest.id, progress())).toMatchObject({ status: 'OK' });
    const file = join(storageDir, 'backups', archiveKey(entry!.directory));
    const original = readFileSync(file);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 100] = tampered[tampered.length - 100]! ^ 0xff;
    writeFileSync(file, tampered);
    expect((await verifyBackup(rt, entry!.manifest.id, progress())).status).toBe('FAILED');
    writeFileSync(file, original);
    expect(await verifyBackup(rt, entry!.manifest.id, progress())).toMatchObject({ status: 'OK' });
  });

  it('restores database and files (content types kept, unknown files quarantined)', async () => {
    const [entry] = await listCatalogue(buckets.backups);
    const logo = await bytesOf(buckets.assets, 'media/logo.png');
    await query(
      `UPDATE system_settings SET value = '{"shopName":"Changed"}' WHERE key = 'general'`,
    );
    await buckets.assets.putBytes('media/extra.png', 'x', 'image/png');
    await buckets.documents.delete('tickets/2026/b.pdf');
    await buckets.documents.putBytes('invoices/2026/a.pdf', 'overwritten', 'text/plain');

    const result = await restoreBackup(rt, {
      backupId: entry!.manifest.id,
      userId: null,
      progress: createProgress({ redis, keys: rt.ctx.keys }, 'RESTORE', entry!.manifest.id),
    });
    expect(result.rowCountMismatches).toEqual([]);
    expect(result.filesQuarantined).toBe(1);
    const setting = await query(`SELECT value FROM system_settings WHERE key = 'general'`);
    expect(setting.rows[0].value.shopName).toBe('Original');
    expect((await bytesOf(buckets.assets, 'media/logo.png')).equals(logo)).toBe(true);
    expect((await bytesOf(buckets.documents, 'invoices/2026/a.pdf')).length).toBe(300_000);
    expect((await buckets.documents.getStream('invoices/2026/a.pdf')).contentType).toBe(
      'application/pdf',
    );
    expect((await bytesOf(buckets.documents, 'tickets/2026/b.pdf')).length).toBe(10);
    expect(await buckets.assets.tryGetBytes('media/extra.png')).toBeNull();
    const quarantined: string[] = [];
    for await (const o of buckets.backups.list('')) quarantined.push(o.key);
    expect(quarantined.some((k) => k.endsWith('/assets/media/extra.png'))).toBe(true);
  });

  it('takes a pre-update backup into the backups directory and prunes old ones', async () => {
    const params = {
      databaseUrl: url,
      migrationsDir: resolve(__dirname, '../../db/migrations'),
      appVersion: 'test',
      keyRing: ring,
      pg: DEFAULT_PG_BINARIES,
      bucket: buckets.backups,
      localDir: null,
      keep: 1,
      logger: { info: () => undefined, warn: () => undefined },
    };
    const first = await createPreUpdateBackup(params);
    expect(first.location).toBe('bucket');
    await new Promise((r) => setTimeout(r, 1_100)); // directory names carry a one-second timestamp
    const second = await createPreUpdateBackup(params);
    const pre = (await listCatalogue(buckets.backups)).filter(
      (e) => e.manifest.kind === 'PRE_UPDATE',
    );
    expect(pre.map((e) => e.manifest.id)).toEqual([second.id]);
    expect(pre[0]!.manifest.scope).toBe('DATABASE');
  });
});
