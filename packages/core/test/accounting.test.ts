import { accountingPreset, accountingSchema, type AccountingSettings } from '@tix/shared';
import { describe, expect, it } from 'vitest';
import {
  buildAccountingCsv,
  buildDatevExport,
  buildCsv,
  csvCell,
  datevBookingLine,
  datevHeaderLine,
  fiscalYearEnd,
  fiscalYearStartOf,
  formatCsvAmount,
  formatDatevAmount,
  instantRange,
  rangePresets,
  sanitizeBookingText,
  sanitizeVoucher,
  type AccountingData,
  type AccountingDocument,
  type DatevLabels,
} from '../src';
import { encodeCp1252 } from '../src/accounting/encoding';

const tz = 'Europe/Berlin';
const labels: DatevLabels = {
  invoice: 'Rechnung',
  creditNote: 'Gutschrift',
  payment: 'Zahlung',
  paymentReversal: 'Zahlung storniert',
  writeOff: 'Restbetrag ausgebucht',
  writeOffReversal: 'Ausbuchung rueckgaengig',
  refund: 'Erstattung',
  description: 'Ticket sales 03/2026',
  exportedBy: 'tix',
};

const settings = (over: Record<string, unknown> = {}): AccountingSettings =>
  accountingSchema.parse({ consultantNumber: 1001, clientNumber: 1, ...over });

const doc = (over: Partial<AccountingDocument>): AccountingDocument => ({
  id: 'i1',
  number: 'RE-2026-000001',
  type: 'INVOICE',
  issuedAt: new Date('2026-03-05T10:00:00Z'),
  correctsNumber: null,
  orderNumber: '2026-000001',
  orderStatus: 'PAID',
  paymentMethod: 'BANK_TRANSFER',
  buyerName: 'Max Muster',
  buyerCompany: '',
  currency: 'EUR',
  totalNet: 0,
  totalTax: 0,
  totalGross: 0,
  breakdown: [],
  lines: [],
  ...over,
});

const invoice = doc({
  totalGross: 11900 + 10700 + 119,
  totalNet: 10000 + 10000 + 100,
  totalTax: 1900 + 700 + 19,
  breakdown: [
    { rateBasisPoints: 700, net: 10000, tax: 700, gross: 10700 },
    { rateBasisPoints: 1900, net: 10100, tax: 1919, gross: 12019 },
  ],
  lines: [
    { rateBasisPoints: 1900, isFee: false, net: 10000, tax: 1900, gross: 11900 },
    { rateBasisPoints: 700, isFee: false, net: 10000, tax: 700, gross: 10700 },
    { rateBasisPoints: 1900, isFee: true, net: 100, tax: 19, gross: 119 },
  ],
});
const creditNote = doc({
  id: 'c1',
  number: 'GS-2026-000001',
  type: 'CREDIT_NOTE',
  issuedAt: new Date('2026-03-06T09:00:00Z'),
  correctsNumber: 'RE-2026-000001',
  totalGross: -11900,
  totalNet: -10000,
  totalTax: -1900,
  breakdown: [{ rateBasisPoints: 1900, net: -10000, tax: -1900, gross: -11900 }],
  lines: [{ rateBasisPoints: 1900, isFee: false, net: -10000, tax: -1900, gross: -11900 }],
});
const data: AccountingData = {
  paymentReversals: [],
  writeOffs: [],
  documents: [invoice, creditNote],
  payments: [
    {
      capturedAt: new Date('2026-03-07T08:00:00Z'),
      orderNumber: '2026-000001',
      voucher: 'RE-2026-000001',
      method: 'BANK_TRANSFER',
      amount: 22719,
      currency: 'EUR',
      paymentReference: 'TIX-2026-000001-1',
      providerReference: null,
      isTest: false,
    },
    {
      capturedAt: new Date('2026-03-08T08:00:00Z'),
      orderNumber: '2026-000002',
      voucher: '2026-000002',
      method: 'PAYPAL',
      amount: 5000,
      currency: 'EUR',
      paymentReference: null,
      providerReference: 'CAP1',
      isTest: false,
    },
  ],
  refunds: [
    {
      processedAt: new Date('2026-03-09T08:00:00Z'),
      orderNumber: '2026-000001',
      method: 'BANK_TRANSFER',
      kind: 'MANUAL',
      status: 'SUCCEEDED',
      amount: 11900,
      currency: 'EUR',
      creditNoteNumber: 'GS-2026-000001',
      overpayment: false,
      isTest: false,
    },
  ],
};

/** A data record is padded to all 125 columns of format version 13. */
const padRow = (fields: string) => `${fields}${';'.repeat(125 - 14)}`;

describe('DATEV export', () => {
  const range = { from: '2026-03-01', to: '2026-03-31' };
  const now = new Date('2026-03-31T10:15:30.123Z'); // CEST → 12:15:30

  it('writes the 31-field header record at the documented positions', () => {
    const { body } = buildDatevExport(data, settings(), range, labels, tz, now);
    const text = body.toString('latin1');
    const lines = text.split('\r\n');
    expect(lines[0]).toBe(
      '"EXTF";700;21;"Buchungsstapel";13;20260331121530123;;"XX";"tix";"";1001;1;20260101;4;' +
        '20260301;20260331;"Ticket sales 03/2026";"";1;0;0;"EUR";;"";;;"03";;;"";""',
    );
    const f = lines[0]!.split(';');
    expect(f).toHaveLength(31);
    expect(f[0]).toBe('"EXTF"'); // 1 Kennzeichen
    expect(f[1]).toBe('700'); // 2 Version
    expect(f[2]).toBe('21'); // 3 Datenkategorie
    expect(f[10]).toBe('1001'); // 11 Berater
    expect(f[11]).toBe('1'); // 12 Mandant
    expect(f[12]).toBe('20260101'); // 13 WJ-Beginn
    expect(f[13]).toBe('4'); // 14 Sachkontenlänge
    expect(f[14]).toBe('20260301'); // 15 Datum von
    expect(f[15]).toBe('20260331'); // 16 Datum bis
    expect(f[20]).toBe('0'); // 21 Festschreibung
    expect(f[21]).toBe('"EUR"'); // 22 WKZ
    expect(f[26]).toBe('"03"'); // 27 SKR
  });

  it('books invoices per account, credit notes reversed, payments and refunds', () => {
    const { body, rows } = buildDatevExport(data, settings(), range, labels, tz, now);
    const lines = body.toString('latin1').split('\r\n');
    // Official column captions of format version 13 (125 columns), hand-checked.
    const captions = lines[1]!.split(';');
    expect(captions).toHaveLength(125);
    expect(captions.slice(0, 14).join(';')).toBe(
      'Umsatz (ohne Soll/Haben-Kz);Soll/Haben-Kennzeichen;WKZ Umsatz;Kurs;Basisumsatz;' +
        'WKZ Basisumsatz;Konto;Gegenkonto (ohne BU-Schlüssel);BU-Schlüssel;Belegdatum;' +
        'Belegfeld 1;Belegfeld 2;Skonto;Buchungstext',
    );
    expect(captions[19]).toBe('Beleglink');
    expect(captions[113]).toBe('Festschreibung');
    expect(captions[114]).toBe('Leistungsdatum');
    expect(captions[124]).toBe('Abw. Skontokonto');
    expect(lines.slice(2, -1).map((l) => l.slice(0, l.length - 111))).toEqual([
      // tickets 19 % + fee 19 % share 8400 (no separate fee account), 7 % → 8300
      '120,19;"S";"EUR";;;;10000;8400;;0503;"RE-2026-000001";;;"Rechnung RE-2026-000001"',
      '107,00;"S";"EUR";;;;10000;8300;;0503;"RE-2026-000001";;;"Rechnung RE-2026-000001"',
      '119,00;"H";"EUR";;;;10000;8400;;0603;"GS-2026-000001";;;"Gutschrift GS-2026-000001"',
      '227,19;"S";"EUR";;;;1200;10000;;0703;"RE-2026-000001";;;"Zahlung 2026-000001"',
      '50,00;"S";"EUR";;;;1360;10000;;0803;"2026-000002";;;"Zahlung 2026-000002"',
      '119,00;"H";"EUR";;;;1200;10000;;0903;"GS-2026-000001";;;"Erstattung GS-2026-000001"',
    ]);
    expect(rows).toBe(6);
    for (const line of lines.slice(2, -1)) {
      expect(line.split(';')).toHaveLength(125);
      expect(line.endsWith(';'.repeat(111))).toBe(true);
    }
  });

  it('books reversed payments and write-offs at their own dates', () => {
    const more: AccountingData = {
      ...data,
      documents: [],
      payments: [],
      refunds: [],
      paymentReversals: [
        {
          ...data.payments[0]!,
          reversedAt: new Date('2026-03-20T08:00:00Z'),
        },
      ],
      writeOffs: [
        {
          date: new Date('2026-03-07T08:00:00Z'),
          orderNumber: '2026-000001',
          voucher: 'RE-2026-000001',
          method: 'BANK_TRANSFER',
          amount: 50,
          currency: 'EUR',
          reversal: false,
          isTest: false,
        },
        {
          date: new Date('2026-03-20T08:00:00Z'),
          orderNumber: '2026-000001',
          voucher: 'RE-2026-000001',
          method: 'BANK_TRANSFER',
          amount: 50,
          currency: 'EUR',
          reversal: true,
          isTest: false,
        },
      ],
    };
    const { body, rows } = buildDatevExport(more, settings(), range, labels, tz, now);
    const out = body
      .toString('latin1')
      .split('\r\n')
      .slice(2, -1)
      .map((l) => l.slice(0, l.length - 111));
    expect(out).toEqual([
      '227,19;"H";"EUR";;;;1200;10000;;2003;"RE-2026-000001";;;"Zahlung storniert 2026-000001"',
      '0,50;"H";"EUR";;;;10000;8730;;0703;"RE-2026-000001";;;"Restbetrag ausgebucht 2026-000001"',
      '0,50;"S";"EUR";;;;10000;8730;;2003;"RE-2026-000001";;;"Ausbuchung rueckgaengig 2026-000001"',
    ]);
    expect(rows).toBe(3);
    const csv = buildAccountingCsv('payments', more, {}, tz).body.split('\r\n');
    expect(csv[1]).toBe(
      '2026-03-07;2026-000001;RE-2026-000001;BANK_TRANSFER;0,50;EUR;;;SHORTFALL_WRITE_OFF;',
    );
    expect(csv[2]).toBe(
      '2026-03-20;2026-000001;RE-2026-000001;BANK_TRANSFER;-227,19;EUR;TIX-2026-000001-1;;PAYMENT_REVERSED;',
    );
    expect(csv[3]).toBe(
      '2026-03-20;2026-000001;RE-2026-000001;BANK_TRANSFER;-0,50;EUR;;;SHORTFALL_WRITE_OFF_REVERSED;',
    );
  });

  it('uses a separate fee account and BU key when configured, skips zero bookings', () => {
    const s = settings({
      taxAccounts: [
        { rateBasisPoints: 700, revenueAccount: '8300' },
        { rateBasisPoints: 1900, revenueAccount: '8400', feeAccount: '8401', buKey: '3' },
      ],
    });
    const free = doc({
      id: 'z',
      number: 'RE-2026-000009',
      lines: [{ rateBasisPoints: 1900, isFee: false, net: 0, tax: 0, gross: 0 }],
    });
    const { body } = buildDatevExport(
      { ...data, documents: [invoice, free], payments: [], refunds: [] },
      s,
      range,
      labels,
      tz,
      now,
    );
    const rows = body
      .toString('latin1')
      .split('\r\n')
      .slice(2, -1)
      .map((l) => l.slice(0, l.length - 111));
    expect(rows).toEqual([
      '119,00;"S";"EUR";;;;10000;8400;"3";0503;"RE-2026-000001";;;"Rechnung RE-2026-000001"',
      '107,00;"S";"EUR";;;;10000;8300;;0503;"RE-2026-000001";;;"Rechnung RE-2026-000001"',
      '1,19;"S";"EUR";;;;10000;8401;"3";0503;"RE-2026-000001";;;"Rechnung RE-2026-000001"',
    ]);
  });

  it('rejects a range across two fiscal years and a shifted fiscal year start', () => {
    expect(() =>
      buildDatevExport(data, settings(), { from: '2026-12-01', to: '2027-01-31' }, labels, tz, now),
    ).toThrow(/one fiscal year/);
    const shifted = settings({ fiscalYearStart: '07-01' });
    const ok = buildDatevExport(
      { ...data, documents: [], payments: [], refunds: [] },
      shifted,
      { from: '2026-01-01', to: '2026-06-30' },
      labels,
      tz,
      now,
    );
    expect(ok.body.toString('latin1').split(';')[12]).toBe('20250701');
    expect(() =>
      buildDatevExport(data, shifted, { from: '2026-06-01', to: '2026-07-31' }, labels, tz, now),
    ).toThrow(/one fiscal year/);
  });

  it('fails loudly for unmapped tax rates, missing master data, other currencies', () => {
    const noSeven = settings({ taxAccounts: [{ rateBasisPoints: 1900, revenueAccount: '8400' }] });
    expect(() => buildDatevExport(data, noSeven, range, labels, tz, now)).toThrow(
      /No revenue account/,
    );
    expect(() =>
      buildDatevExport(data, accountingSchema.parse({}), range, labels, tz, now),
    ).toThrow(/consultant and client/);
    const usd = { ...data, payments: [{ ...data.payments[0]!, currency: 'USD' }] };
    expect(() => buildDatevExport(usd, settings(), range, labels, tz, now)).toThrow(/EUR/);
  });

  it('detects invoices whose lines do not add up', () => {
    const broken = doc({ ...invoice, totalGross: 1 });
    expect(() =>
      buildDatevExport(
        { ...data, documents: [broken], payments: [], refunds: [] },
        settings(),
        range,
        labels,
        tz,
        now,
      ),
    ).toThrow(/add up/);
  });
});

describe('DATEV formatting', () => {
  it('formats amounts with comma and without thousands separator', () => {
    expect(formatDatevAmount(5)).toBe('0,05');
    expect(formatDatevAmount(123456789)).toBe('1234567,89');
    expect(() => formatDatevAmount(0)).toThrow();
    expect(() => formatDatevAmount(-1)).toThrow();
  });

  it('restricts Belegfeld 1 and Buchungstext', () => {
    expect(sanitizeVoucher('RE_2026.1 ä')).toBe('RE-2026-1--');
    expect(sanitizeVoucher('A'.repeat(50))).toHaveLength(36);
    expect(sanitizeBookingText(`${'x'.repeat(70)}`)).toHaveLength(60);
    expect(sanitizeBookingText('a\r\nb')).toBe('a b');
  });

  it('doubles quotes in quoted text fields', () => {
    const line = datevHeaderLine({
      consultantNumber: 1001,
      clientNumber: 1,
      fiscalYearStart: '20260101',
      accountLength: 4,
      from: '20260101',
      to: '20260131',
      description: 'A "B"',
      chart: '',
      createdAt: new Date('2026-01-31T11:00:00Z'),
      timeZone: tz,
    });
    expect(line).toContain('"A ""B"""');
    expect(line.split(';')).toHaveLength(31);
  });

  it('pads every booking line to the full column count', () => {
    expect(
      datevBookingLine({
        amountCents: 100,
        side: 'S',
        account: '1200',
        counterAccount: '10000',
        month: 3,
        day: 5,
        voucher1: 'a b',
        text: 'x "y"',
      }).split(';'),
    ).toHaveLength(125 + 0);
  });

  it('encodes Windows-1252', () => {
    expect([...encodeCp1252('€')]).toEqual([0x80]);
    expect([...encodeCp1252('äöüß')]).toEqual([0xe4, 0xf6, 0xfc, 0xdf]);
    expect([...encodeCp1252('A😀')]).toEqual([0x41, 0x3f]);
    expect([...encodeCp1252('„“')]).toEqual([0x84, 0x93]);
  });
});

describe('simple CSV', () => {
  it('neutralises formulas in text but keeps negative amounts', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell(formatCsvAmount(-1234))).toBe('-12,34');
    expect(csvCell('a;b "c"')).toBe('"a;b ""c"""');
    expect(buildCsv(['a'], [['x']])).toBe('﻿a\r\nx\r\n');
  });

  it('writes one row per document and tax rate with signed credit notes', () => {
    const { body, rows } = buildAccountingCsv('documents', data, { number: 'Nr' }, tz);
    const lines = body.slice(1).split('\r\n');
    expect(lines[0]).toContain('Nr;type;date');
    expect(rows).toBe(3);
    expect(lines[1]).toBe(
      'RE-2026-000001;INVOICE;2026-03-05;;2026-000001;Max Muster;;100,00;7;7,00;107,00;EUR;BANK_TRANSFER;PAID',
    );
    expect(lines[3]).toBe(
      'GS-2026-000001;CREDIT_NOTE;2026-03-06;RE-2026-000001;2026-000001;Max Muster;;-100,00;19;-19,00;-119,00;EUR;BANK_TRANSFER;PAID',
    );
  });

  it('lists payments and refunds', () => {
    const p = buildAccountingCsv('payments', data, {}, tz);
    expect(p.rows).toBe(2);
    expect(p.body.split('\r\n')[1]).toBe(
      '2026-03-07;2026-000001;RE-2026-000001;BANK_TRANSFER;227,19;EUR;TIX-2026-000001-1;;;',
    );
    const r = buildAccountingCsv('refunds', data, {}, tz);
    expect(r.body.split('\r\n')[1]).toBe(
      '2026-03-09;2026-000001;BANK_TRANSFER;119,00;EUR;GS-2026-000001;MANUAL;SUCCEEDED;;',
    );
  });
});

describe('TEST order postings', () => {
  const testData: AccountingData = {
    documents: [],
    payments: [
      {
        capturedAt: new Date('2026-03-07T08:00:00Z'),
        orderNumber: 'TEST-2026-0001',
        voucher: 'TEST-2026-0001',
        method: 'PAYPAL',
        amount: 5000,
        currency: 'EUR',
        paymentReference: null,
        providerReference: 'CAPT',
        isTest: true,
      },
    ],
    paymentReversals: [],
    writeOffs: [],
    refunds: [
      {
        processedAt: new Date('2026-03-09T08:00:00Z'),
        orderNumber: 'TEST-2026-0001',
        method: 'PAYPAL',
        kind: 'AUTOMATIC',
        status: 'SUCCEEDED',
        amount: 5000,
        currency: 'EUR',
        creditNoteNumber: null,
        overpayment: false,
        isTest: true,
      },
    ],
  };

  it('marks test postings in a dedicated CSV column', () => {
    expect(buildAccountingCsv('payments', testData, {}, tz).body.split('\r\n')[1]).toBe(
      '2026-03-07;TEST-2026-0001;;PAYPAL;50,00;EUR;;CAPT;;TEST',
    );
    expect(buildAccountingCsv('refunds', testData, {}, tz).body.split('\r\n')[1]).toBe(
      '2026-03-09;TEST-2026-0001;PAYPAL;50,00;EUR;;AUTOMATIC;SUCCEEDED;;TEST',
    );
  });

  it('prefixes the DATEV booking text with TEST and never uses an invoice number', () => {
    const { body } = buildDatevExport(
      testData,
      settings(),
      { from: '2026-03-01', to: '2026-03-31' },
      labels,
      tz,
      new Date('2026-03-31T10:00:00Z'),
    );
    const lines = body.toString('latin1').split('\r\n');
    const bookings = lines.filter((l) => l.includes('TEST-2026-0001'));
    expect(bookings).toHaveLength(2);
    for (const l of bookings) expect(l).toMatch(/"TEST [^"]*TEST-2026-0001/);
  });
});

describe('dates and presets', () => {
  it('converts local date ranges to instants incl. DST', () => {
    const r = instantRange('2026-01-01', '2026-12-31', tz);
    expect(r.gte.toISOString()).toBe('2025-12-31T23:00:00.000Z');
    expect(r.lt.toISOString()).toBe('2026-12-31T23:00:00.000Z');
    const summer = instantRange('2026-03-29', '2026-03-29', tz); // DST change day (23 h)
    expect(summer.gte.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(summer.lt.toISOString()).toBe('2026-03-29T22:00:00.000Z');
  });

  it('computes fiscal years', () => {
    expect(fiscalYearStartOf('2026-03-10', '01-01')).toBe('2026-01-01');
    expect(fiscalYearStartOf('2026-03-10', '07-01')).toBe('2025-07-01');
    expect(fiscalYearEnd('2025-07-01')).toBe('2026-06-30');
    expect(fiscalYearEnd('2026-01-01')).toBe('2026-12-31');
  });

  it('offers month, quarter and fiscal-year presets', () => {
    const p = rangePresets('2026-02-10', '01-01');
    expect(p.thisMonth).toEqual(['2026-02-01', '2026-02-28']);
    expect(p.lastMonth).toEqual(['2026-01-01', '2026-01-31']);
    expect(p.thisQuarter).toEqual(['2026-01-01', '2026-03-31']);
    expect(p.lastQuarter).toEqual(['2025-10-01', '2025-12-31']);
    expect(p.fiscalYear).toEqual(['2026-01-01', '2026-12-31']);
    expect(p.lastFiscalYear).toEqual(['2025-01-01', '2025-12-31']);
  });
});

describe('accounting settings', () => {
  it('defaults to SKR03 and validates', () => {
    const s = accountingSchema.parse({});
    expect(s.chart).toBe('SKR03');
    expect(s.taxAccounts.map((t) => t.revenueAccount)).toEqual(['8100', '8300', '8400']);
    expect(s.debtorAccount).toBe('10000');
  });

  it('presets per chart and account length', () => {
    const p4 = accountingPreset('SKR04', 4);
    expect(p4.taxAccounts.map((t) => t.revenueAccount)).toEqual(['4100', '4300', '4400']);
    expect([p4.bankAccount, p4.paypalAccount, p4.cashAccount]).toEqual(['1800', '1460', '1600']);
    const p5 = accountingPreset('SKR03', 5);
    expect(p5.bankAccount).toBe('12000');
    expect(p5.debtorAccount).toBe('100000');
    expect(() => accountingSchema.parse({ chart: 'SKR04', accountLength: 5, ...p5 })).not.toThrow();
  });

  it('rejects wrong account lengths and duplicate rates', () => {
    expect(() => accountingSchema.parse({ bankAccount: '120' })).toThrow();
    expect(() => accountingSchema.parse({ debtorAccount: '1000' })).toThrow();
    expect(() =>
      accountingSchema.parse({
        taxAccounts: [
          { rateBasisPoints: 700, revenueAccount: '8300' },
          { rateBasisPoints: 700, revenueAccount: '8301' },
        ],
      }),
    ).toThrow();
    expect(() => accountingSchema.parse({ fiscalYearStart: '02-30' })).toThrow();
  });
});
