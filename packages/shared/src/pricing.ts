import type { DiscountKind } from './enums';

/**
 * Price calculation for one ticket. All values are integer cents (gross).
 * `unitPriceGross - discountAmount = priceGross` always holds (mirrors the DB CHECK).
 */
export interface TicketTypePricing {
  discountKind: DiscountKind;
  /** Basis points for PERCENT, cents for FIXED_AMOUNT / FIXED_PRICE. */
  discountValue: number;
}

export interface TicketPrice {
  unitPriceGross: number;
  discountAmount: number;
  priceGross: number;
}

/**
 * Per price category override of a tariff (price_category_ticket_types):
 *  - `priceOverride` → fixed final price in this category, or
 *  - `discountKind` + `discountValue` → category-specific discount (e.g. Cat 1 −5 €, Cat 2 −4 €).
 * Without an override the tariff's own discount rule applies.
 */
export interface CategoryTariffOverride {
  priceOverride?: number | null;
  discountKind?: DiscountKind | null;
  discountValue?: number | null;
}

function applyDiscount(basePrice: number, rule: TicketTypePricing): number {
  switch (rule.discountKind) {
    case 'NONE':
      return basePrice;
    case 'PERCENT':
      return basePrice - Math.round((basePrice * rule.discountValue) / 10_000);
    case 'FIXED_AMOUNT':
      return Math.max(0, basePrice - rule.discountValue);
    case 'FIXED_PRICE':
      return rule.discountValue;
  }
}

export function computeTicketPrice(
  basePrice: number,
  ticketType: TicketTypePricing,
  override?: number | null | CategoryTariffOverride,
): TicketPrice {
  assertCents(basePrice, 'basePrice');
  const cell: CategoryTariffOverride =
    typeof override === 'number' || override === null || override === undefined
      ? { priceOverride: override ?? null }
      : override;
  let final: number;
  if (cell.priceOverride !== undefined && cell.priceOverride !== null) {
    assertCents(cell.priceOverride, 'priceOverride');
    final = cell.priceOverride;
  } else if (cell.discountKind && cell.discountValue !== undefined && cell.discountValue !== null) {
    final = applyDiscount(basePrice, {
      discountKind: cell.discountKind,
      discountValue: cell.discountValue,
    });
  } else {
    final = applyDiscount(basePrice, ticketType);
  }
  final = Math.max(0, final);
  // A tariff above the category price (premium) is shown as its own list price.
  const unitPriceGross = Math.max(basePrice, final);
  return { unitPriceGross, discountAmount: unitPriceGross - final, priceGross: final };
}

/** Splits a gross amount into net + tax for a rate in basis points (half-up rounding). */
export function splitGross(gross: number, rateBasisPoints: number): { net: number; tax: number } {
  assertCents(gross, 'gross');
  const tax = Math.round((gross * rateBasisPoints) / (10_000 + rateBasisPoints));
  return { net: gross - tax, tax };
}

function assertCents(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer amount of cents`);
  }
}
