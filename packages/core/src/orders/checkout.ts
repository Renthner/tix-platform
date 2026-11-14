import { coreLog } from '../log';
import { randomInt } from 'node:crypto';
import {
  accessCodes,
  customers,
  events,
  isUniqueViolation,
  orderFees,
  orderAdjustments,
  orderHistory,
  orderItems,
  orders,
  seatMapSections,
  withTransaction,
  type Transaction,
} from '@tix/db';
import {
  INVENTORY_HOLDING_ITEM_STATUSES,
  buildPaymentReference,
  type CheckoutInput,
  type OrderStatus,
} from '@tix/shared';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { withMutex } from '../banking/runs';
import { clearCartAfterOrder, holdCartUntil, validateSelection } from '../cart';
import { rebuildInventory } from '../inventory';
import { DomainError, type CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage } from '../email';
import { effectiveCheckoutConfig } from '../events';
import { QUEUE_NAMES } from '../job-queues';
import { nextNumber } from '../numbering';
import { publishSeatDelta } from '../realtime';
import { getSetting } from '../settings';
import { isDraftEvent, shopSaleState, type ShopActorLike } from '../shop-actor';
import { orderAccessToken } from './access';
import { mirrorSeats } from './fulfillment';
import { computeBankTransferTerms } from './payment-terms';
import { quoteForMethod, type CheckoutQuote } from './pricing';

/**
 * "Place order" (zahlungspflichtig bestellen): turns the Redis cart of a session into an
 * order in PostgreSQL.
 *
 *  - BANK_TRANSFER → AWAITING_PAYMENT with payment reference (Verwendungszweck + Luhn
 *    digit), due date, reminder and auto-cancel dates; seats RESERVED_PENDING_PAYMENT.
 *  - PAYPAL        → PENDING; the customer pays on the order page (PayPal redirect). The
 *    order expires after the PayPal approval window (dunning job) and releases its seats.
 *
 * Inventory hand-over: the session's Redis locks are kept alive during the transaction, the
 * partial unique index on `order_items.seat_id` is the final double-booking guard, and after
 * commit the locks become "taken" (reserved) in the mirror.
 */

/** Locks must outlive the order transaction comfortably. */
const ORDER_CREATION_HOLD_MS = 2 * 60 * 1000;
/** Random digits of the payment reference (PREFIX-YYYY-NNNNNN-C). */
const REFERENCE_DIGITS = 6;
const MAX_ATTEMPTS = 3;
/** Order numbers of test orders (separate counter, never mixes with the invoiced series). */
export const TEST_ORDER_NUMBER_PATTERN = 'TEST-{YYYY}-{SEQ:4}';

export interface PlaceOrderParams {
  sessionId: string;
  input: CheckoutInput;
  /** Logged-in customer account: its e-mail address is used for the order. */
  account?: { customerId: string; email: string } | null;
  ipAddress?: string | null;
  /** Signed-in super-admin (role verified by the web layer on this request); omitted for customers. */
  actor?: ShopActorLike;
}

export interface PlacedOrder {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  method: CheckoutInput['method'];
  totalGross: number;
  currency: string;
  paymentReference: string | null;
  paymentDueAt: string | null;
  /** Signed guest access token for the order page. */
  accessToken: string;
  locale: string;
}

/**
 * Sign-in / registration is offered in the checkout when customer accounts are enabled
 * globally and no event of the cart hides them (`events.customer_accounts_enabled = false`).
 * Where they are not offered, guest checkout is always possible.
 */
export function customerAccountsOffered(
  settings: { enabled: boolean },
  events: readonly { customerAccountsEnabled: boolean | null }[],
): boolean {
  return settings.enabled && events.every((e) => e.customerAccountsEnabled !== false);
}

export async function placeOrder(ctx: CoreContext, params: PlaceOrderParams): Promise<PlacedOrder> {
  // One checkout per cart at a time: a double click / retry racing the first request would
  // otherwise create a second order for the same cart (standing spots have no unique index).
  const locked = await withMutex(ctx, `checkout:${params.sessionId}`, 60_000, () =>
    placeOrderLocked(ctx, params),
  );
  if (!locked) {
    throw new DomainError('CHECKOUT_IN_PROGRESS', 'Your order is already being processed', 409);
  }
  return locked.value;
}

async function placeOrderLocked(ctx: CoreContext, params: PlaceOrderParams): Promise<PlacedOrder> {
  const { sessionId } = params;
  const input = params.account ? { ...params.input, email: params.account.email } : params.input;
  // All settings are read here: inside the order transaction a cache miss would borrow a second
  // pool connection while the transaction holds one.
  const [checkoutSettings, accountSettings, general, invoicing, bank] = await Promise.all([
    getSetting(ctx, 'checkout'),
    getSetting(ctx, 'customerAccounts'),
    getSetting(ctx, 'general'),
    getSetting(ctx, 'invoicing'),
    getSetting(ctx, 'bankTransfer'),
  ]);
  if (checkoutSettings.requireTermsAcceptance && !input.acceptTerms) {
    throw new DomainError('TERMS_NOT_ACCEPTED', 'Please accept the terms and conditions', 422);
  }

  if (checkoutSettings.requirePhone && !input.phone) {
    throw new DomainError('PHONE_REQUIRED', 'Please enter your phone number', 422);
  }
  if (checkoutSettings.requireBillingAddress && !input.address) {
    throw new DomainError('ADDRESS_REQUIRED', 'Please enter your billing address', 422);
  }

  const {
    quote,
    events: eventRows,
    maps,
  } = await quoteForMethod(ctx, sessionId, input.method, input.locale);
  const accountsOffered = customerAccountsOffered(accountSettings, [...eventRows.values()]);
  if (accountsOffered && !accountSettings.guestCheckoutEnabled && !params.account) {
    throw new DomainError('LOGIN_REQUIRED', 'Please sign in to complete your order', 401);
  }
  if (quote.totalGross !== input.expectedTotalGross) {
    throw new DomainError('PRICE_CHANGED', 'The price of your order changed', 409, {
      totalGross: quote.totalGross,
    });
  }

  // Sale state + presale access per event.
  const codeIds = new Map<string, string>();
  for (const event of eventRows.values()) {
    const state = shopSaleState(event, params.actor);
    const codeId = await ctx.redis.get(ctx.keys.queueAccessCode(event.id, sessionId));
    if (codeId) codeIds.set(event.id, codeId);
    if (state === 'ON_SALE' || (state === 'PRESALE' && codeId)) continue;
    throw new DomainError('EVENT_NOT_ON_SALE', 'Tickets for this event are not on sale', 409, {
      event: event.title,
      state,
    });
  }

  // Orders on DRAFT events are test orders (super-admin test purchases). They must not be mixed
  // with real events: a test order is never invoiced and never counted, a real one always is.
  const draftCount = [...eventRows.values()].filter(isDraftEvent).length;
  if (draftCount > 0 && draftCount !== eventRows.size) {
    throw new DomainError(
      'TEST_ORDER_MIXED_CART',
      'A cart with events that are not yet published cannot be combined with published events',
      422,
    );
  }
  const isTest = draftCount > 0;

  // Keep the locks alive and make sure the session still holds exactly the quoted items.
  await holdCartUntil(ctx, sessionId, Date.now() + ORDER_CREATION_HOLD_MS);
  for (const quoted of quote.events) {
    const [seatIds, ga] = await Promise.all([
      ctx.seats.sessionSeatIds(quoted.eventId, sessionId),
      ctx.seats.sessionGeneralAdmission(quoted.eventId, sessionId),
    ]);
    const quotedSeats = quoted.items.filter((i) => i.seatId).map((i) => i.seatId!);
    const quotedGa = quoted.items.filter((i) => !i.seatId).length;
    const heldGa = Object.values(ga).reduce((a, b) => a + b, 0);
    const held = new Set(seatIds);
    if (
      quotedSeats.length !== held.size ||
      quotedSeats.some((id) => !held.has(id)) ||
      quotedGa !== heldGa
    ) {
      throw new DomainError('CART_CHANGED', 'Your cart changed, please review it', 409);
    }
  }

  // Seat rules (orphan seats, companion seats) per event.
  const ownerChecks: { eventId: string; companionSeatId: string; partners: string[] }[] = [];
  for (const event of eventRows.values()) {
    const check = await validateSelection(ctx, sessionId, event);
    if (!check.ok) {
      throw new DomainError('SELECTION_INVALID', 'Your seat selection is not allowed', 422, {
        event: event.title,
        orphanSeatIds: check.orphanSeatIds,
        companionSeatIds: check.companionSeatIds,
      });
    }
    const seatsById = new Map(maps.get(event.id)!.seats.map((s) => [s.i, s]));
    for (const seatId of check.companionOwnerCheckSeatIds) {
      ownerChecks.push({
        eventId: event.id,
        companionSeatId: seatId,
        partners: seatsById.get(seatId)?.w ?? [],
      });
    }
  }

  const configs = new Map(
    await Promise.all(
      [...eventRows.values()].map(
        async (e) => [e.id, await effectiveCheckoutConfig(ctx, e)] as const,
      ),
    ),
  );

  // Idempotent re-submit: the order of this very cart already exists (its post-commit Redis work
  // failed or the response got lost) – hand it out again instead of creating a second one.
  const existing = await findOrderOfCart(ctx, sessionId, quote.totalGross, quote.ticketCount);
  if (existing) {
    await repairAfterOrder(ctx, sessionId, quote, eventRows, existing.orderId);
    return {
      orderId: existing.orderId,
      orderNumber: existing.orderNumber,
      status: existing.status,
      method: existing.paymentMethod as PlacedOrder['method'],
      totalGross: existing.totalGross,
      currency: existing.currency,
      paymentReference: existing.paymentReference,
      paymentDueAt: existing.paymentDueAt?.toISOString() ?? null,
      accessToken: orderAccessToken(ctx, existing.orderId),
      locale: existing.locale,
    };
  }

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const created = await withTransaction(ctx.db, (tx) =>
        createOrderRows(ctx, tx, {
          params: { ...params, input },
          quote,
          eventRows,
          configs,
          codeIds,
          ownerChecks,
          settings: { general, invoicing, bank },
          isTest,
        }),
      );
      // The order is committed: nothing below may turn it into an error. A failed Redis hand-over
      // is repaired from PostgreSQL (best effort here, again on a re-submit of the same cart).
      try {
        await afterOrderCreated(ctx, sessionId, quote, created);
      } catch (err) {
        coreLog.error({ err }, '[checkout] post-commit work failed, repairing from PostgreSQL');
        await repairAfterOrder(ctx, sessionId, quote, eventRows, created.orderId).catch((e) =>
          coreLog.error({ err: e }, '[checkout] repair failed'),
        );
      }
      return {
        ...created,
        accessToken: orderAccessToken(ctx, created.orderId),
        locale: input.locale,
      };
    } catch (err) {
      if (isUniqueViolation(err, 'order_items_active_seat_uq')) {
        throw new DomainError(
          'SEAT_UNAVAILABLE',
          'A seat in your cart is no longer available',
          409,
        );
      }
      // Random payment reference collided – try a new one.
      if (isUniqueViolation(err, 'orders_payment_reference_uq') && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }
  }
}

const ACTIVE_ORDER_STATUSES = ['PENDING', 'AWAITING_PAYMENT', 'PAID'] as const;

/** Active order created from this cart after its last change (same total and ticket count). */
async function findOrderOfCart(
  ctx: CoreContext,
  sessionId: string,
  totalGross: number,
  ticketCount: number,
) {
  const changed = Number(await ctx.redis.hget(ctx.keys.cart(sessionId), 'changed'));
  if (!Number.isFinite(changed) || changed <= 0) return null;
  const [row] = await ctx.db
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      paymentMethod: orders.paymentMethod,
      totalGross: orders.totalGross,
      currency: orders.currency,
      paymentReference: orders.paymentReference,
      paymentDueAt: orders.paymentDueAt,
      locale: orders.locale,
      items: count(orderItems.id),
    })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.cartSessionId, sessionId),
        inArray(orders.status, [...ACTIVE_ORDER_STATUSES]),
        eq(orders.totalGross, totalGross),
        sql`${orders.createdAt} >= ${new Date(changed)}`,
      ),
    )
    .groupBy(orders.id)
    .orderBy(sql`${orders.createdAt} desc`)
    .limit(1);
  if (!row || row.items !== ticketCount) return null;
  return row;
}

/**
 * Brings Redis in line with an order that is already committed: seat mirror, released locks,
 * standing capacity (rebuilt from the authoritative DB counter) and the cart itself.
 */
async function repairAfterOrder(
  ctx: CoreContext,
  sessionId: string,
  quote: CheckoutQuote,
  eventRows: CreateContext['eventRows'],
  orderId: string,
): Promise<void> {
  const [order] = await ctx.db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId));
  const paid = order?.status === 'PAID';
  for (const quoted of quote.events) {
    const seatIds = quoted.items.filter((i) => i.seatId).map((i) => i.seatId!);
    if (seatIds.length > 0) {
      await mirrorSeats(
        ctx,
        seatIds.map((seatId) => ({ seatId, eventId: quoted.eventId })),
        paid ? 'S' : 'R',
      );
      await ctx.seats.forceRelease(quoted.eventId, seatIds);
    }
    if (quoted.items.some((i) => i.kind === 'GENERAL_ADMISSION')) {
      const event = eventRows.get(quoted.eventId);
      if (event) await rebuildInventory(ctx, event);
    }
  }
  await clearCartAfterOrder(
    ctx,
    sessionId,
    quote.events.map((e) => e.eventId),
  );
}

interface CreateContext {
  params: PlaceOrderParams;
  quote: CheckoutQuote;
  eventRows: Awaited<ReturnType<typeof quoteForMethod>>['events'];
  configs: Map<string, Awaited<ReturnType<typeof effectiveCheckoutConfig>>>;
  codeIds: Map<string, string>;
  /** Test order (DRAFT events): own order number series, flagged `is_test`. */
  isTest: boolean;
  ownerChecks: { eventId: string; companionSeatId: string; partners: string[] }[];
  settings: {
    general: Awaited<ReturnType<typeof getSetting<'general'>>>;
    invoicing: Awaited<ReturnType<typeof getSetting<'invoicing'>>>;
    bank: Awaited<ReturnType<typeof getSetting<'bankTransfer'>>>;
  };
}

type CreatedOrder = Omit<PlacedOrder, 'accessToken' | 'locale'> & {
  gaByEvent: Map<string, Record<string, number>>;
  /** Confirmation e-mail stored in the same transaction (outbox), dispatched after commit. */
  emailMessageId: string | null;
};

/**
 * Standing areas: claims the capacity of the quoted GA items in the DB (authoritative
 * counter, one conditional UPDATE per section). Returns the claimed spots per event/section.
 */
export async function claimStandingCapacity(
  tx: Transaction,
  quote: Pick<CheckoutQuote, 'events'>,
): Promise<Map<string, Record<string, number>>> {
  const gaByEvent = new Map<string, Record<string, number>>();
  for (const quoted of quote.events) {
    const sections: Record<string, number> = {};
    for (const item of quoted.items) {
      if (item.kind === 'GENERAL_ADMISSION')
        sections[item.sectionId] = (sections[item.sectionId] ?? 0) + 1;
    }
    for (const [sectionId, n] of Object.entries(sections)) {
      const updated = await tx
        .update(seatMapSections)
        .set({ allocatedCount: sql`${seatMapSections.allocatedCount} + ${n}` })
        .where(
          and(
            eq(seatMapSections.id, sectionId),
            sql`${seatMapSections.allocatedCount} + ${n} <= coalesce(${seatMapSections.capacity}, 0)`,
          ),
        )
        .returning({ id: seatMapSections.id });
      if (updated.length === 0) {
        throw new DomainError('SECTION_SOLD_OUT', 'Not enough spots left in this area', 409);
      }
    }
    if (Object.keys(sections).length > 0) gaByEvent.set(quoted.eventId, sections);
  }
  return gaByEvent;
}

async function createOrderRows(
  ctx: CoreContext,
  tx: Transaction,
  c: CreateContext,
): Promise<CreatedOrder> {
  const { input } = c.params;
  const now = new Date();
  const customerId = await upsertCustomer(tx, input);

  // Companion seat bought alone: its wheelchair space must be sold to the same e-mail.
  for (const check of c.ownerChecks) {
    const owned =
      check.partners.length === 0
        ? []
        : await tx
            .select({ id: orderItems.id })
            .from(orderItems)
            .innerJoin(orders, eq(orders.id, orderItems.orderId))
            .where(
              and(
                inArray(orderItems.seatId, check.partners),
                eq(orderItems.eventId, check.eventId),
                eq(orderItems.status, 'CONFIRMED'),
                sql`lower(${orders.email}) = ${input.email.toLowerCase()}`,
              ),
            )
            .limit(1);
    if (owned.length === 0) {
      throw new DomainError(
        'COMPANION_OWNER_MISMATCH',
        'This companion seat can only be booked by the buyer of its wheelchair space',
        422,
        { companionSeatIds: [check.companionSeatId] },
      );
    }
  }

  // Per customer (e-mail) limit per event. The customer row is locked by the upsert, so
  // parallel checkouts of the same buyer are serialised here.
  for (const quoted of c.quote.events) {
    const max = c.configs.get(quoted.eventId)?.maxTicketsPerCustomer ?? null;
    if (max === null) continue;
    const [row] = await tx
      .select({ n: count() })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orders.customerId, customerId),
          eq(orderItems.eventId, quoted.eventId),
          inArray(orderItems.status, [...INVENTORY_HOLDING_ITEM_STATUSES]),
        ),
      );
    const already = row?.n ?? 0;
    if (already + quoted.items.length > max) {
      throw new DomainError('CUSTOMER_LIMIT', 'Ticket limit per customer reached', 422, {
        event: quoted.title,
        max,
        remaining: Math.max(0, max - already),
      });
    }
  }

  // Total tickets per access code across all orders.
  for (const quoted of c.quote.events) {
    const codeId = c.codeIds.get(quoted.eventId);
    if (!codeId) continue;
    const [code] = await tx
      .select({ max: accessCodes.maxTicketsTotal, code: accessCodes.code })
      .from(accessCodes)
      .where(eq(accessCodes.id, codeId))
      .for('update');
    if (!code) {
      c.codeIds.delete(quoted.eventId);
      continue;
    }
    if (code.max === null) continue;
    const [row] = await tx
      .select({ n: count() })
      .from(orderItems)
      .where(
        and(
          eq(orderItems.accessCodeId, codeId),
          inArray(orderItems.status, [...INVENTORY_HOLDING_ITEM_STATUSES]),
        ),
      );
    const used = row?.n ?? 0;
    if (used + quoted.items.length > code.max) {
      throw new DomainError('ACCESS_CODE_LIMIT', 'The ticket quota of your code is used up', 422, {
        max: code.max,
        remaining: Math.max(0, code.max - used),
      });
    }
  }

  // Standing areas: claim capacity in the DB (authoritative counter).
  const gaByEvent = await claimStandingCapacity(tx, c.quote);

  // A test order may only exist on events that are still drafts. The UPDATE row-locks the event
  // and so serialises against publishing (which locks it FOR UPDATE and refuses while test orders
  // exist): a test order created concurrently with the publish either commits first (publish then
  // refuses / cleans up) or sees the event no longer in DRAFT and aborts.
  if (c.isTest) {
    const flagged = await tx
      .update(events)
      .set({ hadTestOrders: true })
      .where(and(inArray(events.id, [...c.eventRows.keys()]), eq(events.status, 'DRAFT')))
      .returning({ id: events.id });
    if (flagged.length !== c.eventRows.size) {
      throw new DomainError(
        'EVENT_NOT_DRAFT',
        'The event was published in the meantime – test purchases are no longer possible',
        409,
      );
    }
  }

  // Payment terms.
  const { general, invoicing, bank } = c.settings;
  const timeZone = general.defaultTimeZone;
  const eventList = [...c.eventRows.values()];
  const isBankTransfer = input.method === 'BANK_TRANSFER';
  let paymentReference: string | null = null;
  let paymentDueAt: Date | null = null;
  let nextReminderAt: Date | null = null;
  let autoCancelAt: Date | null = null;
  if (isBankTransfer) {
    const year = Number(new Intl.DateTimeFormat('en', { timeZone, year: 'numeric' }).format(now));
    // References are unique across orders AND additional payments (order_adjustments).
    for (let n = 0; n < 8; n += 1) {
      paymentReference = buildPaymentReference(
        bank.paymentReferencePrefix,
        year,
        String(randomInt(10 ** (REFERENCE_DIGITS - 1), 10 ** REFERENCE_DIGITS)),
      );
      const [clash] = await tx
        .select({ id: orderAdjustments.id })
        .from(orderAdjustments)
        .where(eq(orderAdjustments.paymentReference, paymentReference));
      if (!clash) break;
    }
    ({ paymentDueAt, nextReminderAt, autoCancelAt } = computeBankTransferTerms({
      bank,
      timeZone,
      events: eventList,
      now,
    }));
  }
  const free = c.quote.totalGross === 0;
  const status: OrderStatus = free ? 'PAID' : isBankTransfer ? 'AWAITING_PAYMENT' : 'PENDING';
  const itemStatus = free ? 'CONFIRMED' : 'PENDING';

  // Gapless order number – allocated last so the counter row lock is held only briefly.
  // Test orders have their own number series: deleting them must never leave holes in the real one.
  const orderNumber = c.isTest
    ? await nextNumber(tx, 'order-test', TEST_ORDER_NUMBER_PATTERN, now, timeZone)
    : await nextNumber(tx, 'order', invoicing.orderNumberPattern, now, timeZone);
  const [order] = await tx
    .insert(orders)
    .values({
      orderNumber,
      customerId,
      status,
      channel: 'ONLINE',
      isTest: c.isTest,
      paymentMethod: input.method,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      company: input.company ?? null,
      phone: input.phone ?? null,
      billingAddress: input.address ?? null,
      locale: input.locale,
      currency: c.quote.currency,
      subtotalGross: c.quote.subtotalGross,
      discountTotal: c.quote.discountTotal,
      feeTotal: c.quote.feeTotal,
      totalGross: c.quote.totalGross,
      totalNet: c.quote.totalNet,
      totalTax: c.quote.totalTax,
      paymentReference,
      paymentDueAt,
      nextReminderAt: free ? null : nextReminderAt,
      autoCancelAt: free ? null : autoCancelAt,
      cartSessionId: c.params.sessionId,
      termsAcceptedAt: input.acceptTerms ? now : null,
      customerNote: input.customerNote ?? null,
      ipAddress: c.params.ipAddress ?? null,
      paidAt: free ? now : null,
    })
    .returning({ id: orders.id });
  const orderId = order!.id;

  const items = c.quote.events.flatMap((e) => e.items);
  await tx.insert(orderItems).values(
    items.map((item) => ({
      orderId,
      eventId: item.eventId,
      kind: item.kind,
      seatId: item.seatId,
      sectionId: item.sectionId,
      priceCategoryId: item.categoryId,
      ticketTypeId: item.ticketTypeId,
      status: itemStatus,
      accessCodeId: c.codeIds.get(item.eventId) ?? null,
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
  const fees = [...c.quote.events.flatMap((e) => e.fees), ...c.quote.orderFees];
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
  await tx.insert(orderHistory).values({
    orderId,
    type: 'created',
    toStatus: status,
    actorType: 'CUSTOMER',
    data: {
      method: input.method,
      totalGross: c.quote.totalGross,
      items: items.length,
      ...(paymentReference ? { paymentReference } : {}),
    },
  });

  // Vorkasse instructions are written atomically with the order (transactional outbox).
  const emailMessageId =
    status === 'AWAITING_PAYMENT'
      ? await createEmailMessage(ctx, tx, { key: 'ORDER_CONFIRMATION_BANK_TRANSFER', orderId })
      : null;

  return {
    orderId,
    orderNumber,
    status,
    method: input.method,
    totalGross: c.quote.totalGross,
    currency: c.quote.currency,
    paymentReference,
    paymentDueAt: paymentDueAt?.toISOString() ?? null,
    gaByEvent,
    emailMessageId,
  };
}

/**
 * One customer record per e-mail address. Guest data refreshes the record; name and
 * company, phone and address of a registered customer account (has a password) are never
 * overwritten by checkout input – a guest checkout with that e-mail must not change the account;
 * the order keeps its own billing data (invoices read the order, not the customer). For
 * guest-only records a newly entered phone / address wins but stored values are never blanked out.
 */
export async function upsertCustomer(
  tx: Transaction,
  input: Pick<
    CheckoutInput,
    'email' | 'firstName' | 'lastName' | 'company' | 'phone' | 'address' | 'locale'
  >,
  /** Box office: stored locale / company are kept when the seller leaves them empty or differs. */
  options: { keepStored?: boolean } = {},
): Promise<string> {
  const keep = options.keepStored === true;
  const address = input.address ? JSON.stringify(input.address) : null;
  const result = await tx.execute<{ id: string }>(sql`
    INSERT INTO ${customers} (email, first_name, last_name, company, phone, address, locale)
    VALUES (${input.email}, ${input.firstName}, ${input.lastName}, ${input.company ?? null},
            ${input.phone ?? null}, ${address}::jsonb, ${input.locale})
    ON CONFLICT ((lower(email))) DO UPDATE SET
      first_name = CASE WHEN ${customers.passwordHash} IS NULL THEN COALESCE(NULLIF(EXCLUDED.first_name, ''), ${customers.firstName}) ELSE ${customers.firstName} END,
      last_name  = CASE WHEN ${customers.passwordHash} IS NULL THEN COALESCE(NULLIF(EXCLUDED.last_name, ''), ${customers.lastName}) ELSE ${customers.lastName} END,
      company    = CASE WHEN ${customers.passwordHash} IS NULL THEN (CASE WHEN ${keep}::boolean THEN COALESCE(NULLIF(EXCLUDED.company, ''), ${customers.company}) ELSE EXCLUDED.company END) ELSE ${customers.company} END,
      -- Registered accounts: only fill an empty phone / address, never overwrite stored values.
      phone      = CASE WHEN ${customers.passwordHash} IS NULL THEN COALESCE(EXCLUDED.phone, ${customers.phone}) ELSE COALESCE(NULLIF(${customers.phone}, ''), EXCLUDED.phone) END,
      address    = CASE WHEN ${customers.passwordHash} IS NULL THEN COALESCE(EXCLUDED.address, ${customers.address}) ELSE (CASE WHEN ${customers.address} IS NULL OR ${customers.address} = '{}'::jsonb OR ${customers.address} = 'null'::jsonb THEN COALESCE(EXCLUDED.address, ${customers.address}) ELSE ${customers.address} END) END,
      locale     = CASE WHEN ${keep}::boolean THEN COALESCE(${customers.locale}, EXCLUDED.locale) ELSE EXCLUDED.locale END,
      updated_at = now()
    RETURNING id`);
  const id = result.rows[0]?.id;
  if (!id) throw new Error('Customer upsert returned no row');
  return id;
}

async function afterOrderCreated(
  ctx: CoreContext,
  sessionId: string,
  quote: CheckoutQuote,
  created: CreatedOrder,
): Promise<void> {
  const paid = created.status === 'PAID';
  for (const quoted of quote.events) {
    const seatIds = quoted.items.filter((i) => i.seatId).map((i) => i.seatId!);
    if (seatIds.length > 0) {
      await mirrorSeats(
        ctx,
        seatIds.map((seatId) => ({ seatId, eventId: quoted.eventId })),
        paid ? 'S' : 'R',
      );
      await ctx.seats.forceRelease(quoted.eventId, seatIds);
    }
    const ga = created.gaByEvent.get(quoted.eventId);
    if (ga) {
      await ctx.seats.commitGeneralAdmission(quoted.eventId, sessionId, ga);
      const remaining = await ctx.seats.generalAdmissionRemaining(quoted.eventId);
      await publishSeatDelta(ctx, {
        eventId: quoted.eventId,
        seats: [],
        ga: Object.fromEntries(Object.keys(ga).map((s) => [s, remaining[s] ?? 0])),
      });
    }
  }
  await clearCartAfterOrder(
    ctx,
    sessionId,
    quote.events.map((e) => e.eventId),
  );

  if (paid) {
    await ctx.jobs?.add(
      QUEUE_NAMES.documents,
      'order-paid',
      { orderId: created.orderId },
      { jobId: `order-paid-${created.orderId}` },
    );
  } else if (created.emailMessageId) {
    try {
      await dispatchEmailMessage(ctx, created.emailMessageId);
    } catch (err) {
      // Stored in the outbox – the worker re-queues undispatched messages.
      coreLog.error({ err }, '[checkout] confirmation e-mail could not be queued');
    }
  }
}
