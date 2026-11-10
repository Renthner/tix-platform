'use client';

import { ChevronDown } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';

/** Inline SVG flags (emoji flags are not rendered on Windows). Decorative only. */
function Flag({ locale }: { locale: string }) {
  const common = {
    width: 18,
    height: 12,
    viewBox: '0 0 18 12',
    'aria-hidden': true,
    className: 'shrink-0 rounded-[2px] ring-1 ring-black/10',
  } as const;
  if (locale === 'de') {
    return (
      <svg {...common}>
        <rect width="18" height="4" fill="#000" />
        <rect y="4" width="18" height="4" fill="#d00" />
        <rect y="8" width="18" height="4" fill="#ffce00" />
      </svg>
    );
  }
  if (locale === 'en') {
    return (
      <svg {...common}>
        <rect width="18" height="12" fill="#012169" />
        <path d="M0 0 18 12M18 0 0 12" stroke="#fff" strokeWidth="2.4" />
        <path d="M0 0 18 12M18 0 0 12" stroke="#c8102e" strokeWidth="1" />
        <path d="M9 0v12M0 6h18" stroke="#fff" strokeWidth="4" />
        <path d="M9 0v12M0 6h18" stroke="#c8102e" strokeWidth="2.2" />
      </svg>
    );
  }
  return null;
}

/** Compact language menu: flag + short code; the list opens in a portal aligned to the right. */
export function LocaleSwitcher() {
  const t = useTranslations('common.locale');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 px-2 text-xs"
          disabled={pending}
          aria-label={`${t('label')}: ${t(locale as 'en' | 'de')}`}
        >
          <Flag locale={locale} />
          <span aria-hidden>{locale.toUpperCase()}</span>
          <ChevronDown className="size-3 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={8} className="min-w-36">
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(value) =>
            startTransition(() => router.replace(pathname, { locale: value as typeof locale }))
          }
        >
          {routing.locales.map((l) => (
            <DropdownMenuRadioItem key={l} value={l} className="gap-2 text-sm">
              <Flag locale={l} />
              {t(l)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
