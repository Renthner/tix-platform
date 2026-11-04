import 'server-only';
import { createDb, type Database, type DbHandle } from '@tix/db';
import { getEnv } from './env';

/**
 * One connection pool per server process. Cached on globalThis so Next.js dev-mode hot
 * reloads do not leak pools. Created lazily so `next build` never needs a database.
 */
const globalForDb = globalThis as typeof globalThis & { __tixDb?: DbHandle };

export function getDbHandle(): DbHandle {
  if (!globalForDb.__tixDb) {
    const env = getEnv();
    globalForDb.__tixDb = createDb({
      connectionString: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      applicationName: 'web',
    });
  }
  return globalForDb.__tixDb;
}

export function getDb(): Database {
  return getDbHandle().db;
}
