import { describe, expect, it } from 'vitest';
import { buildOrderViewModel, type OrderAdminView } from '../src';

const view = {
  order: {
    id: 'o1',
    totalGross: 10000,
    amountPaid: 4000,
    amountRefunded: 500,
    codeDiscountTotal: 300,
    internalNote: 'SECRET-NOTE',
    customerNote: 'SECRET-CUSTOMER',
  },
  events: [
    {
      eventId: 'e1',
      slug: 's',
      title: 'Show',
      startsAt: '2030-01-01T10:00:00Z',
      timeZone: 'UTC',
      venueName: 'Hall',
      admission: false,
      items: [
        {
          id: 'i1',
          kind: 'SEAT',
          status: 'CONFIRMED',
          sectionLabel: 'A',
          rowLabel: '1',
          seatLabel: '2',
          categoryName: 'Cat',
          ticketTypeName: 'Reduced',
          unitPriceGross: 5000,
          discountAmount: 500,
          codeDiscountAmount: 300,
          priceGross: 4200,
        },
        {
          id: 'i2',
          kind: 'GENERAL_ADMISSION',
          status: 'REFUNDED',
          sectionLabel: 'B',
          rowLabel: null,
          seatLabel: null,
          categoryName: 'Cat',
          ticketTypeName: 'Normal',
          unitPriceGross: 1000,
          discountAmount: 0,
          codeDiscountAmount: 0,
          priceGross: 1000,
        },
      ],
    },
  ],
  fees: [
    { id: 'f1', eventId: 'e1', name: 'Event fee', quantity: 2, totalGross: 200 },
    { id: 'f2', eventId: null, name: 'Order fee', quantity: 1, totalGross: 100 },
  ],
  discounts: [
    { code: 'A', amount: 100 },
    { code: 'B', amount: 200 },
  ],
  taxes: [
    { rateBasisPoints: 0, net: 100, tax: 0 },
    { rateBasisPoints: 1900, net: 8000, tax: 1520 },
  ],
  tickets: [],
  invoices: [
    {
      id: 'v1',
      type: 'INVOICE',
      invoiceNumber: 'R1',
      issuedAt: 'x',
      correctsNumber: null,
      isCorrection: false,
    },
    {
      id: 'v2',
      type: 'CREDIT_NOTE',
      invoiceNumber: 'G1',
      issuedAt: 'x',
      correctsNumber: 'R1',
      isCorrection: true,
    },
    {
      id: 'v3',
      type: 'CREDIT_NOTE',
      invoiceNumber: 'G2',
      issuedAt: 'x',
      correctsNumber: 'R1',
      isCorrection: false,
    },
  ],
  bankAccount: { accountHolder: 'H', iban: 'DE00', bic: null, bankName: null },
  paypal: { payable: false, expiresAt: null },
  outstanding: 0,
  adjustment: null,
  // admin-only data that must never reach the shop model
  payments: [{ id: 'p1', providerCaptureId: 'CAPTURE-SECRET' }],
  allocations: [{ id: 'a1', bankTransactionId: 'BANKTX-SECRET' }],
  history: [{ id: 'h1', actorName: 'ADMIN-SECRET' }],
  emails: [],
  soldByName: 'SELLER-SECRET',
} as unknown as OrderAdminView;

describe('buildOrderViewModel', () => {
  it('shop: code discount in item price, event fees per event, order fees in totals', () => {
    const m = buildOrderViewModel(view, { audience: 'shop', tokenQuery: '?t=abc' });
    expect(m.events[0]!.items[0]).toMatchObject({ price: 4500, strikePrice: null, struck: false });
    expect(m.events[0]!.items[1]).toMatchObject({ struck: true, refunded: true });
    expect(m.events[0]!.fees.map((f) => f.id)).toEqual(['f1']);
    expect(m.totals.fees.map((f) => f.id)).toEqual(['f2']);
    expect(m.totals.discount).toEqual({ codes: 'A, B', amount: 300 });
    expect(m.totals.taxes).toHaveLength(1);
    expect(m.totals.paid).toBe(4000);
    expect(m.totals.refunded).toBe(500);
    expect(m.invoices.map((i) => [i.kind, i.href])).toEqual([
      ['invoice', '/api/orders/o1/invoices/v1?t=abc'],
      ['correction', '/api/orders/o1/invoices/v2?t=abc'],
      ['creditNote', '/api/orders/o1/invoices/v3?t=abc'],
    ]);
    expect(m.bank).toEqual({ holder: 'H', iban: 'DE00', bic: null, bankName: null });
  });

  it('admin: booked price with struck list price, all fees and taxes, admin links, no bank block', () => {
    const m = buildOrderViewModel(view, { audience: 'admin' });
    expect(m.events[0]!.items[0]).toMatchObject({ price: 4200, strikePrice: 5000 });
    expect(m.events[0]!.fees).toEqual([]);
    expect(m.totals.fees.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(m.totals.taxes).toHaveLength(2);
    expect(m.totals.discount).toBeNull();
    expect(m.invoices[0]!.href).toBe('/api/admin/invoices/v1');
    expect(m.bank).toBeNull();
  });

  it('shop model never carries admin-only data, even when fed an admin view', () => {
    const json = JSON.stringify(buildOrderViewModel(view, { audience: 'shop' }));
    for (const secret of [
      'SECRET-NOTE',
      'SECRET-CUSTOMER',
      'CAPTURE-SECRET',
      'BANKTX-SECRET',
      'ADMIN-SECRET',
      'SELLER-SECRET',
    ]) {
      expect(json).not.toContain(secret);
    }
  });
});
