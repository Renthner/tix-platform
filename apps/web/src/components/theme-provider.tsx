'use client';

import { resolveTheme, themeAreaOf, type ThemeArea, type ThemeConfig } from '@tix/shared';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { THEME_COOKIE, THEME_MAX_AGE_SECONDS, type ThemePreference } from '@/lib/theme';

interface ThemeContextValue {
  preference: ThemePreference;
  /** The theme actually shown (system resolved through the OS setting). */
  resolved: 'light' | 'dark';
  setPreference: (next: ThemePreference) => void;
  /** The shop operator fixed the theme: there is nothing to choose (never true in the admin portal). */
  fixed: boolean;
  area: ThemeArea;
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: 'system',
  resolved: 'light',
  setPreference: () => {},
  fixed: false,
  area: 'shop',
});

function systemIsDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function apply(preference: ThemePreference, area: ThemeArea): 'light' | 'dark' {
  const dark = preference === 'dark' || (preference === 'system' && systemIsDark());
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.dataset.theme = preference;
  root.dataset.area = area;
  root.style.colorScheme = dark ? 'dark' : 'light';
  return dark ? 'dark' : 'light';
}

/**
 * Holds the preference; the server already rendered the matching class on <html>. The root layout
 * is shared by shop and admin portal (soft navigation keeps it), so the area is derived from the
 * current path and the theme is re-applied when it changes.
 */
export function ThemeProvider({
  config,
  initialChoice,
  children,
}: {
  /** Shop theme rules (Settings → Appearance). */
  config: ThemeConfig;
  /** Value of the visitor's theme cookie (null = none). */
  initialChoice: ThemePreference | null;
  children: ReactNode;
}) {
  const area = themeAreaOf(usePathname() ?? '/');
  const [choice, setChoice] = useState<ThemePreference | null>(initialChoice);
  const theme = useMemo(
    () => resolveTheme({ area, config, cookie: choice }),
    [area, config, choice],
  );
  const { preference, defaultPreference, fixed } = theme;
  const [resolved, setResolved] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    setResolved(apply(preference, area));
    if (preference !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved(apply('system', area));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [preference, area]);

  const setPreference = useCallback(
    (next: ThemePreference) => {
      if (fixed) return;
      const secure = window.location.protocol === 'https:' ? '; Secure' : '';
      // Only a choice that differs from the default needs the cookie.
      if (next === defaultPreference) {
        document.cookie = `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
        setChoice(null);
      } else {
        document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=${THEME_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
        setChoice(next);
      }
    },
    [fixed, defaultPreference],
  );

  const value = useMemo(
    () => ({ preference, resolved, setPreference, fixed, area }),
    [preference, resolved, setPreference, fixed, area],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
