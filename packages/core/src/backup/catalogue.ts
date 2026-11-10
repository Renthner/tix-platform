import { DomainError } from '../context';
import { getSetting } from '../settings';
import {
  BACKUP_PREFIX,
  backupManifestSchema,
  backupStateSchema,
  manifestKey,
  stateKey,
  type BackupManifest,
  type BackupState,
} from './manifest';
import { loadExternalTarget, type BackupLogger, type BackupRuntime } from './runtime';
import type { S3Bucket } from './s3';
import { newestVerifiedId, selectBackupsToDelete } from './schedule';

/** The catalogue lives in the bucket: one directory with manifest.json + state.json per backup. */
export interface CatalogueEntry {
  directory: string;
  manifest: BackupManifest;
  state: BackupState;
}

async function readEntry(
  bucket: S3Bucket,
  directory: string,
  rootPrefix: string,
): Promise<CatalogueEntry | null> {
  const [manifestRaw, stateRaw] = await Promise.all([
    bucket.tryGetBytes(manifestKey(directory)),
    bucket.tryGetBytes(stateKey(directory)),
  ]);
  if (!manifestRaw) return null; // still being written, or a failed upload
  try {
    const manifest = backupManifestSchema.parse(JSON.parse(manifestRaw.toString('utf8')));
    const state = backupStateSchema.parse(stateRaw ? JSON.parse(stateRaw.toString('utf8')) : {});
    return { directory: directory.slice(rootPrefix.length), manifest, state };
  } catch {
    return null;
  }
}

/** All completed backups of a bucket (`rootPrefix` = key prefix of the catalogue), newest first. */
export async function listCatalogue(bucket: S3Bucket, rootPrefix = ''): Promise<CatalogueEntry[]> {
  const dirs = await bucket.listDirectories(`${rootPrefix}${BACKUP_PREFIX}`);
  const entries = (await Promise.all(dirs.map((d) => readEntry(bucket, d, rootPrefix)))).filter(
    (e): e is CatalogueEntry => e !== null,
  );
  return entries.sort(
    (a, b) => Date.parse(b.manifest.createdAt) - Date.parse(a.manifest.createdAt),
  );
}

export async function findBackup(bucket: S3Bucket, id: string): Promise<CatalogueEntry | null> {
  return (await listCatalogue(bucket)).find((e) => e.manifest.id === id) ?? null;
}

export async function writeBackupState(
  bucket: S3Bucket,
  directory: string,
  state: BackupState,
  rootPrefix = '',
): Promise<void> {
  await bucket.putBytes(
    `${rootPrefix}${stateKey(directory)}`,
    JSON.stringify(state),
    'application/json',
  );
}

/**
 * Deletes one backup from the local bucket (and the external target when `deleteExternal`).
 * The newest backup with a successful verification is protected: it is the last known good one.
 */
export async function deleteBackup(
  rt: Pick<BackupRuntime, 'ctx' | 'buckets' | 'logger'>,
  id: string,
  options: { deleteExternal?: boolean } = {},
): Promise<boolean> {
  const catalogue = await listCatalogue(rt.buckets.backups);
  const entry = catalogue.find((e) => e.manifest.id === id);
  if (!entry) return false;
  const protectedId = newestVerifiedId(
    catalogue.map((e) => ({
      id: e.manifest.id,
      kind: e.manifest.kind,
      createdAt: e.manifest.createdAt,
      verifiedOk: e.state.verify?.status === 'OK',
    })),
  );
  if (protectedId === id) {
    throw new DomainError('BACKUP_PROTECTED', 'The newest verified backup cannot be deleted', 409);
  }
  await rt.buckets.backups.deletePrefix(entry.directory);
  if (options.deleteExternal) {
    const external = await loadExternalTarget(rt.ctx).catch(() => null);
    if (external) {
      try {
        await external.bucket.deletePrefix(`${external.prefix}${entry.directory}`);
      } catch (err) {
        rt.logger.warn({ err, id }, 'external backup copy could not be deleted');
      } finally {
        external.bucket.destroy();
      }
    }
  }
  return true;
}

async function applyTo(
  bucket: S3Bucket,
  rootPrefix: string,
  keep: { scheduled: number; manualMaxAgeDays: number },
  logger: BackupLogger,
  /** Backup that must survive even if this target's own view would not protect it. */
  alsoProtect: string | null = null,
): Promise<{ deleted: number; protectedId: string | null }> {
  const entries = await listCatalogue(bucket, rootPrefix);
  const candidates = entries.map((e) => ({
    id: e.manifest.id,
    kind: e.manifest.kind,
    createdAt: e.manifest.createdAt,
    verifiedOk: e.state.verify?.status === 'OK',
  }));
  const protectedId = newestVerifiedId(candidates);
  const doomed = new Set(selectBackupsToDelete(candidates, keep));
  if (alsoProtect) doomed.delete(alsoProtect);
  let deleted = 0;
  for (const entry of entries) {
    if (!doomed.has(entry.manifest.id)) continue;
    try {
      await bucket.deletePrefix(`${rootPrefix}${entry.directory}`);
      deleted += 1;
    } catch (err) {
      logger.warn({ err, id: entry.manifest.id }, 'retention: backup could not be deleted');
    }
  }
  return { deleted, protectedId };
}

/**
 * Retention on both targets: the newest N scheduled backups stay; manual and safety backups stay
 * unless `manualMaxAgeDays` is set; the newest verified backup always stays (on the external
 * target the LOCAL protected id is protected as well).
 */
export async function applyRetention(
  rt: Pick<BackupRuntime, 'ctx' | 'buckets' | 'logger'>,
): Promise<{ local: number; external: number }> {
  const settings = await getSetting(rt.ctx, 'backup');
  const keep = { scheduled: settings.keepScheduled, manualMaxAgeDays: settings.manualMaxAgeDays };
  const localRun = await applyTo(rt.buckets.backups, '', keep, rt.logger);
  const local = localRun.deleted;
  let external = 0;
  const target = await loadExternalTarget(rt.ctx).catch(() => null);
  if (target) {
    try {
      external = (
        await applyTo(target.bucket, target.prefix, keep, rt.logger, localRun.protectedId)
      ).deleted;
    } catch (err) {
      rt.logger.warn({ err }, 'retention on the external target failed');
    } finally {
      target.bucket.destroy();
    }
  }
  return { local, external };
}
