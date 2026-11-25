'use client';

import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface EventFilterOption {
  value: string;
  label: string;
}

const selectClass =
  'border-input bg-background h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * Search + month + city filter of the start page. The cards stay server-rendered and carry
 * `data-search` / `data-month` / `data-city`; this component only hides the ones that do not
 * match (without JavaScript every event stays visible).
 */
export function EventFilter({
  gridId,
  months,
  cities,
}: {
  /** `id` of the card grid. */
  gridId: string;
  months: EventFilterOption[];
  cities: string[];
}) {
  const t = useTranslations('shop.home.filter');
  const id = useId();
  const [query, setQuery] = useState('');
  const [month, setMonth] = useState('');
  const [city, setCity] = useState('');
  const [visible, setVisible] = useState<number | null>(null);

  useEffect(() => {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    const needle = query.trim().toLowerCase();
    let shown = 0;
    for (const card of grid.querySelectorAll<HTMLElement>('[data-event-card]')) {
      const match =
        (!needle || (card.dataset.search ?? '').includes(needle)) &&
        (!month || card.dataset.month === month) &&
        (!city || card.dataset.city === city);
      card.hidden = !match;
      if (match) shown += 1;
    }
    setVisible(shown);
  }, [city, gridId, month, query]);

  const active = query.trim() !== '' || month !== '' || city !== '';
  return (
    <div className="space-y-2" role="search" aria-label={t('label')}>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-q`}>{t('search')}</Label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id={`${id}-q`}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="pl-9"
              autoComplete="off"
            />
          </div>
        </div>
        {months.length > 1 && (
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-m`}>{t('month')}</Label>
            <select
              id={`${id}-m`}
              className={selectClass}
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            >
              <option value="">{t('allMonths')}</option>
              {months.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {cities.length > 1 && (
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-c`}>{t('city')}</Label>
            <select
              id={`${id}-c`}
              className={selectClass}
              value={city}
              onChange={(e) => setCity(e.target.value)}
            >
              <option value="">{t('allCities')}</option>
              {cities.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {active && visible === 0 ? t('noMatch') : ''}
      </p>
    </div>
  );
}
