import {
  MEDIA_VARIANTS_JOB,
  backfillMediaVariants,
  normaliseLegacyMasters,
  processAssetVariants,
  type MediaVariantsJobData,
} from '@tix/core';
import { QUEUE_NAMES } from '@tix/redis';
import type { Job } from 'bullmq';
import type { ProcessorRegistration, WorkerDeps } from './index';

export const MEDIA_JOBS = {
  /** Cleans legacy masters once, then generates AVIF / WebP variants for public images lacking them. */
  backfillVariants: 'media-backfill-variants',
  /** Generates the variants of one freshly uploaded asset (enqueued by the web upload). */
  generateVariants: MEDIA_VARIANTS_JOB,
} as const;

/** Runs on startup (first scheduler tick) and then periodically; nothing to do = cheap query. */
const BACKFILL_INTERVAL_MS = 10 * 60 * 1000;

export function createMediaProcessor(deps: WorkerDeps) {
  return async (job: Job): Promise<unknown> => {
    switch (job.name) {
      case MEDIA_JOBS.backfillVariants: {
        // Legacy masters are cleaned first (their variants are regenerated from the clean master).
        const normalised = await normaliseLegacyMasters(deps.core);
        if (normalised.processed > 0 || normalised.failed > 0) {
          deps.logger.info({ job: job.name, ...normalised }, 'media master clean-up finished');
        }
        if (normalised.more) return { normalised };
        const result = await backfillMediaVariants(deps.core);
        if (result.processed > 0 || result.failed > 0) {
          deps.logger.info({ job: job.name, ...result }, 'media variant backfill finished');
        }
        return { normalised, ...result };
      }
      case MEDIA_JOBS.generateVariants: {
        const { assetId } = job.data as MediaVariantsJobData;
        const result = await processAssetVariants(deps.core, assetId);
        if (result.status === 'missing') return result;
        // Failures with attempts left: let BullMQ retry (with backoff) instead of waiting for the
        // backfill; the attempt counter in the database ends it after a few rounds.
        if (result.status === 'pending') {
          throw new Error(`${result.failed} variant(s) of asset ${assetId} could not be generated`);
        }
        return result;
      }
      default:
        deps.logger.warn({ job: job.name }, 'unknown media job');
        return null;
    }
  };
}

/** Low concurrency on purpose: AVIF encoding is CPU-heavy and must not starve the other queues. */
export function mediaRegistration(deps: WorkerDeps): ProcessorRegistration {
  return {
    queue: QUEUE_NAMES.media,
    concurrency: 1,
    processor: createMediaProcessor(deps),
    schedulers: [{ name: MEDIA_JOBS.backfillVariants, everyMs: BACKFILL_INTERVAL_MS }],
  };
}
