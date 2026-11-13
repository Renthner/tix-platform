'use client';

import {
  MAX_STATS_EVENTS,
  PAYMENT_METHODS,
  SALES_CHANNELS,
  STATS_RANGE_PRESETS,
  type StatsRangePreset,
} from '@tix/shared';
import { Download } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { usePathname, useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

export interface StatisticsFilterEvent {
  id: string;
  title: string;
  startsAt: string;
}

function CheckGroup({
  summary,
  name,
  options,
  selected,
  onToggle,
  hint,
}: {
  summary: string;
  name: string;
  options: { value: string; label: string; detail?: string }[];
  selected: string[];
  onToggle: (value: string) => void;
  hint?: string;
}) {
  return (
    <details className="group relative">
      <summary className="flex h-9 cursor-pointer list-none items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs marker:hidden [&::-webkit-details-marker]:hidden">
        <span className="truncate">{summary}</span>
        <span
          aria-hidden
          className="text-muted-foreground transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <div className="absolute z-30 mt-1 max-h-72 w-[min(22rem,90vw)] overflow-auto rounded-md border bg-popover p-2 shadow-md">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
          >
            <input
              type="checkbox"
              name={name}
              value={option.value}
              checked={selected.includes(option.value)}
              onChange={() => onToggle(option.value)}
              className="mt-0.5 size-4"
            />
            <span className="min-w-0">
              <span className="block truncate">{option.label}</span>
              {option.detail && (
                <span className="block text-xs text-muted-foreground">{option.detail}</span>
              )}
            </span>
          </label>
        ))}
        {hint && <p className="px-2 pt-1 text-xs text-muted-foreground">{hint}</p>}
      </div>
    </details>
  );
}

export function StatisticsFilters({
  events,
  preset,
  from,
  to,
  eventIds,
  channels,
  methods,
  exportQuery,
}: {
  events: StatisticsFilterEvent[];
  preset: StatsRangePreset;
  /** The resolved inclusive range (also for presets), shown in the date fields. */
  from: string;
  to: string;
  eventIds: string[];
  channels: string[];
  methods: string[];
  /** Query string of the current filter for the CSV export link. */
  exportQuery: string;
}) {
  const t = useTranslations('statistics.filters');
  const tc = useTranslations('statistics');
  const format = useFormatter();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [fromValue, setFromValue] = useState(from);
  const [toValue, setToValue] = useState(to);
  const [touched, setTouched] = useState(false);
  const [selectedEvents, setSelectedEvents] = useState(eventIds);
  const [selectedChannels, setSelectedChannels] = useState(channels);
  const [selectedMethods, setSelectedMethods] = useState(methods);

  const toggle = (list: string[], value: string, max = Infinity) =>
    list.includes(value)
      ? list.filter((v) => v !== value)
      : list.length >= max
        ? list
        : [...list, value];

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const range = (submitter?.value || preset) as StatsRangePreset;
    const params = new URLSearchParams();
    params.set('range', range);
    if (range === 'custom') {
      params.set('from', fromValue);
      params.set('to', toValue);
    }
    for (const id of selectedEvents) params.append('event', id);
    for (const c of selectedChannels) params.append('channel', c);
    for (const m of selectedMethods) params.append('method', m);
    router.push(`${pathname}?${params.toString()}`);
  };

  const summary = (list: string[], all: string, labelOf: (v: string) => string) =>
    list.length === 0
      ? all
      : list.length <= 2
        ? list.map(labelOf).join(', ')
        : t('eventsSelected', { count: list.length });
  const eventTitle = (id: string) => events.find((e) => e.id === id)?.title ?? id;

  return (
    <Card>
      <CardContent className="p-4">
        <form onSubmit={submit} aria-label={t('title')} className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label={t('range')}
            >
              {STATS_RANGE_PRESETS.filter((p) => p !== 'custom').map((p) => (
                <Button
                  key={p}
                  type="submit"
                  name="range"
                  value={p}
                  size="sm"
                  variant={preset === p && !touched ? 'default' : 'outline'}
                  aria-pressed={preset === p && !touched}
                >
                  {t(`presets.${p}` as 'presets.today')}
                </Button>
              ))}
            </div>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t('from')}
              <Input
                type="date"
                value={fromValue}
                max={toValue}
                required
                className={cn('w-40', preset === 'custom' && 'border-primary')}
                onChange={(e) => {
                  setFromValue(e.target.value);
                  setTouched(true);
                }}
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t('to')}
              <Input
                type="date"
                value={toValue}
                min={fromValue}
                required
                className={cn('w-40', preset === 'custom' && 'border-primary')}
                onChange={(e) => {
                  setToValue(e.target.value);
                  setTouched(true);
                }}
              />
            </label>
            <div className="grid min-w-44 flex-1 gap-1 text-xs text-muted-foreground sm:flex-none">
              <span>{t('events')}</span>
              <CheckGroup
                summary={summary(selectedEvents, t('eventsAll'), eventTitle)}
                name="event"
                options={events.map((e) => ({
                  value: e.id,
                  label: e.title,
                  detail: format.dateTime(new Date(e.startsAt), { dateStyle: 'medium' }),
                }))}
                selected={selectedEvents}
                onToggle={(v) => setSelectedEvents((l) => toggle(l, v, MAX_STATS_EVENTS))}
                hint={t('eventsLimit', { max: MAX_STATS_EVENTS })}
              />
            </div>
            <div className="grid min-w-40 flex-1 gap-1 text-xs text-muted-foreground sm:flex-none">
              <span>{t('channels')}</span>
              <CheckGroup
                summary={summary(selectedChannels, t('channelsAll'), (v) =>
                  tc(`channel.${v}` as 'channel.ONLINE'),
                )}
                name="channel"
                options={SALES_CHANNELS.map((c) => ({
                  value: c,
                  label: tc(`channel.${c}` as 'channel.ONLINE'),
                }))}
                selected={selectedChannels}
                onToggle={(v) => setSelectedChannels((l) => toggle(l, v))}
              />
            </div>
            <div className="grid min-w-40 flex-1 gap-1 text-xs text-muted-foreground sm:flex-none">
              <span>{t('methods')}</span>
              <CheckGroup
                summary={summary(selectedMethods, t('methodsAll'), (v) =>
                  tc(`method.${v}` as 'method.PAYPAL'),
                )}
                name="method"
                options={PAYMENT_METHODS.map((m) => ({
                  value: m,
                  label: tc(`method.${m}` as 'method.PAYPAL'),
                }))}
                selected={selectedMethods}
                onToggle={(v) => setSelectedMethods((l) => toggle(l, v))}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" name="range" value={touched ? 'custom' : preset}>
              {t('apply')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => router.push(pathname)}>
              {t('reset')}
            </Button>
            <Button asChild size="sm" variant="outline" className="ml-auto">
              <a href={`/api/admin/statistics/export?${exportQuery}&locale=${locale}`} download>
                <Download className="size-4" />
                {t('exportCsv')}
              </a>
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
