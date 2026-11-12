import { coreLog } from '../log';
import {
  isUniqueViolation,
  orderHistory,
  orderItems,
  orders,
  tickets,
  withTransaction,
  type Transaction,
} from '@tix/db';
import { SEAT_FLAG, type PublicSeatMap } from '@tix/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { allowedTypesFor, clearCartAfterOrder, seatIndex } from '../cart';
import { DomainError, type CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage } from '../email';
import { getEventCached } from '../events';
import { ensureInventory } from '../inventory';
import { getSeatMapForChannel } from '../seatmaps/public';
import { lockOrderTickets, reissueTicketInTransaction } from '../tickets/issue';
import { openAdjustmentItemIds } from './adjustment-state';
import { assertSellable, releaseSessionHold } from './box-office';
import { mirrorSeats } from './fulfillment';

/**
 * Seat change of an existing order (Platzwechsel), admin only.
 *
 *  - Allowed for PAID / PARTIALLY_REFUNDED / AWAITING_PAYMENT / PENDING orders and active
 *    (CONFIRMED / PENDING) seat items; standing spots cannot be moved.
 *  - The new seat must be in the same event, held by the admin's hold session (see
 *    `holdBoxOfficeSeats`), a seat another change of the same request vacates (swap), or a blocked
 *    seat with `allowBlocked` (guarded by the unique index only).
 *  - Price rule: the price of the new seat's category for the item's tariff (channel of the
 *    order) must equal the price the item was sold for – otherwise SEAT_PRICE_DIFFERS (cancel the
 *    ticket and sell a new one instead). Prices, tax and invoice stay untouched; only the place
 *    snapshot of the item changes.
 *  - One transaction: ticket advisory lock → order FOR UPDATE → items. CONFIRMED items get a
 *    new ticket (old one REPLACED, new QR). The partial unique index cannot be deferred, so
 *    moved items are parked as CANCELLED for the first step and then restored with their new
 *    seat (this makes A↔B swaps possible).
 *  - After the commit the Redis mirror, the hold locks and the live broadcast are updated; the
 *    ticket PDF is rendered from the current tickets whenever it is requested. Wallet passes that
 *    were already added to a phone keep the old seat (limitation).
 */

const CHANGEABLE_ORDER_STATUSES = ['PAID', 'PARTIALLY_REFUNDED', 'AWAITING_PAYMENT', 'PENDING'];
const MAX_CHANGES = 100;

export const seatChangeSchema = z
  .array(z.object({ orderItemId: z.uuid(), newSeatId: z.uuid() }))
  .min(1)
  .max(MAX_CHANGES);

export interface ChangeOrderSeatsParams {
  orderId: string;
  changes: { orderItemId: string; newSeatId: string }[];
  userId: string;
  /** Redis lock session of the admin tab (`boxOfficeSessionId`) that holds the new seats. */
  holdSessionId: string;
  /** Queue a TICKETS_RESENT e-mail (needs an e-mail address and re-issued tickets). */
  notify: boolean;
  reason?: string | null;
  /** Move to blocked (press / VIP) seats. The caller checks the role (EVENT_MANAGER). */
  allowBlocked?: boolean;
  /** Optimistic concurrency guard against a stale admin page. */
  expectedVersion?: number;
}

export interface SeatPlace {
  seatId: string;
  sectionLabel: string;
  rowLabel: string | null;
  seatLabel: string | null;
}

export interface ChangeOrderSeatsResult {
  changes: { orderItemId: string; from: SeatPlace; to: SeatPlace; newTicketId: string | null }[];
  reissuedTickets: number;
  emailQueued: boolean;
}

interface Resolved {
  orderItemId: string;
  eventId: string;
  status: 'PENDING' | 'CONFIRMED';
  oldSeatId: string;
  newSeatId: string;
  from: SeatPlace;
  to: SeatPlace & {
    sectionId: string;
    categoryId: string;
    categoryName: string;
    unitPriceGross: number;
  };
  priceGross: number;
  blocked: boolean;
}

/** A ticket with an open additional payment (tariff change) cannot be moved: reset the tariff first. */
async function assertNoOpenAdjustment(
  db: Pick<CoreContext, 'db'> | Transaction,
  orderId: string,
  changes: { orderItemId: string }[],
): Promise<void> {
  const open = await openAdjustmentItemIds('db' in db ? db.db : db, [orderId]);
  if (changes.some((c) => open.has(c.orderItemId))) {
    throw new DomainError(
      'ADJUSTMENT_OPEN',
      'This ticket has an open additional payment - reset the tariff first',
      409,
    );
  }
}

function planLabels(map: PublicSeatMap, seatId: string) {
  const seat = seatIndex(map).get(seatId);
  if (!seat || !seat.c) {
    throw new DomainError('SEAT_UNAVAILABLE', 'This seat cannot be used', 409, { seatId });
  }
  const section = map.sections.find((s) => s.id === seat.s);
  const category = map.categories.find((c) => c.id === seat.c);
  if (!section || !category) {
    throw new DomainError('SEAT_UNAVAILABLE', 'This seat cannot be used', 409, { seatId });
  }
  const row = seat.r ? map.rows.find((r) => r.id === seat.r) : undefined;
  return { seat, section, category, rowLabel: row?.label ?? null };
}

export async function changeOrderSeats(
  ctx: CoreContext,
  rawParams: ChangeOrderSeatsParams,
): Promise<ChangeOrderSeatsResult> {
  const params = { ...rawParams, changes: seatChangeSchema.parse(rawParams.changes) };
  const { orderId, userId } = params;
  if (!params.holdSessionId.startsWith(`boxoffice:${userId}:`)) {
    // Only the admin's own hold sessions (never an online buyer's cart) can be converted.
    throw new DomainError('HOLD_EXPIRED', 'The reservation of the new seats is missing', 409);
  }
  if (
    new Set(params.changes.map((c) => c.orderItemId)).size !== params.changes.length ||
    new Set(params.changes.map((c) => c.newSeatId)).size !== params.changes.length
  ) {
    throw new DomainError('INVALID_REQUEST', 'An item or a seat was selected twice', 422);
  }

  // ── Pre-read (no locks): resolve the changes against the plans and check the price rule ──
  const [order] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
  if (!CHANGEABLE_ORDER_STATUSES.includes(order.status)) {
    throw new DomainError(
      'ORDER_NOT_CHANGEABLE',
      'The seats of this order cannot be changed',
      409,
      {
        status: order.status,
      },
    );
  }
  const items = await ctx.db
    .select()
    .from(orderItems)
    .where(
      and(
        eq(orderItems.orderId, orderId),
        inArray(
          orderItems.id,
          params.changes.map((c) => c.orderItemId),
        ),
      ),
    );
  const itemById = new Map(items.map((i) => [i.id, i]));
  await assertNoOpenAdjustment(ctx, orderId, params.changes);
  const eventIds = [...new Set(items.map((i) => i.eventId))].sort();
  const events = new Map<string, Awaited<ReturnType<typeof getEventCached>>>();
  const maps = new Map<string, PublicSeatMap>();
  for (const eventId of eventIds) {
    const event = await getEventCached(ctx, eventId);
    assertSellable(event);
    events.set(eventId, event);
    maps.set(eventId, await getSeatMapForChannel(ctx, event, order.channel));
  }

  const resolved: Resolved[] = params.changes.map((change) => {
    const item = itemById.get(change.orderItemId);
    if (!item) throw new DomainError('ORDER_ITEM_NOT_FOUND', 'Order item not found', 404);
    if (item.status !== 'PENDING' && item.status !== 'CONFIRMED') {
      throw new DomainError('ITEM_NOT_ACTIVE', 'Only active tickets can be moved', 409);
    }
    if (item.kind !== 'SEAT' || !item.seatId) {
      throw new DomainError('ITEM_NOT_SEAT', 'Standing spots cannot be moved', 422);
    }
    if (item.seatId === change.newSeatId) {
      throw new DomainError('INVALID_REQUEST', 'The new seat is the current seat', 422);
    }
    const map = maps.get(item.eventId)!;
    const target = planLabels(map, change.newSeatId);
    const blocked = (target.seat.f & SEAT_FLAG.BLOCKED) !== 0;
    if (blocked && !params.allowBlocked) {
      throw new DomainError('SEAT_BLOCKED', 'This seat is blocked', 409, {
        seatId: change.newSeatId,
      });
    }
    const tariff = map.ticketTypes.find((t) => t.id === item.ticketTypeId);
    if (
      !tariff ||
      !allowedTypesFor(map, target.seat.c!, target.seat.f).some((t) => t.id === tariff.id)
    ) {
      throw new DomainError('TARIFF_NOT_ALLOWED', 'This tariff does not fit the new seat', 422, {
        seatId: change.newSeatId,
      });
    }
    const expected = order.paymentMethod === 'COMPLIMENTARY' ? 0 : tariff.prices[target.seat.c!];
    // Same category + same tariff keeps the price paid (even after price-table changes or a
    // box-office override); another category needs the same current price.
    if (item.priceCategoryId !== target.category.id && expected !== item.priceGross) {
      throw new DomainError(
        'SEAT_PRICE_DIFFERS',
        'The new seat has a different price; cancel the ticket and sell a new one',
        409,
        { seatId: change.newSeatId, expected: expected ?? null, current: item.priceGross },
      );
    }
    return {
      orderItemId: item.id,
      eventId: item.eventId,
      status: item.status,
      oldSeatId: item.seatId,
      newSeatId: change.newSeatId,
      from: {
        seatId: item.seatId,
        sectionLabel: item.sectionLabel,
        rowLabel: item.rowLabel,
        seatLabel: item.seatLabel,
      },
      to: {
        seatId: change.newSeatId,
        sectionId: target.section.id,
        categoryId: target.category.id,
        categoryName: target.category.name,
        unitPriceGross: Math.max(target.category.basePrice, item.priceGross),
        sectionLabel: target.section.ticketLabel || target.section.name,
        rowLabel: target.rowLabel,
        seatLabel: target.seat.l,
      },
      priceGross: item.priceGross,
      blocked,
    };
  });

  // ── Seat availability: held by the admin, vacated by this very request, or blocked ──
  for (const eventId of eventIds) {
    const mine = resolved.filter((r) => r.eventId === eventId);
    const vacated = new Set(mine.map((r) => r.oldSeatId));
    await ensureInventory(ctx, events.get(eventId)!);
    const taken = await ctx.seats.takenSeats(eventId);
    const held = new Set(await ctx.seats.sessionSeatIds(eventId, params.holdSessionId));
    for (const r of mine) {
      if (vacated.has(r.newSeatId)) continue; // swap: guarded by the unique index
      if (r.blocked) {
        const owner = await ctx.redis.get(ctx.keys.seatLock(eventId, r.newSeatId));
        if (
          taken[r.newSeatId] === 'S' ||
          taken[r.newSeatId] === 'R' ||
          (owner !== null && owner !== params.holdSessionId)
        ) {
          throw new DomainError('SEAT_UNAVAILABLE', 'This seat is no longer available', 409, {
            seatId: r.newSeatId,
          });
        }
      } else if (!held.has(r.newSeatId)) {
        throw new DomainError('HOLD_EXPIRED', 'The reservation of the new seats expired', 409, {
          seatId: r.newSeatId,
        });
      }
    }
    // The hold must outlive the transaction.
    const exp = Number(await ctx.redis.hget(ctx.keys.cart(params.holdSessionId), 'exp')) || 0;
    await ctx.seats.extendCart(eventId, params.holdSessionId, Math.max(exp, Date.now() + 120_000));
    const stillHeld = new Set(await ctx.seats.sessionSeatIds(eventId, params.holdSessionId));
    const lost = mine.find(
      (r) => !r.blocked && !vacated.has(r.newSeatId) && !stillHeld.has(r.newSeatId),
    );
    if (lost) {
      throw new DomainError('HOLD_EXPIRED', 'The reservation of the new seats expired', 409, {
        seatId: lost.newSeatId,
      });
    }
  }

  // ── Transaction ───────────────────────────────────────────────────────────────
  let outcome: { reissued: Map<string, string>; messageId: string | null };
  try {
    outcome = await withTransaction(ctx.db, async (tx) => {
      await lockOrderTickets(tx, orderId);
      const [locked] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
      if (!locked) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
      if (!CHANGEABLE_ORDER_STATUSES.includes(locked.status)) {
        throw new DomainError(
          'ORDER_NOT_CHANGEABLE',
          'The seats of this order cannot be changed',
          409,
          { status: locked.status },
        );
      }
      if (params.expectedVersion !== undefined && params.expectedVersion !== locked.version) {
        throw new DomainError('ORDER_CHANGED', 'The order was changed in the meantime', 409);
      }
      await assertNoOpenAdjustment(tx, orderId, params.changes);
      const current = await tx
        .select({ id: orderItems.id, status: orderItems.status, seatId: orderItems.seatId })
        .from(orderItems)
        .where(
          inArray(
            orderItems.id,
            resolved.map((r) => r.orderItemId),
          ),
        )
        .for('update');
      const currentById = new Map(current.map((i) => [i.id, i]));
      for (const r of resolved) {
        const now = currentById.get(r.orderItemId);
        if (!now || now.status !== r.status || now.seatId !== r.oldSeatId) {
          throw new DomainError('ORDER_CHANGED', 'The order was changed in the meantime', 409);
        }
      }

      // Step 1: park the moved items outside the unique index (no trigger / check cares).
      await tx
        .update(orderItems)
        .set({ status: 'CANCELLED' })
        .where(
          inArray(
            orderItems.id,
            resolved.map((r) => r.orderItemId),
          ),
        );
      // Step 2: new place + original status (unique violation = seat taken meanwhile).
      for (const r of resolved) {
        await tx
          .update(orderItems)
          .set({
            status: r.status,
            seatId: r.to.seatId,
            sectionId: r.to.sectionId,
            priceCategoryId: r.to.categoryId,
            categoryName: r.to.categoryName,
            unitPriceGross: r.to.unitPriceGross,
            discountAmount: r.to.unitPriceGross - r.priceGross,
            sectionLabel: r.to.sectionLabel,
            rowLabel: r.to.rowLabel,
            seatLabel: r.to.seatLabel,
          })
          .where(eq(orderItems.id, r.orderItemId));
      }
      await tx
        .update(orders)
        .set({ version: sql`${orders.version} + 1` })
        .where(eq(orders.id, orderId));

      // New tickets for confirmed items (built from the updated item snapshot).
      const reissued = new Map<string, string>();
      const confirmed = resolved.filter((r) => r.status === 'CONFIRMED');
      if (confirmed.length > 0) {
        const valid = await tx
          .select({ id: tickets.id, orderItemId: tickets.orderItemId })
          .from(tickets)
          .where(
            and(
              inArray(
                tickets.orderItemId,
                confirmed.map((r) => r.orderItemId),
              ),
              eq(tickets.status, 'VALID'),
            ),
          );
        for (const t of valid) {
          const created = await reissueTicketInTransaction(ctx, tx, t.id);
          reissued.set(t.orderItemId, created.id);
        }
      }

      const reason = params.reason?.trim() || null;
      await tx.insert(orderHistory).values({
        orderId,
        type: 'seats_changed',
        actorType: 'ADMIN',
        actorUserId: userId,
        data: {
          reason,
          notify: params.notify,
          changes: resolved.map((r) => ({
            orderItemId: r.orderItemId,
            from: r.from,
            to: {
              seatId: r.to.seatId,
              sectionLabel: r.to.sectionLabel,
              rowLabel: r.to.rowLabel,
              seatLabel: r.to.seatLabel,
            },
            ...(r.blocked ? { blockedSeat: true } : {}),
          })),
        },
      });

      let messageId: string | null = null;
      if (params.notify && locked.email && reissued.size > 0) {
        messageId = await createEmailMessage(ctx, tx, { key: 'TICKETS_RESENT', orderId });
      }
      return { reissued, messageId };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'order_items_active_seat_uq')) {
      throw new DomainError('SEAT_UNAVAILABLE', 'A selected seat was just taken', 409);
    }
    throw err;
  }

  // ── After commit: nothing below may turn the committed change into an error ───────────
  const safe = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      coreLog.error(
        { err, step: what },
        '[seat-change] step failed after the change was committed',
      );
    }
  };
  // A cancel / expiry that ran right after the commit may already have released the items.
  const currentItems = await ctx.db
    .select({ id: orderItems.id, status: orderItems.status, seatId: orderItems.seatId })
    .from(orderItems)
    .where(
      inArray(
        orderItems.id,
        resolved.map((r) => r.orderItemId),
      ),
    )
    .catch(() => null);
  const liveStatus = (r: Resolved) => {
    if (!currentItems) return r.status;
    const now = currentItems.find((i) => i.id === r.orderItemId);
    return now && now.seatId === r.newSeatId ? now.status : null;
  };
  for (const eventId of eventIds) {
    const mine = resolved.filter((r) => r.eventId === eventId);
    const newSeats = new Set(mine.map((r) => r.newSeatId));
    // A seat that is vacated and taken again (swap) only gets its new code.
    const freed = mine.filter((r) => !newSeats.has(r.oldSeatId));
    await safe('seat release mirror', () =>
      mirrorSeats(
        ctx,
        freed.map((r) => ({ seatId: r.oldSeatId, eventId })),
        null,
      ),
    );
    for (const [status, code] of [
      ['CONFIRMED', 'S'],
      ['PENDING', 'R'],
    ] as const) {
      const targets = mine.filter((r) => liveStatus(r) === status);
      await safe('seat mirror', () =>
        mirrorSeats(
          ctx,
          targets.map((r) => ({ seatId: r.newSeatId, eventId })),
          code,
        ),
      );
    }
    await safe('seat lock release', () => ctx.seats.forceRelease(eventId, [...newSeats]));
    // Anything else the tab still held goes back to the pool.
    await safe('hold release', () => releaseSessionHold(ctx, params.holdSessionId, eventId));
  }
  await safe('cart cleanup', () => clearCartAfterOrder(ctx, params.holdSessionId, eventIds));
  const messageId = outcome.messageId;
  if (messageId) {
    await safe('e-mail dispatch (the outbox retries)', () => dispatchEmailMessage(ctx, messageId));
  }

  return {
    changes: resolved.map((r) => ({
      orderItemId: r.orderItemId,
      from: r.from,
      to: {
        seatId: r.to.seatId,
        sectionLabel: r.to.sectionLabel,
        rowLabel: r.to.rowLabel,
        seatLabel: r.to.seatLabel,
      },
      newTicketId: outcome.reissued.get(r.orderItemId) ?? null,
    })),
    reissuedTickets: outcome.reissued.size,
    emailQueued: messageId !== null,
  };
}
