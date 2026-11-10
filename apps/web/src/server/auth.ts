import 'server-only';
import { getSetting } from '@tix/core';
import { adminSessions, adminUsers } from '@tix/db';
import type { AdminRole } from '@tix/shared';
import { generateToken, hashToken, signToken, verifyToken } from '@tix/shared/server';
import { and, eq, gt, sql } from 'drizzle-orm';
import { getLocale } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { redirect } from '@/i18n/navigation';
import { getCore } from './core';
import { getEnv } from './env';
import { cookieDefaults } from './session';
import { assertNotInMaintenance } from './maintenance-assert';

export const ADMIN_COOKIE = 'tix_admin';
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface AdminSession {
  userId: string;
  email: string;
  displayName: string;
  roles: AdminRole[];
  /** SHA-256 of the session token (identifies the current session, e.g. to keep it on password change). */
  tokenHash: string;
  /** Security settings demand two-factor authentication and this user has not set it up yet. */
  twoFactorSetupRequired: boolean;
}

/** SUPER_ADMIN implicitly holds every role. */
export function hasRole(session: AdminSession, roles: readonly AdminRole[]): boolean {
  return session.roles.includes('SUPER_ADMIN') || roles.some((r) => session.roles.includes(r));
}

/** Current admin (memoised per request). Returns null for missing/expired/revoked sessions. */
export const getAdminSession = cache(async (): Promise<AdminSession | null> => {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (!token || token.length > 200) return null;
  const { db } = getCore();
  const [row] = await db
    .select({
      tokenHash: adminSessions.tokenHash,
      lastSeenAt: adminSessions.lastSeenAt,
      userId: adminUsers.id,
      email: adminUsers.email,
      displayName: adminUsers.displayName,
      roles: adminUsers.roles,
      isActive: adminUsers.isActive,
      totp: adminUsers.totpSecretEncrypted,
    })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.userId))
    .where(
      and(eq(adminSessions.tokenHash, hashToken(token)), gt(adminSessions.expiresAt, sql`now()`)),
    );
  if (!row || !row.isActive) return null;
  if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db
      .update(adminSessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(adminSessions.tokenHash, row.tokenHash));
  }
  const twoFactorSetupRequired =
    row.totp === null && (await getSetting(getCore(), 'security')).requireTwoFactor;
  return {
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    roles: row.roles,
    tokenHash: row.tokenHash,
    twoFactorSetupRequired,
  };
});

/**
 * Guards admin pages and actions; redirects to the login page when not signed in. While the
 * security settings demand two-factor authentication and the user has not set it up, everything
 * but the account page (`allowTwoFactorSetup`) redirects there.
 */
export async function requireAdmin(
  roles: readonly AdminRole[] = [],
  options: { allowTwoFactorSetup?: boolean; allowIncompleteRestore?: boolean } = {},
): Promise<AdminSession> {
  // An unfinished restore (database replaced, restore not completed) keeps the system in
  // maintenance mode: only the backup actions and sign-in/out may run (server actions are
  // POSTs to a page URL the proxy lets through, so this is enforced here for every other action).
  if (!options.allowIncompleteRestore) await assertNotInMaintenance();
  const session = await getAdminSession();
  const locale = await getLocale();
  if (!session) return redirect({ href: '/admin/login', locale });
  if (session.twoFactorSetupRequired && !options.allowTwoFactorSetup) {
    return redirect({ href: '/admin/account', locale });
  }
  if (roles.length > 0 && !hasRole(session, roles))
    return redirect({ href: '/admin?denied=1', locale });
  return session;
}

/** For route handlers: returns the session or null (caller responds 401/403). */
export async function adminForApi(roles: readonly AdminRole[] = []): Promise<AdminSession | null> {
  const session = await getAdminSession();
  if (!session || session.twoFactorSetupRequired) return null;
  return roles.length === 0 || hasRole(session, roles) ? session : null;
}

export async function createAdminSession(
  userId: string,
  ipAddress: string | null,
  options: { mfaVerified?: boolean } = {},
): Promise<Date> {
  const { db } = getCore();
  const security = await getSetting(getCore(), 'security');
  const token = generateToken(32);
  const ttlSeconds = security.adminSessionTtlHours * 3600;
  const userAgent = (await headers()).get('user-agent')?.slice(0, 500) ?? null;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await db.insert(adminSessions).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt,
    mfaVerifiedAt: options.mfaVerified ? new Date() : null,
    ipAddress,
    userAgent,
  });
  (await cookies()).set(ADMIN_COOKIE, token, { ...cookieDefaults(ttlSeconds), sameSite: 'strict' });
  return expiresAt;
}

export async function destroyAdminSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(ADMIN_COOKIE)?.value;
  if (token)
    await getCore()
      .db.delete(adminSessions)
      .where(eq(adminSessions.tokenHash, hashToken(token)));
  jar.delete(ADMIN_COOKIE);
}

/** Hash of the current session cookie (null when signed out). */
export async function currentAdminTokenHash(): Promise<string | null> {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  return token && token.length <= 200 ? hashToken(token) : null;
}

// ─── Pending two-factor step ────────────────────────────────────────────────────────────

export const ADMIN_PENDING_COOKIE = 'tix_admin_2fa';
const PENDING_TTL_SECONDS = 5 * 60;
const PENDING_TYPE = 'admin-2fa';

const pendingKey = (nonce: string) => `${getCore().keys.prefix}:admin-2fa:${nonce}`;

/**
 * Between password and second factor the browser holds a short-lived signed cookie bound to
 * the user, the password version (a password change invalidates it) and a one-time nonce kept
 * in Redis: the nonce is consumed when the second factor succeeds, so the cookie cannot be
 * replayed for a second session.
 */
export async function setPendingAdminLogin(
  userId: string,
  passwordChangedAt: Date | null,
): Promise<void> {
  const nonce = generateToken(16);
  await getCore().redis.set(pendingKey(nonce), userId, 'EX', PENDING_TTL_SECONDS);
  const token = signToken(
    PENDING_TYPE,
    { uid: userId, pc: passwordChangedAt?.getTime() ?? 0, n: nonce },
    PENDING_TTL_SECONDS,
    getEnv().SESSION_SECRET,
  );
  (await cookies()).set(ADMIN_PENDING_COOKIE, token, {
    ...cookieDefaults(PENDING_TTL_SECONDS),
    sameSite: 'strict',
  });
}

export async function readPendingAdminLogin(): Promise<{
  userId: string;
  passwordChangedAtMs: number;
  nonce: string;
} | null> {
  const token = (await cookies()).get(ADMIN_PENDING_COOKIE)?.value;
  const claims = verifyToken<{ uid: string; pc: number; n: string }>(
    token,
    PENDING_TYPE,
    getEnv().SESSION_SECRET,
  );
  if (
    !claims ||
    typeof claims.uid !== 'string' ||
    typeof claims.pc !== 'number' ||
    typeof claims.n !== 'string'
  ) {
    return null;
  }
  return { userId: claims.uid, passwordChangedAtMs: claims.pc, nonce: claims.n };
}

/** True while the nonce of a pending login has not been consumed or expired. */
export async function pendingAdminLoginActive(nonce: string, userId: string): Promise<boolean> {
  return (await getCore().redis.get(pendingKey(nonce))) === userId;
}

/** Atomically consumes the nonce; false when it was already used (or expired). */
export async function consumePendingAdminLogin(nonce: string, userId: string): Promise<boolean> {
  return (await getCore().redis.getdel(pendingKey(nonce))) === userId;
}

export async function clearPendingAdminLogin(nonce?: string): Promise<void> {
  if (nonce) await getCore().redis.del(pendingKey(nonce));
  (await cookies()).delete(ADMIN_PENDING_COOKIE);
}
