import {
  DomainError,
  EVENT_CANCELLATION_JOB,
  processPaypalRefund,
  reconcileRefundsAfterRestore,
  requeueStaleRefunds,
  resumeStaleEventCancellationRuns,
  runEventCancellation,
} from '@tix/core';
import { QUEUE_NAMES } from '@tix/redis';
import { UnrecoverableError, type Job } from 'bullmq';
import type { ProcessorRegistration, WorkerDeps } from './index';

export const REFUND_JOBS = {
  /** `{ refundId }` – executes one automatic (PayPal) refund; idempotent. */
  execute: 'execute-refund',
  /** Re-queues automatic refunds that are still PENDING after a while (lost job, PayPal pending). */
  sweep: 'sweep-refunds',
  /** Compares PENDING PayPal refunds with PayPal after a backup restore (flag-guarded, idempotent). */
  reconcile: 'reconcile-refunds',
} as const;

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function createRefundsProcessor(deps: WorkerDeps) {
  return async (job: Job): Promise<unknown> => {
    switch (job.name) {
      case REFUND_JOBS.execute: {
        const refundId = (job.data as { refundId?: unknown }).refundId;
        if (typeof refundId !== 'string') throw new UnrecoverableError('Job without refundId');
        try {
          const result = await processPaypalRefund(deps.core, refundId);
          deps.logger.info({ refundId, result }, 'refund processed');
          return result;
        } catch (err) {
          // Transient PayPal/network errors are rethrown by the core and retried with back-off.
          if (err instanceof DomainError && err.status < 500) {
            throw new UnrecoverableError(`${err.code}: ${err.message}`);
          }
          deps.logger.warn(
            { refundId, attempt: job.attemptsMade + 1, err: (err as Error).message },
            'refund attempt failed',
          );
          throw err;
        }
      }
      case EVENT_CANCELLATION_JOB: {
        // `{ runId }` – cancels the orders of a cancelled event; idempotent and resumable.
        const runId = (job.data as { runId?: unknown }).runId;
        if (typeof runId !== 'string') throw new UnrecoverableError('Job without runId');
        const result = await runEventCancellation(deps.core, runId);
        deps.logger.info({ runId, ...result }, 'event cancellation run finished');
        return result;
      }
      case REFUND_JOBS.reconcile: {
        const result = await reconcileRefundsAfterRestore(deps.core, { force: true });
        deps.logger.info(result, 'refunds reconciled after restore');
        // PayPal cannot be asked (no / rejected credentials): the sweeper repeats the pass once an
        // admin fixed the settings; BullMQ retries within minutes would not help.
        if (result.blocked) return result;
        if (!result.complete) throw new Error('refund reconciliation incomplete, will be retried');
        return result;
      }
      case REFUND_JOBS.sweep: {
        // Self-healing: a restore flag whose job was lost or failed is picked up here.
        const reconciled = await reconcileRefundsAfterRestore(deps.core);
        if (reconciled.checked > 0)
          deps.logger.info(reconciled, 'refunds reconciled after restore');
        const requeued = await requeueStaleRefunds(deps.core);
        if (requeued > 0) deps.logger.info({ requeued }, 'stale refunds re-queued');
        const runs = await resumeStaleEventCancellationRuns(deps.core);
        if (runs > 0) deps.logger.info({ runs }, 'stale event cancellation runs resumed');
        return { requeued, runs };
      }
      default:
        deps.logger.warn({ job: job.name }, 'unknown refunds job');
        return null;
    }
  };
}

export function refundsRegistration(deps: WorkerDeps): ProcessorRegistration {
  return {
    queue: QUEUE_NAMES.refunds,
    concurrency: 2,
    processor: createRefundsProcessor(deps),
    schedulers: [{ name: REFUND_JOBS.sweep, everyMs: SWEEP_INTERVAL_MS }],
  };
}
