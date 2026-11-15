import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  DomainError,
  buildInvoiceDraft,
  mailTranslator,
  renderInvoicePdfDocument,
  type InvoicePdfInput,
  type OrderDocumentData,
  type OrderFeeRow,
  type OrderItemRow,
  type OrderRow,
} from '../src';
import { extractPdfText } from './pdf-extract';

const EVENT_START = new Date('2026-12-12T18:30:00Z');

function item(n: number, overrides: Partial<OrderItemRow> = {}): OrderItemRow {
  return {
    id: `item-${n}`,
    orderId: 'order-1',
    eventId: 'event-1',
    kind: 'SEAT',
    seatId: `seat-${n}`,
    sectionId: 'section-1',
    priceCategoryId: 'cat-1',
    ticketTypeId: 'tt-1',
    status: 'CONFIRMED',
    accessCodeId: null,
    sectionLabel: 'Parkett',
    rowLabel: '3',
    seatLabel: String(n),
    entranceLabel: null,
    categoryName: 'Kategorie 1',
    ticketTypeName: 'Normal',
    unitPriceGross: 3210,
    discountAmount: 0,
    codeDiscountAmount: 0,
    codeDiscountCodes: [],
    priceGross: 3210,
    taxRateBasisPoints: 700,
    priceNet: 3000,
    taxAmount: 210,
    attendeeName: null,
    cancelledAt: null,
    refundedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fee(overrides: Partial<OrderFeeRow> = {}): OrderFeeRow {
  return {
    id: 'fee-1',
    orderId: 'order-1',
    eventId: null,
    feeId: null,
    name: 'Service fee',
    scope: 'PER_ORDER',
    quantity: 1,
    unitAmountGross: 119,
    totalGross: 119,
    taxRateBasisPoints: 1900,
    totalNet: 100,
    totalTax: 19,
    codeDiscountAmount: 0,
    isRefunded: false,
    createdAt: new Date(),
    ...overrides,
  };
}

function data(
  items: OrderItemRow[],
  fees: OrderFeeRow[],
  totalGross?: number,
  discounts: OrderDocumentData['discounts'] = [],
): OrderDocumentData {
  const total =
    totalGross ??
    [...items.map((i) => i.priceGross), ...fees.map((f) => f.totalGross)].reduce(
      (a, b) => a + b,
      0,
    );
  const event = {
    id: 'event-1',
    title: 'Winterkonzert',
    subtitle: null,
    startsAt: EVENT_START,
    doorsOpenAt: null,
    timeZone: 'Europe/Berlin',
    taxRateId: 'tax-7',
    venueName: 'Stadthalle',
    venueCity: 'Musterstadt',
    venueAddress: null,
  };
  return {
    order: { totalGross: total, status: 'PAID', currency: 'EUR' } as OrderRow,
    items,
    fees,
    discounts,
    events: [event],
    eventById: new Map([[event.id, event]]),
  };
}

describe('invoice calculation', () => {
  const t = mailTranslator('de');

  it('creates one line per item and fee with the stored tax split', () => {
    const draft = buildInvoiceDraft(
      data(
        [item(1), item(2, { status: 'REFUNDED' }), item(3, { status: 'CANCELLED' })],
        [fee(), fee({ id: 'fee-2', totalGross: 0, totalNet: 0, totalTax: 0, unitAmountGross: 0 })],
        3210 * 2 + 119,
      ),
      t,
      new Map([[700, ['Note 7 %']]]),
    );
    expect(draft.lines).toHaveLength(3); // cancelled item and waived fee are skipped
    expect(draft.lines.map((l) => l.position)).toEqual([1, 2, 3]);
    expect(draft.lines[0]).toMatchObject({
      description: 'Winterkonzert\nBlock Parkett · Reihe 3 · Platz 1 · Kategorie 1 · Normal',
      serviceDate: EVENT_START,
      totalGross: 3210,
      totalNet: 3000,
      totalTax: 210,
      orderItemId: 'item-1',
    });
    expect(draft.lines[2]).toMatchObject({ orderFeeId: 'fee-1', serviceDate: null });
    expect(draft.totalGross).toBe(3210 * 2 + 119);
    expect(draft.totalNet + draft.totalTax).toBe(draft.totalGross);
    expect(draft.taxBreakdown).toEqual([
      { rateBasisPoints: 1900, net: 100, tax: 19, gross: 119 },
      { rateBasisPoints: 700, net: 6000, tax: 420, gross: 6420, note: 'Note 7 %' },
    ]);
  });

  it('invoices discounted tickets at the price before the code plus a negative discount line', () => {
    // 3210 gross at 7 % with a 321 code share: stored (reduced) price 2889 = 2700 net + 189 tax.
    const discounted = item(1, {
      unitPriceGross: 3210,
      codeDiscountAmount: 321,
      codeDiscountCodes: ['SPRING10'],
      priceGross: 2889,
      priceNet: 2700,
      taxAmount: 189,
    });
    const draft = buildInvoiceDraft(
      data([discounted, item(2)], [], 2889 + 3210, [
        {
          id: 'd1',
          orderId: 'order-1',
          discountCodeId: 'c1',
          code: 'SPRING10',
          type: 'PERCENT',
          value: 1000,
          amount: 321,
          feeAmount: 0,
          position: 1,
          createdAt: new Date(),
        },
        // a second code of the order that did not touch this ticket: not named on its line
        {
          id: 'd2',
          orderId: 'order-1',
          discountCodeId: 'c2',
          code: 'OTHERCODE',
          type: 'FIXED',
          value: 100,
          amount: 100,
          feeAmount: 0,
          position: 2,
          createdAt: new Date(),
        },
      ]),
      t,
    );
    expect(draft.lines.map((l) => [l.orderItemId, l.totalGross])).toEqual([
      ['item-1', 3210],
      ['item-1', -321],
      ['item-2', 3210],
    ]);
    expect(draft.lines[1]).toMatchObject({
      description: 'Rabattcode SPRING10',
      taxRateBasisPoints: 700,
    });
    // item line + discount line = stored reduced amounts, net and tax separately
    expect(draft.lines[0]!.totalNet + draft.lines[1]!.totalNet).toBe(2700);
    expect(draft.lines[0]!.totalTax + draft.lines[1]!.totalTax).toBe(189);
    expect(draft.totalGross).toBe(2889 + 3210);
    expect(draft.totalNet + draft.totalTax).toBe(draft.totalGross);
    expect(draft.taxBreakdown).toEqual([
      { rateBasisPoints: 700, net: 2700 + 3000, tax: 189 + 210, gross: 2889 + 3210 },
    ]);
  });

  it('invoices a reduced fee with quantity > 1 as one line so that unit x quantity = total', () => {
    // 3 x 119 = 357 gross, 57 taken off by a code: 300 gross at 19 % = 252 net + 48 tax
    const reduced = fee({
      quantity: 3,
      unitAmountGross: 100,
      totalGross: 300,
      totalNet: 252,
      totalTax: 48,
      codeDiscountAmount: 57,
    });
    const draft = buildInvoiceDraft(data([item(1)], [reduced]), t);
    const line = draft.lines.find((l) => l.orderFeeId === 'fee-1')!;
    expect(line.quantity).toBe(1);
    expect(line.unitPriceGross * line.quantity).toBe(line.totalGross);
    expect(line.totalGross).toBe(300);
    expect(line.description).toContain('Service fee');
    expect(line.description).toContain('3');
    // an untouched fee keeps its quantity
    const plain = buildInvoiceDraft(
      data(
        [item(1)],
        [fee({ quantity: 2, unitAmountGross: 119, totalGross: 238, totalNet: 200, totalTax: 38 })],
      ),
      t,
    );
    const plainLine = plain.lines.find((l) => l.orderFeeId === 'fee-1')!;
    expect(plainLine.quantity).toBe(2);
  });

  it('refuses to invoice when the lines do not add up to the order total', () => {
    expect(() => buildInvoiceDraft(data([item(1)], [], 9999), t)).toThrow(DomainError);
    expect(() => buildInvoiceDraft(data([], []), t)).toThrow(/no paid items/);
  });
});

describe('invoice PDF', () => {
  const lines = Array.from({ length: 40 }, (_, i) => ({
    position: i + 1,
    description: `Winterkonzert\nBlock Parkett · Reihe ${Math.floor(i / 10) + 1} · Platz ${i + 1}`,
    serviceDate: EVENT_START,
    quantity: 1,
    unitPriceGross: 3210,
    taxRateBasisPoints: 700,
    totalGross: 3210,
  }));
  const input: InvoicePdfInput = {
    type: 'INVOICE',
    invoiceNumber: 'RE-2026-000042',
    issuedAt: new Date('2026-11-05T10:00:00Z'),
    correctsInvoiceNumber: null,
    currency: 'EUR',
    seller: {
      name: 'Example Theatre e.V.',
      address: { street: 'Musterweg 1', postalCode: '12345', city: 'Musterstadt', country: 'DE' },
      email: 'info@example.org',
      vatId: 'DE000000000',
      registerCourt: 'Amtsgericht Musterstadt',
      registerNumber: 'VR 0000',
    },
    buyer: {
      name: 'Jürgen Müller',
      address: {
        street: 'Hauptstraße 5',
        postalCode: '54321',
        city: 'Beispielhausen',
        country: 'AT',
      },
      email: 'buyer@example.org',
    },
    orderNumber: '2026-000042',
    orderDate: new Date('2026-11-01T09:00:00Z'),
    paymentMethodLabel: 'PayPal',
    lines,
    totalNet: 120_000,
    totalTax: 8_400,
    totalGross: 128_400,
    taxBreakdown: [{ rateBasisPoints: 700, net: 120_000, tax: 8_400, gross: 128_400 }],
    legalNotes: 'Sofern nicht anders angegeben, entspricht das Leistungsdatum dem Rechnungsdatum.',
    footerText: 'Bankverbindung: Beispielbank · IBAN DE00 0000 0000 0000 0000 00',
    locale: 'de',
    timeZone: 'Europe/Berlin',
  };

  it('renders a multi-page A4 PDF with German texts and umlauts', async () => {
    const bytes = await renderInvoicePdfDocument(input, mailTranslator('de'));
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(Math.round(width)).toBe(595);
    expect(Math.round(height)).toBe(842);
    expect(doc.getTitle()).toBe('Rechnung RE-2026-000042');
    expect(doc.getCreationDate()?.toISOString()).toBe('2026-11-05T10:00:00.000Z');
    const texts = await extractPdfText(bytes);
    for (const text of ['Jürgen Müller', 'Rechnung RE-2026-000042', 'Gesamtbetrag', 'AT']) {
      expect(texts, text).toContain(text);
    }
    expect(texts).toContain(`Seite 2 von ${doc.getPageCount()}`);
  });

  it('is deterministic (re-rendering reproduces the archived document)', async () => {
    const a = await renderInvoicePdfDocument(input, mailTranslator('de'));
    const b = await renderInvoicePdfDocument(input, mailTranslator('de'));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('renders credit notes in English', async () => {
    const bytes = await renderInvoicePdfDocument(
      {
        ...input,
        type: 'CREDIT_NOTE',
        invoiceNumber: 'GS-2026-000001',
        correctsInvoiceNumber: 'RE-2026-000042',
        lines: lines.slice(0, 1),
        locale: 'en',
      },
      mailTranslator('en'),
    );
    const texts = await extractPdfText(bytes);
    expect(texts).toContain('Credit note GS-2026-000001');
    expect(texts).toContain('RE-2026-000042');
  });

  it('a correction credit note says which invoice it corrects; a refund credit note does not', async () => {
    const credit = {
      ...input,
      type: 'CREDIT_NOTE' as const,
      invoiceNumber: 'GS-2026-000001',
      correctsInvoiceNumber: 'RE-2026-000042',
      lines: lines.slice(0, 1),
      locale: 'en',
    };
    const t = mailTranslator('en');
    const correction = (
      await extractPdfText(await renderInvoicePdfDocument({ ...credit, isCorrection: true }, t))
    ).join(' ');
    expect(correction).toContain('corrects invoice RE-2026-000042');
    const refund = (await extractPdfText(await renderInvoicePdfDocument(credit, t))).join(' ');
    expect(refund).not.toContain('corrects invoice RE-2026-000042');
  });

  it('prints the frozen payment note (previous + additional payment, nothing due)', async () => {
    const note =
      'Previously paid: €58.00. Additional payment: €5.00 (received Nov 10, 2026, PayPal). The invoice total of €63.00 is paid in full; nothing is due.';
    const texts = (
      await extractPdfText(
        await renderInvoicePdfDocument(
          { ...input, lines: lines.slice(0, 1), locale: 'en', legalNotes: note },
          mailTranslator('en'),
        ),
      )
    ).join(' ');
    expect(texts).toContain('Previously paid: €58.00');
    expect(texts).toContain('nothing is due');
  });

  it('prints the organiser-worded note of a discount-reduced invoice of 0.00', async () => {
    const note = 'Free ticket: VAT treatment as agreed with the organiser tax adviser.';
    const texts = (
      await extractPdfText(
        await renderInvoicePdfDocument(
          {
            ...input,
            lines: lines.slice(0, 1),
            locale: 'en',
            legalNotes: `Paid.
${note}`,
          },
          mailTranslator('en'),
        ),
      )
    ).join(' ');
    expect(texts).toContain('Free ticket: VAT treatment');
  });
});
