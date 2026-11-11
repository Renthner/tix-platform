import { randomUUID } from 'node:crypto';
import { adminUsers, auditLogs, PgClient } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { QUEUE_NAMES, type Keyspace, type Redis } from '@tix/redis';
import { eq } from 'drizzle-orm';
import type { JobQueues } from '../job-queues';
import { replayErasureLedger } from '../customers/privacy';
import { runPrivacyRetention } from '../customers/privacy';
import { enqueueRefundReconcile, markRefundsForReconciliation } from '../orders/refund-reconcile';
import { BackupCryptoError } from './crypto';
import { createBackup, type CreateBackupResult } from './create';
import { findBackup } from './catalogue';
import { archivedFiles, extractDump, inspectArchive, type ArchiveInspection } from './inspect';
import { archiveKey, type BackupManifest } from './manifest';
import {
  PgRestoreError,
  carryForwardSql,
  latestCodeMigration,
  pgRestoreFromStream,
  readPublicSequences,
  readRowCounts,
  readSequenceCounters,
  terminateOtherSessions,
} from './pg';
import { describeError, type BackupRuntime } from './runtime';
import {
  clearMaintenance,
  clearRestoreIncomplete,
  getRestoreIncomplete,
  setMaintenance,
  setRestoreIncomplete,
  startMaintenanceHeartbeat,
  type Progress,
} from './state';
import { compareRowCounts } from './verify';

export class RestoreRejectedError extends Error {
  override name = 'RestoreRejectedError';
  constructor(
    readonly code:
      'NOT_FOUND' | 'MIGRATION_NEWER' | 'ARCHIVE_INVALID' | 'CHECKSUM_MISMATCH' | 'KEY_UNKNOWN',
    message: string,
  ) {
    super(message);
  }
}

export interface RestoreResult {
  safetyBackupId: string;
  /** Tables whose restored row count differs from the manifest (should be empty). */
  rowCountMismatches: string[];
  filesRestored: number;
  /** Objects that were not part of the backup and were moved to the quarantine area. */
  filesQuarantined: number;
  erasuresReplayed: number;
}

/** Grace period after the flag was set so in-flight web requests can finish. */
const DRAIN_GRACE_MS = 10_000;
/** How long to wait for running jobs of the other queues before the safety backup. */
const DRAIN_JOBS_TIMEOUT_MS = 120_000;
const SESSION_KILL_INTERVAL_MS = 1_000;
const RESTORE_APPLICATIONS = ['tix-restore', 'tix-restore-ctl'];
const SMALL_OBJECT_BYTES = 8 * 1024 * 1024;
/** Quarantine area (backups bucket) for files that a restore replaced; never deleted automatically. */
export const QUARANTINE_PREFIX = 'restore-quarantine/';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Checks everything that can be checked before touching live data. The decisions use the
 * AUTHENTICATED manifest from inside the archive (the unencrypted sidecar can be edited by
 * anyone with bucket access): migration level, key, checksum, decryption, id.
 */
export async function validateRestore(
  rt: BackupRuntime,
  backupId: string,
): Promise<{ directory: string; manifest: BackupManifest; inspected: ArchiveInspection }> {
  const entry = await findBackup(rt.buckets.backups, backupId);
  if (!entry) throw new RestoreRejectedError('NOT_FOUND', 'Backup not found');
  let inspected: ArchiveInspection;
  try {
    const source = await rt.buckets.backups.getStream(archiveKey(entry.directory));
    inspected = await inspectArchive(source.stream, rt.keyRing);
  } catch (err) {
    if (err instanceof BackupCryptoError) {
      throw new RestoreRejectedError(
        err.code === 'KEY_UNKNOWN' ? 'KEY_UNKNOWN' : 'ARCHIVE_INVALID',
        err.message,
      );
    }
    throw err;
  }
  if (entry.manifest.archive && inspected.sha256 !== entry.manifest.archive.sha256) {
    throw new RestoreRejectedError('CHECKSUM_MISMATCH', 'The archive checksum does not match');
  }
  const innerId = entry.manifest.originalId ?? entry.manifest.id;
  if (inspected.manifest.id !== innerId) {
    throw new RestoreRejectedError('ARCHIVE_INVALID', 'The archive does not belong to this entry');
  }
  const code = await latestCodeMigration(rt.migrationsDir);
  if (inspected.manifest.lastMigration.when > code.when) {
    throw new RestoreRejectedError(
      'MIGRATION_NEWER',
      'The backup was made by a newer version of the software than the one running now',
    );
  }
  return { directory: entry.directory, manifest: inspected.manifest, inspected };
}

/** Deletes keys by pattern (SCAN, batched). */
async function deleteByPattern(redis: Redis, pattern: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    if (found.length > 0) deleted += await redis.del(...found);
  } while (cursor !== '0');
  return deleted;
}

/**
 * Redis state that mirrors database content and is wrong after a restore: inventory mirrors and
 * seat/GA locks of all events, carts, queue state; waiting AND delayed (retry) jobs of queues
 * that reference orders / e-mails / refunds (the sweepers re-create them from the restored
 * database). Rate limits, idempotency keys, provider tokens and BullMQ repeat schedules stay.
 */
export async function cleanupRedisAfterRestore(ctx: {
  redis: Redis;
  keys: Keyspace;
  jobs?: JobQueues;
}): Promise<void> {
  const prefix = ctx.keys.prefix;
  await deleteByPattern(ctx.redis, `${prefix}:{ev:*`);
  await deleteByPattern(ctx.redis, `${prefix}:cart:*`);
  await ctx.redis.del(ctx.keys.activeLockEvents(), ctx.keys.activeQueueEvents());
  if (ctx.jobs) {
    for (const name of [QUEUE_NAMES.email, QUEUE_NAMES.documents, QUEUE_NAMES.refunds]) {
      const queue = ctx.jobs.queue(name);
      await queue.drain(false); // waiting jobs
      for (const job of await queue.getDelayed()) {
        // Delayed repeats of job schedulers carry a repeat key and stay.
        if (!job.repeatJobKey) await job.remove().catch(() => undefined);
      }
    }
  }
}

/** Waits until the other queues have no active job (the flag makes new ones back off). */
async function waitForIdleQueues(rt: BackupRuntime): Promise<void> {
  const jobs = rt.ctx.jobs;
  if (!jobs) return;
  const names = Object.values(QUEUE_NAMES).filter((n) => n !== QUEUE_NAMES.backups);
  const deadline = Date.now() + DRAIN_JOBS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const counts = await Promise.all(names.map((n) => jobs.queue(n).getActiveCount()));
    if (counts.every((c) => c === 0)) return;
    await sleep(2_000);
  }
  rt.logger.warn({}, 'restore: some jobs were still running after the drain timeout');
}

async function quarantine(
  rt: BackupRuntime,
  area: 'assets' | 'documents',
  keys: readonly string[],
  restoreId: string,
): Promise<void> {
  for (const key of keys) {
    const object = await rt.buckets[area].getStream(key);
    await rt.buckets.backups.putStream(
      `${QUARANTINE_PREFIX}${restoreId}/${area}/${key}`,
      object.stream,
      object.contentType,
    );
    await rt.buckets[area].delete(key);
  }
}

/**
 * Replaces the content of the assets / documents buckets with the files of the archive.
 * Objects that are not in the backup are MOVED to the quarantine area – and only when the
 * restored counts match what the (authenticated) archive contains.
 */
async function restoreFiles(
  rt: BackupRuntime,
  directory: string,
  expected: ArchiveInspection['files'],
  restoreId: string,
  progress: Progress,
): Promise<{ restored: number; quarantined: number }> {
  const kept = { assets: new Set<string>(), documents: new Set<string>() };
  let restored = 0;
  await progress.step('FILES_RESTORE');
  const source = await rt.buckets.backups.getStream(archiveKey(directory));
  for await (const file of archivedFiles(source.stream, rt.keyRing)) {
    const bucket = rt.buckets[file.area];
    const contentType = file.entry.header.contentType ?? 'application/octet-stream';
    const size = file.entry.header.size;
    if (size !== undefined && size <= SMALL_OBJECT_BYTES) {
      const parts: Buffer[] = [];
      for await (const chunk of file.entry.data) parts.push(chunk);
      await bucket.putBytes(file.key, Buffer.concat(parts), contentType);
    } else {
      await bucket.putStream(file.key, file.entry.data, contentType);
    }
    kept[file.area].add(file.key);
    restored += 1;
    if (restored % 50 === 0) await progress.step('FILES_RESTORE');
  }
  for (const area of ['assets', 'documents'] as const) {
    if (kept[area].size !== expected[area].objects) {
      throw new Error(
        `Restored ${kept[area].size} ${area} files but the archive announces ${expected[area].objects}; cleanup skipped`,
      );
    }
  }
  await progress.step('FILES_CLEANUP');
  let quarantined = 0;
  for (const area of ['assets', 'documents'] as const) {
    const extra: string[] = [];
    for await (const object of rt.buckets[area].list('')) {
      if (!kept[area].has(object.key)) extra.push(object.key);
    }
    await quarantine(rt, area, extra, restoreId);
    quarantined += extra.length;
  }
  return { restored, quarantined };
}

/**
 * Full restore. Order (each step reported in the status):
 *  1. validate against the authenticated manifest (migration level, key, checksum, decryption)
 *  2. maintenance flag ON (heartbeat) – BEFORE the safety backup, so nothing written in between
 *     can be lost from both; wait for running jobs of the other queues
 *  3. safety backup (kind PRE_RESTORE)
 *  4. other database sessions are terminated (and kept terminated); live counters + sequences read
 *  5. ONE transaction: drop/create public, restore dump, raise counters and sequences to
 *     GREATEST(live, restored), set the RESTORE_INCOMPLETE marker, COMMIT (never on EOF)
 *  6. migrations, erasure-ledger replay + privacy retention, files, Redis cleanup
 *  7. marker cleared (only now), flag cleared
 * A failure after the commit keeps the marker: the system stays in maintenance mode until the
 * restore is run again (or the safety backup is restored).
 */
export async function restoreBackup(
  rt: BackupRuntime,
  params: { backupId: string; userId: string | null; progress: Progress },
): Promise<RestoreResult> {
  const { progress } = params;
  await progress.step('VALIDATE');
  const { directory, manifest, inspected } = await validateRestore(rt, params.backupId);
  const restoreId = randomUUID();
  // A marker of an earlier, unfinished restore must survive a failed retry (rollback).
  const markerBefore = await getRestoreIncomplete(rt.ctx);

  const flag = {
    reason: 'RESTORE' as const,
    since: new Date().toISOString(),
    backupId: params.backupId,
  };
  await setMaintenance(rt.ctx, flag);
  const stopHeartbeat = startMaintenanceHeartbeat(rt.ctx, flag);
  let killTimer: NodeJS.Timeout | undefined;
  let control: PgClient | undefined;
  let killer: PgClient | undefined;
  let safetyBackupId: string | null = null;
  let committed = false;
  let step = 'DRAINING';
  const at = (s: string) => {
    step = s;
    return progress.step(s);
  };
  try {
    await at('DRAINING');
    await sleep(rt.drainGraceMs ?? DRAIN_GRACE_MS);
    await waitForIdleQueues(rt);

    await at('SAFETY_BACKUP');
    const safety: CreateBackupResult = await createBackup(rt, {
      kind: 'PRE_RESTORE',
      userId: params.userId,
      progress,
      retention: false,
    });
    safetyBackupId = safety.manifest.id;

    // From here on the worker's own pool connections will be terminated: use dedicated clients.
    control = new PgClient({
      connectionString: rt.databaseUrl,
      application_name: 'tix-restore-ctl',
    });
    control.on('error', () => undefined);
    await control.connect();
    // Separate connection for the terminate loop: one client runs one query at a time.
    killer = new PgClient({
      connectionString: rt.databaseUrl,
      application_name: 'tix-restore-ctl',
    });
    killer.on('error', () => undefined);
    await killer.connect();

    // PayPal keeps its state while the database is rewound: block automatic refunds BEFORE the
    // database is replaced (Redis flag; harmless when the restore rolls back - the pass finds nothing).
    const reconcileToken = await markRefundsForReconciliation(rt.ctx, 'restore', undefined, 'pre');
    await at('DATABASE_RESTORE');
    const kill = () => terminateOtherSessions(killer!, RESTORE_APPLICATIONS).catch(() => 0);
    await kill();
    killTimer = setInterval(() => void kill(), SESSION_KILL_INTERVAL_MS);
    // GoBD: read the live counters only after the other sessions are gone.
    const carryForward = carryForwardSql({
      counters: await readSequenceCounters(control),
      sequences: await readPublicSequences(control),
    });
    try {
      const source = await rt.buckets.backups.getStream(archiveKey(directory));
      await pgRestoreFromStream(rt.pg, rt.databaseUrl, extractDump(source.stream, rt.keyRing), {
        applicationName: 'tix-restore',
        carryForward,
        beforeCommit: async () => {
          await setRestoreIncomplete(rt.ctx, {
            backupId: params.backupId,
            safetyBackupId,
            at: new Date().toISOString(),
            step: 'MIGRATIONS',
          });
          committed = true;
        },
      });
    } catch (err) {
      if (err instanceof PgRestoreError && !err.commitSent) {
        // Rolled back: this attempt changed nothing. Only remove a marker this attempt created;
        // a marker of an earlier half-finished restore stays (the database is still half-restored).
        if (!markerBefore) await clearRestoreIncomplete(rt.ctx).catch(() => undefined);
        committed = false;
      }
      throw err;
    } finally {
      clearInterval(killTimer);
      killTimer = undefined;
    }

    await at('MIGRATIONS');
    await runMigrations({
      connectionString: rt.databaseUrl,
      migrationsFolder: rt.migrationsDir,
      log: (message) => rt.logger.info({}, message),
    });
    // The durable marker lives in the restored database (the table exists only after the migrations).
    await retry(() => markRefundsForReconciliation(rt.ctx, 'restore', reconcileToken, 'post'));
    const counts = await readRowCounts(control);
    // Counters are intentionally allowed to differ (raised in the restore transaction).
    const mismatches = compareRowCounts(manifest.rowCounts, counts).filter(
      (m) => !m.startsWith('number_sequences'),
    );
    if (mismatches.length > 0) rt.logger.warn({ mismatches }, 'row counts differ after restore');

    // Files first: the erasure replay below deletes the stored ticket files of erased customers
    // (they were just restored from the backup).
    const files = await restoreFiles(rt, directory, inspected.files, restoreId, progress);

    await at('ERASURE_REPLAY');
    const erasures = await retry(() => replayErasureLedger(rt.ctx));
    await retry(() => runPrivacyRetention(rt.ctx));

    await at('REDIS_CLEANUP');
    await cleanupRedisAfterRestore(rt.ctx);
    await enqueueRefundReconcile(rt.ctx);

    await retry(() =>
      recordRestoreAudit(rt, params.userId, {
        backupId: params.backupId,
        backupCreatedAt: manifest.createdAt,
        safetyBackupId,
        filesRestored: files.restored,
        filesQuarantined: files.quarantined,
        quarantineId: restoreId,
        erasuresReplayed: erasures.replayed,
      }),
    ).catch((err) => rt.logger.warn({ err }, 'restore audit entry could not be written'));

    // Only now is the restore complete.
    await clearRestoreIncomplete(rt.ctx);
    return {
      safetyBackupId,
      rowCountMismatches: mismatches,
      filesRestored: files.restored,
      filesQuarantined: files.quarantined,
      erasuresReplayed: erasures.replayed,
    };
  } catch (err) {
    if (committed) {
      // The database was replaced: stay in maintenance mode (marker without TTL) until resolved.
      await setRestoreIncomplete(rt.ctx, {
        backupId: params.backupId,
        safetyBackupId,
        at: new Date().toISOString(),
        step,
        error: describeError(err),
      }).catch(() => undefined);
    }
    throw err;
  } finally {
    if (killTimer) clearInterval(killTimer);
    await control?.end().catch(() => undefined);
    await killer?.end().catch(() => undefined);
    stopHeartbeat();
    await clearMaintenance(rt.ctx).catch((err) =>
      rt.logger.error({ err: describeError(err) }, 'maintenance flag could not be cleared'),
    );
  }
}

/** The pooled connections may still be ones that were terminated during the restore. */
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await sleep(500);
    return fn();
  }
}

/** Audit entry in the restored database (the actor may not exist there). */
async function recordRestoreAudit(
  rt: BackupRuntime,
  userId: string | null,
  changes: Record<string, unknown>,
): Promise<void> {
  let actor: string | null = null;
  if (userId) {
    const [row] = await rt.ctx.db
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.id, userId));
    actor = row?.id ?? null;
  }
  await rt.ctx.db.insert(auditLogs).values({
    actorType: 'ADMIN' as const,
    actorUserId: actor,
    action: 'backup.restore',
    entityType: 'backup',
    entityId: String(changes.backupId),
    changes,
    metadata: actor ? null : { requestedByUserId: userId },
  });
}
