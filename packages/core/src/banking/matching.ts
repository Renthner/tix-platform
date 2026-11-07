import {
  bankTransactionAllocations,
  bankTransactions,
  orders,
  withTransaction,
  type Database,
  type Executor,
} from '@tix/db';
import {
  extractPaymentReferences,
  type AllocationMethod,
  type BankTxMatchStatus,
  type BankTxReviewReason,
  type MatchCandidate,
  type MatchCandidateReason,
  type OrderStatus,
  type ParsedPaymentReference,
} from '@tix/shared';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import { recordPayment, type RecordPaymentResult } from '../orders/fulfillment';
import { getSetting } from '../settings';
import { withMutex } from './runs';

/**
 * Reconciliation of incoming bank transfers (Vorkasse):
 *  1. extract payment references (configured prefix, tolerant parser, Luhn check digit),
 *  2. reference with valid check digit → order; amount within tolerance of the outstanding
 *     amount → `recordPayment` + AUTO allocation → AUTO_MATCHED (order PAID, tickets queued),
 *  3. everything else → NEEDS_REVIEW (Klärfall) with a reason and scored candidates
 *     (reference near-misses, sender name similarity via pg_trgm, equal outstanding amount).
 * Debits are IGNORED. Every step is idempotent: a Redis mutex per transaction serialises
 * matcher and admin, `recordPayment` deduplicates by (bank transaction, order), and already
 * matched transactions are never touched again.
 */

const OPEN_STATUSES: OrderStatus[] = ['PENDING', 'AWAITING_PAYMENT'];
const NOT_PAYABLE: OrderStatus[] = ['CANCELLED', 'EXPIRED', 'REFUNDED', 'PARTIALLY_REFUNDED'];
const MAX_CANDIDATES = 8;
const NAME_THRESHOLD = 0.3;
const STRONG_NAME = 0.5;
const MUTEX_TTL_MS = 120_000;

type TxRow = typeof bankTransactions.$inferSelect;

const orderColumns = {
  id: orders.id,
  orderNumber: orders.orderNumber,
  status: orders.status,
  currency: orders.currency,
  totalGross: orders.totalGross,
  amountPaid: orders.amountPaid,
  paymentReference: orders.paymentReference,
};
type OrderInfo = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  currency: string;
  totalGross: number;
  amountPaid: number;
  paymentReference: string | null;
};

export interface MatchResult {
  transactionId: string;
  status: BankTxMatchStatus;
  reviewReason: BankTxReviewReason | null;
  orderIds: string[];
}

export interface MatchSummary {
  processed: number;
  matched: number;
  review: number;
  ignored: number;
  skipped: number;
}

/** Runs the matcher for one transaction. Returns null when another process holds it. */
export async function matchBankTransaction(
  ctx: CoreContext,
  transactionId: string,
  options: { force?: boolean } = {},
): Promise<MatchResult | null> {
  const locked = await withMutex(ctx, `bank-tx:${transactionId}`, MUTEX_TTL_MS, () =>
    matchLocked(ctx, transactionId, options.force ?? false),
  );
  return locked ? locked.value : null;
}

export async function matchBankTransactions(
  ctx: CoreContext,
  transactionIds: readonly string[],
): Promise<MatchSummary> {
  const summary: MatchSummary = { processed: 0, matched: 0, review: 0, ignored: 0, skipped: 0 };
  for (const id of transactionIds) {
    const result = await matchBankTransaction(ctx, id);
    if (!result) {
      summary.skipped += 1;
      continue;
    }
    summary.processed += 1;
    if (result.status === 'AUTO_MATCHED' || result.status === 'MANUALLY_MATCHED')
      summary.matched += 1;
    else if (result.status === 'NEEDS_REVIEW') summary.review += 1;
    else if (result.status === 'IGNORED') summary.ignored += 1;
  }
  return summary;
}

/** Safety net: credits still UNMATCHED (e.g. matcher interrupted) older than `minAgeMs`. */
export async function matchPendingBankTransactions(
  ctx: CoreContext,
  options: { limit?: number; minAgeMs?: number } = {},
): Promise<MatchSummary> {
  const rows = await ctx.db
    .select({ id: bankTransactions.id })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.matchStatus, 'UNMATCHED'),
        lt(bankTransactions.createdAt, new Date(Date.now() - (options.minAgeMs ?? 60_000))),
      ),
    )
    .orderBy(asc(bankTransactions.createdAt))
    .limit(options.limit ?? 200);
  return matchBankTransactions(
    ctx,
    rows.map((r) => r.id),
  );
}

async function allocatedAmount(db: Executor, transactionId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${bankTransactionAllocations.amount}), 0)::int` })
    .from(bankTransactionAllocations)
    .where(
      and(
        eq(bankTransactionAllocations.bankTransactionId, transactionId),
        isNull(bankTransactionAllocations.reversedAt),
      ),
    );
  return row?.total ?? 0;
}

function outcome(
  tx: Pick<TxRow, 'id' | 'matchStatus' | 'reviewReason'>,
  orderIds: string[] = [],
): MatchResult {
  return {
    transactionId: tx.id,
    status: tx.matchStatus,
    reviewReason: tx.reviewReason,
    orderIds,
  };
}

/** Text searched for references: remittance information and end-to-end id. */
export function referenceText(tx: Pick<TxRow, 'remittanceInformation' | 'endToEndId'>): string {
  return [tx.remittanceInformation, tx.endToEndId].filter(Boolean).join(' ');
}

/** Instant used as payment date: booking date (noon UTC), never in the future. */
function bookingInstant(bookingDate: string): Date {
  const at = new Date(`${bookingDate}T12:00:00Z`);
  return at.getTime() > Date.now() ? new Date() : at;
}

async function matchLocked(
  ctx: CoreContext,
  transactionId: string,
  force: boolean,
): Promise<MatchResult | null> {
  const [tx] = await ctx.db
    .select()
    .from(bankTransactions)
    .where(eq(bankTransactions.id, transactionId));
  if (!tx) return null;
  if (tx.matchStatus === 'AUTO_MATCHED' || tx.matchStatus === 'MANUALLY_MATCHED')
    return outcome(tx);
  if (tx.matchStatus === 'IGNORED' && !force) return outcome(tx);
  if (tx.amount <= 0) {
    await setStatus(ctx.db, tx.id, { matchStatus: 'IGNORED', reviewReason: null });
    return { ...outcome(tx), status: 'IGNORED', reviewReason: null };
  }
  // Partially assigned by an admin: never act automatically on the remainder.
  const already = await allocatedAmount(ctx.db, tx.id);
  if (already > 0) {
    const status: BankTxMatchStatus = already >= tx.amount ? 'MANUALLY_MATCHED' : 'NEEDS_REVIEW';
    const reason = status === 'NEEDS_REVIEW' ? (tx.reviewReason ?? 'OVERPAYMENT') : null;
    await setStatus(ctx.db, tx.id, { matchStatus: status, reviewReason: reason });
    return { ...outcome(tx), status, reviewReason: reason };
  }

  const settings = await getSetting(ctx, 'bankTransfer');
  const tolerance = settings.autoMatchToleranceCents;
  const refs = extractPaymentReferences(referenceText(tx), [settings.paymentReferencePrefix]);
  const validRefs = refs.filter((r) => r.checksumValid).map((r) => r.reference);
  const extractedReference = refs[0]?.reference ?? null;
  const referenced: OrderInfo[] = validRefs.length
    ? await ctx.db
        .select(orderColumns)
        .from(orders)
        .where(inArray(orders.paymentReference, validRefs))
    : [];

  const review = async (
    reason: BankTxReviewReason,
    candidates: MatchCandidate[],
  ): Promise<MatchResult> => {
    await setStatus(ctx.db, tx.id, {
      matchStatus: 'NEEDS_REVIEW',
      reviewReason: reason,
      extractedReference,
      matchCandidates: candidates,
      matchConfidence: candidates[0]?.score ?? null,
    });
    return { transactionId: tx.id, status: 'NEEDS_REVIEW', reviewReason: reason, orderIds: [] };
  };

  // ── No order with a valid reference ──────────────────────────────────────
  if (referenced.length === 0) {
    const { candidates, strongName } = await findCandidates(ctx.db, tx, refs, tolerance);
    const reason: BankTxReviewReason =
      refs.length > 0 ? 'UNKNOWN_REFERENCE' : strongName ? 'NAME_MATCH_ONLY' : 'NO_REFERENCE';
    return review(reason, candidates);
  }

  const direct = (
    o: OrderInfo,
    score: number,
    ...extra: MatchCandidateReason[]
  ): MatchCandidate => ({
    orderId: o.id,
    orderNumber: o.orderNumber,
    score,
    reasons: ['REFERENCE', ...extra],
  });

  // ── Exactly one referenced order ─────────────────────────────────────────
  if (referenced.length === 1) {
    const order = referenced[0]!;
    if (order.currency !== tx.currency)
      return review('CURRENCY_MISMATCH', [direct(order, 90, 'CURRENCY')]);
    if (NOT_PAYABLE.includes(order.status)) {
      return review('ORDER_NOT_PAYABLE', [direct(order, 90, 'ORDER_NOT_PAYABLE')]);
    }
    if (order.status === 'PAID') return review('OVERPAYMENT', [direct(order, 90, 'ALREADY_PAID')]);
    const outstanding = order.totalGross - order.amountPaid;
    const diff = tx.amount - outstanding;
    if (diff > tolerance) return review('OVERPAYMENT', [direct(order, 95)]);
    if (diff < -tolerance) return review('UNDERPAYMENT', [direct(order, 95)]);
    return autoAllocate(
      ctx,
      tx,
      [{ order, amount: tx.amount }],
      extractedReference,
      review,
      tolerance,
    );
  }

  // ── Several referenced orders: collective transfer ───────────────────────
  const candidates = referenced.map((o) => direct(o, 85));
  if (referenced.some((o) => o.currency !== tx.currency || !OPEN_STATUSES.includes(o.status))) {
    return review('AMBIGUOUS', candidates);
  }
  const sorted = [...referenced].sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));
  const outstanding = sorted.map((o) => o.totalGross - o.amountPaid);
  const total = outstanding.reduce((s, v) => s + v, 0);
  if (Math.abs(tx.amount - total) > tolerance || outstanding.some((v) => v <= 0)) {
    return review('AMBIGUOUS', candidates);
  }
  // Each order gets its outstanding amount; the last one absorbs the tolerated difference.
  const parts = sorted.map((order, i) => ({
    order,
    amount: i === sorted.length - 1 ? tx.amount - (total - outstanding[i]!) : outstanding[i]!,
  }));
  return autoAllocate(ctx, tx, parts, extractedReference, review, tolerance);
}

async function autoAllocate(
  ctx: CoreContext,
  tx: TxRow,
  parts: { order: OrderInfo; amount: number }[],
  extractedReference: string | null,
  review: (reason: BankTxReviewReason, candidates: MatchCandidate[]) => Promise<MatchResult>,
  /** Matching tolerance: an underpayment up to this amount settles the order. */
  tolerance: number,
): Promise<MatchResult> {
  const done: { orderId: string; paymentId: string; amount: number }[] = [];
  let failure: { reason: BankTxReviewReason; order: OrderInfo } | null = null;
  for (const part of parts) {
    if (part.amount <= 0) continue;
    let result: RecordPaymentResult;
    try {
      result = await recordPayment(ctx, {
        orderId: part.order.id,
        amount: part.amount,
        currency: tx.currency,
        method: 'BANK_TRANSFER',
        bankTransactionId: tx.id,
        capturedAt: bookingInstant(tx.bookingDate),
        providerResponse: { bankTransactionId: tx.id, method: 'AUTO' },
        actor: { type: 'SYSTEM' },
        settleShortfallUpTo: tolerance,
      });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'CURRENCY_MISMATCH') {
        failure = { reason: 'CURRENCY_MISMATCH', order: part.order };
        break;
      }
      throw err;
    }
    if (result.status === 'NOT_PAYABLE') {
      failure = { reason: 'ORDER_NOT_PAYABLE', order: part.order };
      break;
    }
    done.push({ orderId: part.order.id, paymentId: result.paymentId, amount: part.amount });
  }
  await persistAllocations(ctx.db, tx.id, done, 'AUTO', null, null);
  if (failure) {
    const reasons: MatchCandidateReason[] =
      failure.reason === 'CURRENCY_MISMATCH'
        ? ['REFERENCE', 'CURRENCY']
        : ['REFERENCE', 'ORDER_NOT_PAYABLE'];
    if (done.length > 0) {
      // Some orders of a collective transfer were paid – the rest needs a human.
      await setStatus(ctx.db, tx.id, {
        matchStatus: 'NEEDS_REVIEW',
        reviewReason: failure.reason,
        extractedReference,
        matchCandidates: [
          { orderId: failure.order.id, orderNumber: failure.order.orderNumber, score: 90, reasons },
        ],
        matchConfidence: 90,
      });
      return {
        transactionId: tx.id,
        status: 'NEEDS_REVIEW',
        reviewReason: failure.reason,
        orderIds: done.map((d) => d.orderId),
      };
    }
    return review(failure.reason, [
      { orderId: failure.order.id, orderNumber: failure.order.orderNumber, score: 90, reasons },
    ]);
  }
  await setStatus(ctx.db, tx.id, {
    matchStatus: 'AUTO_MATCHED',
    reviewReason: null,
    extractedReference,
    matchConfidence: 100,
    matchCandidates: parts.map((p) => ({
      orderId: p.order.id,
      orderNumber: p.order.orderNumber,
      score: 100,
      reasons: ['REFERENCE'],
    })),
  });
  return {
    transactionId: tx.id,
    status: 'AUTO_MATCHED',
    reviewReason: null,
    orderIds: done.map((d) => d.orderId),
  };
}

async function persistAllocations(
  db: Database,
  transactionId: string,
  allocations: { orderId: string; paymentId: string; amount: number }[],
  method: AllocationMethod,
  userId: string | null,
  note: string | null,
): Promise<void> {
  if (allocations.length === 0) return;
  await withTransaction(db, async (t) => {
    for (const a of allocations) {
      const [exists] = await t
        .select({ id: bankTransactionAllocations.id })
        .from(bankTransactionAllocations)
        .where(
          and(
            eq(bankTransactionAllocations.bankTransactionId, transactionId),
            eq(bankTransactionAllocations.paymentId, a.paymentId),
            isNull(bankTransactionAllocations.reversedAt),
          ),
        );
      if (exists) continue;
      await t.insert(bankTransactionAllocations).values({
        bankTransactionId: transactionId,
        orderId: a.orderId,
        paymentId: a.paymentId,
        amount: a.amount,
        method,
        allocatedByUserId: userId,
        note,
      });
    }
  });
}

async function setStatus(
  db: Executor,
  transactionId: string,
  values: Partial<
    Pick<
      TxRow,
      | 'matchStatus'
      | 'reviewReason'
      | 'extractedReference'
      | 'matchCandidates'
      | 'matchConfidence'
      | 'reviewedByUserId'
      | 'reviewedAt'
      | 'reviewNote'
    >
  >,
): Promise<void> {
  await db
    .update(bankTransactions)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(bankTransactions.id, transactionId));
}

// ─── Candidates ────────────────────────────────────────────────────────────────

/**
 * How close a reference found in the text is to an order's reference:
 * CHECK_DIGIT = identical except the check digit; ONE_EDIT = one wrong / missing / extra
 * digit or two swapped neighbours.
 */
export function referenceDistance(
  found: string,
  actual: string,
): 'CHECK_DIGIT' | 'ONE_EDIT' | null {
  const [pf, ...df] = found.split('-');
  const [pa, ...da] = actual.split('-');
  if (!pf || pf !== pa) return null;
  const a = df.join('');
  const b = da.join('');
  if (a === b) return null;
  if (a.length === b.length) {
    const diffs: number[] = [];
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diffs.push(i);
    if (diffs.length === 1) return diffs[0] === a.length - 1 ? 'CHECK_DIGIT' : 'ONE_EDIT';
    if (
      diffs.length === 2 &&
      diffs[1] === diffs[0]! + 1 &&
      a[diffs[0]!] === b[diffs[1]!] &&
      a[diffs[1]!] === b[diffs[0]!]
    ) {
      return 'ONE_EDIT';
    }
    return null;
  }
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  if (longer.length - shorter.length !== 1) return null;
  for (let i = 0; i < longer.length; i += 1) {
    if (longer.slice(0, i) + longer.slice(i + 1) === shorter) return 'ONE_EDIT';
  }
  return null;
}

interface CandidateScore {
  orderNumber: string;
  score: number;
  reasons: Set<MatchCandidateReason>;
}

export async function findCandidates(
  db: Executor,
  tx: Pick<TxRow, 'amount' | 'currency' | 'bookingDate' | 'counterpartyName'>,
  refs: readonly ParsedPaymentReference[],
  tolerance: number,
): Promise<{ candidates: MatchCandidate[]; strongName: boolean }> {
  const scores = new Map<string, CandidateScore>();
  const add = (id: string, orderNumber: string, points: number, reason: MatchCandidateReason) => {
    const entry = scores.get(id) ?? { orderNumber, score: 0, reasons: new Set() };
    if (!entry.reasons.has(reason)) {
      entry.score += points;
      entry.reasons.add(reason);
    }
    scores.set(id, entry);
  };
  // Orders created after the booking (+2 days for value dating / time zones) cannot match.
  const cutoff = new Date(`${tx.bookingDate}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() + 2);
  const open = and(inArray(orders.status, OPEN_STATUSES), lt(orders.createdAt, cutoff));

  // 1. Reference near-misses (wrong check digit, one wrong / swapped digit).
  const prefixes = [...new Set(refs.map((r) => r.reference.split('-')[0]!))];
  for (const prefix of prefixes) {
    const rows = await db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        reference: orders.paymentReference,
      })
      .from(orders)
      .where(and(open, sql`${orders.paymentReference} LIKE ${`${prefix}-%`}`))
      .orderBy(desc(orders.createdAt))
      .limit(5000);
    for (const row of rows) {
      for (const ref of refs) {
        const distance = referenceDistance(ref.reference, row.reference ?? '');
        if (distance === 'CHECK_DIGIT') add(row.id, row.orderNumber, 70, 'REFERENCE_CHECKSUM');
        else if (distance === 'ONE_EDIT') add(row.id, row.orderNumber, 50, 'REFERENCE_SIMILAR');
      }
    }
  }

  // 2. Sender name ↔ buyer name / company (pg_trgm similarity, word order independent).
  let strongName = false;
  const name = tx.counterpartyName?.trim();
  if (name && name.length >= 3) {
    const similarity = sql<number>`GREATEST(
      similarity(lower(${orders.firstName} || ' ' || ${orders.lastName}), lower(${name})),
      similarity(lower(${orders.lastName} || ' ' || ${orders.firstName}), lower(${name})),
      similarity(lower(coalesce(${orders.company}, '')), lower(${name}))
    )`;
    const rows = await db
      .select({ id: orders.id, orderNumber: orders.orderNumber, similarity })
      .from(orders)
      .where(and(open, sql`${similarity} >= ${NAME_THRESHOLD}`))
      .orderBy(desc(similarity))
      .limit(10);
    for (const row of rows) {
      const sim = Number(row.similarity);
      add(row.id, row.orderNumber, Math.min(50, Math.round(10 + 40 * sim)), 'NAME');
      if (sim >= STRONG_NAME) strongName = true;
    }
  }

  // 3. Outstanding amount equals (or is within tolerance of) the transferred amount.
  const outstanding = sql<number>`(${orders.totalGross} - ${orders.amountPaid})`;
  const amountRows = await db
    .select({ id: orders.id, orderNumber: orders.orderNumber, outstanding })
    .from(orders)
    .where(
      and(
        open,
        eq(orders.currency, tx.currency),
        sql`${outstanding} BETWEEN ${tx.amount - tolerance} AND ${tx.amount + tolerance}`,
      ),
    )
    .orderBy(desc(orders.createdAt))
    .limit(10);
  for (const row of amountRows) {
    if (Number(row.outstanding) === tx.amount) add(row.id, row.orderNumber, 30, 'AMOUNT');
    else add(row.id, row.orderNumber, 20, 'AMOUNT_NEAR');
  }

  const candidates = [...scores.entries()]
    .map(([orderId, s]) => ({
      orderId,
      orderNumber: s.orderNumber,
      score: Math.min(99, s.score),
      reasons: [...s.reasons],
    }))
    .sort((a, b) => b.score - a.score || a.orderNumber.localeCompare(b.orderNumber))
    .slice(0, MAX_CANDIDATES);
  return { candidates, strongName };
}

// ─── Admin actions (Klärfälle) ─────────────────────────────────────────────────

export interface AssignResult {
  payment: RecordPaymentResult['status'];
  /** Order amount still open after this payment (PARTIAL). */
  outstanding: number;
  /** Amount paid beyond the order total by this assignment. */
  overpayment: number;
  /** Part of the bank transaction not yet assigned to any order. */
  unassigned: number;
}

/**
 * Manual 1-click assignment of (part of) a credit transaction to an order. Records the
 * payment with the admin as actor and a MANUAL allocation. The transaction becomes
 * MANUALLY_MATCHED once fully assigned, otherwise it stays in review for the remainder.
 */
export async function assignBankTransaction(
  ctx: CoreContext,
  params: {
    transactionId: string;
    orderId: string;
    amount?: number;
    userId: string;
    note?: string | null;
  },
): Promise<AssignResult> {
  const locked = await withMutex(ctx, `bank-tx:${params.transactionId}`, MUTEX_TTL_MS, async () => {
    const [tx] = await ctx.db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, params.transactionId));
    if (!tx) throw new DomainError('TX_NOT_FOUND', 'Bank transaction not found', 404);
    if (tx.amount <= 0) throw new DomainError('TX_NOT_CREDIT', 'Only credits can be assigned', 422);
    const already = await allocatedAmount(ctx.db, tx.id);
    const unassigned = tx.amount - already;
    if (unassigned <= 0)
      throw new DomainError('TX_RESOLVED', 'The transaction is fully assigned', 409);
    const amount = params.amount ?? unassigned;
    if (!Number.isInteger(amount) || amount <= 0 || amount > unassigned) {
      throw new DomainError('AMOUNT_EXCEEDS', 'Amount exceeds the unassigned part', 422);
    }
    const [order] = await ctx.db
      .select(orderColumns)
      .from(orders)
      .where(eq(orders.id, params.orderId));
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (order.currency !== tx.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Order currency differs from the transfer', 422);
    }
    const before = order.totalGross - order.amountPaid;
    const result = await recordPayment(ctx, {
      orderId: order.id,
      amount,
      currency: tx.currency,
      method: 'BANK_TRANSFER',
      bankTransactionId: tx.id,
      receivedByUserId: params.userId,
      capturedAt: bookingInstant(tx.bookingDate),
      providerResponse: { bankTransactionId: tx.id, method: 'MANUAL' },
      actor: { type: 'ADMIN', userId: params.userId },
    });
    if (result.status === 'NOT_PAYABLE') {
      throw new DomainError('ORDER_NOT_PAYABLE', `Order is ${result.orderStatus}`, 409, {
        orderStatus: result.orderStatus,
      });
    }
    await persistAllocations(
      ctx.db,
      tx.id,
      [{ orderId: order.id, paymentId: result.paymentId, amount }],
      'MANUAL',
      params.userId,
      params.note?.trim() || null,
    );
    const remaining = tx.amount - (await allocatedAmount(ctx.db, tx.id));
    await setStatus(ctx.db, tx.id, {
      matchStatus: remaining <= 0 ? 'MANUALLY_MATCHED' : 'NEEDS_REVIEW',
      reviewReason: remaining <= 0 ? null : (tx.reviewReason ?? 'OVERPAYMENT'),
      reviewedByUserId: params.userId,
      reviewedAt: new Date(),
      reviewNote: params.note?.trim() || tx.reviewNote,
    });
    return {
      payment: result.status,
      outstanding: result.status === 'PARTIAL' ? result.outstanding : 0,
      overpayment: Math.max(0, amount - Math.max(0, before)),
      unassigned: Math.max(0, remaining),
    } satisfies AssignResult;
  });
  if (!locked) throw new DomainError('BUSY', 'The transaction is being processed – try again', 409);
  return locked.value;
}

/** Dismisses a transaction (no order relation, e.g. other income). Requires no allocations. */
export async function ignoreBankTransaction(
  ctx: CoreContext,
  params: { transactionId: string; userId: string; note: string },
): Promise<void> {
  const locked = await withMutex(ctx, `bank-tx:${params.transactionId}`, MUTEX_TTL_MS, async () => {
    const [tx] = await ctx.db
      .select({ id: bankTransactions.id, matchStatus: bankTransactions.matchStatus })
      .from(bankTransactions)
      .where(eq(bankTransactions.id, params.transactionId));
    if (!tx) throw new DomainError('TX_NOT_FOUND', 'Bank transaction not found', 404);
    if ((await allocatedAmount(ctx.db, tx.id)) > 0) {
      throw new DomainError('TX_HAS_ALLOCATIONS', 'Assigned transactions cannot be ignored', 409);
    }
    await setStatus(ctx.db, tx.id, {
      matchStatus: 'IGNORED',
      reviewReason: null,
      reviewedByUserId: params.userId,
      reviewedAt: new Date(),
      reviewNote: params.note.trim().slice(0, 1000),
    });
  });
  if (!locked) throw new DomainError('BUSY', 'The transaction is being processed – try again', 409);
}

/** Re-runs the matcher (also for IGNORED credits, which are reopened). */
export async function rematchBankTransaction(
  ctx: CoreContext,
  transactionId: string,
): Promise<MatchResult> {
  const [tx] = await ctx.db
    .select({
      id: bankTransactions.id,
      matchStatus: bankTransactions.matchStatus,
      amount: bankTransactions.amount,
    })
    .from(bankTransactions)
    .where(eq(bankTransactions.id, transactionId));
  if (!tx) throw new DomainError('TX_NOT_FOUND', 'Bank transaction not found', 404);
  if (tx.amount <= 0) throw new DomainError('TX_NOT_CREDIT', 'Only credits are reconciled', 422);
  const result = await matchBankTransaction(ctx, transactionId, { force: true });
  if (!result) throw new DomainError('BUSY', 'The transaction is being processed – try again', 409);
  return result;
}
