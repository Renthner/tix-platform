import type { BackupRuntime, CoreContext } from '@tix/core';
import type { Database } from '@tix/db';
import { QUEUE_NAMES, type QueueName } from '@tix/redis';
import type { Job } from 'bullmq';
import type { Logger } from '../logger';
import { backupsRegistration, withMaintenancePause } from './backups';
import { bankSyncRegistration } from './bank-sync';
import { documentsRegistration } from './documents';
import { DUNNING_INTERVAL_MS, DUNNING_JOBS, createDunningProcessor } from './dunning';
import { emailRegistration } from './email';
import { mediaRegistration } from './media';
import { privacyRegistration } from './privacy';
import { refundsRegistration } from './refunds';
import { MAINTENANCE_JOBS, PURGE_INTERVAL_MS, createMaintenanceProcessor } from './maintenance';

export interface WorkerDeps {
  core: CoreContext;
  db: Database;
  logger: Logger;
  /** Backup / restore runtime (pg tools, buckets, key ring). */
  backups: BackupRuntime;
}

/** One BullMQ consumer: queue, processor, concurrency and optional repeatable jobs. */
export interface ProcessorRegistration {
  queue: QueueName;
  concurrency: number;
  processor: (job: Job, token?: string) => Promise<unknown>;
  /** Repeatable jobs (job scheduler id = job name). */
  schedulers?: { name: string; everyMs: number; data?: Record<string, unknown> }[];
}

/**
 * All queue consumers of the worker. Each feature registers exactly one entry from its own
 * module (documents, e-mail, bank sync, dunning …) – keep additions to a single line here.
 */
export function processorRegistrations(deps: WorkerDeps): ProcessorRegistration[] {
  // Every queue except `backups` pauses while a restore holds the maintenance flag.
  return withMaintenancePause(deps, [
    {
      queue: QUEUE_NAMES.maintenance,
      concurrency: 1,
      processor: createMaintenanceProcessor(deps.db, deps.logger),
      schedulers: [{ name: MAINTENANCE_JOBS.purgeExpiredCredentials, everyMs: PURGE_INTERVAL_MS }],
    },
    {
      queue: QUEUE_NAMES.dunning,
      concurrency: 1,
      processor: createDunningProcessor(deps),
      schedulers: [{ name: DUNNING_JOBS.run, everyMs: DUNNING_INTERVAL_MS }],
    },
    documentsRegistration(deps),
    emailRegistration(deps),
    bankSyncRegistration(deps),
    refundsRegistration(deps),
    privacyRegistration(deps),
    mediaRegistration(deps),
    backupsRegistration(deps.backups),
  ]);
}
