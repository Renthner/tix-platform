'use client';

import { DEFAULT_LOCALE, type AppLocale } from '@tix/shared';
import { createContext, useContext, type ReactNode } from 'react';

const DefaultLocaleContext = createContext<AppLocale>(DEFAULT_LOCALE);

/** Provides the live shop default language (the one without URL prefix) to client components. */
export function DefaultLocaleProvider({
  value,
  children,
}: {
  value: AppLocale;
  children: ReactNode;
}) {
  return <DefaultLocaleContext.Provider value={value}>{children}</DefaultLocaleContext.Provider>;
}

export function useDefaultLocale(): AppLocale {
  return useContext(DefaultLocaleContext);
}
