'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTheme } from '@/components/theme-provider';
import { THEME_PREFERENCES, parseThemePreference } from '@/lib/theme';

const ICONS = { system: Monitor, light: Sun, dark: Moon } as const;

/** Radio items for System / Light / Dark, to embed in another dropdown (e.g. the shop admin menu). */
export function ThemeMenuItems({ className }: { className?: string }) {
  const t = useTranslations('common.theme');
  const { preference, setPreference } = useTheme();
  return (
    <DropdownMenuRadioGroup
      className={className}
      value={preference}
      onValueChange={(v) => setPreference(parseThemePreference(v))}
      aria-label={t('label')}
    >
      {THEME_PREFERENCES.map((p) => {
        const Item = ICONS[p];
        return (
          <DropdownMenuRadioItem key={p} value={p} className="gap-2 text-sm">
            <Item className="size-4" aria-hidden />
            {t(p)}
          </DropdownMenuRadioItem>
        );
      })}
    </DropdownMenuRadioGroup>
  );
}

/** Colour theme menu: System (follows the OS, default) / Light / Dark. */
export function ThemeSwitcher() {
  const t = useTranslations('common.theme');
  const { preference, setPreference } = useTheme();
  const Icon = ICONS[preference];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 w-8 shrink-0 px-0"
          aria-label={`${t('label')}: ${t(preference)}`}
          data-testid="theme-switcher"
        >
          <Icon className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={8} className="min-w-36">
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(v) => setPreference(parseThemePreference(v))}
        >
          {THEME_PREFERENCES.map((p) => {
            const Item = ICONS[p];
            return (
              <DropdownMenuRadioItem key={p} value={p} className="gap-2 text-sm">
                <Item className="size-4" aria-hidden />
                {t(p)}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
