import { randomUUID } from 'node:crypto';
import {
  orderHistory,
  orderItems,
  orders,
  payments,
  refundReconcileState,
  refunds,
  withTransaction,
} from '@tix/db';
import { and, asc, desc, eq, exists, gt, gte, inArray, or, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import { QUEUE_NAMES } from '../job-queues';
import {
  getPayPalRefundDetails,
  listPayPalOrderRefunds,
  PayPalApiError,
  type PayPalOrderRefund,
} from '../payments/paypal';
import { failRefund } from './refunds';
import {
  markRefundSucceeded,
  recordRefundReview,
  REFUND_REVIEW_EVENT,
  REFUND_REVIEW_RESOLVED_EVENT,
  resolveRefundReview,
  type RefundReviewFinding,
} from './refund-state';

export {
  REFUND_REVIEW_EVENT,
  REFUND_REVIEW_RESOLVED_EVENT,
  hasOpenRefundReview,
  isRefundReconcilePending,
  type RefundReviewFinding,
  type RefundReviewKind,
} from './refund-state';

/**
 * PayPal refunds after a backup restore.
 *
 * A restore rewinds the database, PayPal keeps its state: a refund that was PENDING (or not even
 * recorded) at backup time may have completed at PayPal since, and refunds executed in the
 * "lost window" have no local row at all.
 *
 * Marker: `refund_reconcile_state` (durable, authoritative, set right after the restore's
 * migrations) plus a Redis flag with the same token (set before the database is replaced; the
 * fast path of the refund jobs). While a marker is set no automatic refund is sent or polled
 * (`REFUNDS_RECONCILING`). A pass clears it only when it completed completely and only for its
 * own token, so a pass that started before a newer restore can never clear the newer marker.
 *
 * Per PayPal order the refunds PayPal lists are compared with the local AUTOMATIC rows (matched by
 * the PayPal refund id or by our refund row id, which we send as `custom_id`; the refund resource
 * is fetched when the order details do not carry it). Per row: COMPLETED beats PENDING beats
 * FAILED/CANCELLED. A row is settled only when amount and currency equal PayPal's. Everything
 * else becomes a review finding (`order_history`, shown on /admin/refunds) and holds the
 * automatic refunds of that order until an admin resolves it – otherwise a second PayPal refund
 * would pay money back that already left.
 */

/** PayPal only refunds captures for about 180 days. */
export const PAYPAL_REFUND_WINDOW_DAYS = 180;
const PAGE_SIZE = 200;
/** Renewed after every order: a crashed pass releases the lock after this long. */
const LOCK_TTL_MS = 2 * 60_000;
const MIN_CHECKED_FOR_ALERT = 5;

interface Flag {
  token: string;
  since: string;
  reason: string;
}

const MOSTLY_NOT_FOUND = 'MOSTLY_NOT_FOUND';

// ─── Marker ─────────────────────────────────────────────────────────────────

/**
 * Sets the marker (Redis flag without TTL + DB row when the table exists). Call it with the same
 * token before and after the database replacement of a restore.
 */
export async function markRefundsForReconciliation(
  ctx: Pick<CoreContext, 'redis' | 'keys' | 'db'>,
  reason: string,
  token: string = randomUUID(),
  /**
   * `pre`: called before the database is replaced – a missing table (42P01, older schema) is fine,
   * the Redis flag covers the gap. `post` (default): every error is rethrown.
   */
  phase: 'pre' | 'post' = 'post',
): Promise<string> {
  const flag: Flag = { token, since: new Date().toISOString(), reason };
  await ctx.redis.set(ctx.keys.refundReconcilePending(), JSON.stringify(flag));
  try {
    await ctx.db
      .insert(refundReconcileState)
      .values({ id: true, pending: true, token, reason, since: new Date() })
      .onConflictDoUpdate({
        target: refundReconcileState.id,
        set: {
          pending: true,
          token,
          reason,
          since: new Date(),
          attempts: 0,
          lastAttemptAt: null,
          lastError: null,
          unchecked: 0,
          alert: null,
        },
      });
  } catch (err) {
    if (!(phase === 'pre' && isUndefinedTable(err))) throw err;
  }
  return token;
}

/** Postgres 42P01 (undefined_table), also when the driver wrapped it (`cause`). */
function isUndefinedTable(err: unknown): boolean {
  for (let e = err as { code?: string; cause?: unknown } | undefined, i = 0; e && i < 4; i += 1) {
    if (e.code === '42P01') return true;
    e = e.cause as typeof e;
  }
  return false;
}

export interface RefundReconcileStatus {
  pending: boolean;
  token: string | null;
  since: Date | null;
  reason: string | null;
  attempts: number;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  unchecked: number;
  alert: string | null;
}

async function readFlag(ctx: Pick<CoreContext, 'redis' | 'keys'>): Promise<Flag | null> {
  const raw = await ctx.redis.get(ctx.keys.refundReconcilePending());
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Flag>;
    return { token: parsed.token ?? '', since: parsed.since ?? '', reason: parsed.reason ?? '' };
  } catch {
    return { token: '', since: '', reason: '' };
  }
}

export async function getRefundReconcileStatus(
  ctx: Pick<CoreContext, 'redis' | 'keys' | 'db'>,
): Promise<RefundReconcileStatus> {
  const [flag, rows] = await Promise.all([
    readFlag(ctx),
    ctx.db
      .select()
      .from(refundReconcileState)
      .catch(() => []),
  ]);
  const row = rows[0];
  const pending = Boolean(row?.pending) || flag !== null;
  return {
    pending,
    token: (row?.pending ? row.token : null) ?? flag?.token ?? null,
    since: row?.since ?? (flag?.since ? new Date(flag.since) : null),
    reason: row?.reason ?? flag?.reason ?? null,
    attempts: row?.attempts ?? 0,
    lastAttemptAt: row?.lastAttemptAt ?? null,
    lastSuccessAt: row?.lastSuccessAt ?? null,
    lastError: row?.lastError ?? null,
    unchecked: row?.unchecked ?? 0,
    alert: row?.alert ?? null,
  };
}

/** Deletes the Redis flag only while it still carries `token` (compare-and-delete). */
async function clearFlagIfToken(
  ctx: Pick<CoreContext, 'redis' | 'keys'>,
  token: string | null,
): Promise<void> {
  await ctx.redis.eval(
    `local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local ok, d = pcall(cjson.decode, v)
local t = ''
if ok and type(d) == 'table' and d.token then t = d.token end
if t == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`,
    1,
    ctx.keys.refundReconcilePending(),
    token ?? '',
  );
}

/**
 * SUPER_ADMIN override: stop waiting for the reconciliation (refunds resume). `inTransaction`
 * writes the audit entry in the same transaction.
 */
export async function skipRefundReconciliation(
  ctx: CoreContext,
  inTransaction?: (tx: Parameters<Parameters<typeof withTransaction>[1]>[0]) => Promise<void>,
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    await tx.update(refundReconcileState).set({ pending: false, lastError: null, alert: null });
    await inTransaction?.(tx);
  });
  // After the commit: a rolled back override must not leave the refunds unblocked.
  await ctx.redis.del(ctx.keys.refundReconcilePending());
}

// ─── Job ────────────────────────────────────────────────────────────────────

/** Queues the reconcile job (the refunds sweeper repeats it, with back-off, until it succeeds). */
export async function enqueueRefundReconcile(ctx: Pick<CoreContext, 'jobs'>): Promise<void> {
  if (!ctx.jobs) return;
  try {
    await ctx.jobs.add(
      QUEUE_NAMES.refunds,
      'reconcile-refunds',
      {},
      {
        jobId: `reconcile-refunds-${Date.now().toString(36)}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      },
    );
  } catch (err) {
    console.error('[refunds] reconcile job could not be queued (sweeper retries)', err);
  }
}

export interface RefundReconcileResult {
  checked: number;
  settled: number;
  /** Orders that got (or already had) review findings in this pass. */
  reviewed: number;
  /** Orders PayPal answered 404 for. */
  notFound: number;
  /** Orders that could not be checked (404 with local refunds / permanent 4xx) – put under review. */
  unchecked: number;
  /** Transient failures: the marker stays and the pass is repeated. */
  errors: number;
  alert: string | null;
  /** False when the marker was kept (errors, alert) or the pass did not run. */
  complete: boolean;
  skipped?: 'NOT_PENDING' | 'LOCKED' | 'BACKOFF';
}

const emptyResult = (): RefundReconcileResult => ({
  checked: 0,
  settled: 0,
  reviewed: 0,
  notFound: 0,
  unchecked: 0,
  errors: 0,
  alert: null,
  complete: false,
});

type Failure = 'NOT_FOUND' | 'PERMANENT' | 'TRANSIENT';
function classify(err: unknown): Failure {
  if (err instanceof PayPalApiError) {
    if (err.status === 404) return 'NOT_FOUND';
    if ([400, 410, 422].includes(err.status)) return 'PERMANENT';
  }
  return 'TRANSIENT';
}

const backoffMs = (attempts: number) =>
  Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));

export async function reconcileRefundsAfterRestore(
  ctx: CoreContext,
  options: { force?: boolean; pageSize?: number } = {},
): Promise<RefundReconcileResult> {
  const status = await getRefundReconcileStatus(ctx);
  if (!status.pending) return { ...emptyResult(), complete: true, skipped: 'NOT_PENDING' };
  if (
    !options.force &&
    status.lastAttemptAt &&
    status.attempts > 0 &&
    Date.now() - status.lastAttemptAt.getTime() < backoffMs(status.attempts)
  ) {
    return { ...emptyResult(), skipped: 'BACKOFF' };
  }

  // Single flight: one pass at a time (a second worker / the sweeper skips).
  const lockToken = randomUUID();
  const lockKey = ctx.keys.refundReconcileLock();
  if (!(await ctx.redis.set(lockKey, lockToken, 'PX', LOCK_TTL_MS, 'NX'))) {
    return { ...emptyResult(), skipped: 'LOCKED' };
  }
  const token = status.token;
  try {
    // The durable row must exist (a rolled back restore only left the Redis flag).
    await ctx.db
      .insert(refundReconcileState)
      .values({ id: true, pending: true, token, reason: status.reason, since: status.since })
      .onConflictDoNothing();
    await ctx.db
      .update(refundReconcileState)
      .set({ attempts: sql`${refundReconcileState.attempts} + 1`, lastAttemptAt: new Date() });

    const result = emptyResult();
    let lockLost = false;
    let firstError: string | null = null;
    const seen = new Set<string>();
    const cutoff = new Date(Date.now() - PAYPAL_REFUND_WINDOW_DAYS * 86_400_000);
    let after: string | null = null;
    pages: for (;;) {
      const page: { id: string; orderId: string; providerOrderId: string | null }[] = await ctx.db
        .select({
          id: payments.id,
          orderId: payments.orderId,
          providerOrderId: payments.providerOrderId,
        })
        .from(payments)
        .where(
          and(
            eq(payments.method, 'PAYPAL'),
            sql`${payments.providerCaptureId} IS NOT NULL`,
            sql`${payments.providerOrderId} IS NOT NULL`,
            after ? gt(payments.id, after) : undefined,
            or(
              // Refunds that are still open locally are always checked ...
              exists(
                ctx.db
                  .select({ one: sql`1` })
                  .from(refunds)
                  .where(
                    and(
                      eq(refunds.paymentId, payments.id),
                      eq(refunds.kind, 'AUTOMATIC'),
                      eq(refunds.status, 'PENDING'),
                    ),
                  ),
              ),
              // ... otherwise only captures PayPal can still refund (lost-window detection).
              and(
                inArray(payments.status, ['CAPTURED', 'PARTIALLY_REFUNDED']),
                gte(sql`COALESCE(${payments.capturedAt}, ${payments.createdAt})`, cutoff),
              ),
            ),
          ),
        )
        .orderBy(asc(payments.id))
        .limit(options.pageSize ?? PAGE_SIZE);
      if (page.length === 0) break;
      after = page[page.length - 1]!.id;
      for (const candidate of page) {
        // Compare-and-extend: a pass that lost its lock (expired, taken over) must stop.
        if (!(await renewLock(ctx, lockKey, lockToken))) {
          lockLost = true;
          break pages;
        }
        const providerOrderId = candidate.providerOrderId!;
        if (seen.has(providerOrderId)) continue;
        seen.add(providerOrderId);
        result.checked += 1;
        try {
          const outcome = await reconcileOrderRefunds(ctx, candidate.orderId, providerOrderId);
          result.settled += outcome.settled;
          if (outcome.findings > 0) result.reviewed += 1;
        } catch (err) {
          const kind = classify(err);
          const message = err instanceof Error ? err.message : String(err);
          if (kind === 'TRANSIENT') {
            result.errors += 1;
            firstError ??= message;
            console.error('[refunds] reconcile after restore failed', providerOrderId, err);
            continue;
          }
          if (kind === 'NOT_FOUND') result.notFound += 1;
          // PayPal cannot be asked about an order that has local automatic refunds: a human decides.
          const hasAutomatic = await ctx.db
            .select({ id: refunds.id })
            .from(refunds)
            .innerJoin(payments, eq(payments.id, refunds.paymentId))
            .where(
              and(eq(payments.providerOrderId, providerOrderId), eq(refunds.kind, 'AUTOMATIC')),
            )
            .limit(1);
          if (kind === 'NOT_FOUND' && hasAutomatic.length === 0) continue;
          result.unchecked += 1;
          await recordRefundReview(ctx.db, candidate.orderId, [
            {
              kind: kind === 'NOT_FOUND' ? 'UNCHECKED_AT_PAYPAL' : 'CHECK_FAILED',
              ref: providerOrderId,
              amount: 0,
              currency: '',
              detail: message.slice(0, 300),
            },
          ]);
        }
      }
    }

    if (lockLost) {
      // Another pass owns the work now; leave the marker and its bookkeeping to it.
      return { ...result, errors: result.errors + 1, complete: false, skipped: 'LOCKED' };
    }

    // Most orders unknown to PayPal: wrong environment / account restored – keep the marker.
    if (result.checked >= MIN_CHECKED_FOR_ALERT && result.notFound * 2 > result.checked) {
      result.alert = MOSTLY_NOT_FOUND;
    }
    result.complete = result.errors === 0 && result.alert === null;
    await finish(ctx, token, result, firstError);
    return result;
  } finally {
    await ctx.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
      1,
      lockKey,
      lockToken,
    );
  }
}

/** PEXPIRE only while the lock still carries our token. */
async function renewLock(
  ctx: Pick<CoreContext, 'redis'>,
  lockKey: string,
  lockToken: string,
): Promise<boolean> {
  const renewed = await ctx.redis.eval(
    `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`,
    1,
    lockKey,
    lockToken,
    String(LOCK_TTL_MS),
  );
  return Number(renewed) === 1;
}

async function finish(
  ctx: CoreContext,
  token: string | null,
  result: RefundReconcileResult,
  firstError: string | null,
): Promise<void> {
  // Only the marker this pass started with (a newer restore has its own token).
  const sameToken = sql`${refundReconcileState.token} IS NOT DISTINCT FROM ${token}`;
  if (result.complete) {
    await ctx.db
      .update(refundReconcileState)
      .set({
        pending: false,
        lastSuccessAt: new Date(),
        lastError: null,
        alert: null,
        unchecked: result.unchecked,
      })
      .where(sameToken);
    await clearFlagIfToken(ctx, token);
    return;
  }
  await ctx.db
    .update(refundReconcileState)
    .set({
      lastError:
        firstError ??
        (result.alert
          ? `PayPal does not know ${result.notFound} of ${result.checked} orders`
          : null),
      unchecked: result.unchecked,
      alert: result.alert,
    })
    .where(sameToken);
}

// ─── Per order ──────────────────────────────────────────────────────────────

const moneyful = (r: { status: string }) => r.status === 'COMPLETED' || r.status === 'PENDING';

async function reconcileOrderRefunds(
  ctx: CoreContext,
  orderId: string,
  providerOrderId: string,
): Promise<{ settled: number; findings: number }> {
  const remote = await listPayPalOrderRefunds(ctx, providerOrderId);
  const paymentRows = await ctx.db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.providerOrderId, providerOrderId)));
  const paymentIds = paymentRows.map((p) => p.id);
  const local = paymentIds.length
    ? await ctx.db
        .select()
        .from(refunds)
        .where(and(inArray(refunds.paymentId, paymentIds), eq(refunds.kind, 'AUTOMATIC')))
    : [];

  // The order details may omit `custom_id`: read it from the refund resource itself.
  const resolved: PayPalOrderRefund[] = [];
  for (const r of remote) {
    const known = local.some((l) => l.providerRefundId === r.id);
    if (!r.customId && !known && moneyful(r)) {
      const details = await getPayPalRefundDetails(ctx, r.id);
      resolved.push({ ...r, customId: details.customId });
    } else {
      resolved.push(r);
    }
  }

  const groups = new Map<string, PayPalOrderRefund[]>();
  const findings: RefundReviewFinding[] = [];
  for (const r of resolved) {
    const row = local.find(
      (l) => l.providerRefundId === r.id || (r.customId && l.id === r.customId),
    );
    if (!row) {
      if (moneyful(r)) {
        findings.push({
          kind: 'UNKNOWN_AT_PAYPAL',
          ref: r.id,
          amount: r.amountCents,
          currency: r.currency,
        });
      }
      continue;
    }
    groups.set(row.id, [...(groups.get(row.id) ?? []), r]);
  }

  let settled = 0;
  for (const row of local) {
    const remotes = groups.get(row.id) ?? [];
    const completed = remotes.filter((r) => r.status === 'COMPLETED');
    const pending = remotes.filter((r) => r.status === 'PENDING');
    const failed = remotes.filter((r) => r.status === 'FAILED' || r.status === 'CANCELLED');
    const exact = (r: PayPalOrderRefund) =>
      r.amountCents === row.amount && r.currency === row.currency;
    const mismatch = (r: PayPalOrderRefund) =>
      findings.push({
        kind: 'AMOUNT_MISMATCH',
        ref: r.id,
        amount: r.amountCents,
        currency: r.currency,
        detail: `${row.id}: ${row.amount} ${row.currency}`,
      });

    if (completed.length > 1) {
      findings.push({
        kind: 'DOUBLE_REFUND_AT_PAYPAL',
        ref: completed[0]!.id,
        amount: completed.reduce((sum, r) => sum + r.amountCents, 0),
        currency: completed[0]!.currency,
        detail: completed.map((r) => r.id).join(','),
      });
    }

    if (row.status === 'SUCCEEDED') {
      if (completed.length > 0) {
        if (!completed.some(exact)) mismatch(completed[0]!);
      } else if (!row.completedByUserId && (remotes.length > 0 || row.providerRefundId)) {
        findings.push({
          kind: 'LOCAL_SUCCEEDED_NOT_AT_PAYPAL',
          ref: row.id,
          amount: row.amount,
          currency: row.currency,
        });
      }
      continue;
    }

    const win = completed.find(exact);
    if (win) {
      const done = await withTransaction(ctx.db, (tx) =>
        markRefundSucceeded(tx, row.id, {
          providerRefundId: win.id,
          actor: { type: 'SYSTEM' },
          note: 'Reconciled with PayPal after a backup restore',
        }),
      );
      if (done) settled += 1;
    } else if (completed.length > 0) {
      mismatch(completed[0]!);
    } else if (pending.length > 0) {
      const match = pending.find(exact);
      if (!match) mismatch(pending[0]!);
      else {
        // PayPal is still processing it: back to PENDING (also a row we had given up on) with the
        // PayPal refund id, the normal job polls it to the end.
        await ctx.db
          .update(refunds)
          .set({
            status: 'PENDING',
            failureMessage: null,
            providerRefundId: match.id,
            updatedAt: new Date(),
          })
          .where(and(eq(refunds.id, row.id), inArray(refunds.status, ['PENDING', 'FAILED'])));
        settled += 1;
      }
    } else if (failed.length > 0 && row.status === 'PENDING') {
      // Every PayPal attempt of this row failed. A later retry must use a request id PayPal has
      // not seen: the attempt counter ends up above the number of refunds PayPal holds for it.
      const last = failed[failed.length - 1]!;
      await failRefund(ctx, row.id, `PayPal refund ${last.status} (after restore)`, last.id);
      await ctx.db
        .update(refunds)
        .set({ attempt: sql`GREATEST(${refunds.attempt}, ${failed.length})` })
        .where(eq(refunds.id, row.id));
      settled += 1;
    }
    // Whatever happened: a later retry must not reuse a request id PayPal already saw.
    if (remotes.length > 0 && row.attempt < remotes.length) {
      await ctx.db
        .update(refunds)
        .set({ attempt: sql`GREATEST(${refunds.attempt}, ${remotes.length})` })
        .where(and(eq(refunds.id, row.id), inArray(refunds.status, ['PENDING', 'FAILED'])));
    }
  }

  const recorded = await recordRefundReview(ctx.db, orderId, findings);
  return { settled, findings: findings.length > 0 || recorded ? 1 : 0 };
}

// ─── Admin: review list ─────────────────────────────────────────────────────

export interface RefundReviewRow {
  orderId: string;
  orderNumber: string;
  buyerName: string;
  currency: string;
  findings: RefundReviewFinding[];
  createdAt: Date;
  /** Active tickets (for "record the existing refund as cancellation of these"). */
  items: { id: string; label: string; priceGross: number }[];
}

/** Orders whose latest review entry is still open (not resolved by an admin). */
export async function listRefundRestoreReviews(
  ctx: Pick<CoreContext, 'db'>,
): Promise<RefundReviewRow[]> {
  const rows = await ctx.db
    .selectDistinctOn([orderHistory.orderId], {
      orderId: orderHistory.orderId,
      type: orderHistory.type,
      data: orderHistory.data,
      createdAt: orderHistory.createdAt,
      orderNumber: orders.orderNumber,
      firstName: orders.firstName,
      lastName: orders.lastName,
      currency: orders.currency,
    })
    .from(orderHistory)
    .innerJoin(orders, eq(orders.id, orderHistory.orderId))
    .where(inArray(orderHistory.type, [REFUND_REVIEW_EVENT, REFUND_REVIEW_RESOLVED_EVENT]))
    .orderBy(orderHistory.orderId, desc(orderHistory.createdAt), desc(orderHistory.id));
  const open = rows.filter((r) => r.type === REFUND_REVIEW_EVENT);
  if (open.length === 0) return [];
  const items = await ctx.db
    .select({
      id: orderItems.id,
      orderId: orderItems.orderId,
      sectionLabel: orderItems.sectionLabel,
      rowLabel: orderItems.rowLabel,
      seatLabel: orderItems.seatLabel,
      ticketTypeName: orderItems.ticketTypeName,
      priceGross: orderItems.priceGross,
    })
    .from(orderItems)
    .where(
      and(
        inArray(
          orderItems.orderId,
          open.map((r) => r.orderId),
        ),
        eq(orderItems.status, 'CONFIRMED'),
      ),
    );
  return open
    .map((r) => ({
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      buyerName: `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim(),
      currency: r.currency,
      findings: (r.data as { findings?: RefundReviewFinding[] } | null)?.findings ?? [],
      createdAt: r.createdAt,
      items: items
        .filter((i) => i.orderId === r.orderId)
        .map((i) => ({
          id: i.id,
          label: [i.sectionLabel, i.rowLabel, i.seatLabel, i.ticketTypeName]
            .filter(Boolean)
            .join(' · '),
          priceGross: i.priceGross,
        })),
    }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export async function countRefundRestoreReviews(ctx: Pick<CoreContext, 'db'>): Promise<number> {
  return (await listRefundRestoreReviews(ctx)).length;
}

/**
 * The admin looked at it (and recorded the refund / booked a correction if needed). `inTransaction`
 * runs in the same transaction (audit entry).
 */
export async function resolveRefundRestoreReview(
  ctx: CoreContext,
  params: {
    orderId: string;
    userId: string;
    inTransaction?: (tx: Parameters<Parameters<typeof withTransaction>[1]>[0]) => Promise<void>;
  },
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    if (!(await resolveRefundReview(tx, params.orderId, params.userId))) {
      throw new DomainError('REFUND_REVIEW_NOT_FOUND', 'No open review for this order', 404);
    }
    await params.inTransaction?.(tx);
  });
}
