import { BANK_SYNC_JOBS, BANK_SYNC_TICK_MS, bankSyncTick, runBankSync } from '@tix/core';
import { BANK_SYNC_TRIGGERS, type BankSyncTrigger } from '@tix/shared';
import { QUEUE_NAMES } from '@tix/redis';
import { UnrecoverableError, type Job } from 'bullmq';
import type { ProcessorRegistration, WorkerDeps } from './index';

/**
 * `bank-sync` queue:
 *  - `bank-sync-tick` (every minute): stale-run cleanup, due connections → sync jobs,
 *    matcher safety net for unmatched credits,
 *  - `bank-sync-connection` `{ connectionId, trigger, userId? }`: one FinTS / finAPI / IMAP
 *    sync. FinTS jobs may wait several minutes for a TAN – the concurrency keeps other
 *    connections and the tick running meanwhile. Sync jobs are not retried by BullMQ; the
 *    next poll (or "sync now") starts a fresh run.
 */
export function createBankSyncProcessor(deps: WorkerDeps) {
  return async (job: Job): Promise<unknown> => {
    switch (job.name) {
      case BANK_SYNC_JOBS.tick: {
        const result = await bankSyncTick(deps.core);
        if (result.queued > 0 || result.stale > 0 || result.matched > 0) {
          deps.logger.info(result, 'bank sync tick');
        }
        return result;
      }
      case BANK_SYNC_JOBS.connection: {
        const data = job.data as { connectionId?: unknown; trigger?: unknown; userId?: unknown };
        if (typeof data.connectionId !== 'string')
          throw new UnrecoverableError('Job without connectionId');
        const trigger = (BANK_SYNC_TRIGGERS as readonly string[]).includes(String(data.trigger))
          ? (data.trigger as BankSyncTrigger)
          : 'MANUAL';
        const outcome = await runBankSync(deps.core, {
          connectionId: data.connectionId,
          trigger,
          userId: typeof data.userId === 'string' ? data.userId : null,
        });
        const log = outcome.status === 'FAILED' ? deps.logger.warn : deps.logger.info;
        log.call(
          deps.logger,
          { connectionId: data.connectionId, trigger, ...outcome },
          'bank sync finished',
        );
        return outcome;
      }
      default:
        throw new UnrecoverableError(`Unknown bank-sync job "${job.name}"`);
    }
  };
}

export function bankSyncRegistration(deps: WorkerDeps): ProcessorRegistration {
  return {
    queue: QUEUE_NAMES.bankSync,
    concurrency: 4,
    processor: createBankSyncProcessor(deps),
    schedulers: [{ name: BANK_SYNC_JOBS.tick, everyMs: BANK_SYNC_TICK_MS }],
  };
}
