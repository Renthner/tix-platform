import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Arbitrary but fixed advisory-lock key so concurrent migrators queue instead of racing. */
const MIGRATION_LOCK_KEY = 727_001;

export interface MigrateOptions {
  connectionString: string;
  migrationsFolder: string;
  log?: (message: string) => void;
}

export async function runMigrations({
  connectionString,
  migrationsFolder,
  log = console.log,
}: MigrateOptions): Promise<void> {
  const client = new pg.Client({ connectionString, application_name: 'tix-migrate' });
  await client.connect();
  try {
    log('[migrate] acquiring advisory lock');
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    const started = Date.now();
    await migrate(drizzle({ client }), {
      migrationsFolder,
      migrationsTable: '__drizzle_migrations',
      migrationsSchema: 'public',
    });
    log(`[migrate] schema up to date (${Date.now() - started} ms)`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    await client.end();
  }
}
