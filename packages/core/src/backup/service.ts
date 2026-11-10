import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { DomainError, requireCapability, type CoreContext } from '../context';
import { QUEUE_NAMES } from '@tix/redis';
import { getSetting } from '../settings';
import { listCatalogue, writeBackupState } from './catalogue';
import { createBackup, uploadToExternal, type CreateBackupResult } from './create';
import { inspectArchive } from './inspect';
import {
  BACKUP_PREFIX,
  archiveKey,
  backupManifestSchema,
  incomingDirectory,
  manifestKey,
  type BackupKind,
  type BackupManifest,
} from './manifest';
import { sendBackupAlert, describeError, type BackupRuntime } from './runtime';
import { isBackupDue, latestScheduledSlot } from './schedule';
import {
  clearBackupFailure,
  createProgress,
  getBackupFailure,
  getRestoreIncomplete,
  type BackupOperation,
  getMaintenance,
  isMaintenanceActive,
  isStatusStale,
  readStatus,
  recordBackupFailure,
  withOperationLock,
} from './state';

/** Jobs of the `backups` queue. */
export const BACKUP_JOBS = {
  /** `{ kind: 'MANUAL', userId }` – full backup now. */
  create: 'create-backup',
  /** `{ backupId }` – verification (checksum + test restore). */
  verify: 'verify-backup',
  /** `{ backupId, userId }` – restore (authorised by the web action beforehand). */
  restore: 'restore-backup',
  /** `{ uploadId, userId }` – validates an uploaded archive and adds it to the catalogue. */
  import: 'import-backup',
  /** Every minute: starts the scheduled backup when it is due. */
  tick: 'backup-tick',
} as const;

export const BACKUP_TICK_INTERVAL_MS = 60_000;

/** Enqueued with a single attempt: a restore must never be retried automatically. */
const SINGLE_ATTEMPT = { attempts: 1, removeOnComplete: 100, removeOnFail: 100 } as const;

/**
 * Throws BACKUP_BUSY while another operation runs, a restore holds the maintenance flag, or an
 * unfinished restore left its marker (then only a restore may be started: `allowIncompleteRestore`).
 */
export async function assertBackupIdle(
  ctx: CoreContext,
  options: { allowIncompleteRestore?: boolean } = {},
): Promise<void> {
  const [status, maintenance, marker] = await Promise.all([
    readStatus(ctx),
    getMaintenance(ctx),
    getRestoreIncomplete(ctx),
  ]);
  if (
    maintenance ||
    (marker && !options.allowIncompleteRestore) ||
    (status && status.state === 'RUNNING' && !isStatusStale(status))
  ) {
    throw new DomainError('BACKUP_BUSY', 'Another backup operation is running', 409);
  }
}

/** The operation could not start because another one holds the lock: make that visible. */
export async function reportBusy(
  ctx: CoreContext,
  operation: BackupOperation,
  backupId: string | null,
): Promise<void> {
  const current = await readStatus(ctx);
  // The running operation owns the status (and is visible already); only fill a silent gap.
  if (current && current.state === 'RUNNING' && !isStatusStale(current)) return;
  await createProgress(ctx, operation, backupId).failed(
    'BUSY',
    'Another backup operation was running; please try again.',
  );
}

export async function requestBackup(ctx: CoreContext, userId: string): Promise<void> {
  await assertBackupIdle(ctx);
  await requireCapability(ctx, 'jobs').add(
    QUEUE_NAMES.backups,
    BACKUP_JOBS.create,
    { kind: 'MANUAL', userId },
    SINGLE_ATTEMPT,
  );
}

export async function requestVerify(ctx: CoreContext, backupId: string): Promise<void> {
  await assertBackupIdle(ctx);
  await requireCapability(ctx, 'jobs').add(
    QUEUE_NAMES.backups,
    BACKUP_JOBS.verify,
    { backupId },
    SINGLE_ATTEMPT,
  );
}

export async function requestRestore(
  ctx: CoreContext,
  backupId: string,
  userId: string,
): Promise<void> {
  await assertBackupIdle(ctx, { allowIncompleteRestore: true });
  // At most one queued restore at a time (also against double clicks / replays).
  const claimed = await ctx.redis.set(
    ctx.keys.restoreRequest(),
    randomUUID(),
    'EX',
    RESTORE_REQUEST_TTL_SECONDS,
    'NX',
  );
  if (claimed !== 'OK') throw new DomainError('BACKUP_BUSY', 'A restore is already queued', 409);
  try {
    await requireCapability(ctx, 'jobs').add(
      QUEUE_NAMES.backups,
      BACKUP_JOBS.restore,
      { backupId, userId, requestedAt: Date.now() },
      SINGLE_ATTEMPT,
    );
  } catch (err) {
    await ctx.redis.del(ctx.keys.restoreRequest());
    throw err;
  }
}

/** A restore request older than this is dropped by the worker (an admin confirmed it back then). */
export const RESTORE_REQUEST_TTL_SECONDS = 600;

export async function releaseRestoreRequest(
  ctx: Pick<CoreContext, 'redis' | 'keys'>,
): Promise<void> {
  await ctx.redis.del(ctx.keys.restoreRequest());
}

export async function requestImport(
  ctx: CoreContext,
  uploadId: string,
  userId: string,
): Promise<void> {
  await assertBackupIdle(ctx);
  await requireCapability(ctx, 'jobs').add(
    QUEUE_NAMES.backups,
    BACKUP_JOBS.import,
    { uploadId, userId },
    SINGLE_ATTEMPT,
  );
}

export const newUploadId = (): string => randomUUID();

/** What a restore would discard: rows created in the live database after the backup was made. */
export interface RestoreLoss {
  orders: number;
  invoices: number;
  payments: number;
  refunds: number;
  /** Rows that existed at backup time but were changed since (e.g. an order that got paid). */
  updated: { orders: number; payments: number; refunds: number };
}

export async function countRestoreLoss(
  ctx: Pick<CoreContext, 'db'>,
  since: string,
): Promise<RestoreLoss> {
  const when = new Date(since);
  const count = async (table: 'orders' | 'invoices' | 'payments' | 'refunds') => {
    const res = await ctx.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM ${sql.identifier(table)} WHERE created_at > ${when}`,
    );
    return Number(res.rows[0]?.n ?? 0);
  };
  const changed = async (table: 'orders' | 'payments' | 'refunds') => {
    const res = await ctx.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM ${sql.identifier(table)} WHERE created_at <= ${when} AND updated_at > ${when}`,
    );
    return Number(res.rows[0]?.n ?? 0);
  };
  const [orders, invoices, payments, refunds, uo, up, ur] = await Promise.all([
    count('orders'),
    count('invoices'),
    count('payments'),
    count('refunds'),
    changed('orders'),
    changed('payments'),
    changed('refunds'),
  ]);
  return {
    orders,
    invoices,
    payments,
    refunds,
    updated: { orders: uo, payments: up, refunds: ur },
  };
}

/** Result of a backup run for the caller (job processor). */
export async function runBackupJob(
  rt: BackupRuntime,
  params: {
    kind: BackupKind;
    userId: string | null;
    /** Called once the operation lock is held (before anything is written). */
    onStart?: () => Promise<void>;
  },
): Promise<CreateBackupResult | { busy: true }> {
  const progress = createProgress(rt.ctx, 'BACKUP', null);
  const run = await withOperationLock(rt.ctx, async () => {
    // Liveness while one long step runs (the UI marks silent operations as stalled).
    const keepalive = setInterval(() => void progress.touch().catch(() => undefined), 30_000);
    try {
      await params.onStart?.();
      const result = await createBackup(rt, { kind: params.kind, userId: params.userId, progress });
      await progress.succeeded();
      return result;
    } catch (err) {
      await progress.failed('FAILED', describeError(err));
      throw err;
    } finally {
      clearInterval(keepalive);
    }
  });
  return run.ran ? run.value : { busy: true };
}

/**
 * Scheduler tick (every minute, one run per interval across all workers): starts the scheduled
 * backup when due, reports failures on the dashboard (Redis) and by e-mail.
 */
export async function runBackupTick(
  rt: BackupRuntime,
  now = new Date(),
): Promise<'idle' | 'ran' | 'failed' | 'busy'> {
  const [settings, general] = await Promise.all([
    getSetting(rt.ctx, 'backup'),
    getSetting(rt.ctx, 'general'),
  ]);
  if (!settings.scheduleEnabled) return 'idle';
  if (await isMaintenanceActive(rt.ctx)) return 'idle';
  await sweepIncomingUploads(rt).catch((err) =>
    rt.logger.warn({ err: describeError(err) }, 'sweeping incomplete uploads failed'),
  );
  const catalogue = await listCatalogue(rt.buckets.backups);
  const lastScheduled = catalogue.find((e) => e.manifest.kind === 'SCHEDULED');
  // A failed attempt leaves no catalogue entry: remember attempts to avoid a retry storm.
  const attemptKey = `${rt.ctx.keys.prefix}:backup:last-attempt`;
  const attempted = await rt.ctx.redis.get(attemptKey);
  const lastAttempt = Math.max(
    lastScheduled ? Date.parse(lastScheduled.manifest.createdAt) : 0,
    attempted ? Number(attempted) : 0,
  );
  const last = lastAttempt > 0 ? new Date(lastAttempt) : null;
  if (!isBackupDue(settings, general.defaultTimeZone, now, last)) {
    // A slot that passed without any attempt and is too old to catch up was missed entirely.
    const slot = latestScheduledSlot(settings, general.defaultTimeZone, now);
    if (!last || last.getTime() < slot.getTime()) {
      const missed = 'Scheduled backup missed ' + slot.toISOString();
      const known = await getBackupFailure(rt.ctx);
      if (known?.message !== missed) {
        await recordBackupFailure(rt.ctx, { at: new Date().toISOString(), message: missed });
        if (settings.alertEmail) {
          await sendBackupAlert(rt.ctx, settings.alertEmail, missed).catch(() => undefined);
        }
      }
    }
    return 'idle';
  }

  let failure: string | null = null;
  const outcome = await runBackupJob(rt, {
    kind: 'SCHEDULED',
    userId: null,
    // Marked only once the lock is held: when another operation is running the slot is retried
    // on the next tick instead of being lost.
    onStart: async () => {
      await rt.ctx.redis.set(attemptKey, String(now.getTime()), 'EX', 8 * 24 * 3600);
    },
  }).catch((err) => {
    failure = describeError(err);
    return null;
  });
  if (outcome && 'busy' in outcome) return 'busy';
  if (outcome?.externalError) failure = `External upload failed: ${outcome.externalError}`;
  if (failure) {
    await recordBackupFailure(rt.ctx, { at: new Date().toISOString(), message: failure });
    if (settings.alertEmail) {
      await sendBackupAlert(rt.ctx, settings.alertEmail, failure).catch((err) =>
        rt.logger.warn({ err: describeError(err) }, 'backup alert e-mail could not be sent'),
      );
    }
    return 'failed';
  }
  await clearBackupFailure(rt.ctx);
  return 'ran';
}

/**
 * Validates an uploaded archive (full decryption pass), then registers it in the catalogue.
 * The file already sits in `backups/incoming-<uploadId>/archive.tixbak`; on any problem it is deleted.
 */
export async function importUploadedBackup(
  rt: BackupRuntime,
  uploadId: string,
  userId: string | null,
): Promise<BackupManifest> {
  const directory = incomingDirectory(uploadId);
  const bucket = rt.buckets.backups;
  try {
    const source = await bucket.getStream(archiveKey(directory));
    const inspected = await inspectArchive(source.stream, rt.keyRing);
    const manifest = backupManifestSchema.parse({
      ...inspected.manifest,
      id: uploadId,
      kind: 'MANUAL',
      originalId: inspected.manifest.id,
      createdByUserId: userId,
      archive: { sizeBytes: inspected.sizeBytes, sha256: inspected.sha256 },
      database: { dumpBytes: inspected.dumpBytes },
      files: inspected.files,
    });
    await bucket.putBytes(manifestKey(directory), JSON.stringify(manifest), 'application/json');
    await writeBackupState(bucket, directory, { external: { status: 'NONE' } });
    const external = await uploadToExternal(rt, manifest, directory);
    if (external.state.external.status !== 'NONE') {
      await writeBackupState(bucket, directory, external.state);
    }
    return manifest;
  } catch (err) {
    await bucket.deletePrefix(directory).catch(() => undefined);
    throw err;
  }
}

const INCOMING_MAX_AGE_MS = 24 * 3_600_000;

/** Deletes upload leftovers (incoming-* directories without manifest) older than 24 h; hourly. */
export async function sweepIncomingUploads(rt: BackupRuntime): Promise<number> {
  const gate = await rt.ctx.redis.set(
    rt.ctx.keys.mutex('backup-incoming-sweep'),
    '1',
    'EX',
    3_600,
    'NX',
  );
  if (gate !== 'OK') return 0;
  const bucket = rt.buckets.backups;
  const dirs = new Map<string, { manifest: boolean; newest: number }>();
  for await (const object of bucket.list(BACKUP_PREFIX + 'incoming-')) {
    const dir = object.key.slice(0, object.key.indexOf('/', BACKUP_PREFIX.length) + 1);
    const entry = dirs.get(dir) ?? { manifest: false, newest: 0 };
    if (object.key.endsWith('/manifest.json')) entry.manifest = true;
    entry.newest = Math.max(entry.newest, object.lastModified?.getTime() ?? 0);
    dirs.set(dir, entry);
  }
  let removed = 0;
  for (const [dir, info] of dirs) {
    if (!info.manifest && Date.now() - info.newest > INCOMING_MAX_AGE_MS) {
      await bucket.deletePrefix(dir);
      removed += 1;
    }
  }
  return removed;
}
