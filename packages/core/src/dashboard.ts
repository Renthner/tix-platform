import { adminUsers } from '@tix/db';
import {
  DEFAULT_DASHBOARD_STATUSES,
  EVENT_STATUSES,
  MAX_DASHBOARD_CARDS,
  dashboardPreferencesInputSchema,
  parseDashboardPreferences,
  sortByEventOrder,
  type DashboardPreferences,
  type DashboardPreferencesInput,
  type EventStatus,
} from '@tix/shared';
import { eq, sql } from 'drizzle-orm';
import type { CoreContext } from './context';
import { shopPresenceCounts } from './presence';
import { getSetting } from './settings';

/**
 * Live telemetry of the admin dashboard: cheap aggregated SQL (index-backed: order_items by
 * event/status, tickets by event, orders by status/created) plus Redis counters for live cart
 * locks and the waiting room. Each block is optional so the caller can restrict it per admin role.
 *
 * Money conventions: amounts are gross cents; KPIs in the shop's default currency, per-event figures in the event's currency; "revenue" is
 * `amount_paid − amount_refunded` of orders that were paid in the period (a refund reduces the
 * period in which the order was paid, not the day of the refund).
 *
 * Scope: events whose status is in the (per-admin) status filter; running / upcoming ones
 * (PUBLISHED, POSTPONED) only until one day after their start. The overview aggregates every
 * matching event, the cards are capped (`maxEvents`, ordered by the admin's saved card order).
 */

export interface DashboardKpis {
  revenueTodayCents: number;
  revenue7dCents: number;
  ordersToday: number;
  ticketsSoldToday: number;
  openVorkasseCents: number;
  openVorkasseCount: number;
}

export interface DashboardInventory {
  sold: number;
  reserved: number;
  locked: number;
  available: number;
  blocked: number;
  capacity: number;
}

export interface DashboardPaymentRow {
  method: string;
  tickets: number;
  amountCents: number;
}

/** The blocks shared by an event card and the overview. */
export interface DashboardStats {
  /** Gross revenue of confirmed tickets (refunded tickets are not included). */
  revenueCents?: number;
  payments?: DashboardPaymentRow[];
  inventory?: DashboardInventory;
  /**
   * Waiting-room figures. `active` = pass holders (what AUTO_THRESHOLD compares) – NOT the
   * dashboard's "in the shop" number, see `presence`.
   */
  queue?: { active: number; waiting: number; lobby: number };
  /**
   * Shoppers on the shop right now (heartbeat in the last 45 s; closing a tab removes them at
   * once). Per event on a card, shop-wide (each shopper once) in the overview.
   */
  presence?: number;
  checkIn?: { checkedIn: number; valid: number };
}

export interface DashboardEvent extends DashboardStats {
  id: string;
  title: string;
  status: EventStatus;
  startsAt: string;
  timeZone: string;
  /** Currency of the event (amounts below are in this currency). */
  currency: string;
}

/** Sum over every event matching the status filter (same blocks as an event card). */
export interface DashboardOverview extends DashboardStats {
  /** Events matching the filter (the cards show at most `maxEvents` of them). */
  eventCount: number;
  /** Events in another currency than the shop default: left out of revenue and payments. */
  otherCurrencyEvents?: number;
}

export interface DashboardData {
  generatedAt: string;
  currency: string;
  kpis?: DashboardKpis;
  overview: DashboardOverview;
  events: DashboardEvent[];
}

export interface DashboardOptions {
  /** Revenue, orders, Vorkasse and payment-method figures. */
  money: boolean;
  /** Seat inventory and waiting room. */
  inventory: boolean;
  checkIn: boolean;
  /** Event cards returned (default MAX_DASHBOARD_CARDS); the overview is not limited. */
  maxEvents?: number;
  /** Status filter (default: published + postponed). */
  statuses?: readonly EventStatus[];
  /** Saved card order: listed events first, then the rest by start date. */
  eventOrder?: readonly string[];
}

const num = (v: unknown) => Number(v ?? 0) || 0;

const zeroInventory = (): DashboardInventory => ({
  sold: 0,
  reserved: 0,
  locked: 0,
  available: 0,
  blocked: 0,
  capacity: 0,
});

export async function getDashboardData(
  ctx: CoreContext,
  options: DashboardOptions,
): Promise<DashboardData> {
  const maxEvents = options.maxEvents ?? MAX_DASHBOARD_CARDS;
  const general = await getSetting(ctx, 'general');
  const { defaultCurrency: currency, defaultTimeZone: zone } = general;

  const statuses = (options.statuses ?? DEFAULT_DASHBOARD_STATUSES).filter((s) =>
    (EVENT_STATUSES as readonly string[]).includes(s),
  );
  const statusList =
    statuses.length > 0
      ? sql.join(
          statuses.map((s) => sql`${s}::event_status`),
          sql`, `,
        )
      : sql`NULL`;
  /** Events of the dashboard scope; used as a sub-select so no id list travels to Postgres. */
  const scope = sql`SELECT e.id FROM events e
    WHERE e.status IN (${statusList})
      AND (e.status NOT IN ('PUBLISHED', 'POSTPONED') OR e.starts_at >= now() - interval '1 day')`;

  const eventRows = (
    await ctx.db.execute<{
      id: string;
      title: string;
      status: EventStatus;
      starts_at: Date;
      time_zone: string;
      currency: string;
    }>(sql`
      SELECT id, title, status, starts_at, time_zone, currency FROM events
      WHERE id IN (${scope})
      ORDER BY starts_at ASC, id ASC
    `)
  ).rows;
  const ids = eventRows.map((e) => e.id);
  const stats = new Map<string, DashboardStats>(ids.map((id) => [id, {}]));
  const eventCurrency = new Map(eventRows.map((e) => [e.id, e.currency]));
  const tasks: Promise<void>[] = [];
  let kpis: DashboardKpis | undefined;
  let shopWidePresence = 0;

  if (options.money) {
    tasks.push(
      (async () => {
        const [k] = (
          await ctx.db.execute<Record<string, unknown>>(sql`
            WITH bounds AS (
              SELECT (date_trunc('day', now() AT TIME ZONE ${zone}) AT TIME ZONE ${zone}) AS day_start
            )
            SELECT
              COALESCE(SUM(o.amount_paid - o.amount_refunded) FILTER (
                WHERE o.status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED')
                  AND o.paid_at >= (SELECT day_start FROM bounds)), 0) AS revenue_today,
              COALESCE(SUM(o.amount_paid - o.amount_refunded) FILTER (
                WHERE o.status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED')
                  AND o.paid_at >= now() - interval '7 days'), 0) AS revenue_7d,
              COUNT(*) FILTER (
                WHERE o.status IN ('AWAITING_PAYMENT','PAID','PARTIALLY_REFUNDED','REFUNDED')
                  AND o.created_at >= (SELECT day_start FROM bounds)) AS orders_today,
              COALESCE(SUM(o.total_gross - o.amount_paid) FILTER (
                WHERE o.status = 'AWAITING_PAYMENT' AND o.payment_method = 'BANK_TRANSFER'), 0) AS open_cents,
              COUNT(*) FILTER (
                WHERE o.status = 'AWAITING_PAYMENT' AND o.payment_method = 'BANK_TRANSFER') AS open_count
            FROM orders o
            WHERE o.currency = ${currency}
              AND (o.status = 'AWAITING_PAYMENT'
                OR o.created_at >= now() - interval '8 days'
                OR o.paid_at >= now() - interval '8 days')
          `)
        ).rows;
        const [sold] = (
          await ctx.db.execute<{ n: number }>(sql`
            SELECT COUNT(*)::int AS n
            FROM order_items i JOIN orders o ON o.id = i.order_id
            WHERE i.status = 'CONFIRMED' AND o.currency = ${currency}
              AND o.paid_at >= (date_trunc('day', now() AT TIME ZONE ${zone}) AT TIME ZONE ${zone})
          `)
        ).rows;
        kpis = {
          revenueTodayCents: num(k?.revenue_today),
          revenue7dCents: num(k?.revenue_7d),
          ordersToday: num(k?.orders_today),
          ticketsSoldToday: num(sold?.n),
          openVorkasseCents: num(k?.open_cents),
          openVorkasseCount: num(k?.open_count),
        };
      })(),
      (async () => {
        if (ids.length === 0) return;
        const rows = (
          await ctx.db.execute<{
            event_id: string;
            method: string;
            tickets: number;
            amount: string;
          }>(sql`
            SELECT i.event_id, o.payment_method AS method, COUNT(*)::int AS tickets,
              COALESCE(SUM(i.price_gross), 0) AS amount
            FROM order_items i JOIN orders o ON o.id = i.order_id
            WHERE i.status = 'CONFIRMED' AND i.event_id IN (${scope})
            GROUP BY i.event_id, o.payment_method
            ORDER BY amount DESC
          `)
        ).rows;
        for (const s of stats.values()) {
          s.payments = [];
          s.revenueCents = 0;
        }
        for (const r of rows) {
          const s = stats.get(r.event_id);
          if (!s) continue;
          s.payments!.push({ method: r.method, tickets: r.tickets, amountCents: num(r.amount) });
          s.revenueCents = (s.revenueCents ?? 0) + num(r.amount);
        }
      })(),
    );
  }

  if (options.inventory && ids.length > 0) {
    tasks.push(
      (async () => {
        const counts = (
          await ctx.db.execute<{ event_id: string; status: string; n: number }>(sql`
            SELECT event_id, status, COUNT(*)::int AS n FROM order_items
            WHERE status IN ('PENDING','CONFIRMED') AND event_id IN (${scope})
            GROUP BY event_id, status
          `)
        ).rows;
        const capacity = (
          await ctx.db.execute<{
            event_id: string;
            seats: number;
            blocked: number;
            standing: number;
          }>(sql`
            SELECT e.id AS event_id,
              (SELECT COUNT(*)::int FROM seats s
                WHERE s.seat_map_id = e.seat_map_id AND s.removed_at IS NULL) AS seats,
              (SELECT COUNT(*)::int FROM seats s
                WHERE s.seat_map_id = e.seat_map_id AND s.removed_at IS NULL
                  AND s.block_reason IS NOT NULL) AS blocked,
              (SELECT COALESCE(SUM(m.capacity), 0)::int FROM seat_map_sections m
                WHERE m.seat_map_id = e.seat_map_id AND m.type = 'STANDING'
                  AND m.is_active AND m.removed_at IS NULL) AS standing
            FROM events e WHERE e.id IN (${scope})
          `)
        ).rows;
        const live = await ctx.seats.liveHoldCountsMany(ids);
        const soldBy = new Map<string, number>();
        const reservedBy = new Map<string, number>();
        for (const c of counts) {
          (c.status === 'CONFIRMED' ? soldBy : reservedBy).set(c.event_id, num(c.n));
        }
        const capBy = new Map(capacity.map((c) => [c.event_id, c]));
        for (const [id, s] of stats) {
          const sold = soldBy.get(id) ?? 0;
          const reserved = reservedBy.get(id) ?? 0;
          const cap = capBy.get(id);
          const total = num(cap?.seats) + num(cap?.standing);
          const blocked = num(cap?.blocked);
          const hold = live.get(id);
          const locked = (hold?.seats ?? 0) + (hold?.gaSpots ?? 0);
          s.inventory = {
            sold,
            reserved,
            locked,
            blocked,
            capacity: total,
            available: Math.max(0, total - blocked - sold - reserved - locked),
          };
        }
      })(),
      (async () => {
        const [counts, presence] = await Promise.all([
          ctx.queue.countsMany(ids),
          shopPresenceCounts(ctx, ids),
        ]);
        for (const [id, s] of stats) {
          s.queue = counts.get(id) ?? { active: 0, waiting: 0, lobby: 0 };
          s.presence = presence.byEvent.get(id) ?? 0;
        }
        shopWidePresence = presence.shop;
      })(),
    );
  }

  if (options.checkIn && ids.length > 0) {
    tasks.push(
      (async () => {
        const rows = (
          await ctx.db.execute<{ event_id: string; valid: number; checked_in: number }>(sql`
            SELECT event_id, COUNT(*)::int AS valid,
              COUNT(*) FILTER (WHERE check_in_state = 'CHECKED_IN')::int AS checked_in
            FROM tickets WHERE status = 'VALID' AND event_id IN (${scope})
            GROUP BY event_id
          `)
        ).rows;
        const byEvent = new Map(rows.map((r) => [r.event_id, r]));
        for (const [id, s] of stats) {
          const r = byEvent.get(id);
          s.checkIn = { valid: num(r?.valid), checkedIn: num(r?.checked_in) };
        }
      })(),
    );
  }

  await Promise.all(tasks);

  // Overview = sum of the per-event figures, so it always equals the sum over all matching cards.
  const overview: DashboardOverview = { eventCount: ids.length };
  if (options.money) {
    const methods = new Map<string, DashboardPaymentRow>();
    let revenue = 0;
    let other = 0;
    for (const [id, s] of stats) {
      if (eventCurrency.get(id) !== currency) {
        other += 1;
        continue;
      }
      revenue += s.revenueCents ?? 0;
      for (const p of s.payments ?? []) {
        const row = methods.get(p.method) ?? { method: p.method, tickets: 0, amountCents: 0 };
        row.tickets += p.tickets;
        row.amountCents += p.amountCents;
        methods.set(p.method, row);
      }
    }
    overview.revenueCents = revenue;
    overview.payments = [...methods.values()].sort((a, b) => b.amountCents - a.amountCents);
    if (other > 0) overview.otherCurrencyEvents = other;
  }
  if (options.inventory) {
    const inv = zeroInventory();
    const queue = { active: 0, waiting: 0, lobby: 0 };
    for (const s of stats.values()) {
      for (const key of Object.keys(inv) as (keyof DashboardInventory)[])
        inv[key] += s.inventory?.[key] ?? 0;
      queue.active += s.queue?.active ?? 0;
      queue.waiting += s.queue?.waiting ?? 0;
      queue.lobby += s.queue?.lobby ?? 0;
    }
    overview.inventory = inv;
    overview.queue = queue;
    overview.presence = shopWidePresence;
  }
  if (options.checkIn) {
    const checkIn = { checkedIn: 0, valid: 0 };
    for (const s of stats.values()) {
      checkIn.checkedIn += s.checkIn?.checkedIn ?? 0;
      checkIn.valid += s.checkIn?.valid ?? 0;
    }
    overview.checkIn = checkIn;
  }

  const cards: DashboardEvent[] = sortByEventOrder(eventRows, options.eventOrder ?? [])
    .slice(0, maxEvents)
    .map((e) => ({
      id: e.id,
      title: e.title,
      status: e.status,
      startsAt: new Date(e.starts_at).toISOString(),
      timeZone: e.time_zone,
      currency: e.currency,
      ...stats.get(e.id),
    }));

  return {
    generatedAt: new Date().toISOString(),
    currency,
    ...(kpis ? { kpis } : {}),
    overview,
    events: cards,
  };
}

/** Personal dashboard settings of an admin (defaults for anything missing or invalid). */
export async function getDashboardPreferences(
  ctx: CoreContext,
  userId: string,
): Promise<DashboardPreferences> {
  const [row] = await ctx.db
    .select({ prefs: adminUsers.dashboardPreferences })
    .from(adminUsers)
    .where(eq(adminUsers.id, userId))
    .limit(1);
  return parseDashboardPreferences(row?.prefs);
}

/**
 * Saves the given keys of the admin's own dashboard settings (other keys are kept; merged in one
 * statement, so concurrent saves of different keys do not overwrite each other).
 * Throws on invalid input.
 */
export async function saveDashboardPreferences(
  ctx: CoreContext,
  userId: string,
  input: unknown,
): Promise<DashboardPreferences> {
  const parsed: DashboardPreferencesInput = dashboardPreferencesInputSchema.parse(input);
  const patch = JSON.stringify(parsed);
  const { rows } = await ctx.db.execute<{ prefs: unknown }>(sql`
    UPDATE admin_users
    SET dashboard_preferences = COALESCE(dashboard_preferences, '{}'::jsonb) || ${patch}::jsonb
    WHERE id = ${userId}::uuid
    RETURNING dashboard_preferences AS prefs
  `);
  return parseDashboardPreferences(rows[0]?.prefs);
}
