import 'server-only';
import { getSetting } from '@tix/core';
import { SUPPORTED_LOCALES } from '@tix/shared';
import { cookies } from 'next/headers';
import { getCore } from '@/server/core';

/** Cookie holding the content language admins edit in (event tabs + seat plan editor). */
export const EDIT_LOCALE_COOKIE = 'tix_edit_locale';

/** Shop default language = language of the base texts. */
export async function getBaseContentLocale(): Promise<string> {
  return (await getSetting(getCore(), 'general')).defaultLocale;
}

/**
 * Language the admin currently edits content in, or null for the base language (the shop default).
 * Only supported, non-default locales qualify.
 */
export async function getEditLocale(): Promise<string | null> {
  const value = (await cookies()).get(EDIT_LOCALE_COOKIE)?.value;
  if (!value || !(SUPPORTED_LOCALES as readonly string[]).includes(value)) return null;
  const base = await getBaseContentLocale();
  return value.split('-')[0] === base.split('-')[0] ? null : value;
}
