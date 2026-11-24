import 'server-only';
import { DomainError, getSetting, rateLimitIpSubject } from '@tix/core';
import { getCore } from './core';
import { enforceRateLimit } from './http';

const MINUTE = 60_000;
/** Account-wide hard block per address, whatever the origin (distributed guessing). */
export const LOGIN_EMAIL_BLOCK_LIMIT = 100;
/** Past this many attempts per address, attempts for that address are serialised. */
const LOGIN_EMAIL_SLOW_LIMIT = 40;
const LOGIN_SLOT_MS = 2_000;

async function exceeded(
  bucket: string,
  subject: string,
  max: number,
  windowMs: number,
): Promise<boolean> {
  try {
    await enforceRateLimit(bucket, subject, max, windowMs);
    return false;
  } catch (err) {
    if (err instanceof DomainError && err.code === 'RATE_LIMITED') return true;
    throw err;
  }
}

/**
 * Password sign-in throttle shared by the shop form and the admin form. Returns true when the
 * attempt must be refused (answer RATE_LIMITED, do not look at the password).
 *
 *  - per client (IPv6 reduced to its /64) and per address + client: the strict limits; a
 *    stranger can never lock the owner out from another client. The address + client limit
 *    follows Settings -> Security (never below 10 attempts per 15 minutes, so ordinary use
 *    and repeated sign-ins are not affected);
 *  - per address from anywhere: hard block at 100 attempts per 15 minutes;
 *  - per address above 40 attempts: attempts are serialised (one per 2 s, Redis "next allowed"
 *    slot) instead of delayed, so parallel guesses are not free.
 */
export async function loginThrottled(
  emailKey: string,
  ip: string,
  kinds: readonly ('customer' | 'admin')[],
): Promise<boolean> {
  const core = getCore();
  const security = await getSetting(core, 'security');
  const ipSubject = rateLimitIpSubject(ip);
  const pairMax = Math.max(10, security.maxFailedLogins);
  const pairWindow = Math.max(15, security.lockoutMinutes) * MINUTE;
  for (const kind of kinds) {
    if (await exceeded(`${kind}-login-ip`, ipSubject, 20, 15 * MINUTE)) return true;
    if (await exceeded(`${kind}-login-email-ip`, `${emailKey}:${ipSubject}`, pairMax, pairWindow)) {
      return true;
    }
  }
  if (await exceeded('login-email-block', emailKey, LOGIN_EMAIL_BLOCK_LIMIT, 15 * MINUTE)) {
    return true;
  }
  if (await exceeded('login-email-global', emailKey, LOGIN_EMAIL_SLOW_LIMIT, 15 * MINUTE)) {
    const claimed = await core.redis.set(
      core.keys.rateLimit('login-slot', emailKey),
      '1',
      'PX',
      LOGIN_SLOT_MS,
      'NX',
    );
    if (claimed !== 'OK') return true;
  }
  return false;
}
