import { peekDefaultLocale } from './default-locale-state';
import { navigationFor } from './navigation-for';

/**
 * Locale-aware navigation primitives – always use these instead of next/link & next/navigation.
 * The shop default language (Settings → General) has no URL prefix, all others use `/<locale>`:
 * components follow it via context (`DefaultLocaleProvider` in the locale layout), server-side
 * `redirect` / `getPathname` via the process-wide last known value.
 */
export { Link, usePathname, useRouter } from './navigation-client';

type Navigation = ReturnType<typeof navigationFor>;

export const redirect = ((...args: Parameters<Navigation['redirect']>) =>
  navigationFor(peekDefaultLocale()).redirect(...args)) as Navigation['redirect'];

export const getPathname = ((...args: Parameters<Navigation['getPathname']>) =>
  navigationFor(peekDefaultLocale()).getPathname(...args)) as Navigation['getPathname'];
