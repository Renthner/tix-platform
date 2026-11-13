import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CoreContext } from '../context';
import { clearSecretSetting, getSecretSetting, saveSecretSetting } from '../settings';

/**
 * Bearer token of the Prometheus endpoint (`/api/metrics`), a secret setting managed in
 * Settings → Security. No token configured = the endpoint does not exist (404).
 */

type Ctx = Pick<CoreContext, 'db' | 'secrets'>;
type WriteCtx = Pick<CoreContext, 'publisher' | 'channels' | 'secrets'> & {
  db: Parameters<typeof saveSecretSetting>[0]['db'];
};

export async function isMetricsEnabled(ctx: Ctx): Promise<boolean> {
  return (await getSecretSetting(ctx, 'metrics.credentials')) !== null;
}

/** Constant-time comparison (both sides hashed, so the length does not leak). */
export async function verifyMetricsToken(
  ctx: Ctx,
  presented: string | null | undefined,
): Promise<'disabled' | 'denied' | 'ok'> {
  const stored = await getSecretSetting(ctx, 'metrics.credentials');
  if (!stored) return 'disabled';
  if (!presented) return 'denied';
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(stored.token).digest();
  return timingSafeEqual(a, b) ? 'ok' : 'denied';
}

/** Creates (or replaces) the token and returns it - the only time it is ever visible. */
export async function generateMetricsToken(ctx: WriteCtx, userId: string | null): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await saveSecretSetting(ctx, 'metrics.credentials', { token }, userId);
  return token;
}

export async function clearMetricsToken(ctx: WriteCtx): Promise<void> {
  await clearSecretSetting(ctx, 'metrics.credentials');
}
