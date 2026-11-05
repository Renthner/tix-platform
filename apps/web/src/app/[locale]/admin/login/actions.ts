'use server';

import { DomainError, getSetting } from '@tix/core';
import { adminUsers } from '@tix/db';
import { hashPassword, needsRehash, verifyPassword } from '@tix/shared/server';
import { eq, sql } from 'drizzle-orm';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { redirect } from '@/i18n/navigation';
import { createAdminSession } from '@/server/auth';
import { getCore } from '@/server/core';
import { clientIp, enforceRateLimit } from '@/server/http';

export interface LoginState {
  error: 'INVALID' | 'LOCKED' | 'RATE_LIMITED' | null;
}

const schema = z.object({ email: z.email().max(254), password: z.string().min(1).max(1024) });

// Constant-time-ish behaviour for unknown e-mails: verify against a fixed dummy hash.
let dummyHash: Promise<string> | null = null;

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return { error: 'INVALID' };
  const email = parsed.data.email.trim().toLowerCase();
  const ip = await clientIp();
  try {
    await enforceRateLimit('admin-login-ip', ip, 20, 15 * 60_000);
    await enforceRateLimit('admin-login-email', email, 10, 15 * 60_000);
  } catch (err) {
    if (err instanceof DomainError) return { error: 'RATE_LIMITED' };
    throw err;
  }

  const core = getCore();
  const security = await getSetting(core, 'security');
  const [user] = await core.db
    .select()
    .from(adminUsers)
    .where(sql`lower(${adminUsers.email}) = ${email}`);
  if (!user || !user.passwordHash || !user.isActive) {
    dummyHash ??= hashPassword('dummy-password-for-timing');
    await verifyPassword(await dummyHash, parsed.data.password);
    return { error: 'INVALID' };
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) return { error: 'LOCKED' };

  if (!(await verifyPassword(user.passwordHash, parsed.data.password))) {
    const failed = user.failedLoginCount + 1;
    await core.db
      .update(adminUsers)
      .set({
        failedLoginCount: failed >= security.maxFailedLogins ? 0 : failed,
        lockedUntil:
          failed >= security.maxFailedLogins
            ? new Date(Date.now() + security.lockoutMinutes * 60_000)
            : null,
      })
      .where(eq(adminUsers.id, user.id));
    return { error: failed >= security.maxFailedLogins ? 'LOCKED' : 'INVALID' };
  }

  await core.db
    .update(adminUsers)
    .set({
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      ...(needsRehash(user.passwordHash)
        ? { passwordHash: await hashPassword(parsed.data.password) }
        : {}),
    })
    .where(eq(adminUsers.id, user.id));
  await createAdminSession(user.id, ip === '0.0.0.0' ? null : ip);
  return redirect({ href: '/admin', locale: await getLocale() });
}
