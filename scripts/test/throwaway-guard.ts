/**
 * Vitest setup file (per worker). Integration tests may only talk to a throw-away Postgres/Redis:
 * unless TIX_TEST_THROWAWAY=1 is set, every connection variable is removed from the environment
 * so the tests skip instead of touching a real stack.
 */
if (process.env.TIX_TEST_THROWAWAY !== '1') {
  for (const name of [
    'TEST_DATABASE_URL',
    'BACKUP_TEST_DATABASE_URL',
    'TEST_REDIS_URL',
    'REDIS_URL',
    'DATABASE_URL',
    'TEST_S3_OPT_IN',
  ]) {
    delete process.env[name];
  }
}
