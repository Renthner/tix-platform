import { randomUUID } from 'node:crypto';
import {
  isUniqueViolation,
  orderFees,
  orderHistory,
  orderItems,
  orders,
  payments,
  withTransaction,
  type Transaction,
} from '@tix/db';
import {
  SEAT_FLAG,
  normalizeLocale,
  postalAddressSchema,
  type PublicSeatMap,
  type SalesChannel,
} from '@tix/shared';
import { z } from 'zod';
import { allowedTypesFor, clearCartAfterOrder, seatIndex, type CartView } from '../cart';
import type { CartEventView, CartItemView } from '../cart';
import { DomainError, type CoreContext } from '../context';
import { effectiveCheckoutConfig, getEventCached, type EventRow } from '../events';
import { ensureInventory, rebuildInventory } from '../inventory';
import { issueInvoice } from '../invoices';
import { QUEUE_NAMES } from '../job-queues';
import { nextNumber } from '../numbering';
import { publishSeatDelta } from '../realtime';
import { getPublicSeatMap, getSeatMapForChannel } from '../seatmaps/public';
import { getSetting } from '../settings';
import { ensureOrderTickets } from '../tickets/issue';
import { claimStandingCapacity, upsertCustomer } from './checkout';
import { withMutex } from '../banking/runs';
import { mirrorSeats } from './fulfillment';
import { quoteChannelCart, type CheckoutQuote } from './pricing';

/**
 * Box office (Abendkasse) and complimentary tickets (Freikarten).
 *
 * An admin sells seats / standing spots over the counter: the order is created in ONE
 * transaction directly as PAID (payment CASH / CARD, or COMPLIMENTARY = free of charge),
 * tickets are issued synchronously so the PDF can be printed right away.
 *
 * Inventory safety is the same as online:
 *  - seats are locked atomically in Redis (Lua) under a one-off box-office session, so a seat
 *    held in an online buyer's cart (or sold / reserved) is rejected;
 *  - the partial unique index on `order_items.seat_id` is the final guard;
 *  - seats BLOCKED for press / VIPs are rejected unless `allowBlocked` is set. They can never be
 *    locked by online buyers, so only the unique index guards them.
 *
 * Rules: no order limits and no sale-window restrictions (selling after the online sale ended
 * and during the event is the point of a box office); only CANCELLED / ARCHIVED events are
 * refused. Prices come from the pricing matrix of the BOX_OFFICE channel (tariffs can be
 * restricted to channels), fees from the fees whose channels include the sales channel.
 * COMPLIMENTARY orders cost 0, carry no fees and get NO invoice (nothing was sold).
 * Buyer data is optional: without an e-mail address the order has no customer record.
 */

/** Locks only need to outlive the order transaction. */
const HOLD_MS = 2 * 60 * 1000;
const MAX_LINES = 500;
const MAX_GA_PER_LINE = 200;

export const BOX_OFFICE_PAYMENT_METHODS = ['CASH', 'CARD', 'COMPLIMENTARY'] as const;
export type BoxOfficePaymentMethod = (typeof BOX_OFFICE_PAYMENT_METHODS)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const boxOfficeBuyerSchema = z.object({
  firstName: optionalText(100),
  lastName: optionalText(100),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(z.email().optional()),
  phone: optionalText(50),
  company: optionalText(200),
  address: postalAddressSchema.optional(),
});
export type BoxOfficeBuyer = z.output<typeof boxOfficeBuyerSchema>;

const lineBase = {
  eventId: z.uuid(),
  /** Tariff (ticket type) of the line. */
  ticketTypeId: z.uuid(),
  /** Gross price per ticket replacing the matrix price (needs a reason, see params). */
  priceOverrideCents: z.number().int().min(0).max(10_000_000).optional(),
};
export const boxOfficeLineSchema = z.union([
  z.object({ ...lineBase, seatId: z.uuid() }).strict(),
  z
    .object({
      ...lineBase,
      sectionId: z.uuid(),
      quantity: z.number().int().min(1).max(MAX_GA_PER_LINE),
    })
    .strict(),
]);
export type BoxOfficeLine = z.input<typeof boxOfficeLineSchema>;

/**
 * Locale tag of the buyer's mails. The shop default may be a regional tag ("de-DE"); anything
 * unsupported falls back to the base language, then to English.
 */
export function normalizeBuyerLocale(tag: string | undefined | null): 'en' | 'de' | undefined {
  if (!tag) return undefined;
  const base = tag.toLowerCase().split(/[-_]/)[0];
  return base === 'de' ? 'de' : 'en';
}

/** Request body of the box-office sale API (shared by the route and the tests). */
export const boxOfficeSellSchema = z.object({
  lines: z.array(boxOfficeLineSchema).min(1).max(MAX_LINES),
  payment: z.enum(BOX_OFFICE_PAYMENT_METHODS),
  buyer: boxOfficeBuyerSchema.optional(),
  sendEmail: z.boolean().default(false),
  note: z.string().trim().max(1000).optional(),
  allowBlocked: z.boolean().default(false),
  priceOverrideReason: z.string().trim().max(500).optional(),
  locale: z
    .string()
    .regex(/^[A-Za-z]{2,3}(?:[-_][A-Za-z]{2})?$/)
    .transform((v) => normalizeBuyerLocale(v))
    .optional(),
  /** Admin tab whose held seat locks are converted into the sale. */
  tabId: z.uuid().optional(),
});

export interface CreateBoxOfficeOrderParams {
  userId: string;
  channel: Exclude<SalesChannel, 'ONLINE'>;
  lines: BoxOfficeLine[];
  payment: BoxOfficePaymentMethod;
  buyer?: z.input<typeof boxOfficeBuyerSchema>;
  /** Send the tickets by e-mail (needs a buyer e-mail address). */
  sendEmail: boolean;
  note?: string | null;
  /** Sell seats that are blocked (press, VIP, technical). The caller checks the role. */
  allowBlocked?: boolean;
  /** Required when a line carries a price override. */
  priceOverrideReason?: string | null;
  locale?: string;
  ipAddress?: string | null;
  /**
   * Admin tab whose held locks (see `holdBoxOfficeSeats`) are converted into the sale. Without
   * it the seats are locked just for the duration of the sale.
   */
  holdTabId?: string;
}

export interface BoxOfficeOrderResult {
  orderId: string;
  orderNumber: string;
  status: 'PAID';
  payment: BoxOfficePaymentMethod;
  totalGross: number;
  feeTotal: number;
  currency: string;
  ticketCount: number;
  /** False when ticket issuance failed after the sale (the background job retries). */
  ticketsReady: boolean;
}

interface ResolvedLine {
  eventId: string;
  seatId: string | null;
  sectionId: string;
  /** One entry per ticket (GA quantity expanded). */
  tickets: number;
  ticketTypeId: string;
  categoryId: string;
  blocked: boolean;
  overrideCents: number | null;
}

function lockError(reason: string, seatId?: string): DomainError {
  if (reason === 'LOCKED') {
    return new DomainError('SEAT_LOCKED', 'This seat is currently in an online cart', 409, {
      seatId,
    });
  }
  return new DomainError('SEAT_UNAVAILABLE', 'This seat is no longer available', 409, { seatId });
}

/** Box-office sales need a published (or postponed) event; drafts, cancelled and archived ones are refused. */
export function assertSellable(event: EventRow): void {
  if (event.status !== 'PUBLISHED' && event.status !== 'POSTPONED') {
    throw new DomainError('EVENT_NOT_SELLABLE', 'This event is not on the box-office list', 409, {
      event: event.title,
    });
  }
}

interface Prepared {
  buyerDataRequired: boolean;
  smallAmountInvoiceLimit: number;
  buyer: BoxOfficeBuyer;
  overrideReason: string | null;
  eventIds: string[];
  eventRows: Map<string, EventRow>;
  resolved: ResolvedLine[];
  quote: CheckoutQuote;
}

/** Validates the request, resolves the lines against the seating plans and prices them. */
async function prepare(
  ctx: CoreContext,
  params: Pick<
    CreateBoxOfficeOrderParams,
    | 'lines'
    | 'payment'
    | 'buyer'
    | 'sendEmail'
    | 'channel'
    | 'allowBlocked'
    | 'priceOverrideReason'
    | 'locale'
  >,
  strict: boolean,
): Promise<Prepared> {
  const lines = z.array(boxOfficeLineSchema).min(1).max(MAX_LINES).parse(params.lines);
  const buyer = boxOfficeBuyerSchema.parse(params.buyer ?? {});
  if (strict && params.sendEmail && !buyer.email) {
    throw new DomainError('EMAIL_REQUIRED', 'An e-mail address is needed to send the tickets', 422);
  }
  const hasOverride = lines.some((l) => l.priceOverrideCents !== undefined);
  const overrideReason = params.priceOverrideReason?.trim() || null;
  if (hasOverride && params.payment === 'COMPLIMENTARY') {
    throw new DomainError('OVERRIDE_NOT_ALLOWED', 'Complimentary tickets are free already', 422);
  }
  if (strict && hasOverride && !overrideReason) {
    throw new DomainError(
      'OVERRIDE_REASON_REQUIRED',
      'A reason is required for a price change',
      422,
    );
  }

  // ── Resolve lines against the seating plans of the events ──────────────────
  const eventIds = [...new Set(lines.map((l) => l.eventId))].sort();
  const eventRows = new Map<string, EventRow>();
  const maps = new Map<string, PublicSeatMap>();
  for (const eventId of eventIds) {
    const event = await getEventCached(ctx, eventId);
    assertSellable(event);
    eventRows.set(eventId, event);
    maps.set(eventId, await getSeatMapForChannel(ctx, event, params.channel));
  }
  const resolved = resolveLines(lines, maps, Boolean(params.allowBlocked));

  // ── Quote (tariff prices, channel fees, VAT) ───────────────────────────────
  const free = params.payment === 'COMPLIMENTARY';
  const cart = buildCart(eventRows, maps, resolved, free);
  const buyerLocale = normalizeLocale(
    params.locale ?? (await getSetting(ctx, 'general')).defaultLocale,
  );
  const { quote } = await quoteChannelCart(ctx, cart, params.payment, params.channel, buyerLocale);

  // Kleinbetragsrechnung: above the limit an invoice needs the buyer's name and full address.
  const invoicing = await getSetting(ctx, 'invoicing');
  const buyerDataRequired =
    invoicing.issueInvoices && !free && quote.totalGross > invoicing.smallAmountInvoiceLimit;
  if (strict && buyerDataRequired && !(buyer.firstName && buyer.lastName && buyer.address)) {
    throw new DomainError(
      'BUYER_DATA_REQUIRED',
      'The invoice needs the name and address of the buyer',
      422,
      { limit: invoicing.smallAmountInvoiceLimit },
    );
  }
  return {
    buyerDataRequired,
    smallAmountInvoiceLimit: invoicing.smallAmountInvoiceLimit,
    buyer,
    overrideReason,
    eventIds,
    eventRows,
    resolved,
    quote,
  };
}

export interface BoxOfficeQuote {
  currency: string;
  subtotalGross: number;
  discountTotal: number;
  feeTotal: number;
  totalGross: number;
  ticketCount: number;
  fees: { name: string; totalGross: number }[];
  /** Name and full address of the buyer are mandatory for this sale (invoice above the limit). */
  buyerDataRequired: boolean;
  smallAmountInvoiceLimit: number;
}

/** Price preview for the box-office screen (same code as the sale, nothing is reserved). */
export async function quoteBoxOfficeOrder(
  ctx: CoreContext,
  params: Pick<
    CreateBoxOfficeOrderParams,
    'lines' | 'payment' | 'buyer' | 'channel' | 'allowBlocked'
  >,
): Promise<BoxOfficeQuote> {
  const { quote, buyerDataRequired, smallAmountInvoiceLimit } = await prepare(
    ctx,
    { ...params, sendEmail: false },
    false,
  );
  const fees = [...quote.events.flatMap((e) => e.fees), ...quote.orderFees];
  return {
    currency: quote.currency,
    subtotalGross: quote.subtotalGross,
    discountTotal: quote.discountTotal,
    feeTotal: quote.feeTotal,
    totalGross: quote.totalGross,
    ticketCount: quote.ticketCount,
    fees: fees.map((f) => ({ name: f.name, totalGross: f.totalGross })),
    buyerDataRequired,
    smallAmountInvoiceLimit,
  };
}

export async function createBoxOfficeOrder(
  ctx: CoreContext,
  params: CreateBoxOfficeOrderParams,
): Promise<BoxOfficeOrderResult> {
  if (!params.holdTabId) return createBoxOfficeOrderLocked(ctx, params);
  // Double submit of the same hold (two clicks, two tabs of one session) must not create two orders.
  const locked = await withMutex(
    ctx,
    `boxoffice-sale:${boxOfficeSessionId(params.userId, params.holdTabId)}`,
    30_000,
    () => createBoxOfficeOrderLocked(ctx, params),
  );
  if (!locked) {
    throw new DomainError('SALE_IN_PROGRESS', 'This sale is already being processed', 409);
  }
  return locked.value;
}

async function createBoxOfficeOrderLocked(
  ctx: CoreContext,
  params: CreateBoxOfficeOrderParams,
): Promise<BoxOfficeOrderResult> {
  const { buyer, overrideReason, eventIds, eventRows, resolved, quote } = await prepare(
    ctx,
    params,
    true,
  );

  // ── Inventory: Redis locks (online carts are respected) ────────────────────
  const held = Boolean(params.holdTabId);
  const sessionId = held
    ? boxOfficeSessionId(params.userId, params.holdTabId!)
    : `boxoffice:${params.userId}:${randomUUID()}`;
  const expiresAt = Date.now() + HOLD_MS;
  const lockedSeats = new Map<string, string[]>();
  const heldGa = new Map<string, Record<string, number>>();
  const releaseHolds = async () => {
    // Held picks stay in place so the seller can correct the form and try again.
    if (held) return;
    for (const [eventId, seatIds] of lockedSeats) {
      await ctx.seats.releaseSeats(eventId, sessionId, seatIds).catch(() => undefined);
    }
    for (const [eventId, sections] of heldGa) {
      for (const [sectionId, n] of Object.entries(sections)) {
        await ctx.seats
          .holdGeneralAdmission({
            eventId,
            sessionId,
            sectionId,
            delta: -n,
            expiresAt: Date.now() + 1000,
            maxPerSession: 0,
          })
          .catch(() => undefined);
      }
    }
    await clearCartAfterOrder(ctx, sessionId, eventIds).catch(() => undefined);
  };

  let created: Awaited<ReturnType<typeof createRows>>;
  try {
    for (const eventId of eventIds) {
      const event = eventRows.get(eventId)!;
      await ensureInventory(ctx, event);
      const mine = resolved.filter((l) => l.eventId === eventId);
      const taken = await ctx.seats.takenSeats(eventId);
      const lockable: string[] = [];
      for (const line of mine) {
        if (!line.seatId) continue;
        if (line.blocked) {
          // Blocked seats are never locked by online buyers; only sold / reserved ones count.
          if (taken[line.seatId] === 'S' || taken[line.seatId] === 'R') {
            throw lockError('UNAVAILABLE', line.seatId);
          }
        } else {
          lockable.push(line.seatId);
        }
      }
      if (held) {
        // Converting the held locks: every seat / spot must still belong to this tab.
        const mineSeats = new Set(await ctx.seats.sessionSeatIds(eventId, sessionId));
        const holdGa = await ctx.seats.sessionGeneralAdmission(eventId, sessionId);
        const needGa: Record<string, number> = {};
        for (const line of mine) {
          if (!line.seatId) needGa[line.sectionId] = (needGa[line.sectionId] ?? 0) + line.tickets;
        }
        if (
          lockable.some((id) => !mineSeats.has(id)) ||
          Object.entries(needGa).some(([sectionId, n]) => (holdGa[sectionId] ?? 0) < n)
        ) {
          throw new DomainError('HOLD_EXPIRED', 'The reservation of your selection expired', 409);
        }
        // Extend, never shorten: the hold may have more time left than the sale needs.
        await ctx.seats.extendCart(
          eventId,
          sessionId,
          Math.max(await holdExpiry(ctx, sessionId), expiresAt),
        );
        lockedSeats.set(eventId, lockable);
        continue;
      }
      if (lockable.length > 0) {
        const result = await ctx.seats.lockSeats({
          eventId,
          sessionId,
          seatIds: lockable,
          expiresAt,
          maxPerSession: 0,
        });
        if (!result.ok) throw lockError(result.reason, result.seatId);
        lockedSeats.set(eventId, lockable);
      }
      const ga: Record<string, number> = {};
      for (const line of mine) {
        if (!line.seatId) ga[line.sectionId] = (ga[line.sectionId] ?? 0) + line.tickets;
      }
      for (const [sectionId, n] of Object.entries(ga)) {
        const result = await ctx.seats.holdGeneralAdmission({
          eventId,
          sessionId,
          sectionId,
          delta: n,
          expiresAt,
          maxPerSession: 0,
        });
        if (!result.ok) {
          throw new DomainError('SECTION_SOLD_OUT', 'Not enough spots left in this area', 409, {
            sectionId,
            remaining: result.remaining,
          });
        }
        heldGa.set(eventId, { ...(heldGa.get(eventId) ?? {}), [sectionId]: n });
      }
    }

    // ── Order in PostgreSQL (the final double-booking guard) ─────────────────
    // Settings are read before the transaction (a cache miss would borrow a second connection).
    const [general, invoicing] = await Promise.all([
      getSetting(ctx, 'general'),
      getSetting(ctx, 'invoicing'),
    ]);
    created = await withTransaction(ctx.db, (tx) =>
      createRows(ctx, tx, {
        params,
        buyer,
        quote,
        resolved,
        overrideReason,
        settings: { general, invoicing },
      }),
    );
  } catch (err) {
    await releaseHolds();
    if (isUniqueViolation(err, 'order_items_active_seat_uq')) {
      throw new DomainError('SEAT_UNAVAILABLE', 'A selected seat was just sold', 409);
    }
    throw err;
  }

  // ── After commit: nothing below may turn the committed sale into an error ──
  const safe = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[box-office] ${what} failed after the sale was committed`, err);
    }
  };
  for (const quoted of quote.events) {
    const seatIds = quoted.items.filter((i) => i.seatId).map((i) => i.seatId!);
    if (seatIds.length > 0) {
      await safe('seat mirror', () =>
        mirrorSeats(
          ctx,
          seatIds.map((seatId) => ({ seatId, eventId: quoted.eventId })),
          'S',
        ),
      );
      await safe('seat lock release', () =>
        ctx.seats.forceRelease(quoted.eventId, lockedSeats.get(quoted.eventId) ?? []),
      );
    }
    const ga = created.gaByEvent.get(quoted.eventId);
    if (ga) {
      await safe('standing capacity', async () => {
        const committed = await ctx.seats.commitGeneralAdmission(quoted.eventId, sessionId, ga);
        if (!committed) {
          // The hold was smaller than expected: PostgreSQL is right, rebuild the mirror from it.
          await rebuildInventory(ctx, eventRows.get(quoted.eventId)!);
          await releaseSessionHold(ctx, sessionId, quoted.eventId);
        }
        const remaining = await ctx.seats.generalAdmissionRemaining(quoted.eventId);
        await publishSeatDelta(ctx, {
          eventId: quoted.eventId,
          seats: [],
          ga: Object.fromEntries(Object.keys(ga).map((sec) => [sec, remaining[sec] ?? 0])),
        });
      });
    }
    // Picks that were held but are not part of the sale go back to the pool.
    if (held) await safe('hold release', () => releaseSessionHold(ctx, sessionId, quoted.eventId));
  }
  await safe('cart cleanup', () => clearCartAfterOrder(ctx, sessionId, eventIds));

  let ticketCount = 0;
  let ticketsReady = true;
  try {
    ticketCount = (await ensureOrderTickets(ctx, created.orderId)).length;
  } catch (err) {
    ticketsReady = false;
    console.error('[box-office] tickets could not be issued (the worker retries)', err);
  }
  // The invoice does not depend on the job: issue it now (idempotent; null for complimentary tickets).
  await safe('invoice', () => issueInvoice(ctx, created.orderId));
  // Job: PDF rendering retries + the optional e-mail through the normal path.
  await safe('fulfilment job enqueue', async () => {
    await ctx.jobs?.add(
      QUEUE_NAMES.documents,
      'order-paid',
      {
        orderId: created.orderId,
        paidCycle: 0,
        sendPaymentMail: params.sendEmail && Boolean(buyer.email),
      },
      { jobId: `order-paid-${created.orderId}` },
    );
  });
  return {
    orderId: created.orderId,
    orderNumber: created.orderNumber,
    status: 'PAID',
    payment: params.payment,
    totalGross: quote.totalGross,
    feeTotal: quote.feeTotal,
    currency: quote.currency,
    ticketCount,
    ticketsReady,
  };
}

function resolveLines(
  lines: z.output<typeof boxOfficeLineSchema>[],
  maps: Map<string, PublicSeatMap>,
  allowBlocked: boolean,
): ResolvedLine[] {
  const seenSeats = new Set<string>();
  return lines.map((line) => {
    const map = maps.get(line.eventId)!;
    const tariff = map.ticketTypes.find((t) => t.id === line.ticketTypeId);
    if (!tariff) {
      throw new DomainError('TARIFF_NOT_ALLOWED', 'This tariff is not sold at the box office', 422);
    }
    const overrideCents = line.priceOverrideCents ?? null;
    if ('seatId' in line) {
      if (seenSeats.has(line.seatId)) {
        throw new DomainError('DUPLICATE_SEAT', 'A seat was selected twice', 422);
      }
      seenSeats.add(line.seatId);
      const seat = seatIndex(map).get(line.seatId);
      if (!seat || !seat.c) {
        throw new DomainError('SEAT_UNAVAILABLE', 'This seat cannot be sold', 409, {
          seatId: line.seatId,
        });
      }
      const blocked = (seat.f & SEAT_FLAG.BLOCKED) !== 0;
      if (blocked && !allowBlocked) {
        throw new DomainError('SEAT_BLOCKED', 'This seat is blocked', 409, { seatId: line.seatId });
      }
      if (!allowedTypesFor(map, seat.c, seat.f).some((t) => t.id === tariff.id)) {
        throw new DomainError('TARIFF_NOT_ALLOWED', 'This tariff does not fit the seat', 422, {
          seatId: line.seatId,
        });
      }
      return {
        eventId: line.eventId,
        seatId: line.seatId,
        sectionId: seat.s,
        tickets: 1,
        ticketTypeId: tariff.id,
        categoryId: seat.c,
        blocked,
        overrideCents,
      };
    }
    const section = map.sections.find((s) => s.id === line.sectionId);
    if (!section || section.type !== 'STANDING' || !section.priceCategoryId) {
      throw new DomainError('SECTION_NOT_FOUND', 'Standing area not found', 404);
    }
    if (!allowedTypesFor(map, section.priceCategoryId, null).some((t) => t.id === tariff.id)) {
      throw new DomainError('TARIFF_NOT_ALLOWED', 'This tariff does not fit the area', 422);
    }
    return {
      eventId: line.eventId,
      seatId: null,
      sectionId: section.id,
      tickets: line.quantity,
      ticketTypeId: tariff.id,
      categoryId: section.priceCategoryId,
      blocked: false,
      overrideCents,
    };
  });
}

/** Synthetic cart (no Redis) so the order uses exactly the shop's pricing code. */
function buildCart(
  eventRows: Map<string, EventRow>,
  maps: Map<string, PublicSeatMap>,
  resolved: ResolvedLine[],
  free: boolean,
): CartView {
  const views: CartEventView[] = [];
  for (const [eventId, event] of eventRows) {
    const map = maps.get(eventId)!;
    const sections = new Map(map.sections.map((s) => [s.id, s]));
    const rows = new Map(map.rows.map((r) => [r.id, r]));
    const categories = new Map(map.categories.map((c) => [c.id, c]));
    const seats = seatIndex(map);
    const items: CartItemView[] = [];
    for (const line of resolved.filter((l) => l.eventId === eventId)) {
      const category = categories.get(line.categoryId);
      const section = sections.get(line.sectionId);
      const tariff = map.ticketTypes.find((t) => t.id === line.ticketTypeId);
      if (!category || !section || !tariff) {
        throw new DomainError('CART_OUTDATED', 'The seating plan changed, please reload', 409);
      }
      const seat = line.seatId ? seats.get(line.seatId) : undefined;
      const price = free ? 0 : (line.overrideCents ?? tariff.prices[category.id] ?? 0);
      for (let i = 0; i < line.tickets; i += 1) {
        items.push({
          key: line.seatId ?? `ga:${line.sectionId}:${items.length}`,
          kind: line.seatId ? 'SEAT' : 'GENERAL_ADMISSION',
          seatId: line.seatId,
          sectionId: section.id,
          sectionLabel: section.showLabelOnTicket ? section.ticketLabel : null,
          rowLabel: seat?.r ? (rows.get(seat.r)?.label ?? null) : null,
          seatLabel: seat?.l ?? null,
          categoryId: category.id,
          categoryName: category.name,
          categoryColor: category.color,
          ticketTypeId: tariff.id,
          priceGross: price,
          allowedTicketTypeIds: [tariff.id],
        });
      }
    }
    views.push({
      eventId,
      slug: event.slug,
      title: event.title,
      startsAt: event.startsAt.toISOString(),
      timeZone: event.timeZone,
      venueName: '',
      currency: event.currency,
      orphanSeatRuleEnabled: false,
      ticketTypes: map.ticketTypes,
      items,
      subtotalGross: items.reduce((sum, i) => sum + i.priceGross, 0),
    });
  }
  return {
    expiresAt: null,
    events: views,
    itemCount: views.reduce((n, e) => n + e.items.length, 0),
    totalGross: views.reduce((n, e) => n + e.subtotalGross, 0),
    currencies: [...new Set(views.map((e) => e.currency))],
  };
}

async function createRows(
  ctx: CoreContext,
  tx: Transaction,
  c: {
    params: CreateBoxOfficeOrderParams;
    buyer: BoxOfficeBuyer;
    quote: CheckoutQuote;
    resolved: ResolvedLine[];
    overrideReason: string | null;
    settings: {
      general: Awaited<ReturnType<typeof getSetting<'general'>>>;
      invoicing: Awaited<ReturnType<typeof getSetting<'invoicing'>>>;
    };
  },
): Promise<{
  orderId: string;
  orderNumber: string;
  gaByEvent: Map<string, Record<string, number>>;
}> {
  const { params, buyer, quote } = c;
  const now = new Date();
  const { general, invoicing } = c.settings;
  const locale = normalizeBuyerLocale(params.locale ?? general.defaultLocale) ?? 'en';

  const customerId = buyer.email
    ? await upsertCustomer(
        tx,
        {
          email: buyer.email,
          firstName: buyer.firstName ?? '',
          lastName: buyer.lastName ?? '',
          company: buyer.company,
          phone: buyer.phone,
          address: buyer.address,
          locale,
        },
        { keepStored: true },
      )
    : null;

  const gaByEvent = await claimStandingCapacity(tx, quote);

  const orderNumber = await nextNumber(
    tx,
    'order',
    invoicing.orderNumberPattern,
    now,
    general.defaultTimeZone,
  );
  const [order] = await tx
    .insert(orders)
    .values({
      orderNumber,
      customerId,
      status: 'PAID',
      channel: params.channel,
      paymentMethod: params.payment,
      email: buyer.email ?? null,
      firstName: buyer.firstName ?? '',
      lastName: buyer.lastName ?? '',
      company: buyer.company ?? null,
      phone: buyer.phone ?? null,
      billingAddress: buyer.address ?? null,
      locale,
      currency: quote.currency,
      subtotalGross: quote.subtotalGross,
      discountTotal: quote.discountTotal,
      feeTotal: quote.feeTotal,
      totalGross: quote.totalGross,
      totalNet: quote.totalNet,
      totalTax: quote.totalTax,
      amountPaid: quote.totalGross,
      internalNote: params.note?.trim() || null,
      createdByUserId: params.userId,
      ipAddress: params.ipAddress ?? null,
      paidAt: now,
    })
    .returning({ id: orders.id });
  const orderId = order!.id;

  const items = quote.events.flatMap((e) => e.items);
  await tx.insert(orderItems).values(
    items.map((item) => ({
      orderId,
      eventId: item.eventId,
      kind: item.kind,
      seatId: item.seatId,
      sectionId: item.sectionId,
      priceCategoryId: item.categoryId,
      ticketTypeId: item.ticketTypeId,
      status: 'CONFIRMED' as const,
      sectionLabel: item.sectionLabel,
      rowLabel: item.rowLabel,
      seatLabel: item.seatLabel,
      categoryName: item.categoryName,
      ticketTypeName: item.ticketTypeName,
      unitPriceGross: item.unitPriceGross,
      discountAmount: item.discountAmount,
      priceGross: item.priceGross,
      taxRateBasisPoints: item.taxRateBasisPoints,
      priceNet: item.priceNet,
      taxAmount: item.taxAmount,
    })) as (typeof orderItems.$inferInsert)[],
  );
  const fees = [...quote.events.flatMap((e) => e.fees), ...quote.orderFees];
  if (fees.length > 0) {
    await tx.insert(orderFees).values(
      fees.map((fee) => ({
        orderId,
        eventId: fee.eventId,
        feeId: fee.feeId,
        name: fee.name,
        scope: fee.scope,
        quantity: fee.quantity,
        unitAmountGross: fee.unitAmountGross,
        totalGross: fee.totalGross,
        taxRateBasisPoints: fee.taxRateBasisPoints,
        totalNet: fee.totalNet,
        totalTax: fee.totalTax,
      })),
    );
  }
  await tx.insert(payments).values({
    orderId,
    method: params.payment,
    status: 'CAPTURED',
    amount: quote.totalGross,
    currency: quote.currency,
    receivedByUserId: params.userId,
    capturedAt: now,
  });

  const overrides = c.resolved
    .filter((l) => l.overrideCents !== null)
    .map((l) => ({ seatId: l.seatId, sectionId: l.sectionId, priceGross: l.overrideCents }));
  const blockedSeatIds = c.resolved.filter((l) => l.blocked).map((l) => l.seatId);
  await tx.insert(orderHistory).values({
    orderId,
    type: 'box_office_sale',
    toStatus: 'PAID',
    actorType: 'ADMIN',
    actorUserId: params.userId,
    data: {
      channel: params.channel,
      payment: params.payment,
      totalGross: quote.totalGross,
      items: items.length,
      ...(overrides.length > 0 ? { priceOverrides: overrides, reason: c.overrideReason } : {}),
      ...(blockedSeatIds.length > 0 ? { blockedSeatsSold: blockedSeatIds } : {}),
    },
  });
  return { orderId, orderNumber, gaByEvent };
}

// ─── Held selection (locks while the seller builds the sale) ─────────────────

const tabIdSchema = z.uuid();

/** Redis lock session of one admin browser tab. */
export function boxOfficeSessionId(userId: string, tabId: string): string {
  return `boxoffice:${userId}:${tabIdSchema.parse(tabId)}`;
}

async function holdExpiry(ctx: CoreContext, sessionId: string): Promise<number> {
  const value = await ctx.redis.hget(ctx.keys.cart(sessionId), 'exp');
  return value ? Number(value) : 0;
}

/** Remembers the end of a tab's hold (read when the hold is converted into a sale). */
async function setHoldExpiry(ctx: CoreContext, sessionId: string, exp: number): Promise<void> {
  const key = ctx.keys.cart(sessionId);
  await ctx.redis
    .multi()
    .hset(key, 'exp', String(exp))
    .pexpireat(key, exp + 60_000)
    .exec();
}

async function sellableEvent(ctx: CoreContext, eventId: string): Promise<EventRow> {
  const event = await getEventCached(ctx, eventId);
  assertSellable(event);
  return event;
}

interface HoldRef {
  userId: string;
  tabId: string;
  eventId: string;
}

/**
 * Locks seats for the seller's tab with the normal cart lock TTL (Redis Lua, all-or-nothing, a
 * seat in an online cart is refused). Every call restarts the timer of the whole hold.
 * Blocked seats cannot be locked (they are guarded by the unique index at sale time).
 */
export async function holdBoxOfficeSeats(
  ctx: CoreContext,
  ref: HoldRef & { seatIds: string[] },
): Promise<{ expiresAt: number }> {
  const event = await sellableEvent(ctx, ref.eventId);
  const sessionId = boxOfficeSessionId(ref.userId, ref.tabId);
  const seatIds = [...new Set(ref.seatIds)];
  if (seatIds.length === 0 || seatIds.length > 200) {
    throw new DomainError('INVALID_REQUEST', 'Select between 1 and 200 seats', 400);
  }
  const index = seatIndex(await getPublicSeatMap(ctx, event));
  for (const id of seatIds) {
    const seat = index.get(id);
    if (!seat || !seat.c || (seat.f & SEAT_FLAG.BLOCKED) !== 0) throw lockError('UNAVAILABLE', id);
  }
  await ensureInventory(ctx, event);
  const config = await effectiveCheckoutConfig(ctx, event);
  const expiresAt = Date.now() + config.cartLockTtlSeconds * 1000;
  const before = new Set(await ctx.seats.sessionSeatIds(event.id, sessionId));
  const result = await ctx.seats.lockSeats({
    eventId: event.id,
    sessionId,
    seatIds,
    expiresAt,
    maxPerSession: 0,
  });
  if (!result.ok) throw lockError(result.reason, result.seatId);
  await ctx.seats.extendCart(event.id, sessionId, expiresAt);
  await setHoldExpiry(ctx, sessionId, expiresAt);
  const added = seatIds.filter((id) => !before.has(id));
  if (added.length > 0) {
    await publishSeatDelta(ctx, { eventId: event.id, seats: added.map((id) => [id, 'L']) });
  }
  return { expiresAt };
}

export async function releaseBoxOfficeSeats(
  ctx: CoreContext,
  ref: HoldRef & { seatIds: string[] },
): Promise<void> {
  const sessionId = boxOfficeSessionId(ref.userId, ref.tabId);
  const released = await ctx.seats.releaseSeats(ref.eventId, sessionId, [...new Set(ref.seatIds)]);
  if (released.length > 0) {
    await publishSeatDelta(ctx, {
      eventId: ref.eventId,
      seats: released.map((id) => [id, 'F']),
    });
  }
}

/** Sets the number of standing spots the tab holds in one area (total over all tariffs). */
export async function setBoxOfficeStandingHold(
  ctx: CoreContext,
  ref: HoldRef & { sectionId: string; quantity: number },
): Promise<{ expiresAt: number | null; remaining: number }> {
  const event = await sellableEvent(ctx, ref.eventId);
  const sessionId = boxOfficeSessionId(ref.userId, ref.tabId);
  const section = (await getPublicSeatMap(ctx, event)).sections.find((s) => s.id === ref.sectionId);
  if (!section || section.type !== 'STANDING' || !section.priceCategoryId) {
    throw new DomainError('SECTION_NOT_FOUND', 'Standing area not found', 404);
  }
  const quantity = Math.max(0, Math.min(Math.trunc(ref.quantity), MAX_GA_PER_LINE * 5));
  await ensureInventory(ctx, event);
  const current =
    (await ctx.seats.sessionGeneralAdmission(event.id, sessionId))[ref.sectionId] ?? 0;
  const config = await effectiveCheckoutConfig(ctx, event);
  const expiresAt = Date.now() + config.cartLockTtlSeconds * 1000;
  const result = await ctx.seats.holdGeneralAdmission({
    eventId: event.id,
    sessionId,
    sectionId: ref.sectionId,
    delta: quantity - current,
    expiresAt,
    maxPerSession: 0,
  });
  if (!result.ok) {
    throw new DomainError('SECTION_SOLD_OUT', 'Not enough spots left in this area', 409, {
      sectionId: ref.sectionId,
      remaining: result.remaining,
    });
  }
  // Every change restarts the timer of the whole hold (seats and spots share one expiry).
  if (quantity > 0) {
    await ctx.seats.extendCart(event.id, sessionId, expiresAt);
    await setHoldExpiry(ctx, sessionId, expiresAt);
  }
  await publishSeatDelta(ctx, {
    eventId: event.id,
    seats: [],
    ga: { [ref.sectionId]: result.remaining },
  });
  return { expiresAt: quantity > 0 ? expiresAt : null, remaining: result.remaining };
}

/**
 * What the tab currently holds in the event (seats, standing spots per area, end of the hold).
 * Lets a reloaded / re-opened box-office page restore its selection and countdown.
 */
export async function getBoxOfficeHold(
  ctx: CoreContext,
  ref: HoldRef,
): Promise<{ seatIds: string[]; ga: Record<string, number>; expiresAt: number | null }> {
  const sessionId = boxOfficeSessionId(ref.userId, ref.tabId);
  const [seatIds, ga, exp] = await Promise.all([
    ctx.seats.sessionSeatIds(ref.eventId, sessionId),
    ctx.seats.sessionGeneralAdmission(ref.eventId, sessionId),
    holdExpiry(ctx, sessionId),
  ]);
  const held = seatIds.length > 0 || Object.values(ga).some((n) => n > 0);
  return {
    seatIds,
    ga: Object.fromEntries(Object.entries(ga).filter(([, n]) => n > 0)),
    expiresAt: held && exp > Date.now() ? exp : null,
  };
}

/** Releases everything the tab still holds in the event (clear, next sale, tab closed). */
export async function releaseBoxOfficeHold(ctx: CoreContext, ref: HoldRef): Promise<void> {
  await releaseSessionHold(ctx, boxOfficeSessionId(ref.userId, ref.tabId), ref.eventId);
  await clearCartAfterOrder(ctx, boxOfficeSessionId(ref.userId, ref.tabId), [ref.eventId]);
}

export async function releaseSessionHold(
  ctx: CoreContext,
  sessionId: string,
  eventId: string,
): Promise<void> {
  const seatIds = await ctx.seats.sessionSeatIds(eventId, sessionId);
  const released = await ctx.seats.releaseSeats(eventId, sessionId, seatIds);
  const ga = await ctx.seats.sessionGeneralAdmission(eventId, sessionId);
  const remaining: Record<string, number> = {};
  for (const [sectionId, n] of Object.entries(ga)) {
    const r = await ctx.seats.holdGeneralAdmission({
      eventId,
      sessionId,
      sectionId,
      delta: -n,
      expiresAt: Date.now() + 1000,
      maxPerSession: 0,
    });
    remaining[sectionId] = r.remaining;
  }
  if (released.length > 0 || Object.keys(remaining).length > 0) {
    await publishSeatDelta(ctx, {
      eventId,
      seats: released.map((id) => [id, 'F'] as [string, 'F']),
      ga: Object.keys(remaining).length ? remaining : undefined,
    });
  }
}
