import { splitGross, type TaxBreakdownEntry } from '@tix/shared';
import { DomainError } from '../context';
import { describeOrderItem, type OrderDocumentData } from '../documents/order-data';
import type { MailTranslator } from '../i18n/mail-messages';

/**
 * Pure invoice calculation from an order snapshot: one line per order item and per fee line,
 * the tax split taken verbatim from the stored item / fee amounts (never recomputed, so the
 * invoice always matches what the customer paid), grouped into a tax breakdown per rate.
 *
 * Discount codes (GoBD): an item with a code share is invoiced at its gross price BEFORE the code
 * and followed by its own negative "discount code" line of the same tax rate (orderItemId set, so
 * a credit note of the ticket takes the discount back with it). The discount line's net / tax is
 * the difference of the two splits, so item line + discount line equal the stored (reduced) item
 * amounts exactly and the tax breakdown per rate is net of discounts. Fee lines already carry the
 * reduced fee amounts (the code share of a fee is kept in `order_fees.code_discount_amount`).
 */

export interface InvoiceLineDraft {
  position: number;
  description: string;
  serviceDate: Date | null;
  quantity: number;
  unitPriceGross: number;
  taxRateBasisPoints: number;
  totalNet: number;
  totalTax: number;
  totalGross: number;
  orderItemId: string | null;
  orderFeeId: string | null;
}

export interface InvoiceDraft {
  lines: InvoiceLineDraft[];
  totalNet: number;
  totalTax: number;
  totalGross: number;
  taxBreakdown: TaxBreakdownEntry[];
}

/**
 * @param taxNotes legal notes per rate (basis points) of the tax rates applied to this order,
 *                 e.g. the § 19 UStG small-business note of a 0 % rate.
 */
export function buildInvoiceDraft(
  data: OrderDocumentData,
  t: MailTranslator,
  taxNotes: ReadonlyMap<number, readonly string[]> = new Map(),
): InvoiceDraft {
  const lines: InvoiceLineDraft[] = [];
  // The original sale: everything that was paid (later refunds are credit notes).
  const items = data.items.filter((i) => i.status === 'CONFIRMED' || i.status === 'REFUNDED');
  for (const item of items) {
    const event = data.eventById.get(item.eventId);
    const detail = [
      describeOrderItem(item, t, event?.admission),
      item.categoryName,
      item.ticketTypeName,
    ]
      .filter(Boolean)
      .join(' · ');
    const code = item.codeDiscountAmount;
    // Invoiced price: the price before the discount code (equals the stored price without one).
    const gross = item.priceGross + code;
    const split = code > 0 ? splitGross(gross, item.taxRateBasisPoints) : null;
    lines.push({
      position: lines.length + 1,
      description: event ? `${event.title}\n${detail}` : detail,
      serviceDate: event?.startsAt ?? null,
      quantity: 1,
      unitPriceGross: gross,
      taxRateBasisPoints: item.taxRateBasisPoints,
      totalNet: split ? split.net : item.priceNet,
      totalTax: split ? split.tax : item.taxAmount,
      totalGross: gross,
      orderItemId: item.id,
      orderFeeId: null,
    });
    if (split) {
      lines.push({
        position: lines.length + 1,
        // Only the codes that actually took something off this ticket.
        description: t('invoice.discountLine', {
          codes: (item.codeDiscountCodes.length > 0
            ? item.codeDiscountCodes
            : data.discounts.map((d) => d.code)
          ).join(', '),
        }),
        serviceDate: event?.startsAt ?? null,
        quantity: 1,
        unitPriceGross: -code,
        taxRateBasisPoints: item.taxRateBasisPoints,
        totalNet: item.priceNet - split.net,
        totalTax: item.taxAmount - split.tax,
        totalGross: -code,
        orderItemId: item.id,
        orderFeeId: null,
      });
    }
  }
  for (const fee of data.fees) {
    if (fee.totalGross === 0) continue; // waived fee – nothing to invoice
    const event = fee.eventId ? data.eventById.get(fee.eventId) : undefined;
    // A fee reduced by a code no longer equals unit price x quantity: invoice it as one line at
    // the amount actually charged (the quantity moves into the description).
    const reduced = fee.codeDiscountAmount > 0 && fee.quantity > 1;
    const feeName = reduced
      ? t('items.feeQuantity', { name: fee.name, quantity: fee.quantity })
      : fee.name;
    lines.push({
      position: lines.length + 1,
      description: event ? `${feeName}\n${event.title}` : feeName,
      // PER_ORDER fees have no performance: date of supply = invoice date (legal note).
      serviceDate: event?.startsAt ?? null,
      quantity: reduced ? 1 : fee.quantity,
      unitPriceGross: reduced ? fee.totalGross : fee.unitAmountGross,
      taxRateBasisPoints: fee.taxRateBasisPoints,
      totalNet: fee.totalNet,
      totalTax: fee.totalTax,
      totalGross: fee.totalGross,
      orderItemId: null,
      orderFeeId: fee.id,
    });
  }
  if (lines.length === 0) {
    throw new DomainError('INVOICE_EMPTY', 'The order has no paid items to invoice', 409);
  }

  const sum = (pick: (l: InvoiceLineDraft) => number) => lines.reduce((s, l) => s + pick(l), 0);
  const totalGross = sum((l) => l.totalGross);
  if (totalGross !== data.order.totalGross) {
    throw new DomainError(
      'INVOICE_TOTAL_MISMATCH',
      `Invoice lines (${totalGross}) do not add up to the order total (${data.order.totalGross})`,
      409,
    );
  }

  const byRate = new Map<number, TaxBreakdownEntry>();
  for (const line of lines) {
    const entry = byRate.get(line.taxRateBasisPoints) ?? {
      rateBasisPoints: line.taxRateBasisPoints,
      net: 0,
      tax: 0,
      gross: 0,
    };
    entry.net += line.totalNet;
    entry.tax += line.totalTax;
    entry.gross += line.totalGross;
    byRate.set(line.taxRateBasisPoints, entry);
  }
  const taxBreakdown = [...byRate.values()]
    .sort((a, b) => b.rateBasisPoints - a.rateBasisPoints)
    .map((entry) => {
      const notes = taxNotes.get(entry.rateBasisPoints);
      return notes?.length ? { ...entry, note: notes.join(' ') } : entry;
    });

  return {
    lines,
    totalNet: sum((l) => l.totalNet),
    totalTax: sum((l) => l.totalTax),
    totalGross,
    taxBreakdown,
  };
}
