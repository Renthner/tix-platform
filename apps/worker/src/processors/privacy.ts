import { runPrivacyRetention } from '@tix/core';
import { QUEUE_NAMES } from '@tix/redis';
import type { Job } from 'bullmq';
import type { ProcessorRegistration, WorkerDeps } from './index';

export const PRIVACY_JOBS = {
  /** Daily GDPR retention run (e-mail log purge, expired order data). */
  retention: 'privacy-retention',
} as const;

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function createPrivacyProcessor(deps: WorkerDeps) {
  return async (job: Job): Promise<unknown> => {
    switch (job.name) {
      case PRIVACY_JOBS.retention: {
        const result = await runPrivacyRetention(deps.core);
        deps.logger.info({ job: job.name, ...result }, 'privacy retention run finished');
        return result;
      }
      default:
        deps.logger.warn({ job: job.name }, 'unknown privacy job');
        return null;
    }
  };
}

/** BullMQ job schedulers fire once per interval across all replicas (leader-elected by Redis). */
export function privacyRegistration(deps: WorkerDeps): ProcessorRegistration {
  return {
    queue: QUEUE_NAMES.privacy,
    concurrency: 1,
    processor: createPrivacyProcessor(deps),
    schedulers: [{ name: PRIVACY_JOBS.retention, everyMs: RETENTION_INTERVAL_MS }],
  };
}
