/**
 * Backup / verify / restore against a real PostgreSQL (throwaway database) with the real
 * pg_dump / pg_restore / psql binaries and in-memory buckets + Redis.
 *
 * Opt-in: set BACKUP_TEST_DATABASE_URL to a postgres:// URL of a SCRATCH server (database name
 * is ignored; a temporary database is created and dropped). Never point it at a shared stack.
 * Skipped cleanly when the variable is missing or pg_dump is not installed.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createDb, PgClient, type DbHandle } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createKeyspace, type Redis } from '@tix/redis';
import { parseKeyRing } from '@tix/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  S3Bucket,
  createBackup,
  anonymizeCustomer,
  backupDirectory,
  decryptStream,
  encryptStream,
  readArchive,
  writeArchive,
  countRestoreLoss,
  extractDump,
  getRestoreIncomplete,
  pgRestoreFromStream,
  createProgress,
  findBackup,
  getMaintenance,
  importUploadedBackup,
  incomingDirectory,
  listCatalogue,
  restoreBackup,
  validateRestore,
  verifyBackup,
  withDatabase,
  archiveKey,
  manifestKey,
  DEFAULT_PG_BINARIES,
  type BackupRuntime,
  type CoreContext,
  type S3ObjectInfo,
} from '../src';

const ADMIN_URL = process.env.BACKUP_TEST_DATABASE_URL;
const hasPgDump = spawnSync('pg_dump', ['--version']).status === 0;
const run = ADMIN_URL && hasPgDump ? describe : describe.skip;

async function collectAll(stream: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const c of stream) out.push(Buffer.from(c));
  return out;
}

/** In-memory S3 bucket (same interface as the real class). */
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
    const { createHash } = await import('node:crypto');
    const parts: Buffer[] = [];
    for await (const p of source) parts.push(Buffer.from(p));
    const body = Buffer.concat(parts);
    this.objects.set(key, { body, contentType });
    return { sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
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
  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.objects].map(([k, v]) => [k, v.body.toString('hex')]));
  }
}

/** The few Redis commands the backup module uses. */
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

run('backup, verify and restore (real PostgreSQL)', () => {
  const dbName = `tix_bak_${randomBytes(4).toString('hex')}`;
  const ring = parseKeyRing(`k1:${randomBytes(32).toString('base64')}`);
  let admin: PgClient;
  let handle: DbHandle;
  let url: string;
  let rt: BackupRuntime;
  let buckets: { assets: MemoryBucket; documents: MemoryBucket; backups: MemoryBucket };
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
  const progress = () => createProgress({ redis, keys: rt.ctx.keys }, 'BACKUP', null);

  beforeAll(async () => {
    admin = new PgClient({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    url = withDatabase(ADMIN_URL!, dbName);
    await runMigrations({
      connectionString: url,
      migrationsFolder: resolve(__dirname, '../../db/migrations'),
      log: () => undefined,
    });
    handle = createDb({ connectionString: url, poolMax: 3 });
    redis = fakeRedis();
    buckets = {
      assets: new MemoryBucket('assets'),
      documents: new MemoryBucket('documents'),
      backups: new MemoryBucket('backups'),
    };
    const keys = createKeyspace('t');
    rt = {
      ctx: { db: handle.db, redis, keys } as unknown as CoreContext,
      buckets,
      keyRing: ring,
      databaseUrl: url,
      migrationsDir: resolve(__dirname, '../../db/migrations'),
      appVersion: 'test',
      pg: DEFAULT_PG_BINARIES,
      drainGraceMs: 0,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    await query(
      `INSERT INTO number_sequences (scope, last_value) VALUES ('invoice:2026', 100), ('order:2026', 40)`,
    );
    await query(
      `INSERT INTO system_settings (key, value) VALUES ('general', '{"shopName":"Original"}')`,
    );
    await query(
      `INSERT INTO customers (id, email, first_name, last_name) VALUES ('11111111-1111-4111-8111-111111111111', 'jane@example.org', 'Jane', 'Doe')`,
    );
    buckets.assets.objects.set('logo.png', { body: randomBytes(1_000), contentType: 'image/png' });
    buckets.documents.objects.set('invoices/a.pdf', {
      body: randomBytes(300_000),
      contentType: 'application/pdf',
    });
    buckets.documents.objects.set('tickets/b/c.pdf', {
      body: randomBytes(10),
      contentType: 'application/pdf',
    });
  });

  afterAll(async () => {
    await handle?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  it('creates an encrypted archive with manifest, state and counts', async () => {
    const result = await createBackup(rt, { kind: 'MANUAL', userId: null, progress: progress() });
    const { manifest } = result;
    expect(manifest.rowCounts.number_sequences).toBe(2);
    expect(manifest.files?.documents.objects).toBe(2);
    expect(manifest.files?.assets.objects).toBe(1);
    expect(manifest.lastMigration.tag).toMatch(/^\d{4}_/);
    expect(manifest.archive?.sha256).toHaveLength(64);
    // Ciphertext only: neither the setting value nor a file's name appear in the archive.
    const raw = buckets.backups.objects.get(archiveKey(result.directory))!.body.toString('latin1');
    expect(raw).not.toContain('Original');
    expect(raw).not.toContain('invoices/a.pdf');
    expect((await listCatalogue(buckets.backups)).map((e) => e.manifest.id)).toContain(manifest.id);
  });

  it('verifies a good backup in a temporary database and detects tampering', async () => {
    const [entry] = await listCatalogue(buckets.backups);
    const ok = await verifyBackup(rt, entry!.manifest.id, progress());
    expect(ok).toMatchObject({ status: 'OK' });
    // The temporary database is gone again.
    const left = await admin.query(
      `SELECT datname FROM pg_database WHERE datname LIKE 'tix_verify_%'`,
    );
    expect(left.rows).toHaveLength(0);

    const key = archiveKey(entry!.directory);
    const original = buckets.backups.objects.get(key)!;
    const tampered = Buffer.from(original.body);
    tampered[tampered.length - 100] = tampered[tampered.length - 100]! ^ 0xff;
    buckets.backups.objects.set(key, { ...original, body: tampered });
    const bad = await verifyBackup(rt, entry!.manifest.id, progress());
    expect(bad.status).toBe('FAILED');
    expect((await findBackup(buckets.backups, entry!.manifest.id))?.state.verify?.status).toBe(
      'FAILED',
    );
    buckets.backups.objects.set(key, original);
    await verifyBackup(rt, entry!.manifest.id, progress());
    expect((await findBackup(buckets.backups, entry!.manifest.id))?.state.verify?.status).toBe(
      'OK',
    );
  });

  it('rejects restores of backups from newer code and with an unknown key', async () => {
    const [entry] = await listCatalogue(buckets.backups);
    // The decision uses the AUTHENTICATED manifest inside the archive: a code base whose newest
    // migration is older than the backup's must reject it (the sidecar is not trusted).
    const olderCode = mkdtempSync(join(tmpdir(), 'tix-journal-'));
    mkdirSync(join(olderCode, 'meta'));
    writeFileSync(
      join(olderCode, 'meta', '_journal.json'),
      JSON.stringify({ entries: [{ idx: 0, when: 1, tag: '0000_old' }] }),
    );
    await expect(
      validateRestore({ ...rt, migrationsDir: olderCode }, entry!.manifest.id),
    ).rejects.toMatchObject({ code: 'MIGRATION_NEWER' });
    rmSync(olderCode, { recursive: true, force: true });

    // Editing the unencrypted sidecar changes nothing about what is checked.
    const key = manifestKey(entry!.directory);
    const original = buckets.backups.objects.get(key)!;
    const forged = JSON.parse(original.body.toString('utf8'));
    forged.lastMigration.when = 1;
    buckets.backups.objects.set(key, { ...original, body: Buffer.from(JSON.stringify(forged)) });
    await expect(validateRestore(rt, entry!.manifest.id)).resolves.toBeDefined();
    buckets.backups.objects.set(key, original);

    const foreign = parseKeyRing(`other:${randomBytes(32).toString('base64')}`);
    await expect(
      validateRestore({ ...rt, keyRing: foreign }, entry!.manifest.id),
    ).rejects.toMatchObject({
      code: 'KEY_UNKNOWN',
    });
  });

  it('a failing restore never commits: truncated dump and failing SQL leave the live database intact', async () => {
    const [entry] = await listCatalogue(buckets.backups);
    await query('CREATE TABLE IF NOT EXISTS survivor (id int)');
    const source = await buckets.backups.getStream(archiveKey(entry!.directory));
    const parts: Buffer[] = [];
    for await (const chunk of extractDump(source.stream, ring)) parts.push(chunk);
    const dump = Buffer.concat(parts);
    async function* slice(buf: Buffer) {
      for (let i = 0; i < buf.length; i += 50_000) yield buf.subarray(i, i + 50_000);
    }
    const intact = async () => {
      const t = await query("SELECT to_regclass('public.survivor') AS t");
      const s = await query("SELECT value FROM system_settings WHERE key = 'general'");
      return t.rows[0].t !== null && s.rows[0].value.shopName === 'Original';
    };

    // 1. pg_restore fails (dump cut off) after it already emitted SQL.
    await expect(
      pgRestoreFromStream(
        DEFAULT_PG_BINARIES,
        url,
        slice(dump.subarray(0, Math.floor(dump.length * 0.6))),
        {
          applicationName: 'tix-test-restore',
        },
      ),
    ).rejects.toMatchObject({ name: 'PgRestoreError', commitSent: false });
    expect(await intact()).toBe(true);

    // 2. The carry-forward SQL fails: psql stops, beforeCommit is never reached, nothing commits.
    let marked = false;
    await expect(
      pgRestoreFromStream(DEFAULT_PG_BINARIES, url, slice(dump), {
        applicationName: 'tix-test-restore',
        carryForward: 'SELECT 1/0;',
        beforeCommit: async () => {
          marked = true;
        },
      }),
    ).rejects.toMatchObject({ name: 'PgRestoreError', commitSent: false });
    expect(marked).toBe(false);
    expect(await intact()).toBe(true);
  });

  it('restores database and files, removes newer schema objects and keeps number counters', async () => {
    const [entry] = await listCatalogue(buckets.backups);
    // Changes after the backup that the restore must undo / carry forward.
    await query(`CREATE TABLE only_in_live (id int)`);
    await query(
      `UPDATE system_settings SET value = '{"shopName":"Changed"}' WHERE key = 'general'`,
    );
    await query(`UPDATE number_sequences SET last_value = 150 WHERE scope = 'invoice:2026'`);
    await query(`INSERT INTO number_sequences (scope, last_value) VALUES ('credit:2026', 7)`);
    await query("SELECT setval('ticket_sync_version_seq', 500)");
    // GDPR: a customer erased after the backup must stay erased after the restore (ledger replay).
    await anonymizeCustomer(rt.ctx, null, '11111111-1111-4111-8111-111111111111', { replay: true });
    buckets.assets.objects.set('extra.png', { body: Buffer.from('x'), contentType: 'image/png' });
    buckets.documents.objects.delete('tickets/b/c.pdf');
    buckets.documents.objects.set('invoices/a.pdf', {
      body: Buffer.from('overwritten'),
      contentType: 'application/pdf',
    });
    const expectedAssets = {
      'logo.png': buckets.assets.objects.get('logo.png')!.body.toString('hex'),
    };

    // The restore dialog's loss counts must work on the real schema (all four tables have created_at).
    const loss = await countRestoreLoss(rt.ctx, entry!.manifest.createdAt);
    expect(loss).toEqual({
      orders: 0,
      invoices: 0,
      payments: 0,
      refunds: 0,
      updated: { orders: 0, payments: 0, refunds: 0 },
    });

    const result = await restoreBackup(rt, {
      backupId: entry!.manifest.id,
      userId: null,
      progress: createProgress({ redis, keys: rt.ctx.keys }, 'RESTORE', entry!.manifest.id),
    });

    expect(result.rowCountMismatches).toEqual([]);
    expect(result.erasuresReplayed).toBe(1);
    const customer = await query(
      "SELECT email, first_name, anonymized_at FROM customers WHERE id = '11111111-1111-4111-8111-111111111111'",
    );
    expect(customer.rows[0].anonymized_at).not.toBeNull();
    expect(customer.rows[0].first_name).toBe('');
    expect(customer.rows[0].email).not.toContain('jane@');
    // Public sequences never move backwards either (inside the restore transaction).
    const seq = await query(
      "SELECT last_value FROM pg_sequences WHERE sequencename = 'ticket_sync_version_seq'",
    );
    expect(Number(seq.rows[0].last_value)).toBeGreaterThanOrEqual(500);
    expect(await getRestoreIncomplete(rt.ctx)).toBeNull();
    // Files that were not part of the backup are quarantined, not deleted.
    expect(result.filesQuarantined).toBe(1);
    expect([...buckets.backups.objects.keys()].some((k) => k.endsWith('/assets/extra.png'))).toBe(
      true,
    );
    const tables = await query(`SELECT to_regclass('public.only_in_live') AS t`);
    expect(tables.rows[0].t).toBeNull();
    const setting = await query(`SELECT value FROM system_settings WHERE key = 'general'`);
    expect(setting.rows[0].value.shopName).toBe('Original');
    const sequences = await query(`SELECT scope, last_value FROM number_sequences ORDER BY scope`);
    expect(Object.fromEntries(sequences.rows.map((r) => [r.scope, Number(r.last_value)]))).toEqual({
      'credit:2026': 7,
      'invoice:2026': 150,
      'order:2026': 40,
    });
    expect(buckets.assets.snapshot()).toEqual(expectedAssets);
    expect([...buckets.documents.objects.keys()].sort()).toEqual([
      'invoices/a.pdf',
      'tickets/b/c.pdf',
    ]);
    expect(buckets.documents.objects.get('invoices/a.pdf')!.body.length).toBe(300_000);
    expect(await getMaintenance(rt.ctx)).toBeNull();
    // A safety backup was taken first.
    const safety = (await listCatalogue(buckets.backups)).filter(
      (e) => e.manifest.kind === 'PRE_RESTORE',
    );
    expect(safety).toHaveLength(1);
    expect(safety[0]!.manifest.id).toBe(result.safetyBackupId);
    // Audit entry written into the restored database.
    const audit = await query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'backup.restore'`,
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('imports an uploaded archive into the catalogue and rejects garbage', async () => {
    const [entry] = await listCatalogue(buckets.backups);
    const uploadId = randomUUID();
    const body = buckets.backups.objects.get(archiveKey(entry!.directory))!;
    buckets.backups.objects.set(archiveKey(incomingDirectory(uploadId)), body);
    const imported = await importUploadedBackup(rt, uploadId, null);
    expect(imported.id).toBe(uploadId);
    expect(imported.originalId).toBe(entry!.manifest.id);
    expect(imported.kind).toBe('MANUAL');

    const badId = randomUUID();
    buckets.backups.objects.set(archiveKey(incomingDirectory(badId)), {
      body: Buffer.from('not a backup at all'),
      contentType: 'x',
    });
    await expect(importUploadedBackup(rt, badId, null)).rejects.toBeInstanceOf(Error);
    expect([...buckets.backups.objects.keys()].some((k) => k.includes(badId))).toBe(false);
  });

  it('a failed retry (rollback before COMMIT) keeps the marker of an earlier failed restore', async () => {
    const [entry] = (await listCatalogue(buckets.backups)).filter(
      (e) => e.manifest.kind !== 'PRE_RESTORE',
    );
    const migrations = resolve(__dirname, '../../db/migrations');

    // Run 1: the database is replaced, then the forward migration fails (journal without SQL files).
    const broken = mkdtempSync(join(tmpdir(), 'tix-mig-'));
    mkdirSync(join(broken, 'meta'));
    writeFileSync(
      join(broken, 'meta', '_journal.json'),
      readFileSync(join(migrations, 'meta', '_journal.json')),
    );
    const progress = createProgress({ redis, keys: rt.ctx.keys }, 'RESTORE', entry!.manifest.id);
    await expect(
      restoreBackup(
        { ...rt, migrationsDir: broken },
        { backupId: entry!.manifest.id, userId: null, progress },
      ),
    ).rejects.toBeInstanceOf(Error);
    rmSync(broken, { recursive: true, force: true });
    const marker = await getRestoreIncomplete(rt.ctx);
    expect(marker).not.toBeNull();
    expect(marker!.backupId).toBe(entry!.manifest.id);

    // Run 2: an authenticated archive whose dump is cut off fails BEFORE the commit.
    const source = await buckets.backups.getStream(archiveKey(entry!.directory));
    const cut = async function* () {
      for await (const e of readArchive(decryptStream(source.stream, ring))) {
        const data: Buffer[] = [];
        for await (const c of e.data) data.push(c);
        let body = Buffer.concat(data);
        if (e.header.name === 'db.dump') body = body.subarray(0, Math.floor(body.length * 0.6));
        yield {
          header: e.header,
          data: (async function* () {
            yield body;
          })(),
        };
      }
    };
    const archive = Buffer.concat(await collectAll(encryptStream(writeArchive(cut()), ring[0]!)));
    const sha256 = createHash('sha256').update(archive).digest('hex');
    const badId = randomUUID();
    const badManifest = {
      ...entry!.manifest,
      id: badId,
      originalId: entry!.manifest.originalId ?? entry!.manifest.id,
      archive: { sizeBytes: archive.length, sha256 },
    };
    const dir = backupDirectory(badManifest);
    buckets.backups.objects.set(archiveKey(dir), { body: archive, contentType: 'x' });
    buckets.backups.objects.set(manifestKey(dir), {
      body: Buffer.from(JSON.stringify(badManifest)),
      contentType: 'application/json',
    });
    await expect(
      restoreBackup(rt, { backupId: badId, userId: null, progress }),
    ).rejects.toMatchObject({ name: 'PgRestoreError', commitSent: false });
    // The marker of run 1 must still be there: the shop is still half restored.
    expect(await getRestoreIncomplete(rt.ctx)).not.toBeNull();

    // Run 3 (good backup, good migrations) finishes the job and clears the marker.
    await restoreBackup(rt, { backupId: entry!.manifest.id, userId: null, progress });
    expect(await getRestoreIncomplete(rt.ctx)).toBeNull();
  });
});
