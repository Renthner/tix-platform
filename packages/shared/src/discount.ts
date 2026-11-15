import type { DiscountCodeType } from './enums';

/**
 * Discount codes – pure calculation (no I/O), shared by the shop quote and the tests.
 *
 * ROUNDING AND ALLOCATION (GoBD / VAT)
 *  - All amounts are integer cents (gross). A PERCENT code takes `round-half-up(base × bp / 10 000)`
 *    of the eligible base; a FIXED code takes `min(value, base)`. The discount never exceeds the
 *    eligible base, so no line and no order total can become negative.
 *  - The total is distributed over the eligible lines proportionally to their current gross
 *    price with the **largest remainder method**: every line gets `floor(total × price / base)`,
 *    the cents that are left go one by one to the lines with the largest fractional remainder
 *    (ties: the earlier line). The parts always add up to the total exactly, and no line receives
 *    more than its own price.
 *  - Every line carries exactly one tax rate and its tax is split from the discounted gross price
 *    afterwards (`splitGross`), so the VAT per rate always equals the sum over the lines – the
 *    discount is therefore allocated "per tax rate" by construction.
 *  - Several (stackable) codes are applied one after another, each one on the prices left by the
 *    previous one.
 */

export interface DiscountLine {
  kind: 'item' | 'fee';
  /** Event of the line; null for per-order fees. */
  eventId: string | null;
  categoryId: string | null;
  ticketTypeId: string | null;
  /** Current gross price of the line (after earlier discounts). */
  gross: number;
}

export interface DiscountRuleInput {
  type: DiscountCodeType;
  /** Cents (FIXED) or basis points (PERCENT). */
  value: number;
  allEvents: boolean;
  eventIds: readonly string[];
  /** Empty = all price categories. */
  categoryIds: readonly string[];
  /** Empty = all tariffs. */
  ticketTypeIds: readonly string[];
  /** Minimum value of the eligible tickets (cents). */
  minOrderValue: number | null;
  discountFees: boolean;
}

export type DiscountRejection = 'NOT_VALID_FOR_ITEMS' | 'MIN_ORDER_VALUE';

export type DiscountOutcome =
  | { ok: true; total: number; itemTotal: number; feeTotal: number; perLine: number[] }
  | { ok: false; reason: DiscountRejection; minOrderValue?: number };

/** Largest remainder allocation of `total` over `weights` (see the module comment). */
export function allocateLargestRemainder(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!Number.isInteger(total) || total < 0) throw new RangeError('total must be cents >= 0');
  if (total === 0 || sum === 0) return weights.map(() => 0);
  if (total > sum) throw new RangeError('total exceeds the sum of the weights');
  const parts = weights.map((w, index) => {
    // Integer arithmetic: w × total stays far below 2^53 for realistic orders (cents × cents).
    const exact = w * total;
    return { index, base: Math.floor(exact / sum), remainder: exact % sum };
  });
  let left = total - parts.reduce((a, p) => a + p.base, 0);
  const byRemainder = [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const p of byRemainder) {
    if (left === 0) break;
    if (p.remainder > 0) {
      p.base += 1;
      left -= 1;
    }
  }
  return parts.map((p) => p.base);
}

/** Does the code apply to this ticket line (event / category / tariff scope)? */
function eligibleItem(rule: DiscountRuleInput, line: DiscountLine): boolean {
  if (line.gross <= 0) return false;
  if (!rule.allEvents && (line.eventId === null || !rule.eventIds.includes(line.eventId))) {
    return false;
  }
  if (rule.categoryIds.length > 0) {
    if (line.categoryId === null || !rule.categoryIds.includes(line.categoryId)) return false;
  }
  if (rule.ticketTypeIds.length > 0) {
    if (line.ticketTypeId === null || !rule.ticketTypeIds.includes(line.ticketTypeId)) {
      return false;
    }
  }
  return true;
}

/**
 * Fee lines are only discounted when the code is not restricted to categories / tariffs, and
 * only fees of an event in scope (per-order fees: when any ticket is eligible).
 */
function eligibleFee(rule: DiscountRuleInput, line: DiscountLine, anyItem: boolean): boolean {
  if (!rule.discountFees || line.gross <= 0) return false;
  if (rule.categoryIds.length > 0 || rule.ticketTypeIds.length > 0) return false;
  if (line.eventId === null) return anyItem;
  return rule.allEvents || rule.eventIds.includes(line.eventId);
}

export function applyDiscountRule(
  rule: DiscountRuleInput,
  lines: readonly DiscountLine[],
): DiscountOutcome {
  const itemEligible = lines.map((l) => l.kind === 'item' && eligibleItem(rule, l));
  const anyItem = itemEligible.some(Boolean);
  const eligible = lines.map((l, i) =>
    l.kind === 'item' ? itemEligible[i]! : eligibleFee(rule, l, anyItem),
  );
  const itemBase = lines.reduce((s, l, i) => s + (itemEligible[i] ? l.gross : 0), 0);
  if (!anyItem || itemBase <= 0) return { ok: false, reason: 'NOT_VALID_FOR_ITEMS' };
  if (rule.minOrderValue !== null && itemBase < rule.minOrderValue) {
    return { ok: false, reason: 'MIN_ORDER_VALUE', minOrderValue: rule.minOrderValue };
  }
  const base = lines.reduce((s, l, i) => s + (eligible[i] ? l.gross : 0), 0);
  const wanted =
    rule.type === 'PERCENT' ? Math.round((base * rule.value) / 10_000) : Math.round(rule.value);
  const total = Math.min(Math.max(wanted, 0), base);
  if (total <= 0) return { ok: false, reason: 'NOT_VALID_FOR_ITEMS' };
  const indexes = lines.flatMap((_, i) => (eligible[i] ? [i] : []));
  const shares = allocateLargestRemainder(
    total,
    indexes.map((i) => lines[i]!.gross),
  );
  const perLine = lines.map(() => 0);
  indexes.forEach((lineIndex, k) => {
    perLine[lineIndex] = shares[k]!;
  });
  const itemTotal = lines.reduce((s, l, i) => s + (l.kind === 'item' ? perLine[i]! : 0), 0);
  return { ok: true, total, itemTotal, feeTotal: total - itemTotal, perLine };
}

export interface AppliedDiscount<R> {
  rule: R;
  outcome: Extract<DiscountOutcome, { ok: true }>;
}

/**
 * Applies the rules in order, each on the prices left by the previous one. A rule that does not
 * apply is reported in `rejected` and changes nothing.
 */
export function applyDiscountRules<R extends DiscountRuleInput>(
  rules: readonly R[],
  lines: readonly DiscountLine[],
): {
  applied: AppliedDiscount<R>[];
  rejected: { rule: R; reason: DiscountRejection; minOrderValue?: number }[];
  /** Total discount per line over all applied rules. */
  perLine: number[];
} {
  const remaining = lines.map((l) => ({ ...l }));
  const perLine = lines.map(() => 0);
  const applied: AppliedDiscount<R>[] = [];
  const rejected: { rule: R; reason: DiscountRejection; minOrderValue?: number }[] = [];
  for (const rule of rules) {
    const outcome = applyDiscountRule(rule, remaining);
    if (!outcome.ok) {
      rejected.push({
        rule,
        reason: outcome.reason,
        ...(outcome.minOrderValue !== undefined ? { minOrderValue: outcome.minOrderValue } : {}),
      });
      continue;
    }
    applied.push({ rule, outcome });
    outcome.perLine.forEach((part, i) => {
      remaining[i]!.gross -= part;
      perLine[i] = perLine[i]! + part;
    });
  }
  return { applied, rejected, perLine };
}

/** Normalised form of a code: inner whitespace removed, upper-case. */
export function normalizeDiscountCode(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

export const DISCOUNT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;
export const DISCOUNT_BULK_MAX = 5000;
/** Alphabet of generated codes: no 0/O, 1/I/L (dictated over the phone, typed from print). */
export const DISCOUNT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
