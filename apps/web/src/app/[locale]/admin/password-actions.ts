'use server';

import {
  DomainError,
  acceptAdminInvite,
  requestAdminPasswordReset,
  resetAdminPassword,
} from '@tix/core';
import { SUPPORTED_LOCALES, type AppLocale } from '@tix/shared';
import { getLocale } from 'next-intl/server';
import { after } from 'next/server';
import { z } from 'zod';
import { redirect } from '@/i18n/navigation';
import type { SecurityState } from '@/lib/security-state';
import { getCore } from '@/server/core';
import { clientIp, enforceRateLimit } from '@/server/http';
import { fail, guarded, ok } from '@/server/security-action';

async function rateLimited(bucket: string, subject: string, max: number): Promise<boolean> {
  try {
    await enforceRateLimit(bucket, subject, max, 15 * 60_000);
    return false;
  } catch (err) {
    if (err instanceof DomainError) return true;
    throw err;
  }
}

async function currentLocale(): Promise<AppLocale> {
  const locale = await getLocale();
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale) ? (locale as AppLocale) : 'en';
}

/** "Forgot password": always the same neutral answer, whether or not the address is an admin. */
export async function forgotPasswordAction(
  _prev: SecurityState,
  fd: FormData,
): Promise<SecurityState> {
  const email = z
    .email()
    .max(254)
    .safeParse(String(fd.get('email') ?? '').trim());
  if (!email.success) return fail('VALIDATION');
  const ip = await clientIp();
  if (
    (await rateLimited('admin-forgot-ip', ip, 10)) ||
    (await rateLimited('admin-forgot-email', email.data.toLowerCase(), 3))
  ) {
    return fail('RATE_LIMITED');
  }
  // The lookup and the mail run after the response, so the answer takes the same time whether or
  // not the address belongs to an admin.
  const locale = await currentLocale();
  const address = ip === '0.0.0.0' ? null : ip;
  after(async () => {
    try {
      await requestAdminPasswordReset(getCore(), email.data, locale, address);
    } catch (err) {
      console.error('[admin] password reset request failed', err);
    }
  });
  return ok({ message: 'resetRequested' });
}

/** Sets the password with an invitation or reset link, then sends the user to the sign-in page. */
export async function setPasswordAction(
  mode: 'invite' | 'reset',
  token: string,
  _prev: SecurityState,
  fd: FormData,
): Promise<SecurityState> {
  const password = fd.get('password');
  const confirm = fd.get('confirm');
  if (typeof password !== 'string' || password === '') return fail('VALIDATION');
  if (password !== confirm) return fail('MISMATCH');
  const ip = await clientIp();
  if (await rateLimited('admin-set-password-ip', ip, 20)) return fail('RATE_LIMITED');
  const result = await guarded(async () => {
    const address = ip === '0.0.0.0' ? null : ip;
    if (mode === 'invite') await acceptAdminInvite(getCore(), token, password, address);
    else await resetAdminPassword(getCore(), token, password, address);
    return ok();
  });
  if (result.status !== 'success') return result;
  return redirect({
    href: `/admin/login?notice=${mode === 'invite' ? 'invited' : 'reset'}`,
    locale: await getLocale(),
  });
}
