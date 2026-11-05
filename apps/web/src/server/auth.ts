import 'server-only';
import { getSetting } from '@tix/core';
import { adminSessions, adminUsers } from '@tix/db';
import type { AdminRole } from '@tix/shared';
import { generateToken, hashToken } from '@tix/shared/server';
import { and, eq, gt, sql } from 'drizzle-orm';
import { getLocale } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { redirect } from '@/i18n/navigation';
import { getCore } from './core';
import { cookieDefaults } from './session';

export const ADMIN_COOKIE = 'tix_admin';
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface AdminSession {
  userId: string;
  email: string;
  displayName: string;
  roles: AdminRole[];
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
  return { userId: row.userId, email: row.email, displayName: row.displayName, roles: row.roles };
});

/** Guards admin pages and actions; redirects to the login page when not signed in. */
export async function requireAdmin(roles: readonly AdminRole[] = []): Promise<AdminSession> {
  const session = await getAdminSession();
  const locale = await getLocale();
  if (!session) return redirect({ href: '/admin/login', locale });
  if (roles.length > 0 && !hasRole(session, roles))
    return redirect({ href: '/admin?denied=1', locale });
  return session;
}

/** For route handlers: returns the session or null (caller responds 401/403). */
export async function adminForApi(roles: readonly AdminRole[] = []): Promise<AdminSession | null> {
  const session = await getAdminSession();
  if (!session) return null;
  return roles.length === 0 || hasRole(session, roles) ? session : null;
}

export async function createAdminSession(userId: string, ipAddress: string | null): Promise<void> {
  const { db } = getCore();
  const security = await getSetting(getCore(), 'security');
  const token = generateToken(32);
  const ttlSeconds = security.adminSessionTtlHours * 3600;
  const userAgent = (await headers()).get('user-agent')?.slice(0, 500) ?? null;
  await db.insert(adminSessions).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    ipAddress,
    userAgent,
  });
  (await cookies()).set(ADMIN_COOKIE, token, { ...cookieDefaults(ttlSeconds), sameSite: 'strict' });
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
