import { emailMessages, orders, withTransaction } from '@tix/db';
import { and, eq, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage, type EmailAttachment } from '../email';
import { issueInvoice } from '../invoices';

export interface PaidOrderResult {
  invoiceId: string | null;
  /** Business reason why no invoice could be issued (order data inconsistent). */
  invoiceError: string | null;
  /** The payment confirmation; null when it was queued by an earlier run. */
  messageId: string | null;
  skipped?: 'ORDER_NOT_FOUND' | 'NOT_PAID';
}

/** Domain errors of invoice issuance that retrying cannot fix. */
const PERMANENT_INVOICE_ERRORS = new Set(['INVOICE_EMPTY', 'INVOICE_TOTAL_MISMATCH']);

/**
 * Fulfilment after an order became PAID (`documents` job `order-paid`): issues the invoice
 * (if enabled) and queues the PAYMENT_RECEIVED_TICKETS e-mail with the invoice attached.
 * Idempotent – a retried job never creates a second invoice or a second e-mail.
 */
export async function processPaidOrder(
  ctx: CoreContext,
  orderId: string,
): Promise<PaidOrderResult> {
  const [order] = await ctx.db
    .select({ id: orders.id, paidAt: orders.paidAt })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order)
    return { invoiceId: null, invoiceError: null, messageId: null, skipped: 'ORDER_NOT_FOUND' };
  if (!order.paidAt)
    return { invoiceId: null, invoiceError: null, messageId: null, skipped: 'NOT_PAID' };

  let invoiceId: string | null = null;
  let invoiceError: string | null = null;
  try {
    invoiceId = (await issueInvoice(ctx, orderId))?.invoiceId ?? null;
  } catch (err) {
    // The customer still gets the payment confirmation; the admin issues the invoice later.
    if (!(err instanceof DomainError && PERMANENT_INVOICE_ERRORS.has(err.code))) throw err;
    invoiceError = `${err.code}: ${err.message}`;
  }

  const attachments: EmailAttachment[] = invoiceId ? [{ type: 'invoice', invoiceId }] : [];
  const messageId = await withTransaction(ctx.db, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`order-paid-mail:${orderId}`}))`);
    const [existing] = await tx
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.orderId, orderId),
          eq(emailMessages.templateKey, 'PAYMENT_RECEIVED_TICKETS'),
        ),
      )
      .limit(1);
    if (existing) return null;
    return createEmailMessage(ctx, tx, {
      key: 'PAYMENT_RECEIVED_TICKETS',
      orderId,
      attachments,
    });
  });
  if (messageId) await dispatchEmailMessage(ctx, messageId);
  return { invoiceId, invoiceError, messageId };
}
