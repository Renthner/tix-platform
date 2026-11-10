import {
  BACKUP_JOBS,
  BACKUP_TICK_INTERVAL_MS,
  RestoreRejectedError,
  createMaintenanceProbe,
  createProgress,
  describeError,
  importUploadedBackup,
  RESTORE_REQUEST_TTL_SECONDS,
  reportBusy,
  incomingDirectory,
  releaseRestoreRequest,
  restoreBackup,
  runBackupJob,
  runBackupTick,
  toolMajorVersion,
  verifyBackup,
  withOperationLock,
  type BackupKind,
  type BackupRuntime,
} from '@tix/core';
import { QUEUE_NAMES } from '@tix/redis';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import type { Logger } from '../logger';
import type { ProcessorRegistration, WorkerDeps } from './index';

const PAUSE_RECHECK_MS = 30_000;
/** Progress is re-announced while one long step runs (UI marks silent operations as stalled). */
const KEEPALIVE_MS = 30_000;

export function createBackupsProcessor(rt: BackupRuntime) {
  return async (job: Job): Promise<unknown> => {
    const { ctx } = rt;
    switch (job.name) {
      case BACKUP_JOBS.tick:
        return runBackupTick(rt);

      case BACKUP_JOBS.create: {
        const data = job.data as { kind?: BackupKind; userId?: string | null };
        return runBackupJob(rt, { kind: data.kind ?? 'MANUAL', userId: data.userId ?? null });
      }

      case BACKUP_JOBS.verify: {
        const { backupId } = job.data as { backupId: string };
        const progress = createProgress(ctx, 'VERIFY', backupId);
        const keepalive = setInterval(
          () => void progress.touch().catch(() => undefined),
          KEEPALIVE_MS,
        );
        try {
          const run = await withOperationLock(ctx, async () => {
            try {
              const result = await verifyBackup(rt, backupId, progress);
              if (result.status === 'OK') await progress.succeeded();
              else await progress.failed('VERIFY_FAILED', result.detail ?? 'FAILED');
              return result;
            } catch (err) {
              await progress.failed('FAILED', describeError(err));
              throw err;
            }
          });
          if (run.ran) return run.value;
          await reportBusy(ctx, 'VERIFY', backupId);
          return { busy: true };
        } finally {
          clearInterval(keepalive);
        }
      }

      case BACKUP_JOBS.restore: {
        // A restore is never executed twice: no retry, no re-run of a stalled job.
        if (job.attemptsStarted > 1 || (job.stalledCounter ?? 0) > 0) {
          await releaseRestoreRequest(ctx).catch(() => undefined);
          throw new UnrecoverableError(
            'Restore job was interrupted and is not re-run automatically',
          );
        }
        const { backupId, userId, requestedAt } = job.data as {
          backupId: string;
          userId: string | null;
          requestedAt?: number;
        };
        // The admin confirmed this restore a while ago: an old job must never run unattended.
        if (!requestedAt || Date.now() - requestedAt > RESTORE_REQUEST_TTL_SECONDS * 1000) {
          await releaseRestoreRequest(ctx);
          throw new UnrecoverableError('Restore request expired');
        }
        const progress = createProgress(ctx, 'RESTORE', backupId);
        const keepalive = setInterval(
          () => void progress.touch().catch(() => undefined),
          KEEPALIVE_MS,
        );
        try {
          const run = await withOperationLock(ctx, async () => {
            try {
              const result = await restoreBackup(rt, { backupId, userId, progress });
              await progress.succeeded();
              return result;
            } catch (err) {
              const rejected = err instanceof RestoreRejectedError;
              await progress.failed(
                rejected ? `REJECTED_${err.code}` : 'FAILED',
                describeError(err),
              );
              if (rejected) throw new UnrecoverableError(err.message);
              throw err;
            }
          });
          if (run.ran) return run.value;
          await reportBusy(ctx, 'RESTORE', backupId);
          return { busy: true };
        } finally {
          clearInterval(keepalive);
          await releaseRestoreRequest(ctx).catch(() => undefined);
        }
      }

      case BACKUP_JOBS.import: {
        const { uploadId, userId } = job.data as { uploadId: string; userId: string | null };
        const progress = createProgress(ctx, 'IMPORT', uploadId);
        const run = await withOperationLock(ctx, async () => {
          try {
            await progress.step('VALIDATE');
            const manifest = await importUploadedBackup(rt, uploadId, userId);
            await progress.succeeded();
            return { id: manifest.id };
          } catch (err) {
            await progress.failed('IMPORT_FAILED', describeError(err));
            throw err;
          }
        });
        if (run.ran) return run.value;
        // Not started: the uploaded file would stay behind (swept only after 24 h).
        await rt.buckets.backups.deletePrefix(incomingDirectory(uploadId)).catch(() => undefined);
        await reportBusy(ctx, 'IMPORT', uploadId);
        return { busy: true };
      }

      default:
        rt.logger.warn({ job: job.name }, 'unknown backups job');
        return null;
    }
  };
}

export function backupsRegistration(rt: BackupRuntime): ProcessorRegistration {
  return {
    queue: QUEUE_NAMES.backups,
    concurrency: 1,
    processor: createBackupsProcessor(rt),
    schedulers: [{ name: BACKUP_JOBS.tick, everyMs: BACKUP_TICK_INTERVAL_MS }],
  };
}

/**
 * Pauses every other queue while a restore runs: the job is pushed back by 30 s (no slot is
 * held, nothing is lost) and runs again once the flag is gone. The flag has a TTL, so a dead
 * worker cannot pause the system forever.
 */
export function withMaintenancePause(deps: WorkerDeps, registrations: ProcessorRegistration[]) {
  const probe = createMaintenanceProbe(deps.core);
  return registrations.map((registration): ProcessorRegistration => {
    if (registration.queue === QUEUE_NAMES.backups) return registration;
    const inner = registration.processor;
    return {
      ...registration,
      processor: async (job: Job, token?: string) => {
        if (await probe()) {
          await job.moveToDelayed(Date.now() + PAUSE_RECHECK_MS, token);
          throw new DelayedError();
        }
        return inner(job, token);
      },
    };
  });
}

/** Startup check: the PostgreSQL client tools should match the server's major version. */
export async function warnOnPgToolMismatch(
  rt: BackupRuntime,
  serverVersionNum: number,
  logger: Logger,
): Promise<void> {
  const [dump, restore] = await Promise.all([
    toolMajorVersion(rt.pg.dump),
    toolMajorVersion(rt.pg.restore),
  ]);
  const server = Math.floor(serverVersionNum / 10_000);
  if (dump === null || restore === null) {
    logger.warn(
      {},
      'pg_dump / pg_restore not found: backups will fail until the image provides them',
    );
  } else if (dump < server) {
    logger.warn(
      { pgDump: dump, server },
      'pg_dump is older than the PostgreSQL server: backups will fail',
    );
  }
}
