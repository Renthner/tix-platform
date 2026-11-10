/**
 * Accounting export against a real PostgreSQL (throw-away database, no Redis, no object storage):
 * the range contains invoices, credit notes, payments and refunds; credit notes are negative;
 * boundaries follow the shop time zone; cancelled / pending / complimentary money is left out.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  bankAccounts,
  bankTransactionAllocations,
  bankTransactions,
  createDb,
  invoiceLines,
  invoiceSupersessions,
  invoices,
  loadRootEnv,
  orderHistory,
  orders,
  payments,
  refunds,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { accountingSchema } from '@tix/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAccountingCsv, buildDatevExport, loadAccountingData, type DatevLabels } from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const tz = 'Europe/Berlin';
const labels: DatevLabels = {
  invoice: 'Rechnung',
  creditNote: 'Gutschrift',
  payment: 'Zahlung',
  paymentReversal: 'Zahlung storniert',
  writeOff: 'Restbetrag ausgebucht',
  writeOffReversal: 'Ausbuchung rueckgaengig',
  refund: 'Erstattung',
  description: 'Export',
  exportedBy: 'tix',
};

describe.skipIf(!adminUrl)('accounting export (integration)', () => {
  const dbName = `tix_accounting_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  const settings = accountingSchema.parse({ consultantNumber: 1001, clientNumber: 1 });
  const party = { name: 'Erika Beispiel', company: '=Evil GmbH' };

  async function order(number: string, method: 'BANK_TRANSFER' | 'PAYPAL' | 'COMPLIMENTARY') {
    const [row] = await handle.db
      .insert(orders)
      .values({
        orderNumber: number,
        status: 'PAID',
        channel: 'BOX_OFFICE',
        paymentMethod: method,
        firstName: 'Erika',
        lastName: 'Beispiel',
        locale: 'de',
        currency: 'EUR',
        subtotalGross: 11900,
        totalGross: 11900,
        totalNet: 10000,
        totalTax: 1900,
        amountPaid: 11900,
        paidAt: new Date('2026-01-15T10:00:00Z'),
      })
      .returning({ id: orders.id });
    return row!.id;
  }

  async function document(
    orderId: string,
    number: string,
    type: 'INVOICE' | 'CREDIT_NOTE',
    issuedAt: string,
    gross: number,
    correctsInvoiceId?: string,
  ) {
    const net = Math.round(gross / 1.19);
    const tax = gross - net;
    const [row] = await handle.db
      .insert(invoices)
      .values({
        orderId,
        type,
        invoiceNumber: number,
        correctsInvoiceId: correctsInvoiceId ?? null,
        issuedAt: new Date(issuedAt),
        seller: { name: 'Club' },
        buyer: party,
        currency: 'EUR',
        totalNet: net,
        totalTax: tax,
        totalGross: gross,
        taxBreakdown: [{ rateBasisPoints: 1900, net, tax, gross }],
      })
      .returning({ id: invoices.id });
    await handle.db.insert(invoiceLines).values({
      invoiceId: row!.id,
      position: 1,
      description: 'Ticket',
      quantity: gross < 0 ? -1 : 1,
      unitPriceGross: Math.abs(gross),
      taxRateBasisPoints: 1900,
      totalNet: net,
      totalTax: tax,
      totalGross: gross,
    });
    return row!.id;
  }

  const pay = (
    orderId: string,
    over: Partial<typeof payments.$inferInsert> & { capturedAt: Date },
  ) =>
    handle.db.insert(payments).values({
      orderId,
      method: 'BANK_TRANSFER',
      status: 'CAPTURED',
      amount: 11900,
      currency: 'EUR',
      ...over,
    });

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    await runMigrations({
      connectionString: url.toString(),
      migrationsFolder: resolve(import.meta.dirname, '../../db/migrations'),
      log: () => {},
    });
    handle = createDb({ connectionString: url.toString(), poolMax: 5 });

    const a = await order('2026-000001', 'BANK_TRANSFER');
    // 00:30 on 1 Jan in Berlin (23:30 UTC on 31 Dec): belongs to 2026, not to 2025.
    const inv = await document(a, 'RE-2026-000001', 'INVOICE', '2025-12-31T23:30:00Z', 11900);
    await document(a, 'GS-2026-000001', 'CREDIT_NOTE', '2026-01-20T09:00:00Z', -11900, inv);
    await pay(a, { capturedAt: new Date('2026-01-15T10:00:00Z') });
    await pay(a, {
      capturedAt: new Date('2026-01-16T10:00:00Z'),
      status: 'REFUNDED',
      amount: 500,
    });
    // Not exported: reversed allocation, before / after the range, complimentary.
    await pay(a, { capturedAt: new Date('2026-01-17T10:00:00Z'), status: 'CANCELLED' });
    await pay(a, { capturedAt: new Date('2026-02-01T00:00:00Z') }); // 01:00 Berlin on 1 Feb
    await pay(a, { capturedAt: new Date('2025-12-31T22:59:59Z') }); // 23:59:59 Berlin on 31 Dec
    await handle.db.insert(refunds).values([
      {
        orderId: a,
        method: 'BANK_TRANSFER',
        kind: 'MANUAL',
        status: 'SUCCEEDED',
        amount: 11900,
        currency: 'EUR',
        processedAt: new Date('2026-01-21T10:00:00Z'),
      },
      {
        orderId: a,
        method: 'BANK_TRANSFER',
        kind: 'MANUAL',
        status: 'PENDING',
        amount: 100,
        currency: 'EUR',
      },
    ]);
    const c = await order('2026-000002', 'COMPLIMENTARY');
    await pay(c, {
      method: 'COMPLIMENTARY',
      amount: 0,
      capturedAt: new Date('2026-01-18T10:00:00Z'),
    });
    // A superseded invoice and its replacement: payments reference the replacement.
    const b = await order('2026-000003', 'PAYPAL');
    const old = await document(b, 'RE-2026-000010', 'INVOICE', '2026-01-10T09:00:00Z', 11900);
    const cn = await document(
      b,
      'GS-2026-000010',
      'CREDIT_NOTE',
      '2026-01-11T09:00:00Z',
      -11900,
      old,
    );
    await handle.db.insert(invoiceSupersessions).values({ invoiceId: old, creditNoteId: cn });
    await document(b, 'RE-2026-000011', 'INVOICE', '2026-01-12T09:00:00Z', 11900);
    await pay(b, { method: 'PAYPAL', capturedAt: new Date('2026-01-13T09:00:00Z') });

    // A bank payment (with a written-off shortfall) whose allocation was reversed on 3 Feb: it
    // stays in January, the reversing bookings fall into February.
    const d = await order('2026-000004', 'BANK_TRANSFER');
    const [account] = await handle.db
      .insert(bankAccounts)
      .values({
        name: 'Main',
        accountHolder: 'Club',
        iban: 'DE02120300000000202051',
        currency: 'EUR',
      })
      .returning({ id: bankAccounts.id });
    const [tx] = await handle.db
      .insert(bankTransactions)
      .values({
        bankAccountId: account!.id,
        fingerprint: 'fp-accounting-1',
        bookingDate: '2026-01-14',
        amount: 11850,
        currency: 'EUR',
        endToEndId: 'E2E-1',
      })
      .returning({ id: bankTransactions.id });
    const [reversedPayment] = await handle.db
      .insert(payments)
      .values({
        orderId: d,
        method: 'BANK_TRANSFER',
        status: 'CANCELLED',
        amount: 11850,
        currency: 'EUR',
        bankTransactionId: tx!.id,
        capturedAt: new Date('2026-01-14T10:00:00Z'),
      })
      .returning({ id: payments.id });
    await handle.db.insert(bankTransactionAllocations).values({
      bankTransactionId: tx!.id,
      orderId: d,
      paymentId: reversedPayment!.id,
      amount: 11850,
      method: 'MANUAL',
      reversedAt: new Date('2026-02-03T10:00:00Z'),
      reversalReason: 'wrong order',
    });
    await handle.db.insert(orderHistory).values({
      orderId: d,
      type: 'shortfall_written_off',
      actorType: 'SYSTEM',
      data: {
        paymentId: reversedPayment!.id,
        method: 'BANK_TRANSFER',
        amount: 11850,
        shortfall: 50,
      },
      createdAt: new Date('2026-01-14T10:00:00Z'),
    });
  });

  afterAll(async () => {
    await handle?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  const january = { from: '2026-01-01', to: '2026-01-31' };

  it('selects documents, payments and refunds by shop-time-zone dates', async () => {
    const data = await loadAccountingData(handle.db, january, tz);
    expect(data.documents.map((d) => d.number)).toEqual([
      'RE-2026-000001',
      'RE-2026-000010',
      'GS-2026-000010',
      'RE-2026-000011',
      'GS-2026-000001',
    ]);
    expect(data.documents.find((d) => d.number === 'GS-2026-000001')).toMatchObject({
      type: 'CREDIT_NOTE',
      correctsNumber: 'RE-2026-000001',
      totalGross: -11900,
    });
    expect(data.payments.map((p) => [p.orderNumber, p.amount, p.voucher])).toEqual([
      ['2026-000003', 11900, 'RE-2026-000011'],
      ['2026-000004', 11850, '2026-000004'], // reversed later, but captured in January

      ['2026-000001', 11900, 'RE-2026-000001'],
      ['2026-000001', 500, 'RE-2026-000001'],
    ]);
    expect(data.refunds).toHaveLength(1);
    expect(data.refunds[0]).toMatchObject({ amount: 11900, status: 'SUCCEEDED' });

    const december = await loadAccountingData(
      handle.db,
      { from: '2025-12-01', to: '2025-12-31' },
      tz,
    );
    expect(december.documents).toEqual([]);
    expect(december.payments).toHaveLength(1); // 23:59:59 Berlin on 31 Dec
    const february = await loadAccountingData(
      handle.db,
      { from: '2026-02-01', to: '2026-02-28' },
      tz,
    );
    expect(february.payments).toHaveLength(1);
    // January: write-off booked at the payment date, no reversal yet.
    expect(data.paymentReversals).toEqual([]);
    expect(data.writeOffs).toMatchObject([
      { orderNumber: '2026-000004', amount: 50, reversal: false },
    ]);
    // February: the reversal of the payment and of the write-off.
    expect(february.paymentReversals).toMatchObject([
      { orderNumber: '2026-000004', amount: 11850 },
    ]);
    expect(february.paymentReversals[0]!.reversedAt.toISOString()).toBe('2026-02-03T10:00:00.000Z');
    expect(february.writeOffs).toMatchObject([
      { orderNumber: '2026-000004', amount: 50, reversal: true },
    ]);
  });

  it('exports CSV with negative credit notes and neutralised text', async () => {
    const data = await loadAccountingData(handle.db, january, tz);
    const docs = buildAccountingCsv('documents', data, {}, tz);
    expect(docs.rows).toBe(5);
    const lines = docs.body.slice(1).split('\r\n');
    expect(lines.find((l) => l.startsWith('GS-2026-000001'))).toBe(
      "GS-2026-000001;CREDIT_NOTE;2026-01-20;RE-2026-000001;2026-000001;Erika Beispiel;'=Evil GmbH;-100,00;19;-19,00;-119,00;EUR;BANK_TRANSFER;PAID",
    );
    expect(lines.find((l) => l.startsWith('RE-2026-000001'))).toContain(';2026-01-01;'); // Berlin date
    expect(buildAccountingCsv('payments', data, {}, tz).rows).toBe(5); // 4 payments + 1 write-off
    expect(buildAccountingCsv('refunds', data, {}, tz).rows).toBe(1);
  });

  it('builds a balanced DATEV file for the range', async () => {
    const data = await loadAccountingData(handle.db, january, tz);
    const { body, rows } = buildDatevExport(data, settings, january, labels, tz);
    const lines = body.toString('latin1').split('\r\n').slice(2, -1);
    expect(rows).toBe(lines.length);
    // 5 documents (one account each), 4 payments, 1 write-off, 1 refund.
    expect(lines).toHaveLength(11);
    expect(lines[0]).toContain(';10000;8400;;0101;"RE-2026-000001"'); // 1 Jan, shop time zone
    const credit = lines.find((l) => l.includes('"GS-2026-000001";;;"Gutschrift'))!;
    expect(credit.startsWith('119,00;"H";')).toBe(true);
    expect(lines.filter((l) => l.includes(';1360;10000;'))).toHaveLength(1);
    expect(lines.find((l) => l.includes('"Erstattung'))).toContain('"H";"EUR";;;;1200;10000;');
  });
});
