import { DomainError, processPaypalRefund, requeueStaleRefunds } from '@tix/core';
import { QUEUE_NAMES } from '@tix/redis';
import { UnrecoverableError, type Job } from 'bullmq';
import type { ProcessorRegistration, WorkerDeps } from './index';

export const REFUND_JOBS = {
  /** `{ refundId }` – executes one automatic (PayPal) refund; idempotent. */
  execute: 'execute-refund',
  /** Re-queues automatic refunds that are still PENDING after a while (lost job, PayPal pending). */
  sweep: 'sweep-refunds',
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
      case REFUND_JOBS.sweep: {
        const requeued = await requeueStaleRefunds(deps.core);
        if (requeued > 0) deps.logger.info({ requeued }, 'stale refunds re-queued');
        return { requeued };
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
