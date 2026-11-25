import {
  auditLogs,
  eventCancellationRuns,
  events,
  orderFees,
  orderItems,
  orders,
  venues,
  type Database,
  type Executor,
} from '@tix/db';
import type { PaymentMethod } from '@tix/shared';
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, requireCapability, type CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage, type EmailAttachment } from '../email';
import { formatDateTime, formatMoney } from '../format';
import { QUEUE_NAMES } from '../job-queues';
import { coreLog } from '../log';
import { cancelOrder } from './fulfillment';
import { cancelPaidOrder } from './refunds';
import { changeEventStatus } from './test-orders';

/**
 * Event cancellation assistant: cancels EVERY active order / ticket of a CANCELLED event.
 *
 * Rules (client decisions)
 *  - Unpaid orders (PENDING / AWAITING_PAYMENT, nothing paid, only tickets of this event) are
 *    cancelled and their seats released.
 *  - Paid orders (PAID / PARTIALLY_REFUNDED): only the tickets of THIS event are cancelled through
 *    the normal paid-cancellation (credit note, refund rows: PayPal automatic, everything else an
 *    open refund to-do). Fees are refunded (the assistant defaults to "refund fees").
 *  - Unpaid orders that also hold tickets of OTHER events, or that already received a partial
 *    payment, need a manual decision (repricing / paying back money): they are left alone and
 *    counted as `manualOrders`.
 *  - Test orders (super-admin test purchases) are never touched.
 *  - One EVENT_CANCELLED mail per cancelled order (created in the cancellation transaction, so a
 *    re-run can never send it twice). Holders of handed-over tickets get the usual
 *    "ticket no longer valid" mail from the ticket void.
 *
 * The run row is progress / audit only. The work is derived from the live data in every pass, so a
 * run is idempotent and resumable (a second run simply finds nothing left).
 */

export const EVENT_CANCELLATION_JOB = 'run-event-cancellation';
const ACTIVE_ITEM_STATUSES = ['PENDING', 'CONFIRMED'] as const;
const OPEN_ORDER_STATUSES = ['PENDING', 'AWAITING_PAYMENT'] as const;
const PAID_ORDER_STATUSES = ['PAID', 'PARTIALLY_REFUNDED'] as const;
const BATCH = 25;
const MAX_PASSES = 5;
/** A RUNNING run without a heartbeat for this long is picked up again by the sweeper. */
export const STALE_RUN_AFTER_MS = 10 * 60 * 1000;

type Class = 'UNPAID_CANCEL' | 'UNPAID_MANUAL' | 'PAID';

interface Candidate {
  id: string;
  status: (typeof orders.$inferSelect)['status'];
  paymentMethod: PaymentMethod;
  amountPaid: number;
  thisItems: number;
  thisGross: number;
  otherItems: number;
}

function classify(c: Candidate): Class {
  if ((PAID_ORDER_STATUSES as readonly string[]).includes(c.status)) return 'PAID';
  return c.otherItems > 0 || c.amountPaid > 0 ? 'UNPAID_MANUAL' : 'UNPAID_CANCEL';
}

/** Orders with active tickets of the event (test orders excluded), keyset-paged by id. */
async function loadCandidates(
  db: Executor,
  eventId: string,
  options: { afterId?: string | null; limit?: number } = {},
): Promise<Candidate[]> {
  const thisEvent = sql`${orderItems.eventId} = ${eventId}`;
  const rows = await db
    .select({
      id: orders.id,
      status: orders.status,
      paymentMethod: orders.paymentMethod,
      amountPaid: orders.amountPaid,
      thisItems: sql<number>`(count(*) FILTER (WHERE ${thisEvent}))::int`,
      thisGross: sql<number>`(coalesce(sum(${orderItems.priceGross}) FILTER (WHERE ${thisEvent}), 0))::int`,
      otherItems: sql<number>`(count(*) FILTER (WHERE NOT (${thisEvent})))::int`,
    })
    .from(orders)
    .innerJoin(
      orderItems,
      and(eq(orderItems.orderId, orders.id), inArray(orderItems.status, [...ACTIVE_ITEM_STATUSES])),
    )
    .where(
      and(
        eq(orders.isTest, false),
        inArray(orders.status, [...OPEN_ORDER_STATUSES, ...PAID_ORDER_STATUSES]),
        options.afterId ? gt(orders.id, options.afterId) : undefined,
      ),
    )
    .groupBy(orders.id)
    .having(sql`count(*) FILTER (WHERE ${thisEvent}) > 0`)
    .orderBy(asc(orders.id))
    .limit(options.limit ?? 1_000_000);
  return rows as Candidate[];
}

export interface EventCancellationPreview {
  /** Unpaid orders that will be cancelled. */
  unpaid: { orders: number; tickets: number };
  /** Unpaid orders that need a manual decision (other events in the order / partly paid). */
  manual: { orders: number; tickets: number };
  /** Paid orders: tickets of this event are cancelled and refunded. */
  paid: {
    orders: number;
    tickets: number;
    /** Value of the event's tickets (gross). */
    ticketsGross: number;
    /** Fee lines that belong to this event (refunded when "refund fees" is on). */
    feesGross: number;
    /** Orders and ticket value per payment method (PAYPAL refunds automatically). */
    byMethod: { method: PaymentMethod; orders: number; gross: number }[];
    /** Orders that also contain tickets of other events (those stay valid). */
    multiEventOrders: number;
  };
  /** A cancellation run is currently working on the event. */
  runningRunId: string | null;
}

export async function previewEventCancellation(
  ctx: CoreContext,
  eventId: string,
): Promise<EventCancellationPreview> {
  const [event] = await ctx.db.select({ id: events.id }).from(events).where(eq(events.id, eventId));
  if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  const candidates = await loadCandidates(ctx.db, eventId);
  const preview: EventCancellationPreview = {
    unpaid: { orders: 0, tickets: 0 },
    manual: { orders: 0, tickets: 0 },
    paid: {
      orders: 0,
      tickets: 0,
      ticketsGross: 0,
      feesGross: 0,
      byMethod: [],
      multiEventOrders: 0,
    },
    runningRunId: null,
  };
  const methods = new Map<PaymentMethod, { orders: number; gross: number }>();
  const paidIds: string[] = [];
  for (const c of candidates) {
    const kind = classify(c);
    if (kind === 'UNPAID_CANCEL') {
      preview.unpaid.orders += 1;
      preview.unpaid.tickets += c.thisItems;
    } else if (kind === 'UNPAID_MANUAL') {
      preview.manual.orders += 1;
      preview.manual.tickets += c.thisItems;
    } else {
      paidIds.push(c.id);
      preview.paid.orders += 1;
      preview.paid.tickets += c.thisItems;
      preview.paid.ticketsGross += c.thisGross;
      if (c.otherItems > 0) preview.paid.multiEventOrders += 1;
      const entry = methods.get(c.paymentMethod) ?? { orders: 0, gross: 0 };
      entry.orders += 1;
      entry.gross += c.thisGross;
      methods.set(c.paymentMethod, entry);
    }
  }
  preview.paid.byMethod = [...methods].map(([method, v]) => ({ method, ...v }));
  if (paidIds.length > 0) {
    const [fees] = await ctx.db
      .select({ total: sql<number>`coalesce(sum(${orderFees.totalGross}), 0)::int` })
      .from(orderFees)
      .where(
        and(
          eq(orderFees.eventId, eventId),
          eq(orderFees.isRefunded, false),
          inArray(orderFees.orderId, paidIds),
        ),
      );
    preview.paid.feesGross = fees?.total ?? 0;
  }
  const [running] = await ctx.db
    .select({ id: eventCancellationRuns.id })
    .from(eventCancellationRuns)
    .where(
      and(eq(eventCancellationRuns.eventId, eventId), eq(eventCancellationRuns.status, 'RUNNING')),
    );
  preview.runningRunId = running?.id ?? null;
  return preview;
}

export interface StartEventCancellationParams {
  eventId: string;
  reason?: string | null;
  /** Refund the fees as well (the assistant defaults to true). */
  refundFees: boolean;
  /** Send the EVENT_CANCELLED mail to every affected buyer. */
  notify: boolean;
  userId: string;
}

/**
 * Marks the event CANCELLED (the only status writer, `changeEventStatus`) and creates the run that
 * cancels its orders. Returns the already running run of the event when there is one. The caller
 * enqueues the job (`enqueueEventCancellationRun`) after this returned.
 */
export async function startEventCancellation(
  ctx: CoreContext,
  params: StartEventCancellationParams,
): Promise<{ runId: string; alreadyRunning: boolean }> {
  const [event] = await ctx.db
    .select({ id: events.id, status: events.status, reason: events.cancellationReason })
    .from(events)
    .where(eq(events.id, params.eventId));
  if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  if (event.status === 'ARCHIVED') {
    throw new DomainError('EVENT_ARCHIVED', 'An archived event cannot be cancelled', 409);
  }
  const [running] = await ctx.db
    .select({ id: eventCancellationRuns.id })
    .from(eventCancellationRuns)
    .where(
      and(
        eq(eventCancellationRuns.eventId, params.eventId),
        eq(eventCancellationRuns.status, 'RUNNING'),
      ),
    );
  if (running) return { runId: running.id, alreadyRunning: true };

  const reason = params.reason?.trim() || event.reason || null;
  await changeEventStatus(ctx, {
    eventId: params.eventId,
    status: 'CANCELLED',
    cancellationReason: reason,
  });
  const candidates = await loadCandidates(ctx.db, params.eventId);
  try {
    const [run] = await ctx.db
      .insert(eventCancellationRuns)
      .values({
        eventId: params.eventId,
        refundFees: params.refundFees,
        notify: params.notify,
        reason,
        startedByUserId: params.userId,
        totalOrders: candidates.length,
      })
      .returning({ id: eventCancellationRuns.id });
    return { runId: run!.id, alreadyRunning: false };
  } catch (err) {
    // Lost the race against a concurrent start (unique RUNNING run per event).
    const [other] = await ctx.db
      .select({ id: eventCancellationRuns.id })
      .from(eventCancellationRuns)
      .where(
        and(
          eq(eventCancellationRuns.eventId, params.eventId),
          eq(eventCancellationRuns.status, 'RUNNING'),
        ),
      );
    if (other) return { runId: other.id, alreadyRunning: true };
    throw err;
  }
}

export const eventCancellationJobId = (runId: string) => `event-cancel-${runId}`;

/**
 * Queues the run on the worker under one stable job id. A job that is still waiting / in back-off
 * / running is left alone; a finished or failed one is replaced, so "resume" always queues work.
 * Returns false when a live job already exists.
 */
export async function enqueueEventCancellationRun(
  ctx: CoreContext,
  runId: string,
): Promise<boolean> {
  const jobs = requireCapability(ctx, 'jobs');
  return jobs.addUnlessLive(
    QUEUE_NAMES.refunds,
    EVENT_CANCELLATION_JOB,
    { runId },
    {
      jobId: eventCancellationJobId(runId),
      attempts: 20,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  );
}

/**
 * Sweeper: re-queues RUNNING runs without a heartbeat for a while whose job is gone (a job that
 * is only waiting in its retry back-off is not duplicated).
 */
export async function resumeStaleEventCancellationRuns(ctx: CoreContext): Promise<number> {
  const stale = await ctx.db
    .select({ id: eventCancellationRuns.id })
    .from(eventCancellationRuns)
    .where(
      and(
        eq(eventCancellationRuns.status, 'RUNNING'),
        lt(eventCancellationRuns.heartbeatAt, new Date(Date.now() - STALE_RUN_AFTER_MS)),
      ),
    );
  let requeued = 0;
  for (const run of stale) {
    if (!(await enqueueEventCancellationRun(ctx, run.id))) continue;
    await ctx.db
      .update(eventCancellationRuns)
      .set({ heartbeatAt: new Date() })
      .where(eq(eventCancellationRuns.id, run.id));
    requeued += 1;
  }
  return requeued;
}

export interface EventCancellationRunView {
  id: string;
  status: string;
  refundFees: boolean;
  notify: boolean;
  reason: string | null;
  totalOrders: number;
  cancelledOrders: number;
  manualOrders: number;
  failedOrders: number;
  lastError: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export async function listEventCancellationRuns(
  db: Database,
  eventId: string,
): Promise<EventCancellationRunView[]> {
  return db
    .select({
      id: eventCancellationRuns.id,
      status: eventCancellationRuns.status,
      refundFees: eventCancellationRuns.refundFees,
      notify: eventCancellationRuns.notify,
      reason: eventCancellationRuns.reason,
      totalOrders: eventCancellationRuns.totalOrders,
      cancelledOrders: eventCancellationRuns.cancelledOrders,
      manualOrders: eventCancellationRuns.manualOrders,
      failedOrders: eventCancellationRuns.failedOrders,
      lastError: eventCancellationRuns.lastError,
      createdAt: eventCancellationRuns.createdAt,
      finishedAt: eventCancellationRuns.finishedAt,
    })
    .from(eventCancellationRuns)
    .where(eq(eventCancellationRuns.eventId, eventId))
    .orderBy(desc(eventCancellationRuns.createdAt))
    .limit(10);
}

type OrderOutcome = 'CANCELLED' | 'MANUAL' | 'SKIPPED' | 'FAILED';

interface RunContext {
  run: typeof eventCancellationRuns.$inferSelect;
  event: { id: string; title: string; startsAt: Date; timeZone: string; venue: string };
}

/** Variables that name THE event (an order can span several; `events[0]` would be wrong). */
function eventVariables(rc: RunContext, order: { locale: string }, reason: string | null) {
  return {
    eventTitle: rc.event.title,
    eventDate: formatDateTime(rc.event.startsAt, order.locale, rc.event.timeZone),
    eventVenue: rc.event.venue,
    eventCancellationReason: reason,
  };
}

/** Same rule as the outbox (`createEmailMessage` refuses anything else with INVALID_RECIPIENT). */
const emailAddress = z.email();
const mailable = (email: string | null) =>
  Boolean(email?.trim()) && emailAddress.safeParse(email!.trim()).success;

async function processOrder(
  ctx: CoreContext,
  rc: RunContext,
  candidate: Candidate,
): Promise<{ outcome: OrderOutcome; error?: string; noticeSkipped?: boolean }> {
  const kind = classify(candidate);
  if (kind === 'UNPAID_MANUAL') return { outcome: 'MANUAL' };
  const [order] = await ctx.db
    .select({
      id: orders.id,
      email: orders.email,
      locale: orders.locale,
      currency: orders.currency,
    })
    .from(orders)
    .where(eq(orders.id, candidate.id));
  if (!order) return { outcome: 'SKIPPED' };
  const reason = rc.run.reason;
  const userId = rc.run.startedByUserId;
  // An unusable address must never roll back the cancellation / refund: no notice, counted.
  // No address at all (box office without buyer data) is normal and silent; only a stored but
  // invalid address counts as a skipped notice.
  const notify = rc.run.notify && mailable(order.email);
  const noticeSkipped = rc.run.notify && !notify && Boolean(order.email?.trim());
  if (noticeSkipped) {
    coreLog.warn(
      { orderId: order.id },
      '[event-cancellation] invalid e-mail address, notice skipped',
    );
  }

  if (kind === 'UNPAID_CANCEL') {
    const done = await cancelOrder(ctx, {
      orderId: order.id,
      status: 'CANCELLED',
      reason: 'EVENT_CANCELLED',
      actor: { type: userId ? 'ADMIN' : 'SYSTEM', userId },
      // The candidate was classified from an unlocked snapshot: re-checked on the locked row.
      onlyIfNothingPaid: { eventId: rc.event.id },
      notifyCustomer: notify,
      notification: {
        key: 'EVENT_CANCELLED',
        eventId: rc.event.id,
        attachments: [],
        variables: {
          ...eventVariables(rc, order, reason),
          orderWasUnpaid: 'yes',
          cancelledTicketCount: candidate.thisItems,
        },
      },
    });
    // Paid / partly paid / extended to another event in the meantime: the next pass classifies
    // it again from fresh data (refund path or manual decision).
    if (!done) return { outcome: 'SKIPPED' };
    await ctx.db.insert(auditLogs).values({
      actorType: userId ? 'ADMIN' : 'SYSTEM',
      actorUserId: userId,
      action: 'order.event_cancelled',
      entityType: 'order',
      entityId: order.id,
      changes: null,
      metadata: {
        eventId: rc.event.id,
        runId: rc.run.id,
        paid: false,
        ...(noticeSkipped ? { noticeSkipped: true } : {}),
      },
    });
    return { outcome: 'CANCELLED', noticeSkipped };
  }

  if (!userId) {
    return { outcome: 'FAILED', error: 'NO_ACTOR: the admin who started the run no longer exists' };
  }
  const items = await ctx.db
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(
      and(
        eq(orderItems.orderId, order.id),
        eq(orderItems.eventId, rc.event.id),
        eq(orderItems.status, 'CONFIRMED'),
      ),
    );
  if (items.length === 0) return { outcome: 'SKIPPED' };
  let messageId: string | null = null;
  try {
    await cancelPaidOrder(ctx, {
      orderId: order.id,
      orderItemIds: items.map((i) => i.id),
      refundFees: rc.run.refundFees,
      reason: reason ?? 'EVENT_CANCELLED',
      notify: false,
      userId,
      inTransaction: async (tx, result) => {
        messageId = null;
        if (notify) {
          const attachments: EmailAttachment[] = result.creditNote
            ? [{ type: 'invoice', invoiceId: result.creditNote.id }]
            : [];
          messageId = await createEmailMessage(ctx, tx, {
            key: 'EVENT_CANCELLED',
            orderId: order.id,
            // `mailable` judged the trimmed address; the outbox validates `to` as given.
            to: order.email!.trim(),
            eventId: rc.event.id,
            attachments,
            variables: {
              ...eventVariables(rc, order, reason),
              cancelledTicketCount: result.cancelledItems,
              refundAmount:
                result.refundTotal > 0
                  ? formatMoney(result.refundTotal, order.currency, order.locale)
                  : null,
              creditNoteNumber: result.creditNote?.number ?? null,
              refundViaPaypal: result.refunds.some((r) => r.kind === 'AUTOMATIC') ? 'yes' : null,
              refundManual: result.refunds.some((r) => r.kind === 'MANUAL') ? 'yes' : null,
            },
          });
        }
        await tx.insert(auditLogs).values({
          actorType: 'ADMIN',
          actorUserId: userId,
          action: 'order.event_cancelled',
          entityType: 'order',
          entityId: order.id,
          changes: null,
          metadata: {
            eventId: rc.event.id,
            runId: rc.run.id,
            paid: true,
            tickets: result.cancelledItems,
            creditTotal: result.creditTotal,
            refundTotal: result.refundTotal,
            creditNote: result.creditNote?.number ?? null,
            ...(noticeSkipped ? { noticeSkipped: true } : {}),
          },
        });
      },
    });
  } catch (err) {
    if (err instanceof DomainError) {
      // Cancelled / refunded meanwhile (concurrent admin action or a second worker): nothing to do.
      if (err.code === 'ORDER_NOT_REFUNDABLE' || err.code === 'ITEMS_NOT_REFUNDABLE') {
        return { outcome: 'SKIPPED' };
      }
      return { outcome: 'FAILED', error: `${err.code}: ${err.message}` };
    }
    throw err;
  }
  if (messageId) {
    await dispatchEmailMessage(ctx, messageId).catch((err: unknown) =>
      coreLog.error({ err }, '[event-cancellation] mail stored but not queued (outbox retries)'),
    );
  }
  return { outcome: 'CANCELLED', noticeSkipped };
}

export interface EventCancellationRunResult {
  status: 'RUNNING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS';
  cancelledOrders: number;
  manualOrders: number;
  failedOrders: number;
}

/**
 * Works the run off in passes over the live order data (keyset-paged, one order at a time).
 * Orders that fail (e.g. a refund review is open) are recorded and skipped, the rest continues;
 * the next pass also picks up orders that were paid while the run was working. `maxOrders` bounds
 * one invocation (the caller re-enqueues while the result is still RUNNING).
 */
export async function runEventCancellation(
  ctx: CoreContext,
  runId: string,
  options: { maxOrders?: number } = {},
): Promise<EventCancellationRunResult> {
  const [run] = await ctx.db
    .select()
    .from(eventCancellationRuns)
    .where(eq(eventCancellationRuns.id, runId));
  if (!run) throw new DomainError('RUN_NOT_FOUND', 'Cancellation run not found', 404);
  const summary = (r: typeof run): EventCancellationRunResult => ({
    status: r.status as EventCancellationRunResult['status'],
    cancelledOrders: r.cancelledOrders,
    manualOrders: r.manualOrders,
    failedOrders: r.failedOrders,
  });
  if (run.status !== 'RUNNING') return summary(run);

  const [eventRow] = await ctx.db
    .select({
      id: events.id,
      title: events.title,
      startsAt: events.startsAt,
      timeZone: events.timeZone,
      venueName: venues.name,
      venueCity: venues.city,
      status: events.status,
    })
    .from(events)
    .innerJoin(venues, eq(venues.id, events.venueId))
    .where(eq(events.id, run.eventId));
  if (!eventRow) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  if (eventRow.status !== 'CANCELLED') {
    // The event was taken back (re-published / postponed): retrying can never succeed, so the
    // run ends here instead of failing forever (`changeEventStatus` refuses this while a run is
    // RUNNING; this covers a status change that slipped in before the run row existed).
    const message = `EVENT_NOT_CANCELLED: the event is ${eventRow.status}, nothing was cancelled by this pass`;
    const [ended] = await ctx.db
      .update(eventCancellationRuns)
      .set({
        status: 'COMPLETED_WITH_ERRORS',
        lastError: message,
        finishedAt: new Date(),
        heartbeatAt: new Date(),
      })
      .where(and(eq(eventCancellationRuns.id, run.id), eq(eventCancellationRuns.status, 'RUNNING')))
      .returning();
    if (ended) {
      await ctx.db.insert(auditLogs).values({
        actorType: 'SYSTEM',
        action: 'event.cancellation.finished',
        entityType: 'event',
        entityId: run.eventId,
        changes: null,
        metadata: { runId: run.id, status: ended.status, error: 'EVENT_NOT_CANCELLED' },
      });
    }
    const [fresh] = await ctx.db
      .select()
      .from(eventCancellationRuns)
      .where(eq(eventCancellationRuns.id, run.id));
    return summary(fresh!);
  }
  const rc: RunContext = {
    run,
    event: {
      id: eventRow.id,
      title: eventRow.title,
      startsAt: eventRow.startsAt,
      timeZone: eventRow.timeZone,
      venue: [eventRow.venueName, eventRow.venueCity].filter(Boolean).join(', '),
    },
  };

  const budget = options.maxOrders ?? Number.POSITIVE_INFINITY;
  let handled = 0;
  let manual = 0;
  let failed = 0;
  let lastError: string | null = null;
  let finishedPasses = 0;
  let noticesSkipped = 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let cursor: string | null = null;
    let cancelledInPass = 0;
    let skippedInPass = 0;
    manual = 0;
    failed = 0;
    lastError = null;
    for (;;) {
      const batch = await loadCandidates(ctx.db, run.eventId, { afterId: cursor, limit: BATCH });
      if (batch.length === 0) break;
      for (const candidate of batch) {
        cursor = candidate.id;
        let result: Awaited<ReturnType<typeof processOrder>>;
        try {
          result = await processOrder(ctx, rc, candidate);
        } catch (err) {
          result = { outcome: 'FAILED', error: err instanceof Error ? err.message : String(err) };
          coreLog.error({ err, orderId: candidate.id }, '[event-cancellation] order failed');
        }
        if (result.noticeSkipped) noticesSkipped += 1;
        if (result.outcome === 'SKIPPED') skippedInPass += 1;
        if (result.outcome === 'CANCELLED') {
          cancelledInPass += 1;
          await ctx.db
            .update(eventCancellationRuns)
            .set({
              cancelledOrders: sql`${eventCancellationRuns.cancelledOrders} + 1`,
              heartbeatAt: new Date(),
            })
            .where(eq(eventCancellationRuns.id, run.id));
        } else if (result.outcome === 'MANUAL') manual += 1;
        else if (result.outcome === 'FAILED') {
          failed += 1;
          lastError = result.error ?? lastError;
        }
        handled += 1;
        if (handled >= budget) {
          await ctx.db
            .update(eventCancellationRuns)
            .set({ heartbeatAt: new Date() })
            .where(eq(eventCancellationRuns.id, run.id));
          const [fresh] = await ctx.db
            .select()
            .from(eventCancellationRuns)
            .where(eq(eventCancellationRuns.id, run.id));
          return summary(fresh!);
        }
      }
      await ctx.db
        .update(eventCancellationRuns)
        .set({ heartbeatAt: new Date() })
        .where(eq(eventCancellationRuns.id, run.id));
    }
    finishedPasses += 1;
    // A pass that neither cancelled anything nor saw an order change under it (SKIPPED, e.g. an
    // unpaid order that was paid meanwhile and now needs the refund path) saw everything that is
    // left: done.
    if (cancelledInPass === 0 && skippedInPass === 0) break;
  }

  // Orders that still need automatic work after the last pass (kept changing, or are skipped for
  // a reason a pass cannot resolve) must not end in a silent COMPLETED.
  const leftover = (await loadCandidates(ctx.db, run.eventId)).filter(
    (c) => classify(c) !== 'UNPAID_MANUAL',
  ).length;
  if (leftover > 0 && failed === 0) {
    lastError = `ORDERS_LEFT: ${leftover} order(s) of the event still need processing – run the cancellation again`;
  }
  const status = failed > 0 || leftover > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
  const [done] = await ctx.db
    .update(eventCancellationRuns)
    .set({
      status,
      manualOrders: manual,
      failedOrders: failed,
      lastError,
      finishedAt: new Date(),
      heartbeatAt: new Date(),
    })
    .where(and(eq(eventCancellationRuns.id, run.id), eq(eventCancellationRuns.status, 'RUNNING')))
    .returning();
  if (done) {
    await ctx.db.insert(auditLogs).values({
      actorType: 'SYSTEM',
      action: 'event.cancellation.finished',
      entityType: 'event',
      entityId: run.eventId,
      changes: null,
      metadata: {
        runId: run.id,
        status,
        cancelledOrders: done.cancelledOrders,
        manualOrders: manual,
        failedOrders: failed,
        passes: finishedPasses,
        ...(leftover > 0 ? { leftoverOrders: leftover } : {}),
        ...(noticesSkipped > 0 ? { noticesSkipped } : {}),
      },
    });
  }
  const [fresh] = await ctx.db
    .select()
    .from(eventCancellationRuns)
    .where(eq(eventCancellationRuns.id, run.id));
  return summary(fresh!);
}
