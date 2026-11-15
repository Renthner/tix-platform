import { bankAccounts, events, fees, taxRates, venues } from '@tix/db';
import {
  ONLINE_PAYMENT_METHODS,
  splitGross,
  type FeeScope,
  type OnlinePaymentMethod,
  type PaymentMethod,
  localizePublicSeatMap,
  localized,
  type PublicSeatMap,
  type SalesChannel,
} from '@tix/shared';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { getCart, type CartView } from '../cart';
import { DomainError, type CoreContext } from '../context';
import {
  discountUsageCounts,
  getSessionDiscountCodes,
  loadDiscountCodeRows,
  planDiscounts,
  type DiscountCodeRow,
  type QuoteDiscount,
  type RejectedDiscount,
} from '../discounts/plan';
import { isDraftEvent } from '../shop-actor';
import type { EventRow } from '../events';
import { contentLocale } from '../content-locale';
import { getPublicSeatMap, getSeatMapForChannel } from '../seatmaps/public';
import { getSecretSetting, getSetting } from '../settings';

export interface QuoteItem {
  eventId: string;
  /** Cart item key (seat id, or `ga:<section>:<index>`). */
  key: string;
  kind: 'SEAT' | 'GENERAL_ADMISSION';
  seatId: string | null;
  sectionId: string;
  /** Full block label (snapshot; printing honours the block's show-label flag). */
  sectionLabel: string;
  rowLabel: string | null;
  seatLabel: string | null;
  categoryId: string;
  categoryName: string;
  ticketTypeId: string;
  ticketTypeName: string;
  requiresProofAtEntry: boolean;
  /** List price of the category (before the tariff reduction). */
  unitPriceGross: number;
  /** Tariff reduction (list price minus tariff price). */
  discountAmount: number;
  /** Share of discount codes (already deducted from `priceGross`). */
  codeDiscount: number;
  /** Codes behind `codeDiscount`. */
  codeDiscountCodes: string[];
  /** What the customer pays for the ticket: list price - tariff reduction - code share. */
  priceGross: number;
  taxRateBasisPoints: number;
  priceNet: number;
  taxAmount: number;
}

export interface QuoteFee {
  /** null for PER_ORDER fees. */
  eventId: string | null;
  feeId: string;
  name: string;
  scope: FeeScope;
  quantity: number;
  unitAmountGross: number;
  totalGross: number;
  taxRateBasisPoints: number;
  totalNet: number;
  totalTax: number;
  /** Share of discount codes already deducted from `totalGross`. */
  codeDiscountAmount: number;
}

export interface QuoteEvent {
  eventId: string;
  slug: string;
  title: string;
  startsAt: string;
  timeZone: string;
  venueName: string;
  items: QuoteItem[];
  fees: QuoteFee[];
  /** Σ item prices (after tariff reductions). */
  ticketsGross: number;
}

export interface CheckoutQuote {
  method: PaymentMethod;
  currency: string;
  events: QuoteEvent[];
  orderFees: QuoteFee[];
  subtotalGross: number;
  /** Tariff reductions. */
  discountTotal: number;
  /** Discount codes, ticket share (the fee share sits in `fees[].codeDiscountAmount`). */
  codeDiscountTotal: number;
  /** Discount codes that reduce this quote (stored with the order). */
  discounts: QuoteDiscount[];
  /** Codes of the cart that do not apply (shown to the customer, refused at checkout). */
  rejectedCodes: RejectedDiscount[];
  feeTotal: number;
  totalGross: number;
  totalNet: number;
  totalTax: number;
  ticketCount: number;
}

export interface PaymentMethodOption {
  method: OnlinePaymentMethod;
  available: boolean;
  /** Why the method is not offered (stable code, translated in the UI). */
  reason?: 'DISABLED' | 'NOT_CONFIGURED' | 'TOO_CLOSE_TO_EVENT' | 'EVENT_DISABLED';
  totalGross: number;
  feeTotal: number;
}

interface PricingContext {
  cart: CartView;
  eventRows: Map<string, EventRow & { venueName: string; taxRateBasisPoints: number }>;
  maps: Map<string, PublicSeatMap>;
  feeRows: (typeof fees.$inferSelect)[];
  taxRateById: Map<string, number>;
  /** Discount codes of the cart session (online shop only). */
  discount: {
    codes: string[];
    rows: Map<string, DiscountCodeRow>;
    usage: Awaited<ReturnType<typeof discountUsageCounts>>;
    hasEmail: boolean;
  } | null;
}

export interface QuoteOptions {
  /** Buyer e-mail when known (checkout): enables the per-customer usage limit. */
  email?: string | null;
  /** Checkout: orders created from this cart session do not count as code usage (re-submit). */
  excludeCartSessionId?: string | null;
  /** Evaluate these codes instead of the ones stored in the cart session (apply preview). */
  codes?: string[];
}

async function loadPricingContext(
  ctx: CoreContext,
  sessionId: string,
  locale?: string,
  options: QuoteOptions = {},
): Promise<PricingContext> {
  const pc = await loadPricingContextForCart(
    ctx,
    await getCart(ctx, sessionId, locale),
    'ONLINE',
    locale,
  );
  const codes = options.codes ?? (await getSessionDiscountCodes(ctx, sessionId));
  if (codes.length > 0) {
    const rows = await loadDiscountCodeRows(ctx.db, codes);
    const usage = await discountUsageCounts(
      ctx.db,
      [...rows.values()].map((r) => r.id),
      options.email ?? null,
      options.excludeCartSessionId ?? null,
    );
    pc.discount = { codes, rows, usage, hasEmail: Boolean(options.email) };
  }
  return pc;
}

async function loadPricingContextForCart(
  ctx: CoreContext,
  cart: CartView,
  channel: SalesChannel,
  locale?: string,
): Promise<PricingContext> {
  const { locale: loc, defaultLocale } = await contentLocale(ctx, locale);
  if (cart.itemCount === 0) throw new DomainError('CART_EMPTY', 'Your cart is empty', 409);
  if (cart.currencies.length > 1) {
    throw new DomainError('MIXED_CURRENCIES', 'Events with different currencies', 409);
  }
  const eventIds = cart.events.map((e) => e.eventId);
  const rows = await ctx.db
    .select({ event: events, venue: venues, rate: taxRates.rateBasisPoints })
    .from(events)
    .innerJoin(venues, eq(venues.id, events.venueId))
    .innerJoin(taxRates, eq(taxRates.id, events.taxRateId))
    .where(inArray(events.id, eventIds));
  const eventRows = new Map(
    rows.map((r) => [
      r.event.id,
      {
        ...r.event,
        title: localized(r.event, 'title', loc, defaultLocale),
        venueName: localized(r.venue, 'name', loc, defaultLocale),
        taxRateBasisPoints: r.rate,
      },
    ]),
  );
  const maps = new Map<string, PublicSeatMap>();
  for (const row of eventRows.values()) {
    maps.set(
      row.id,
      localizePublicSeatMap(
        channel === 'ONLINE'
          ? await getPublicSeatMap(ctx, row, { fresh: true })
          : await getSeatMapForChannel(ctx, row, channel),
        loc,
        defaultLocale,
      ),
    );
  }
  const feeRows = await ctx.db
    .select()
    .from(fees)
    .where(or(isNull(fees.eventId), inArray(fees.eventId, eventIds)));
  for (const fee of feeRows) fee.name = localized(fee, 'name', loc, defaultLocale);
  const rateRows = await ctx.db
    .select({ id: taxRates.id, rate: taxRates.rateBasisPoints })
    .from(taxRates);
  return {
    cart,
    eventRows,
    maps,
    feeRows,
    taxRateById: new Map(rateRows.map((r) => [r.id, r.rate])),
    discount: null,
  };
}

/** Fees effective for an event: global ones (minus waived / replaced) + event-only fees. */
function effectiveEventFees(
  feeRows: PricingContext['feeRows'],
  eventId: string,
  method: PaymentMethod,
  channel: SalesChannel,
): PricingContext['feeRows'] {
  const applies = (f: PricingContext['feeRows'][number]) =>
    f.isActive &&
    feeChannels(f).includes(channel) &&
    (!f.paymentMethods || f.paymentMethods.includes(method));
  const overrides = new Map(
    feeRows
      .filter((f) => f.eventId === eventId && f.overridesFeeId)
      .map((f) => [f.overridesFeeId!, f]),
  );
  const result: PricingContext['feeRows'] = [];
  for (const global of feeRows.filter((f) => f.eventId === null && f.scope !== 'PER_ORDER')) {
    const override = overrides.get(global.id);
    const effective = override ?? global;
    if (applies(effective)) result.push(effective);
  }
  for (const own of feeRows.filter((f) => f.eventId === eventId && !f.overridesFeeId)) {
    if (applies(own)) result.push(own);
  }
  return result.sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Fees without a channel restriction are charged online only; the box office needs an explicit tick. */
function feeChannels(fee: { channels: SalesChannel[] | null }): readonly SalesChannel[] {
  return fee.channels?.length ? fee.channels : ['ONLINE'];
}

const percentOf = (amount: number, basisPoints: number) =>
  Math.round((amount * basisPoints) / 10_000);

function feeLine(
  fee: PricingContext['feeRows'][number],
  eventId: string | null,
  quantity: number,
  unitAmountGross: number,
  totalGross: number,
  taxRateBasisPoints: number,
): QuoteFee {
  const split = splitGross(totalGross, taxRateBasisPoints);
  return {
    eventId,
    feeId: fee.id,
    name: fee.name,
    scope: fee.scope,
    quantity,
    unitAmountGross,
    totalGross,
    taxRateBasisPoints,
    totalNet: split.net,
    totalTax: split.tax,
    codeDiscountAmount: 0,
  };
}

function buildQuote(
  pc: PricingContext,
  method: PaymentMethod,
  channel: SalesChannel = 'ONLINE',
): CheckoutQuote {
  const quoteEvents: QuoteEvent[] = [];
  for (const cartEvent of pc.cart.events) {
    const event = pc.eventRows.get(cartEvent.eventId);
    const map = pc.maps.get(cartEvent.eventId);
    if (!event || !map) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
    const categories = new Map(map.categories.map((c) => [c.id, c]));
    const sections = new Map(map.sections.map((s) => [s.id, s]));
    const tariffs = new Map(map.ticketTypes.map((t) => [t.id, t]));
    const rate = event.taxRateBasisPoints;
    const items: QuoteItem[] = cartEvent.items.map((item) => {
      const category = categories.get(item.categoryId);
      const tariff = tariffs.get(item.ticketTypeId);
      const section = sections.get(item.sectionId);
      if (!category || !tariff || !section) {
        throw new DomainError('CART_OUTDATED', 'Your cart changed, please review it', 409);
      }
      const priceGross = item.priceGross;
      const unitPriceGross = Math.max(category.basePrice, priceGross);
      const split = splitGross(priceGross, rate);
      return {
        eventId: event.id,
        key: item.key,
        kind: item.kind,
        seatId: item.seatId,
        sectionId: item.sectionId,
        sectionLabel: section.ticketLabel || section.name,
        rowLabel: item.rowLabel,
        seatLabel: item.seatLabel,
        categoryId: category.id,
        categoryName: category.name,
        ticketTypeId: tariff.id,
        ticketTypeName: tariff.name,
        requiresProofAtEntry: tariff.requiresProofAtEntry,
        unitPriceGross,
        discountAmount: unitPriceGross - priceGross,
        codeDiscount: 0,
        codeDiscountCodes: [],
        priceGross,
        taxRateBasisPoints: rate,
        priceNet: split.net,
        taxAmount: split.tax,
      };
    });
    const ticketsGross = items.reduce((sum, i) => sum + i.priceGross, 0);
    const eventFees: QuoteFee[] = [];
    for (const fee of effectiveEventFees(pc.feeRows, event.id, method, channel)) {
      const feeRate = fee.taxRateId ? (pc.taxRateById.get(fee.taxRateId) ?? rate) : rate;
      if (fee.scope === 'PER_TICKET') {
        const amounts = items.map((i) =>
          fee.calculation === 'FIXED' ? fee.value : percentOf(i.priceGross, fee.value),
        );
        const total = amounts.reduce((a, b) => a + b, 0);
        if (total > 0)
          eventFees.push(
            feeLine(fee, event.id, items.length, Math.round(total / items.length), total, feeRate),
          );
      } else {
        const total = fee.calculation === 'FIXED' ? fee.value : percentOf(ticketsGross, fee.value);
        if (total > 0) eventFees.push(feeLine(fee, event.id, 1, total, total, feeRate));
      }
    }
    quoteEvents.push({
      eventId: event.id,
      slug: event.slug,
      title: event.title,
      startsAt: event.startsAt.toISOString(),
      timeZone: event.timeZone,
      venueName: event.venueName,
      items,
      fees: eventFees,
      ticketsGross,
    });
  }

  const allItems = quoteEvents.flatMap((e) => e.items);
  const ticketsTotal = allItems.reduce((sum, i) => sum + i.priceGross, 0);
  const orderFees: QuoteFee[] = [];
  for (const fee of pc.feeRows
    .filter((f) => f.eventId === null && f.scope === 'PER_ORDER' && f.isActive)
    .filter((f) => feeChannels(f).includes(channel))
    .filter((f) => !f.paymentMethods || f.paymentMethods.includes(method))
    .sort((a, b) => a.sortOrder - b.sortOrder)) {
    const rate = pc.taxRateById.get(fee.taxRateId!) ?? 0;
    const total = fee.calculation === 'FIXED' ? fee.value : percentOf(ticketsTotal, fee.value);
    if (total > 0) orderFees.push(feeLine(fee, null, 1, total, total, rate));
  }
  const allFees = [...quoteEvents.flatMap((e) => e.fees), ...orderFees];

  // Discount codes: allocated over tickets (and optionally fee lines) per line with the largest
  // remainder method; every line then re-splits its reduced gross price into net and tax, so the
  // VAT per rate stays exact (see `applyDiscountRules` in @tix/shared).
  let discounts: QuoteDiscount[] = [];
  let rejectedCodes: RejectedDiscount[] = [];
  if (pc.discount) {
    const plan = planDiscounts({
      codes: pc.discount.codes,
      rows: pc.discount.rows,
      now: new Date(),
      usage: pc.discount.usage,
      hasEmail: pc.discount.hasEmail,
      isTest: [...pc.eventRows.values()].every(isDraftEvent),
      lines: [
        ...allItems.map((i) => ({
          kind: 'item' as const,
          eventId: i.eventId,
          categoryId: i.categoryId,
          ticketTypeId: i.ticketTypeId,
          gross: i.priceGross,
        })),
        ...allFees.map((f) => ({
          kind: 'fee' as const,
          eventId: f.eventId,
          categoryId: null,
          ticketTypeId: null,
          gross: f.totalGross,
        })),
      ],
    });
    discounts = plan.applied;
    rejectedCodes = plan.rejected;
    allItems.forEach((item, index) => {
      const part = plan.perLine[index] ?? 0;
      if (part === 0) return;
      item.codeDiscount = part;
      item.codeDiscountCodes = plan.perLineCodes[index] ?? [];
      item.priceGross -= part;
      const split = splitGross(item.priceGross, item.taxRateBasisPoints);
      item.priceNet = split.net;
      item.taxAmount = split.tax;
    });
    allFees.forEach((fee, index) => {
      const part = plan.perLine[allItems.length + index] ?? 0;
      if (part === 0) return;
      fee.codeDiscountAmount = part;
      fee.totalGross -= part;
      fee.unitAmountGross =
        fee.quantity > 1 ? Math.round(fee.totalGross / fee.quantity) : fee.totalGross;
      const split = splitGross(fee.totalGross, fee.taxRateBasisPoints);
      fee.totalNet = split.net;
      fee.totalTax = split.tax;
    });
    for (const event of quoteEvents) {
      event.ticketsGross = event.items.reduce((sum, i) => sum + i.priceGross, 0);
    }
  }
  const codeDiscountTotal = allItems.reduce((sum, i) => sum + i.codeDiscount, 0);
  const subtotalGross = allItems.reduce((sum, i) => sum + i.unitPriceGross, 0);
  const discountTotal = allItems.reduce((sum, i) => sum + i.discountAmount, 0);
  const feeTotal = allFees.reduce((sum, f) => sum + f.totalGross, 0);
  const totalNet =
    allItems.reduce((sum, i) => sum + i.priceNet, 0) + allFees.reduce((s, f) => s + f.totalNet, 0);
  const totalTax =
    allItems.reduce((sum, i) => sum + i.taxAmount, 0) + allFees.reduce((s, f) => s + f.totalTax, 0);
  return {
    method,
    currency: pc.cart.currencies[0] ?? 'EUR',
    events: quoteEvents,
    orderFees,
    subtotalGross,
    discountTotal,
    codeDiscountTotal,
    discounts,
    rejectedCodes,
    feeTotal,
    totalGross: subtotalGross - discountTotal - codeDiscountTotal + feeTotal,
    totalNet,
    totalTax,
    ticketCount: allItems.length,
  };
}

/** Availability of the online payment methods for the events in the cart. */
async function paymentAvailability(
  ctx: CoreContext,
  pc: PricingContext,
): Promise<Record<OnlinePaymentMethod, PaymentMethodOption['reason'] | null>> {
  return paymentAvailabilityForEvents(ctx, [...pc.eventRows.values()]);
}

/** Same rules for any set of events (cart or an existing order, e.g. an additional payment). */
export async function paymentAvailabilityForEvents(
  ctx: CoreContext,
  rows: readonly Pick<
    EventRow,
    'startsAt' | 'bankTransferEnabled' | 'bankTransferDisableDaysBeforeEvent' | 'paypalEnabled'
  >[],
): Promise<Record<OnlinePaymentMethod, PaymentMethodOption['reason'] | null>> {
  const [bank, paypal, credentials, defaultAccount] = await Promise.all([
    getSetting(ctx, 'bankTransfer'),
    getSetting(ctx, 'paypal'),
    getSecretSetting(ctx, 'paypal.credentials').catch(() => null),
    ctx.db
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.isDefaultForBankTransfer, true), eq(bankAccounts.isActive, true)))
      .limit(1),
  ]);
  const now = Date.now();
  let bankReason: PaymentMethodOption['reason'] | null = null;
  if (rows.some((e) => e.bankTransferEnabled === false)) bankReason = 'EVENT_DISABLED';
  else if (!bank.enabled && !rows.every((e) => e.bankTransferEnabled === true))
    bankReason = 'DISABLED';
  else if (defaultAccount.length === 0) bankReason = 'NOT_CONFIGURED';
  else if (
    rows.some(
      (e) =>
        e.startsAt.getTime() - now <
        (e.bankTransferDisableDaysBeforeEvent ?? bank.disableDaysBeforeEvent) * 86_400_000,
    )
  ) {
    bankReason = 'TOO_CLOSE_TO_EVENT';
  }
  let paypalReason: PaymentMethodOption['reason'] | null = null;
  if (rows.some((e) => e.paypalEnabled === false)) paypalReason = 'EVENT_DISABLED';
  else if (!paypal.enabled && !rows.every((e) => e.paypalEnabled === true))
    paypalReason = 'DISABLED';
  else if (!paypal.clientId || !credentials?.clientSecret) paypalReason = 'NOT_CONFIGURED';
  return { BANK_TRANSFER: bankReason, PAYPAL: paypalReason };
}

/** Prices of the current cart for every online payment method plus their availability. */
export async function getCheckoutOptions(
  ctx: CoreContext,
  sessionId: string,
  locale?: string,
  options: QuoteOptions = {},
): Promise<{ quotes: Record<OnlinePaymentMethod, CheckoutQuote>; methods: PaymentMethodOption[] }> {
  const pc = await loadPricingContext(ctx, sessionId, locale, options);
  const availability = await paymentAvailability(ctx, pc);
  const quotes = {
    PAYPAL: buildQuote(pc, 'PAYPAL'),
    BANK_TRANSFER: buildQuote(pc, 'BANK_TRANSFER'),
  };
  const methods = ONLINE_PAYMENT_METHODS.map((method) => ({
    method,
    available: availability[method] === null,
    ...(availability[method] ? { reason: availability[method]! } : {}),
    totalGross: quotes[method].totalGross,
    feeTotal: quotes[method].feeTotal,
  }));
  return { quotes, methods };
}

/** Quote for one method; throws when the method is not available for this cart. */
export async function quoteForMethod(
  ctx: CoreContext,
  sessionId: string,
  method: OnlinePaymentMethod,
  locale?: string,
  options: QuoteOptions = {},
): Promise<{
  quote: CheckoutQuote;
  events: PricingContext['eventRows'];
  maps: PricingContext['maps'];
}> {
  const pc = await loadPricingContext(ctx, sessionId, locale, options);
  const quote = buildQuote(pc, method);
  // An order that costs nothing (free tickets, 100 % discount) needs no payment method.
  const availability =
    quote.totalGross === 0
      ? { PAYPAL: null, BANK_TRANSFER: null }
      : await paymentAvailability(ctx, pc);
  if (availability[method] !== null) {
    throw new DomainError(
      'PAYMENT_METHOD_UNAVAILABLE',
      'This payment method is not available',
      409,
      {
        reason: availability[method],
      },
    );
  }
  return { quote, events: pc.eventRows, maps: pc.maps };
}

/**
 * Prices of a box-office / admin order built from explicit lines (no Redis cart): tariffs of
 * the sales channel, fees of that channel. Complimentary orders carry no fees.
 */
export async function quoteChannelCart(
  ctx: CoreContext,
  cart: CartView,
  method: PaymentMethod,
  channel: SalesChannel,
  locale?: string,
): Promise<{
  quote: CheckoutQuote;
  events: PricingContext['eventRows'];
  maps: PricingContext['maps'];
}> {
  const pc = await loadPricingContextForCart(ctx, cart, channel, locale);
  if (method === 'COMPLIMENTARY') pc.feeRows = [];
  return { quote: buildQuote(pc, method, channel), events: pc.eventRows, maps: pc.maps };
}

export interface CartDiscountPreview {
  codes: string[];
  applied: QuoteDiscount[];
  rejected: RejectedDiscount[];
  /** Σ discount of all applied codes (tickets and discounted fees). */
  total: number;
  currency: string;
}

/**
 * Discount codes of the cart session and what they take off right now (cart page and checkout:
 * the discount line, rejected codes). Cheap when no code was entered.
 */
export async function previewCartDiscounts(
  ctx: CoreContext,
  sessionId: string,
  locale?: string,
  options: QuoteOptions = {},
): Promise<CartDiscountPreview> {
  const codes = options.codes ?? (await getSessionDiscountCodes(ctx, sessionId));
  const empty = { codes, applied: [], rejected: [], total: 0, currency: 'EUR' };
  if (codes.length === 0) return empty;
  let pc: PricingContext;
  try {
    pc = await loadPricingContext(ctx, sessionId, locale, { ...options, codes });
  } catch (err) {
    // Empty / outdated cart: nothing to discount (the cart page shows its own state).
    if (err instanceof DomainError && ['CART_EMPTY', 'MIXED_CURRENCIES'].includes(err.code)) {
      return empty;
    }
    throw err;
  }
  const quote = buildQuote(pc, 'BANK_TRANSFER');
  return {
    codes,
    applied: quote.discounts,
    rejected: quote.rejectedCodes,
    total: quote.discounts.reduce((sum, d) => sum + d.amount, 0),
    currency: quote.currency,
  };
}
