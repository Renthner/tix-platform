'use client';

import type { DashboardEvent, DashboardInventory } from '@tix/core';
import { EVENT_STATUSES, type EventStatus } from '@tix/shared';
import { CalendarX2, ChevronDown, Filter } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState } from '@/components/admin/empty-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Link } from '@/i18n/navigation';
import { formatMoney } from '@/lib/money';
import type { DashboardPayload } from '@/server/admin/dashboard';
import { saveDashboardPreferencesAction } from '@/server/admin/dashboard-actions';
import { EventStatusBadge, SaleStateBadge } from './badges';

/** Refresh interval of the live figures (cheap aggregated queries + Redis counters). */
const POLL_INTERVAL_MS = 8_000;

/** Rows of the events table (the payload carries up to 60 events). */
const MAX_ROWS = 15;

/** Sold and reserved use the strong theme colour (the shop's light sold grey is unreadable in a bar). */
const SOLD_COLOR = 'var(--primary)';

const HATCH = 'repeating-linear-gradient(45deg, rgba(255,255,255,.65) 0 3px, transparent 3px 6px)';

function Kpi({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  testId: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-4" data-testid={`dashboard-kpi-${testId}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** Slim sold / reserved / in carts / blocked bar of one event with its numbers. */
function InventoryBar({
  inv,
  colors,
}: {
  inv: DashboardInventory;
  colors: DashboardPayload['colors'];
}) {
  const t = useTranslations('admin.dashboard.live.inventory');
  const segments = [
    { key: 'sold', value: inv.sold, color: SOLD_COLOR, hatched: false },
    { key: 'reserved', value: inv.reserved, color: SOLD_COLOR, hatched: true },
    { key: 'test', value: inv.testHeld, color: 'var(--muted-foreground)', hatched: true },
    { key: 'locked', value: inv.locked, color: colors.locked, hatched: false },
    { key: 'blocked', value: inv.blocked, color: colors.blocked, hatched: true },
  ];
  return (
    <div className="min-w-44 space-y-1">
      <div
        role="img"
        aria-label={t('aria', {
          sold: inv.sold,
          reserved: inv.reserved,
          locked: inv.locked,
          available: inv.available,
          blocked: inv.blocked,
        })}
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        {inv.capacity > 0 &&
          segments
            .filter((s) => s.value > 0)
            .map((s) => (
              <div
                key={s.key}
                style={{
                  width: `${(s.value / inv.capacity) * 100}%`,
                  backgroundColor: s.color,
                  backgroundImage: s.hatched ? HATCH : undefined,
                }}
              />
            ))}
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">
        {t('summary', {
          sold: inv.sold,
          reserved: inv.reserved,
          available: inv.available,
          capacity: inv.capacity,
        })}
      </div>
    </div>
  );
}

function CheckInBar({ checkedIn, valid }: { checkedIn: number; valid: number }) {
  const t = useTranslations('admin.dashboard.live.checkIn');
  return (
    <div className="min-w-28 space-y-1">
      <div
        role="progressbar"
        aria-label={t('title')}
        aria-valuemin={0}
        aria-valuemax={valid}
        aria-valuenow={checkedIn}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full bg-primary"
          style={{ width: `${valid > 0 ? (checkedIn / valid) * 100 : 0}%` }}
        />
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">
        {checkedIn} / {valid}
      </div>
    </div>
  );
}

/** Local calendar day of an instant in a time zone (YYYY-MM-DD). */
function dayIn(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Live part of the dashboard: KPI row (by role) and ONE compact table of the events in scope
 * (status, sale state, seat bar, check-in on the event day). Polls the dashboard API.
 */
export function LiveDashboard({
  initial,
  canOpenEvents,
}: {
  initial: DashboardPayload;
  /** Event titles link to the event overview (event managers). */
  canOpenEvents: boolean;
}) {
  const t = useTranslations('admin.dashboard.live');
  const tStatus = useTranslations('admin.eventStatus');
  const locale = useLocale();
  const format = useFormatter();
  const [data, setData] = useState(initial);
  const [stale, setStale] = useState(false);
  const [filter, setFilter] = useState<EventStatus[]>(initial.preferences.statusFilter);
  const [saveFailed, setSaveFailed] = useState(false);
  const filterRef = useRef(filter);

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
    // No polling while the tab is hidden; coming back refreshes immediately.
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const toggleStatus = (status: EventStatus) => {
    const next = filter.includes(status)
      ? filter.filter((s) => s !== status)
      : EVENT_STATUSES.filter((s) => s === status || filter.includes(s));
    if (next.length === 0) return;
    setFilter(next);
    filterRef.current = next;
    void saveDashboardPreferencesAction({ statusFilter: next })
      .then((result) => setSaveFailed(!result.ok))
      .catch(() => setSaveFailed(true));
    void refresh();
  };

  const { sections, kpis, colors, currency } = data;
  if (!sections.money && !sections.inventory && !sections.checkIn) return null;
  const money = (cents: number, cur: string = currency) => formatMoney(cents, cur, locale);
  const time = format.dateTime(new Date(data.generatedAt), { timeStyle: 'medium' });
  const today = new Date();
  const rows = data.events.slice(0, MAX_ROWS);
  const showCheckIn = (e: DashboardEvent) =>
    Boolean(e.checkIn) &&
    (!sections.inventory ||
      (e.checkIn?.checkedIn ?? 0) > 0 ||
      dayIn(new Date(e.startsAt), e.timeZone) === dayIn(today, e.timeZone));
  const anyCheckIn = rows.some(showCheckIn);

  return (
    <section aria-label={t('title')} className="space-y-4" data-testid="live-dashboard">
      {sections.money && kpis && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          <Kpi
            testId="revenue-today"
            label={t('kpi.revenueToday')}
            value={money(kpis.revenueTodayCents)}
            hint={t('kpi.netOfRefunds')}
          />
          <Kpi
            testId="revenue-7d"
            label={t('kpi.revenue7d')}
            value={money(kpis.revenue7dCents)}
            hint={t('kpi.netOfRefunds')}
          />
          <Kpi
            testId="orders-today"
            label={t('kpi.ordersToday')}
            value={String(kpis.ordersToday)}
          />
          <Kpi
            testId="tickets-today"
            label={t('kpi.ticketsToday')}
            value={String(kpis.ticketsSoldToday)}
          />
          <Kpi
            testId="open-transfers"
            label={t('kpi.openVorkasse')}
            value={money(kpis.openVorkasseCents)}
            hint={t('kpi.openVorkasseCount', { count: kpis.openVorkasseCount })}
          />
        </div>
      )}

      <Card data-testid="dashboard-events">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-base">{t('events.title')}</CardTitle>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {stale ? t('stale') : t('updated', { time })}
              {sections.inventory && data.overview.presence !== undefined && (
                <>
                  {' · '}
                  {t('events.inShop', {
                    active: data.overview.presence,
                    waiting: data.overview.queue?.waiting ?? 0,
                  })}
                </>
              )}
              {sections.inventory && data.overview.serverCapacity && (
                <>
                  {' · '}
                  {t('events.serverCapacity', data.overview.serverCapacity)}
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <details className="group relative">
              <summary className="inline-flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border px-2.5 text-xs select-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
                <Filter className="size-3.5" aria-hidden />
                {t('overview.statusLabel')}
                <span className="rounded-full bg-muted px-1.5 tabular-nums">{filter.length}</span>
                <ChevronDown
                  className="size-3 opacity-70 transition-transform group-open:rotate-180"
                  aria-hidden
                />
              </summary>
              <fieldset className="absolute right-0 z-30 mt-1 w-48 space-y-1.5 rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
                <legend className="sr-only">{t('overview.statusLabel')}</legend>
                {EVENT_STATUSES.map((status) => (
                  <label key={status} className="flex items-center gap-2 text-sm">
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
            </details>
            {canOpenEvents && (
              <Link
                href="/admin/events"
                className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                {t('events.all')}
              </Link>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {saveFailed && (
            <p role="alert" className="mb-2 text-xs text-destructive">
              {t('events.saveFailed')}
            </p>
          )}
          {rows.length === 0 ? (
            <EmptyState size="sm" icon={CalendarX2} title={t('overview.none')} />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('events.columns.event')}</TableHead>
                    <TableHead>{t('events.columns.status')}</TableHead>
                    {sections.inventory && <TableHead>{t('events.columns.seats')}</TableHead>}
                    {anyCheckIn && <TableHead>{t('checkIn.title')}</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((e) => (
                    <TableRow
                      key={e.id}
                      data-testid="dashboard-event-row"
                      className={canOpenEvents ? 'relative focus-within:bg-muted/50' : undefined}
                    >
                      <TableCell className="max-w-72">
                        {canOpenEvents ? (
                          <Link
                            href={`/admin/events/${e.id}`}
                            className="block truncate font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                          >
                            {e.title}
                          </Link>
                        ) : (
                          <span className="block truncate font-medium">{e.title}</span>
                        )}
                        <span className="block text-xs whitespace-nowrap text-muted-foreground">
                          {format.dateTime(new Date(e.startsAt), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                            timeZone: e.timeZone,
                          })}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <EventStatusBadge status={e.status} />
                          {data.saleStates[e.id] &&
                            (e.status === 'PUBLISHED' || e.status === 'POSTPONED') && (
                              <SaleStateBadge state={data.saleStates[e.id]!} />
                            )}
                        </div>
                      </TableCell>
                      {sections.inventory && (
                        <TableCell>
                          {e.inventory ? <InventoryBar inv={e.inventory} colors={colors} /> : '–'}
                        </TableCell>
                      )}
                      {anyCheckIn && (
                        <TableCell>
                          {showCheckIn(e) && e.checkIn ? (
                            <CheckInBar checkedIn={e.checkIn.checkedIn} valid={e.checkIn.valid} />
                          ) : (
                            <span className="text-muted-foreground">–</span>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {data.overview.eventCount > rows.length && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('events.showing', { shown: rows.length, total: data.overview.eventCount })}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
