import { SUPPORTED_LOCALES } from './i18n';
import type { DefaultTheme, ThemeMode } from './schemas/settings';

/**
 * Colour theme rules. The visitor's choice lives in the `tix_theme` cookie; the shop operator can
 * fix the theme or set the default for visitors without a choice (Settings → Appearance). The
 * admin portal is never affected: admins keep their own switch (default: follow the device).
 */
export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ThemeArea = 'shop' | 'admin';

/** Cookie value → preference; null when absent or unknown. */
export function parseThemeCookie(value: string | undefined | null): ThemePreference | null {
  return value === 'light' || value === 'dark' || value === 'system' ? value : null;
}

const ADMIN_PATH = new RegExp(`^/(?:(?:${SUPPORTED_LOCALES.join('|')})/)?admin(?:/|$)`);

/** Admin portal URL (with or without a locale prefix)? Shared by the proxy and the client. */
export function isAdminPath(pathname: string): boolean {
  return ADMIN_PATH.test(pathname);
}

export function themeAreaOf(pathname: string): ThemeArea {
  return isAdminPath(pathname) ? 'admin' : 'shop';
}

export interface ThemeConfig {
  mode: ThemeMode;
  defaultTheme: DefaultTheme;
}

export interface ResolvedTheme {
  /** What the page renders (the visitor's choice or the default). */
  preference: ThemePreference;
  /** Preference when no cookie exists (a cookie is only needed for a different choice). */
  defaultPreference: ThemePreference;
  /** Fixed by the operator: no switch, the cookie is ignored. */
  fixed: boolean;
}

export function resolveTheme(input: {
  area: ThemeArea;
  config: ThemeConfig;
  cookie: ThemePreference | null;
}): ResolvedTheme {
  const { area, config, cookie } = input;
  if (area === 'admin') {
    return { preference: cookie ?? 'system', defaultPreference: 'system', fixed: false };
  }
  if (config.mode === 'ALWAYS_LIGHT') {
    return { preference: 'light', defaultPreference: 'light', fixed: true };
  }
  if (config.mode === 'ALWAYS_DARK') {
    return { preference: 'dark', defaultPreference: 'dark', fixed: true };
  }
  const defaultPreference = config.defaultTheme.toLowerCase() as ThemePreference;
  return { preference: cookie ?? defaultPreference, defaultPreference, fixed: false };
}
