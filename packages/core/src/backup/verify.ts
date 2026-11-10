import { PgClient } from '@tix/db';
import { BackupCryptoError } from './crypto';
import { findBackup, writeBackupState } from './catalogue';
import { extractDump, inspectArchive } from './inspect';
import { archiveKey, type BackupManifest, type VerifyResult } from './manifest';
import { pgRestoreFromStream, readRowCounts, withDatabase, withPgClient } from './pg';
import { describeError, type BackupRuntime } from './runtime';
import type { Progress } from './state';

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
 * "Verify backup": checksum + full decryption pass, structure and file counts, then a real
 * restore into a temporary database `tix_verify_<id>` whose row counts are compared with the
 * manifest. The temporary database is always dropped. The result is stored in `state.json`.
 */
export async function verifyBackup(
  rt: BackupRuntime,
  backupId: string,
  progress: Progress,
): Promise<VerifyResult> {
  const entry = await findBackup(rt.buckets.backups, backupId);
  if (!entry) throw new Error('Backup not found');
  const { manifest, directory } = entry;
  const result = await runVerification(rt, manifest, directory, progress);
  await writeBackupState(rt.buckets.backups, directory, { ...entry.state, verify: result });
  return result;
}

async function runVerification(
  rt: BackupRuntime,
  manifest: BackupManifest,
  directory: string,
  progress: Progress,
): Promise<VerifyResult> {
  const fail = (detail: string, mismatches?: string[]): VerifyResult => ({
    status: 'FAILED',
    at: new Date().toISOString(),
    detail,
    ...(mismatches?.length ? { mismatches: mismatches.slice(0, 50) } : {}),
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
  const admin = new PgClient({
    connectionString: rt.databaseUrl,
    application_name: 'tix-backup-verify',
  });
  admin.on('error', () => undefined);
  await admin.connect();
  const database = `tix_verify_${manifest.id.replaceAll('-', '').slice(0, 20)}`;
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
    const counts = await withPgClient(target, 'tix-backup-verify-count', readRowCounts);
    const mismatches = compareRowCounts(manifest.rowCounts, counts);
    return mismatches.length > 0
      ? fail('ROW_COUNT_MISMATCH', mismatches)
      : { status: 'OK', at: new Date().toISOString() };
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
