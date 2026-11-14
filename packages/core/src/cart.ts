import { accessCodes, events, venues } from '@tix/db';
import {
  MAX_SEATS_PER_REQUEST,
  type BestAvailableArrangement,
  SEAT_FLAG,
  findBestAvailable,
  findOrphanSeats,
  localizePublicSeatMap,
  localized,
  checkCompanionSeats,
  type EventAvailability,
  type PublicSeat,
  type PublicSeatMap,
  type PublicTicketType,
  type RowSeat,
} from '@tix/shared';
import { eq, inArray } from 'drizzle-orm';
import { DomainError, type CoreContext } from './context';
import { effectiveCheckoutConfig, getEventCached, type EventRow } from './events';
import { ensureInventory } from './inventory';
import { publishSeatDelta } from './realtime';
import { contentLocale } from './content-locale';
import { getPublicSeatMap } from './seatmaps/public';
import { getSetting } from './settings';

/**
 * Multi-event cart of one browser session.
 *
 * Redis hash `cart:<sid>`:
 *   exp                     cart expiry (epoch ms) shared by all locks of the session
 *   ev:<eventId>            event is part of the cart
 *   tt:<eventId>:<seatId>   tariff (ticket type) chosen for a seat
 *   ga:<eventId>:<section>  JSON array of tariffs, one per held standing spot
 */

const CART_RETENTION_MS = 60 * 60 * 1000;
const BEST_AVAILABLE_ATTEMPTS = 5;
/** Below this remaining cart lifetime (maxCartLifetimeMinutes) no further seats can be added. */
const MIN_REMAINING_LIFETIME_MS = 30_000;

export interface CartItemView {
  key: string;
  kind: 'SEAT' | 'GENERAL_ADMISSION';
  seatId: string | null;
  sectionId: string;
  /** Block label as printed on the ticket; null when the block hides it (show_label_on_ticket). */
  sectionLabel: string | null;
  rowLabel: string | null;
  seatLabel: string | null;
  categoryId: string;
  categoryName: string;
  categoryColor: string;
  ticketTypeId: string;
  priceGross: number;
  allowedTicketTypeIds: string[];
}

export interface CartEventView {
  eventId: string;
  slug: string;
  title: string;
  startsAt: string;
  timeZone: string;
  venueName: string;
  currency: string;
  orphanSeatRuleEnabled: boolean;
  ticketTypes: PublicTicketType[];
  items: CartItemView[];
  subtotalGross: number;
}

export interface CartView {
  expiresAt: number | null;
  events: CartEventView[];
  itemCount: number;
  totalGross: number;
  /** Set when events with different currencies are mixed (checkout requires one). */
  currencies: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const seatField = (eventId: string, seatId: string) => `tt:${eventId}:${seatId}`;
const gaField = (eventId: string, sectionId: string) => `ga:${eventId}:${sectionId}`;
const eventField = (eventId: string) => `ev:${eventId}`;

export function allowedTypesFor(
  map: PublicSeatMap,
  categoryId: string,
  seatFlags: number | null,
): PublicTicketType[] {
  return map.ticketTypes.filter((t) => {
    if (t.prices[categoryId] === undefined) return false;
    if (t.requiredSeatFeature === 'WHEELCHAIR_SPACE')
      return seatFlags !== null && (seatFlags & SEAT_FLAG.WHEELCHAIR) !== 0;
    if (t.requiredSeatFeature === 'COMPANION_SEAT')
      return seatFlags !== null && (seatFlags & SEAT_FLAG.COMPANION) !== 0;
    return true;
  });
}

function defaultTypeFor(
  map: PublicSeatMap,
  categoryId: string,
  seatFlags: number | null,
): PublicTicketType | null {
  const allowed = allowedTypesFor(map, categoryId, seatFlags);
  // Feature-bound tariffs (wheelchair / companion) are the natural default on such seats.
  const featured = allowed.find((t) => t.requiredSeatFeature !== null);
  return featured ?? allowed.find((t) => t.isDefault) ?? allowed[0] ?? null;
}

export function seatIndex(map: PublicSeatMap): Map<string, PublicSeat> {
  return new Map(map.seats.map((s) => [s.i, s]));
}

async function cartExpiry(ctx: CoreContext, sessionId: string): Promise<number | null> {
  const exp = await ctx.redis.hget(ctx.keys.cart(sessionId), 'exp');
  return exp ? Number(exp) : null;
}

/** Returns a valid cart expiry, starting a new cart when none exists or it expired. */
/**
 * Expiry for seats that are about to be added: the reservation time RESTARTS with every newly
 * selected seat / standing spot (removing seats does not). An already expired cart is
 * discarded first. The cart itself is only updated once the new seats are locked
 * (`restartCartTimer`), so a failed selection leaves the running timer untouched.
 */
async function freshCartExpiry(
  ctx: CoreContext,
  sessionId: string,
  ttlSeconds: number,
): Promise<number> {
  const now = Date.now();
  let current = await cartExpiry(ctx, sessionId);
  if (current && current <= now + 1_000) {
    await discardCart(ctx, sessionId);
    current = null;
  }
  const proposed = now + ttlSeconds * 1000;
  const lifetimeMs = await cartLifetimeMs(ctx);
  if (lifetimeMs === null) return proposed;
  const key = ctx.keys.cart(sessionId);
  // No live timer: a cart that expired was discarded above; this also drops the leftover of a
  // selection that failed before locking anything. Removing single seats keeps the lifetime
  // running (otherwise removing and re-adding seats would circumvent the limit); emptying the
  // whole cart (`discardCart`, DELETE /api/cart) does start a new lifetime – acceptable, because
  // all seats are released immediately.
  if (current === null) await ctx.redis.hdel(key, 'first');
  // Written here (not when the seats are locked) so the cap stays exactly the same afterwards.
  await ctx.redis.hsetnx(key, 'first', String(now));
  // A failed selection must not leave a hash without expiry behind.
  await ctx.redis.pexpire(key, ttlSeconds * 1000 + CART_RETENTION_MS, 'NX');
  const first = Number(await ctx.redis.hget(key, 'first'));
  // Practically at the end of the cart lifetime: adding seats would only hand out a reservation
  // that expires within seconds.
  if (first + lifetimeMs - now < MIN_REMAINING_LIFETIME_MS) {
    throw new DomainError(
      'CART_LIFETIME_REACHED',
      'The cart lifetime is almost over – complete the order or empty the cart',
      409,
    );
  }
  // Never shorten what the cart already holds (e.g. after the payment grace period).
  return Math.max(current ?? 0, Math.min(proposed, first + lifetimeMs));
}

/** Maximum total cart lifetime in milliseconds; null = not limited. */
async function cartLifetimeMs(ctx: CoreContext): Promise<number | null> {
  const { maxCartLifetimeMinutes } = await getSetting(ctx, 'checkout');
  return maxCartLifetimeMinutes ? maxCartLifetimeMinutes * 60_000 : null;
}

/** Moves the whole cart (all events, seats and standing spots) to a new expiry. */
async function setCartExpiry(ctx: CoreContext, sessionId: string, exp: number): Promise<void> {
  const key = ctx.keys.cart(sessionId);
  await ctx.redis
    .multi()
    .hset(key, 'exp', String(exp))
    .pexpireat(key, exp + CART_RETENTION_MS)
    .exec();
  for (const eventId of await cartEventIds(ctx, sessionId)) {
    await ctx.seats.extendCart(eventId, sessionId, exp);
  }
}

/** New seats were added: restart the timer and re-arm the payment grace period. */
async function restartCartTimer(ctx: CoreContext, sessionId: string, exp: number): Promise<void> {
  const key = ctx.keys.cart(sessionId);
  const before = await cartExpiry(ctx, sessionId);
  // With a lifetime limit the grace period is only re-armed when the timer really moved on,
  // otherwise adding seats at the limit would hand out another grace extension each time.
  if ((await cartLifetimeMs(ctx)) === null || before === null || exp > before) {
    await ctx.redis.hdel(key, 'grace');
  }
  // Last time seats were added: lets the checkout recognise a re-submit of an already ordered cart.
  await ctx.redis.hset(ctx.keys.cart(sessionId), 'changed', String(Date.now()));
  await setCartExpiry(ctx, sessionId, exp);
}

/**
 * Two-stage lock TTL: when the customer enters the checkout, the whole cart is extended ONCE
 * by the payment grace period (largest `paymentGraceSeconds` of the events in the cart), so
 * seats never run out while the buyer fills in the form or pays. Adding seats afterwards
 * restarts the normal timer and re-arms the grace period. Returns the (new) expiry.
 */
export async function extendCartForCheckout(
  ctx: CoreContext,
  sessionId: string,
): Promise<number | null> {
  const key = ctx.keys.cart(sessionId);
  const current = await cartExpiry(ctx, sessionId);
  if (!current || current <= Date.now()) return null;
  const eventIds = await cartEventIds(ctx, sessionId);
  if (eventIds.length === 0) return current;
  // HSETNX makes the extension one-shot, also for parallel requests.
  if (!(await ctx.redis.hsetnx(key, 'grace', '1'))) return current;
  const graceSeconds = await cartGraceSeconds(ctx, sessionId);
  if (graceSeconds === 0) return current;
  const next = current + graceSeconds * 1000;
  await setCartExpiry(ctx, sessionId, next);
  return next;
}

/** Payment grace period of the cart: the largest effective value of its events (seconds). */
export async function cartGraceSeconds(ctx: CoreContext, sessionId: string): Promise<number> {
  let graceSeconds = 0;
  for (const eventId of await cartEventIds(ctx, sessionId)) {
    const config = await effectiveCheckoutConfig(ctx, await getEventCached(ctx, eventId));
    graceSeconds = Math.max(graceSeconds, config.paymentGraceSeconds);
  }
  return graceSeconds;
}

/** Keeps all locks of the cart alive at least until `until` (order creation in progress). */
export async function holdCartUntil(
  ctx: CoreContext,
  sessionId: string,
  until: number,
): Promise<void> {
  const current = await cartExpiry(ctx, sessionId);
  if (current && current < until) await setCartExpiry(ctx, sessionId, until);
}

/**
 * Forgets the cart after its seats became an order. The seat locks were already turned into
 * reservations by the checkout, so nothing is released or broadcast here.
 */
export async function clearCartAfterOrder(
  ctx: CoreContext,
  sessionId: string,
  eventIds: string[],
): Promise<void> {
  await ctx.redis.del(
    ctx.keys.cart(sessionId),
    ...eventIds.map((eventId) => ctx.keys.cartSeats(eventId, sessionId)),
  );
}

export async function cartEventIds(ctx: CoreContext, sessionId: string): Promise<string[]> {
  const fields = await ctx.redis.hkeys(ctx.keys.cart(sessionId));
  return fields.filter((f) => f.startsWith('ev:')).map((f) => f.slice(3));
}

/** Releases everything a session still holds and deletes its cart. */
export async function discardCart(ctx: CoreContext, sessionId: string): Promise<void> {
  for (const eventId of await cartEventIds(ctx, sessionId)) {
    const seatIds = await ctx.redis.smembers(ctx.keys.cartSeats(eventId, sessionId));
    const released = await ctx.seats.releaseSeats(eventId, sessionId, seatIds);
    await ctx.redis.del(ctx.keys.cartSeats(eventId, sessionId));
    const ga = await ctx.seats.sessionGeneralAdmission(eventId, sessionId);
    const gaRemaining: Record<string, number> = {};
    for (const [sectionId, count] of Object.entries(ga)) {
      const r = await ctx.seats.holdGeneralAdmission({
        eventId,
        sessionId,
        sectionId,
        delta: -count,
        expiresAt: Date.now() + 1000,
        maxPerSession: 0,
      });
      gaRemaining[sectionId] = r.remaining;
    }
    await publishSeatDelta(ctx, {
      eventId,
      seats: released.map((id) => [id, 'F'] as [string, 'F']),
      ga: Object.keys(gaRemaining).length ? gaRemaining : undefined,
    });
  }
  await ctx.redis.del(ctx.keys.cart(sessionId));
}

// ─── Order limits (per category, per tariff, per access code) ──────────────

/** Tickets the session already holds per price category for this event. */
async function categoryCounts(
  ctx: CoreContext,
  sessionId: string,
  event: EventRow,
  map: PublicSeatMap,
): Promise<Map<string, number>> {
  const [seatIds, ga] = await Promise.all([
    ctx.seats.sessionSeatIds(event.id, sessionId),
    ctx.seats.sessionGeneralAdmission(event.id, sessionId),
  ]);
  const index = seatIndex(map);
  const counts = new Map<string, number>();
  const add = (category: string | null | undefined, n: number) => {
    if (category) counts.set(category, (counts.get(category) ?? 0) + n);
  };
  for (const id of seatIds) add(index.get(id)?.c, 1);
  for (const [sectionId, n] of Object.entries(ga))
    add(map.sections.find((s) => s.id === sectionId)?.priceCategoryId, n);
  return counts;
}

/** Throws CATEGORY_LIMIT when adding `additions` would exceed a category's per-order limit. */
async function assertCategoryLimits(
  ctx: CoreContext,
  sessionId: string,
  event: EventRow,
  map: PublicSeatMap,
  additions: Map<string, number>,
): Promise<void> {
  const limited = map.categories.filter(
    (c) => c.maxPerOrder !== null && (additions.get(c.id) ?? 0) > 0,
  );
  if (limited.length === 0) return;
  const counts = await categoryCounts(ctx, sessionId, event, map);
  for (const category of limited) {
    if ((counts.get(category.id) ?? 0) + additions.get(category.id)! > category.maxPerOrder!) {
      throw new DomainError('CATEGORY_LIMIT', 'Category limit per order reached', 422, {
        category: category.name,
        max: category.maxPerOrder,
      });
    }
  }
}

/** Tariffs already chosen in the cart for this event (seats and standing spots). */
async function tariffCounts(
  ctx: CoreContext,
  sessionId: string,
  eventId: string,
  exceptSeatId?: string,
): Promise<Map<string, number>> {
  const cart = await ctx.redis.hgetall(ctx.keys.cart(sessionId));
  const counts = new Map<string, number>();
  const add = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [field, value] of Object.entries(cart)) {
    if (field.startsWith(`tt:${eventId}:`) && field !== seatField(eventId, exceptSeatId ?? ''))
      add(value);
    else if (field.startsWith(`ga:${eventId}:`)) (JSON.parse(value) as string[]).forEach(add);
  }
  return counts;
}

/**
 * Default tariff for a newly added item that respects the tariffs' per-order limits: the
 * natural default first, otherwise the next allowed tariff with room left.
 */
function pickTariff(
  map: PublicSeatMap,
  categoryId: string,
  seatFlags: number | null,
  counts: Map<string, number>,
): PublicTicketType {
  const preferred = defaultTypeFor(map, categoryId, seatFlags);
  const candidates = [
    ...(preferred ? [preferred] : []),
    ...allowedTypesFor(map, categoryId, seatFlags).filter((t) => t.id !== preferred?.id),
  ];
  const fits = candidates.find(
    (t) => t.maxPerOrder === null || (counts.get(t.id) ?? 0) < t.maxPerOrder,
  );
  if (!fits) {
    const limited = preferred ?? candidates[0];
    throw new DomainError('TARIFF_LIMIT', 'Tariff limit per order reached', 422, {
      tariff: limited?.name ?? '',
      max: limited?.maxPerOrder ?? 0,
    });
  }
  counts.set(fits.id, (counts.get(fits.id) ?? 0) + 1);
  return fits;
}

/**
 * Tickets a session may hold for this event: the event / global limit, further restricted
 * by the per-order limit of an access code the session has redeemed (0 = unlimited).
 */
async function sessionTicketLimit(
  ctx: CoreContext,
  sessionId: string,
  event: EventRow,
  eventLimit: number | null,
): Promise<number | null> {
  const codeId = await ctx.redis.get(ctx.keys.queueAccessCode(event.id, sessionId));
  if (!codeId) return eventLimit;
  const [code] = await ctx.db
    .select({ max: accessCodes.maxTicketsPerOrder })
    .from(accessCodes)
    .where(eq(accessCodes.id, codeId));
  const codeLimit = code?.max ?? null;
  if (codeLimit === null) return eventLimit;
  return eventLimit === null ? codeLimit : Math.min(eventLimit, codeLimit);
}

function lockError(reason: string, details: Record<string, unknown> = {}): DomainError {
  switch (reason) {
    case 'UNAVAILABLE':
      return new DomainError('SEAT_UNAVAILABLE', 'This seat is no longer available', 409, details);
    case 'LOCKED':
      return new DomainError('SEAT_LOCKED', 'This seat is currently in another cart', 409, details);
    case 'CART_EXPIRED':
      return new DomainError('CART_EXPIRED', 'Your cart has expired', 409, details);
    case 'LIMIT_EXCEEDED':
      return new DomainError(
        'TICKET_LIMIT',
        'Maximum number of tickets for this event reached',
        422,
        details,
      );
    case 'SOLD_OUT':
      return new DomainError(
        'SECTION_SOLD_OUT',
        'Not enough spots left in this area',
        409,
        details,
      );
    default:
      return new DomainError('NOT_AVAILABLE', 'Not available', 409, details);
  }
}

// ─── Seats ──────────────────────────────────────────────────────────────────

export async function addSeats(
  ctx: CoreContext,
  sessionId: string,
  event: EventRow,
  seatIds: string[],
): Promise<{ expiresAt: number }> {
  const unique = [...new Set(seatIds)];
  if (unique.length === 0 || unique.length > 50) {
    throw new DomainError('INVALID_REQUEST', 'Select between 1 and 50 seats', 400);
  }
  const config = await effectiveCheckoutConfig(ctx, event);
  if (!config.manualSeatSelectionEnabled) {
    throw new DomainError(
      'MANUAL_SELECTION_DISABLED',
      'Seat selection is not available for this event',
      403,
    );
  }
  const map = await getPublicSeatMap(ctx, event, { fresh: true });
  const index = seatIndex(map);
  for (const id of unique) {
    const seat = index.get(id);
    if (
      !seat ||
      !seat.c ||
      (seat.f & SEAT_FLAG.BLOCKED) !== 0 ||
      !defaultTypeFor(map, seat.c, seat.f)
    ) {
      throw lockError('UNAVAILABLE', { seatId: id });
    }
  }
  await ensureInventory(ctx, event);
  const mineBefore = new Set(await ctx.seats.sessionSeatIds(event.id, sessionId));
  const added = unique.filter((id) => !mineBefore.has(id));
  const additions = new Map<string, number>();
  for (const id of added) {
    const c = index.get(id)!.c!;
    additions.set(c, (additions.get(c) ?? 0) + 1);
  }
  await assertCategoryLimits(ctx, sessionId, event, map, additions);
  const tariffs = await tariffCounts(ctx, sessionId, event.id);
  const assigned = new Map(
    added.map((id) => {
      const seat = index.get(id)!;
      return [id, pickTariff(map, seat.c!, seat.f, tariffs).id] as const;
    }),
  );
  const limit = await sessionTicketLimit(ctx, sessionId, event, config.maxTicketsPerOrder);
  const expiresAt = await freshCartExpiry(ctx, sessionId, config.cartLockTtlSeconds);
  const result = await ctx.seats.lockSeats({
    eventId: event.id,
    sessionId,
    seatIds: unique,
    expiresAt,
    maxPerSession: limit ?? 0, // 0 = unlimited
  });
  if (!result.ok) {
    throw lockError(result.reason, { seatId: result.seatId, max: limit });
  }

  const cartKey = ctx.keys.cart(sessionId);
  const tx = ctx.redis.multi().hset(cartKey, eventField(event.id), '1');
  for (const [id, tariffId] of assigned) tx.hsetnx(cartKey, seatField(event.id, id), tariffId);
  await tx.exec();
  await restartCartTimer(ctx, sessionId, expiresAt);
  await publishSeatDelta(ctx, { eventId: event.id, seats: unique.map((id) => [id, 'L']) });
  return { expiresAt };
}

export async function removeSeats(
  ctx: CoreContext,
  sessionId: string,
  eventId: string,
  seatIds: string[],
): Promise<void> {
  const released = await ctx.seats.releaseSeats(eventId, sessionId, [...new Set(seatIds)]);
  if (seatIds.length > 0)
    await ctx.redis.hdel(ctx.keys.cart(sessionId), ...seatIds.map((id) => seatField(eventId, id)));
  await publishSeatDelta(ctx, { eventId, seats: released.map((id) => [id, 'F']) });
  await dropEventIfEmpty(ctx, sessionId, eventId);
}

async function dropEventIfEmpty(
  ctx: CoreContext,
  sessionId: string,
  eventId: string,
): Promise<void> {
  const [seatIds, ga] = await Promise.all([
    ctx.seats.sessionSeatIds(eventId, sessionId),
    ctx.seats.sessionGeneralAdmission(eventId, sessionId),
  ]);
  if (seatIds.length === 0 && Object.keys(ga).length === 0) {
    await ctx.redis.hdel(ctx.keys.cart(sessionId), eventField(eventId));
  }
}

/** Removes one cart item: a seat, or one specific standing spot (`ga:<sectionId>:<index>`). */
export async function removeCartItem(
  ctx: CoreContext,
  sessionId: string,
  event: EventRow,
  itemKey: string,
): Promise<void> {
  if (!itemKey.startsWith('ga:')) {
    await removeSeats(ctx, sessionId, event.id, [itemKey]);
    return;
  }
  const [, sectionId, indexRaw] = itemKey.split(':');
  const index = Number(indexRaw);
  if (!sectionId || !Number.isInteger(index))
    throw new DomainError('ITEM_NOT_FOUND', 'Cart item not found', 404);
  const cartKey = ctx.keys.cart(sessionId);
  const field = gaField(event.id, sectionId);
  const tariffs = JSON.parse((await ctx.redis.hget(cartKey, field)) ?? '[]') as string[];
  if (index < 0 || index >= tariffs.length)
    throw new DomainError('ITEM_NOT_FOUND', 'Cart item not found', 404);
  // Keep the tariffs of the remaining spots: drop exactly the removed index.
  tariffs.splice(index, 1);
  await ctx.redis.hset(cartKey, field, JSON.stringify(tariffs));
  await setGeneralAdmission(ctx, sessionId, event, sectionId, tariffs.length);
}

// ─── Standing areas ─────────────────────────────────────────────────────────

export async function setGeneralAdmission(
  ctx: CoreContext,
  sessionId: string,
  event: EventRow,
  sectionId: string,
  quantity: number,
): Promise<{ held: number; remaining: number; expiresAt: number | null }> {
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 100) {
    throw new DomainError('INVALID_REQUEST', 'Invalid quantity', 400);
  }
  const map = await getPublicSeatMap(ctx, event, { fresh: true });
  const section = map.sections.find((s) => s.id === sectionId && s.type === 'STANDING');
  if (!section || !section.priceCategoryId || !defaultTypeFor(map, section.priceCategoryId, null)) {
    throw new DomainError('SECTION_NOT_FOUND', 'Standing area not available', 404);
  }
  const config = await effectiveCheckoutConfig(ctx, event);
  await ensureInventory(ctx, event);
  const current = (await ctx.seats.sessionGeneralAdmission(event.id, sessionId))[sectionId] ?? 0;
  const delta = quantity - current;
  const expiresAt =
    delta > 0
      ? await freshCartExpiry(ctx, sessionId, config.cartLockTtlSeconds)
      : await cartExpiry(ctx, sessionId);
  if (delta === 0) {
    const remaining = (await ctx.seats.generalAdmissionRemaining(event.id))[sectionId] ?? 0;
    return { held: current, remaining, expiresAt };
  }
  if (delta > 0) {
    await assertCategoryLimits(
      ctx,
      sessionId,
      event,
      map,
      new Map([[section.priceCategoryId, delta]]),
    );
  }
  const limit = await sessionTicketLimit(ctx, sessionId, event, config.maxTicketsPerOrder);
  const result = await ctx.seats.holdGeneralAdmission({
    eventId: event.id,
    sessionId,
    sectionId,
    delta,
    expiresAt: expiresAt ?? Date.now(),
    maxPerSession: limit ?? 0, // 0 = unlimited
  });
  if (!result.ok) {
    throw lockError(result.reason, { remaining: result.remaining, max: limit });
  }

  const cartKey = ctx.keys.cart(sessionId);
  const field = gaField(event.id, sectionId);
  const tariffs = JSON.parse((await ctx.redis.hget(cartKey, field)) ?? '[]') as string[];
  if (tariffs.length < result.held) {
    const counts = await tariffCounts(ctx, sessionId, event.id);
    while (tariffs.length < result.held)
      tariffs.push(pickTariff(map, section.priceCategoryId, null, counts).id);
  }
  tariffs.length = result.held;
  if (result.held > 0) {
    await ctx.redis
      .multi()
      .hset(cartKey, eventField(event.id), '1')
      .hset(cartKey, field, JSON.stringify(tariffs))
      .exec();
    if (delta > 0 && expiresAt) await restartCartTimer(ctx, sessionId, expiresAt);
  } else {
    await ctx.redis.hdel(cartKey, field);
    await dropEventIfEmpty(ctx, sessionId, event.id);
  }
  await publishSeatDelta(ctx, {
    eventId: event.id,
    seats: [],
    ga: { [sectionId]: result.remaining },
  });
  return { held: result.held, remaining: result.remaining, expiresAt };
}

// ─── Best available ─────────────────────────────────────────────────────────

export async function bestAvailable(
  ctx: CoreContext,
  sessionId: string,
  event: EventRow,
  categoryId: string,
  quantity: number,
): Promise<{ seatIds: string[]; expiresAt: number; arrangement: BestAvailableArrangement }> {
  const config = await effectiveCheckoutConfig(ctx, event);
  if (!config.bestAvailableEnabled) {
    throw new DomainError(
      'BEST_AVAILABLE_DISABLED',
      'Best available is not offered for this event',
      403,
    );
  }
  const maxQuantity = Math.min(
    config.maxTicketsPerOrder ?? MAX_SEATS_PER_REQUEST,
    MAX_SEATS_PER_REQUEST,
  );
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQuantity) {
    throw new DomainError('TICKET_LIMIT', 'Invalid quantity', 422, { max: maxQuantity });
  }
  const map = await getPublicSeatMap(ctx, event, { fresh: true });
  if (!map.categories.some((c) => c.id === categoryId)) {
    throw new DomainError('CATEGORY_NOT_FOUND', 'Price category not found', 404);
  }
  await ensureInventory(ctx, event);
  await assertCategoryLimits(ctx, sessionId, event, map, new Map([[categoryId, quantity]]));
  const limit = await sessionTicketLimit(ctx, sessionId, event, config.maxTicketsPerOrder);
  const expiresAt = await freshCartExpiry(ctx, sessionId, config.cartLockTtlSeconds);
  const sections = map.sections.map((s) => ({
    id: s.id,
    priority: s.bestAvailablePriority,
    enabled: s.isBestAvailableEnabled && s.type === 'SEATED',
  }));
  const seatsForAlgo = map.seats.map((s) => ({
    id: s.i,
    sectionId: s.s,
    rowId: s.r,
    position: s.p,
    categoryId: s.c,
    rank: s.k,
    flags: s.f,
    x: s.x,
    y: s.y,
  }));
  const rows = map.rows.map((r) => ({ id: r.id, sortOrder: r.sortOrder }));

  for (let attempt = 0; attempt < BEST_AVAILABLE_ATTEMPTS; attempt += 1) {
    const [taken, locked] = await Promise.all([
      ctx.seats.takenSeats(event.id),
      ctx.seats.lockedSeatIds(event.id),
    ]);
    const unavailable = new Set<string>([...Object.keys(taken), ...locked]);
    const candidates = findBestAvailable({
      seats: seatsForAlgo,
      sections,
      rows,
      unavailable,
      categoryId,
      quantity,
      maxCandidates: 3,
    });
    if (candidates.length === 0) {
      throw new DomainError('NOT_ENOUGH_SEATS', 'Not enough free seats in this category', 409);
    }
    for (const { ids: candidate, arrangement } of candidates) {
      const result = await ctx.seats.lockSeats({
        eventId: event.id,
        sessionId,
        seatIds: candidate,
        expiresAt,
        maxPerSession: limit ?? 0, // 0 = unlimited
      });
      if (result.ok) {
        const cartKey = ctx.keys.cart(sessionId);
        const index = seatIndex(map);
        const tariffs = await tariffCounts(ctx, sessionId, event.id);
        const tx = ctx.redis.multi().hset(cartKey, eventField(event.id), '1');
        for (const id of candidate) {
          const seat = index.get(id)!;
          tx.hsetnx(cartKey, seatField(event.id, id), pickTariff(map, seat.c!, seat.f, tariffs).id);
        }
        await tx.exec();
        await restartCartTimer(ctx, sessionId, expiresAt);
        await publishSeatDelta(ctx, { eventId: event.id, seats: candidate.map((id) => [id, 'L']) });
        return { seatIds: candidate, expiresAt, arrangement };
      }
      if (result.reason === 'LIMIT_EXCEEDED' || result.reason === 'CART_EXPIRED') {
        throw lockError(result.reason, { max: limit });
      }
      // Lost a race for this block → try the next candidate / recompute.
    }
  }
  throw new DomainError('NOT_ENOUGH_SEATS', 'Seats are in high demand, please try again', 409);
}

// ─── Tariffs (chosen per seat in the cart) ──────────────────────────────────

/** Throws TARIFF_LIMIT when one more ticket of this tariff exceeds its per-order limit. */
function assertTariffRoom(map: PublicSeatMap, ticketTypeId: string, current: number): void {
  const tariff = map.ticketTypes.find((t) => t.id === ticketTypeId);
  if (tariff?.maxPerOrder != null && current + 1 > tariff.maxPerOrder) {
    throw new DomainError('TARIFF_LIMIT', 'Tariff limit per order reached', 422, {
      tariff: tariff.name,
      max: tariff.maxPerOrder,
    });
  }
}

export async function setTariff(
  ctx: CoreContext,
  sessionId: string,
  event: EventRow,
  itemKey: string,
  ticketTypeId: string,
): Promise<void> {
  const map = await getPublicSeatMap(ctx, event, { fresh: true });
  const cartKey = ctx.keys.cart(sessionId);
  if (itemKey.startsWith('ga:')) {
    const [, sectionId, indexRaw] = itemKey.split(':');
    const section = map.sections.find((s) => s.id === sectionId);
    const index = Number(indexRaw);
    if (!section?.priceCategoryId || !Number.isInteger(index)) {
      throw new DomainError('ITEM_NOT_FOUND', 'Cart item not found', 404);
    }
    if (!allowedTypesFor(map, section.priceCategoryId, null).some((t) => t.id === ticketTypeId)) {
      throw new DomainError(
        'TARIFF_NOT_ALLOWED',
        'This tariff is not available for this item',
        422,
      );
    }
    const field = gaField(event.id, section.id);
    const tariffs = JSON.parse((await ctx.redis.hget(cartKey, field)) ?? '[]') as string[];
    if (index < 0 || index >= tariffs.length)
      throw new DomainError('ITEM_NOT_FOUND', 'Cart item not found', 404);
    if (tariffs[index] !== ticketTypeId) {
      const counts = await tariffCounts(ctx, sessionId, event.id);
      assertTariffRoom(map, ticketTypeId, counts.get(ticketTypeId) ?? 0);
    }
    tariffs[index] = ticketTypeId;
    await ctx.redis.hset(cartKey, field, JSON.stringify(tariffs));
    return;
  }
  const mine = await ctx.seats.sessionSeatIds(event.id, sessionId);
  const seat = seatIndex(map).get(itemKey);
  if (!seat || !seat.c || !mine.includes(itemKey))
    throw new DomainError('ITEM_NOT_FOUND', 'Cart item not found', 404);
  if (!allowedTypesFor(map, seat.c, seat.f).some((t) => t.id === ticketTypeId)) {
    throw new DomainError('TARIFF_NOT_ALLOWED', 'This tariff is not available for this seat', 422);
  }
  const counts = await tariffCounts(ctx, sessionId, event.id, itemKey);
  assertTariffRoom(map, ticketTypeId, counts.get(ticketTypeId) ?? 0);
  await ctx.redis.hset(cartKey, seatField(event.id, itemKey), ticketTypeId);
}

// ─── Selection validation ("continue to cart") ──────────────────────────────

export interface SelectionCheck {
  ok: boolean;
  /** Seats that would remain as isolated single seats (orphan rule). */
  orphanSeatIds: string[];
  /** Selected companion seats whose wheelchair space is not selected too. */
  companionSeatIds: string[];
  /**
   * Companion seats allowed because their wheelchair space is already sold – checkout must
   * verify that it was sold to the same customer (e-mail address).
   */
  companionOwnerCheckSeatIds: string[];
}

export async function validateSelection(
  ctx: CoreContext,
  sessionId: string,
  event: EventRow,
): Promise<SelectionCheck> {
  const config = await effectiveCheckoutConfig(ctx, event);
  const none: SelectionCheck = {
    ok: true,
    orphanSeatIds: [],
    companionSeatIds: [],
    companionOwnerCheckSeatIds: [],
  };
  if (!config.orphanSeatRuleEnabled && !config.companionRequiresWheelchair) return none;
  const mine = new Set(await ctx.seats.sessionSeatIds(event.id, sessionId));
  if (mine.size === 0) return none;
  const map = await getPublicSeatMap(ctx, event, { fresh: true });
  const [taken, locked] = await Promise.all([
    ctx.seats.takenSeats(event.id),
    ctx.seats.lockedSeatIds(event.id),
  ]);
  const sold = new Set(
    Object.entries(taken)
      .filter(([, code]) => code === 'S')
      .map(([id]) => id),
  );
  const companion = config.companionRequiresWheelchair
    ? checkCompanionSeats(mine, map.seats, sold)
    : { unpaired: [], ownerCheck: [] };
  const companionSeatIds = companion.unpaired;
  const companionOwnerCheckSeatIds = companion.ownerCheck;
  if (!config.orphanSeatRuleEnabled) {
    return {
      ok: companionSeatIds.length === 0,
      orphanSeatIds: [],
      companionSeatIds,
      companionOwnerCheckSeatIds,
    };
  }
  const unavailable = new Set<string>([...Object.keys(taken), ...locked]);

  const rows = new Map<string, RowSeat[]>();
  const relevantRows = new Set(
    map.seats
      .filter((s) => mine.has(s.i))
      .map((s) => s.r ?? s.t)
      .filter(Boolean),
  );
  for (const seat of map.seats) {
    const parent = seat.r ?? seat.t;
    if (!parent || !relevantRows.has(parent) || seat.p === null) continue;
    const state: RowSeat['state'] = mine.has(seat.i)
      ? 'mine'
      : unavailable.has(seat.i) || (seat.f & SEAT_FLAG.BLOCKED) !== 0
        ? 'taken'
        : 'free';
    const list = rows.get(parent) ?? [];
    list.push({ id: seat.i, position: seat.p, state });
    rows.set(parent, list);
  }
  const orphanSeatIds = [...rows.values()].flatMap((row) => findOrphanSeats(row));
  return {
    ok: orphanSeatIds.length === 0 && companionSeatIds.length === 0,
    orphanSeatIds,
    companionSeatIds,
    companionOwnerCheckSeatIds,
  };
}

// ─── Views ──────────────────────────────────────────────────────────────────

export async function getAvailability(
  ctx: CoreContext,
  sessionId: string | null,
  event: EventRow,
): Promise<EventAvailability> {
  const version = await ensureInventory(ctx, event);
  const [taken, locked, ga, mine, gaMine] = await Promise.all([
    ctx.seats.takenSeats(event.id),
    ctx.seats.lockedSeatIds(event.id),
    ctx.seats.generalAdmissionRemaining(event.id),
    sessionId ? ctx.seats.sessionSeatIds(event.id, sessionId) : Promise.resolve([]),
    sessionId ? ctx.seats.sessionGeneralAdmission(event.id, sessionId) : Promise.resolve({}),
  ]);
  const mineSet = new Set(mine);
  return {
    eventId: event.id,
    at: Date.now(),
    version,
    taken: Object.entries(taken)
      .filter(([, code]) => code === 'S' || code === 'R')
      .map(([id]) => id),
    locked: locked.filter((id) => !mineSet.has(id)),
    mine,
    ga,
    gaMine,
  };
}

export async function getCart(
  ctx: CoreContext,
  sessionId: string,
  locale?: string,
): Promise<CartView> {
  const expiresAt = await cartExpiry(ctx, sessionId);
  const now = Date.now();
  if (!expiresAt || expiresAt <= now) {
    if (expiresAt) await discardCart(ctx, sessionId);
    return { expiresAt: null, events: [], itemCount: 0, totalGross: 0, currencies: [] };
  }
  const eventIds = await cartEventIds(ctx, sessionId);
  if (eventIds.length === 0)
    return { expiresAt, events: [], itemCount: 0, totalGross: 0, currencies: [] };

  const { locale: loc, defaultLocale } = await contentLocale(ctx, locale);
  const rows = await ctx.db
    .select({ event: events, venue: venues })
    .from(events)
    .innerJoin(venues, eq(venues.id, events.venueId))
    .where(inArray(events.id, eventIds));
  const fields = await ctx.redis.hgetall(ctx.keys.cart(sessionId));

  const views: CartEventView[] = [];
  for (const { event, venue } of rows.sort(
    (a, b) => a.event.startsAt.getTime() - b.event.startsAt.getTime(),
  )) {
    const [map, mine, gaMine, config] = await Promise.all([
      getPublicSeatMap(ctx, event, { fresh: true }).then((m) =>
        localizePublicSeatMap(m, loc, defaultLocale),
      ),
      ctx.seats.sessionSeatIds(event.id, sessionId),
      ctx.seats.sessionGeneralAdmission(event.id, sessionId),
      effectiveCheckoutConfig(ctx, event),
    ]);
    const index = seatIndex(map);
    const sections = new Map(map.sections.map((s) => [s.id, s]));
    const rowsById = new Map(map.rows.map((r) => [r.id, r]));
    const categories = new Map(map.categories.map((c) => [c.id, c]));
    const items: CartItemView[] = [];

    const pushItem = (
      base: Omit<CartItemView, 'ticketTypeId' | 'priceGross' | 'allowedTicketTypeIds'>,
      chosen: string | undefined,
      flags: number | null,
    ) => {
      const allowed = allowedTypesFor(map, base.categoryId, flags);
      const type =
        allowed.find((t) => t.id === chosen) ?? defaultTypeFor(map, base.categoryId, flags);
      if (!type) return;
      items.push({
        ...base,
        ticketTypeId: type.id,
        priceGross: type.prices[base.categoryId]!,
        allowedTicketTypeIds: allowed.map((t) => t.id),
      });
    };

    for (const seatId of mine) {
      const seat = index.get(seatId);
      if (!seat?.c) continue;
      const section = sections.get(seat.s);
      const category = categories.get(seat.c);
      if (!section || !category) continue;
      pushItem(
        {
          key: seatId,
          kind: 'SEAT',
          seatId,
          sectionId: section.id,
          sectionLabel: section.showLabelOnTicket ? section.ticketLabel : null,
          rowLabel: seat.r ? (rowsById.get(seat.r)?.label ?? null) : null,
          seatLabel: seat.l,
          categoryId: category.id,
          categoryName: category.name,
          categoryColor: category.color,
        },
        fields[seatField(event.id, seatId)],
        seat.f,
      );
    }
    for (const [sectionId, count] of Object.entries(gaMine)) {
      const section = sections.get(sectionId);
      const category = section?.priceCategoryId
        ? categories.get(section.priceCategoryId)
        : undefined;
      if (!section || !category) continue;
      const tariffs = JSON.parse(fields[gaField(event.id, sectionId)] ?? '[]') as string[];
      for (let i = 0; i < count; i += 1) {
        pushItem(
          {
            key: `ga:${sectionId}:${i}`,
            kind: 'GENERAL_ADMISSION',
            seatId: null,
            sectionId,
            sectionLabel: section.showLabelOnTicket ? section.ticketLabel : null,
            rowLabel: null,
            seatLabel: null,
            categoryId: category.id,
            categoryName: category.name,
            categoryColor: category.color,
          },
          tariffs[i],
          null,
        );
      }
    }
    if (items.length === 0) continue;
    items.sort((a, b) =>
      `${a.sectionLabel ?? ''}|${a.rowLabel ?? ''}|${(a.seatLabel ?? '').padStart(6, '0')}`.localeCompare(
        `${b.sectionLabel ?? ''}|${b.rowLabel ?? ''}|${(b.seatLabel ?? '').padStart(6, '0')}`,
      ),
    );
    views.push({
      eventId: event.id,
      slug: event.slug,
      title: localized(event, 'title', loc, defaultLocale),
      startsAt: event.startsAt.toISOString(),
      timeZone: event.timeZone,
      venueName: localized(venue, 'name', loc, defaultLocale),
      currency: event.currency,
      orphanSeatRuleEnabled: config.orphanSeatRuleEnabled,
      ticketTypes: map.ticketTypes,
      items,
      subtotalGross: items.reduce((sum, i) => sum + i.priceGross, 0),
    });
  }

  return {
    expiresAt,
    events: views,
    itemCount: views.reduce((n, e) => n + e.items.length, 0),
    totalGross: views.reduce((n, e) => n + e.subtotalGross, 0),
    currencies: [...new Set(views.map((e) => e.currency))],
  };
}

export { cartExpiry };
