import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@tix/shared';
import { defineRouting } from 'next-intl/routing';

/** English is the default (no URL prefix); other locales live under /<locale>/… */
export const routing = defineRouting({
  locales: SUPPORTED_LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'as-needed',
  localeCookie: { name: 'tix_locale', maxAge: 60 * 60 * 24 * 365 },
});
