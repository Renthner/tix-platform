'use server';

import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { endAdminSession, endLinkedCustomerSession } from '@/server/admin-login';
import { destroyAdminSession, getAdminSession } from '@/server/auth';

export async function logoutAction(): Promise<void> {
  const session = await getAdminSession();
  if (session) {
    await endLinkedCustomerSession(session.email);
    await endAdminSession(session);
  } else {
    // Expired admin session: a customer session created by the link must not outlive it.
    await endLinkedCustomerSession(null);
    await destroyAdminSession();
  }
  redirect({ href: '/admin/login', locale: await getLocale() });
}
