import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Arbitrary but fixed advisory-lock key so concurrent migrators queue instead of racing. */
const MIGRATION_LOCK_KEY = 727_001;
const LOCK_NOT_AVAILABLE = '55P03';

export interface PendingMigration {
  idx: number;
  /** Millisecond timestamp (drizzle `created_at` / `folderMillis`). */
  when: number;
  tag: string;
}

export interface MigrationState {
  /** No migration was ever applied (fresh installation): there is nothing to protect. */
  fresh: boolean;
  /** Number of migrations already applied. */
  applied: number;
  pending: PendingMigration[];
}

export interface MigrateOptions {
  connectionString: string;
  migrationsFolder: string;
  log?: (message: string) => void;
  /**
   * `lock_timeout` of the migration session: a DDL statement that cannot get its table lock
   * within this time fails (and is retried) instead of queueing behind a long transaction and
   * blocking every other query of the shop. 0 = off. Default 10 s.
   */
  lockTimeoutMs?: number;
  /** `statement_timeout` of the migration session, 0 = off. Default 10 min. */
  statementTimeoutMs?: number;
  /** Attempts when the lock timeout strikes (default 5, exponential backoff). */
  lockRetries?: number;
  /** First backoff delay (default 2 s, doubled per attempt). */
  retryDelayMs?: number;
  /**
   * Called under the advisory lock when an existing installation has pending migrations and
   * before the first one is applied (e.g. the pre-update backup). A throw aborts the migration.
   */
  beforeApply?: (state: MigrationState, client: pg.Client) => Promise<void>;
}

/** drizzle may wrap the driver error (`cause`): look through the chain for SQLSTATE 55P03. */
function isLockTimeout(err: unknown): boolean {
  for (let e = err, depth = 0; e && depth < 5; depth += 1) {
    if ((e as { code?: string }).code === LOCK_NOT_AVAILABLE) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readJournal(migrationsFolder: string): Promise<PendingMigration[]> {
  const raw = await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8');
  return (JSON.parse(raw) as { entries: PendingMigration[] }).entries;
}

/**
 * Pending migrations the way drizzle decides it: every journal entry newer than the newest
 * applied `created_at`. Reads only; creates nothing (drizzle creates its table on `migrate`).
 */
export async function readMigrationState(
  client: Pick<pg.Client, 'query'>,
  migrationsFolder: string,
): Promise<MigrationState> {
  const journal = await readJournal(migrationsFolder);
  const exists = await client.query<{ present: boolean }>(
    "SELECT to_regclass('public.__drizzle_migrations') IS NOT NULL AS present",
  );
  if (!exists.rows[0]?.present) return { fresh: true, applied: 0, pending: journal };
  const res = await client.query<{ last: string | null; count: string }>(
    'SELECT max(created_at) AS last, count(*) AS count FROM public.__drizzle_migrations',
  );
  const applied = Number(res.rows[0]?.count ?? 0);
  if (applied === 0) return { fresh: true, applied: 0, pending: journal };
  const last = Number(res.rows[0]?.last ?? 0);
  return { fresh: false, applied, pending: journal.filter((e) => e.when > last) };
}

/** Sessions that currently hold locks on application tables (for the lock-timeout message). */
async function describeLockHolders(client: pg.Client): Promise<string> {
  try {
    const res = await client.query<{ relation: string; app: string; state: string; age: number }>(
      `SELECT c.relname AS relation,
              COALESCE(NULLIF(a.application_name, ''), 'unknown') AS app,
              a.state,
              COALESCE(EXTRACT(EPOCH FROM now() - a.xact_start), 0)::int AS age
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
         JOIN pg_class c ON c.oid = l.relation
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE l.granted
          AND n.nspname = 'public'
          AND a.pid <> pg_backend_pid()
          AND a.datname = current_database()
          AND a.xact_start IS NOT NULL
        ORDER BY a.xact_start
        LIMIT 8`,
    );
    return res.rows
      .map((r) => `${r.relation} (held by "${r.app}", ${r.state}, transaction open ${r.age} s)`)
      .join(', ');
  } catch {
    return '';
  }
}

export async function runMigrations({
  connectionString,
  migrationsFolder,
  log = console.log,
  lockTimeoutMs = 10_000,
  statementTimeoutMs = 600_000,
  lockRetries = 5,
  retryDelayMs = 2_000,
  beforeApply,
}: MigrateOptions): Promise<void> {
  const client = new pg.Client({ connectionString, application_name: 'tix-migrate' });
  await client.connect();
  try {
    log('[migrate] acquiring advisory lock');
    // Waiting for the advisory lock (another migrator) is intentionally unbounded: `lock_timeout`
    // also applies to it, so it is set only afterwards.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    const started = Date.now();
    if (beforeApply) {
      const state = await readMigrationState(client, migrationsFolder);
      if (!state.fresh && state.pending.length > 0) await beforeApply(state, client);
    }
    await client.query('SELECT set_config($1, $2, false)', [
      'lock_timeout',
      `${Math.max(0, Math.floor(lockTimeoutMs))}ms`,
    ]);
    await client.query('SELECT set_config($1, $2, false)', [
      'statement_timeout',
      `${Math.max(0, Math.floor(statementTimeoutMs))}ms`,
    ]);
    for (let attempt = 1; ; attempt += 1) {
      try {
        // All pending migrations run in ONE transaction: a timeout rolls everything back and the
        // call can simply be repeated.
        await migrate(drizzle({ client }), {
          migrationsFolder,
          migrationsTable: '__drizzle_migrations',
          migrationsSchema: 'public',
        });
        break;
      } catch (err) {
        if (!isLockTimeout(err)) throw err;
        // The failed transaction was rolled back by drizzle; make sure the session is usable.
        await client.query('ROLLBACK').catch(() => undefined);
        const holders = await describeLockHolders(client);
        const detail = holders ? ` Open transactions on: ${holders}.` : '';
        if (attempt >= lockRetries) {
          throw new Error(
            `[migrate] gave up after ${attempt} attempts: another session holds a lock that the schema change needs for more than ${lockTimeoutMs} ms.${detail} Stop the application (docker compose stop web worker realtime) and run the update again.`,
            { cause: err },
          );
        }
        const delay = retryDelayMs * 2 ** (attempt - 1);
        log(
          `[migrate] another session holds a lock on a table the migration needs (lock timeout ${lockTimeoutMs} ms, attempt ${attempt}/${lockRetries}).${detail} Retrying in ${delay} ms`,
        );
        await sleep(delay);
      }
    }
    log(`[migrate] schema up to date (${Date.now() - started} ms)`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    await client.end();
  }
}
