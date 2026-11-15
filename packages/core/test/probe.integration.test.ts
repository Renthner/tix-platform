/**
 * Automatic probe restore against a real PostgreSQL (throwaway server) with the real pg_dump /
 * pg_restore / psql, real Redis and in-memory buckets. Opt-in: needs TIX_TEST_THROWAWAY=1,
 * TEST_DATABASE_URL, TEST_REDIS_URL and the PostgreSQL client tools; skipped otherwise.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { auditLogs, createDb, loadRootEnv, PgClient, type DbHandle } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { parseKeyRing } from '@tix/shared/server';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PG_BINARIES,
  S3Bucket,
  archiveKey,
  cleanupStaleTestDatabases,
  stackTag,
  testDatabasePattern,
  createBackup,
  createCoreContext,
  createProgress,
  findBackup,
  listCatalogue,
  readProbeHistory,
  runProbe,
  runProbeTick,
  saveSetting,
  setMaintenance,
  clearMaintenance,
  withDatabase,
  type BackupRuntime,
  type S3ObjectInfo,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const hasPgDump = spawnSync('pg_dump', ['--version']).status === 0;

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
  override async tryGetBytes(key: string) {
    return this.objects.get(key)?.body ?? null;
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
  override async checkAccess() {}
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

describe.skipIf(!adminUrl || !redisUrl || !hasPgDump)('probe restore (integration)', () => {
  const dbName = `tixpit_${randomBytes(4).toString('hex')}`;
  const ring = parseKeyRing(`k1:${randomBytes(32).toString('base64')}`);
  let admin: PgClient;
  let handle: DbHandle;
  let redis: Redis;
  let url: string;
  let rt: BackupRuntime;
  let backups: MemoryBucket;

  /** Throwaway databases of THIS stack (those of other stacks are not ours to judge). */
  const leftovers = async () =>
    (
      await admin.query(`SELECT datname FROM pg_database WHERE datname ~ $1`, [
        testDatabasePattern(stackTag(url, rt.ctx.keys.prefix)).source,
      ])
    ).rows;
  const FOREIGN = 'tix_probe_0badc0de_stale00';

  beforeAll(async () => {
    admin = new PgClient({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    url = withDatabase(adminUrl!, dbName);
    await runMigrations({
      connectionString: url,
      migrationsFolder: resolve(import.meta.dirname, '../../db/migrations'),
      log: () => undefined,
    });
    handle = createDb({ connectionString: url, poolMax: 3 });
    redis = new Redis(redisUrl!);
    backups = new MemoryBucket('backups');
    const ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      appUrl: 'https://shop.example.org',
    });
    rt = {
      ctx,
      buckets: { assets: new MemoryBucket('a'), documents: new MemoryBucket('d'), backups },
      keyRing: ring,
      databaseUrl: url,
      migrationsDir: resolve(import.meta.dirname, '../../db/migrations'),
      appVersion: 'test',
      pg: DEFAULT_PG_BINARIES,
      drainGraceMs: 0,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
  });

  afterAll(async () => {
    await handle?.close();
    if (redis) {
      const keys = await redis.keys(`${rt.ctx.keys.prefix}:*`);
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('does nothing without a backup', async () => {
    expect(await runProbe(rt, { trigger: 'MANUAL' })).toEqual({ ran: false, reason: 'NO_BACKUP' });
  });

  it('restores the newest backup into a throwaway database and records the result', async () => {
    const progress = createProgress(rt.ctx, 'BACKUP', null);
    await createBackup(rt, { kind: 'MANUAL', userId: null, progress });
    await progress.succeeded();
    // A leftover of a crashed run is cleaned up, the live database stays.
    const stale = `tix_probe_${stackTag(url, rt.ctx.keys.prefix)}_stale00`;
    await admin.query(`DROP DATABASE IF EXISTS "${stale}"`);
    await admin.query(`CREATE DATABASE "${stale}"`);
    // A leftover of ANOTHER stack on the same server must survive our cleanup.
    await admin.query(`DROP DATABASE IF EXISTS "${FOREIGN}"`);
    await admin.query(`CREATE DATABASE "${FOREIGN}"`);

    const outcome = await runProbe(rt, { trigger: 'MANUAL', userId: null });
    expect(outcome.ran).toBe(true);
    if (!outcome.ran) return;
    expect(outcome.entry.status).toBe('OK');
    expect(outcome.entry.counts).toMatchObject({ events: 0, orders: 0, tickets: 0 });
    expect(await leftovers()).toHaveLength(0);
    const foreign = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [FOREIGN]);
    expect(foreign.rows).toHaveLength(1);
    await admin.query(`DROP DATABASE IF EXISTS "${FOREIGN}"`);

    const [history] = await readProbeHistory(backups);
    expect(history?.id).toBe(outcome.entry.id);
    const [entry] = await listCatalogue(backups);
    expect(entry?.state.verify?.status).toBe('OK');
    const rows = await handle.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'backup.probe'));
    expect(rows[0]?.actorType).toBe('SYSTEM');
    // The live database is still there and untouched.
    const live = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    expect(live.rows).toHaveLength(1);
  });

  it('is skipped during maintenance and a running operation', async () => {
    await setMaintenance(rt.ctx, { reason: 'RESTORE', since: new Date().toISOString() });
    expect(await runProbe(rt, { trigger: 'MANUAL' })).toEqual({
      ran: false,
      reason: 'MAINTENANCE',
    });
    await clearMaintenance(rt.ctx);
    await redis.set(rt.ctx.keys.restoreRequest(), 'x', 'EX', 30);
    expect(await runProbe(rt, { trigger: 'MANUAL' })).toEqual({
      ran: false,
      reason: 'RESTORE_QUEUED',
    });
    await redis.del(rt.ctx.keys.restoreRequest());
    await redis.set(rt.ctx.keys.mutex('backup-operation'), 'other', 'PX', 30_000);
    expect(await runProbe(rt, { trigger: 'MANUAL' })).toEqual({ ran: false, reason: 'BUSY' });
    await redis.del(rt.ctx.keys.mutex('backup-operation'));
  });

  it('reports a damaged archive as failed and still drops the throwaway database', async () => {
    const [entry] = await listCatalogue(backups);
    const key = archiveKey(entry!.directory);
    const original = backups.objects.get(key)!;
    const tampered = Buffer.from(original.body);
    tampered[tampered.length - 100] = tampered[tampered.length - 100]! ^ 0xff;
    backups.objects.set(key, { ...original, body: tampered });
    const outcome = await runProbe(rt, { trigger: 'MANUAL' });
    expect(outcome.ran && outcome.entry.status).toBe('FAILED');
    expect(await leftovers()).toHaveLength(0);
    expect((await readProbeHistory(backups))[0]?.status).toBe('FAILED');
    expect((await findBackup(backups, entry!.manifest.id))?.state.verify?.status).toBe('FAILED');
    backups.objects.set(key, original);
  });

  it("worker start cleanup drops only this stack's leftovers under the operation lock", async () => {
    const tag = stackTag(url, rt.ctx.keys.prefix);
    const mine = `tix_verify_${tag}_crashed01`;
    await admin.query(`DROP DATABASE IF EXISTS "${mine}"`);
    await admin.query(`CREATE DATABASE "${mine}"`);
    await admin.query(`DROP DATABASE IF EXISTS "${FOREIGN}"`);
    await admin.query(`CREATE DATABASE "${FOREIGN}"`);
    expect(await cleanupStaleTestDatabases(rt)).toBe(1);
    expect(await leftovers()).toHaveLength(0);
    const foreign = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [FOREIGN]);
    expect(foreign.rows).toHaveLength(1);
    await admin.query(`DROP DATABASE IF EXISTS "${FOREIGN}"`);
  });

  it('the scheduled tick runs when due, not when disabled', async () => {
    await saveSetting(rt.ctx, 'backup', { probeEnabled: false }, null);
    expect(await runProbeTick(rt)).toEqual({ ran: false, reason: 'DISABLED' });
    await saveSetting(rt.ctx, 'backup', { probeEnabled: true }, null);
    // The last attempt failed more than the retry delay ago: due again.
    const later = new Date(Date.now() + 7 * 3_600_000);
    const outcome = await runProbeTick(rt, later);
    expect(outcome.ran).toBe(true);
    if (outcome.ran) expect(outcome.entry.trigger).toBe('SCHEDULED');
  });
});
