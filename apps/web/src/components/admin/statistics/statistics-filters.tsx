'use client';

import {
  MAX_STATS_EVENTS,
  PAYMENT_METHODS,
  SALES_CHANNELS,
  STATS_RANGE_PRESETS,
  type StatsRangePreset,
} from '@tix/shared';
import { Loader2 } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useFilterNavigation } from '@/components/admin/auto-submit-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isApplicableDateValue } from '@/lib/filter-query';
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
}: {
  events: StatisticsFilterEvent[];
  preset: StatsRangePreset;
  /** The resolved inclusive range (also for presets), shown in the date fields. */
  from: string;
  to: string;
  eventIds: string[];
  channels: string[];
  methods: string[];
}) {
  const t = useTranslations('statistics.filters');
  const tc = useTranslations('statistics');
  const format = useFormatter();
  const { navigate, pending } = useFilterNavigation();
  const [fromValue, setFromValue] = useState(from);
  const [toValue, setToValue] = useState(to);
  const [touched, setTouched] = useState(false);
  const [selectedEvents, setSelectedEvents] = useState(eventIds);
  const [selectedChannels, setSelectedChannels] = useState(channels);
  const [selectedMethods, setSelectedMethods] = useState(methods);
  const dateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Not remounted per filter change (open checkbox groups stay open): follow the URL once no
  // filter navigation is in flight any more (chip-free reset, back button, applied changes).
  const propsKey = JSON.stringify([preset, from, to, eventIds, channels, methods]);
  const [syncedKey, setSyncedKey] = useState(propsKey);
  if (syncedKey !== propsKey && !pending) {
    setSyncedKey(propsKey);
    setFromValue(from);
    setToValue(to);
    setTouched(false);
    setSelectedEvents(eventIds);
    setSelectedChannels(channels);
    setSelectedMethods(methods);
  }

  useEffect(
    () => () => {
      if (dateTimer.current) clearTimeout(dateTimer.current);
    },
    [],
  );

  const toggle = (list: string[], value: string, max = Infinity) =>
    list.includes(value)
      ? list.filter((v) => v !== value)
      : list.length >= max
        ? list
        : [...list, value];

  /** Applies the filters right away (current state, overridden by the just changed part). */
  const apply = (
    next: Partial<{
      range: StatsRangePreset;
      from: string;
      to: string;
      events: string[];
      channels: string[];
      methods: string[];
    }> = {},
  ) => {
    if (dateTimer.current) clearTimeout(dateTimer.current);
    dateTimer.current = null;
    const range = next.range ?? (touched ? 'custom' : preset);
    const params = new URLSearchParams();
    params.set('range', range);
    if (range === 'custom') {
      params.set('from', next.from ?? fromValue);
      params.set('to', next.to ?? toValue);
    }
    for (const id of next.events ?? selectedEvents) params.append('event', id);
    for (const c of next.channels ?? selectedChannels) params.append('channel', c);
    for (const m of next.methods ?? selectedMethods) params.append('method', m);
    navigate(params);
  };

  /** A custom range applies after a short pause, once both dates are complete and in order. */
  const changeDate = (field: 'from' | 'to', value: string) => {
    const nextFrom = field === 'from' ? value : fromValue;
    const nextTo = field === 'to' ? value : toValue;
    if (field === 'from') setFromValue(value);
    else setToValue(value);
    setTouched(true);
    if (dateTimer.current) clearTimeout(dateTimer.current);
    dateTimer.current = null;
    const complete = (v: string) => v !== '' && isApplicableDateValue('date', v);
    if (!complete(nextFrom) || !complete(nextTo) || nextFrom > nextTo) return;
    dateTimer.current = setTimeout(
      () => apply({ range: 'custom', from: nextFrom, to: nextTo }),
      400,
    );
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const range = (submitter?.value || (touched ? 'custom' : preset)) as StatsRangePreset;
    // A preset replaces a half-edited custom range.
    if (range !== 'custom') setTouched(false);
    apply({ range });
  };

  const summary = (list: string[], all: string, labelOf: (v: string) => string) =>
    list.length === 0
      ? all
      : list.length <= 2
        ? list.map(labelOf).join(', ')
        : t('eventsSelected', { count: list.length });
  const eventTitle = (id: string) => events.find((e) => e.id === id)?.title ?? id;

  return (
    // Filter toolbar (the CSV export sits in the page header).
    <form
      onSubmit={submit}
      aria-label={t('title')}
      className="space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
      data-testid="statistics-filters"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('range')}>
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
            onChange={(e) => changeDate('from', e.target.value)}
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
            onChange={(e) => changeDate('to', e.target.value)}
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
            onToggle={(v) => {
              const next = toggle(selectedEvents, v, MAX_STATS_EVENTS);
              setSelectedEvents(next);
              apply({ events: next });
            }}
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
            onToggle={(v) => {
              const next = toggle(selectedChannels, v);
              setSelectedChannels(next);
              apply({ channels: next });
            }}
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
            onToggle={(v) => {
              const next = toggle(selectedMethods, v);
              setSelectedMethods(next);
              apply({ methods: next });
            }}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            if (dateTimer.current) clearTimeout(dateTimer.current);
            dateTimer.current = null;
            if (navigate(new URLSearchParams())) return;
            // Already unfiltered: only drop local, not yet applied edits.
            setFromValue(from);
            setToValue(to);
            setTouched(false);
            setSelectedEvents(eventIds);
            setSelectedChannels(channels);
            setSelectedMethods(methods);
          }}
        >
          {t('reset')}
        </Button>
        <Loader2
          className={cn(
            'size-4 shrink-0 text-muted-foreground',
            pending ? 'animate-spin' : 'invisible',
          )}
          aria-hidden
          data-testid={pending ? 'auto-submit-pending' : undefined}
        />
      </div>
    </form>
  );
}
