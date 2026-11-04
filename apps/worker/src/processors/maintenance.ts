import {
  adminSessions,
  customerSessions,
  customerTokens,
  devicePairingCodes,
  type Database,
} from '@tix/db';
import type { Job } from 'bullmq';
import { lt, sql } from 'drizzle-orm';
import type { Logger } from '../logger';

export const MAINTENANCE_JOBS = {
  purgeExpiredCredentials: 'purge-expired-credentials',
} as const;

/** Interval of the housekeeping job scheduler. */
export const PURGE_INTERVAL_MS = 15 * 60 * 1000;

/** Expired pairing codes and customer tokens are kept this long for audit purposes. */
const AUDIT_RETENTION = sql`now() - interval '7 days'`;

export function createMaintenanceProcessor(db: Database, logger: Logger) {
  return async function processMaintenance(job: Job): Promise<Record<string, number>> {
    switch (job.name) {
      case MAINTENANCE_JOBS.purgeExpiredCredentials: {
        const [admin, customer, tokens, pairing] = await Promise.all([
          db.delete(adminSessions).where(lt(adminSessions.expiresAt, sql`now()`)),
          db.delete(customerSessions).where(lt(customerSessions.expiresAt, sql`now()`)),
          db.delete(customerTokens).where(lt(customerTokens.expiresAt, AUDIT_RETENTION)),
          db.delete(devicePairingCodes).where(lt(devicePairingCodes.expiresAt, AUDIT_RETENTION)),
        ]);
        const result = {
          adminSessions: admin.rowCount ?? 0,
          customerSessions: customer.rowCount ?? 0,
          customerTokens: tokens.rowCount ?? 0,
          pairingCodes: pairing.rowCount ?? 0,
        };
        logger.info({ job: job.name, ...result }, 'expired credentials purged');
        return result;
      }
      default:
        throw new Error(`Unknown maintenance job "${job.name}"`);
    }
  };
}
