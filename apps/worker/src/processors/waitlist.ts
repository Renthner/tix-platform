import { evaluateWaitlist } from '@tix/core';
import { QUEUE_NAMES } from '@tix/redis';
import type { Job } from 'bullmq';
import type { ProcessorRegistration, WorkerDeps } from './index';

export const WAITLIST_JOBS = { evaluate: 'evaluate-waitlist' } as const;
/**
 * The job runs every minute; each event is checked at most every `waitlist.evaluateIntervalMinutes`
 * (Redis debounce inside `evaluateWaitlist`), so the interval stays configurable in the admin.
 */
export const WAITLIST_TICK_MS = 60 * 1000;

export function createWaitlistProcessor(deps: WorkerDeps) {
  return async (job: Job): Promise<unknown> => {
    if (job.name !== WAITLIST_JOBS.evaluate) {
      deps.logger.warn({ job: job.name }, 'unknown waitlist job');
      return null;
    }
    const result = await evaluateWaitlist(deps.core);
    if (result.notified || result.removedBought || result.expiredUnconfirmed) {
      deps.logger.info(result, 'waitlist run');
    }
    return result;
  };
}

export function waitlistRegistration(deps: WorkerDeps): ProcessorRegistration {
  return {
    queue: QUEUE_NAMES.waitlist,
    concurrency: 1,
    processor: createWaitlistProcessor(deps),
    schedulers: [{ name: WAITLIST_JOBS.evaluate, everyMs: WAITLIST_TICK_MS }],
  };
}
