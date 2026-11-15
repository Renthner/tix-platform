import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  DEFAULT_PG_BINARIES,
  createBackupBuckets,
  createPreUpdateBackup,
  isMountPointIn,
  isOnPersistentVolumeIn,
  runPreUpdatePolicy,
  storageConfigFromEnv,
  type BackupBucket,
  type PreUpdateOutcome,
} from '@tix/core';
import { loadRootEnv } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { APP_VERSION } from '@tix/shared';
import { parseKeyRing, readSecretEnv } from '@tix/shared/server';

/**
 * Entry point of the `migrate` one-shot service (dist/migrate.mjs): applies the SQL migrations
 * under an advisory lock with a lock timeout and retries, and - for an existing installation with
 * pending migrations - takes a database backup first (see packages/core/src/backup/pre-update.ts).
 *
 * Environment (all optional except DATABASE_URL):
 *   SKIP_PRE_UPDATE_BACKUP=1        skip the pre-update backup (documented escape hatch)
 *   PRE_UPDATE_BACKUP_KEEP=3        pre-update backups kept per location
 *   PRE_UPDATE_BACKUP_DIR           fallback directory when the backups bucket is not reachable
 *                                   (default /pre-update-backups, a volume in the compose file)
 *   MIGRATION_LOCK_TIMEOUT=10       seconds a schema change may wait for a table lock (0 = off)
 *   MIGRATION_STATEMENT_TIMEOUT=600 seconds a single statement may run (0 = off)
 *   MIGRATION_LOCK_RETRIES=5        attempts after a lock timeout (exponential backoff)
 */

const log = (message: string) => console.log(message);

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

const isOn = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value ?? '');

/** The backups bucket of the configured storage driver (S3 bucket or <STORAGE_DIR>/backups). */
function backupsBucket(): BackupBucket | null {
  const config = storageConfigFromEnv({
    ...process.env,
    S3_ACCESS_KEY_ID: readSecretEnv('S3_ACCESS_KEY_ID'),
    S3_SECRET_ACCESS_KEY: readSecretEnv('S3_SECRET_ACCESS_KEY'),
  });
  return createBackupBuckets(config).backups;
}

/** Mounted volume check for the filesystem backups directory; unreadable mountinfo = not Linux. */
async function isOnVolume(dir: string): Promise<boolean> {
  let mountinfo: string;
  try {
    mountinfo = await readFile('/proc/self/mountinfo', 'utf8');
  } catch {
    log(`[migrate] cannot read /proc/self/mountinfo; assuming ${dir} is persistent`);
    return true;
  }
  return isOnPersistentVolumeIn(mountinfo, dir);
}

async function main(): Promise<void> {
  loadRootEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing required environment variable DATABASE_URL');
  const migrationsFolder =
    process.env.MIGRATIONS_DIR ?? resolve(import.meta.dirname, '../../packages/db/migrations');
  const skip = isOn(process.env.SKIP_PRE_UPDATE_BACKUP);

  await runMigrations({
    connectionString: databaseUrl,
    migrationsFolder,
    log,
    lockTimeoutMs: intEnv('MIGRATION_LOCK_TIMEOUT', 10, 0, 3600) * 1000,
    statementTimeoutMs: intEnv('MIGRATION_STATEMENT_TIMEOUT', 600, 0, 86_400) * 1000,
    lockRetries: intEnv('MIGRATION_LOCK_RETRIES', 5, 1, 50),
    beforeApply: async ({ pending, applied }) => {
      const tags = pending.map((p) => p.tag).join(', ');
      if (skip) {
        log(
          `[migrate] ${pending.length} pending migration(s) (${tags}); pre-update backup SKIPPED (SKIP_PRE_UPDATE_BACKUP)`,
        );
        return;
      }
      log(
        `[migrate] ${pending.length} pending migration(s) on an installation with ${applied} applied: ${tags}. Creating a pre-update database backup first.`,
      );
      const localDir = process.env.PRE_UPDATE_BACKUP_DIR ?? '/pre-update-backups';
      let outcome: PreUpdateOutcome;
      try {
        outcome = await runPreUpdatePolicy({
          skip: false,
          composeVersion: process.env.TIX_COMPOSE_VERSION,
          makeBucket: backupsBucket,
          localDir,
          isMountPoint: async (dir) =>
            isMountPointIn(await readFile('/proc/self/mountinfo', 'utf8'), dir),
          isOnVolume,
          create: ({ bucket, localDir: dir }) =>
            createPreUpdateBackup({
              databaseUrl,
              migrationsDir: migrationsFolder,
              appVersion: APP_VERSION,
              keyRing: parseKeyRing(process.env.APP_ENCRYPTION_KEYS ?? ''),
              pg: DEFAULT_PG_BINARIES,
              bucket,
              localDir: dir,
              keep: intEnv('PRE_UPDATE_BACKUP_KEEP', 3, 1, 100),
              logger: { info: log, warn: log },
            }),
          logger: { info: log, warn: log },
        });
      } catch (err) {
        throw new Error(
          `The pre-update backup failed, so no migration was applied and your data is unchanged: ${err instanceof Error ? err.message : String(err)}. Fix the cause and run the update again; set SKIP_PRE_UPDATE_BACKUP=1 in .env to update without a backup (not recommended).`,
          { cause: err },
        );
      }
      if (outcome.kind === 'skipped') return;
      const result = outcome.result;
      log(
        result.location === 'bucket'
          ? `[migrate] pre-update backup ${result.id} stored (Admin > Backups, "Before update"; ${result.sizeBytes} bytes)`
          : `[migrate] pre-update backup ${result.id} stored as a local file ${result.path} (volume pre-update-backups; upload it under Admin > Backups to restore it)`,
      );
    },
  });
}

main().catch((err) => {
  console.error('[migrate] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
