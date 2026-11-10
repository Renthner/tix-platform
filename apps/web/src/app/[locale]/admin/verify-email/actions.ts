'use server';

import { DomainError, verifyAdminEmail } from '@tix/core';
import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { getCore } from '@/server/core';
import { clientIp, enforceRateLimit } from '@/server/http';

/** Consumes the e-mail verification link (button press, so mail scanners cannot use it up). */
export async function confirmAdminEmailAction(fd: FormData): Promise<void> {
  const token = fd.get('token');
  const locale = await getLocale();
  const ip = await clientIp();
  let status: 'done' | 'invalid' = 'invalid';
  try {
    await enforceRateLimit('admin-verify-email-ip', ip, 20, 15 * 60_000);
    await verifyAdminEmail(getCore(), token, ip === '0.0.0.0' ? null : ip);
    status = 'done';
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
  }
  redirect({ href: { pathname: '/admin/verify-email', query: { status } }, locale });
}
