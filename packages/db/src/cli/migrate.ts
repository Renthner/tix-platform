import { resolve } from 'node:path';
import { loadRootEnv, requireEnv } from '../env';
import { runMigrations } from '../migrate';

loadRootEnv();

const migrationsFolder =
  process.env.MIGRATIONS_DIR ?? resolve(import.meta.dirname, '../../migrations');

runMigrations({ connectionString: requireEnv('DATABASE_URL'), migrationsFolder }).catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
