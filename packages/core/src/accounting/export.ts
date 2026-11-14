import {
  bankTransactionAllocations,
  bankTransactions,
  orderHistory,
  invoiceLines,
  invoiceSupersessions,
  invoices,
  orders,
  payments,
  refunds,
  type Executor,
} from '@tix/db';
import type { AccountingSettings, PaymentMethod } from '@tix/shared';
import { and, asc, eq, gte, inArray, isNotNull, lt, gt, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DomainError } from '../context';
import { buildCsv, formatCsvAmount, formatCsvPercent, type CsvCell } from './csv';
import {
  compactDate,
  fiscalYearEnd,
  fiscalYearStartOf,
  formatLocalDate,
  instantRange,
  localDateOf,
  parseLocalDate,
} from './dates';
import { buildDatevFile, type DatevBooking } from './datev';

/**
 * Accounting export for the tax advisor / treasurer: a simple CSV (documents, payments, refunds)
 * and a DATEV Buchungsstapel. Dates and range boundaries are in the shop time zone.
 *
 * Postings (collective debtor `D`, revenue account `R`, money account `M`):
 *   invoice      D soll  / R haben   (credit note: reversed)
 *   payment      M soll  / D haben   (captured payments, by capture date)
 *   refund       M haben / D soll    (succeeded refunds, by processing date)
 *   payment reversal  M haben / D soll  (reversed bank allocation, dated at the reversal; the
 *                     original payment stays in the period of its capture)
 *   write-off    D haben / W soll    (shortfall written off when settling an order, by payment date;
 *                     a reversed allocation books it back at the reversal date)
 */

export const ACCOUNTING_EXPORT_KINDS = ['documents', 'payments', 'refunds', 'datev'] as const;
export type AccountingExportKind = (typeof ACCOUNTING_EXPORT_KINDS)[number];

export interface AccountingRange {
  /** Inclusive local dates `YYYY-MM-DD` in the shop time zone. */
  from: string;
  to: string;
}

export interface DocumentLine {
  rateBasisPoints: number;
  isFee: boolean;
  net: number;
  tax: number;
  gross: number;
}

export interface AccountingDocument {
  id: string;
  number: string;
  type: 'INVOICE' | 'CREDIT_NOTE';
  issuedAt: Date;
  correctsNumber: string | null;
  orderNumber: string;
  orderStatus: string;
  paymentMethod: PaymentMethod;
  buyerName: string;
  buyerCompany: string;
  currency: string;
  totalNet: number;
  totalTax: number;
  totalGross: number;
  breakdown: { rateBasisPoints: number; net: number; tax: number; gross: number }[];
  lines: DocumentLine[];
}

export interface AccountingPayment {
  capturedAt: Date;
  orderNumber: string;
  /** Number of the order's current invoice (for open-item matching), else the order number. */
  voucher: string;
  method: PaymentMethod;
  amount: number;
  currency: string;
  paymentReference: string | null;
  providerReference: string | null;
  /** Payment on a super-admin TEST order: real money, but never revenue (no invoice). */
  isTest: boolean;
}

/** A captured payment that was cancelled later (bank allocation reversed). */
export interface AccountingPaymentReversal extends AccountingPayment {
  /** Date of the reversal (the booking date of the reversing entry). */
  reversedAt: Date;
}

/** Shortfall written off when an order was settled with a slightly too small payment. */
export interface AccountingWriteOff {
  /** Booking date: the payment date, or the reversal date when `reversal` is true. */
  date: Date;
  orderNumber: string;
  voucher: string;
  method: PaymentMethod | null;
  amount: number;
  currency: string;
  /** Books the write-off back (the allocation it belonged to was reversed). */
  reversal: boolean;
  /** Booking on a super-admin TEST order. */
  isTest: boolean;
}

export interface AccountingRefund {
  processedAt: Date;
  orderNumber: string;
  method: PaymentMethod;
  kind: string;
  status: string;
  amount: number;
  currency: string;
  creditNoteNumber: string | null;
  /** Pays back an overpayment (no credit note). */
  overpayment: boolean;
  /** Refund of a super-admin TEST order (never has a credit note). */
  isTest: boolean;
}

export interface AccountingData {
  documents: AccountingDocument[];
  payments: AccountingPayment[];
  paymentReversals: AccountingPaymentReversal[];
  writeOffs: AccountingWriteOff[];
  refunds: AccountingRefund[];
}

const PAID_STATUSES = ['CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;

export function validateRange(range: AccountingRange): void {
  const from = parseLocalDate(range.from);
  const to = parseLocalDate(range.to);
  if (!from || !to || range.from > range.to) {
    throw new DomainError('ACCOUNTING_RANGE_INVALID', 'Invalid date range', 400);
  }
}

/** Loads everything booked in the range (by issue / capture / processing date). */
export async function loadAccountingData(
  db: Executor,
  range: AccountingRange,
  timeZone: string,
  kinds: ('documents' | 'payments' | 'refunds')[] = ['documents', 'payments', 'refunds'],
): Promise<AccountingData> {
  validateRange(range);
  const window = instantRange(range.from, range.to, timeZone);
  const data: AccountingData = {
    documents: [],
    payments: [],
    paymentReversals: [],
    writeOffs: [],
    refunds: [],
  };

  if (kinds.includes('documents')) {
    const corrected = alias(invoices, 'corrected');
    const docs = await db
      .select({
        invoice: invoices,
        correctsNumber: corrected.invoiceNumber,
        orderNumber: orders.orderNumber,
        orderStatus: orders.status,
        paymentMethod: orders.paymentMethod,
      })
      .from(invoices)
      .innerJoin(orders, eq(orders.id, invoices.orderId))
      .leftJoin(corrected, eq(corrected.id, invoices.correctsInvoiceId))
      .where(
        and(
          gte(invoices.issuedAt, window.gte),
          lt(invoices.issuedAt, window.lt),
          eq(orders.isTest, false),
        ),
      )
      .orderBy(asc(invoices.issuedAt), asc(invoices.invoiceNumber));
    const lines = docs.length
      ? await db
          .select({
            invoiceId: invoiceLines.invoiceId,
            rate: invoiceLines.taxRateBasisPoints,
            orderFeeId: invoiceLines.orderFeeId,
            net: invoiceLines.totalNet,
            tax: invoiceLines.totalTax,
            gross: invoiceLines.totalGross,
          })
          .from(invoiceLines)
          .where(
            inArray(
              invoiceLines.invoiceId,
              docs.map((d) => d.invoice.id),
            ),
          )
      : [];
    const byInvoice = new Map<string, DocumentLine[]>();
    for (const l of lines) {
      const list = byInvoice.get(l.invoiceId) ?? [];
      list.push({
        rateBasisPoints: l.rate,
        isFee: l.orderFeeId !== null,
        net: l.net,
        tax: l.tax,
        gross: l.gross,
      });
      byInvoice.set(l.invoiceId, list);
    }
    data.documents = docs.map(
      ({ invoice, correctsNumber, orderNumber, orderStatus, paymentMethod }) => ({
        id: invoice.id,
        number: invoice.invoiceNumber,
        type: invoice.type,
        issuedAt: invoice.issuedAt,
        correctsNumber,
        orderNumber,
        orderStatus,
        paymentMethod,
        buyerName: invoice.buyer.name,
        buyerCompany: invoice.buyer.company ?? '',
        currency: invoice.currency,
        totalNet: invoice.totalNet,
        totalTax: invoice.totalTax,
        totalGross: invoice.totalGross,
        breakdown: invoice.taxBreakdown.map((b) => ({
          rateBasisPoints: b.rateBasisPoints,
          net: b.net,
          tax: b.tax,
          gross: b.gross,
        })),
        lines: byInvoice.get(invoice.id) ?? [],
      }),
    );
  }

  if (kinds.includes('payments')) {
    const rows = await db
      .select({
        capturedAt: payments.capturedAt,
        orderId: payments.orderId,
        orderNumber: orders.orderNumber,
        method: payments.method,
        amount: payments.amount,
        currency: payments.currency,
        // An additional payment (tariff change) carries its own reference.
        paymentReference: sql<
          string | null
        >`coalesce((select a.payment_reference from order_adjustments a where a.id = ${payments.adjustmentId}), ${orders.paymentReference})`,
        providerCaptureId: payments.providerCaptureId,
        endToEndId: bankTransactions.endToEndId,
        isTest: orders.isTest,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .leftJoin(bankTransactions, eq(bankTransactions.id, payments.bankTransactionId))
      .where(
        and(
          isNotNull(payments.capturedAt),
          gte(payments.capturedAt, window.gte),
          lt(payments.capturedAt, window.lt),
          // Reversed payments (CANCELLED) stay in the period of their capture; a reversing booking
          // dated at the reversal corrects them (see `paymentReversals`).
          or(
            inArray(payments.status, [...PAID_STATUSES]),
            inArray(
              payments.id,
              db
                .select({ id: bankTransactionAllocations.paymentId })
                .from(bankTransactionAllocations)
                .where(
                  and(
                    isNotNull(bankTransactionAllocations.paymentId),
                    isNotNull(bankTransactionAllocations.reversedAt),
                  ),
                ),
            ),
          ),
          ne(payments.method, 'COMPLIMENTARY'),
          gt(payments.amount, 0),
        ),
      )
      .orderBy(asc(payments.capturedAt), asc(orders.orderNumber));
    const current = await currentInvoiceNumbers(db, [...new Set(rows.map((r) => r.orderId))]);
    data.payments = rows.map((r) => ({
      capturedAt: r.capturedAt!,
      orderNumber: r.orderNumber,
      voucher: current.get(r.orderId) ?? r.orderNumber,
      method: r.method,
      amount: r.amount,
      currency: r.currency,
      paymentReference: r.paymentReference,
      providerReference: r.providerCaptureId ?? r.endToEndId ?? null,
      isTest: r.isTest,
    }));
  }

  if (kinds.includes('payments')) {
    const reversed = await db
      .select({
        reversedAt: bankTransactionAllocations.reversedAt,
        capturedAt: payments.capturedAt,
        orderId: payments.orderId,
        orderNumber: orders.orderNumber,
        method: payments.method,
        amount: payments.amount,
        currency: payments.currency,
        paymentReference: orders.paymentReference,
        endToEndId: bankTransactions.endToEndId,
        isTest: orders.isTest,
      })
      .from(bankTransactionAllocations)
      .innerJoin(payments, eq(payments.id, bankTransactionAllocations.paymentId))
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .leftJoin(bankTransactions, eq(bankTransactions.id, payments.bankTransactionId))
      .where(
        and(
          isNotNull(bankTransactionAllocations.reversedAt),
          gte(bankTransactionAllocations.reversedAt, window.gte),
          lt(bankTransactionAllocations.reversedAt, window.lt),
          isNotNull(payments.capturedAt),
          ne(payments.method, 'COMPLIMENTARY'),
          gt(payments.amount, 0),
        ),
      )
      .orderBy(asc(bankTransactionAllocations.reversedAt), asc(orders.orderNumber));

    // Shortfall write-offs: history entries written when the order was settled (payment date),
    // plus those whose payment's allocation was reversed inside the range.
    const paymentIdOf = sql<string | null>`(${orderHistory.data}->>'paymentId')`;
    const writeOffRows = await db
      .select({
        createdAt: orderHistory.createdAt,
        data: orderHistory.data,
        orderId: orderHistory.orderId,
        orderNumber: orders.orderNumber,
        currency: orders.currency,
        isTest: orders.isTest,
        reversedAt: bankTransactionAllocations.reversedAt,
      })
      .from(orderHistory)
      .innerJoin(orders, eq(orders.id, orderHistory.orderId))
      .leftJoin(
        bankTransactionAllocations,
        and(
          sql`${bankTransactionAllocations.paymentId}::text = ${paymentIdOf}`,
          isNotNull(bankTransactionAllocations.reversedAt),
        ),
      )
      .where(
        and(
          eq(orderHistory.type, 'shortfall_written_off'),
          or(
            and(gte(orderHistory.createdAt, window.gte), lt(orderHistory.createdAt, window.lt)),
            and(
              gte(bankTransactionAllocations.reversedAt, window.gte),
              lt(bankTransactionAllocations.reversedAt, window.lt),
            ),
          ),
        ),
      )
      .orderBy(asc(orderHistory.createdAt));

    const current = await currentInvoiceNumbers(db, [
      ...new Set([...reversed.map((r) => r.orderId), ...writeOffRows.map((r) => r.orderId)]),
    ]);
    data.paymentReversals = reversed.map((r) => ({
      reversedAt: r.reversedAt!,
      capturedAt: r.capturedAt!,
      orderNumber: r.orderNumber,
      voucher: current.get(r.orderId) ?? r.orderNumber,
      method: r.method,
      amount: r.amount,
      currency: r.currency,
      paymentReference: r.paymentReference,
      providerReference: r.endToEndId ?? null,
      isTest: r.isTest,
    }));
    for (const r of writeOffRows) {
      const d = (r.data ?? {}) as { shortfall?: unknown; method?: unknown };
      const amount = typeof d.shortfall === 'number' ? d.shortfall : 0;
      if (amount <= 0) continue;
      const base = {
        orderNumber: r.orderNumber,
        voucher: current.get(r.orderId) ?? r.orderNumber,
        method: (typeof d.method === 'string' ? d.method : null) as PaymentMethod | null,
        amount,
        currency: r.currency,
        isTest: r.isTest,
      };
      if (r.createdAt >= window.gte && r.createdAt < window.lt) {
        data.writeOffs.push({ ...base, date: r.createdAt, reversal: false });
      }
      if (r.reversedAt && r.reversedAt >= window.gte && r.reversedAt < window.lt) {
        data.writeOffs.push({ ...base, date: r.reversedAt, reversal: true });
      }
    }
    data.writeOffs.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  if (kinds.includes('refunds')) {
    const creditNote = alias(invoices, 'credit_note');
    const rows = await db
      .select({
        processedAt: refunds.processedAt,
        orderNumber: orders.orderNumber,
        method: refunds.method,
        kind: refunds.kind,
        status: refunds.status,
        amount: refunds.amount,
        currency: refunds.currency,
        creditNoteNumber: creditNote.invoiceNumber,
        overpayment: refunds.overpayment,
        isTest: orders.isTest,
      })
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .leftJoin(creditNote, eq(creditNote.id, refunds.creditNoteId))
      .where(
        and(
          eq(refunds.status, 'SUCCEEDED'),
          isNotNull(refunds.processedAt),
          gte(refunds.processedAt, window.gte),
          lt(refunds.processedAt, window.lt),
        ),
      )
      .orderBy(asc(refunds.processedAt), asc(orders.orderNumber));
    data.refunds = rows.map((r) => ({ ...r, processedAt: r.processedAt! }));
  }
  return data;
}

/** Number of the latest invoice per order that no credit note cancelled completely. */
async function currentInvoiceNumbers(
  db: Executor,
  orderIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (orderIds.length === 0) return out;
  const rows = await db
    .select({
      orderId: invoices.orderId,
      number: invoices.invoiceNumber,
      superseded: invoiceSupersessions.invoiceId,
    })
    .from(invoices)
    .leftJoin(invoiceSupersessions, eq(invoiceSupersessions.invoiceId, invoices.id))
    .where(and(inArray(invoices.orderId, orderIds), eq(invoices.type, 'INVOICE')))
    .orderBy(asc(invoices.issuedAt));
  for (const r of rows) {
    // Later invoices override earlier ones; a superseded one only counts when nothing else exists.
    if (!r.superseded || !out.has(r.orderId)) out.set(r.orderId, r.number);
  }
  return out;
}

// ─── Simple CSV ─────────────────────────────────────────────────────────────

export const CSV_COLUMNS = {
  documents: [
    'number',
    'type',
    'date',
    'corrects',
    'order',
    'buyerName',
    'buyerCompany',
    'net',
    'taxRate',
    'tax',
    'gross',
    'currency',
    'paymentMethod',
    'orderStatus',
  ],
  payments: [
    'date',
    'order',
    'invoice',
    'method',
    'amount',
    'currency',
    'reference',
    'providerId',
    'note',
    'test',
  ],
  refunds: [
    'date',
    'order',
    'method',
    'amount',
    'currency',
    'creditNote',
    'kind',
    'status',
    'overpayment',
    'test',
  ],
} as const;
export type CsvKind = keyof typeof CSV_COLUMNS;

const isoDate = (d: Date, tz: string) => formatLocalDate(localDateOf(d, tz));

/** CSV text (UTF-8 BOM, `;`, decimal comma). `headers` maps column keys to labels. */
export function buildAccountingCsv(
  kind: CsvKind,
  data: AccountingData,
  headers: Record<string, string>,
  timeZone: string,
): { body: string; rows: number } {
  const rows: CsvCell[][] = [];
  if (kind === 'documents') {
    for (const d of data.documents) {
      // One row per document and tax rate (credit notes carry negative amounts as stored).
      const parts = d.breakdown.length
        ? d.breakdown
        : [{ rateBasisPoints: null, net: d.totalNet, tax: d.totalTax, gross: d.totalGross }];
      for (const part of parts) {
        rows.push([
          d.number,
          d.type,
          isoDate(d.issuedAt, timeZone),
          d.correctsNumber,
          d.orderNumber,
          d.buyerName,
          d.buyerCompany,
          formatCsvAmount(part.net),
          part.rateBasisPoints === null ? '' : formatCsvPercent(part.rateBasisPoints),
          formatCsvAmount(part.tax),
          formatCsvAmount(part.gross),
          d.currency,
          d.paymentMethod,
          d.orderStatus,
        ]);
      }
    }
  } else if (kind === 'payments') {
    // Chronological. Reversals are negative rows at the reversal date; write-offs carry a note
    // (they are not money received - exclude them when summing receipts).
    const entries: { at: Date; row: CsvCell[] }[] = [];
    const row = (
      at: Date,
      p: AccountingPayment,
      amount: number,
      note: string,
      method: string | null = p.method,
    ) => ({
      at,
      row: [
        isoDate(at, timeZone),
        p.orderNumber,
        p.voucher === p.orderNumber ? '' : p.voucher,
        method,
        formatCsvAmount(amount),
        p.currency,
        p.paymentReference,
        p.providerReference,
        note,
        p.isTest ? 'TEST' : '',
      ] as CsvCell[],
    });
    for (const p of data.payments) entries.push(row(p.capturedAt, p, p.amount, ''));
    for (const p of data.paymentReversals)
      entries.push(row(p.reversedAt, p, -p.amount, 'PAYMENT_REVERSED'));
    for (const w of data.writeOffs) {
      const asPayment: AccountingPayment = {
        capturedAt: w.date,
        orderNumber: w.orderNumber,
        voucher: w.voucher,
        method: w.method ?? 'BANK_TRANSFER',
        amount: w.amount,
        currency: w.currency,
        paymentReference: null,
        providerReference: null,
        isTest: w.isTest,
      };
      entries.push(
        row(
          w.date,
          asPayment,
          w.reversal ? -w.amount : w.amount,
          w.reversal ? 'SHORTFALL_WRITE_OFF_REVERSED' : 'SHORTFALL_WRITE_OFF',
          w.method,
        ),
      );
    }
    entries.sort((a, b) => a.at.getTime() - b.at.getTime());
    for (const e of entries) rows.push(e.row);
  } else {
    for (const r of data.refunds) {
      rows.push([
        isoDate(r.processedAt, timeZone),
        r.orderNumber,
        r.method,
        formatCsvAmount(r.amount),
        r.currency,
        r.creditNoteNumber,
        r.kind,
        r.status,
        r.overpayment ? 'yes' : '',
        r.isTest ? 'TEST' : '',
      ]);
    }
  }
  return {
    body: buildCsv(
      CSV_COLUMNS[kind].map((c) => headers[c] ?? c),
      rows,
    ),
    rows: rows.length,
  };
}

// ─── DATEV ──────────────────────────────────────────────────────────────────

export interface DatevLabels {
  invoice: string;
  creditNote: string;
  payment: string;
  paymentReversal: string;
  writeOff: string;
  writeOffReversal: string;
  refund: string;
  description: string;
  exportedBy: string;
}

export function moneyAccountFor(
  settings: AccountingSettings,
  method: PaymentMethod,
): string | null {
  switch (method) {
    case 'BANK_TRANSFER':
      return settings.bankAccount;
    case 'PAYPAL':
      return settings.paypalAccount;
    case 'CASH':
      return settings.cashAccount;
    case 'CARD':
      return settings.cardAccount;
    default:
      return null;
  }
}

/** Booking text of a TEST order posting: the marker leads, so the 60 character cut never drops it. */
const testText = (isTest: boolean, text: string) => (isTest ? `TEST ${text}` : text);

export interface DatevBuild {
  body: Buffer;
  rows: number;
  fiscalYearStart: string;
}

/** Validates the range against one fiscal year and the settings, then builds the DATEV file. */
export function buildDatevExport(
  data: AccountingData,
  settings: AccountingSettings,
  range: AccountingRange,
  labels: DatevLabels,
  timeZone: string,
  now: Date = new Date(),
): DatevBuild {
  validateRange(range);
  if (!settings.consultantNumber || !settings.clientNumber) {
    throw new DomainError(
      'ACCOUNTING_DATEV_MASTER_DATA_MISSING',
      'DATEV consultant and client number are required',
      409,
    );
  }
  const fyStart = fiscalYearStartOf(range.from, settings.fiscalYearStart);
  if (range.to > fiscalYearEnd(fyStart)) {
    throw new DomainError(
      'ACCOUNTING_FISCAL_YEAR_SPAN',
      'A DATEV file may only contain one fiscal year',
      400,
      { fiscalYearStart: fyStart, fiscalYearEnd: fiscalYearEnd(fyStart) },
    );
  }
  for (const c of [
    ...data.documents.map((d) => d.currency),
    ...data.payments.map((p) => p.currency),
    ...data.paymentReversals.map((p) => p.currency),
    ...data.writeOffs.map((w) => w.currency),
    ...data.refunds.map((r) => r.currency),
  ]) {
    if (c !== 'EUR') {
      throw new DomainError('ACCOUNTING_CURRENCY', 'Only EUR can be exported to DATEV', 409, {
        currency: c,
      });
    }
  }

  const rateMap = new Map(settings.taxAccounts.map((t) => [t.rateBasisPoints, t]));
  const missingRates = new Set<number>();
  const bookings: DatevBooking[] = [];
  const day = (d: Date) => {
    const l = localDateOf(d, timeZone);
    return { month: l.m, day: l.d };
  };

  for (const doc of data.documents) {
    // Group by resulting revenue account + tax key so tickets and fees of one rate share a row
    // unless the admin mapped fees to their own account.
    const groups = new Map<string, { account: string; buKey?: string; gross: number }>();
    let grossSum = 0;
    for (const line of doc.lines) {
      grossSum += line.gross;
      const mapping = rateMap.get(line.rateBasisPoints);
      if (!mapping) {
        missingRates.add(line.rateBasisPoints);
        continue;
      }
      const account = (line.isFee && mapping.feeAccount) || mapping.revenueAccount;
      const key = `${account}|${mapping.buKey ?? ''}`;
      const group = groups.get(key) ?? {
        account,
        gross: 0,
        ...(mapping.buKey ? { buKey: mapping.buKey } : {}),
      };
      group.gross += line.gross;
      groups.set(key, group);
    }
    if (grossSum !== doc.totalGross) {
      throw new DomainError(
        'ACCOUNTING_DOCUMENT_MISMATCH',
        'Invoice lines do not add up to the invoice total',
        409,
        { number: doc.number },
      );
    }
    const label = doc.type === 'CREDIT_NOTE' ? labels.creditNote : labels.invoice;
    for (const group of groups.values()) {
      if (group.gross === 0) continue; // DATEV rejects 0,00 bookings
      bookings.push({
        amountCents: Math.abs(group.gross),
        side: group.gross > 0 ? 'S' : 'H',
        account: settings.debtorAccount,
        counterAccount: group.account,
        buKey: group.buKey,
        ...day(doc.issuedAt),
        voucher1: doc.number,
        text: `${label} ${doc.number}`,
      });
    }
  }
  if (missingRates.size > 0) {
    throw new DomainError(
      'ACCOUNTING_ACCOUNT_MISSING',
      'No revenue account is configured for some tax rates',
      409,
      { rateBasisPoints: [...missingRates].sort((a, b) => a - b) },
    );
  }

  for (const p of data.payments) {
    const money = moneyAccountFor(settings, p.method);
    if (!money) continue;
    bookings.push({
      amountCents: p.amount,
      side: 'S',
      account: money,
      counterAccount: settings.debtorAccount,
      ...day(p.capturedAt),
      voucher1: p.voucher,
      text: testText(p.isTest, `${labels.payment} ${p.orderNumber}`),
    });
  }
  for (const p of data.paymentReversals) {
    const money = moneyAccountFor(settings, p.method);
    if (!money) continue;
    bookings.push({
      amountCents: p.amount,
      side: 'H',
      account: money,
      counterAccount: settings.debtorAccount,
      ...day(p.reversedAt),
      voucher1: p.voucher,
      text: testText(p.isTest, `${labels.paymentReversal} ${p.orderNumber}`),
    });
  }
  for (const w of data.writeOffs) {
    bookings.push({
      amountCents: w.amount,
      side: w.reversal ? 'S' : 'H',
      account: settings.debtorAccount,
      counterAccount: settings.writeOffAccount,
      ...day(w.date),
      voucher1: w.voucher,
      text: testText(
        w.isTest,
        `${w.reversal ? labels.writeOffReversal : labels.writeOff} ${w.orderNumber}`,
      ),
    });
  }
  for (const r of data.refunds) {
    const money = moneyAccountFor(settings, r.method);
    if (!money) continue;
    bookings.push({
      amountCents: r.amount,
      side: 'H',
      account: money,
      counterAccount: settings.debtorAccount,
      ...day(r.processedAt),
      voucher1: r.creditNoteNumber ?? r.orderNumber,
      text: testText(r.isTest, `${labels.refund} ${r.creditNoteNumber ?? r.orderNumber}`),
    });
  }

  const body = buildDatevFile(
    {
      consultantNumber: settings.consultantNumber,
      clientNumber: settings.clientNumber,
      fiscalYearStart: compactDate(fyStart),
      accountLength: settings.accountLength,
      from: compactDate(range.from),
      to: compactDate(range.to),
      description: labels.description,
      chart: settings.chart === 'SKR03' ? '03' : settings.chart === 'SKR04' ? '04' : '',
      createdAt: now,
      timeZone,
      exportedBy: labels.exportedBy,
    },
    bookings,
  );
  return { body, rows: bookings.length, fiscalYearStart: fyStart };
}
