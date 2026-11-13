import type { Database } from '@tix/db';
import { sql, type SQL } from 'drizzle-orm';
import type { CoreContext } from '../context';
import { getSetting } from '../settings';
import {
  chooseInterval,
  previousPeriod,
  rangeDays,
  resolveRange,
  windowInstants,
  type DateRange,
  type StatisticsFilter,
  type StatsInterval,
} from './range';

/**
 * Sales statistics of the admin portal (one SQL aggregation per block, nothing is loaded into
 * memory). Definitions (also shown to the admin in the info popover):
 *
 * - A sale is an order with `paid_at` set (cancelled-before-payment orders and bank allocations
 *   that were reversed have none). It counts on its payment date, in the shop time zone
 *   (`general.defaultTimeZone`); an order paid in March and refunded in May is +March, -May.
 * - Tickets = order items in CONFIRMED or REFUNDED state. Items replaced by a seat change
 *   (CANCELLED) are not counted again.
 * - Revenue (gross) = price of those tickets + the service fees of the order. With an event
 *   filter only items of the chosen events and fees booked to them (per-order fees cannot be
 *   attributed to an event and are left out). Tariff upgrades stay on the original payment date.
 * - Refunds = successful refunds (not pure overpayment refunds) on their processing date; with
 *   an event filter only the share that pays back tickets / fees of those events.
 *   Net revenue = gross revenue - refunds.
 * - Only orders in the shop currency are summed (others are counted in `otherCurrencyOrders`).
 * - "Days before the event" uses the event's own time zone.
 */

export interface StatisticsQuery extends StatisticsFilter {
  /** Overrides "now" (tests; such results are not cached). */
  now?: Date;
}

export interface KpiSet {
  revenueGross: number;
  refunds: number;
  revenueNet: number;
  tickets: number;
  orders: number;
  averageOrderValue: number;
  ticketsPerOrder: number;
}

export interface SeriesPoint {
  /** Local start of the bucket, `YYYY-MM-DDTHH:MM` (no zone: already in the shop time zone). */
  bucket: string;
  revenue: number;
  tickets: number;
  orders: number;
  refunds: number;
  refundedTickets: number;
  newCustomerOrders: number;
  returningCustomerOrders: number;
}

export interface NamedBreakdown {
  name: string;
  tickets: number;
  revenue: number;
}

export interface KeyedBreakdown {
  key: string;
  orders: number;
  tickets: number;
  revenue: number;
}

export interface SalesCurveEvent {
  eventId: string;
  title: string;
  startsAt: string;
  /** Daily sales, `daysBefore` 0 = event day (later sales and the door count as 0). */
  points: { daysBefore: number; tickets: number; revenue: number }[];
  total: number;
}

export const LEAD_TIME_BUCKETS = [
  '0',
  '1-2',
  '3-7',
  '8-14',
  '15-30',
  '31-60',
  '61-90',
  '91+',
] as const;
export type LeadTimeBucket = (typeof LEAD_TIME_BUCKETS)[number];

export interface SalesStatistics {
  generatedAt: string;
  timeZone: string;
  currency: string;
  range: DateRange & { days: number };
  previous: DateRange;
  interval: StatsInterval;
  kpis: { current: KpiSet; previous: KpiSet };
  otherCurrencyOrders: number;
  series: SeriesPoint[];
  salesCurve: SalesCurveEvent[];
  byCategory: NamedBreakdown[];
  byTariff: NamedBreakdown[];
  bySection: NamedBreakdown[];
  byMethod: KeyedBreakdown[];
  byChannel: KeyedBreakdown[];
  /** Sparse: only hours with sales. `dow` 1 = Monday … 7 = Sunday, `hour` 0-23. */
  heatmap: { dow: number; hour: number; orders: number; tickets: number }[];
  leadTime: { bucket: LeadTimeBucket; tickets: number }[];
  averageLeadDays: number;
  customers: { total: number; returning: number; multiEvent: number };
}

const num = (v: unknown) => Number(v ?? 0) || 0;
const SOLD = sql`('CONFIRMED','REFUNDED')`;
const MAX_CURVE_EVENTS = 8;
const DEFAULT_CURVE_EVENTS = 6;
const STATEMENT_TIMEOUT_MS = 15_000;

interface Window {
  start: Date;
  end: Date;
}

interface Scope {
  currency: string;
  timeZone: string;
  filter: StatisticsFilter;
}

const list = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/** Channel / method restriction of an `orders` alias. */
function orderFilter(f: StatisticsFilter, alias: string): SQL {
  const a = sql.raw(alias);
  return sql`${f.channels.length ? sql`AND ${a}.channel IN (${list(f.channels)})` : sql``}
    ${f.methods.length ? sql`AND ${a}.payment_method IN (${list(f.methods)})` : sql``}`;
}

function eventFilter(f: StatisticsFilter, alias: string): SQL {
  return f.eventIds.length ? sql`AND ${sql.raw(alias)}.event_id IN (${list(f.eventIds)})` : sql``;
}

/** One row per sold order of the window with its ticket count and gross revenue. */
function ordCte(scope: Scope, w: Window, options: { firstPaid?: boolean } = {}): SQL {
  const f = scope.filter;
  return sql`ord AS (
    SELECT o.id, o.paid_at, o.customer_id, o.channel, o.payment_method AS method,
           COALESCE(i.tickets, 0) AS tickets,
           COALESCE(i.revenue, 0) + COALESCE(fe.revenue, 0) AS revenue
           ${
             options.firstPaid
               ? sql`, (SELECT min(x.paid_at) FROM orders x
                        WHERE x.customer_id = o.customer_id AND x.paid_at IS NOT NULL) AS first_paid`
               : sql``
           }
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS tickets, COALESCE(sum(oi.price_gross), 0)::bigint AS revenue
      FROM order_items oi
      WHERE oi.order_id = o.id AND oi.status IN ${SOLD} ${eventFilter(f, 'oi')}
    ) i ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(ofee.total_gross), 0)::bigint AS revenue
      FROM order_fees ofee
      WHERE ofee.order_id = o.id ${eventFilter(f, 'ofee')}
    ) fe ON true
    WHERE o.paid_at >= ${ts(w.start)} AND o.paid_at < ${ts(w.end)}
      AND o.currency = ${scope.currency} ${orderFilter(f, 'o')}
      ${f.eventIds.length ? sql`AND COALESCE(i.tickets, 0) > 0` : sql``}
  )`;
}

/** Successful refunds (without overpayment refunds) with their amount attributed to the filter. */
function refundCte(scope: Scope, w: Window): SQL {
  const f = scope.filter;
  const amount = f.eventIds.length
    ? sql`(SELECT COALESCE(sum(ri.amount), 0)::bigint FROM refund_items ri
           LEFT JOIN order_items roi ON roi.id = ri.order_item_id
           LEFT JOIN order_fees rof ON rof.id = ri.order_fee_id
           WHERE ri.refund_id = r.id
             AND COALESCE(roi.event_id, rof.event_id) IN (${list(f.eventIds)}))`
    : sql`r.amount`;
  return sql`rf AS (
    SELECT COALESCE(r.processed_at, r.completed_at, r.updated_at) AS at, ${amount} AS amount
    FROM refunds r JOIN orders o ON o.id = r.order_id
    WHERE r.status = 'SUCCEEDED' AND NOT r.overpayment
      AND COALESCE(r.processed_at, r.completed_at, r.updated_at) >= ${ts(w.start)}
      AND COALESCE(r.processed_at, r.completed_at, r.updated_at) < ${ts(w.end)}
      AND o.currency = ${scope.currency} ${orderFilter(f, 'o')}
  )`;
}

/** Tickets of paid orders that were cancelled / refunded in the window. */
function cancelledCte(scope: Scope, w: Window): SQL {
  const f = scope.filter;
  return sql`cx AS (
    SELECT oi.refunded_at AS at
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.status = 'REFUNDED' AND oi.refunded_at >= ${ts(w.start)} AND oi.refunded_at < ${ts(w.end)}
      AND o.paid_at IS NOT NULL AND o.currency = ${scope.currency}
      ${orderFilter(f, 'o')} ${eventFilter(f, 'oi')}
  )`;
}

/**
 * At most this many statistics queries run at once in a process: one uncached load fans out into a
 * dozen aggregations and must not take the connection pool away from the shop.
 */
const MAX_PARALLEL_QUERIES = 4;
let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL_QUERIES) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function run<T extends Record<string, unknown>>(db: Database, query: SQL): Promise<T[]> {
  return withSlot(() =>
    db.transaction(async (tx) => {
      await tx.execute(sql.raw('SET TRANSACTION READ ONLY'));
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
      return (await tx.execute<T>(query)).rows as T[];
    }),
  );
}

const kpiSet = (revenue: number, refunds: number, tickets: number, orders: number): KpiSet => ({
  revenueGross: revenue,
  refunds,
  revenueNet: revenue - refunds,
  tickets,
  orders,
  averageOrderValue: orders > 0 ? Math.round(revenue / orders) : 0,
  ticketsPerOrder: orders > 0 ? Math.round((tickets / orders) * 100) / 100 : 0,
});

async function loadKpis(db: Database, scope: Scope, cur: Window, prev: Window) {
  const whole: Window = { start: prev.start, end: cur.end };
  const [sold, refunds] = await Promise.all([
    run<Record<string, unknown>>(
      db,
      sql`WITH ${ordCte(scope, whole)}
      SELECT
        count(*) FILTER (WHERE paid_at >= ${ts(cur.start)})::int AS c_orders,
        COALESCE(sum(tickets) FILTER (WHERE paid_at >= ${ts(cur.start)}), 0)::bigint AS c_tickets,
        COALESCE(sum(revenue) FILTER (WHERE paid_at >= ${ts(cur.start)}), 0)::bigint AS c_revenue,
        count(*) FILTER (WHERE paid_at < ${ts(cur.start)})::int AS p_orders,
        COALESCE(sum(tickets) FILTER (WHERE paid_at < ${ts(cur.start)}), 0)::bigint AS p_tickets,
        COALESCE(sum(revenue) FILTER (WHERE paid_at < ${ts(cur.start)}), 0)::bigint AS p_revenue
      FROM ord`,
    ),
    run<Record<string, unknown>>(
      db,
      sql`WITH ${refundCte(scope, whole)}
      SELECT
        COALESCE(sum(amount) FILTER (WHERE at >= ${ts(cur.start)}), 0)::bigint AS c_refunds,
        COALESCE(sum(amount) FILTER (WHERE at < ${ts(cur.start)}), 0)::bigint AS p_refunds
      FROM rf`,
    ),
  ]);
  const s = sold[0] ?? {};
  const r = refunds[0] ?? {};
  return {
    current: kpiSet(num(s.c_revenue), num(r.c_refunds), num(s.c_tickets), num(s.c_orders)),
    previous: kpiSet(num(s.p_revenue), num(r.p_refunds), num(s.p_tickets), num(s.p_orders)),
  };
}

async function loadOtherCurrency(db: Database, scope: Scope, w: Window): Promise<number> {
  const f = scope.filter;
  const rows = await run<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM orders o
        WHERE o.paid_at >= ${ts(w.start)} AND o.paid_at < ${ts(w.end)}
          AND o.currency <> ${scope.currency} ${orderFilter(f, 'o')}
          ${
            f.eventIds.length
              ? sql`AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id ${eventFilter(f, 'oi')})`
              : sql``
          }`,
  );
  return num(rows[0]?.n);
}

async function loadSeries(
  db: Database,
  scope: Scope,
  w: Window,
  interval: StatsInterval,
): Promise<SeriesPoint[]> {
  const unit = sql.raw(`'${interval}'`);
  const step = sql.raw(`interval '1 ${interval}'`);
  const tz = sql`${scope.timeZone}::text`;
  const buckets = sql`b AS (
    SELECT g AS bucket FROM generate_series(
      date_trunc(${unit}, ${ts(w.start)}, ${tz}),
      ${ts(w.end)} - interval '1 microsecond', ${step}, ${tz}) g
  )`;
  const label = (instant: SQL) =>
    sql`to_char(${instant} AT TIME ZONE ${tz}, 'YYYY-MM-DD"T"HH24:MI')`;
  const truncated = sql`date_trunc(${unit}, at, ${tz})`;
  const [sales, refunds, cancelled] = await Promise.all([
    run<Record<string, unknown>>(
      db,
      sql`WITH ${ordCte(scope, w, { firstPaid: true })}, ${buckets},
        a AS (
          SELECT date_trunc(${unit}, paid_at, ${tz}) AS bucket,
                 count(*)::int AS orders, sum(tickets)::int AS tickets, sum(revenue)::bigint AS revenue,
                 count(*) FILTER (WHERE customer_id IS NOT NULL AND first_paid = paid_at)::int AS new_orders,
                 count(*) FILTER (WHERE customer_id IS NOT NULL AND first_paid < paid_at)::int AS returning_orders
          FROM ord GROUP BY 1
        )
        SELECT ${label(sql`b.bucket`)} AS label,
               COALESCE(a.orders, 0) AS orders, COALESCE(a.tickets, 0) AS tickets,
               COALESCE(a.revenue, 0) AS revenue, COALESCE(a.new_orders, 0) AS new_orders,
               COALESCE(a.returning_orders, 0) AS returning_orders
        FROM b LEFT JOIN a ON a.bucket = b.bucket ORDER BY b.bucket`,
    ),
    run<Record<string, unknown>>(
      db,
      sql`WITH ${refundCte(scope, w)}
        SELECT ${label(truncated)} AS label,
               sum(amount)::bigint AS amount
        FROM rf GROUP BY 1`,
    ),
    run<Record<string, unknown>>(
      db,
      sql`WITH ${cancelledCte(scope, w)}
        SELECT ${label(truncated)} AS label,
               count(*)::int AS n
        FROM cx GROUP BY 1`,
    ),
  ]);
  const refundBy = new Map(refunds.map((r) => [String(r.label), num(r.amount)]));
  const cancelBy = new Map(cancelled.map((r) => [String(r.label), num(r.n)]));
  return sales.map((r) => {
    const bucket = String(r.label);
    return {
      bucket,
      revenue: num(r.revenue),
      tickets: num(r.tickets),
      orders: num(r.orders),
      refunds: refundBy.get(bucket) ?? 0,
      refundedTickets: cancelBy.get(bucket) ?? 0,
      newCustomerOrders: num(r.new_orders),
      returningCustomerOrders: num(r.returning_orders),
    };
  });
}

type ItemColumn = 'category_name' | 'ticket_type_name' | 'section_label';

async function loadItemBreakdown(
  db: Database,
  scope: Scope,
  w: Window,
  column: ItemColumn,
  limit: number,
): Promise<NamedBreakdown[]> {
  const col = sql.raw(`oi.${column}`);
  const rows = await run<Record<string, unknown>>(
    db,
    sql`WITH ${ordCte(scope, w)}
      SELECT ${col} AS name, count(*)::int AS tickets, sum(oi.price_gross)::bigint AS revenue
      FROM order_items oi JOIN ord ON ord.id = oi.order_id
      WHERE oi.status IN ${SOLD} ${eventFilter(scope.filter, 'oi')}
      GROUP BY 1 ORDER BY tickets DESC, revenue DESC, name LIMIT ${limit}`,
  );
  return rows.map((r) => ({
    name: String(r.name),
    tickets: num(r.tickets),
    revenue: num(r.revenue),
  }));
}

async function loadKeyed(
  db: Database,
  scope: Scope,
  w: Window,
  column: 'method' | 'channel',
): Promise<KeyedBreakdown[]> {
  const col = sql.raw(column);
  const rows = await run<Record<string, unknown>>(
    db,
    sql`WITH ${ordCte(scope, w)}
      SELECT ${col}::text AS key, count(*)::int AS orders, sum(tickets)::int AS tickets,
             sum(revenue)::bigint AS revenue
      FROM ord GROUP BY 1 ORDER BY revenue DESC, key`,
  );
  return rows.map((r) => ({
    key: String(r.key),
    orders: num(r.orders),
    tickets: num(r.tickets),
    revenue: num(r.revenue),
  }));
}

async function loadHeatmap(db: Database, scope: Scope, w: Window) {
  const tz = sql`${scope.timeZone}::text`;
  const rows = await run<Record<string, unknown>>(
    db,
    sql`WITH ${ordCte(scope, w)}
      SELECT extract(isodow FROM paid_at AT TIME ZONE ${tz})::int AS dow,
             extract(hour FROM paid_at AT TIME ZONE ${tz})::int AS hour,
             count(*)::int AS orders, sum(tickets)::int AS tickets
      FROM ord GROUP BY 1, 2`,
  );
  return rows.map((r) => ({
    dow: num(r.dow),
    hour: num(r.hour),
    orders: num(r.orders),
    tickets: num(r.tickets),
  }));
}

async function loadLeadTime(db: Database, scope: Scope, w: Window) {
  const rows = await run<Record<string, unknown>>(
    db,
    sql`WITH ${ordCte(scope, w)}, lt AS (
        SELECT GREATEST(
                 (e.starts_at AT TIME ZONE e.time_zone)::date - (ord.paid_at AT TIME ZONE e.time_zone)::date,
                 0) AS days
        FROM order_items oi JOIN ord ON ord.id = oi.order_id JOIN events e ON e.id = oi.event_id
        WHERE oi.status IN ${SOLD} ${eventFilter(scope.filter, 'oi')}
      )
      SELECT CASE WHEN days = 0 THEN '0' WHEN days <= 2 THEN '1-2' WHEN days <= 7 THEN '3-7'
                  WHEN days <= 14 THEN '8-14' WHEN days <= 30 THEN '15-30' WHEN days <= 60 THEN '31-60'
                  WHEN days <= 90 THEN '61-90' ELSE '91+' END AS bucket,
             count(*)::int AS tickets, COALESCE(sum(days), 0)::bigint AS total_days
      FROM lt GROUP BY 1`,
  );
  const by = new Map(rows.map((r) => [String(r.bucket), num(r.tickets)]));
  const tickets = rows.reduce((s, r) => s + num(r.tickets), 0);
  const days = rows.reduce((s, r) => s + num(r.total_days), 0);
  return {
    leadTime: LEAD_TIME_BUCKETS.map((bucket) => ({ bucket, tickets: by.get(bucket) ?? 0 })),
    averageLeadDays: tickets > 0 ? Math.round((days / tickets) * 10) / 10 : 0,
  };
}

async function loadCustomers(db: Database, scope: Scope, w: Window) {
  const rows = await run<Record<string, unknown>>(
    db,
    sql`WITH ${ordCte(scope, w)}, cust AS (SELECT DISTINCT customer_id FROM ord WHERE customer_id IS NOT NULL)
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM orders x WHERE x.customer_id = cust.customer_id AND x.paid_at < ${ts(w.start)}
        ))::int AS returning,
        count(*) FILTER (WHERE (
          SELECT count(DISTINCT oi.event_id) FROM orders x JOIN order_items oi ON oi.order_id = x.id
          WHERE x.customer_id = cust.customer_id AND x.paid_at IS NOT NULL AND oi.status IN ${SOLD}
        ) >= 2)::int AS multi_event
      FROM cust`,
  );
  const r = rows[0] ?? {};
  return { total: num(r.total), returning: num(r.returning), multiEvent: num(r.multi_event) };
}

/** Cumulative-ready sales per event by days before the event (all-time sales of the event). */
async function loadSalesCurve(db: Database, scope: Scope, w: Window): Promise<SalesCurveEvent[]> {
  const f = scope.filter;
  let eventIds: string[];
  if (f.eventIds.length > 0) {
    const rows = await run<{ id: string }>(
      db,
      sql`SELECT id FROM events WHERE id IN (${list(f.eventIds)}) ORDER BY starts_at DESC LIMIT ${MAX_CURVE_EVENTS}`,
    );
    eventIds = rows.map((r) => r.id);
  } else {
    const rows = await run<{ event_id: string }>(
      db,
      sql`WITH ${ordCte(scope, w)}
        SELECT oi.event_id FROM order_items oi JOIN ord ON ord.id = oi.order_id
        WHERE oi.status IN ${SOLD}
        GROUP BY oi.event_id ORDER BY count(*) DESC LIMIT ${DEFAULT_CURVE_EVENTS}`,
    );
    eventIds = rows.map((r) => r.event_id);
  }
  if (eventIds.length === 0) return [];
  const rows = await run<Record<string, unknown>>(
    db,
    sql`SELECT oi.event_id, e.title, e.starts_at,
             LEAST(GREATEST((e.starts_at AT TIME ZONE e.time_zone)::date
                            - (o.paid_at AT TIME ZONE e.time_zone)::date, 0), 365) AS days_before,
             count(*)::int AS tickets, sum(oi.price_gross)::bigint AS revenue
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        JOIN events e ON e.id = oi.event_id
        WHERE oi.event_id IN (${list(eventIds)}) AND oi.status IN ${SOLD}
          AND o.paid_at IS NOT NULL AND o.currency = ${scope.currency} ${orderFilter(f, 'o')}
        GROUP BY 1, 2, 3, 4 ORDER BY e.starts_at, days_before DESC`,
  );
  const byEvent = new Map<string, SalesCurveEvent>();
  for (const r of rows) {
    const id = String(r.event_id);
    let entry = byEvent.get(id);
    if (!entry) {
      entry = {
        eventId: id,
        title: String(r.title),
        startsAt: new Date(r.starts_at as string | Date).toISOString(),
        points: [],
        total: 0,
      };
      byEvent.set(id, entry);
    }
    entry.points.push({
      daysBefore: num(r.days_before),
      tickets: num(r.tickets),
      revenue: num(r.revenue),
    });
    entry.total += num(r.tickets);
  }
  return [...byEvent.values()];
}

async function compute(db: Database, scope: Scope, now: Date): Promise<SalesStatistics> {
  const range = resolveRange(scope.filter, now, scope.timeZone);
  const prevRange = previousPeriod(range);
  const days = rangeDays(range);
  const interval = chooseInterval(days);
  const cur = windowInstants(range, scope.timeZone);
  const prev = windowInstants(prevRange, scope.timeZone);

  const [kpis, otherCurrencyOrders, series, byCategory, byTariff, bySection, byMethod, byChannel] =
    await Promise.all([
      loadKpis(db, scope, cur, prev),
      loadOtherCurrency(db, scope, cur),
      loadSeries(db, scope, cur, interval),
      loadItemBreakdown(db, scope, cur, 'category_name', 12),
      loadItemBreakdown(db, scope, cur, 'ticket_type_name', 12),
      loadItemBreakdown(db, scope, cur, 'section_label', 10),
      loadKeyed(db, scope, cur, 'method'),
      loadKeyed(db, scope, cur, 'channel'),
    ]);
  const [heatmap, lead, customers, salesCurve] = await Promise.all([
    loadHeatmap(db, scope, cur),
    loadLeadTime(db, scope, cur),
    loadCustomers(db, scope, cur),
    loadSalesCurve(db, scope, cur),
  ]);

  return {
    generatedAt: now.toISOString(),
    timeZone: scope.timeZone,
    currency: scope.currency,
    range: { from: range.from, to: range.to, days },
    previous: prevRange,
    interval,
    kpis,
    otherCurrencyOrders,
    series,
    salesCurve,
    byCategory,
    byTariff,
    bySection,
    byMethod,
    byChannel,
    heatmap,
    leadTime: lead.leadTime,
    averageLeadDays: lead.averageLeadDays,
    customers,
  };
}

// ─── Short cache (one DB round per filter and 45 s, single flight) ──────────────

const CACHE_TTL_MS = 45_000;
const CACHE_MAX = 64;
const cache = new Map<string, { at: number; value: SalesStatistics }>();
const inflight = new Map<string, Promise<SalesStatistics>>();

export function clearSalesStatisticsCache(): void {
  cache.clear();
  inflight.clear();
}

export async function getSalesStatistics(
  ctx: Pick<CoreContext, 'db'>,
  query: StatisticsQuery,
): Promise<SalesStatistics> {
  const general = await getSetting(ctx, 'general');
  const now = query.now ?? new Date();
  const scope: Scope = {
    currency: general.defaultCurrency,
    timeZone: general.defaultTimeZone,
    filter: query,
  };
  const range = resolveRange(query, now, scope.timeZone);
  const key = JSON.stringify([
    scope.currency,
    scope.timeZone,
    range.from,
    range.to,
    [...query.eventIds].sort(),
    [...query.channels].sort(),
    [...query.methods].sort(),
  ]);
  const cacheable = !query.now;
  const hit = cache.get(key);
  if (cacheable && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const pending = inflight.get(key);
  if (pending) return pending;
  const load = compute(ctx.db, scope, now)
    .then((value) => {
      if (cacheable) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
        cache.set(key, { at: Date.now(), value });
      }
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, load);
  return load;
}
