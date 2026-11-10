import { randomUUID } from 'node:crypto';
import { PgClient } from '@tix/db';
import { writeArchive, type ArchiveEntry } from './archive';
import { applyRetention, writeBackupState } from './catalogue';
import { encryptStream } from './crypto';
import {
  ARCHIVE_DUMP,
  ARCHIVE_FILES_PREFIX,
  ARCHIVE_MANIFEST,
  BACKUP_FORMAT_VERSION,
  archiveKey,
  backupDirectory,
  manifestKey,
  type BackupKind,
  type BackupManifest,
  type BackupState,
} from './manifest';
import { pgDumpStream, readMigrationInfo, readRowCounts } from './pg';
import { describeError, loadExternalTarget, type BackupRuntime } from './runtime';
import type { Progress } from './state';

export interface CreateBackupResult {
  manifest: BackupManifest;
  directory: string;
  /** Set when the backup exists locally but the external upload failed. */
  externalError?: string;
}

/**
 * Full backup: PostgreSQL (pg_dump -Fc inside one exported snapshot, so row counts and dump
 * agree) + every object of the assets and documents buckets, as one encrypted archive in the
 * backups bucket, then (optionally) a copy on the external S3 target. Streams end to end.
 */
export async function createBackup(
  rt: BackupRuntime,
  params: {
    kind: BackupKind;
    userId: string | null;
    progress: Progress;
    /** Apply the retention rules afterwards (default). A restore skips it to keep its source. */
    retention?: boolean;
  },
): Promise<CreateBackupResult> {
  const { progress } = params;
  const active = rt.keyRing[0];
  if (!active) throw new Error('The key ring is empty');
  await progress.step('SNAPSHOT');

  const snapshotClient = new PgClient({
    connectionString: rt.databaseUrl,
    application_name: 'tix-backup-snapshot',
  });
  snapshotClient.on('error', () => undefined);
  await snapshotClient.connect();

  try {
    await snapshotClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (
      await snapshotClient.query<{ snapshot: string }>('SELECT pg_export_snapshot() AS snapshot')
    ).rows[0]!.snapshot;
    // One client = one query at a time.
    const rowCounts = await readRowCounts(snapshotClient);
    const lastMigration = await readMigrationInfo(snapshotClient, rt.migrationsDir);
    const version = await snapshotClient.query<{ server_version: string }>('SHOW server_version');

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const inner: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      id,
      kind: params.kind,
      createdAt,
      appVersion: rt.appVersion,
      lastMigration,
      postgresVersion: version.rows[0]!.server_version,
      encryption: { algorithm: 'AES-256-GCM-STREAM', keyId: active.id },
      rowCounts,
      createdByUserId: params.userId,
    };
    const directory = backupDirectory(inner);

    const stats = {
      dumpBytes: 0,
      assets: { objects: 0, bytes: 0 },
      documents: { objects: 0, bytes: 0 },
    };

    async function* entries(): AsyncGenerator<ArchiveEntry> {
      yield {
        header: { name: ARCHIVE_MANIFEST, contentType: 'application/json' },
        data: (async function* () {
          yield Buffer.from(JSON.stringify(inner));
        })(),
      };
      await progress.step('DATABASE');
      yield {
        header: { name: ARCHIVE_DUMP },
        data: (async function* () {
          for await (const chunk of pgDumpStream(rt.pg, rt.databaseUrl, snapshot)) {
            stats.dumpBytes += chunk.length;
            yield chunk;
          }
        })(),
      };
      for (const area of ['assets', 'documents'] as const) {
        await progress.step(area === 'assets' ? 'FILES_ASSETS' : 'FILES_DOCUMENTS');
        for await (const object of rt.buckets[area].list('')) {
          let download: Awaited<ReturnType<typeof rt.buckets.assets.getStream>>;
          try {
            download = await rt.buckets[area].getStream(object.key);
          } catch (err) {
            // Deleted between listing and download: it is not part of the backup.
            if ((err as { name?: string }).name === 'NoSuchKey') continue;
            throw err;
          }
          stats[area].objects += 1;
          yield {
            header: {
              name: `${ARCHIVE_FILES_PREFIX}${area}/${object.key}`,
              contentType: download.contentType,
              size: object.size,
            },
            data: (async function* () {
              for await (const chunk of download.stream) {
                stats[area].bytes += chunk.byteLength;
                yield chunk;
              }
            })(),
          };
        }
      }
    }

    const written = await rt.buckets.backups.putStream(
      archiveKey(directory),
      encryptStream(writeArchive(entries()), active),
    );
    await snapshotClient.query('ROLLBACK');

    const manifest: BackupManifest = {
      ...inner,
      archive: { sizeBytes: written.sizeBytes, sha256: written.sha256 },
      database: { dumpBytes: stats.dumpBytes },
      files: {
        assets: stats.assets,
        documents: stats.documents,
      },
    };
    await rt.buckets.backups.putBytes(
      manifestKey(directory),
      JSON.stringify(manifest),
      'application/json',
    );
    let state: BackupState = { external: { status: 'NONE' } };
    await writeBackupState(rt.buckets.backups, directory, state);

    const result: CreateBackupResult = { manifest, directory };
    await progress.step('EXTERNAL');
    const externalError = await uploadToExternal(rt, manifest, directory);
    state = externalError.state;
    if (externalError.error) result.externalError = externalError.error;
    if (state.external.status !== 'NONE') {
      await writeBackupState(rt.buckets.backups, directory, state);
    }

    if (params.retention !== false) {
      await progress.step('RETENTION');
      await applyRetention(rt).catch((err) =>
        rt.logger.warn({ err }, 'backup retention failed (backup itself succeeded)'),
      );
    }
    return result;
  } finally {
    await snapshotClient.query('ROLLBACK').catch(() => undefined);
    await snapshotClient.end().catch(() => undefined);
  }
}

/** Copies archive + manifest (+ state) to the external target when it is enabled. */
export async function uploadToExternal(
  rt: BackupRuntime,
  manifest: BackupManifest,
  directory: string,
): Promise<{ state: BackupState; error?: string }> {
  let target;
  try {
    target = await loadExternalTarget(rt.ctx);
  } catch (err) {
    const error = describeError(err);
    return {
      state: { external: { status: 'FAILED', at: new Date().toISOString(), error } },
      error,
    };
  }
  if (!target) return { state: { external: { status: 'NONE' } } };
  try {
    const source = await rt.buckets.backups.getStream(archiveKey(directory));
    const written = await target.bucket.putStream(
      `${target.prefix}${archiveKey(directory)}`,
      source.stream,
    );
    if (manifest.archive && written.sha256 !== manifest.archive.sha256) {
      await target.bucket.deletePrefix(`${target.prefix}${directory}`).catch(() => undefined);
      throw new Error('Checksum mismatch after the external upload');
    }
    await target.bucket.putBytes(
      `${target.prefix}${manifestKey(directory)}`,
      JSON.stringify(manifest),
      'application/json',
    );
    return { state: { external: { status: 'UPLOADED', at: new Date().toISOString() } } };
  } catch (err) {
    const error = describeError(err);
    rt.logger.warn({ err, id: manifest.id }, 'external backup upload failed');
    return {
      state: { external: { status: 'FAILED', at: new Date().toISOString(), error } },
      error,
    };
  } finally {
    target.bucket.destroy();
  }
}
