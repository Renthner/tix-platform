'use client';

import type { KpiSet, SalesStatistics } from '@tix/core';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { useFormatter, useTranslations, type DateTimeFormatOptions } from 'next-intl';
import { useMemo, type ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  BarList,
  ChartCard,
  ColumnChart,
  Heatmap,
  InfoPopover,
  Legend,
  LineChart,
  chartColor,
  type ChartTable,
} from './chart-kit';

type Interval = SalesStatistics['interval'];

/** `2026-06-10T14:00` (already local to the shop time zone) → a Date whose UTC fields carry it. */
const bucketDate = (bucket: string) => new Date(`${bucket}:00Z`);

function Delta({
  current,
  previous,
  invert = false,
}: {
  current: number;
  previous: number;
  invert?: boolean;
}) {
  const t = useTranslations('statistics.kpi');
  const format = useFormatter();
  if (previous === 0 && current === 0) return null;
  if (previous === 0) {
    return <span className="text-xs text-muted-foreground">{t('newBaseline')}</span>;
  }
  const ratio = (current - previous) / previous;
  if (Math.abs(ratio) < 0.0005) {
    return (
      <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
        <Minus className="size-3" aria-hidden />
        {t('noChange')}
      </span>
    );
  }
  const up = ratio > 0;
  const good = invert ? !up : up;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'flex items-center gap-0.5 text-xs font-medium',
        good ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400',
      )}
    >
      <Icon className="size-3" aria-hidden />
      {format.number(ratio, {
        style: 'percent',
        maximumFractionDigits: 0,
        signDisplay: 'exceptZero',
      })}
    </span>
  );
}

function Kpi({
  label,
  value,
  previous,
  delta,
}: {
  label: string;
  value: string;
  previous: string;
  delta: ReactNode;
}) {
  const t = useTranslations('statistics.kpi');
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {delta}
          <span>{t('previous', { value: previous })}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export function StatisticsView({ data }: { data: SalesStatistics }) {
  const t = useTranslations('statistics');
  const tChart = useTranslations('statistics.charts');
  const format = useFormatter();
  const { currency, interval } = data;

  const money = (cents: number) => format.number(cents / 100, { style: 'currency', currency });
  const moneyTick = (cents: number) =>
    format.number(cents / 100, {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    });
  const count = (v: number) => format.number(v, { maximumFractionDigits: 0 });
  const decimal = (v: number) => format.number(v, { maximumFractionDigits: 2 });
  const intervalText = t(`summary.interval.${interval}` as 'summary.interval.day');

  const labelOf = {
    short: (b: string) => {
      const opts: Record<Interval, DateTimeFormatOptions> = {
        hour: {
          hour: '2-digit',
          minute: '2-digit',
          ...(data.range.days > 1 ? { day: 'numeric', month: 'short' } : {}),
        },
        day: { day: 'numeric', month: 'short' },
        week: { day: 'numeric', month: 'short' },
        month: { month: 'short', year: 'numeric' },
      };
      return format.dateTime(bucketDate(b), { timeZone: 'UTC', ...opts[interval] });
    },
    long: (b: string) => {
      const opts: Record<Interval, DateTimeFormatOptions> = {
        hour: { dateStyle: 'medium', timeStyle: 'short' },
        day: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' },
        week: { dateStyle: 'medium' },
        month: { month: 'long', year: 'numeric' },
      };
      return format.dateTime(bucketDate(b), { timeZone: 'UTC', ...opts[interval] });
    },
  };

  const dateOnly = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), { timeZone: 'UTC', dateStyle: 'medium' });

  const labels = data.series.map((p) => labelOf.short(p.bucket));
  const tooltipLabels = data.series.map((p) => labelOf.long(p.bucket));
  const seriesTable = (
    columns: string[],
    pick: (p: SalesStatistics['series'][number]) => ReactNode[],
  ): ChartTable => ({
    columns: [t('csv.bucket'), ...columns],
    rows: data.series.map((p, i) => [tooltipLabels[i], ...pick(p)]),
  });

  const { current, previous } = data.kpis;
  const kpis: {
    key: string;
    label: string;
    pick: (k: KpiSet) => number;
    fmt: (n: number) => string;
    invert?: boolean;
  }[] = [
    { key: 'revenue', label: t('kpi.revenue'), pick: (k) => k.revenueGross, fmt: money },
    { key: 'net', label: t('kpi.net'), pick: (k) => k.revenueNet, fmt: money },
    { key: 'refunds', label: t('kpi.refunds'), pick: (k) => k.refunds, fmt: money, invert: true },
    { key: 'tickets', label: t('kpi.tickets'), pick: (k) => k.tickets, fmt: count },
    { key: 'orders', label: t('kpi.orders'), pick: (k) => k.orders, fmt: count },
    { key: 'aov', label: t('kpi.aov'), pick: (k) => k.averageOrderValue, fmt: money },
    { key: 'tpo', label: t('kpi.ticketsPerOrder'), pick: (k) => k.ticketsPerOrder, fmt: decimal },
  ];

  // Sales curve: one line per event, cumulative by days before the event (oldest on the left).
  const curve = useMemo(() => {
    const maxDays = Math.max(
      0,
      ...data.salesCurve.flatMap((e) => e.points.map((p) => p.daysBefore)),
    );
    const days = Array.from({ length: maxDays + 1 }, (_, i) => maxDays - i);
    return {
      days,
      series: data.salesCurve.map((event, i) => {
        const byDay = new Map(event.points.map((p) => [p.daysBefore, p.tickets]));
        let running = 0;
        return {
          key: event.eventId,
          label: event.title,
          color: chartColor(i),
          values: days.map((d) => (running += byDay.get(d) ?? 0)),
        };
      }),
    };
  }, [data.salesCurve]);

  const heat = useMemo(() => {
    const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    for (const c of data.heatmap) cells[c.dow - 1]![c.hour] = c.orders;
    return cells;
  }, [data.heatmap]);
  const dayNames = [1, 2, 3, 4, 5, 6, 7].map((d) => t(`days.${d}` as 'days.1'));
  const hourText = (h: number) => `${String(h).padStart(2, '0')}`;

  const refundedTotal = data.series.reduce((s, p) => s + p.refundedTickets, 0);
  const totals = {
    revenue: data.series.reduce((s, p) => s + p.revenue, 0),
    tickets: data.series.reduce((s, p) => s + p.tickets, 0),
  };

  const named = (rows: SalesStatistics['byCategory']) =>
    rows.map((r, i) => ({
      key: r.name,
      label: r.name,
      value: r.tickets,
      valueLabel: count(r.tickets),
      detail: money(r.revenue),
      color: chartColor(i),
    }));
  const namedTable = (rows: SalesStatistics['byCategory']): ChartTable => ({
    columns: ['', t('kpi.tickets'), t('kpi.revenue')],
    rows: rows.map((r) => [r.name, count(r.tickets), money(r.revenue)]),
  });
  const keyed = (rows: SalesStatistics['byMethod'], group: 'method' | 'channel') =>
    rows.map((r, i) => ({
      key: r.key,
      label: t(`${group}.${r.key}` as 'method.PAYPAL'),
      value: r.revenue,
      valueLabel: money(r.revenue),
      detail: `${t('kpi.orders')}: ${count(r.orders)} · ${t('kpi.tickets')}: ${count(r.tickets)}`,
      color: chartColor(i),
    }));
  const keyedTable = (
    rows: SalesStatistics['byMethod'],
    group: 'method' | 'channel',
  ): ChartTable => ({
    columns: ['', t('kpi.orders'), t('kpi.tickets'), t('kpi.revenue')],
    rows: rows.map((r) => [
      t(`${group}.${r.key}` as 'method.PAYPAL'),
      count(r.orders),
      count(r.tickets),
      money(r.revenue),
    ]),
  });
  const empty = t('chart.empty');
  const returningShare =
    data.customers.total > 0 ? data.customers.returning / data.customers.total : 0;
  const multiShare =
    data.customers.total > 0 ? data.customers.multiEvent / data.customers.total : 0;
  const percent = (v: number) => format.number(v, { style: 'percent', maximumFractionDigits: 0 });
  const newTotal = data.series.reduce((s, p) => s + p.newCustomerOrders, 0);
  const returningTotal = data.series.reduce((s, p) => s + p.returningCustomerOrders, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <div>
          <div>
            {t('summary.period', {
              from: dateOnly(data.range.from),
              to: dateOnly(data.range.to),
              days: data.range.days,
              zone: data.timeZone,
            })}
          </div>
          <div className="text-xs">
            {t('summary.previous', {
              from: dateOnly(data.previous.from),
              to: dateOnly(data.previous.to),
            })}
          </div>
        </div>
        <InfoPopover label={t('summary.definitionsTitle')}>
          <p className="mb-2 font-medium">{t('summary.definitionsTitle')}</p>
          <ul className="list-disc space-y-1.5 pl-4">
            <li>{t('summary.definitions.sale')}</li>
            <li>{t('summary.definitions.tickets')}</li>
            <li>{t('summary.definitions.revenue')}</li>
            <li>{t('summary.definitions.refunds')}</li>
            <li>{t('summary.definitions.currency')}</li>
          </ul>
        </InfoPopover>
      </div>
      {data.otherCurrencyOrders > 0 && (
        <p className="rounded-md bg-muted p-3 text-sm">
          {t('summary.otherCurrency', { count: data.otherCurrencyOrders, currency })}
        </p>
      )}

      <section aria-label={t('title')} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map((k) => (
          <Kpi
            key={k.key}
            label={k.label}
            value={k.fmt(k.pick(current))}
            previous={k.fmt(k.pick(previous))}
            delta={
              <Delta current={k.pick(current)} previous={k.pick(previous)} invert={k.invert} />
            }
          />
        ))}
      </section>

      <h2 className="pt-2 text-lg font-semibold">{t('sections.timeline')}</h2>
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard
          title={tChart('revenue.title')}
          description={`${tChart('revenue.description')}, ${intervalText}`}
          table={seriesTable([tChart('revenue.series')], (p) => [money(p.revenue)])}
        >
          <LineChart
            labels={labels}
            tooltipLabels={tooltipLabels}
            area
            series={[
              {
                key: 'revenue',
                label: tChart('revenue.series'),
                color: chartColor(0),
                values: data.series.map((p) => p.revenue),
              },
            ]}
            formatValue={money}
            formatTick={moneyTick}
            minMax={1000}
            ariaLabel={tChart('revenue.aria', {
              interval: intervalText,
              total: money(totals.revenue),
            })}
          />
        </ChartCard>
        <ChartCard
          title={tChart('tickets.title')}
          description={`${tChart('tickets.description')}, ${intervalText}`}
          table={seriesTable([tChart('tickets.tickets'), tChart('tickets.orders')], (p) => [
            count(p.tickets),
            count(p.orders),
          ])}
        >
          <LineChart
            labels={labels}
            tooltipLabels={tooltipLabels}
            series={[
              {
                key: 'tickets',
                label: tChart('tickets.tickets'),
                color: chartColor(1),
                values: data.series.map((p) => p.tickets),
              },
              {
                key: 'orders',
                label: tChart('tickets.orders'),
                color: chartColor(2),
                values: data.series.map((p) => p.orders),
              },
            ]}
            formatValue={count}
            integer
            minMax={4}
            ariaLabel={tChart('tickets.aria', {
              interval: intervalText,
              tickets: count(totals.tickets),
            })}
          />
          <Legend
            items={[
              { key: 't', label: tChart('tickets.tickets'), color: chartColor(1) },
              { key: 'o', label: tChart('tickets.orders'), color: chartColor(2) },
            ]}
          />
        </ChartCard>
        <ChartCard
          title={tChart('curve.title')}
          description={tChart('curve.description')}
          className="xl:col-span-2"
          table={{
            columns: ['', ...data.salesCurve.map((e) => e.title)],
            rows: curve.days.map((d, i) => [
              tChart('curve.daysBefore', { days: d }),
              ...curve.series.map((s) => count(s.values[i] ?? 0)),
            ]),
          }}
        >
          {data.salesCurve.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {tChart('curve.empty')}
            </p>
          ) : (
            <>
              <LineChart
                labels={curve.days.map((d) => (d === 0 ? '0' : String(d)))}
                tooltipLabels={curve.days.map((d) =>
                  d === 0 ? tChart('curve.eventDay') : tChart('curve.daysBefore', { days: d }),
                )}
                series={curve.series}
                formatValue={count}
                integer
                minMax={4}
                height={260}
                ariaLabel={tChart('curve.aria', { count: data.salesCurve.length })}
              />
              <Legend
                items={curve.series.map((s) => ({ key: s.key, label: s.label, color: s.color }))}
              />
            </>
          )}
        </ChartCard>
        <ChartCard
          title={tChart('refunds.title')}
          description={`${tChart('refunds.description')}, ${intervalText}`}
          table={seriesTable([tChart('refunds.amount'), tChart('refunds.tickets')], (p) => [
            money(p.refunds),
            count(p.refundedTickets),
          ])}
        >
          <LineChart
            labels={labels}
            tooltipLabels={tooltipLabels}
            area
            series={[
              {
                key: 'refunds',
                label: tChart('refunds.amount'),
                color: chartColor(5),
                values: data.series.map((p) => p.refunds),
              },
            ]}
            formatValue={money}
            formatTick={moneyTick}
            minMax={1000}
            ariaLabel={tChart('refunds.aria', { interval: intervalText })}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {tChart('refunds.tickets')}: {count(refundedTotal)}
          </p>
        </ChartCard>
        <ChartCard
          title={tChart('newReturning.title')}
          description={`${tChart('newReturning.description')}, ${intervalText}`}
          table={seriesTable(
            [tChart('newReturning.new'), tChart('newReturning.returning')],
            (p) => [count(p.newCustomerOrders), count(p.returningCustomerOrders)],
          )}
        >
          <LineChart
            labels={labels}
            tooltipLabels={tooltipLabels}
            series={[
              {
                key: 'new',
                label: tChart('newReturning.new'),
                color: chartColor(3),
                values: data.series.map((p) => p.newCustomerOrders),
              },
              {
                key: 'returning',
                label: tChart('newReturning.returning'),
                color: chartColor(4),
                values: data.series.map((p) => p.returningCustomerOrders),
              },
            ]}
            formatValue={count}
            integer
            minMax={4}
            ariaLabel={tChart('newReturning.aria', { interval: intervalText })}
          />
          <Legend
            items={[
              {
                key: 'n',
                label: `${tChart('newReturning.new')} (${count(newTotal)})`,
                color: chartColor(3),
              },
              {
                key: 'r',
                label: `${tChart('newReturning.returning')} (${count(returningTotal)})`,
                color: chartColor(4),
              },
            ]}
          />
        </ChartCard>
      </div>

      <h2 className="pt-2 text-lg font-semibold">{t('sections.preferences')}</h2>
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard
          title={tChart('category.title')}
          description={tChart('category.description')}
          table={namedTable(data.byCategory)}
        >
          <BarList
            items={named(data.byCategory)}
            ariaLabel={tChart('category.aria')}
            emptyLabel={empty}
          />
        </ChartCard>
        <ChartCard
          title={tChart('tariff.title')}
          description={tChart('tariff.description')}
          table={namedTable(data.byTariff)}
        >
          <BarList
            items={named(data.byTariff)}
            ariaLabel={tChart('tariff.aria')}
            emptyLabel={empty}
          />
        </ChartCard>
        <ChartCard
          title={tChart('method.title')}
          description={tChart('method.description')}
          table={keyedTable(data.byMethod, 'method')}
        >
          <BarList
            items={keyed(data.byMethod, 'method')}
            ariaLabel={tChart('method.aria')}
            emptyLabel={empty}
          />
        </ChartCard>
        <ChartCard
          title={tChart('channel.title')}
          description={tChart('channel.description')}
          table={keyedTable(data.byChannel, 'channel')}
        >
          <BarList
            items={keyed(data.byChannel, 'channel')}
            ariaLabel={tChart('channel.aria')}
            emptyLabel={empty}
          />
        </ChartCard>
        <ChartCard
          title={tChart('heatmap.title')}
          description={tChart('heatmap.description')}
          className="xl:col-span-2"
        >
          <Heatmap
            rowLabels={dayNames}
            hourLabel={hourText}
            cells={heat}
            ariaLabel={tChart('heatmap.aria')}
            cellLabel={(row, hour, value) =>
              tChart('heatmap.cell', {
                day: dayNames[row] ?? '',
                hour: `${hourText(hour)}:00`,
                count: value,
              })
            }
          />
        </ChartCard>
        <ChartCard
          title={tChart('leadTime.title')}
          description={tChart('leadTime.description')}
          table={{
            columns: ['', t('kpi.tickets')],
            rows: data.leadTime.map((l) => [
              tChart('leadTime.bucket', { bucket: l.bucket }),
              count(l.tickets),
            ]),
          }}
        >
          <ColumnChart
            items={data.leadTime.map((l) => ({ key: l.bucket, label: l.bucket, value: l.tickets }))}
            ariaLabel={tChart('leadTime.aria')}
            formatValue={count}
            color={chartColor(0)}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {tChart('leadTime.average', { days: decimal(data.averageLeadDays) })}
          </p>
        </ChartCard>
        <ChartCard
          title={tChart('sections.title')}
          description={tChart('sections.description')}
          table={namedTable(data.bySection)}
        >
          <BarList
            items={named(data.bySection)}
            ariaLabel={tChart('sections.aria')}
            emptyLabel={empty}
          />
        </ChartCard>
        <ChartCard title={t('customers.title')} className="xl:col-span-2">
          {data.customers.total === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t('customers.none')}</p>
          ) : (
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">{t('customers.total')}</dt>
                <dd className="text-2xl font-semibold tabular-nums">
                  {count(data.customers.total)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('customers.returning')}</dt>
                <dd className="text-2xl font-semibold tabular-nums">
                  {count(data.customers.returning)}
                </dd>
                <dd className="text-xs text-muted-foreground">
                  {t('customers.returningShare', { share: percent(returningShare) })}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('customers.multiEvent')}</dt>
                <dd className="text-2xl font-semibold tabular-nums">
                  {count(data.customers.multiEvent)}
                </dd>
                <dd className="text-xs text-muted-foreground">
                  {t('customers.returningShare', { share: percent(multiShare) })}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('customers.perOrder')}</dt>
                <dd className="text-2xl font-semibold tabular-nums">
                  {decimal(current.ticketsPerOrder)}
                </dd>
              </div>
            </dl>
          )}
        </ChartCard>
      </div>
    </div>
  );
}
