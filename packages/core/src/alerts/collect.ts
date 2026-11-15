import { statfs } from 'node:fs/promises';
import { bankConnections, bankTransactions, emailMessages, refunds, systemSettings } from '@tix/db';
import { QUEUE_NAMES, type QueueName } from '@tix/redis';
import { APP_VERSION, type AdminAlertType } from '@tix/shared';
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  max,
  min,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { getBackupFailure, readStatus } from '../backup/state';
import { listCatalogue } from '../backup/catalogue';
import type { BackupRuntime } from '../backup/runtime';
import type { CoreContext } from '../context';
import { coreLog } from '../log';
import { getSetting } from '../settings';
import { getUpdateStatus } from '../updates';
import {
  checkBackupFailed,
  checkBackupOverdue,
  checkBankSyncFailing,
  checkDiskLow,
  checkEmailDeliveryFailing,
  checkJobsFailing,
  checkPaymentProviderErrors,
  checkRefundsOpen,
  checkReviewCasesOpen,
  checkUpdateAvailable,
  type AlertFinding,
  type AlertSettings,
  type BackupSnapshot,
  type JobsSnapshot,
} from './checks';

/** E-mail templates of the alert mails themselves: never counted as delivery problems (no feedback loop). */
export const ALERT_TEMPLATE_KEYS = ['ADMIN_ALERT', 'ADMIN_ALERT_RESOLVED'] as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const FAILED_JOBS_SCANNED = 200;
const WAITING_JOBS_SCANNED = 50;
/** Bucket sizes need a full listing: refreshed at most once per hour. */
const BUCKET_SIZE_TTL_SECONDS = 3_600;

export interface CollectDeps {
  /** Backup runtime of the worker; without it the backup checks are not evaluated. */
  backups?: BackupRuntime;
  /** `TIX_CHANNEL` / `TIX_UPDATE_REPOSITORY` of the installation (update check). */
  update?: { channel: string; defaultRepository: string };
  /** Types at least one recipient wants: unwanted expensive checks are skipped. */
  wanted?: ReadonlySet<AdminAlertType>;
}

export interface Collected {
  findings: AlertFinding[];
  /** Types whose check ran: open alerts of other types are left untouched (e.g. Redis was down). */
  evaluated: Set<AdminAlertType>;
}

const readSignal = async <T>(ctx: CoreContext, name: string): Promise<T | null> => {
  const raw = await ctx.redis.get(ctx.keys.alertSignal(name));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

async function collectBackupSnapshot(rt: BackupRuntime): Promise<BackupSnapshot> {
  const ctx = rt.ctx;
  const [settings, scheduled, status, catalogue, configured] = await Promise.all([
    getSetting(ctx, 'backup'),
    getBackupFailure(ctx),
    readStatus(ctx),
    listCatalogue(rt.buckets.backups),
    ctx.db
      .select({ at: systemSettings.updatedAt })
      .from(systemSettings)
      .where(eq(systemSettings.key, 'backup')),
  ]);
  const newest = catalogue[0] ?? null;
  const external = newest?.state.external;
  return {
    scheduleEnabled: settings.scheduleEnabled,
    frequency: settings.frequency,
    scheduledFailure: scheduled ? { at: new Date(scheduled.at), message: scheduled.message } : null,
    lastOperationFailure:
      status && status.operation === 'BACKUP' && status.state === 'FAILED'
        ? { at: new Date(status.updatedAt), message: status.detail ?? status.step }
        : null,
    newestBackupAt: newest ? new Date(newest.manifest.createdAt) : null,
    externalFailure:
      settings.externalEnabled && newest && external?.status === 'FAILED'
        ? {
            at: new Date(external.at ?? newest.manifest.createdAt),
            message: `External upload failed: ${external.error ?? 'unknown error'}`,
          }
        : null,
    scheduleConfiguredAt: configured[0]?.at ?? null,
  };
}

async function bucketBytes(rt: BackupRuntime): Promise<number> {
  const ctx = rt.ctx;
  const cached = await readSignal<{ bytes: number }>(ctx, 'bucket-bytes');
  if (cached) return cached.bytes;
  let bytes = 0;
  for (const bucket of [rt.buckets.assets, rt.buckets.documents, rt.buckets.backups]) {
    for await (const object of bucket.list('')) bytes += object.size;
  }
  await ctx.redis.set(
    ctx.keys.alertSignal('bucket-bytes'),
    JSON.stringify({ bytes }),
    'EX',
    BUCKET_SIZE_TTL_SECONDS,
  );
  return bytes;
}

/** `fs.statfs` of every configured directory; directories that do not exist in this container are skipped. */
export async function readFilesystems(
  paths: string,
): Promise<{ path: string; totalBytes: number; freeBytes: number }[]> {
  const list = [
    ...new Set(
      paths
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  ];
  const out: { path: string; totalBytes: number; freeBytes: number }[] = [];
  for (const path of list) {
    try {
      const s = await statfs(path);
      out.push({ path, totalBytes: s.bsize * s.blocks, freeBytes: s.bsize * s.bavail });
    } catch {
      // Not mounted in this container (or not readable): nothing to check.
    }
  }
  return out;
}

async function collectJobsSnapshot(ctx: CoreContext, now: Date): Promise<JobsSnapshot> {
  const jobs = ctx.jobs;
  if (!jobs) throw new Error('job queues are not available in this process');
  const since = now.getTime() - HOUR_MS;
  const names = Object.values(QUEUE_NAMES) as QueueName[];
  const queues = await Promise.all(
    names.map(async (name) => {
      const queue = jobs.queue(name);
      const [failed, waitingOldFirst, waitingNewFirst] = await Promise.all([
        queue.getFailed(0, FAILED_JOBS_SCANNED - 1),
        queue.getJobs(['waiting'], 0, WAITING_JOBS_SCANNED - 1, true),
        queue.getJobs(['waiting'], 0, WAITING_JOBS_SCANNED - 1, false),
      ]);
      const recent = failed
        .filter((j) => (j.finishedOn ?? 0) >= since)
        .sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0));
      // The waiting list is read from both ends: the oldest job is one of the two end blocks.
      const timestamps = [...waitingOldFirst, ...waitingNewFirst]
        .filter((j): j is NonNullable<typeof j> => Boolean(j))
        .map((j) => j.timestamp);
      return {
        name,
        failedLastHour: recent.length,
        oldestWaitingMs: timestamps.length > 0 ? now.getTime() - Math.min(...timestamps) : null,
        lastFailure: recent[0]?.failedReason?.slice(0, 300) ?? null,
      };
    }),
  );
  return { queues };
}

/**
 * Runs every check and returns the findings. A block that cannot be collected (Redis, S3 …
 * unreachable) is logged and left out of `evaluated` so that its open alerts stay open.
 */
export async function collectFindings(
  ctx: CoreContext,
  deps: CollectDeps,
  settings: AlertSettings,
  now: Date,
): Promise<Collected> {
  const findings: AlertFinding[] = [];
  const evaluated = new Set<AdminAlertType>();
  const block = async (
    name: string,
    types: AdminAlertType[],
    fn: () => Promise<AlertFinding[]>,
  ): Promise<void> => {
    try {
      findings.push(...(await fn()));
      for (const t of types) evaluated.add(t);
    } catch (err) {
      coreLog.warn({ err, block: name }, 'alert check could not be evaluated');
    }
  };

  const backups = deps.backups;
  if (backups) {
    await block('backups', ['BACKUP_FAILED', 'BACKUP_OVERDUE'], async () => {
      const snapshot = await collectBackupSnapshot(backups);
      return [...checkBackupFailed(snapshot), ...checkBackupOverdue(snapshot, settings, now)];
    });
  }

  await block('disk', ['DISK_LOW'], async () => {
    const filesystems = await readFilesystems(settings.diskPaths);
    let storage = null;
    if (backups && settings.storageCapacityGb > 0) {
      const [db] = await ctx.db
        .execute<{ size: string }>(sql`SELECT pg_database_size(current_database())::text AS size`)
        .then((r) => r.rows);
      storage = { databaseBytes: Number(db?.size ?? 0), bucketBytes: await bucketBytes(backups) };
    }
    return checkDiskLow({ filesystems, storage }, settings);
  });

  await block('jobs', ['JOBS_FAILING'], async () =>
    checkJobsFailing(await collectJobsSnapshot(ctx, now), settings, now),
  );

  await block('email', ['EMAIL_DELIVERY_FAILING'], async () => {
    const since = new Date(now.getTime() - DAY_MS);
    const failedFilter = and(
      eq(emailMessages.status, 'FAILED'),
      sql`${emailMessages.updatedAt} >= ${since}`,
      // Marked FAILED on purpose (obsolete reminders): not a delivery problem.
      sql`coalesce(${emailMessages.lastError}, '') NOT LIKE 'obsolete:%'`,
      or(
        isNull(emailMessages.templateKey),
        notInArray(emailMessages.templateKey, [...ALERT_TEMPLATE_KEYS]),
      ),
    );
    const [agg] = await ctx.db
      .select({ n: count(), first: min(emailMessages.updatedAt) })
      .from(emailMessages)
      .where(failedFilter);
    const [last] = await ctx.db
      .select({ error: emailMessages.lastError })
      .from(emailMessages)
      .where(failedFilter)
      .orderBy(desc(emailMessages.updatedAt))
      .limit(1);
    return checkEmailDeliveryFailing(
      {
        failedCount: agg?.n ?? 0,
        firstFailedAt: agg?.first ?? null,
        lastError: last?.error ?? null,
      },
      settings,
    );
  });

  await block('review-cases', ['REVIEW_CASES_OPEN'], async () => {
    const before = new Date(now.getTime() - settings.reviewCaseDays * DAY_MS);
    const [row] = await ctx.db
      .select({ n: count(), oldest: min(bankTransactions.createdAt) })
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.matchStatus, 'NEEDS_REVIEW'),
          lt(bankTransactions.createdAt, before),
        ),
      );
    return checkReviewCasesOpen({ count: row?.n ?? 0, oldestAt: row?.oldest ?? null });
  });

  await block('bank-sync', ['BANK_SYNC_FAILING'], async () => {
    const rows = await ctx.db
      .select({
        id: bankConnections.id,
        name: bankConnections.name,
        lastSyncStatus: bankConnections.lastSyncStatus,
        lastError: bankConnections.lastError,
        lastSuccessfulSyncAt: bankConnections.lastSuccessfulSyncAt,
        createdAt: bankConnections.createdAt,
      })
      .from(bankConnections)
      .where(
        and(
          eq(bankConnections.isActive, true),
          inArray(bankConnections.lastSyncStatus, ['FAILED', 'TAN_REQUIRED']),
        ),
      );
    return checkBankSyncFailing(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        lastSyncStatus: r.lastSyncStatus,
        lastError: r.lastError,
        healthySince: r.lastSuccessfulSyncAt ?? r.createdAt,
      })),
      settings,
      now,
    );
  });

  await block('payments', ['PAYMENT_PROVIDER_ERRORS'], async () => {
    const [signal, [failed]] = await Promise.all([
      readSignal<{ at: string; environment: string }>(ctx, 'paypal-credentials'),
      ctx.db
        .select({ n: count(), oldest: min(refunds.createdAt), updated: max(refunds.updatedAt) })
        .from(refunds)
        .where(and(eq(refunds.kind, 'AUTOMATIC'), eq(refunds.status, 'FAILED'))),
    ]);
    const [last] = await ctx.db
      .select({ message: refunds.failureMessage })
      .from(refunds)
      .where(and(eq(refunds.kind, 'AUTOMATIC'), eq(refunds.status, 'FAILED')))
      .orderBy(desc(refunds.updatedAt))
      .limit(1);
    return checkPaymentProviderErrors(
      {
        paypalCredentials: signal
          ? { at: new Date(signal.at), environment: signal.environment }
          : null,
        failedRefunds: {
          count: failed?.n ?? 0,
          oldestAt: failed?.oldest ?? null,
          lastError: last?.message ?? null,
        },
      },
      settings,
      now,
    );
  });

  await block('refunds-open', ['REFUNDS_OPEN'], async () => {
    const before = new Date(now.getTime() - settings.refundOpenDays * DAY_MS);
    const [row] = await ctx.db
      .select({
        n: sql<number>`count(distinct ${refunds.batchId})::int`,
        oldest: min(refunds.createdAt),
      })
      .from(refunds)
      .where(
        and(
          eq(refunds.kind, 'MANUAL'),
          eq(refunds.status, 'PENDING'),
          lt(refunds.createdAt, before),
        ),
      );
    return checkRefundsOpen({ count: row?.n ?? 0, oldestAt: row?.oldest ?? null });
  });

  await block('update', ['UPDATE_AVAILABLE'], async () => {
    // The release lookup (network) only happens when somebody wants this notice.
    if (!deps.update || (deps.wanted && !deps.wanted.has('UPDATE_AVAILABLE'))) return [];
    const status = await getUpdateStatus(ctx, {
      channel: deps.update.channel,
      currentVersion: APP_VERSION,
      defaultRepository: deps.update.defaultRepository,
    });
    return checkUpdateAvailable({
      updateAvailable: status.updateAvailable,
      pinned: status.pinned,
      current: status.current,
      latest: status.latest?.version ?? null,
    });
  });

  return { findings, evaluated };
}
