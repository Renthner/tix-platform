'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';

export function LocaleSwitcher() {
  const t = useTranslations('common.locale');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="sr-only">{t('label')}</span>
      <select
        className="rounded-md border bg-background px-2 py-1 text-xs"
        value={locale}
        disabled={pending}
        onChange={(e) =>
          startTransition(() =>
            router.replace(pathname, { locale: e.target.value as typeof locale }),
          )
        }
      >
        {routing.locales.map((l) => (
          <option key={l} value={l}>
            {t(l)}
          </option>
        ))}
      </select>
    </label>
  );
}
