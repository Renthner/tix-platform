import { wallMs, wallToInstant } from '../zoned-time';
import type { BackupKind } from './manifest';

const DAY_MS = 86_400_000;

export interface ScheduleConfig {
  frequency: 'DAILY' | 'WEEKLY';
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** HH:MM local time. */
  time: string;
}

/**
 * Newest scheduled instant at or before `now` (wall-clock time in `timeZone`, DST-safe):
 * a time inside the spring-forward gap runs right after the gap, a time inside the
 * fall-back overlap runs at its first occurrence.
 */
export function latestScheduledSlot(config: ScheduleConfig, timeZone: string, now: Date): Date {
  const [hh, mm] = config.time.split(':').map(Number) as [number, number];
  const todayWall = Math.floor(wallMs(now, timeZone) / DAY_MS);
  for (let back = 0; back <= 8; back += 1) {
    const day = todayWall - back;
    // 1970-01-01 was a Thursday (4).
    const weekday = (((day + 4) % 7) + 7) % 7;
    if (config.frequency === 'WEEKLY' && weekday !== config.weekday) continue;
    const slot = wallToInstant(day * DAY_MS + (hh * 60 + mm) * 60_000, timeZone);
    if (slot.getTime() <= now.getTime()) return slot;
  }
  throw new Error('No schedule slot found'); // unreachable: a weekly slot exists within 7 days
}

/** A backup that is more than this late (e.g. the stack was down) is skipped, not run late. */
export const SCHEDULE_CATCH_UP_MS = 6 * 3_600_000;

/**
 * Whether a scheduled backup must start now. `lastScheduledAt` = creation time of the last
 * SCHEDULED backup (or the last attempt), which prevents a second run for the same slot.
 */
export function isBackupDue(
  config: ScheduleConfig,
  timeZone: string,
  now: Date,
  lastScheduledAt: Date | null,
  catchUpMs = SCHEDULE_CATCH_UP_MS,
): boolean {
  const slot = latestScheduledSlot(config, timeZone, now);
  if (now.getTime() - slot.getTime() > catchUpMs) return false;
  return lastScheduledAt === null || lastScheduledAt.getTime() < slot.getTime();
}

export interface RetentionCandidate {
  id: string;
  kind: BackupKind;
  createdAt: string;
  /** The last verification succeeded. */
  verifiedOk: boolean;
}

/** The newest backup whose verification succeeded (never deleted automatically). */
export function newestVerifiedId(backups: readonly RetentionCandidate[]): string | null {
  const ok = backups
    .filter((b) => b.verifiedOk)
    .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
  return ok[0]?.id ?? null;
}

/**
 * Ids to delete automatically:
 *  - scheduled backups beyond the newest N (failed / unverified ones count, but the newest
 *    verified backup is protected so they can never push out the last good one);
 *  - manual and safety backups only when `manualMaxAgeDays` > 0 and they are older than that.
 */
export function selectBackupsToDelete(
  backups: readonly RetentionCandidate[],
  keep: { scheduled: number; manualMaxAgeDays: number },
  now = new Date(),
): string[] {
  const protectedId = newestVerifiedId(backups);
  const doomed = backups
    .filter((b) => b.kind === 'SCHEDULED')
    .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt))
    .slice(Math.max(keep.scheduled, 0))
    .map((b) => b.id);
  if (keep.manualMaxAgeDays > 0) {
    const cutoff = now.getTime() - keep.manualMaxAgeDays * 86_400_000;
    for (const b of backups) {
      if (b.kind !== 'SCHEDULED' && Date.parse(b.createdAt) < cutoff) doomed.push(b.id);
    }
  }
  return doomed.filter((id) => id !== protectedId);
}

/** GoBD: after a restore every number counter is max(live, restored) – numbers are never reused. */
export function mergeSequenceCounters(
  live: ReadonlyMap<string, number>,
  restored: ReadonlyMap<string, number>,
): Map<string, number> {
  const merged = new Map(restored);
  for (const [scope, value] of live) {
    if (value > (merged.get(scope) ?? -1)) merged.set(scope, value);
  }
  return merged;
}

/** Counters that must be written after the restore (missing or lower than the live value). */
export function sequenceRaises(
  live: ReadonlyMap<string, number>,
  restored: ReadonlyMap<string, number>,
): { scope: string; value: number }[] {
  const out: { scope: string; value: number }[] = [];
  for (const [scope, value] of mergeSequenceCounters(live, restored)) {
    if (value > (restored.get(scope) ?? -1)) out.push({ scope, value });
  }
  return out;
}
