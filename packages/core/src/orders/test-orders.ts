import {
  accessCodeRedemptions,
  accessCodes,
  auditLogs,
  bankTransactionAllocations,
  emailMessages,
  events,
  invoices,
  orderAdjustments,
  orderItems,
  orders,
  payments,
  refunds,
  seatMapSections,
  tickets,
  withTransaction,
  type Transaction,
} from '@tix/db';
import { INVENTORY_HOLDING_ITEM_STATUSES, type EventStatus } from '@tix/shared';
import { and, count, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { cartEventIds } from '../cart';
import { DomainError, type CoreContext } from '../context';
import { coreLog } from '../log';
import { reconcilePayPalOrder } from '../payments/paypal';
import { rotateSyncEpoch } from '../scanner/sync';
import { revokeAllEventSigningKeysTx } from '../tickets/keys';
import { cancelOrder, releaseInventory } from './fulfillment';
import { cancelPaidOrder } from './refunds';

/**
 * Test orders: orders a super-admin placed on a DRAFT event (`orders.is_test`). They are real
 * orders for the shop machinery (seats, payment, e-mails, tickets) but never invoiced, never in
 * statistics and never revenue.
 *
 * Money rules (accounting): a test order that NEVER received money can be deleted completely.
 * Once real money was captured (PayPal capture or bank allocation) the order is a financial
 * record and can no longer be deleted: it is cancelled through the normal cancellation / refund
 * flow and hidden from the default order list instead (`cancelAndHideTestOrder`). Its payments,
 * refunds and reversals stay in the accounting export, marked TEST.
 */

export type TestOrderBlocker =
  /** Real money was captured at some point (also when refunded since): cancel & hide instead. */
  | 'MONEY_CAPTURED'
  /** A PayPal payment was started and may still be approved / captured. */
  | 'PAYMENT_OPEN'
  /** Defensive: an invoice exists (GoBD documents can never be deleted). */
  | 'INVOICE_EXISTS';

export interface TestOrderDeleteResult {
  orderId: string;
  orderNumber: string;
  deleted: boolean;
  /** Why the order was kept (only when `deleted` is false). */
  blocker?: TestOrderBlocker;
}

export interface TestOrderSummary {
  /** Test orders with items of the event (cancelled / hidden ones included). */
  orders: number;
  /** Seats / standing spots they still occupy. */
  seats: number;
  /** Test orders that received real money at some point: they cannot be deleted. */
  withMoney: number;
  /** Test orders that are already cancelled and hidden. */
  hidden: number;
}

/** Money was ever captured on the order (a payment with `captured_at`, or a bank allocation). */
async function moneyEverCaptured(
  db: Pick<Transaction, 'select'>,
  orderId: string,
): Promise<boolean> {
  const [payment] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.orderId, orderId),
        ne(payments.method, 'COMPLIMENTARY'),
        sql`${payments.amount} > 0`,
        or(
          isNotNull(payments.capturedAt),
          inArray(payments.status, ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED']),
        ),
      ),
    )
    .limit(1);
  if (payment) return true;
  const [allocation] = await db
    .select({ id: bankTransactionAllocations.id })
    .from(bankTransactionAllocations)
    .where(eq(bankTransactionAllocations.orderId, orderId))
    .limit(1);
  return Boolean(allocation);
}

/**
 * Test orders of an event that still count (cancelled & hidden ones are inert and only counted as
 * `hidden`) and the seats they occupy (publish confirmation).
 */
export async function summarizeTestOrders(
  ctx: Pick<CoreContext, 'db'>,
  eventId: string,
): Promise<TestOrderSummary> {
  const [row] = await ctx.db
    .select({
      orders: sql<number>`count(DISTINCT ${orders.id})::int`,
      seats: sql<number>`count(*) FILTER (WHERE ${inArray(orderItems.status, [...INVENTORY_HOLDING_ITEM_STATUSES])})::int`,
      withMoney: sql<number>`count(DISTINCT ${orders.id}) FILTER (WHERE EXISTS (
        SELECT 1 FROM payments p WHERE p.order_id = ${orders.id} AND p.method <> 'COMPLIMENTARY' AND p.amount > 0
          AND (p.captured_at IS NOT NULL OR p.status IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'))
      ) OR EXISTS (SELECT 1 FROM bank_transaction_allocations a WHERE a.order_id = ${orders.id}))::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(eq(orderItems.eventId, eventId), eq(orders.isTest, true), isNull(orders.testHiddenAt)),
    );
  const [hiddenRow] = await ctx.db
    .select({ n: sql<number>`count(DISTINCT ${orders.id})::int` })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(eq(orderItems.eventId, eventId), eq(orders.isTest, true), isNotNull(orders.testHiddenAt)),
    );
  return {
    orders: row?.orders ?? 0,
    seats: row?.seats ?? 0,
    withMoney: row?.withMoney ?? 0,
    hidden: hiddenRow?.n ?? 0,
  };
}

interface DeleteOutcome {
  result: TestOrderDeleteResult;
  released: { seatId: string | null; eventId: string; sectionId: string; kind: string }[];
  objectKeys: string[];
}

/**
 * Checks open PayPal attempts of the order at PayPal BEFORE the delete transaction (network
 * calls never run inside it): an approved payment is captured, an abandoned one is cancelled.
 * PayPal being unreachable or unconfigured only means the attempt stays open (PAYMENT_OPEN).
 */
async function settleOpenPayPalAttempts(ctx: CoreContext, orderId: string): Promise<void> {
  const open = await ctx.db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.orderId, orderId),
        eq(payments.method, 'PAYPAL'),
        inArray(payments.status, ['CREATED', 'APPROVED']),
        isNotNull(payments.providerOrderId),
      ),
    )
    .limit(1);
  if (open.length === 0) return;
  try {
    await reconcilePayPalOrder(ctx, orderId);
  } catch (err) {
    coreLog.warn({ err, orderId }, '[test-orders] PayPal reconcile before deletion failed');
  }
}

/**
 * Deletes one test order completely: items, tickets, payments, e-mail outbox rows, history,
 * access-code redemptions and stored ticket PDFs; seats and standing capacity go back to the pool
 * (database and Redis mirrors). Refused (returned as `blocker`, not thrown) once real money was
 * captured, while a PayPal payment is open, or when an invoice exists.
 *
 * Tickets that were already issued are gone for scanners too: the sync epoch is rotated so every
 * device drops its synced copy on the next sync run.
 */
export async function deleteTestOrder(
  ctx: CoreContext,
  params: { orderId: string; userId: string },
): Promise<TestOrderDeleteResult> {
  await settleOpenPayPalAttempts(ctx, params.orderId);
  const outcome = await withTransaction(ctx.db, async (tx): Promise<DeleteOutcome> => {
    // Row lock + re-check of every condition inside the transaction (a payment may arrive while
    // an admin looks at the confirmation dialog).
    const [order] = await tx
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        isTest: orders.isTest,
        status: orders.status,
        paymentMethod: orders.paymentMethod,
        cartSessionId: orders.cartSessionId,
      })
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .for('update');
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (!order.isTest) {
      throw new DomainError('NOT_A_TEST_ORDER', 'Only test orders can be deleted', 409);
    }
    const kept = (blocker: TestOrderBlocker): DeleteOutcome => ({
      result: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        deleted: false,
        blocker,
      },
      released: [],
      objectKeys: [],
    });

    const [invoiceRow] = await tx
      .select({ n: count() })
      .from(invoices)
      .where(eq(invoices.orderId, order.id));
    if ((invoiceRow?.n ?? 0) > 0) return kept('INVOICE_EXISTS');

    // Real money (also refunded since, also bank allocations) makes the order a financial record.
    if (await moneyEverCaptured(tx, order.id)) return kept('MONEY_CAPTURED');
    const paymentRows = await tx
      .select({
        id: payments.id,
        status: payments.status,
        providerOrderId: payments.providerOrderId,
      })
      .from(payments)
      .where(eq(payments.orderId, order.id));
    // A started PayPal payment can still be approved / captured: keep the order, it is the
    // anchor for late-capture reconciliation (cancel it and let the approval window pass first).
    if (
      paymentRows.some(
        (p) => (p.status === 'CREATED' || p.status === 'APPROVED') && p.providerOrderId !== null,
      )
    ) {
      return kept('PAYMENT_OPEN');
    }

    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    const ticketRows = await tx
      .select({ pdfObjectKey: tickets.pdfObjectKey })
      .from(tickets)
      .where(eq(tickets.orderId, order.id));
    const holding = items.filter((i) =>
      (INVENTORY_HOLDING_ITEM_STATUSES as readonly string[]).includes(i.status),
    );

    // Standing areas: give the spots back to the DB capacity counter.
    const gaBySection = new Map<string, number>();
    for (const item of holding) {
      if (item.kind === 'GENERAL_ADMISSION') {
        gaBySection.set(item.sectionId, (gaBySection.get(item.sectionId) ?? 0) + 1);
      }
    }
    for (const [sectionId, n] of gaBySection) {
      await tx
        .update(seatMapSections)
        .set({ allocatedCount: sql`GREATEST(${seatMapSections.allocatedCount} - ${n}, 0)` })
        .where(eq(seatMapSections.id, sectionId));
    }

    // Bank transactions never hold an allocation of this order (no captured money, checked
    // above), but the review candidates of ANY transaction may still name it: drop it from all.
    await tx.execute(sql`
      UPDATE bank_transactions
         SET match_candidates = coalesce(
               (SELECT jsonb_agg(c) FROM jsonb_array_elements(match_candidates) c
                 WHERE c->>'orderId' <> ${order.id}),
               '[]'::jsonb)
       WHERE match_candidates IS NOT NULL
         AND match_candidates @> ${JSON.stringify([{ orderId: order.id }])}::jsonb`);
    // Access codes: the redemptions the order's shop session made for the codes of its items are
    // released and the codes' counters lowered – a single-use code must be usable again (the
    // `order_id` FK would only be set NULL and the code would stay consumed).
    const codeIds = [...new Set(items.flatMap((i) => (i.accessCodeId ? [i.accessCodeId] : [])))];
    const releasedRedemptions = await tx
      .delete(accessCodeRedemptions)
      .where(
        or(
          eq(accessCodeRedemptions.orderId, order.id),
          codeIds.length > 0 && order.cartSessionId
            ? and(
                inArray(accessCodeRedemptions.accessCodeId, codeIds),
                eq(accessCodeRedemptions.sessionId, order.cartSessionId),
              )
            : undefined,
        ),
      )
      .returning({ accessCodeId: accessCodeRedemptions.accessCodeId });
    const perCode = new Map<string, number>();
    for (const r of releasedRedemptions) {
      perCode.set(r.accessCodeId, (perCode.get(r.accessCodeId) ?? 0) + 1);
    }
    for (const [codeId, n] of perCode) {
      await tx
        .update(accessCodes)
        .set({ redemptionCount: sql`GREATEST(${accessCodes.redemptionCount} - ${n}, 0)` })
        .where(eq(accessCodes.id, codeId));
    }

    // FK order: refunds → payments → adjustments → e-mail outbox (set null otherwise) → order
    // (items, fees, tickets, history cascade).
    await tx.delete(refunds).where(eq(refunds.orderId, order.id));
    await tx.delete(payments).where(eq(payments.orderId, order.id));
    await tx.delete(orderAdjustments).where(eq(orderAdjustments.orderId, order.id));
    await tx.delete(emailMessages).where(eq(emailMessages.orderId, order.id));
    await tx.delete(orders).where(eq(orders.id, order.id));
    // Devices may hold the deleted tickets: a new sync epoch makes them drop and re-sync.
    if (ticketRows.length > 0) await rotateSyncEpoch(tx);
    await tx.insert(auditLogs).values({
      actorType: 'ADMIN',
      actorUserId: params.userId,
      action: 'order.test.delete',
      entityType: 'order',
      entityId: order.id,
      changes: null,
      metadata: {
        orderNumber: order.orderNumber,
        status: order.status,
        paymentMethod: order.paymentMethod,
        items: items.length,
        payments: paymentRows.length,
        tickets: ticketRows.length,
      },
    });
    return {
      result: { orderId: order.id, orderNumber: order.orderNumber, deleted: true },
      released: holding.map((i) => ({
        seatId: i.seatId,
        eventId: i.eventId,
        sectionId: i.sectionId,
        kind: i.kind,
      })),
      objectKeys: [...new Set(ticketRows.flatMap((t) => (t.pdfObjectKey ? [t.pdfObjectKey] : [])))],
    };
  });

  if (outcome.result.deleted) {
    await releaseInventory(ctx, outcome.released);
    const storage = ctx.storage ?? null;
    if (storage) {
      for (const key of outcome.objectKeys) {
        await storage.delete('documents', key).catch((err: unknown) => {
          coreLog.warn({ err, key }, '[test-orders] stored ticket PDF could not be deleted');
        });
      }
    }
  }
  return outcome.result;
}

export interface TestOrderBulkDeleteResult {
  deleted: number;
  /** Test orders that stay: with money they can only be cancelled (`MONEY_CAPTURED`). */
  kept: TestOrderDeleteResult[];
}

/**
 * Deletes every money-free test order of an event (multi-event test orders are deleted
 * entirely, including their items of the other draft events); reports the ones that had to stay.
 */
export async function deleteTestOrdersOfEvent(
  ctx: CoreContext,
  params: { eventId: string; userId: string },
): Promise<TestOrderBulkDeleteResult> {
  const rows = await ctx.db
    .selectDistinct({ id: orders.id })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orderItems.eventId, params.eventId),
        eq(orders.isTest, true),
        isNull(orders.testHiddenAt),
      ),
    );
  let deleted = 0;
  const kept: TestOrderDeleteResult[] = [];
  for (const { id } of rows) {
    try {
      const result = await deleteTestOrder(ctx, { orderId: id, userId: params.userId });
      if (result.deleted) deleted += 1;
      else kept.push(result);
    } catch (err) {
      // Deleted by a parallel request in the meantime: nothing left to do for this one.
      if (err instanceof DomainError && err.code === 'ORDER_NOT_FOUND') continue;
      throw err;
    }
  }
  return { deleted, kept };
}

export interface CancelAndHideResult {
  orderId: string;
  orderNumber: string;
  /** Money that is paid back (or open for a manual refund) by the cancellation. */
  refundTotal: number;
  hidden: true;
}

/**
 * Test order with real money: cancels it through the normal flow (paid orders: refunds as usual,
 * PayPal automatically, bank transfers as an open refund to-do – no invoice, so no credit note;
 * unpaid orders: plain cancellation) and hides it from the default order list. Idempotent.
 */
export async function cancelAndHideTestOrder(
  ctx: CoreContext,
  params: { orderId: string; userId: string; refundFees?: boolean },
): Promise<CancelAndHideResult> {
  const [order] = await ctx.db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      isTest: orders.isTest,
      status: orders.status,
      amountPaid: orders.amountPaid,
    })
    .from(orders)
    .where(eq(orders.id, params.orderId));
  if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
  if (!order.isTest) {
    throw new DomainError('NOT_A_TEST_ORDER', 'Only test orders can be cancelled this way', 409);
  }
  let refundTotal = 0;
  if (order.status === 'PAID' || order.status === 'PARTIALLY_REFUNDED') {
    const [active] = await ctx.db
      .select({ n: count() })
      .from(orderItems)
      .where(and(eq(orderItems.orderId, order.id), eq(orderItems.status, 'CONFIRMED')));
    // Everything refunded already (PARTIALLY_REFUNDED with no active ticket): only hide.
    if ((active?.n ?? 0) > 0) {
      const result = await cancelPaidOrder(ctx, {
        orderId: order.id,
        refundFees: params.refundFees ?? true,
        reason: 'TEST_ORDER',
        notify: false,
        userId: params.userId,
      });
      refundTotal = result.refundTotal;
    }
  } else if (order.status === 'PENDING' || order.status === 'AWAITING_PAYMENT') {
    if (order.amountPaid > 0) {
      throw new DomainError(
        'TEST_ORDER_PARTIAL_PAYMENT',
        'The order holds a partial payment: pay it back (reverse the bank allocation) first',
        409,
      );
    }
    await cancelOrder(ctx, {
      orderId: order.id,
      status: 'CANCELLED',
      reason: 'TEST_ORDER',
      actor: { type: 'ADMIN', userId: params.userId },
      notifyCustomer: false,
    });
  }
  const now = new Date();
  await withTransaction(ctx.db, async (tx) => {
    await tx
      .update(orders)
      .set({ testHiddenAt: now })
      .where(and(eq(orders.id, order.id), isNull(orders.testHiddenAt)));
    await tx.insert(auditLogs).values({
      actorType: 'ADMIN',
      actorUserId: params.userId,
      action: 'order.test.cancel_hide',
      entityType: 'order',
      entityId: order.id,
      changes: null,
      metadata: { orderNumber: order.orderNumber, from: order.status, refundTotal },
    });
  });
  return { orderId: order.id, orderNumber: order.orderNumber, refundTotal, hidden: true };
}

export interface ChangeEventStatusParams {
  eventId: string;
  status: EventStatus;
  cancellationReason?: string | null;
}

/**
 * The ONLY writer of `events.status` (the admin action calls it). Going live (any non-live status
 * → PUBLISHED / POSTPONED) is guarded for events that had test purchases:
 *  - refused (`TEST_ORDERS_PRESENT`) while a test order that is not cancelled & hidden exists –
 *    delete them first. Cancelled & hidden ones (money held, tickets void, seats released) are
 *    inert and do not block;
 *  - when the event EVER had test orders, all its ticket signing keys are revoked and a fresh one
 *    is created in the same transaction, so QR codes of test tickets fail verification (also
 *    offline, after the scanner's next manifest sync). Refused (`TEST_KEY_ROTATION_REAL_TICKETS`)
 *    when real (non-test) tickets exist: the rotation would invalidate them.
 * The event row is locked FOR UPDATE; test checkouts take the same lock through their UPDATE.
 */
export async function changeEventStatus(
  ctx: CoreContext,
  params: ChangeEventStatusParams,
): Promise<{ from: EventStatus; rotatedKeys: number }> {
  return withTransaction(ctx.db, async (tx) => {
    const [event] = await tx
      .select({
        id: events.id,
        status: events.status,
        hadTestOrders: events.hadTestOrders,
        publishedAt: events.publishedAt,
        cancelledAt: events.cancelledAt,
      })
      .from(events)
      .where(eq(events.id, params.eventId))
      .for('update');
    if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
    const live = (s: EventStatus) => s === 'PUBLISHED' || s === 'POSTPONED';
    let rotatedKeys = 0;
    if (live(params.status) && !live(event.status)) {
      const [tests] = await tx
        .select({ n: sql<number>`count(DISTINCT ${orders.id})::int` })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(
          and(
            eq(orderItems.eventId, event.id),
            eq(orders.isTest, true),
            isNull(orders.testHiddenAt),
          ),
        );
      if ((tests?.n ?? 0) > 0) {
        throw new DomainError(
          'TEST_ORDERS_PRESENT',
          'The event still has test orders – delete them before publishing',
          409,
          { orders: tests!.n },
        );
      }
      if (event.hadTestOrders) {
        const [real] = await tx
          .select({ n: count() })
          .from(tickets)
          .innerJoin(orders, eq(orders.id, tickets.orderId))
          .where(and(eq(tickets.eventId, event.id), eq(orders.isTest, false)));
        if ((real?.n ?? 0) > 0) {
          throw new DomainError(
            'TEST_KEY_ROTATION_REAL_TICKETS',
            'The event had test purchases and already has real tickets: its ticket key cannot be rotated',
            409,
            { tickets: real!.n },
          );
        }
        rotatedKeys = await revokeAllEventSigningKeysTx(ctx, tx, event.id);
      }
    }
    const now = new Date();
    await tx
      .update(events)
      .set({
        status: params.status,
        publishedAt: params.status === 'PUBLISHED' && !event.publishedAt ? now : event.publishedAt,
        cancelledAt: params.status === 'CANCELLED' ? (event.cancelledAt ?? now) : null,
        cancellationReason:
          params.status === 'CANCELLED' ? (params.cancellationReason ?? null) : null,
      })
      .where(eq(events.id, event.id));
    return { from: event.status, rotatedKeys };
  });
}

/** True when the session's cart holds seats of a DRAFT event (the checkout would create a test order). */
export async function cartHasDraftEvents(ctx: CoreContext, sessionId: string): Promise<boolean> {
  const eventIds = await cartEventIds(ctx, sessionId);
  if (eventIds.length === 0) return false;
  const [row] = await ctx.db
    .select({ id: events.id })
    .from(events)
    .where(and(inArray(events.id, eventIds), eq(events.status, 'DRAFT')))
    .limit(1);
  return Boolean(row);
}
