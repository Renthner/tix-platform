import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@tix/shared';
import { defineRouting } from 'next-intl/routing';

/**
 * Static routing config. The default locale here is only the build-time fallback: the live shop
 * default language (no URL prefix) is applied by `proxy.ts` and `navigation-for.ts`.
 */
export const routing = defineRouting({
  locales: SUPPORTED_LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'as-needed',
  localeCookie: { name: 'tix_locale', maxAge: 60 * 60 * 24 * 365 },
});
