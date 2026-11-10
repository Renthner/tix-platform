import { randomUUID } from 'node:crypto';
import {
  events,
  eventSigningKeys,
  orderItems,
  orders,
  seatMapSections,
  tickets,
  withTransaction,
  type Executor,
  type Transaction,
} from '@tix/db';
import { QUEUE_NAMES } from '@tix/redis';
import { buildTicketPayload, ticketSeatInfo } from '@tix/shared';
import { generateHumanCode } from '@tix/shared/server';
import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage } from '../email';
import { currentPaidCycle, hasPaymentMailForCycle, orderPaidJobId } from '../orders/paid-cycle';
import { placeOrderBy } from './order';
import { ensureEventSigningKeyTx, type TicketSigningKey } from './keys';

export type TicketRow = typeof tickets.$inferSelect;

const CODE_LENGTH = 10;
const MAX_CODE_ATTEMPTS = 8;
const orderLockSql = (orderId: string) =>
  sql`SELECT pg_advisory_xact_lock(hashtext(${`order-tickets:${orderId}`}))`;

/**
 * Per-order ticket advisory lock (shared by issuance, re-issue, cancellation and allocation
 * reversal). Take it FIRST, before the order row lock, so ticket changes cannot interleave.
 */
export async function lockOrderTickets(tx: Transaction, orderId: string): Promise<void> {
  await tx.execute(orderLockSql(orderId));
}

interface ItemForTicket {
  id: string;
  eventId: string;
  kind: 'SEAT' | 'GENERAL_ADMISSION';
  sectionLabel: string;
  rowLabel: string | null;
  seatLabel: string | null;
  attendeeName: string | null;
  showLabelOnTicket: boolean;
}

const itemColumns = {
  id: orderItems.id,
  eventId: orderItems.eventId,
  kind: orderItems.kind,
  sectionLabel: orderItems.sectionLabel,
  rowLabel: orderItems.rowLabel,
  seatLabel: orderItems.seatLabel,
  attendeeName: orderItems.attendeeName,
  showLabelOnTicket: seatMapSections.showLabelOnTicket,
};

function signTicket(key: TicketSigningKey, ticketId: string, item: ItemForTicket): Promise<string> {
  return buildTicketPayload(
    {
      keyId: key.keyId,
      eventId: item.eventId,
      ticketId,
      seatInfo: ticketSeatInfo({
        kind: item.kind,
        sectionLabel: item.sectionLabel,
        rowLabel: item.rowLabel,
        seatLabel: item.seatLabel,
        showSectionLabel: item.showLabelOnTicket,
      }),
    },
    key.signer,
  );
}

/**
 * Inserts one ticket for `item`; retries with a new code on a `ticket_code` collision.
 * Returns null when the item already has a VALID ticket (concurrent issuance).
 */
async function insertTicket(
  tx: Transaction,
  orderId: string,
  item: ItemForTicket,
  key: TicketSigningKey,
  attendeeName: string | null,
  carryOver: Partial<typeof tickets.$inferInsert> = {},
): Promise<TicketRow | null> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const id = randomUUID();
    const [row] = await tx
      .insert(tickets)
      .values({
        id,
        orderItemId: item.id,
        orderId,
        eventId: item.eventId,
        ticketCode: generateHumanCode(CODE_LENGTH),
        signingKeyId: key.id,
        qrPayload: await signTicket(key, id, item),
        attendeeName,
        ...carryOver,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const [valid] = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.orderItemId, item.id), eq(tickets.status, 'VALID')));
    if (valid) return null;
  }
  throw new Error('Could not allocate a unique ticket code');
}

/** VALID tickets of an order, in issuance order (read only). */
export async function listOrderTickets(ctx: CoreContext, orderId: string): Promise<TicketRow[]> {
  return validTicketsInPlaceOrder(ctx.db, orderId);
}

async function validTicketsInPlaceOrder(db: Executor, orderId: string): Promise<TicketRow[]> {
  const rows = await db
    .select({ ticket: tickets })
    .from(tickets)
    .innerJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
    .innerJoin(events, eq(events.id, tickets.eventId))
    .where(and(eq(tickets.orderId, orderId), eq(tickets.status, 'VALID')))
    .orderBy(...placeOrderBy());
  return rows.map((r) => r.ticket);
}

/**
 * Idempotent ticket issuance: exactly one VALID, signed ticket per CONFIRMED order item.
 * Existing tickets are returned unchanged; concurrent callers are serialised per order
 * (advisory lock) and the partial unique index is the backstop. All-or-nothing: any failure
 * rolls the whole order back, so a retry never sees half state.
 *
 * Only PAID orders get tickets. The order row is read `FOR SHARE`, so a concurrent status change
 * (cancel/refund, which update the row) waits for issuance and vice versa. Phase-5 refund and
 * seat-change flows MUST lock the order row `FOR UPDATE` (before touching items/tickets) to
 * serialise with issuance.
 */
export async function ensureOrderTickets(ctx: CoreContext, orderId: string): Promise<TicketRow[]> {
  return withTransaction(ctx.db, async (tx) => {
    await tx.execute(orderLockSql(orderId));
    const [order] = await tx
      .select({
        id: orders.id,
        status: orders.status,
        firstName: orders.firstName,
        lastName: orders.lastName,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('share');
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    // PARTIALLY_REFUNDED: the remaining CONFIRMED items still get their tickets (refunded items
    // are REFUNDED and never selected below).
    if (order.status !== 'PAID' && order.status !== 'PARTIALLY_REFUNDED') return [];

    const missing = await tx
      .select(itemColumns)
      .from(orderItems)
      .innerJoin(seatMapSections, eq(seatMapSections.id, orderItems.sectionId))
      .where(
        and(
          eq(orderItems.orderId, orderId),
          eq(orderItems.status, 'CONFIRMED'),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(tickets)
              .where(and(eq(tickets.orderItemId, orderItems.id), eq(tickets.status, 'VALID'))),
          ),
        ),
      )
      .orderBy(asc(orderItems.createdAt), asc(orderItems.id));

    const keys = new Map<string, TicketSigningKey>();
    const buyerName = `${order.firstName} ${order.lastName}`.trim() || null;
    // Acquire per-event keys in a stable order so concurrent multi-event orders cannot deadlock.
    for (const eventId of [...new Set(missing.map((item) => item.eventId))].sort()) {
      keys.set(eventId, await ensureEventSigningKeyTx(ctx, tx, eventId));
    }
    for (const item of missing) {
      await insertTicket(
        tx,
        orderId,
        item,
        keys.get(item.eventId)!,
        item.attendeeName?.trim() || buyerName,
      );
    }
    return validTicketsInPlaceOrder(tx, orderId);
  });
}

export interface ReissueOptions {
  /** New attendee name; omitted keeps the old one. */
  attendeeName?: string | null;
}

/**
 * Replaces a VALID ticket (seat change, name change, revoked key): the old ticket becomes
 * REPLACED (scanners stop accepting it after their next sync), a new ticket with a new id,
 * code and signature – built from the *current* order item snapshot and the event's ACTIVE
 * key – is issued. The check-in state is carried over to the new ticket (a checked-in guest
 * keeps being checked in with the new QR); the old row keeps its history for the audit trail.
 */
export async function reissueTicket(
  ctx: CoreContext,
  ticketId: string,
  options: ReissueOptions = {},
): Promise<TicketRow> {
  return withTransaction(ctx.db, async (tx) => {
    const [head] = await tx
      .select({ orderId: tickets.orderId })
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    if (!head) throw new DomainError('TICKET_NOT_FOUND', 'Ticket not found', 404);
    await tx.execute(orderLockSql(head.orderId));
    return reissueTicketInTransaction(ctx, tx, ticketId, options);
  });
}

/**
 * `reissueTicket` inside the caller's transaction. The caller MUST already hold the per-order
 * ticket advisory lock (`lockOrderTickets`); it is not re-entrant across connections.
 */
export async function reissueTicketInTransaction(
  ctx: CoreContext,
  tx: Transaction,
  ticketId: string,
  options: ReissueOptions = {},
): Promise<TicketRow> {
  const [old] = await tx.select().from(tickets).where(eq(tickets.id, ticketId)).for('update');
  if (!old) throw new DomainError('TICKET_NOT_FOUND', 'Ticket not found', 404);
  if (old.status !== 'VALID') {
    throw new DomainError('TICKET_NOT_VALID', 'Only a valid ticket can be re-issued', 409);
  }
  const [item] = await tx
    .select(itemColumns)
    .from(orderItems)
    .innerJoin(seatMapSections, eq(seatMapSections.id, orderItems.sectionId))
    .where(eq(orderItems.id, old.orderItemId));
  if (!item) throw new DomainError('ORDER_ITEM_NOT_FOUND', 'Order item not found', 404);

  const key = await ensureEventSigningKeyTx(ctx, tx, item.eventId);
  await tx
    .update(tickets)
    .set({ status: 'REPLACED', voidedAt: sql`now()` })
    .where(eq(tickets.id, old.id));
  const created = await insertTicket(
    tx,
    old.orderId,
    item,
    key,
    options.attendeeName === undefined ? old.attendeeName : options.attendeeName,
    {
      checkInState: old.checkInState,
      firstCheckedInAt: old.firstCheckedInAt,
      firstCheckedInDeviceId: old.firstCheckedInDeviceId,
      checkInCount: old.checkInCount,
      lastScanAt: old.lastScanAt,
    },
  );
  if (!created) throw new DomainError('TICKET_CONFLICT', 'Concurrent ticket change', 409);
  await tx.update(tickets).set({ replacedByTicketId: created.id }).where(eq(tickets.id, old.id));
  return created;
}

export interface RevokedKeyReissueResult {
  /** Tickets actually re-issued (failures excluded). */
  reissued: number;
  /** Orders that got at least one new ticket (they receive a TICKETS_RESENT e-mail). */
  orderIds: string[];
}

/**
 * Re-issues every VALID ticket of the event that is signed with a REVOKED key (after
 * `revokeEventSigningKey`) and queues a TICKETS_RESENT e-mail per affected order (outbox row
 * in its own transaction, dispatched after commit). A ticket that changed concurrently
 * (TICKET_NOT_VALID / TICKET_CONFLICT) is skipped, not counted and not fatal.
 */
export async function reissueTicketsOfRevokedKeys(
  ctx: CoreContext,
  eventId: string,
): Promise<RevokedKeyReissueResult> {
  const stale = await ctx.db
    .select({ id: tickets.id, orderId: tickets.orderId })
    .from(tickets)
    .where(
      and(
        eq(tickets.eventId, eventId),
        eq(tickets.status, 'VALID'),
        sql`${tickets.signingKeyId} IN (SELECT id FROM event_signing_keys WHERE event_id = ${eventId} AND status = 'REVOKED')`,
      ),
    );
  let reissued = 0;
  const orderIds = new Set<string>();
  for (const t of stale) {
    try {
      await reissueTicket(ctx, t.id);
      reissued += 1;
      orderIds.add(t.orderId);
    } catch (err) {
      if (
        err instanceof DomainError &&
        (err.code === 'TICKET_NOT_VALID' || err.code === 'TICKET_CONFLICT')
      ) {
        continue;
      }
      throw err;
    }
  }
  for (const orderId of orderIds) {
    const messageId = await withTransaction(ctx.db, (tx) =>
      createEmailMessage(ctx, tx, { key: 'TICKETS_RESENT', orderId }),
    );
    await dispatchEmailMessage(ctx, messageId);
  }
  return { reissued, orderIds: [...orderIds] };
}

/**
 * Voids the VALID tickets of the given order items (cancellation / refund). Runs inside the
 * caller's transaction so item and ticket state change atomically.
 */
export async function voidTicketsForItems(
  tx: Transaction,
  orderItemIds: string[],
  status: 'CANCELLED' | 'REFUNDED',
): Promise<number> {
  if (orderItemIds.length === 0) return 0;
  const rows = await tx
    .update(tickets)
    .set({ status, voidedAt: sql`now()` })
    .where(and(inArray(tickets.orderItemId, orderItemIds), eq(tickets.status, 'VALID')))
    .returning({ id: tickets.id });
  return rows.length;
}

export interface BackfillResult {
  /** Orders whose tickets were issued directly (silently). */
  orders: number;
  tickets: number;
  failed: number;
  /** Recently paid orders handed back to the `order-paid` job (tickets + e-mail). */
  requeued: number;
  /** VALID tickets re-issued because their signing key is REVOKED. */
  reissued: number;
}

/** Orders paid within this window without a confirmation e-mail are re-processed by the job. */
export const BACKFILL_REQUEUE_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Issues missing tickets for PAID orders (paid before ticket issuance existed, or after a
 * failed fulfilment job) and re-issues VALID tickets signed with a REVOKED key.
 *  - paid within the last 48 h and no PAYMENT_RECEIVED_TICKETS e-mail row yet: the `order-paid`
 *    job is re-enqueued (jobId `order-paid-<id>`, deduplicated by BullMQ) so the customer gets
 *    tickets and mail through the normal path;
 *  - older orders (or no job queue in the context): tickets are issued silently, no e-mail, so
 *    historic orders are never mailed unexpectedly.
 * Idempotent and safe to run concurrently with `processPaidOrder` (same per-order lock).
 * Processes at most `batchSize` orders per call.
 */
export async function backfillMissingTickets(
  ctx: CoreContext,
  options: {
    batchSize?: number;
    log?: (message: string, data?: Record<string, unknown>) => void;
  } = {},
): Promise<BackfillResult> {
  const limit = options.batchSize ?? 200;
  const candidates = await ctx.db
    .selectDistinct({ orderId: orderItems.orderId, paidAt: orders.paidAt, channel: orders.channel })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        inArray(orders.status, ['PAID', 'PARTIALLY_REFUNDED']),
        eq(orderItems.status, 'CONFIRMED'),
        notExists(
          ctx.db
            .select({ one: sql`1` })
            .from(tickets)
            .where(and(eq(tickets.orderItemId, orderItems.id), eq(tickets.status, 'VALID'))),
        ),
      ),
    )
    .limit(limit);
  const result: BackfillResult = { orders: 0, tickets: 0, failed: 0, requeued: 0, reissued: 0 };
  const recentSince = Date.now() - BACKFILL_REQUEUE_WINDOW_MS;
  for (const { orderId, paidAt, channel } of candidates) {
    try {
      // Box-office orders are fulfilled synchronously; their mail is only sent on request.
      if (ctx.jobs && channel === 'ONLINE' && paidAt && paidAt.getTime() >= recentSince) {
        if (!(await hasPaymentMailForCycle(ctx.db, orderId))) {
          await ctx.jobs.add(
            QUEUE_NAMES.documents,
            'order-paid',
            { orderId, paidCycle: await currentPaidCycle(ctx.db, orderId) },
            { jobId: await orderPaidJobId(ctx.db, orderId) },
          );
          result.requeued += 1;
          continue;
        }
      }
      const before = (await listOrderTickets(ctx, orderId)).length;
      const after = (await ensureOrderTickets(ctx, orderId)).length;
      result.orders += 1;
      result.tickets += after - before;
    } catch (err) {
      result.failed += 1;
      options.log?.('ticket backfill failed', { orderId, error: String(err) });
    }
  }

  const revokedEvents = await ctx.db
    .selectDistinct({ eventId: tickets.eventId })
    .from(tickets)
    .innerJoin(eventSigningKeys, eq(eventSigningKeys.id, tickets.signingKeyId))
    .where(and(eq(tickets.status, 'VALID'), eq(eventSigningKeys.status, 'REVOKED')))
    .limit(limit);
  for (const { eventId } of revokedEvents) {
    try {
      result.reissued += (await reissueTicketsOfRevokedKeys(ctx, eventId)).reissued;
    } catch (err) {
      result.failed += 1;
      options.log?.('revoked-key re-issue failed', { eventId, error: String(err) });
    }
  }
  return result;
}
