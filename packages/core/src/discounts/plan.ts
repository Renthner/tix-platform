import { discountCodes, orderDiscounts, orders, type Executor } from '@tix/db';
import {
  DISCOUNT_USAGE_ORDER_STATUSES,
  applyDiscountRules,
  exceedsPercentCap,
  normalizeDiscountCode,
  violatesMinimumTotal,
  type DiscountLine,
  type DiscountRejection,
} from '@tix/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';

/**
 * Discount codes in the shop: codes of a cart session, availability checks and the plan that
 * turns them into per-line discounts for a quote. The calculation itself is pure and lives in
 * `@tix/shared` (`applyDiscountRules`, see its comment for the rounding rules).
 *
 * Usage is counted from `order_discounts` (orders that are PENDING / AWAITING_PAYMENT / PAID /
 * PARTIALLY_REFUNDED and not test orders). Cancelled, expired and fully refunded orders release
 * the usage automatically. The limits are enforced atomically in `placeOrder` (the code rows are
 * locked FOR UPDATE, see `lockAndCheckDiscountUsage`).
 */

export type DiscountCodeRow = typeof discountCodes.$inferSelect;

export type DiscountRejectionReason =
  | 'INVALID'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'USAGE_LIMIT'
  | 'EMAIL_LIMIT'
  | 'NOT_STACKABLE'
  | 'PERCENT_CAP'
  | 'BELOW_MINIMUM_TOTAL'
  | DiscountRejection;

export interface RejectedDiscount {
  code: string;
  reason: DiscountRejectionReason;
  minOrderValue?: number;
}

export interface QuoteDiscount {
  discountCodeId: string;
  code: string;
  type: DiscountCodeRow['type'];
  value: number;
  /** Whole discount of this code in cents (tickets + discounted fees). */
  amount: number;
  /** Part of `amount` that reduced fee lines. */
  feeAmount: number;
  position: number;
  /** `discount_codes.updated_at` the quote was calculated with (checked under lock at checkout). */
  updatedAt: number;
}

/** DomainError for a rejected code (stable codes, translated in the UI). */
export function discountRejectionError(rejected: RejectedDiscount): DomainError {
  const status = rejected.reason === 'INVALID' ? 404 : 422;
  return new DomainError(
    `DISCOUNT_${rejected.reason}`,
    `Discount code ${rejected.code} cannot be used: ${rejected.reason}`,
    status,
    {
      code: rejected.code,
      ...(rejected.minOrderValue ? { minOrderValue: rejected.minOrderValue } : {}),
    },
  );
}

// ─── Codes of a cart session (Redis hash field of the cart) ─────────────────────

const SESSION_FIELD = 'dc';
export const MAX_CODES_PER_CART = 5;

/** Codes entered in this cart session, in the order they were applied. */
export async function getSessionDiscountCodes(
  ctx: CoreContext,
  sessionId: string,
): Promise<string[]> {
  const raw = await ctx.redis.hget(ctx.keys.cart(sessionId), SESSION_FIELD);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

export async function setSessionDiscountCodes(
  ctx: CoreContext,
  sessionId: string,
  codes: string[],
): Promise<void> {
  const key = ctx.keys.cart(sessionId);
  if (codes.length === 0) await ctx.redis.hdel(key, SESSION_FIELD);
  else await ctx.redis.hset(key, SESSION_FIELD, JSON.stringify(codes));
}

export async function loadDiscountCodeRows(
  db: Executor,
  codes: readonly string[],
): Promise<Map<string, DiscountCodeRow>> {
  if (codes.length === 0) return new Map();
  const rows = await db
    .select()
    .from(discountCodes)
    .where(inArray(discountCodes.code, codes.map(normalizeDiscountCode)));
  return new Map(rows.map((r) => [r.code, r]));
}

// ─── Availability and usage ─────────────────────────────────────────────────

/** Static availability: switched on, inside its validity window. */
export function discountAvailability(
  row: Pick<DiscountCodeRow, 'isActive' | 'validFrom' | 'validUntil'>,
  now: Date,
): 'INVALID' | 'NOT_STARTED' | 'EXPIRED' | null {
  if (!row.isActive) return 'INVALID';
  if (row.validFrom && row.validFrom > now) return 'NOT_STARTED';
  if (row.validUntil && row.validUntil <= now) return 'EXPIRED';
  return null;
}

const countsAsUsage = (email?: string | null, excludeCartSessionId?: string | null) =>
  and(
    eq(orders.isTest, false),
    inArray(orders.status, [...DISCOUNT_USAGE_ORDER_STATUSES]),
    email ? sql`lower(${orders.email}) = ${email.toLowerCase()}` : undefined,
    // An order this very cart already produced is not "another use" (idempotent re-submit).
    excludeCartSessionId
      ? sql`${orders.cartSessionId} IS DISTINCT FROM ${excludeCartSessionId}`
      : undefined,
  );

/**
 * Active uses per code id (and, with an e-mail, the uses of that address). `excludeCartSessionId`
 * leaves out the orders created from that cart session (checkout quote of a re-submitted cart).
 */
export async function discountUsageCounts(
  db: Executor,
  codeIds: readonly string[],
  email?: string | null,
  excludeCartSessionId?: string | null,
): Promise<{ total: Map<string, number>; perEmail: Map<string, number> }> {
  const total = new Map<string, number>();
  const perEmail = new Map<string, number>();
  if (codeIds.length === 0) return { total, perEmail };
  const rows = await db
    .select({ id: orderDiscounts.discountCodeId, n: sql<number>`count(*)::int` })
    .from(orderDiscounts)
    .innerJoin(orders, eq(orders.id, orderDiscounts.orderId))
    .where(
      and(
        inArray(orderDiscounts.discountCodeId, [...codeIds]),
        countsAsUsage(null, excludeCartSessionId),
      ),
    )
    .groupBy(orderDiscounts.discountCodeId);
  for (const r of rows) total.set(r.id, r.n);
  if (email) {
    const own = await db
      .select({ id: orderDiscounts.discountCodeId, n: sql<number>`count(*)::int` })
      .from(orderDiscounts)
      .innerJoin(orders, eq(orders.id, orderDiscounts.orderId))
      .where(
        and(
          inArray(orderDiscounts.discountCodeId, [...codeIds]),
          countsAsUsage(email, excludeCartSessionId),
        ),
      )
      .groupBy(orderDiscounts.discountCodeId);
    for (const r of own) perEmail.set(r.id, r.n);
  }
  return { total, perEmail };
}

function usageRejection(
  row: DiscountCodeRow,
  usage: { total: Map<string, number>; perEmail: Map<string, number> },
  hasEmail: boolean,
): 'USAGE_LIMIT' | 'EMAIL_LIMIT' | null {
  if (row.maxTotalUses !== null && (usage.total.get(row.id) ?? 0) >= row.maxTotalUses) {
    return 'USAGE_LIMIT';
  }
  if (
    hasEmail &&
    row.maxUsesPerEmail !== null &&
    (usage.perEmail.get(row.id) ?? 0) >= row.maxUsesPerEmail
  ) {
    return 'EMAIL_LIMIT';
  }
  return null;
}

/**
 * Inside the order transaction: locks the code rows (ordered by id, so parallel checkouts cannot
 * deadlock), verifies that they are unchanged since the quote and re-checks the usage limits on
 * the now serialised data. Test orders are not limited (and never counted). Throws a
 * DomainError; the transaction then rolls back.
 */
export async function lockAndCheckDiscountUsage(
  tx: Executor,
  discounts: readonly QuoteDiscount[],
  options: { email: string; isTest: boolean; now: Date },
): Promise<void> {
  if (discounts.length === 0) return;
  const ids = discounts.map((d) => d.discountCodeId);
  const rows = await tx
    .select()
    .from(discountCodes)
    .where(inArray(discountCodes.id, ids))
    .orderBy(discountCodes.id)
    .for('update');
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const d of discounts) {
    const row = byId.get(d.discountCodeId);
    if (!row) throw discountRejectionError({ code: d.code, reason: 'INVALID' });
    const availability = discountAvailability(row, options.now);
    if (availability) throw discountRejectionError({ code: d.code, reason: availability });
    // Edited while the customer was checking out: the discount the customer saw is outdated.
    if (row.updatedAt.getTime() !== d.updatedAt) {
      throw new DomainError('PRICE_CHANGED', 'The price of your order changed', 409);
    }
  }
  if (options.isTest) return;
  const usage = await discountUsageCounts(tx, ids, options.email);
  for (const d of discounts) {
    const reason = usageRejection(byId.get(d.discountCodeId)!, usage, true);
    if (reason) throw discountRejectionError({ code: d.code, reason });
  }
}

// ─── Plan ───────────────────────────────────────────────────────────────────

export interface DiscountPlan {
  applied: QuoteDiscount[];
  rejected: RejectedDiscount[];
  /** Total discount per input line (cents), same order as the lines. */
  perLine: number[];
  /** Codes that took something off each input line, same order as the lines. */
  perLineCodes: string[][];
}

/**
 * Evaluates the codes of a cart against its price lines: availability, usage (when `usage` is
 * given), stacking rules, scope and minimum value, then the allocation. Codes that do not apply
 * are reported as `rejected` and change nothing.
 */
export function planDiscounts(params: {
  codes: readonly string[];
  rows: ReadonlyMap<string, DiscountCodeRow>;
  lines: readonly DiscountLine[];
  now: Date;
  usage?: { total: Map<string, number>; perEmail: Map<string, number> };
  hasEmail?: boolean;
  isTest?: boolean;
  /** Organiser policy (Settings -> Checkout); omitted = unrestricted. */
  policy?: { minimumTotal: number; maxDiscountPercent: number };
}): DiscountPlan {
  const rejected: RejectedDiscount[] = [];
  const candidates: DiscountCodeRow[] = [];
  for (const code of params.codes) {
    const row = params.rows.get(code);
    if (!row) {
      rejected.push({ code, reason: 'INVALID' });
      continue;
    }
    const availability = discountAvailability(row, params.now);
    if (availability) {
      rejected.push({ code, reason: availability });
      continue;
    }
    // Test orders never count against the limits.
    const limit =
      params.usage && !params.isTest
        ? usageRejection(row, params.usage, params.hasEmail ?? false)
        : null;
    if (limit) {
      rejected.push({ code, reason: limit });
      continue;
    }
    if (candidates.length > 0 && (!row.stackable || candidates.some((c) => !c.stackable))) {
      rejected.push({ code, reason: 'NOT_STACKABLE' });
      continue;
    }
    // Codes above the configured percentage cap are refused (never clamped).
    if (params.policy && exceedsPercentCap(row.type, row.value, params.policy.maxDiscountPercent)) {
      rejected.push({ code, reason: 'PERCENT_CAP' });
      continue;
    }
    candidates.push(row);
  }
  let result = applyDiscountRules(candidates, params.lines);
  // Minimum payable total: codes are dropped from the last to the first until the order stays at
  // or above the floor. Only codes are refused - an order that is free without a code is not.
  if (params.policy && params.policy.minimumTotal > 0) {
    const linesTotal = params.lines.reduce((sum, l) => sum + l.gross, 0);
    const total = () => linesTotal - result.perLine.reduce((sum, p) => sum + p, 0);
    const kept = [...candidates];
    while (
      result.applied.length > 0 &&
      violatesMinimumTotal(
        total(),
        result.perLine.reduce((sum, p) => sum + p, 0),
        params.policy.minimumTotal,
      )
    ) {
      // The last code that actually took effect goes first: a candidate the rules never applied
      // (e.g. minimum order value) must not be blamed for the floor.
      const dropped = result.applied[result.applied.length - 1]!.rule;
      kept.splice(
        kept.findIndex((c) => c.id === dropped.id),
        1,
      );
      rejected.push({ code: dropped.code, reason: 'BELOW_MINIMUM_TOTAL' });
      result = applyDiscountRules(kept, params.lines);
    }
  }
  for (const r of result.rejected) {
    rejected.push({
      code: r.rule.code,
      reason: r.reason,
      ...(r.minOrderValue !== undefined ? { minOrderValue: r.minOrderValue } : {}),
    });
  }
  const applied: QuoteDiscount[] = result.applied.map((a, index) => ({
    discountCodeId: a.rule.id,
    code: a.rule.code,
    type: a.rule.type,
    value: a.rule.value,
    amount: a.outcome.total,
    feeAmount: a.outcome.feeTotal,
    position: index + 1,
    updatedAt: a.rule.updatedAt.getTime(),
  }));
  const perLineCodes = params.lines.map(() => [] as string[]);
  for (const a of result.applied) {
    a.outcome.perLine.forEach((part, i) => {
      if (part > 0) perLineCodes[i]!.push(a.rule.code);
    });
  }
  return { applied, rejected, perLine: result.perLine, perLineCodes };
}
