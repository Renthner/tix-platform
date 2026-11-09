import { randomInt } from 'node:crypto';
import {
  accessCodes,
  customers,
  isUniqueViolation,
  orderFees,
  orderHistory,
  orderItems,
  orders,
  seatMapSections,
  withTransaction,
  type Transaction,
} from '@tix/db';
import {
  INVENTORY_HOLDING_ITEM_STATUSES,
  addPaymentDays,
  buildPaymentReference,
  endOfDayInZone,
  type CheckoutInput,
  type OrderStatus,
} from '@tix/shared';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { clearCartAfterOrder, holdCartUntil, validateSelection } from '../cart';
import { DomainError, type CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage } from '../email';
import { computeSaleState, effectiveCheckoutConfig } from '../events';
import { QUEUE_NAMES } from '../job-queues';
import { nextNumber } from '../numbering';
import { publishSeatDelta } from '../realtime';
import { getSetting } from '../settings';
import { orderAccessToken } from './access';
import { resolveCancelDays } from './cancel-terms';
import { mirrorSeats } from './fulfillment';
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

export interface PlaceOrderParams {
  sessionId: string;
  input: CheckoutInput;
  /** Logged-in customer account: its e-mail address is used for the order. */
  account?: { customerId: string; email: string } | null;
  ipAddress?: string | null;
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
  const { sessionId } = params;
  const input = params.account ? { ...params.input, email: params.account.email } : params.input;
  const [checkoutSettings, accountSettings] = await Promise.all([
    getSetting(ctx, 'checkout'),
    getSetting(ctx, 'customerAccounts'),
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

  const { quote, events: eventRows, maps } = await quoteForMethod(ctx, sessionId, input.method);
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
    const state = computeSaleState(event);
    const codeId = await ctx.redis.get(ctx.keys.queueAccessCode(event.id, sessionId));
    if (codeId) codeIds.set(event.id, codeId);
    if (state === 'ON_SALE' || (state === 'PRESALE' && codeId)) continue;
    throw new DomainError('EVENT_NOT_ON_SALE', 'Tickets for this event are not on sale', 409, {
      event: event.title,
      state,
    });
  }

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
        }),
      );
      await afterOrderCreated(ctx, sessionId, quote, created);
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

interface CreateContext {
  params: PlaceOrderParams;
  quote: CheckoutQuote;
  eventRows: Awaited<ReturnType<typeof quoteForMethod>>['events'];
  configs: Map<string, Awaited<ReturnType<typeof effectiveCheckoutConfig>>>;
  codeIds: Map<string, string>;
  ownerChecks: { eventId: string; companionSeatId: string; partners: string[] }[];
}

type CreatedOrder = Omit<PlacedOrder, 'accessToken' | 'locale'> & {
  gaByEvent: Map<string, Record<string, number>>;
  /** Confirmation e-mail stored in the same transaction (outbox), dispatched after commit. */
  emailMessageId: string | null;
};

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
  const gaByEvent = new Map<string, Record<string, number>>();
  for (const quoted of c.quote.events) {
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

  // Payment terms.
  const [general, invoicing, bank] = await Promise.all([
    getSetting(ctx, 'general'),
    getSetting(ctx, 'invoicing'),
    getSetting(ctx, 'bankTransfer'),
  ]);
  const timeZone = general.defaultTimeZone;
  const eventList = [...c.eventRows.values()];
  const firstEventStart = Math.min(...eventList.map((e) => e.startsAt.getTime()));
  // Vorkasse terms: event override ?? global; a multi-event order uses the strictest value.
  const strictest = (pick: (e: (typeof eventList)[number]) => number | null, global: number) =>
    Math.min(...eventList.map((e) => pick(e) ?? global));
  const termDays = strictest((e) => e.bankTransferPaymentTermDays, bank.paymentTermDays);
  const reminderDays = strictest((e) => e.bankTransferReminderAfterDays, bank.reminderAfterDays);
  const cancelDays = resolveCancelDays(eventList, bank.cancelAfterDays, termDays);
  const capAtEvent = (d: Date) => new Date(Math.min(d.getTime(), firstEventStart));
  const isBankTransfer = input.method === 'BANK_TRANSFER';
  const dayOptions = {
    businessDaysOnly: bank.countBusinessDaysOnly,
    state: bank.holidayRegion,
    timeZone,
  };
  let paymentReference: string | null = null;
  let paymentDueAt: Date | null = null;
  let nextReminderAt: Date | null = null;
  let autoCancelAt: Date | null = null;
  if (isBankTransfer) {
    const year = Number(new Intl.DateTimeFormat('en', { timeZone, year: 'numeric' }).format(now));
    paymentReference = buildPaymentReference(
      bank.paymentReferencePrefix,
      year,
      String(randomInt(10 ** (REFERENCE_DIGITS - 1), 10 ** REFERENCE_DIGITS)),
    );
    paymentDueAt = capAtEvent(endOfDayInZone(addPaymentDays(now, termDays, dayOptions), timeZone));
    if (cancelDays !== null) {
      autoCancelAt = capAtEvent(
        endOfDayInZone(addPaymentDays(now, cancelDays, dayOptions), timeZone),
      );
    }
    // Reminder on the morning after day X (end of day X + 9 h ≈ 09:00 local time). It must fall
    // before the auto-cancel (if any) or, without auto-cancel, before the event starts.
    const reminder = new Date(
      endOfDayInZone(addPaymentDays(now, reminderDays, dayOptions), timeZone).getTime() +
        9 * 3600_000,
    );
    nextReminderAt = reminder < (autoCancelAt ?? new Date(firstEventStart)) ? reminder : null;
  }
  const free = c.quote.totalGross === 0;
  const status: OrderStatus = free ? 'PAID' : isBankTransfer ? 'AWAITING_PAYMENT' : 'PENDING';
  const itemStatus = free ? 'CONFIRMED' : 'PENDING';

  // Gapless order number – allocated last so the counter row lock is held only briefly.
  const orderNumber = await nextNumber(tx, 'order', invoicing.orderNumberPattern, now, timeZone);
  const [order] = await tx
    .insert(orders)
    .values({
      orderNumber,
      customerId,
      status,
      channel: 'ONLINE',
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
 * company of a customer account are never overwritten by checkout input. A newly entered
 * phone / address wins (the invoice needs them) but stored values are never blanked out.
 */
async function upsertCustomer(tx: Transaction, input: CheckoutInput): Promise<string> {
  const address = input.address ? JSON.stringify(input.address) : null;
  const result = await tx.execute<{ id: string }>(sql`
    INSERT INTO ${customers} (email, first_name, last_name, company, phone, address, locale)
    VALUES (${input.email}, ${input.firstName}, ${input.lastName}, ${input.company ?? null},
            ${input.phone ?? null}, ${address}::jsonb, ${input.locale})
    ON CONFLICT ((lower(email))) DO UPDATE SET
      first_name = CASE WHEN ${customers.passwordHash} IS NULL THEN EXCLUDED.first_name ELSE ${customers.firstName} END,
      last_name  = CASE WHEN ${customers.passwordHash} IS NULL THEN EXCLUDED.last_name ELSE ${customers.lastName} END,
      company    = CASE WHEN ${customers.passwordHash} IS NULL THEN EXCLUDED.company ELSE ${customers.company} END,
      phone      = COALESCE(EXCLUDED.phone, ${customers.phone}),
      address    = COALESCE(EXCLUDED.address, ${customers.address}),
      locale     = EXCLUDED.locale,
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
      console.error('[checkout] confirmation e-mail could not be queued', err);
    }
  }
}
