'use client';

import type { DashboardStats } from '@tix/core';
import {
  EVENT_STATUSES,
  applyVisibleOrder,
  moveItem,
  sortByEventOrder,
  type EventStatus,
} from '@tix/shared';
import { Activity, Banknote, GripVertical, ScanLine, Ticket, Users } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { DashboardPayload } from '@/server/admin/dashboard';
import { saveDashboardPreferencesAction } from '@/server/admin/dashboard-actions';
import { EventStatusBadge } from './badges';

/** Refresh interval of the live figures (cheap aggregated queries + Redis counters). */
const POLL_INTERVAL_MS = 8_000;

/** Delay before a keyboard reorder is saved (several key presses become one request). */
const SAVE_DELAY_MS = 500;

/** Sold and reserved use the strong theme colour (the shop's light sold grey is unreadable in a bar). */
const SOLD_COLOR = 'var(--primary)';

const HATCH = 'repeating-linear-gradient(45deg, rgba(255,255,255,.65) 0 3px, transparent 3px 6px)';

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Bar({
  segments,
  total,
  label,
}: {
  segments: { key: string; value: number; color: string; hatched?: boolean }[];
  total: number;
  label: string;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      className="flex h-4 w-full overflow-hidden rounded-full border bg-muted"
    >
      {total > 0 &&
        segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <div
              key={s.key}
              style={{
                width: `${(s.value / total) * 100}%`,
                backgroundColor: s.color,
                backgroundImage: s.hatched ? HATCH : undefined,
              }}
            />
          ))}
    </div>
  );
}

function Legend({
  items,
}: {
  items: { key: string; label: string; value: number; swatch: ReactNode }[];
}) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {items.map((i) => (
        <li key={i.key} className="flex items-center gap-1.5">
          {i.swatch}
          <span className="text-muted-foreground">{i.label}</span>
          <span className="font-medium tabular-nums">{i.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** The statistic blocks of an event card and of the overview (same markup, same role filtering). */
function StatBlocks({
  sections,
  colors,
  stats,
  currency,
  showRevenue,
  money,
}: {
  sections: DashboardPayload['sections'];
  colors: DashboardPayload['colors'];
  stats: DashboardStats;
  currency: string;
  showRevenue?: boolean;
  money: (cents: number, currency?: string) => string;
}) {
  const t = useTranslations('admin.dashboard.live');
  const tm = useTranslations('orders.method');
  const inv = stats.inventory;
  return (
    <>
      {sections.inventory && inv && (
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs font-medium">
            <Ticket className="size-3.5" aria-hidden /> {t('inventory.title')}
            <span className="ml-auto font-normal text-muted-foreground tabular-nums">
              {t('inventory.capacity', { count: inv.capacity })}
            </span>
          </div>
          <Bar
            total={inv.capacity}
            label={t('inventory.aria', {
              sold: inv.sold,
              reserved: inv.reserved,
              locked: inv.locked,
              available: inv.available,
              blocked: inv.blocked,
            })}
            segments={[
              { key: 'sold', value: inv.sold, color: SOLD_COLOR },
              { key: 'reserved', value: inv.reserved, color: SOLD_COLOR, hatched: true },
              { key: 'locked', value: inv.locked, color: colors.locked },
              { key: 'blocked', value: inv.blocked, color: colors.blocked, hatched: true },
            ]}
          />
          <Legend
            items={(
              [
                ['sold', inv.sold, SOLD_COLOR, false],
                ['reserved', inv.reserved, SOLD_COLOR, true],
                ['locked', inv.locked, colors.locked, false],
                ['available', inv.available, 'transparent', false],
                ['blocked', inv.blocked, colors.blocked, true],
              ] as const
            ).map(([key, value, color, hatched]) => ({
              key,
              value,
              label: t(`inventory.${key}`),
              swatch: (
                <span
                  aria-hidden
                  className="inline-block size-3 rounded-sm border"
                  style={{
                    backgroundColor: color,
                    backgroundImage: hatched ? HATCH : undefined,
                  }}
                />
              ),
            }))}
          />
        </div>
      )}
      {sections.inventory && stats.queue && (
        <div className="flex items-center gap-2 text-xs">
          <Users className="size-3.5" aria-hidden />
          <span className="font-medium">{t('queue.title')}</span>
          <span className="text-muted-foreground tabular-nums">
            {t('queue.value', { active: stats.presence ?? 0, waiting: stats.queue.waiting })}
            {stats.queue.lobby > 0 ? ` · ${t('queue.lobby', { count: stats.queue.lobby })}` : ''}
          </span>
        </div>
      )}
      {sections.money && stats.payments && (
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs font-medium">
            <Banknote className="size-3.5" aria-hidden /> {t('payments.title')}
            {showRevenue && (
              <span className="ml-auto font-normal text-muted-foreground tabular-nums">
                {t('overview.revenue')}: {money(stats.revenueCents ?? 0, currency)}
              </span>
            )}
          </div>
          {stats.payments.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('payments.none')}</p>
          ) : (
            <ul className="space-y-0.5 text-xs">
              {stats.payments.map((p) => (
                <li key={p.method} className="flex justify-between gap-2">
                  <span>
                    {tm(p.method as 'PAYPAL')}{' '}
                    <span className="text-muted-foreground">
                      {t('payments.tickets', { count: p.tickets })}
                    </span>
                  </span>
                  <span className="tabular-nums">{money(p.amountCents, currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {sections.checkIn && stats.checkIn && (
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs font-medium">
            <ScanLine className="size-3.5" aria-hidden /> {t('checkIn.title')}
            <span className="ml-auto font-normal text-muted-foreground tabular-nums">
              {stats.checkIn.checkedIn} / {stats.checkIn.valid}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={t('checkIn.title')}
            aria-valuemin={0}
            aria-valuemax={stats.checkIn.valid}
            aria-valuenow={stats.checkIn.checkedIn}
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-primary"
              style={{
                width: `${stats.checkIn.valid > 0 ? (stats.checkIn.checkedIn / stats.checkIn.valid) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}

export function LiveDashboard({ initial }: { initial: DashboardPayload }) {
  const t = useTranslations('admin.dashboard.live');
  const tStatus = useTranslations('admin.eventStatus');
  const locale = useLocale();
  const format = useFormatter();
  const [data, setData] = useState(initial);
  const [stale, setStale] = useState(false);
  const [selected, setSelected] = useState(initial.events[0]?.id ?? '');
  const [filter, setFilter] = useState<EventStatus[]>(initial.preferences.statusFilter);
  /** Local card order: polling never reorders, only the admin does (new events join the end). */
  const [order, setOrder] = useState<string[]>(initial.preferences.eventOrder);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [saveFailed, setSaveFailed] = useState(false);
  const filterRef = useRef(filter);
  const focusHandle = useRef<string | null>(null);
  const saveTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (document.visibilityState === 'hidden') return;
    const requested = filterRef.current;
    try {
      const res = await fetch(`/api/admin/dashboard?statuses=${requested.join(',')}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as DashboardPayload;
      // A response for an outdated filter must not overwrite a newer selection.
      if (filterRef.current !== requested) return;
      setData(next);
      setStale(false);
    } catch {
      setStale(true);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const onVisible = () => void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [refresh]);

  // A keyboard move re-inserts the card in the DOM; give the focus back to its handle.
  useEffect(() => {
    if (focusHandle.current) {
      document.querySelector<HTMLElement>(`[data-handle="${focusHandle.current}"]`)?.focus();
      focusHandle.current = null;
    }
  }, [order]);

  const persist = useCallback(
    async (payload: Parameters<typeof saveDashboardPreferencesAction>[0]) => {
      try {
        const result = await saveDashboardPreferencesAction(payload);
        setSaveFailed(!result.ok);
      } catch {
        setSaveFailed(true);
      }
    },
    [],
  );

  const toggleStatus = (status: EventStatus) => {
    const next = filter.includes(status)
      ? filter.filter((s) => s !== status)
      : EVENT_STATUSES.filter((s) => s === status || filter.includes(s));
    if (next.length === 0) return;
    setFilter(next);
    filterRef.current = next;
    void persist({ statusFilter: next });
    void refresh();
  };

  const { sections, kpis, colors, currency } = data;
  if (!sections.money && !sections.inventory && !sections.checkIn) return null;
  const money = (cents: number, cur: string = currency) => formatMoney(cents, cur, locale);
  const cards = sortByEventOrder(data.events, order);
  const ids = cards.map((c) => c.id);
  const selectedEvent = cards.find((e) => e.id === selected) ?? cards[0];
  const time = format.dateTime(new Date(data.generatedAt), { timeStyle: 'medium' });

  const reorder = (nextVisible: string[], immediate: boolean) => {
    const next = applyVisibleOrder(order, nextVisible);
    setOrder(next);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    if (immediate) void persist({ eventOrder: next });
    else
      saveTimer.current = window.setTimeout(
        () => void persist({ eventOrder: next }),
        SAVE_DELAY_MS,
      );
  };
  const moveBy = (id: string, delta: number) => {
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    focusHandle.current = id;
    reorder(moveItem(ids, from, to), false);
    setAnnouncement(
      t('cards.moved', { title: cards[from]?.title ?? '', position: to + 1, total: ids.length }),
    );
  };
  const endDrag = () => {
    setDragId(null);
    setOverId(null);
  };

  return (
    <section aria-label={t('title')} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Activity className="size-5" aria-hidden /> {t('title')}
        </h2>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {stale ? t('stale') : t('updated', { time })}
        </span>
      </div>

      {sections.money && kpis && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Tile
            label={t('kpi.revenueToday')}
            value={money(kpis.revenueTodayCents)}
            hint={t('kpi.netOfRefunds')}
          />
          <Tile
            label={t('kpi.revenue7d')}
            value={money(kpis.revenue7dCents)}
            hint={t('kpi.netOfRefunds')}
          />
          <div className="rounded-lg border bg-card p-4">
            <label htmlFor="kpi-event" className="text-xs text-muted-foreground">
              {t('kpi.revenueEvent')}
            </label>
            <select
              id="kpi-event"
              value={selectedEvent?.id ?? ''}
              onChange={(e) => setSelected(e.target.value)}
              className="mt-1 block w-full truncate rounded-md border bg-background px-2 py-1 text-sm"
            >
              {cards.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </select>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {money(selectedEvent?.revenueCents ?? 0, selectedEvent?.currency)}
            </div>
          </div>
          <Tile label={t('kpi.ordersToday')} value={String(kpis.ordersToday)} />
          <Tile label={t('kpi.ticketsToday')} value={String(kpis.ticketsSoldToday)} />
          <Tile
            label={t('kpi.openVorkasse')}
            value={money(kpis.openVorkasseCents)}
            hint={t('kpi.openVorkasseCount', { count: kpis.openVorkasseCount })}
          />
          <Tile label={t('kpi.openRefunds')} value={String(data.openRefunds)} />
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <CardTitle className="text-base">
              {t('overview.title')}{' '}
              <span className="text-sm font-normal text-muted-foreground">
                · {t('overview.events', { count: data.overview.eventCount })}
              </span>
            </CardTitle>
            <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
              <legend className="sr-only">{t('overview.statusLabel')}</legend>
              {EVENT_STATUSES.map((status) => (
                <label key={status} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={filter.includes(status)}
                    onChange={() => toggleStatus(status)}
                    disabled={filter.length === 1 && filter.includes(status)}
                  />
                  {tStatus(status)}
                </label>
              ))}
            </fieldset>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.overview.eventCount === 0 ? (
            <p className="text-sm text-muted-foreground">{t('overview.none')}</p>
          ) : (
            <>
              <StatBlocks
                sections={sections}
                colors={colors}
                stats={data.overview}
                currency={currency}
                showRevenue
                money={money}
              />
              {sections.money && data.overview.otherCurrencyEvents ? (
                <p className="text-xs text-muted-foreground">
                  {t('overview.otherCurrency', { count: data.overview.otherCurrencyEvents })}
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {cards.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">
              {t('cards.title')}{' '}
              <span className="font-normal text-muted-foreground">
                {data.overview.eventCount > cards.length
                  ? `· ${t('cards.showing', { shown: cards.length, total: data.overview.eventCount })}`
                  : ''}
              </span>
            </h3>
            <span className="text-xs text-muted-foreground">{t('cards.handleHint')}</span>
          </div>
          {saveFailed && (
            <p role="alert" className="text-xs text-destructive">
              {t('cards.saveFailed')}
            </p>
          )}
          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            {cards.map((e, index) => (
              <Card
                key={e.id}
                data-card={e.id}
                onDragOver={(ev) => {
                  if (dragId === null || dragId === e.id) return;
                  ev.preventDefault();
                  ev.dataTransfer.dropEffect = 'move';
                  setOverId(e.id);
                }}
                onDrop={(ev) => {
                  ev.preventDefault();
                  const from = dragId === null ? -1 : ids.indexOf(dragId);
                  if (from >= 0 && from !== index) reorder(moveItem(ids, from, index), true);
                  endDrag();
                }}
                className={cn(
                  'relative',
                  dragId === e.id && 'opacity-50',
                  overId === e.id && dragId !== e.id && 'shadow-[inset_0_3px_0_var(--primary)]',
                )}
              >
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 pr-9 text-base">
                    <span className="truncate">{e.title}</span>
                    <EventStatusBadge status={e.status} />
                  </CardTitle>
                  <button
                    type="button"
                    draggable
                    data-handle={e.id}
                    aria-label={t('cards.handle', { title: e.title })}
                    title={t('cards.handleHint')}
                    onDragStart={(ev) => {
                      ev.dataTransfer.effectAllowed = 'move';
                      ev.dataTransfer.setData('text/plain', e.id);
                      const card = ev.currentTarget.closest('[data-card]');
                      if (card) ev.dataTransfer.setDragImage(card, 16, 16);
                      setDragId(e.id);
                    }}
                    onDragEnd={endDrag}
                    onKeyDown={(ev) => {
                      const delta =
                        ev.key === 'ArrowUp' || ev.key === 'ArrowLeft'
                          ? -1
                          : ev.key === 'ArrowDown' || ev.key === 'ArrowRight'
                            ? 1
                            : 0;
                      if (delta === 0) return;
                      ev.preventDefault();
                      moveBy(e.id, delta);
                    }}
                    className="absolute top-2 right-2 flex size-7 cursor-grab items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing"
                  >
                    <GripVertical className="size-4" aria-hidden />
                  </button>
                </CardHeader>
                <CardContent className="space-y-4">
                  <StatBlocks
                    sections={sections}
                    colors={colors}
                    stats={e}
                    currency={e.currency}
                    money={money}
                  />
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
