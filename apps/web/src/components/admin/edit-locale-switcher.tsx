'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { setEditLocaleAction } from '@/server/admin/translations';
import { NativeSelect } from './form-controls';

export interface EditLocaleOption {
  locale: string;
  done: number;
  total: number;
}

/**
 * Content language dropdown of the event admin header (and the seat plan editor): the base
 * language (shop default) or a translation language with its completeness.
 */
export function EditLocaleSwitcher({
  baseLocale,
  current,
  options,
  compact,
}: {
  baseLocale: string;
  /** Currently edited locale (base locale = default). */
  current: string;
  options: EditLocaleOption[];
  compact?: boolean;
}) {
  const t = useTranslations('translations');
  const uiLocale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const names = new Intl.DisplayNames([uiLocale], { type: 'language' });
  const name = (l: string) => names.of(l) ?? l;
  if (options.length === 0) return null;
  return (
    <label className="flex items-center gap-2 text-sm">
      {!compact && <span className="text-muted-foreground">{t('switcher.label')}</span>}
      <NativeSelect
        aria-label={t('switcher.label')}
        value={current}
        disabled={pending}
        className="h-9 w-auto min-w-44"
        onChange={(e) => {
          const next = e.target.value;
          startTransition(async () => {
            await setEditLocaleAction(next === baseLocale ? '' : next);
            router.refresh();
          });
        }}
      >
        <option value={baseLocale}>
          {name(baseLocale)} {t('switcher.default')}
        </option>
        {options.map((o) => (
          <option key={o.locale} value={o.locale}>
            {name(o.locale)} – {t('switcher.completeness', { done: o.done, total: o.total })}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}
