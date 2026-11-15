import { createHash } from 'node:crypto';
import { PgClient } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { BackupCryptoError } from './crypto';
import { findBackup, writeBackupState } from './catalogue';
import { extractDump, inspectArchive } from './inspect';
import { archiveKey, type BackupManifest, type VerifyResult } from './manifest';
import {
  databaseName,
  latestCodeMigration,
  pgRestoreFromStream,
  readExistingRowCounts,
  readMigrationInfo,
  withDatabase,
  withPgClient,
} from './pg';
import { describeError, type BackupRuntime } from './runtime';
import { withOperationLock, type Progress } from './state';

const cryptoMessage = (err: BackupCryptoError): string => `${err.code}: ${err.message}`;

/** Row counts that must match exactly between manifest and the test restore. */
export function compareRowCounts(
  expected: Record<string, number>,
  actual: Record<string, number>,
): string[] {
  const mismatches: string[] = [];
  for (const [table, count] of Object.entries(expected)) {
    if (actual[table] !== count) {
      mismatches.push(`${table}: manifest ${count}, restored ${actual[table] ?? 'missing'}`);
    }
  }
  return mismatches;
}

/**
 * Short tag of THIS stack (live database name + Redis key prefix). Throwaway databases carry it, so
 * a stack never drops the leftovers of another stack that shares the PostgreSQL server.
 */
export function stackTag(databaseUrl: string, keyPrefix: string): string {
  return createHash('sha256')
    .update(`${databaseName(databaseUrl)}\0${keyPrefix}`)
    .digest('hex')
    .slice(0, 8);
}

const rtTag = (rt: BackupRuntime): string => stackTag(rt.databaseUrl, rt.ctx.keys.prefix);

/** Pattern of the throwaway databases of the stack with this tag (hex, safe to embed). */
export const testDatabasePattern = (tag: string): RegExp => {
  if (!/^[0-9a-f]{8}$/.test(tag)) throw new Error('Invalid stack tag');
  return new RegExp(`^tix_(verify|probe)_${tag}_[a-z0-9_]{1,40}$`);
};

/** Name of a throwaway database of this stack (`kind` + random / backup based suffix). */
export const testDatabaseName = (rt: BackupRuntime, kind: 'verify' | 'probe', suffix: string) =>
  `tix_${kind}_${rtTag(rt)}_${suffix.toLowerCase()}`;

/**
 * Guard in front of every CREATE / DROP DATABASE: the name must be a throwaway name of this stack
 * (`tag`) and must never be the live database. The name is interpolated into SQL, hence the strict
 * pattern.
 */
export function assertThrowawayDatabase(
  database: string,
  liveDatabaseUrl: string,
  tag: string,
): void {
  if (!testDatabasePattern(tag).test(database)) {
    throw new Error('Refusing to use this name as a throwaway database');
  }
  if (database === databaseName(liveDatabaseUrl)) {
    throw new Error('Refusing to use the live database as a throwaway database');
  }
}

/** Tables whose row counts are recorded by the probe restore (after migrating the copy). */
export const PROBE_COUNT_TABLES = ['events', 'orders', 'tickets'] as const;

export interface VerifyOptions {
  /** Throwaway database name (default: derived from the backup id). */
  database?: string;
  /**
   * Probe restore: after the row-count comparison the copy is migrated to the current structure
   * (exactly what a real restore does) and key tables are read.
   */
  deep?: boolean;
}

/**
 * "Verify backup": checksum + full decryption pass, structure and file counts, then a real
 * restore into a temporary database `tix_verify_<id>` whose row counts are compared with the
 * manifest. The temporary database is always dropped. The result is stored in `state.json`.
 */
export async function verifyBackup(
  rt: BackupRuntime,
  backupId: string,
  progress: Progress,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const entry = await findBackup(rt.buckets.backups, backupId);
  if (!entry) throw new Error('Backup not found');
  const { manifest, directory } = entry;
  const result = await runVerification(rt, manifest, directory, progress, options);
  await writeBackupState(rt.buckets.backups, directory, { ...entry.state, verify: result });
  return result;
}

/**
 * Leftover throwaway databases of a crashed run. Only call while holding the backup operation
 * lock: then no other verification / probe can be using one.
 */
export async function dropStaleTestDatabases(rt: BackupRuntime): Promise<number> {
  const admin = new PgClient({
    connectionString: rt.databaseUrl,
    application_name: 'tix-backup-probe-cleanup',
  });
  admin.on('error', () => undefined);
  await admin.connect();
  let dropped = 0;
  try {
    const tag = rtTag(rt);
    const stale = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database
        WHERE datname ~ $1
          AND datname <> current_database() AND NOT datistemplate`,
      [testDatabasePattern(tag).source],
    );
    for (const { datname } of stale.rows) {
      try {
        assertThrowawayDatabase(datname, rt.databaseUrl, tag);
        await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
        dropped += 1;
      } catch (err) {
        rt.logger.warn({ err: describeError(err), database: datname }, 'stale test database kept');
      }
    }
  } finally {
    await admin.end().catch(() => undefined);
  }
  return dropped;
}

/**
 * Startup cleanup (worker): drops leftovers of a crashed verification / probe, but only while the
 * backup operation lock is free (a running operation of another worker is never disturbed).
 */
export async function cleanupStaleTestDatabases(rt: BackupRuntime): Promise<number> {
  const run = await withOperationLock(rt.ctx, () => dropStaleTestDatabases(rt));
  return run.ran ? run.value : 0;
}

interface SanityOutcome {
  problems: string[];
  counts: Record<string, number>;
  applied: number;
  newer: boolean;
}

/** Probe restore: migrate the copy to the code's structure and read the key tables. */
async function sanityCheck(
  rt: BackupRuntime,
  target: string,
  manifest: BackupManifest,
): Promise<SanityOutcome> {
  const problems: string[] = [];
  const code = await latestCodeMigration(rt.migrationsDir);
  if (manifest.lastMigration.when > code.when) {
    return { problems: ['MIGRATION_NEWER'], counts: {}, applied: 0, newer: true };
  }
  const before = await withPgClient(target, 'tix-backup-probe-check', async (client) => {
    const present = await client.query<{ t: string | null }>(
      "SELECT to_regclass('public.__drizzle_migrations')::text AS t",
    );
    if (!present.rows[0]?.t) return null;
    return readMigrationInfo(client, rt.migrationsDir);
  });
  if (!before) {
    return { problems: ['migrations table missing'], counts: {}, applied: 0, newer: false };
  }
  if (
    before.when !== manifest.lastMigration.when ||
    before.count !== manifest.lastMigration.count
  ) {
    problems.push(`migrations: manifest ${manifest.lastMigration.count}, restored ${before.count}`);
  }
  await runMigrations({
    connectionString: target,
    migrationsFolder: rt.migrationsDir,
    log: () => undefined,
    // A throwaway copy: no live traffic to protect, but never wait forever either.
    statementTimeoutMs: 0,
    lockTimeoutMs: 30_000,
  });
  const { after, counts } = await withPgClient(
    target,
    'tix-backup-probe-check',
    async (client) => ({
      after: await readMigrationInfo(client, rt.migrationsDir),
      counts: await readExistingRowCounts(client),
    }),
  );
  if (after.when !== code.when) problems.push('database is not at the current migration level');
  const key: Record<string, number> = {};
  for (const table of PROBE_COUNT_TABLES) {
    if (counts[table] === undefined) problems.push(`${table}: table missing`);
    else key[table] = counts[table];
  }
  return { problems, counts: key, applied: Math.max(after.count - before.count, 0), newer: false };
}

async function runVerification(
  rt: BackupRuntime,
  manifest: BackupManifest,
  directory: string,
  progress: Progress,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const fail = (detail: string, mismatches?: string[]): VerifyResult => ({
    status: 'FAILED',
    at: new Date().toISOString(),
    detail: detail.slice(0, 1_000),
    ...(mismatches?.length
      ? { mismatches: mismatches.map((m) => m.slice(0, 200)).slice(0, 50) }
      : {}),
  });

  // 1. Checksum, decryption of every chunk, structure, file counts.
  await progress.step('CHECKSUM');
  try {
    const source = await rt.buckets.backups.getStream(archiveKey(directory));
    const inspected = await inspectArchive(source.stream, rt.keyRing);
    const problems: string[] = [];
    if (manifest.archive && inspected.sha256 !== manifest.archive.sha256) {
      problems.push('Checksum of the archive differs from the manifest');
    }
    if (manifest.files) {
      for (const area of ['assets', 'documents'] as const) {
        if (inspected.files[area].objects !== manifest.files[area].objects) {
          problems.push(
            `${area}: manifest ${manifest.files[area].objects} files, archive ${inspected.files[area].objects}`,
          );
        }
      }
    }
    if (problems.length > 0) return fail('ARCHIVE_MISMATCH', problems);
  } catch (err) {
    if (err instanceof BackupCryptoError) return fail(cryptoMessage(err));
    throw err;
  }

  // 2. Restore into a temporary database and compare row counts.
  await progress.step('TEST_RESTORE');
  const database =
    options.database ??
    testDatabaseName(rt, 'verify', manifest.id.replaceAll('-', '').slice(0, 20));
  assertThrowawayDatabase(database, rt.databaseUrl, rtTag(rt));
  const admin = new PgClient({
    connectionString: rt.databaseUrl,
    application_name: 'tix-backup-verify',
  });
  admin.on('error', () => undefined);
  await admin.connect();
  try {
    const privileges = await admin.query<{ allowed: boolean }>(
      'SELECT (rolcreatedb OR rolsuper) AS allowed FROM pg_roles WHERE rolname = current_user',
    );
    if (!privileges.rows[0]?.allowed) {
      return fail(
        'CREATEDB_MISSING: checksum and decryption are fine, but the database role may not create databases',
      );
    }
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${database}"`);
    const target = withDatabase(rt.databaseUrl, database);
    const source = await rt.buckets.backups.getStream(archiveKey(directory));
    await pgRestoreFromStream(rt.pg, target, extractDump(source.stream, rt.keyRing), {
      applicationName: 'tix-backup-verify-restore',
    });
    const counts = await withPgClient(target, 'tix-backup-verify-count', readExistingRowCounts);
    const mismatches = compareRowCounts(manifest.rowCounts, counts);
    if (mismatches.length > 0) return fail('ROW_COUNT_MISMATCH', mismatches);
    if (!options.deep) return { status: 'OK', at: new Date().toISOString() };

    await progress.step('SANITY');
    const sanity = await sanityCheck(rt, target, manifest);
    if (sanity.newer) return fail('MIGRATION_NEWER');
    if (sanity.problems.length > 0) return fail('SANITY_FAILED', sanity.problems);
    return {
      status: 'OK',
      at: new Date().toISOString(),
      counts: sanity.counts,
      migrationsApplied: sanity.applied,
    };
  } catch (err) {
    if (err instanceof BackupCryptoError) return fail(cryptoMessage(err));
    return fail(`TEST_RESTORE_FAILED: ${describeError(err)}`);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch((err) => {
      rt.logger.warn({ err, database }, 'temporary verification database could not be dropped');
    });
    await admin.end().catch(() => undefined);
  }
}
