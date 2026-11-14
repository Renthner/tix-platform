/**
 * Colour theme preference. Stored in the `tix_theme` cookie so the server can render the right
 * `dark` class on <html> (no flash). "system" is resolved by a tiny nonce'd inline script from
 * `prefers-color-scheme` before first paint. The shop operator can fix the theme or choose the
 * default for visitors (Settings → Appearance); the rules live in `@tix/shared` (`resolveTheme`).
 */
export const THEME_COOKIE = 'tix_theme';
/** Remembered for one year. */
export const THEME_MAX_AGE_SECONDS = 365 * 24 * 3600;

export { THEME_PREFERENCES, type ThemePreference } from '@tix/shared';
import type { ThemePreference } from '@tix/shared';

export function parseThemePreference(value: string | undefined | null): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/**
 * Inline script for <head> (CSP nonce required): resolves "system" before first paint. Explicit
 * choices are already rendered by the server. Kept dependency-free and tiny.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var d=document.documentElement;if(d.dataset.theme!=='system')return;var m=window.matchMedia('(prefers-color-scheme: dark)').matches;d.classList.toggle('dark',m);d.style.colorScheme=m?'dark':'light'}catch(e){}})()`;

/** Request header set by the proxy: `admin` for the admin portal, `shop` otherwise. */
export const AREA_HEADER = 'x-tix-area';
