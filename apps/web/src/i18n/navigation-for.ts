import { SUPPORTED_LOCALES, type AppLocale } from '@tix/shared';
import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';

/**
 * next-intl fixes the default locale (= the unprefixed one) when `createNavigation` runs, but the
 * shop default language is a live setting. The navigation primitives are only configuration, so
 * one instance per possible default locale is created and the matching one is picked at use time.
 */
const make = (defaultLocale: AppLocale) => createNavigation({ ...routing, defaultLocale });

const instances = Object.fromEntries(SUPPORTED_LOCALES.map((d) => [d, make(d)])) as Record<
  AppLocale,
  ReturnType<typeof make>
>;

export function navigationFor(defaultLocale: AppLocale): ReturnType<typeof make> {
  return instances[defaultLocale] ?? instances[routing.defaultLocale];
}
