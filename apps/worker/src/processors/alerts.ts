import { runAlertCycle } from '@tix/core';
import { QUEUE_NAMES } from '@tix/redis';
import type { Job } from 'bullmq';
import type { ProcessorRegistration, WorkerDeps } from './index';

export const ALERT_JOBS = { run: 'run-alerts' } as const;
/** The admin warning checks run every 5 minutes (one job per interval across all replicas). */
export const ALERT_INTERVAL_MS = 5 * 60 * 1000;

export function createAlertsProcessor(deps: WorkerDeps) {
  return async (job: Job): Promise<unknown> => {
    if (job.name !== ALERT_JOBS.run) {
      deps.logger.warn({ job: job.name }, 'unknown alerts job');
      return null;
    }
    return runAlertCycle(deps.core, {
      backups: deps.backups,
      update: {
        channel: process.env.TIX_CHANNEL ?? '',
        defaultRepository: process.env.TIX_UPDATE_REPOSITORY ?? '',
      },
    });
  };
}

export function alertsRegistration(deps: WorkerDeps): ProcessorRegistration {
  return {
    queue: QUEUE_NAMES.alerts,
    concurrency: 1,
    processor: createAlertsProcessor(deps),
    schedulers: [{ name: ALERT_JOBS.run, everyMs: ALERT_INTERVAL_MS }],
  };
}
