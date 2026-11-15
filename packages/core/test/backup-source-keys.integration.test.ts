/**
 * Restoring a backup of ANOTHER system (different APP_ENCRYPTION_KEYS) against a real PostgreSQL
 * (throwaway database), real pg_dump / pg_restore, in-memory buckets + fake Redis, and the
 * re-encryption of every registered secret afterwards.
 *
 * Both systems deliberately use the SAME key id (`k1`) with different material: the normal case for
 * two installations created from the same example `.env`.
 *
 * Opt-in: BACKUP_TEST_DATABASE_URL (SCRATCH server, e.g. postgres://postgres:x@127.0.0.1:25432/postgres).
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDb, events, PgClient, seatMaps, taxRates, venues, type DbHandle } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createChannels, createKeyspace, type Redis } from '@tix/redis';
import {
  createReloadingSecretBox,
  createSecretBox,
  extraKeysPath,
  keyFingerprint,
  keyLabel,
  loadExtraKeys,
  loadKeyRing,
  parseKeyRing,
} from '@tix/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PG_BINARIES,
  ENCRYPT_CALL_SITES,
  S3Bucket,
  SECRET_COLUMNS,
  SourceKeysError,
  archiveKey,
  checkBackupKey,
  connectionSecretContext,
  createBackup,
  createPreUpdateBackup,
  countBackupsUsingKeys,
  createProgress,
  ensureEventLanSecret,
  ensureEventSigningKey,
  foreignBackupKeysAllowed,
  getSecretSetting,
  getSecretsUnreadable,
  importUploadedBackup,
  incomingDirectory,
  invalidateSettings,
  listCatalogue,
  reEncryptSecrets,
  restoreBackup,
  runReEncryptSecrets,
  saveSecretSetting,
  secretKeysMissingFrom,
  stageSourceKeys,
  takeSourceKeys,
  TOTP_SECRET_CONTEXT,
  validateRestore,
  verifyBackup,
  withDatabase,
  withSourceKeys,
  type BackupRuntime,
  type CoreContext,
  type S3ObjectInfo,
  type SecretColumn,
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
const ENVELOPE = String.raw`v1\.[A-Za-z0-9_-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+`;

run('restoring a backup of another system (foreign encryption key, same key id)', () => {
  const dbName = `tix_fk_${randomBytes(4).toString('hex')}`;
  const migrationsDir = resolve(__dirname, '../../db/migrations');
  // Both systems use the id "k1" with different material.
  const specA = newKey('k1'); // the SOURCE system
  const specB = newKey('k1'); // THIS system
  const ringA = parseKeyRing(specA);
  const ringB = parseKeyRing(specB);
  const boxA = createSecretBox(ringA);
  const primaryB = createSecretBox(ringB);
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
  let eventId: string;
  const adminUserId = randomUUID();
  const connectionId = randomUUID();
  const emailId = randomUUID();

  const query = async (text: string, values: unknown[] = []) => {
    const c = new PgClient({ connectionString: url });
    await c.connect();
    try {
      return await c.query(text, values);
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
    // Like the worker: archives open with the configured keys (+ additional ones only on opt-in).
    get archiveKeyRing() {
      return foreignBackupKeysAllowed() ? loadKeyRing(spec) : parseKeyRing(spec);
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
  const ctxWith = (box = boxA): CoreContext => ({ ...ctx, secrets: box }) as CoreContext;

  /** Reads every registered secret from the live database and opens it with `box`. */
  async function openAll(box: { decrypt(envelope: string, context: string): string }) {
    const result = new Map<string, { opened: number; failed: number }>();
    for (const c of SECRET_COLUMNS) {
      const value = c.jsonKey ? `"${c.column}"->>'${c.jsonKey}'` : `"${c.column}"`;
      const filter = c.jsonKey
        ? `jsonb_typeof("${c.column}"->'${c.jsonKey}') = 'string'`
        : `"${c.column}" IS NOT NULL`;
      const rows = (
        await query(
          `SELECT ${c.primaryKey.map((k) => `"${k}"::text AS "${k}"`).join(', ')}, ${value} AS v FROM "${c.table}" WHERE ${filter}`,
        )
      ).rows as Record<string, string>[];
      const entry = { opened: 0, failed: 0 };
      for (const row of rows) {
        try {
          box.decrypt(row.v!, c.context(c.primaryKey.map((k) => row[k]!)));
          entry.opened += 1;
        } catch {
          entry.failed += 1;
        }
      }
      result.set(c.id, entry);
    }
    return result;
  }
  const expectAll = (
    map: Map<string, { opened: number; failed: number }>,
    expected: 'opened' | 'failed',
  ) => {
    for (const c of SECRET_COLUMNS) {
      const entry = map.get(c.id)!;
      expect(entry.opened + entry.failed, `${c.id} has a fixture row`).toBeGreaterThan(0);
      if (expected === 'opened') expect(entry.failed, `${c.id} fully readable`).toBe(0);
      else expect(entry.opened, `${c.id} not readable`).toBe(0);
    }
  };

  /** One row for EVERY registry entry, encrypted by system A. */
  async function seedFixtures() {
    const a = ctxWith(boxA);
    await saveSecretSetting(
      a as never,
      'backup.external.credentials',
      { accessKeyId: 'AKIA-SOURCE', secretAccessKey: 'source-secret' },
      null,
    );
    await query(
      `INSERT INTO bank_accounts (name, account_holder, iban, currency) VALUES ('Main', 'Club', 'DE02120300000000202051', 'EUR')`,
    );
    const account = (await query(`SELECT id FROM bank_accounts LIMIT 1`)).rows[0].id as string;
    await query(
      `INSERT INTO bank_connections (id, bank_account_id, adapter, name, config, credentials_encrypted)
       VALUES ($1, $2, 'FINTS', 'Test', '{}'::jsonb, $3)`,
      [
        connectionId,
        account,
        boxA.encryptJson({ pin: '4711' }, connectionSecretContext(connectionId)),
      ],
    );
    const [venue] = await handle.db
      .insert(venues)
      .values({ name: 'Hall', slug: `hall-${randomUUID().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning();
    const [map] = await handle.db
      .insert(seatMaps)
      .values({
        venueId: venue!.id,
        kind: 'EVENT',
        name: 'Hall',
        canvasWidth: 100,
        canvasHeight: 100,
      })
      .returning();
    const [rate] = await handle.db
      .insert(taxRates)
      .values({ name: `vat-${randomUUID().slice(0, 6)}`, rateBasisPoints: 1900 })
      .returning();
    const [ev] = await handle.db
      .insert(events)
      .values({
        venueId: venue!.id,
        seatMapId: map!.id,
        slug: `ev-${randomUUID().slice(0, 8)}`,
        title: 'Show',
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: rate!.id,
      })
      .returning();
    eventId = ev!.id;
    await ensureEventSigningKey(a, eventId); // event_signing_keys.private_key_encrypted
    await ensureEventLanSecret(a, eventId); // event_scanner_secrets.lan_secret_encrypted
    await query(
      `INSERT INTO admin_users (id, email, display_name, roles, totp_secret_encrypted, totp_pending_secret_encrypted)
       VALUES ($1, 'root@example.test', 'Root', ARRAY['SUPER_ADMIN']::admin_role[], $2, $3)`,
      [
        adminUserId,
        boxA.encrypt('JBSWY3DPEHPK3PXP', TOTP_SECRET_CONTEXT(adminUserId)),
        boxA.encrypt('KRSXG5CTMVRXEZLU', TOTP_SECRET_CONTEXT(adminUserId)),
      ],
    );
    await query(
      `INSERT INTO email_messages (id, to_email, subject, attachments) VALUES ($1, 'a@example.test', 'x', $2::jsonb)`,
      [
        emailId,
        JSON.stringify({
          v: 1,
          attachments: [],
          locale: 'en',
          eventId: null,
          customerId: null,
          variables: boxA.encryptJson({ firstName: 'Ada' }, 'email-message:variables'),
        }),
      ],
    );
  }

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

    // SYSTEM A: stores secrets of every kind under ITS key and makes a backup.
    await seedFixtures();
    const made = await createBackup(runtime(specA), {
      kind: 'MANUAL',
      userId: null,
      progress: progress(),
    });
    backupId = made.manifest.id;
    directory = made.directory;
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

  it('every envelope-shaped value in the live schema is covered by the registry', async () => {
    const registered = new Set(SECRET_COLUMNS.map((c) => `${c.table}.${c.column}`));
    const columns = (
      await query(`
        SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb')
      `)
    ).rows as { table_name: string; column_name: string; data_type: string }[];
    const hits: string[] = [];
    for (const col of columns) {
      const expr =
        col.data_type === 'jsonb' ? `"${col.column_name}"::text` : `"${col.column_name}"`;
      const res = await query(`SELECT 1 FROM "${col.table_name}" WHERE ${expr} ~ $1 LIMIT 1`, [
        ENVELOPE,
      ]);
      if (res.rowCount) hits.push(`${col.table_name}.${col.column_name}`);
    }
    // All registered columns have a fixture, and nothing else holds an envelope.
    expect([...hits].sort()).toEqual([...registered].sort());
    // Every call site is claimed by registry entries that exist.
    for (const ids of Object.values(ENCRYPT_CALL_SITES)) {
      for (const id of ids) expect(SECRET_COLUMNS.map((c) => c.id)).toContain(id);
    }
  });

  it('live data of this system differs from the backup (so a restore is observable)', async () => {
    await query(`DELETE FROM email_messages`);
    await query(`DELETE FROM bank_connections`);
    await query(`DELETE FROM system_settings WHERE encrypted_value IS NOT NULL`);
    await query(`DELETE FROM admin_users`);
    await query(`DELETE FROM events`); // cascades signing keys and LAN secret
    expect((await query(`SELECT count(*)::int AS n FROM event_signing_keys`)).rows[0].n).toBe(0);
  });

  it('without the source key the backup is rejected (same key id, other material) and nothing is stored', async () => {
    const b = runtime(specB);
    await expect(validateRestore(b, backupId)).rejects.toMatchObject({ code: 'KEY_UNKNOWN' });
    await expect(
      restoreBackup(b, { backupId, userId: null, progress: progress(backupId) }),
    ).rejects.toMatchObject({ code: 'KEY_UNKNOWN' });
    expect(existsSync(keysFile)).toBe(false);
  });

  it('the key check says match / mismatch without starting anything', async () => {
    const key = archiveKey(directory);
    expect(await checkBackupKey(buckets.backups, key, [...ringB, ...ringA])).toBe('MATCH');
    expect(await checkBackupKey(buckets.backups, key, ringB)).toBe('MISMATCH');
    // Another id: unknown.
    expect(await checkBackupKey(buckets.backups, key, parseKeyRing(newKey('zz')))).toBe(
      'KEY_UNKNOWN',
    );
    expect(existsSync(keysFile)).toBe(false);
  });

  it('a wrong key (same id, other material) is rejected before anything is replaced or stored', async () => {
    const wrong = parseKeyRing(newKey('k1'));
    await expect(
      restoreBackup(runtime(specB), {
        backupId,
        userId: null,
        progress: progress(backupId),
        sourceKeys: wrong,
      }),
    ).rejects.toMatchObject({ code: 'KEY_UNKNOWN' });
    expect(existsSync(keysFile)).toBe(false);
    expect((await query(`SELECT count(*)::int AS n FROM event_signing_keys`)).rows[0].n).toBe(0);
  });

  it('restores with the entered source key (staged like the UI does) and keeps every secret readable', async () => {
    // A long-running process: its box exists before the keys are stored.
    const running = createReloadingSecretBox(specB);
    const token = await stageSourceKeys(ctxWith(primaryB), `APP_ENCRYPTION_KEYS=${specA}`);
    const sourceKeys = await takeSourceKeys(ctxWith(primaryB), token);
    expect(sourceKeys).toHaveLength(1);

    const result = await restoreBackup(runtime(specB), {
      backupId,
      userId: null,
      progress: progress(backupId),
      sourceKeys,
    });
    // The id collides with this system's own id and is stored all the same.
    expect(result.additionalKeyIds).toEqual([keyLabel(ringA[0]!)]);
    // The verification pass after the restore found every secret readable: no notice.
    expect(result.unreadableSecrets).toBe(0);
    expect(await getSecretsUnreadable({ redis, keys: ctx.keys })).toBeNull();
    expect(result.additionalKeyIds[0]).toMatch(/^k1 \([0-9a-f]{8}\)$/);
    expect(loadExtraKeys(extraKeysPath())).toHaveLength(1);
    expect(loadKeyRing(specB).map((k) => k.id)).toEqual(['k1', 'k1']);

    // Without the additional key nothing of the restored data opens ...
    expectAll(await openAll(primaryB), 'failed');
    // ... a running process picks the key up on its own, a restarted one reads the file.
    expectAll(await openAll(running), 'opened');
    expectAll(await openAll(createReloadingSecretBox(specB)), 'opened');
    invalidateSettings();
    const creds = await getSecretSetting(
      { db: handle.db, secrets: createReloadingSecretBox(specB) } as never,
      'backup.external.credentials',
    );
    expect(creds).toEqual({ accessKeyId: 'AKIA-SOURCE', secretAccessKey: 'source-secret' });
    // New secrets use this system's own key, whatever the ring holds.
    expect(createSecretBox(loadKeyRing(specB)).encrypt('x', 'c').startsWith('v1.k1.')).toBe(true);
    // The safety backup made by the restore is encrypted with THIS system's key.
    const safety = (await listCatalogue(buckets.backups)).find(
      (e) => e.manifest.kind === 'PRE_RESTORE',
    );
    expect(safety).toBeDefined();
    expect(await checkBackupKey(buckets.backups, archiveKey(safety!.directory), ringB)).toBe(
      'MATCH',
    );
    // The foreign archive stays readable without typing the key again (it is in the file now).
    await expect(validateRestore(runtime(specB), backupId)).resolves.toBeDefined();
  });

  it('the manifest names the keys the secrets depend on; missing ones are detected', async () => {
    const entry = (await listCatalogue(buckets.backups)).find((e) => e.manifest.id === backupId)!;
    expect(entry.manifest.secretKeys).toEqual([`k1:${keyFingerprint(ringA[0]!)}`]);
    expect(secretKeysMissingFrom(entry.manifest, ringB)).toEqual([
      `k1:${keyFingerprint(ringA[0]!)}`,
    ]);
    expect(secretKeysMissingFrom(entry.manifest, [...ringB, ...ringA])).toEqual([]);
    expect(countBackupsUsingKeys([entry.manifest], ringA)).toBe(1);
    expect(countBackupsUsingKeys([entry.manifest], ringB)).toBe(0);

    // Pre-update backups (taken by the migrate service) record the fingerprints as well, so the
    // "backups using the keys to be removed" count is right for them too.
    await createPreUpdateBackup({
      databaseUrl: url,
      migrationsDir,
      appVersion: 'test',
      keyRing: loadKeyRing(specB),
      pg: DEFAULT_PG_BINARIES,
      bucket: buckets.backups,
      localDir: null,
      keep: 3,
      logger: { info: () => undefined, warn: () => undefined },
    });
    const pre = (await listCatalogue(buckets.backups)).find(
      (e) => e.manifest.kind === 'PRE_UPDATE',
    )!;
    expect(pre.manifest.secretKeys).toEqual([`k1:${keyFingerprint(ringA[0]!)}`]);
    expect(countBackupsUsingKeys([entry.manifest, pre.manifest], ringA)).toBe(2);
  });

  it('with the switch off, additional keys already on disk do not open archives (secrets keep working)', async () => {
    const was = process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS;
    delete process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS;
    try {
      expect(existsSync(keysFile)).toBe(true);
      const b = runtime(specB);
      expect(b.archiveKeyRing).toHaveLength(1);
      expect(b.keyRing).toHaveLength(2); // the secrets of the restored database still open
      // restore / validate: refused with the key step code, nothing touched
      await expect(validateRestore(b, backupId)).rejects.toMatchObject({ code: 'KEY_UNKNOWN' });
      await expect(
        restoreBackup(b, { backupId, userId: null, progress: progress(backupId) }),
      ).rejects.toMatchObject({ code: 'KEY_UNKNOWN' });
      // upload / import of an archive built under the additional key
      const uploadId = randomUUID();
      const archive = buckets.backups.objects.get(archiveKey(directory))!;
      buckets.backups.objects.set(archiveKey(incomingDirectory(uploadId)), archive);
      await expect(importUploadedBackup(b, uploadId, null)).rejects.toMatchObject({
        name: 'BackupCryptoError',
      });
      expect(buckets.backups.objects.has(archiveKey(incomingDirectory(uploadId)))).toBe(false);
      // verify (and with it the probe, which shares the code path)
      const verified = await verifyBackup(b, backupId, progress(backupId));
      expect(verified.status).toBe('FAILED');
      expect(verified.detail).toMatch(/^KEY_/);
      // secrets stored in the database are unaffected
      expectAll(await openAll(createReloadingSecretBox(specB)), 'opened');
    } finally {
      process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS = was;
    }
    expect(foreignBackupKeysAllowed()).toBe(true);
    await expect(validateRestore(runtime(specB), backupId)).resolves.toBeDefined();
  });

  it('a failure half-way leaves everything readable and the additional keys in place', async () => {
    const email = SECRET_COLUMNS.find((c) => c.id.startsWith('email_messages'))!;
    const broken: SecretColumn = {
      ...email,
      context: () => {
        throw new Error('boom');
      },
    };
    const ring = loadKeyRing(specB);
    const before = (
      await query(
        `SELECT encrypted_value FROM system_settings WHERE key = 'backup.external.credentials'`,
      )
    ).rows[0].encrypted_value as string;
    await expect(
      reEncryptSecrets(ctx, {
        primary: ring[0]!,
        allKeys: ring,
        columns: [SECRET_COLUMNS[0]!, SECRET_COLUMNS[1]!, broken],
      }),
    ).rejects.toThrow('boom');
    const after = (
      await query(
        `SELECT encrypted_value FROM system_settings WHERE key = 'backup.external.credentials'`,
      )
    ).rows[0].encrypted_value as string;
    expect(after).not.toBe(before); // the tables before the failure were converted and committed
    const map = await openAll(createSecretBox(ring));
    expectAll(map, 'opened'); // ... and the whole database still opens with the ring
    expect(existsSync(keysFile)).toBe(true);
    // The unprocessed tables still depend on the additional key.
    const primaryOnly = await openAll(primaryB);
    expect(primaryOnly.get(SECRET_COLUMNS[0]!.id)!.failed).toBe(0);
    expect(primaryOnly.get(email.id)!.opened).toBe(0);
  });

  it('rows no known key opens are reported, left untouched, and keep the additional keys', async () => {
    const junkContext = 'setting:zz.junk';
    const junk = createSecretBox(parseKeyRing(newKey('zz'))).encrypt('lost', junkContext);
    await query(`INSERT INTO system_settings (key, encrypted_value) VALUES ('zz.junk', $1)`, [
      junk,
    ]);
    const outcome = await runReEncryptSecrets(runtime(specB), {
      userId: null,
      trigger: 'MANUAL',
      progress: createProgress({ redis, keys: ctx.keys }, 'REENCRYPT', null),
    });
    expect(outcome.complete).toBe(false);
    expect(outcome.undecryptable).toEqual([
      { id: 'system_settings.encrypted_value', pk: 'zz.junk' },
    ]);
    expect(outcome.removedKeys).toBe(0);
    expect(existsSync(keysFile)).toBe(true);
    expect(await getSecretsUnreadable({ redis, keys: ctx.keys })).toMatchObject({
      count: 1,
      source: 'REENCRYPT',
    });
    expect(
      (await query(`SELECT encrypted_value FROM system_settings WHERE key = 'zz.junk'`)).rows[0]
        .encrypted_value,
    ).toBe(junk);
    // Everything else is converted already.
    for (const c of SECRET_COLUMNS) {
      const map = await openAll(primaryB);
      const entry = map.get(c.id)!;
      expect(entry.failed, c.id).toBe(c.id === 'system_settings.encrypted_value' ? 1 : 0);
    }
  });

  it('a restore reports secrets no key opens (notice) instead of silently succeeding', async () => {
    // zz.junk (key id zz, nobody has it) is still stored: the manifest records it as unreadable ...
    const made = await createBackup(runtime(specB), {
      kind: 'MANUAL',
      userId: null,
      progress: progress(),
      retention: false,
    });
    expect(made.manifest.secretKeys).toEqual([`k1:${keyFingerprint(ringB[0]!)}`, 'zz:unreadable']);
    // The probe's deep check opens the secrets of its throwaway copy with the current ring, too.
    const deep = await verifyBackup(runtime(specB), made.manifest.id, progress(made.manifest.id), {
      deep: true,
    });
    expect(deep.status).toBe('FAILED');
    expect(deep.detail).toBe('SANITY_FAILED');
    expect(deep.mismatches?.join(' ')).toContain('secrets: 1 stored secret(s)');
    // ... and restoring it finds the secret unreadable with the current ring.
    const result = await restoreBackup(runtime(specB), {
      backupId: made.manifest.id,
      userId: null,
      progress: progress(made.manifest.id),
    });
    expect(result.unreadableSecrets).toBe(1);
    expect(await getSecretsUnreadable({ redis, keys: ctx.keys })).toMatchObject({
      count: 1,
      source: 'RESTORE',
    });
  });

  it('re-encrypts everything, then removes the additional keys; the app works with the primary key alone', async () => {
    await query(`DELETE FROM system_settings WHERE key = 'zz.junk'`);
    const status = createProgress({ redis, keys: ctx.keys }, 'REENCRYPT', null);
    const outcome = await runReEncryptSecrets(runtime(specB), {
      userId: null,
      trigger: 'MANUAL',
      progress: status,
    });
    expect(outcome.complete).toBe(true);
    // A complete pass clears the "secrets unreadable" notice.
    expect(await getSecretsUnreadable({ redis, keys: ctx.keys })).toBeNull();
    expect(outcome.removedKeys).toBe(1);
    expect(outcome.removedKeyIds).toEqual([keyLabel(ringA[0]!)]);
    expect(existsSync(keysFile)).toBe(false);
    expect(loadKeyRing(specB)).toHaveLength(1);

    // Every registered table was converted earlier or now; the rest was already primary.
    const processed = outcome.tables.reduce((n, t) => n + t.reEncrypted + t.skipped, 0);
    expect(processed).toBe(SECRET_COLUMNS.length);
    expectAll(await openAll(primaryB), 'opened');

    // The rest of the application works with this system's key only.
    const only = ctxWith(primaryB);
    const key = await ensureEventSigningKey(only, eventId);
    expect(key.signer).toBeDefined();
    expect(await ensureEventLanSecret(only, eventId)).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    invalidateSettings();
    expect(await getSecretSetting(only as never, 'backup.external.credentials')).toEqual({
      accessKeyId: 'AKIA-SOURCE',
      secretAccessKey: 'source-secret',
    });
    const mail = (await query(`SELECT attachments FROM email_messages WHERE id = $1`, [emailId]))
      .rows[0].attachments as { locale: string; variables: string };
    expect(mail.locale).toBe('en'); // the rest of the jsonb is untouched
    expect(primaryB.decryptJson(mail.variables, 'email-message:variables')).toEqual({
      firstName: 'Ada',
    });
    expect(
      primaryB.decrypt(
        (
          await query(`SELECT totp_secret_encrypted AS v FROM admin_users WHERE id = $1`, [
            adminUserId,
          ])
        ).rows[0].v,
        TOTP_SECRET_CONTEXT(adminUserId),
      ),
    ).toBe('JBSWY3DPEHPK3PXP');

    // Idempotent: a second run changes nothing.
    const again = await runReEncryptSecrets(runtime(specB), {
      userId: null,
      trigger: 'MANUAL',
      progress: status,
    });
    expect(again.complete).toBe(true);
    expect(again.tables.every((t) => t.reEncrypted === 0 && t.undecryptable === 0)).toBe(true);
    expect(again.removedKeys).toBe(0);

    // Audit entries carry counts and ids, never key material or values.
    const audits = (
      await query(`SELECT changes::text AS c FROM audit_logs WHERE action = 'secrets.reencrypt'`)
    ).rows as { c: string }[];
    expect(audits.length).toBe(3);
    const text = audits.map((a) => a.c).join('\n');
    expect(text).not.toContain(specA.split(':')[1]);
    expect(text).not.toContain(specB.split(':')[1]);
    expect(text).not.toContain('AKIA-SOURCE');
    expect(text).not.toMatch(new RegExp(ENVELOPE));
  });

  it('after re-encryption the foreign archive needs its key again (earlier backups depend on it)', async () => {
    await expect(validateRestore(runtime(specB), backupId)).rejects.toMatchObject({
      code: 'KEY_UNKNOWN',
    });
  });

  it('staged keys are encrypted at rest, single use and never appear in plain text', async () => {
    const c = ctxWith(primaryB);
    const token = await stageSourceKeys(c, `APP_ENCRYPTION_KEYS=${specA}`);
    const stored = [...(redis as unknown as { _store: Map<string, string> })._store.entries()].find(
      ([k]) => k.includes(token),
    );
    expect(stored).toBeDefined();
    expect(stored![1]).not.toContain(specA.split(':')[1]!);
    expect(stored![1].startsWith('v1.k1.')).toBe(true);
    const keys = await takeSourceKeys(c, token);
    expect(keys.map((k) => k.id)).toEqual(['k1']);
    await expect(takeSourceKeys(c, token)).rejects.toMatchObject({ code: 'EXPIRED' });
    await expect(takeSourceKeys(c, 'short')).rejects.toMatchObject({ code: 'EXPIRED' });
    await expect(stageSourceKeys(c, 'garbage')).rejects.toMatchObject({ code: 'INVALID' });
    await expect(stageSourceKeys(c, '  ')).rejects.toBeInstanceOf(SourceKeysError);
    // A key with the same id as this system's own is accepted (candidates per id).
    await expect(stageSourceKeys(c, newKey('k1'))).resolves.toBeTypeOf('string');
  });

  it('with the operator switch off, staging, taking and restoring with foreign keys are refused', async () => {
    const c = ctxWith(primaryB);
    // A token staged while the switch was on must not be usable once it is off.
    const token = await stageSourceKeys(c, specA);
    const was = process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS;
    try {
      for (const off of [undefined, '', '0', 'false', 'yes']) {
        if (off === undefined) delete process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS;
        else process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS = off;
        expect(foreignBackupKeysAllowed()).toBe(false);
        await expect(stageSourceKeys(c, specA)).rejects.toMatchObject({ code: 'DISABLED' });
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
    } finally {
      process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS = was;
    }
    process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS = 'true';
    expect(foreignBackupKeysAllowed()).toBe(true);
    process.env.TIX_ALLOW_FOREIGN_BACKUP_KEYS = was;
    expect(existsSync(keysFile)).toBe(false);
  });
});
