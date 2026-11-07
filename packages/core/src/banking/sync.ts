import { bankConnections } from '@tix/db';
import { POLLING_BANK_ADAPTERS, type BankSyncTrigger, imapConfigSchema } from '@tix/shared';
import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import { QUEUE_NAMES } from '../job-queues';
import { syncFinApi, type FinApiDeps } from './adapters/finapi';
import { syncFinTs, type FinTsClientFactory } from './adapters/fints';
import { syncImap } from './adapters/imap';
import { BankSyncError, decryptConnectionSecrets, loadConnection } from './connections';
import { storeTransactions } from './importer';
import { matchBankTransactions, matchPendingBankTransactions } from './matching';
import { cleanupStaleRuns, finishSyncRun, startSyncRun, type SyncCounts } from './runs';
import type { ParsedTransaction } from './types';

/** Job names on the `bank-sync` queue. */
export const BANK_SYNC_JOBS = {
  /** Repeatable: stale-run cleanup, due connections → sync jobs, unmatched leftovers. */
  tick: 'bank-sync-tick',
  /** Sync of one connection (scheduled or manual). */
  connection: 'bank-sync-connection',
} as const;

export const BANK_SYNC_TICK_MS = 60_000;

export interface BankSyncJobData {
  connectionId: string;
  trigger: BankSyncTrigger;
  userId?: string | null;
}

export type BankSyncOutcome =
  | { status: 'SKIPPED'; reason: 'NOT_FOUND' | 'INACTIVE' | 'NOT_POLLING' | 'BUSY' }
  | { status: 'SUCCEEDED' | 'FAILED'; runId: string; counts: SyncCounts; error: string | null };

export interface BankSyncDeps {
  fintsClientFactory?: FinTsClientFactory;
  finApi?: FinApiDeps;
  tanTimeoutMs?: number;
}

const isPolling = (adapter: string) =>
  (POLLING_BANK_ADAPTERS as readonly string[]).includes(adapter);

/** Admin "sync now": queues a sync job for the worker. */
export async function requestBankSync(
  ctx: CoreContext,
  params: { connectionId: string; userId: string },
): Promise<void> {
  const loaded = await loadConnection(ctx, params.connectionId);
  if (!loaded) throw new DomainError('NOT_FOUND', 'Connection not found', 404);
  if (!loaded.connection.isActive) throw new DomainError('INACTIVE', 'Connection is inactive', 409);
  if (!isPolling(loaded.connection.adapter)) {
    throw new DomainError('NOT_POLLING', 'This connection has no automatic download', 422);
  }
  if (
    loaded.connection.lastSyncStatus === 'RUNNING' ||
    loaded.connection.lastSyncStatus === 'TAN_REQUIRED'
  ) {
    throw new DomainError('BUSY', 'A sync is already running', 409);
  }
  if (!ctx.jobs) throw new DomainError('NO_QUEUE', 'Job queue not available', 500);
  await ctx.jobs.add(
    QUEUE_NAMES.bankSync,
    BANK_SYNC_JOBS.connection,
    {
      connectionId: params.connectionId,
      trigger: 'MANUAL',
      userId: params.userId,
    } satisfies BankSyncJobData,
    { jobId: `bank-sync-manual-${params.connectionId}-${Date.now()}`, attempts: 1 },
  );
}

/** Runs one sync of a connection (worker). Never throws for adapter errors – they are recorded. */
export async function runBankSync(
  ctx: CoreContext,
  data: BankSyncJobData,
  deps: BankSyncDeps = {},
): Promise<BankSyncOutcome> {
  const loaded = await loadConnection(ctx, data.connectionId);
  if (!loaded) return { status: 'SKIPPED', reason: 'NOT_FOUND' };
  const { connection, account } = loaded;
  if (!connection.isActive || !account.isActive) return { status: 'SKIPPED', reason: 'INACTIVE' };
  if (!isPolling(connection.adapter)) return { status: 'SKIPPED', reason: 'NOT_POLLING' };
  const run = await startSyncRun(ctx, {
    connectionId: connection.id,
    trigger: data.trigger,
    userId: data.userId ?? null,
  });
  if (!run) return { status: 'SKIPPED', reason: 'BUSY' };

  const counts: SyncCounts = { fetched: 0, imported: 0, duplicates: 0, matched: 0 };
  let error: BankSyncError | Error | null = null;
  let period: { from: string | null; to: string | null } = { from: null, to: null };
  const intervalMs = connection.pollIntervalSeconds ? connection.pollIntervalSeconds * 1000 : null;
  let nextSyncAt: Date | null = intervalMs ? new Date(Date.now() + intervalMs) : null;

  const importBatch = async (transactions: ParsedTransaction[]) => {
    const stored = await storeTransactions(ctx, {
      bankAccountId: account.id,
      syncRunId: run.id,
      transactions,
    });
    counts.fetched += stored.fetched;
    counts.duplicates += stored.duplicates;
    counts.imported += stored.fetched - stored.duplicates;
    const summary = await matchBankTransactions(ctx, stored.insertedIds);
    counts.matched += summary.matched;
  };

  try {
    switch (connection.adapter) {
      case 'FINTS': {
        const secrets = decryptConnectionSecrets(ctx, connection, 'FINTS');
        if (!secrets) throw new BankSyncError('NO_CREDENTIALS', 'PIN missing');
        const result = await syncFinTs(ctx, {
          connection,
          account,
          syncRunId: run.id,
          pin: secrets.pin,
          lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
          clientFactory: deps.fintsClientFactory,
          tanTimeoutMs: deps.tanTimeoutMs,
        });
        period = { from: result.periodFrom, to: result.periodTo };
        await importBatch(result.transactions);
        break;
      }
      case 'PSD2_FINAPI': {
        const result = await syncFinApi(
          ctx,
          { connectionId: connection.id, lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt },
          deps.finApi,
        );
        period = { from: result.periodFrom, to: result.periodTo };
        await importBatch(result.transactions);
        error = result.warning;
        break;
      }
      case 'IMAP': {
        const secrets = decryptConnectionSecrets(ctx, connection, 'IMAP');
        if (!secrets) throw new BankSyncError('NO_CREDENTIALS', 'Password missing');
        imapConfigSchema.parse(connection.config);
        const result = await syncImap(ctx, { connection, account, password: secrets.password });
        const ids: string[] = [];
        for (const r of result.imports) {
          counts.fetched += r.transactionCount;
          counts.imported += r.importedCount;
          counts.duplicates += r.duplicateCount;
          ids.push(...r.insertedIds);
        }
        counts.matched += (await matchBankTransactions(ctx, ids)).matched;
        const failed = result.imports.filter((r) => r.status === 'FAILED');
        if (failed.length > 0) {
          error = new BankSyncError(
            'IMPORT_FAILED',
            failed.map((f) => `${f.fileName}: ${f.errorMessage}`).join('; '),
          );
        }
        break;
      }
      default:
        throw new BankSyncError('NOT_SUPPORTED', `Adapter ${connection.adapter} is not supported`);
    }
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
    // An unanswered TAN on a scheduled run pauses polling – otherwise the bank would push a
    // new approval request to the admin's phone at every interval.
    if (
      err instanceof BankSyncError &&
      [
        'TAN_EXPIRED',
        'TAN_CANCELLED',
        'FINTS_TAN_METHOD_REQUIRED',
        'FINTS_TAN_MEDIUM_REQUIRED',
      ].includes(err.code)
    ) {
      nextSyncAt = null;
    }
  }

  const message = error
    ? error instanceof BankSyncError
      ? `${error.code}: ${error.message}`
      : error.message
    : null;
  await finishSyncRun(ctx, {
    runId: run.id,
    connectionId: connection.id,
    status: error ? 'FAILED' : 'SUCCEEDED',
    counts,
    error: message,
    periodFrom: period.from,
    periodTo: period.to,
    nextSyncAt,
  });
  return { status: error ? 'FAILED' : 'SUCCEEDED', runId: run.id, counts, error: message };
}

/**
 * Scheduler tick: cleans up crashed runs, claims due connections (next_sync_at ≤ now) and
 * queues one sync job each, then retries the matcher for leftovers.
 */
export async function bankSyncTick(
  ctx: CoreContext,
): Promise<{ queued: number; stale: number; matched: number }> {
  const stale = await cleanupStaleRuns(ctx);
  const due = await ctx.db
    .update(bankConnections)
    .set({
      nextSyncAt: sql`now() + make_interval(secs => ${bankConnections.pollIntervalSeconds})`,
    })
    .where(
      and(
        eq(bankConnections.isActive, true),
        isNotNull(bankConnections.pollIntervalSeconds),
        isNotNull(bankConnections.nextSyncAt),
        lte(bankConnections.nextSyncAt, sql`now()`),
        inArray(bankConnections.adapter, [...POLLING_BANK_ADAPTERS]),
        sql`${bankConnections.lastSyncStatus} IS DISTINCT FROM 'RUNNING'`,
        sql`${bankConnections.lastSyncStatus} IS DISTINCT FROM 'TAN_REQUIRED'`,
      ),
    )
    .returning({ id: bankConnections.id });
  for (const { id } of due) {
    await ctx.jobs?.add(
      QUEUE_NAMES.bankSync,
      BANK_SYNC_JOBS.connection,
      { connectionId: id, trigger: 'SCHEDULED' } satisfies BankSyncJobData,
      { jobId: `bank-sync-scheduled-${id}-${Math.floor(Date.now() / 60_000)}`, attempts: 1 },
    );
  }
  const leftovers = await matchPendingBankTransactions(ctx, { limit: 200 });
  return { queued: due.length, stale, matched: leftovers.matched };
}
