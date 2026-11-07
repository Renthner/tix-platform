import type { TaxBreakdownEntry } from '@tix/shared';
import { DomainError } from '../context';
import { describeOrderItem, type OrderDocumentData } from '../documents/order-data';
import type { MailTranslator } from '../i18n/mail-messages';

/**
 * Pure invoice calculation from an order snapshot: one line per order item and per fee line,
 * the tax split taken verbatim from the stored item / fee amounts (never recomputed, so the
 * invoice always matches what the customer paid), grouped into a tax breakdown per rate.
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
    const detail = [describeOrderItem(item, t), item.categoryName, item.ticketTypeName]
      .filter(Boolean)
      .join(' · ');
    lines.push({
      position: lines.length + 1,
      description: event ? `${event.title}\n${detail}` : detail,
      serviceDate: event?.startsAt ?? null,
      quantity: 1,
      unitPriceGross: item.priceGross,
      taxRateBasisPoints: item.taxRateBasisPoints,
      totalNet: item.priceNet,
      totalTax: item.taxAmount,
      totalGross: item.priceGross,
      orderItemId: item.id,
      orderFeeId: null,
    });
  }
  for (const fee of data.fees) {
    if (fee.totalGross === 0) continue; // waived fee – nothing to invoice
    const event = fee.eventId ? data.eventById.get(fee.eventId) : undefined;
    lines.push({
      position: lines.length + 1,
      description: event ? `${fee.name}\n${event.title}` : fee.name,
      // PER_ORDER fees have no performance: date of supply = invoice date (legal note).
      serviceDate: event?.startsAt ?? null,
      quantity: fee.quantity,
      unitPriceGross: fee.unitAmountGross,
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
