/**
 * UI locales shipped with the application. Adding a locale = adding message files under
 * `apps/web/messages/<locale>/` and the code here.
 */
export const SUPPORTED_LOCALES = ['en', 'de'] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = 'en';

export function isAppLocale(value: string): value is AppLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * URL path of `path` in `locale`: the shop default language has no prefix, every other language
 * lives under `/<locale>`. `path` may carry a query and/or hash ("/events?x=1#top"); the root
 * path becomes "/de" (not "/de/") for prefixed locales.
 */
export function localizedPath(locale: string, path: string, defaultLocale: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (locale === defaultLocale) return normalized;
  const cut = normalized.search(/[?#]/);
  const pathname = cut === -1 ? normalized : normalized.slice(0, cut);
  const rest = cut === -1 ? '' : normalized.slice(cut);
  return `/${locale}${pathname === '/' ? '' : pathname}${rest}`;
}

/** Base language of a locale tag ("de-DE" → "de") if supported, else "en". */
export function normalizeLocale(tag: string | null | undefined): AppLocale {
  const base = (tag ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  return isAppLocale(base) ? base : 'en';
}
