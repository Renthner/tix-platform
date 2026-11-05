'use server';

import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { destroyAdminSession } from '@/server/auth';

export async function logoutAction(): Promise<void> {
  await destroyAdminSession();
  redirect({ href: '/admin/login', locale: await getLocale() });
}
