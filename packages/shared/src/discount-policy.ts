import type { DiscountCodeType } from './enums';

/**
 * Policy for discounts that reduce an order to (almost) nothing – pure decision logic, shared by
 * the shop quote, the admin code form and the tests.
 *
 * The organiser decides (Settings -> Checkout); the software hard-codes no tax or accounting
 * opinion. Whether a free ticket counts as a "gift" (unentgeltliche Wertabgabe) or how it is
 * booked is a question for the organiser's own tax adviser.
 *
 *  - ALLOW            discounts may reduce the payable total down to 0 (default, the original behaviour)
 *  - ALLOW_WITH_NOTE  same, and the invoice of such an order carries the configured invoice note
 *  - DISALLOW         a code that would take the total below the minimum payable amount (at least
 *                     0.01) is refused; orders that are free without a code are not affected
 */
export const FULL_DISCOUNT_POLICIES = ['ALLOW', 'ALLOW_WITH_NOTE', 'DISALLOW'] as const;
export type FullDiscountPolicy = (typeof FULL_DISCOUNT_POLICIES)[number];

export interface DiscountPolicySettings {
  fullDiscountPolicy: FullDiscountPolicy;
  /** Minimum payable total after discount codes (cents). 0 = unrestricted. */
  minimumOrderTotalAfterDiscounts: number;
  /** Highest percentage a PERCENT code may have (1 - 100). */
  maxDiscountPercent: number;
}

/** Smallest total (cents) an order may have after discount codes were applied. */
export function effectiveMinimumTotal(
  settings: Pick<DiscountPolicySettings, 'fullDiscountPolicy' | 'minimumOrderTotalAfterDiscounts'>,
): number {
  const minimum = Math.max(0, Math.trunc(settings.minimumOrderTotalAfterDiscounts));
  return settings.fullDiscountPolicy === 'DISALLOW' ? Math.max(minimum, 1) : minimum;
}

/** Does a total after codes (cents) fall below the floor, given that codes reduced it? */
export function violatesMinimumTotal(
  totalAfterCodes: number,
  codeDiscountTotal: number,
  minimum: number,
): boolean {
  return codeDiscountTotal > 0 && totalAfterCodes < minimum;
}

/** Is a PERCENT code (value in basis points) above the configured cap? FIXED codes never are. */
export function exceedsPercentCap(
  type: DiscountCodeType,
  valueBasisPoints: number,
  maxDiscountPercent: number,
): boolean {
  return type === 'PERCENT' && valueBasisPoints > maxDiscountPercent * 100;
}

export type FullDiscountWarning = 'FULL_PERCENT' | 'FIXED_COVERS_PRICE' | 'FIXED_MAY_COVER_PRICE';

/**
 * Admin hint for a code that can make an order free. `lowestPrice` is the cheapest gross price
 * (cents) of the tickets in the code's scope when known; a FIXED code of at least that amount
 * covers it, otherwise (unknown price) the hint is generic.
 */
export function fullDiscountWarning(
  code: { type: DiscountCodeType; value: number },
  lowestPrice: number | null,
): FullDiscountWarning | null {
  if (code.type === 'PERCENT') return code.value >= 10_000 ? 'FULL_PERCENT' : null;
  if (lowestPrice === null) return 'FIXED_MAY_COVER_PRICE';
  return code.value >= lowestPrice ? 'FIXED_COVERS_PRICE' : null;
}
