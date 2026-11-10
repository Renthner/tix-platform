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
  discountAmount: number;
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
  discountTotal: number;
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
}

async function loadPricingContext(
  ctx: CoreContext,
  sessionId: string,
  locale?: string,
): Promise<PricingContext> {
  return loadPricingContextForCart(ctx, await getCart(ctx, sessionId, locale), 'ONLINE', locale);
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
          ? await getPublicSeatMap(ctx, row)
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
    feeTotal,
    totalGross: subtotalGross - discountTotal + feeTotal,
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
): Promise<{ quotes: Record<OnlinePaymentMethod, CheckoutQuote>; methods: PaymentMethodOption[] }> {
  const pc = await loadPricingContext(ctx, sessionId, locale);
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
): Promise<{
  quote: CheckoutQuote;
  events: PricingContext['eventRows'];
  maps: PricingContext['maps'];
}> {
  const pc = await loadPricingContext(ctx, sessionId, locale);
  const availability = await paymentAvailability(ctx, pc);
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
  return { quote: buildQuote(pc, method), events: pc.eventRows, maps: pc.maps };
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
