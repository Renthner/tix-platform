import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run queries: the pooled database or an open transaction. */
export type Executor = Database | Transaction;

export interface DbConfig {
  connectionString: string;
  /** Max pooled connections per process. */
  poolMax?: number;
  applicationName?: string;
  /** Server-side guard rails – a stuck query or forgotten transaction can never hold seat rows forever. */
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
  connectionTimeoutMs?: number;
  onPoolError?: (err: Error) => void;
}

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(config: DbConfig): DbHandle {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.poolMax ?? 10,
    application_name: config.applicationName ?? 'tix',
    statement_timeout: config.statementTimeoutMs ?? 15_000,
    lock_timeout: config.lockTimeoutMs ?? 5_000,
    idle_in_transaction_session_timeout: config.idleInTransactionTimeoutMs ?? 30_000,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 10_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
  });

  // An idle client error (e.g. DB restart) must never crash the process.
  pool.on('error', (err) => {
    if (config.onPoolError) config.onPoolError(err);
    else console.error('[db] idle client error', err);
  });

  const db = drizzle({ client: pool, schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

/** Round-trip check used by health endpoints. Returns latency in ms. */
export async function pingDb(pool: pg.Pool): Promise<number> {
  const started = performance.now();
  await pool.query('SELECT 1');
  return Math.round((performance.now() - started) * 100) / 100;
}
