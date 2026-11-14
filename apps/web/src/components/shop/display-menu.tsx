'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LocaleMenuItems } from '@/components/locale-switcher';
import { ThemeMenuItems } from '@/components/theme-switcher';
import { routing } from '@/i18n/routing';
import { cn } from '@/lib/utils';

/**
 * Phones: language and colour theme in ONE menu button (the header has no room for two). The
 * language list only shows with more than one locale, the theme items only when the visitor may
 * choose the theme; without either the button is not rendered. `className` carries the breakpoint
 * at which the separate switchers take over.
 */
export function DisplayMenu({ showTheme, className }: { showTheme: boolean; className?: string }) {
  const t = useTranslations('common');
  const [pending, startTransition] = useTransition();
  const showLocale = routing.locales.length > 1;
  if (!showLocale && !showTheme) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn('size-9 shrink-0 px-0', className)}
          disabled={pending}
          aria-label={t('display.label')}
          data-testid="display-menu"
        >
          <SlidersHorizontal className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={8} className="min-w-44">
        {showLocale && (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t('locale.label')}
            </DropdownMenuLabel>
            <LocaleMenuItems onPending={startTransition} />
          </>
        )}
        {showLocale && showTheme && <DropdownMenuSeparator />}
        {showTheme && (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t('theme.label')}
            </DropdownMenuLabel>
            <ThemeMenuItems />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
