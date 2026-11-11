import { randomUUID } from 'node:crypto';
import { bankConnections, bankSyncRuns, bankTanChallenges, isUniqueViolation } from '@tix/db';
import type { BankSyncStatus, BankSyncTrigger } from '@tix/shared';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { CoreContext } from '../context';

/** Runs that are still RUNNING / TAN_REQUIRED after this long are considered crashed. */
export const STALE_RUN_MS = 30 * 60 * 1000;

export interface SyncCounts {
  fetched: number;
  imported: number;
  duplicates: number;
  matched: number;
}

/** Starts a sync run; null when another run of the connection is still active. */
export async function startSyncRun(
  ctx: Pick<CoreContext, 'db'>,
  params: { connectionId: string; trigger: BankSyncTrigger; userId?: string | null },
): Promise<{ id: string } | null> {
  try {
    const [run] = await ctx.db
      .insert(bankSyncRuns)
      .values({
        connectionId: params.connectionId,
        trigger: params.trigger,
        status: 'RUNNING',
        triggeredByUserId: params.userId ?? null,
      })
      .returning({ id: bankSyncRuns.id });
    await ctx.db
      .update(bankConnections)
      .set({ lastSyncStatus: 'RUNNING', lastSyncAt: new Date(), updatedAt: new Date() })
      .where(eq(bankConnections.id, params.connectionId));
    return run!;
  } catch (err) {
    if (isUniqueViolation(err, 'bank_sync_runs_single_running_uq')) return null;
    throw err;
  }
}

export async function setRunStatus(
  ctx: Pick<CoreContext, 'db'>,
  runId: string,
  connectionId: string,
  status: 'RUNNING' | 'TAN_REQUIRED',
): Promise<void> {
  await ctx.db.update(bankSyncRuns).set({ status }).where(eq(bankSyncRuns.id, runId));
  await ctx.db
    .update(bankConnections)
    .set({ lastSyncStatus: status, updatedAt: new Date() })
    .where(eq(bankConnections.id, connectionId));
}

export async function finishSyncRun(
  ctx: Pick<CoreContext, 'db'>,
  params: {
    runId: string;
    connectionId: string;
    status: Extract<BankSyncStatus, 'SUCCEEDED' | 'FAILED' | 'CANCELLED'>;
    counts: SyncCounts;
    error?: string | null;
    periodFrom?: string | null;
    periodTo?: string | null;
    /** Next scheduled poll; null pauses scheduled polling (e.g. after an unanswered TAN). */
    nextSyncAt: Date | null;
  },
): Promise<void> {
  const now = new Date();
  await ctx.db
    .update(bankSyncRuns)
    .set({
      status: params.status,
      fetchedCount: params.counts.fetched,
      importedCount: params.counts.imported,
      duplicateCount: params.counts.duplicates,
      matchedCount: params.counts.matched,
      errorMessage: params.error?.slice(0, 2000) ?? null,
      periodFrom: params.periodFrom ?? null,
      periodTo: params.periodTo ?? null,
      finishedAt: now,
    })
    .where(eq(bankSyncRuns.id, params.runId));
  await ctx.db
    .update(bankConnections)
    .set({
      lastSyncStatus: params.status,
      lastSyncAt: now,
      ...(params.status === 'SUCCEEDED' ? { lastSuccessfulSyncAt: now, lastError: null } : {}),
      ...(params.status === 'FAILED' ? { lastError: params.error?.slice(0, 2000) ?? null } : {}),
      nextSyncAt: params.nextSyncAt,
      updatedAt: now,
    })
    .where(eq(bankConnections.id, params.connectionId));
}

/** Marks runs of crashed workers as FAILED and expires unanswered TAN challenges. */
export async function cleanupStaleRuns(ctx: Pick<CoreContext, 'db'>): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_RUN_MS);
  const stale = await ctx.db
    .update(bankSyncRuns)
    .set({ status: 'FAILED', errorMessage: 'Interrupted (worker stopped)', finishedAt: new Date() })
    .where(
      and(
        inArray(bankSyncRuns.status, ['RUNNING', 'TAN_REQUIRED']),
        lt(bankSyncRuns.startedAt, cutoff),
      ),
    )
    .returning({ connectionId: bankSyncRuns.connectionId });
  if (stale.length > 0) {
    await ctx.db
      .update(bankConnections)
      .set({ lastSyncStatus: 'FAILED', lastError: 'Interrupted (worker stopped)' })
      .where(
        and(
          inArray(
            bankConnections.id,
            stale.map((s) => s.connectionId),
          ),
          inArray(bankConnections.lastSyncStatus, ['RUNNING', 'TAN_REQUIRED']),
        ),
      );
  }
  await ctx.db
    .update(bankTanChallenges)
    .set({ status: 'EXPIRED' })
    .where(
      and(
        inArray(bankTanChallenges.status, ['PENDING', 'SUBMITTED']),
        lt(bankTanChallenges.expiresAt, sql`now() - interval '2 minutes'`),
      ),
    );
  return stale.length;
}

const MUTEX_RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0";

/**
 * Small Redis mutex (SET NX PX + compare-and-delete with a unique token). Returns null when the
 * lock is held by someone else. While `fn` runs the lease is renewed every third of the TTL (only
 * while the token is still ours), so a long-running body never loses the lock; if the process dies
 * the lock still expires after `ttlMs`.
 */
export async function withMutex<T>(
  ctx: Pick<CoreContext, 'redis' | 'keys'>,
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ value: T } | null> {
  const key = ctx.keys.mutex(name);
  const token = randomUUID();
  const ok = await ctx.redis.set(key, token, 'PX', ttlMs, 'NX');
  if (ok !== 'OK') return null;
  const startedAt = Date.now();
  let lostLogged = false;
  const renew = setInterval(
    () => {
      // Safety net against a hung body: stop renewing after 10 x TTL so the lock cannot live forever.
      if (Date.now() - startedAt > ttlMs * 10) {
        clearInterval(renew);
        return;
      }
      ctx.redis
        .eval(MUTEX_RENEW_SCRIPT, 1, key, token, String(ttlMs))
        .then((renewed) => {
          if (renewed !== 1 && !lostLogged) {
            lostLogged = true;
            console.warn(`[mutex] lease of "${name}" was lost while its body is still running`);
          }
        })
        .catch(() => undefined);
    },
    Math.max(50, Math.floor(ttlMs / 3)),
  );
  renew.unref();
  try {
    return { value: await fn() };
  } finally {
    clearInterval(renew);
    // A failing release must never replace the result (or the error) of the body.
    await ctx.redis
      .eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
        1,
        key,
        token,
      )
      .catch((err) => console.warn(`[mutex] release of "${name}" failed`, err));
  }
}
