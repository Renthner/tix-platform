'use server';

import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { signOutAdminFromShop } from '@/server/admin-login';

/** Sign-out of the shop header's dashboard menu: ends the admin session (and the linked customer session). */
export async function signOutAdminAction(): Promise<void> {
  await signOutAdminFromShop();
  redirect({ href: '/', locale: await getLocale() });
}
