import { INVENTORY_REBUILD_JOB, reconcileEventInventory } from '@tix/core';
import { QUEUE_NAMES } from '@tix/redis';
import type { Job } from 'bullmq';
import type { ProcessorRegistration, WorkerDeps } from './index';

/**
 * Delayed rebuilds of an event's Redis inventory mirror after a seat plan / contingent save
 * (`scheduleInventoryRebuild`): corrects a standing-capacity drift caused by a checkout or release
 * that raced with the immediate rebuild.
 */
export function createInventoryProcessor(deps: WorkerDeps) {
  return async (job: Job): Promise<unknown> => {
    if (job.name !== INVENTORY_REBUILD_JOB) {
      deps.logger.warn({ job: job.name }, 'unknown seat-locks job');
      return null;
    }
    const eventId = (job.data as { eventId?: unknown }).eventId;
    if (typeof eventId !== 'string') return null;
    return reconcileEventInventory(deps.core, eventId);
  };
}

export function inventoryRegistration(deps: WorkerDeps): ProcessorRegistration {
  return {
    queue: QUEUE_NAMES.seatLocks,
    concurrency: 2,
    processor: createInventoryProcessor(deps),
  };
}
