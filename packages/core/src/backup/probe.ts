import { randomBytes, randomUUID } from 'node:crypto';
import { auditLogs } from '@tix/db';
import type { SettingValue } from '@tix/shared';
import { z } from 'zod';
import { getSetting } from '../settings';
import { listCatalogue } from './catalogue';
import { dropStaleTestDatabases, testDatabaseName, verifyBackup } from './verify';
import { BACKUP_PREFIX } from './manifest';
import { describeError, type BackupRuntime } from './runtime';
import { isBackupDue, type ScheduleConfig } from './schedule';
import type { BackupBucket } from './bucket';
import {
  createProgress,
  getRestoreIncomplete,
  isMaintenanceActive,
  isStatusStale,
  readStatus,
  withOperationLock,
} from './state';

/* Automatic probe restore: the newest backup is restored into a throwaway database, migrated to
 * the current structure and sanity-checked. It reuses the VERIFY code (`verifyBackup`, deep mode),
 * so there is exactly one restore path for tests. The live database is never touched. */

/** A failed probe is retried after this long (not on the next tick, a restore is heavy). */
export const PROBE_RETRY_AFTER_MS = 6 * 3_600_000;
/**
 * Failure reasons a retry cannot fix (missing privilege, backup from a newer version): they wait
 * for the next regular slot instead of retrying every few hours. The alert stays until a probe passes.
 */
export const PROBE_PERMANENT_ERRORS = ['CREATEDB_MISSING', 'MIGRATION_NEWER'] as const;
export const isPermanentProbeError = (error: string | undefined): boolean =>
  error !== undefined && PROBE_PERMANENT_ERRORS.some((code) => error.startsWith(code));
/** Entries kept in the history file. */
export const PROBE_HISTORY_MAX = 50;
/** History file inside the backups bucket (a file, not a directory: the catalogue ignores it). */
export const PROBE_HISTORY_KEY = `${BACKUP_PREFIX}probe-history.json`;

export const probeEntrySchema = z.object({
  id: z.uuid(),
  trigger: z.enum(['SCHEDULED', 'MANUAL']),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.number().int().min(0),
  status: z.enum(['OK', 'FAILED']),
  backupId: z.uuid().nullable(),
  backupCreatedAt: z.iso.datetime().nullable(),
  /** Stable reason code / short text of the failure (never contains secrets). */
  error: z.string().max(1_000).optional(),
  mismatches: z.array(z.string().max(200)).max(50).optional(),
  counts: z.record(z.string(), z.number().int().min(0)).optional(),
  migrationsApplied: z.number().int().min(0).optional(),
});
export type ProbeEntry = z.infer<typeof probeEntrySchema>;

const historySchema = z.object({ entries: z.array(probeEntrySchema) });

export async function readProbeHistory(bucket: BackupBucket): Promise<ProbeEntry[]> {
  try {
    const raw = await bucket.tryGetBytes(PROBE_HISTORY_KEY);
    if (!raw) return [];
    const parsed = historySchema.safeParse(JSON.parse(raw.toString('utf8')));
    return parsed.success ? parsed.data.entries : [];
  } catch {
    return [];
  }
}

async function appendProbeHistory(bucket: BackupBucket, entry: ProbeEntry): Promise<void> {
  const entries = [entry, ...(await readProbeHistory(bucket))].slice(0, PROBE_HISTORY_MAX);
  await bucket.putBytes(PROBE_HISTORY_KEY, JSON.stringify({ entries }), 'application/json');
}

export type ProbeSettings = Pick<
  SettingValue<'backup'>,
  'probeEnabled' | 'probeFrequency' | 'probeWeekday' | 'probeTime'
>;

export const probeSchedule = (s: ProbeSettings): ScheduleConfig => ({
  frequency: s.probeFrequency,
  weekday: s.probeWeekday,
  time: s.probeTime,
});

/**
 * Whether a scheduled probe must start now. Due when the latest slot has no attempt yet (a late
 * slot is still caught up: the probe is not time critical), or when the last attempt failed and the
 * retry delay passed. `last` = newest attempt (also an interrupted one, counted as failed).
 */
export function isProbeDue(
  settings: ProbeSettings,
  timeZone: string,
  now: Date,
  last: { at: Date; status: 'OK' | 'FAILED'; permanent?: boolean } | null,
): boolean {
  if (!settings.probeEnabled) return false;
  if (
    last?.status === 'FAILED' &&
    !last.permanent &&
    now.getTime() - last.at.getTime() >= PROBE_RETRY_AFTER_MS
  ) {
    return true;
  }
  return isBackupDue(
    probeSchedule(settings),
    timeZone,
    now,
    last?.at ?? null,
    Number.POSITIVE_INFINITY,
  );
}

const attemptKey = (rt: BackupRuntime) => `${rt.ctx.keys.prefix}:backup:probe-attempt`;

export type ProbeOutcome =
  | { ran: true; entry: ProbeEntry }
  | {
      ran: false;
      reason: 'BUSY' | 'MAINTENANCE' | 'RESTORE_QUEUED' | 'NO_BACKUP' | 'DISABLED' | 'NOT_DUE';
    };

/** Newest attempt, from the history and the Redis marker of an attempt that never finished. */
async function lastAttempt(
  rt: BackupRuntime,
  history: readonly ProbeEntry[],
): Promise<{ at: Date; status: 'OK' | 'FAILED'; permanent?: boolean } | null> {
  const fromHistory = history[0]
    ? {
        at: new Date(history[0].startedAt),
        status: history[0].status,
        permanent: isPermanentProbeError(history[0].error),
      }
    : null;
  const raw = await rt.ctx.redis.get(attemptKey(rt));
  const marker = raw && Number.isFinite(Number(raw)) ? new Date(Number(raw)) : null;
  if (marker && (!fromHistory || marker.getTime() > fromHistory.at.getTime())) {
    return { at: marker, status: 'FAILED' }; // started, never finished
  }
  return fromHistory;
}

async function writeAudit(
  rt: BackupRuntime,
  entry: ProbeEntry,
  userId: string | null,
): Promise<void> {
  try {
    await rt.ctx.db.insert(auditLogs).values({
      actorType: 'SYSTEM',
      action: 'backup.probe',
      entityType: 'backup',
      entityId: entry.backupId,
      changes: {
        status: entry.status,
        trigger: entry.trigger,
        durationMs: entry.durationMs,
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.counts ? { counts: entry.counts } : {}),
      },
      metadata: userId ? { requestedByUserId: userId } : null,
    });
  } catch (err) {
    rt.logger.warn({ err: describeError(err) }, 'probe restore audit entry could not be written');
  }
}

/**
 * One probe run: single-flight through the backup operation lock, never during a restore or a
 * running backup operation. The result is stored in the history file, on the backup's `state.json`
 * (verification result) and in the audit log; the alert check reads the history.
 */
export async function runProbe(
  rt: BackupRuntime,
  params: { trigger: 'SCHEDULED' | 'MANUAL'; userId?: string | null },
): Promise<ProbeOutcome> {
  const { ctx } = rt;
  if (await isMaintenanceActive(ctx)) return { ran: false, reason: 'MAINTENANCE' };
  // A confirmed restore is queued: it must not meet a busy lock and be dropped.
  if (
    (await ctx.redis.exists(ctx.keys.restoreRequest())) > 0 ||
    (await getRestoreIncomplete(ctx))
  ) {
    return { ran: false, reason: 'RESTORE_QUEUED' };
  }
  const status = await readStatus(ctx);
  if (status && status.state === 'RUNNING' && !isStatusStale(status)) {
    return { ran: false, reason: 'BUSY' };
  }

  const run = await withOperationLock(ctx, async (): Promise<ProbeOutcome> => {
    const [newest] = await listCatalogue(rt.buckets.backups);
    if (!newest) return { ran: false, reason: 'NO_BACKUP' };
    const started = new Date();
    // Marked once the lock is held: an interrupted run is not retried on every tick.
    await ctx.redis.set(attemptKey(rt), String(started.getTime()), 'EX', 8 * 24 * 3600);
    const progress = createProgress(ctx, 'PROBE', newest.manifest.id);
    const keepalive = setInterval(() => void progress.touch().catch(() => undefined), 30_000);
    let entry: ProbeEntry;
    try {
      await progress.step('CLEANUP');
      await dropStaleTestDatabases(rt).catch((err) =>
        rt.logger.warn({ err: describeError(err) }, 'cleanup of stale test databases failed'),
      );
      const database = testDatabaseName(rt, 'probe', randomBytes(6).toString('hex'));
      let result;
      try {
        result = await verifyBackup(rt, newest.manifest.id, progress, { database, deep: true });
      } catch (err) {
        result = {
          status: 'FAILED' as const,
          at: new Date().toISOString(),
          detail: `PROBE_FAILED: ${describeError(err)}`,
        };
      }
      const finished = new Date();
      entry = {
        id: randomUUID(),
        trigger: params.trigger,
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        status: result.status,
        backupId: newest.manifest.id,
        backupCreatedAt: newest.manifest.createdAt,
        ...(result.detail ? { error: result.detail.slice(0, 1_000) } : {}),
        ...(result.mismatches ? { mismatches: result.mismatches } : {}),
        ...(result.counts ? { counts: result.counts } : {}),
        ...(result.migrationsApplied !== undefined
          ? { migrationsApplied: result.migrationsApplied }
          : {}),
      };
      // Drop leftovers even when the restore step died before its own cleanup (belt and braces).
      await dropStaleTestDatabases(rt).catch(() => undefined);
      await appendProbeHistory(rt.buckets.backups, entry).catch((err) =>
        rt.logger.warn({ err: describeError(err) }, 'probe history could not be written'),
      );
      if (entry.status === 'OK') await progress.succeeded();
      else await progress.failed('VERIFY_FAILED', entry.error ?? 'FAILED');
    } finally {
      clearInterval(keepalive);
    }
    await writeAudit(rt, entry, params.userId ?? null);
    return { ran: true, entry };
  });
  return run.ran ? run.value : { ran: false, reason: 'BUSY' };
}

/** Scheduler tick: starts the scheduled probe when it is due. Never throws. */
export async function runProbeTick(rt: BackupRuntime, now = new Date()): Promise<ProbeOutcome> {
  const [settings, general] = await Promise.all([
    getSetting(rt.ctx, 'backup'),
    getSetting(rt.ctx, 'general'),
  ]);
  if (!settings.probeEnabled) return { ran: false, reason: 'DISABLED' };
  const history = await readProbeHistory(rt.buckets.backups);
  const last = await lastAttempt(rt, history);
  if (!isProbeDue(settings, general.defaultTimeZone, now, last)) {
    return { ran: false, reason: 'NOT_DUE' };
  }
  try {
    return await runProbe(rt, { trigger: 'SCHEDULED' });
  } catch (err) {
    rt.logger.error({ err: describeError(err) }, 'probe restore failed unexpectedly');
    return { ran: false, reason: 'BUSY' };
  }
}
