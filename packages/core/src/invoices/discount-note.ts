import type { FullDiscountPolicy } from '@tix/shared';

/**
 * Organiser-worded invoice note for discounted orders (`invoicing.zeroValueInvoiceNote`). The
 * software never words it itself: whether a free ticket is a gift without consideration
 * (unentgeltliche Wertabgabe) and how it is booked is for each organiser's tax adviser to decide.
 *
 * The text is frozen into `invoices.legal_notes` when the invoice is issued (GoBD), so changing
 * the setting later never alters invoices that already exist.
 *
 *  - an order that a discount code reduced to 0: printed when the full-discount policy is
 *    ALLOW_WITH_NOTE
 *  - any invoice that contains a discount code: printed when `onAllDiscounted` is set
 * Language: the order's locale, falling back to the shop default locale; nothing when empty.
 */
export function discountInvoiceNote(params: {
  policy: FullDiscountPolicy;
  notes: Partial<Record<string, string>>;
  onAllDiscounted: boolean;
  orderLocale: string;
  defaultLocale: string;
  /** The order used at least one discount code. */
  hasDiscount: boolean;
  totalGross: number;
}): string | null {
  if (!params.hasDiscount) return null;
  const text =
    params.notes[params.orderLocale]?.trim() || params.notes[params.defaultLocale]?.trim() || '';
  if (!text) return null;
  if (params.totalGross === 0 && params.policy === 'ALLOW_WITH_NOTE') return text;
  return params.onAllDiscounted ? text : null;
}
