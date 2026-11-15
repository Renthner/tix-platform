import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDb, PgClient } from '@tix/db';
import { collectSecretKeyFingerprints } from '../secrets/reencrypt';
import { writeArchive, type ArchiveEntry } from './archive';
import { listCatalogue, writeBackupState } from './catalogue';
import { encryptStream, type BackupKey } from './crypto';
import {
  ARCHIVE_DUMP,
  ARCHIVE_MANIFEST,
  BACKUP_FORMAT_VERSION,
  archiveKey,
  backupDirectory,
  manifestKey,
  type BackupManifest,
} from './manifest';
import { pgDumpStream, readExistingRowCounts, readMigrationInfo, type PgBinaries } from './pg';
import { describeError } from './runtime';
import type { BackupBucket } from './bucket';

/**
 * Pre-update backup: a database-only archive (same encrypted format and catalogue as the admin
 * backups, kind PRE_UPDATE, scope DATABASE) taken by the `migrate` service before pending
 * migrations are applied. It lives in the backups bucket (listed under Admin > Backups, restorable
 * with the normal restore, which leaves the files alone) or - when the bucket is not reachable -
 * as an encrypted `.tixbak` file in a local directory (upload it under Admin > Backups).
 * Failing to create it must stop the update, the caller lets the error propagate.
 */

export interface PreUpdateLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface PreUpdateBackupParams {
  databaseUrl: string;
  migrationsDir: string;
  appVersion: string;
  keyRing: readonly BackupKey[];
  pg: PgBinaries;
  /** Backups bucket; null = go straight to the local directory. */
  bucket: BackupBucket | null;
  /** Fallback directory (volume `pre-update-backups`); null = no fallback. */
  localDir: string | null;
  /** Pre-update backups to keep per location (default 3, at least 1). */
  keep: number;
  logger: PreUpdateLogger;
}

export interface PreUpdateBackupResult {
  id: string;
  location: 'bucket' | 'local';
  /** Bucket key of the archive or absolute path of the local file. */
  path: string;
  sizeBytes: number;
}

/** Keeps the newest `keep` names of `names` (sorted newest first by the caller) and returns the rest. */
export function selectPreUpdateToDelete<T>(newestFirst: readonly T[], keep: number): T[] {
  return newestFirst.slice(Math.max(1, Math.floor(keep)));
}

const LOCAL_FILE = /^\d{8}T\d{6}Z-PRE_UPDATE-[0-9a-f-]{36}\.tixbak$/;

async function* archiveEntries(
  inner: BackupManifest,
  dump: AsyncIterable<Buffer>,
  stats: { dumpBytes: number },
): AsyncGenerator<ArchiveEntry> {
  yield {
    header: { name: ARCHIVE_MANIFEST, contentType: 'application/json' },
    data: (async function* () {
      yield Buffer.from(JSON.stringify(inner));
    })(),
  };
  yield {
    header: { name: ARCHIVE_DUMP },
    data: (async function* () {
      for await (const chunk of dump) {
        stats.dumpBytes += chunk.length;
        yield chunk;
      }
    })(),
  };
}

async function sampleSecretKeys(params: PreUpdateBackupParams): Promise<string[]> {
  const handle = createDb({
    connectionString: params.databaseUrl,
    poolMax: 1,
    applicationName: 'tix-pre-update-secret-keys',
    statementTimeoutMs: 30_000,
  });
  try {
    return await collectSecretKeyFingerprints(handle, params.keyRing, undefined, {
      tolerateMissing: true,
    });
  } catch (err) {
    params.logger.warn(
      `pre-update backup: secret key fingerprints not recorded: ${describeError(err)}`,
    );
    return [];
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** One snapshot-consistent dump + manifest, written to the bucket or (fallback) the local directory. */
export async function createPreUpdateBackup(
  params: PreUpdateBackupParams,
): Promise<PreUpdateBackupResult> {
  const active = params.keyRing[0];
  if (!active) throw new Error('The key ring is empty');
  const snapshotClient = new PgClient({
    connectionString: params.databaseUrl,
    application_name: 'tix-pre-update-backup',
  });
  snapshotClient.on('error', () => undefined);
  await snapshotClient.connect();
  try {
    await snapshotClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (
      await snapshotClient.query<{ snapshot: string }>('SELECT pg_export_snapshot() AS snapshot')
    ).rows[0]!.snapshot;
    const rowCounts = await readExistingRowCounts(snapshotClient);
    const lastMigration = await readMigrationInfo(snapshotClient, params.migrationsDir);
    const version = await snapshotClient.query<{ server_version: string }>('SHOW server_version');
    // Which keys do the stored secrets depend on? (sample; never blocks the backup; the database
    // may still be at an older version: missing tables are skipped)
    const secretKeys = await sampleSecretKeys(params);
    const inner: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      id: randomUUID(),
      kind: 'PRE_UPDATE',
      scope: 'DATABASE',
      createdAt: new Date().toISOString(),
      appVersion: params.appVersion,
      lastMigration,
      postgresVersion: version.rows[0]!.server_version,
      encryption: { algorithm: 'AES-256-GCM-STREAM', keyId: active.id },
      rowCounts,
      createdByUserId: null,
      ...(secretKeys.length > 0 ? { secretKeys } : {}),
    };
    const directory = backupDirectory(inner);
    const stats = { dumpBytes: 0 };
    // Every attempt needs a fresh stream (a failed upload consumed the previous one); all of them
    // dump the same exported snapshot.
    const encrypted = () =>
      encryptStream(
        writeArchive(
          archiveEntries(inner, pgDumpStream(params.pg, params.databaseUrl, snapshot), stats),
        ),
        active,
      );

    let bucketError: string | null = null;
    if (params.bucket) {
      try {
        await params.bucket.checkAccess('.tix-pre-update-probe');
        stats.dumpBytes = 0;
        const written = await params.bucket.putStream(archiveKey(directory), encrypted());
        const manifest: BackupManifest = {
          ...inner,
          archive: { sizeBytes: written.sizeBytes, sha256: written.sha256 },
          database: { dumpBytes: stats.dumpBytes },
        };
        await params.bucket.putBytes(
          manifestKey(directory),
          JSON.stringify(manifest),
          'application/json',
        );
        await writeBackupState(params.bucket, directory, { external: { status: 'NONE' } });
        await pruneBucket(params.bucket, params.keep, params.logger);
        return {
          id: inner.id,
          location: 'bucket',
          path: archiveKey(directory),
          sizeBytes: written.sizeBytes,
        };
      } catch (err) {
        bucketError = describeError(err);
        // Incomplete objects are never listed (the manifest is written last), remove them anyway.
        await params.bucket.deletePrefix(directory).catch(() => undefined);
        params.logger.warn(
          `[pre-update-backup] the backups bucket is not usable (${bucketError}); falling back to the local directory`,
        );
      }
    }
    if (!params.localDir) {
      throw new Error(
        `No place to store the pre-update backup (${bucketError ?? 'object storage not configured'}; no local directory)`,
      );
    }
    stats.dumpBytes = 0;
    const file = await writeLocal(params.localDir, directory, encrypted());
    await pruneLocal(params.localDir, params.keep, params.logger);
    return { id: inner.id, location: 'local', path: file.path, sizeBytes: file.sizeBytes };
  } finally {
    await snapshotClient.query('ROLLBACK').catch(() => undefined);
    await snapshotClient.end().catch(() => undefined);
  }
}

async function writeLocal(
  dir: string,
  directory: string,
  source: AsyncIterable<Uint8Array>,
): Promise<{ path: string; sizeBytes: number }> {
  await mkdir(dir, { recursive: true });
  const name = `${directory.replace(/^backups\//, '').replace(/\/$/, '')}.tixbak`;
  const target = join(dir, name);
  const partial = `${target}.partial`;
  try {
    await pipeline(Readable.from(source), createWriteStream(partial, { mode: 0o600 }));
    await rename(partial, target);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  return { path: target, sizeBytes: (await stat(target)).size };
}

async function pruneBucket(
  bucket: BackupBucket,
  keep: number,
  logger: PreUpdateLogger,
): Promise<void> {
  try {
    const entries = (await listCatalogue(bucket)).filter((e) => e.manifest.kind === 'PRE_UPDATE');
    for (const entry of selectPreUpdateToDelete(entries, keep)) {
      await bucket.deletePrefix(entry.directory);
      logger.info(`[pre-update-backup] removed old pre-update backup ${entry.manifest.id}`);
    }
  } catch (err) {
    logger.warn(
      `[pre-update-backup] retention failed (backup itself succeeded): ${describeError(err)}`,
    );
  }
}

async function pruneLocal(dir: string, keep: number, logger: PreUpdateLogger): Promise<void> {
  try {
    const names = (await readdir(dir))
      .filter((n) => LOCAL_FILE.test(n))
      .sort()
      .reverse();
    for (const name of selectPreUpdateToDelete(names, keep)) {
      await rm(join(dir, name), { force: true });
      logger.info(`[pre-update-backup] removed old local pre-update backup ${name}`);
    }
  } catch (err) {
    logger.warn(`[pre-update-backup] local retention failed: ${describeError(err)}`);
  }
}

// ─── Policy of the `migrate` service ──────────────────────────────────────────

/** `true` when `dir` is a mount point according to the text of /proc/self/mountinfo. */
export function isMountPointIn(mountinfo: string, dir: string): boolean {
  const wanted = dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
  for (const line of mountinfo.split('\n')) {
    const field = line.split(' ')[4];
    if (field === undefined) continue;
    // mountinfo escapes space, tab, newline and backslash as octal sequences.
    const point = field.replace(/\\([0-7]{3})/g, (_, oct: string) =>
      String.fromCharCode(Number.parseInt(oct, 8)),
    );
    if (point === wanted) return true;
  }
  return false;
}

const NON_PERSISTENT_FS = new Set([
  'overlay',
  'aufs',
  'tmpfs',
  'devtmpfs',
  'ramfs',
  'proc',
  'sysfs',
  'devpts',
  'mqueue',
  'cgroup',
  'cgroup2',
]);

/**
 * `true` when `dir` is on persistent storage according to the text of /proc/self/mountinfo: inside
 * a mounted volume (a mount at or above `dir`, not `/` and not a memory/overlay file system). On a
 * host whose root file system is not a container layer (no overlay/aufs at `/`) everything counts as
 * persistent. Used for the filesystem storage directory, which lives inside one volume.
 */
export function isOnPersistentVolumeIn(mountinfo: string, dir: string): boolean {
  const wanted = dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
  let rootType: string | undefined;
  let best = false;
  for (const line of mountinfo.split('\n')) {
    const [head, tail] = line.split(' - ');
    const field = head?.split(' ')[4];
    const type = tail?.split(' ')[0];
    if (field === undefined || type === undefined) continue;
    const point = field.replace(/\\([0-7]{3})/g, (_, oct: string) =>
      String.fromCharCode(Number.parseInt(oct, 8)),
    );
    if (point === '/') {
      rootType = type;
      continue;
    }
    if (NON_PERSISTENT_FS.has(type)) continue;
    if (wanted === point || wanted.startsWith(`${point}/`)) best = true;
  }
  if (rootType !== undefined && !['overlay', 'aufs'].includes(rootType)) return true;
  return best;
}

export type PreUpdateOutcome =
  | { kind: 'skipped'; reason: 'opt-out' | 'old-compose' }
  | { kind: 'created'; result: PreUpdateBackupResult };

export interface PreUpdatePolicyParams {
  /** SKIP_PRE_UPDATE_BACKUP. */
  skip: boolean;
  /** TIX_COMPOSE_VERSION: empty = docker-compose.yml of an older release without backup support. */
  composeVersion: string | undefined;
  /** Builds the bucket; may throw (e.g. unreadable credentials) or return null (not configured). */
  makeBucket: () => BackupBucket | null;
  /** Local fallback directory, used only when it is a real mount (never the container layer). */
  localDir: string | null;
  isMountPoint: (dir: string) => Promise<boolean>;
  /**
   * Filesystem bucket (`bucket.localPath`): must be inside a persistent volume, otherwise it would
   * live in the container layer and vanish with it - then it counts as no bucket. Default: the
   * stricter `isMountPoint`.
   */
  isOnVolume?: (dir: string) => Promise<boolean>;
  create: (target: {
    bucket: BackupBucket | null;
    localDir: string | null;
  }) => Promise<PreUpdateBackupResult>;
  logger: PreUpdateLogger;
}

/**
 * Decides whether and where the pre-update backup is taken. A new compose file (TIX_COMPOSE_VERSION
 * set) must be able to back up: no target or a failing backup throws and nothing is migrated. An old
 * compose file (no version, no volume, maybe no storage credentials) cannot - that must not brick an
 * existing installation, so without any target the migration continues with a prominent warning.
 */
export async function runPreUpdatePolicy(params: PreUpdatePolicyParams): Promise<PreUpdateOutcome> {
  if (params.skip) return { kind: 'skipped', reason: 'opt-out' };
  const oldCompose = (params.composeVersion ?? '').trim() === '';
  let bucket: BackupBucket | null = null;
  try {
    bucket = params.makeBucket();
  } catch (err) {
    params.logger.warn(
      `[pre-update-backup] object storage credentials are not usable (${describeError(err)}); no bucket`,
    );
  }
  if (bucket?.localPath) {
    const onVolume = params.isOnVolume ?? params.isMountPoint;
    let persistent = false;
    try {
      persistent = await onVolume(bucket.localPath);
    } catch {
      // unreadable mountinfo = not a volume
    }
    if (persistent) {
      params.logger.warn(
        `[pre-update-backup] the backups live on the local storage volume (${bucket.localPath}), the same disk as the application files: they survive container updates but not the loss of that disk. Configure an external backup target under Admin > Backups.`,
      );
    } else {
      params.logger.warn(
        `[pre-update-backup] ${bucket.localPath} is not on a mounted volume; it is not used (it would live inside the container and vanish with it)`,
      );
      bucket.destroy();
      bucket = null;
    }
  }
  let localDir: string | null = null;
  if (params.localDir) {
    try {
      if (await params.isMountPoint(params.localDir)) localDir = params.localDir;
    } catch {
      // unreadable mountinfo = not a mount
    }
    if (!localDir) {
      params.logger.warn(
        `[pre-update-backup] ${params.localDir} is not a mounted volume; it is not used (it would live inside the container and vanish with it)`,
      );
    }
  }
  const skippedOldCompose = (cause: string): PreUpdateOutcome => {
    params.logger.warn(
      `[pre-update-backup] WARNING: pre-update backup SKIPPED (${cause}) - this docker-compose.yml is from an older release (no storage credentials / backup volume for the migrate service). Download the current docker-compose.yml of this release or run tix-update.sh to get the automatic backup before database updates.`,
    );
    return { kind: 'skipped', reason: 'old-compose' };
  };
  if (!bucket && !localDir) {
    if (oldCompose) return skippedOldCompose('no usable backup target');
    throw new Error(
      'No place to store the pre-update backup (object storage not reachable or not configured, no mounted pre-update-backups volume)',
    );
  }
  try {
    return { kind: 'created', result: await params.create({ bucket, localDir }) };
  } catch (err) {
    // An old compose file cannot guarantee a working target (inline credentials, storage not up
    // yet, no volume): never brick it. A new compose file must be able to back up, so it fails.
    if (oldCompose) return skippedOldCompose(describeError(err));
    throw err;
  } finally {
    bucket?.destroy();
  }
}
