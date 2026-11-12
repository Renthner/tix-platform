'use client';

import { forwardRef, type ComponentProps } from 'react';
import { useDefaultLocale } from './default-locale-context';
import { navigationFor } from './navigation-for';

type Navigation = ReturnType<typeof navigationFor>;

/** `Link` following the live default language (no prefix for it, `/<locale>` for the others). */
export const Link = forwardRef<HTMLAnchorElement, ComponentProps<Navigation['Link']>>(
  function Link(props, ref) {
    const Base = navigationFor(useDefaultLocale()).Link;
    return <Base ref={ref} {...props} />;
  },
) as Navigation['Link'];

export function useRouter(): ReturnType<Navigation['useRouter']> {
  return navigationFor(useDefaultLocale()).useRouter();
}

export function usePathname(): ReturnType<Navigation['usePathname']> {
  return navigationFor(useDefaultLocale()).usePathname();
}
