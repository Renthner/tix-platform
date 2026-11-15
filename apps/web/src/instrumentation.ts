/** Runs once per server process before the first request: fail fast on bad configuration. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { getEnv } = await import('./server/env');
  const { createReloadingSecretBox } = await import('@tix/shared/server');
  const env = getEnv();
  createReloadingSecretBox(env.APP_ENCRYPTION_KEYS);
}
