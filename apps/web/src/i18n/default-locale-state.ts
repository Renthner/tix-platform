import { DEFAULT_LOCALE, isAppLocale, type AppLocale } from '@tix/shared';

/**
 * Last known shop default language (Settings → General), shared by every module instance of
 * the process (proxy and server bundles are separate module graphs → globalThis). Dependency
 * free so navigation helpers can read it synchronously; kept fresh by `getDefaultLocale()`.
 */
const g = globalThis as typeof globalThis & { __tixDefaultLocale?: AppLocale };

export function peekDefaultLocale(): AppLocale {
  return g.__tixDefaultLocale ?? DEFAULT_LOCALE;
}

export function rememberDefaultLocale(value: string): void {
  if (isAppLocale(value)) g.__tixDefaultLocale = value;
}
