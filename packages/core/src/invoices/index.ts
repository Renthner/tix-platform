import {
  fees as feesTable,
  invoiceLines,
  invoices,
  orderHistory,
  orders,
  taxRates,
  withTransaction,
  type Executor,
} from '@tix/db';
import type { PartySnapshot, PostalAddress, SettingValue } from '@tix/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { DomainError, requireCapability, type CoreContext } from '../context';
import { loadOrderDocumentData, type OrderDocumentData } from '../documents/order-data';
import { formatDate, yearIn } from '../format';
import { documentLocale, mailTranslator } from '../i18n/mail-messages';
import { QUEUE_NAMES } from '../job-queues';
import { nextNumber } from '../numbering';
import { getSetting } from '../settings';
import { buildInvoiceDraft } from './build';
import { renderInvoicePdfDocument } from './pdf';

export { buildInvoiceDraft, type InvoiceDraft, type InvoiceLineDraft } from './build';
export { renderInvoicePdfDocument, type InvoicePdfInput } from './pdf';
export { toWinAnsi } from './pdf-text';

/**
 * Invoicing – CONTRACT used by order fulfilment.
 *
 * `issueInvoice` creates the invoice for a PAID order (GoBD: gapless number from the
 * `invoicing.invoiceNumberPattern`, seller snapshot from the `organizer` settings, buyer
 * snapshot from the order, one line per order item and fee with tax split, tax breakdown,
 * legal notes e.g. Kleinunternehmer § 19 UStG) in its own transaction and enqueues the PDF
 * rendering (`documents` queue). Idempotent: returns the existing invoice of the order.
 * Returns null when invoicing is disabled (`invoicing.issueInvoices = false`).
 *
 * `renderInvoicePdf` renders (or re-renders) the PDF, stores it in the documents bucket and
 * sets `invoices.pdf_object_key` (the only column the GoBD trigger allows to change).
 */
export async function issueInvoice(
  ctx: CoreContext,
  orderId: string,
): Promise<{ invoiceId: string; invoiceNumber: string } | null> {
  const invoicing = await getSetting(ctx, 'invoicing');
  if (!invoicing.issueInvoices) return null;
  const [general, organizer] = await Promise.all([
    getSetting(ctx, 'general'),
    getSetting(ctx, 'organizer'),
  ]);

  const result = await withTransaction(ctx.db, async (tx) => {
    // Row lock: concurrent calls for the same order serialise here (one invoice per order).
    const [order] = await tx
      .select({ id: orders.id, paidAt: orders.paidAt })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('update');
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    const [existing] = await tx
      .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
      .from(invoices)
      .where(and(eq(invoices.orderId, orderId), eq(invoices.type, 'INVOICE')))
      .orderBy(asc(invoices.issuedAt))
      .limit(1);
    if (existing)
      return { invoiceId: existing.id, invoiceNumber: existing.invoiceNumber, created: false };
    if (!order.paidAt) {
      throw new DomainError('ORDER_NOT_PAID', 'Invoices are issued for paid orders only', 409);
    }

    const data = (await loadOrderDocumentData(tx, orderId))!;
    const t = mailTranslator(data.order.locale);
    const draft = buildInvoiceDraft(data, t, await taxNotesByRate(tx, data));
    const issuedAt = new Date();
    const invoiceNumber = await nextNumber(
      tx,
      'invoice',
      invoicing.invoiceNumberPattern,
      issuedAt,
      general.defaultTimeZone,
    );
    const legalNotes = [
      ...new Set(draft.taxBreakdown.flatMap((entry) => (entry.note ? [entry.note] : []))),
      t('invoice.notes.serviceDate'),
      t('invoice.notes.paid', {
        date: formatDate(order.paidAt, data.order.locale, general.defaultTimeZone, 'medium'),
        method: t(`paymentMethods.${data.order.paymentMethod}`),
      }),
    ].join('\n');

    const [invoice] = await tx
      .insert(invoices)
      .values({
        orderId,
        type: 'INVOICE',
        invoiceNumber,
        issuedAt,
        seller: sellerSnapshot(organizer, general.shopName, general.supportEmail),
        buyer: buyerSnapshot(data),
        currency: data.order.currency,
        totalNet: draft.totalNet,
        totalTax: draft.totalTax,
        totalGross: draft.totalGross,
        taxBreakdown: draft.taxBreakdown,
        legalNotes,
      })
      .returning({ id: invoices.id });
    await tx.insert(invoiceLines).values(
      draft.lines.map((line) => ({
        invoiceId: invoice!.id,
        position: line.position,
        description: line.description,
        serviceDate: line.serviceDate,
        quantity: line.quantity,
        unitPriceGross: line.unitPriceGross,
        taxRateBasisPoints: line.taxRateBasisPoints,
        totalNet: line.totalNet,
        totalTax: line.totalTax,
        totalGross: line.totalGross,
        orderItemId: line.orderItemId,
        orderFeeId: line.orderFeeId,
      })),
    );
    await tx.insert(orderHistory).values({
      orderId,
      type: 'invoice_issued',
      actorType: 'SYSTEM',
      data: { invoiceId: invoice!.id, invoiceNumber, totalGross: draft.totalGross },
    });
    return { invoiceId: invoice!.id, invoiceNumber, created: true };
  });

  if (result.created && ctx.jobs) {
    await ctx.jobs.add(
      QUEUE_NAMES.documents,
      'render-invoice',
      { invoiceId: result.invoiceId },
      { jobId: `render-invoice-${result.invoiceId}` },
    );
  }
  return { invoiceId: result.invoiceId, invoiceNumber: result.invoiceNumber };
}

/** Legal notes of the tax rates applied to the order, keyed by rate (basis points). */
async function taxNotesByRate(
  db: Executor,
  data: OrderDocumentData,
): Promise<Map<number, string[]>> {
  const feeIds = data.fees.flatMap((f) => (f.feeId ? [f.feeId] : []));
  const feeRates = feeIds.length
    ? await db
        .select({ id: feesTable.id, taxRateId: feesTable.taxRateId })
        .from(feesTable)
        .where(inArray(feesTable.id, feeIds))
    : [];
  const rateIds = new Set<string>(data.events.map((e) => e.taxRateId));
  for (const fee of feeRates) if (fee.taxRateId) rateIds.add(fee.taxRateId);
  if (rateIds.size === 0) return new Map();
  const rates = await db
    .select({ rate: taxRates.rateBasisPoints, note: taxRates.invoiceNote })
    .from(taxRates)
    .where(inArray(taxRates.id, [...rateIds]));
  // Only rates actually present on the invoice (a rate edited after the sale is skipped).
  const used = new Set([
    ...data.items.map((i) => i.taxRateBasisPoints),
    ...data.fees.map((f) => f.taxRateBasisPoints),
  ]);
  const notes = new Map<number, string[]>();
  for (const { rate, note } of rates) {
    const text = note?.trim();
    if (!text || !used.has(rate)) continue;
    const list = notes.get(rate) ?? [];
    if (!list.includes(text)) list.push(text);
    notes.set(rate, list);
  }
  return notes;
}

function sellerSnapshot(
  organizer: SettingValue<'organizer'>,
  shopName: string,
  supportEmail: string | undefined,
): PartySnapshot {
  const address: PostalAddress | undefined =
    organizer.street && organizer.postalCode && organizer.city
      ? {
          street: organizer.street,
          postalCode: organizer.postalCode,
          city: organizer.city,
          country: organizer.country,
        }
      : undefined;
  return stripUndefined({
    name: organizer.legalName || shopName,
    address,
    email: organizer.email ?? supportEmail,
    vatId: organizer.vatId,
    taxNumber: organizer.taxNumber,
    registerCourt: organizer.registerCourt,
    registerNumber: organizer.registerNumber,
    representatives: organizer.representatives,
  });
}

function buyerSnapshot(data: OrderDocumentData): PartySnapshot {
  const { order } = data;
  return stripUndefined({
    name: `${order.firstName} ${order.lastName}`.trim() || order.email,
    company: order.company ?? undefined,
    address: order.billingAddress ?? undefined,
    email: order.email,
  });
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ) as T;
}

/** Object key of an invoice PDF: invoices/{YYYY}/{number}.pdf (number made path-safe). */
export function invoiceObjectKey(invoiceNumber: string, issuedAt: Date, timeZone: string): string {
  const safe = invoiceNumber.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `invoices/${yearIn(issuedAt, timeZone)}/${safe}.pdf`;
}

interface RenderedInvoice {
  objectKey: string;
  bytes: Uint8Array;
  fileName: string;
  invoiceNumber: string;
  orderId: string;
}

async function renderAndStore(ctx: CoreContext, invoiceId: string): Promise<RenderedInvoice> {
  const storage = requireCapability(ctx, 'storage');
  const [invoice] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!invoice) throw new DomainError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
  const [lines, [order], corrected, general, invoicing] = await Promise.all([
    ctx.db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoiceId))
      .orderBy(asc(invoiceLines.position)),
    ctx.db
      .select({
        orderNumber: orders.orderNumber,
        createdAt: orders.createdAt,
        locale: orders.locale,
        paymentMethod: orders.paymentMethod,
      })
      .from(orders)
      .where(eq(orders.id, invoice.orderId)),
    invoice.correctsInvoiceId
      ? ctx.db
          .select({ number: invoices.invoiceNumber })
          .from(invoices)
          .where(eq(invoices.id, invoice.correctsInvoiceId))
      : Promise.resolve([]),
    getSetting(ctx, 'general'),
    getSetting(ctx, 'invoicing'),
  ]);
  if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
  const locale = documentLocale(order.locale);
  const t = mailTranslator(locale);
  const bytes = await renderInvoicePdfDocument(
    {
      type: invoice.type,
      invoiceNumber: invoice.invoiceNumber,
      issuedAt: invoice.issuedAt,
      correctsInvoiceNumber: corrected[0]?.number ?? null,
      currency: invoice.currency,
      seller: invoice.seller,
      buyer: invoice.buyer,
      orderNumber: order.orderNumber,
      orderDate: order.createdAt,
      paymentMethodLabel: t(`paymentMethods.${order.paymentMethod}`),
      lines,
      totalNet: invoice.totalNet,
      totalTax: invoice.totalTax,
      totalGross: invoice.totalGross,
      taxBreakdown: invoice.taxBreakdown,
      legalNotes: invoice.legalNotes,
      footerText: invoicing.invoiceFooter ?? null,
      locale,
      timeZone: general.defaultTimeZone,
    },
    t,
  );
  const objectKey =
    invoice.pdfObjectKey ??
    invoiceObjectKey(invoice.invoiceNumber, invoice.issuedAt, general.defaultTimeZone);
  await storage.put('documents', objectKey, bytes, 'application/pdf');
  if (!invoice.pdfObjectKey) {
    // The GoBD trigger allows exactly this change (NULL → key) on an issued invoice.
    await ctx.db
      .update(invoices)
      .set({ pdfObjectKey: objectKey })
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.pdfObjectKey)));
  }
  return {
    objectKey,
    bytes,
    fileName: invoiceFileName(invoice.type, invoice.invoiceNumber, locale),
    invoiceNumber: invoice.invoiceNumber,
    orderId: invoice.orderId,
  };
}

function invoiceFileName(type: 'INVOICE' | 'CREDIT_NOTE', number: string, locale: string): string {
  const t = mailTranslator(locale);
  const safe = number.replace(/[^A-Za-z0-9._-]+/g, '_');
  return type === 'CREDIT_NOTE'
    ? t('invoice.creditNoteFileName', { number: safe })
    : t('invoice.fileName', { number: safe });
}

/**
 * Renders the invoice PDF and stores it. An already archived PDF is kept unless `force` is
 * set (the rendering is deterministic, so a forced re-render reproduces the same document).
 */
export async function renderInvoicePdf(
  ctx: CoreContext,
  invoiceId: string,
  options: { force?: boolean } = {},
): Promise<{ objectKey: string }> {
  if (!options.force) {
    const [row] = await ctx.db
      .select({ key: invoices.pdfObjectKey })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    if (!row) throw new DomainError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
    if (row.key && (await objectExists(ctx, row.key))) return { objectKey: row.key };
  }
  const rendered = await renderAndStore(ctx, invoiceId);
  return { objectKey: rendered.objectKey };
}

async function objectExists(ctx: CoreContext, key: string): Promise<boolean> {
  try {
    await requireCapability(ctx, 'storage').get('documents', key);
    return true;
  } catch (err) {
    if (isMissingObject(err)) return false;
    throw err;
  }
}

function isMissingObject(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}

/**
 * PDF bytes of an invoice / credit note for downloads and e-mail attachments; renders and
 * archives it first when it does not exist yet (or the stored object went missing).
 */
export async function loadInvoicePdf(
  ctx: CoreContext,
  invoiceId: string,
): Promise<{
  bytes: Uint8Array;
  fileName: string;
  contentType: 'application/pdf';
  invoiceNumber: string;
  orderId: string;
}> {
  const storage = requireCapability(ctx, 'storage');
  const [invoice] = await ctx.db
    .select({
      key: invoices.pdfObjectKey,
      type: invoices.type,
      invoiceNumber: invoices.invoiceNumber,
      orderId: invoices.orderId,
      locale: orders.locale,
    })
    .from(invoices)
    .innerJoin(orders, eq(orders.id, invoices.orderId))
    .where(eq(invoices.id, invoiceId));
  if (!invoice) throw new DomainError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
  if (invoice.key) {
    try {
      const { body } = await storage.get('documents', invoice.key);
      return {
        bytes: body,
        fileName: invoiceFileName(
          invoice.type,
          invoice.invoiceNumber,
          documentLocale(invoice.locale),
        ),
        contentType: 'application/pdf',
        invoiceNumber: invoice.invoiceNumber,
        orderId: invoice.orderId,
      };
    } catch (err) {
      if (!isMissingObject(err)) throw err;
    }
  }
  const rendered = await renderAndStore(ctx, invoiceId);
  return {
    bytes: rendered.bytes,
    fileName: rendered.fileName,
    contentType: 'application/pdf',
    invoiceNumber: rendered.invoiceNumber,
    orderId: rendered.orderId,
  };
}

/** Invoices and credit notes of an order (newest last) – for order pages and the admin. */
export async function listOrderInvoices(ctx: Pick<CoreContext, 'db'>, orderId: string) {
  const rows = await ctx.db
    .select({
      id: invoices.id,
      type: invoices.type,
      invoiceNumber: invoices.invoiceNumber,
      issuedAt: invoices.issuedAt,
      totalGross: invoices.totalGross,
      currency: invoices.currency,
      pdfObjectKey: invoices.pdfObjectKey,
    })
    .from(invoices)
    .where(eq(invoices.orderId, orderId))
    .orderBy(asc(invoices.issuedAt));
  return rows.map(({ pdfObjectKey, ...row }) => ({ ...row, hasPdf: pdfObjectKey !== null }));
}
