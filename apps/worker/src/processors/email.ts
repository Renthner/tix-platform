import { EmailDeliveryError, deliverEmailMessage, requeueStaleEmails } from '@tix/core';
import { QUEUE_NAMES } from '@tix/redis';
import { UnrecoverableError, type Job } from 'bullmq';
import type { ProcessorRegistration, WorkerDeps } from './index';

export const EMAIL_JOBS = {
  /** `{ messageId }` – render + send one outbox message. */
  send: 'send',
  /** Re-dispatches QUEUED messages whose job got lost (outbox sweeper). */
  sweepOutbox: 'sweep-outbox',
} as const;

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function createEmailProcessor(deps: WorkerDeps) {
  return async (job: Job): Promise<unknown> => {
    switch (job.name) {
      case EMAIL_JOBS.send: {
        const messageId = (job.data as { messageId?: unknown }).messageId;
        if (typeof messageId !== 'string') throw new UnrecoverableError('Job without messageId');
        const attempts = job.opts.attempts ?? 1;
        try {
          const result = await deliverEmailMessage(deps.core, messageId, {
            finalAttempt: job.attemptsMade + 1 >= attempts,
          });
          deps.logger.info({ messageId, status: result.status }, 'e-mail delivered');
          return result;
        } catch (err) {
          const permanent = err instanceof EmailDeliveryError && err.permanent;
          deps.logger.warn(
            { messageId, attempt: job.attemptsMade + 1, permanent, err: (err as Error).message },
            'e-mail delivery failed',
          );
          // Permanent problems (unknown template, rejected recipient) are not retried.
          if (permanent) throw new UnrecoverableError((err as Error).message);
          throw err;
        }
      }
      case EMAIL_JOBS.sweepOutbox: {
        const requeued = await requeueStaleEmails(deps.core);
        if (requeued > 0) deps.logger.info({ requeued }, 'stale e-mails re-queued');
        return { requeued };
      }
      default:
        deps.logger.warn({ job: job.name }, 'unknown e-mail job');
        return null;
    }
  };
}

export function emailRegistration(deps: WorkerDeps): ProcessorRegistration {
  return {
    queue: QUEUE_NAMES.email,
    concurrency: 4,
    processor: createEmailProcessor(deps),
    schedulers: [{ name: EMAIL_JOBS.sweepOutbox, everyMs: SWEEP_INTERVAL_MS }],
  };
}
