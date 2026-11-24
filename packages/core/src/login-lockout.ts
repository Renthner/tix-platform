/**
 * Account-wide password lockout (database level, `failedLoginCount` / `lockedUntil`).
 *
 * A lock keyed by e-mail alone is a lock-out DoS: a stranger could keep a legitimate user out
 * by guessing wrong passwords. The strict, low limit therefore lives in the web layer and is
 * keyed by address + client IP (Settings -> Security: "Failed attempts before lockout"). The
 * account-wide lock only kicks in at this HIGH threshold of consecutive failures (a distributed
 * guessing attack) and expires after `security.lockoutMinutes`. A successful sign-in resets the
 * counter.
 *
 * The object is mutable only so tests can lower the threshold; never change it in production code.
 */
export const ACCOUNT_LOCK_THRESHOLD = 100;

export const accountLock = { threshold: ACCOUNT_LOCK_THRESHOLD };
