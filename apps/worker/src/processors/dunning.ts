import { runDunning } from '@tix/core';
import type { Job } from 'bullmq';
import type { WorkerDeps } from './index';

export const DUNNING_JOBS = { run: 'run-dunning' } as const;
/** Reminders, Vorkasse auto-cancel and PayPal expiry are checked every 5 minutes. */
export const DUNNING_INTERVAL_MS = 5 * 60 * 1000;

export function createDunningProcessor(deps: WorkerDeps) {
  return async (job: Job): Promise<unknown> => {
    if (job.name !== DUNNING_JOBS.run) {
      deps.logger.warn({ job: job.name }, 'unknown dunning job');
      return null;
    }
    const result = await runDunning(deps.core);
    if (result.reminded || result.cancelled || result.expired || result.errors) {
      deps.logger.info(result, 'dunning run');
    }
    return result;
  };
}
