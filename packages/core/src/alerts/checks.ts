import type { AdminAlertType, SettingValue } from '@tix/shared';

/**
 * Pure alert checks: every function turns an already collected snapshot into findings. They do
 * not touch the database, Redis or the clock (`now` is passed in) – `collect.ts` gathers the
 * snapshots, `engine.ts` reconciles findings with the stored alert history and sends the mails.
 */

export type AlertSettings = SettingValue<'alerts'>;
export type AlertDetails = Record<string, string | number | null>;

export interface AlertFinding {
  type: AdminAlertType;
  /** Identifies the problem (one open alert per key). */
  key: string;
  /** Selects the message text inside the type (`alerts.<TYPE>.<variant>`). */
  variant: string;
  /** When the problem started, if the data tells; otherwise the first evaluation counts. */
  since: Date | null;
  details: AlertDetails;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const finding = (
  type: AdminAlertType,
  key: string,
  variant: string,
  since: Date | null,
  details: AlertDetails,
): AlertFinding => ({ type, key, variant, since, details: { ...details, variant } });

// ─── Backups ────────────────────────────────────────────────────────────────

export interface BackupSnapshot {
  scheduleEnabled: boolean;
  frequency: 'DAILY' | 'WEEKLY';
  /**
   * Last failed / missed scheduled backup (Redis). Cleared only by the next successful SCHEDULED
   * backup – a manual backup neither clears it nor resolves the alert (same source as the portal).
   */
  scheduledFailure: { at: Date; message: string } | null;
  /** Status of the last backup operation when it failed (also manual backups). */
  lastOperationFailure: { at: Date; message: string } | null;
  /** Newest backup of any kind that is complete in the catalogue. */
  newestBackupAt: Date | null;
  /** Newest complete SCHEDULED backup; closes `scheduledFailure`. Absent = `newestBackupAt`. */
  newestScheduledBackupAt?: Date | null;
  /** The newest catalogue entry when its upload to the external target failed. */
  externalFailure: { at: Date; message: string } | null;
  /** When the schedule was last configured (reference while no backup exists yet). */
  scheduleConfiguredAt: Date | null;
  /** The latest probe restore failed (null = probes off, no probe yet, or the latest one passed). */
  probeFailure?: { at: Date; message: string } | null;
}

/** A failed probe restore: the newest backup could not be restored into a throwaway database. */
export function checkBackupProbe(s: BackupSnapshot): AlertFinding[] {
  const f = s.probeFailure;
  if (!f) return [];
  return [
    finding('BACKUP_FAILED', 'BACKUP_PROBE', 'probe', f.at, { reason: f.message.slice(0, 300) }),
  ];
}

export function checkBackupFailed(s: BackupSnapshot): AlertFinding[] {
  // A backup that completed after the failure supersedes it (a later success clears the alert).
  const newer = (f: { at: Date } | null, than: Date | null) =>
    f !== null && (than === null || f.at.getTime() > than.getTime());
  const newestScheduled =
    s.newestScheduledBackupAt !== undefined ? s.newestScheduledBackupAt : s.newestBackupAt;
  const candidates = [
    s.scheduledFailure && newer(s.scheduledFailure, newestScheduled)
      ? { ...s.scheduledFailure, variant: 'failed' }
      : null,
    s.lastOperationFailure && newer(s.lastOperationFailure, s.newestBackupAt)
      ? { ...s.lastOperationFailure, variant: 'failed' }
      : null,
    s.externalFailure ? { ...s.externalFailure, variant: 'external' } : null,
  ].filter((c): c is NonNullable<typeof c> => c !== null);
  if (candidates.length === 0) return [];
  const latest = candidates.reduce((a, b) => (b.at > a.at ? b : a));
  return [
    finding('BACKUP_FAILED', 'BACKUP_FAILED', latest.variant, latest.at, {
      reason: latest.message.slice(0, 300),
    }),
  ];
}

export function checkBackupOverdue(
  s: BackupSnapshot,
  settings: Pick<AlertSettings, 'backupOverdueFactor'>,
  now: Date,
): AlertFinding[] {
  if (!s.scheduleEnabled) return [];
  const intervalMs = s.frequency === 'WEEKLY' ? 7 * DAY_MS : DAY_MS;
  const limitMs = intervalMs * settings.backupOverdueFactor;
  // Never overdue before the first expected run after the schedule was configured: an old backup
  // (manual, pre-update) must not make a freshly enabled schedule look late.
  const times = [s.newestBackupAt, s.scheduleConfiguredAt].filter((d): d is Date => d !== null);
  if (times.length === 0) return [];
  const reference = new Date(Math.max(...times.map((d) => d.getTime())));
  const dueSince = new Date(reference.getTime() + limitMs);
  if (now.getTime() < dueSince.getTime()) return [];
  return [
    finding('BACKUP_OVERDUE', 'BACKUP_OVERDUE', s.newestBackupAt ? 'last' : 'never', dueSince, {
      lastBackup: s.newestBackupAt ? s.newestBackupAt.toISOString() : null,
      hours: Math.round(limitMs / HOUR_MS),
    }),
  ];
}

// ─── Storage ────────────────────────────────────────────────────────────────

export interface DiskSnapshot {
  /** File systems of the worker container (`fs.statfs`). Unreachable paths are left out. */
  filesystems: { path: string; totalBytes: number; freeBytes: number }[];
  /** Database + bucket sizes; null = not collected. */
  storage: { databaseBytes: number; bucketBytes: number } | null;
}

const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function checkDiskLow(
  s: DiskSnapshot,
  settings: Pick<AlertSettings, 'diskUsedPercent' | 'storageCapacityGb'>,
): AlertFinding[] {
  const out: AlertFinding[] = [];
  for (const fs of s.filesystems) {
    const used = fs.totalBytes - fs.freeBytes;
    const usedPercent = pct(used, fs.totalBytes);
    if (fs.totalBytes > 0 && usedPercent >= settings.diskUsedPercent) {
      out.push(
        finding('DISK_LOW', `DISK_LOW:fs:${fs.path}`, 'filesystem', null, {
          path: fs.path,
          usedPercent: Math.round(usedPercent),
          used: formatBytes(used),
          total: formatBytes(fs.totalBytes),
          free: formatBytes(fs.freeBytes),
        }),
      );
    }
  }
  if (s.storage && settings.storageCapacityGb > 0) {
    const capacity = settings.storageCapacityGb * 1024 ** 3;
    const used = s.storage.databaseBytes + s.storage.bucketBytes;
    const usedPercent = pct(used, capacity);
    if (usedPercent >= settings.diskUsedPercent) {
      out.push(
        finding('DISK_LOW', 'DISK_LOW:storage', 'storage', null, {
          usedPercent: Math.round(usedPercent),
          used: formatBytes(used),
          total: formatBytes(capacity),
          database: formatBytes(s.storage.databaseBytes),
          files: formatBytes(s.storage.bucketBytes),
        }),
      );
    }
  }
  return out;
}

// ─── Background jobs ────────────────────────────────────────────────────────

export interface JobsSnapshot {
  queues: {
    name: string;
    /** Jobs that failed within the last hour. */
    failedLastHour: number;
    /** Age of the oldest waiting (not delayed) job in ms; null = nothing waiting. */
    oldestWaitingMs: number | null;
    /** Most recent failure reason (truncated). */
    lastFailure: string | null;
  }[];
}

export function checkJobsFailing(
  s: JobsSnapshot,
  settings: Pick<AlertSettings, 'failedJobsPerHour' | 'queueBacklogMinutes'>,
  now: Date,
): AlertFinding[] {
  const out: AlertFinding[] = [];
  const failed = s.queues.reduce((sum, q) => sum + q.failedLastHour, 0);
  if (failed >= settings.failedJobsPerHour) {
    const worst = s.queues.reduce((a, b) => (b.failedLastHour > a.failedLastHour ? b : a));
    out.push(
      finding('JOBS_FAILING', 'JOBS_FAILING:failed', 'failed', null, {
        count: failed,
        queue: worst.name,
        reason: worst.lastFailure,
      }),
    );
  }
  for (const q of s.queues) {
    if (q.oldestWaitingMs !== null && q.oldestWaitingMs >= settings.queueBacklogMinutes * 60_000) {
      out.push(
        finding(
          'JOBS_FAILING',
          `JOBS_FAILING:backlog:${q.name}`,
          'backlog',
          new Date(now.getTime() - q.oldestWaitingMs),
          { queue: q.name, minutes: Math.round(q.oldestWaitingMs / 60_000) },
        ),
      );
    }
  }
  return out;
}

// ─── E-mail ─────────────────────────────────────────────────────────────────

export interface EmailSnapshot {
  /** Messages that failed for good within the last 24 h (alert mails and obsolete ones excluded). */
  failedCount: number;
  firstFailedAt: Date | null;
  lastError: string | null;
}

export function checkEmailDeliveryFailing(
  s: EmailSnapshot,
  settings: Pick<AlertSettings, 'failedEmailsPer24h'>,
): AlertFinding[] {
  if (s.failedCount < settings.failedEmailsPer24h) return [];
  return [
    finding('EMAIL_DELIVERY_FAILING', 'EMAIL_DELIVERY_FAILING', 'default', s.firstFailedAt, {
      count: s.failedCount,
      reason: s.lastError ? s.lastError.slice(0, 300) : null,
    }),
  ];
}

// ─── Bank / payments ────────────────────────────────────────────────────────

export interface ReviewCasesSnapshot {
  /** Unresolved cases older than the configured number of days. */
  count: number;
  oldestAt: Date | null;
}

export function checkReviewCasesOpen(s: ReviewCasesSnapshot): AlertFinding[] {
  if (s.count <= 0) return [];
  return [
    finding('REVIEW_CASES_OPEN', 'REVIEW_CASES_OPEN', 'default', s.oldestAt, { count: s.count }),
  ];
}

export interface BankConnectionSnapshot {
  id: string;
  name: string;
  lastSyncStatus: string | null;
  lastError: string | null;
  /** Last successful sync, or when the connection was created. */
  healthySince: Date;
}

export function checkBankSyncFailing(
  connections: BankConnectionSnapshot[],
  settings: Pick<AlertSettings, 'bankSyncHours'>,
  now: Date,
): AlertFinding[] {
  const out: AlertFinding[] = [];
  for (const c of connections) {
    const tan = c.lastSyncStatus === 'TAN_REQUIRED';
    if (!tan && c.lastSyncStatus !== 'FAILED') continue;
    if (now.getTime() - c.healthySince.getTime() < settings.bankSyncHours * HOUR_MS) continue;
    out.push(
      finding(
        'BANK_SYNC_FAILING',
        `BANK_SYNC_FAILING:${c.id}`,
        tan ? 'tan' : 'failed',
        c.healthySince,
        { connection: c.name, reason: c.lastError ? c.lastError.slice(0, 300) : null },
      ),
    );
  }
  return out;
}

export interface PaymentProviderSnapshot {
  /** PayPal rejected the stored credentials (Redis signal), with the moment of the last rejection. */
  paypalCredentials: { at: Date; environment: string } | null;
  /** Automatic (PayPal) refunds in status FAILED. */
  failedRefunds: { count: number; oldestAt: Date | null; lastError: string | null };
}

export function checkPaymentProviderErrors(
  s: PaymentProviderSnapshot,
  settings: Pick<AlertSettings, 'paymentErrorHours'>,
  now: Date,
): AlertFinding[] {
  const out: AlertFinding[] = [];
  if (
    s.paypalCredentials &&
    now.getTime() - s.paypalCredentials.at.getTime() < settings.paymentErrorHours * HOUR_MS
  ) {
    out.push(
      finding(
        'PAYMENT_PROVIDER_ERRORS',
        'PAYMENT_PROVIDER_ERRORS:paypal-credentials',
        'credentials',
        s.paypalCredentials.at,
        { environment: s.paypalCredentials.environment },
      ),
    );
  }
  if (s.failedRefunds.count > 0) {
    out.push(
      finding(
        'PAYMENT_PROVIDER_ERRORS',
        'PAYMENT_PROVIDER_ERRORS:refunds',
        'refunds',
        s.failedRefunds.oldestAt,
        {
          count: s.failedRefunds.count,
          reason: s.failedRefunds.lastError ? s.failedRefunds.lastError.slice(0, 300) : null,
        },
      ),
    );
  }
  return out;
}

export interface OpenRefundsSnapshot {
  /** Manual refunds waiting longer than the configured number of days (distinct cancellations). */
  count: number;
  oldestAt: Date | null;
}

export function checkRefundsOpen(s: OpenRefundsSnapshot): AlertFinding[] {
  if (s.count <= 0) return [];
  return [finding('REFUNDS_OPEN', 'REFUNDS_OPEN', 'default', s.oldestAt, { count: s.count })];
}

export interface PaidCancelledEventSnapshot {
  /** Orders paid AFTER one of their events was cancelled that still hold active items of it. */
  count: number;
  /** A few order numbers for the mail. */
  orderNumbers: string[];
  oldestPaidAt: Date | null;
}

/**
 * Money arrived for tickets of a cancelled event (PayPal capture racing the cancellation, bank
 * transfer assigned by hand, …): those tickets are never issued, the assistant must cancel and
 * refund them. Orders of an event whose cancellation run is still running are not counted.
 */
export function checkPaidCancelledEvent(s: PaidCancelledEventSnapshot): AlertFinding[] {
  if (s.count <= 0) return [];
  return [
    finding('PAID_CANCELLED_EVENT', 'PAID_CANCELLED_EVENT', 'default', s.oldestPaidAt, {
      count: s.count,
      orders: s.orderNumbers.join(', '),
    }),
  ];
}

// ─── Updates ────────────────────────────────────────────────────────────────

export function checkUpdateAvailable(s: {
  updateAvailable: boolean;
  pinned: boolean;
  current: string;
  latest: string | null;
}): AlertFinding[] {
  if (!s.updateAvailable || s.pinned || !s.latest) return [];
  return [
    finding('UPDATE_AVAILABLE', `UPDATE_AVAILABLE:${s.latest}`, 'default', null, {
      current: s.current,
      latest: s.latest,
    }),
  ];
}
