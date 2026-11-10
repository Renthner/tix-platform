import { randomUUID } from 'node:crypto';
import type { Keyspace, Redis } from '@tix/redis';

type RedisCtx = { redis: Redis; keys: Keyspace };

/* ---------------------------------------------------------------------------------------
 * Maintenance flag. Set for the whole restore; a TTL + heartbeat make it heal itself when the
 * worker dies. Web, realtime and every worker loop / job look at it (see `maintenance-gate`).
 * ------------------------------------------------------------------------------------- */

export interface MaintenanceState {
  reason: 'RESTORE';
  since: string;
  backupId?: string;
}

export const MAINTENANCE_TTL_SECONDS = 60;
export const MAINTENANCE_HEARTBEAT_MS = 15_000;

export async function setMaintenance(ctx: RedisCtx, state: MaintenanceState): Promise<void> {
  await ctx.redis.set(ctx.keys.maintenance(), JSON.stringify(state), 'EX', MAINTENANCE_TTL_SECONDS);
}

export async function clearMaintenance(ctx: RedisCtx): Promise<void> {
  await ctx.redis.del(ctx.keys.maintenance());
}

export async function getMaintenance(ctx: RedisCtx): Promise<MaintenanceState | null> {
  const raw = await ctx.redis.get(ctx.keys.maintenance());
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MaintenanceState;
  } catch {
    return { reason: 'RESTORE', since: new Date(0).toISOString() };
  }
}

/** Keeps the flag alive (re-SET with EX each beat: also recreates it if it was lost). */
export function startMaintenanceHeartbeat(ctx: RedisCtx, state: MaintenanceState): () => void {
  const timer = setInterval(() => {
    setMaintenance(ctx, state).catch(() => undefined);
  }, MAINTENANCE_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Durable marker (no TTL) set right before the restore transaction commits and cleared only
 * after migrations, files, Redis cleanup and the erasure replay succeeded. While it exists the
 * system stays in maintenance mode: the database was replaced but the restore is unfinished.
 */
export interface RestoreIncompleteMarker {
  backupId: string;
  safetyBackupId: string | null;
  at: string;
  /** Step that failed (or the step the worker was in when it stopped). */
  step: string;
  error?: string;
}

export async function setRestoreIncomplete(
  ctx: RedisCtx,
  marker: RestoreIncompleteMarker,
): Promise<void> {
  await ctx.redis.set(ctx.keys.restoreIncomplete(), JSON.stringify(marker));
}

export async function clearRestoreIncomplete(ctx: RedisCtx): Promise<void> {
  await ctx.redis.del(ctx.keys.restoreIncomplete());
}

export async function getRestoreIncomplete(ctx: RedisCtx): Promise<RestoreIncompleteMarker | null> {
  const raw = await ctx.redis.get(ctx.keys.restoreIncomplete());
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RestoreIncompleteMarker;
  } catch {
    return { backupId: '', safetyBackupId: null, at: new Date(0).toISOString(), step: 'UNKNOWN' };
  }
}

/** Maintenance in the sense of "everything but backups pauses": flag OR incomplete restore. */
export async function isMaintenanceActive(ctx: RedisCtx): Promise<boolean> {
  const [flag, marker] = await Promise.all([
    ctx.redis.exists(ctx.keys.maintenance()),
    ctx.redis.exists(ctx.keys.restoreIncomplete()),
  ]);
  return flag + marker > 0;
}

/**
 * In-process cached probe for hot paths (loops, job wrapper): at most one Redis round trip per
 * `ttlMs`. Fails open when Redis is unreachable (the app has bigger problems then).
 */
export function createMaintenanceProbe(ctx: RedisCtx, ttlMs = 1_500) {
  let cached: { at: number; value: boolean } | null = null;
  return async (): Promise<boolean> => {
    const now = Date.now();
    if (cached && now - cached.at < ttlMs) return cached.value;
    try {
      cached = { at: now, value: await isMaintenanceActive(ctx) };
    } catch {
      cached = { at: now, value: false };
    }
    return cached.value;
  };
}

/* ---------------------------------------------------------------------------------------
 * Progress of the running / last operation (Redis only, 7 days).
 * ------------------------------------------------------------------------------------- */

export type BackupOperation = 'BACKUP' | 'VERIFY' | 'RESTORE' | 'IMPORT';

export interface BackupStatus {
  operation: BackupOperation;
  backupId: string | null;
  state: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  /** Stable step code (translated in the UI). */
  step: string;
  startedAt: string;
  updatedAt: string;
  /** Technical detail / error text of the failure. */
  detail?: string;
}

const STATUS_TTL_SECONDS = 7 * 24 * 3600;
/** A RUNNING status that was not updated for this long belongs to a dead worker. */
export const STATUS_STALE_MS = 3 * 60_000;

export async function writeStatus(ctx: RedisCtx, status: BackupStatus): Promise<void> {
  await ctx.redis.set(ctx.keys.backupStatus(), JSON.stringify(status), 'EX', STATUS_TTL_SECONDS);
}

export async function readStatus(ctx: RedisCtx): Promise<BackupStatus | null> {
  const raw = await ctx.redis.get(ctx.keys.backupStatus());
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BackupStatus;
  } catch {
    return null;
  }
}

export const isStatusStale = (status: BackupStatus, now = Date.now()): boolean =>
  status.state === 'RUNNING' && now - Date.parse(status.updatedAt) > STATUS_STALE_MS;

/** Progress reporter bound to one operation; every call refreshes `updatedAt` (= liveness). */
export function createProgress(ctx: RedisCtx, operation: BackupOperation, backupId: string | null) {
  const startedAt = new Date().toISOString();
  let currentStep = 'START';
  const emit = (state: BackupStatus['state'], step: string, detail?: string) => {
    currentStep = step;
    return writeStatus(ctx, {
      operation,
      backupId,
      state,
      step,
      startedAt,
      updatedAt: new Date().toISOString(),
      ...(detail ? { detail: detail.slice(0, 1_000) } : {}),
    });
  };
  return {
    /** Re-announces the current step (liveness while one step runs for minutes). */
    touch: () => emit('RUNNING', currentStep),
    step: (step: string) => emit('RUNNING', step),
    succeeded: (step = 'DONE') => emit('SUCCEEDED', step),
    failed: (step: string, detail: string) => emit('FAILED', step, detail),
  };
}
export type Progress = ReturnType<typeof createProgress>;

/** Last failed scheduled backup (dashboard alert). */
export interface BackupFailure {
  at: string;
  message: string;
}

export async function recordBackupFailure(ctx: RedisCtx, failure: BackupFailure): Promise<void> {
  await ctx.redis.set(ctx.keys.backupFailure(), JSON.stringify(failure));
}

export async function clearBackupFailure(ctx: RedisCtx): Promise<void> {
  await ctx.redis.del(ctx.keys.backupFailure());
}

export async function getBackupFailure(ctx: RedisCtx): Promise<BackupFailure | null> {
  const raw = await ctx.redis.get(ctx.keys.backupFailure());
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BackupFailure;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------------------
 * Operation lock: only one backup / verify / restore at a time across all worker replicas.
 * ------------------------------------------------------------------------------------- */

const LOCK_TTL_MS = 120_000;
const LOCK_RENEW_MS = 30_000;

const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`;

/** Runs `fn` while holding the lock; returns null when another operation holds it. */
export async function withOperationLock<T>(
  ctx: RedisCtx,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const key = ctx.keys.mutex('backup-operation');
  const token = randomUUID();
  const acquired = await ctx.redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
  if (acquired !== 'OK') return { ran: false };
  const timer = setInterval(() => {
    ctx.redis.eval(RENEW, 1, key, token, LOCK_TTL_MS).catch(() => undefined);
  }, LOCK_RENEW_MS);
  timer.unref();
  try {
    return { ran: true, value: await fn() };
  } finally {
    clearInterval(timer);
    await ctx.redis.eval(RELEASE, 1, key, token).catch(() => undefined);
  }
}
