import { emailMessages, orders, withTransaction } from '@tix/db';
import { eq, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage, type EmailAttachment } from '../email';
import { issueInvoice } from '../invoices';
import { hasPaymentMailForCycle } from '../orders/paid-cycle';
import { ensureOrderTickets } from '../tickets/issue';

export interface PaidOrderResult {
  invoiceId: string | null;
  /** Business reason why no invoice could be issued (order data inconsistent). */
  invoiceError: string | null;
  /** Number of VALID tickets of the order after issuance. */
  ticketCount?: number;
  /** The payment confirmation; null when it was queued by an earlier run. */
  messageId: string | null;
  skipped?: 'ORDER_NOT_FOUND' | 'NOT_PAID' | 'REFUNDED';
}

/** Domain errors of invoice issuance that retrying cannot fix. */
const PERMANENT_INVOICE_ERRORS = new Set(['INVOICE_EMPTY', 'INVOICE_TOTAL_MISMATCH']);

/**
 * Fulfilment after an order became PAID (`documents` job `order-paid`): issues the invoice
 * (if enabled), issues the signed tickets and queues the PAYMENT_RECEIVED_TICKETS e-mail with the invoice and the ticket PDF attached.
 * Idempotent – a retried job never creates a second invoice or a second e-mail.
 */
export async function processPaidOrder(
  ctx: CoreContext,
  orderId: string,
  /** Paid cycle the job was queued for; a job of an undone payment is skipped. */
  expectedCycle?: number,
  /**
   * Box-office / admin orders get the payment confirmation only when the seller asked for it
   * (and the buyer left an address); online orders always get it.
   */
  options: { sendPaymentMail?: boolean } = {},
): Promise<PaidOrderResult> {
  const [order] = await ctx.db
    .select({
      id: orders.id,
      paidAt: orders.paidAt,
      status: orders.status,
      paidCycle: orders.paidCycle,
      channel: orders.channel,
      email: orders.email,
    })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order)
    return { invoiceId: null, invoiceError: null, messageId: null, skipped: 'ORDER_NOT_FOUND' };
  if (!order.paidAt || (expectedCycle !== undefined && expectedCycle !== order.paidCycle))
    return { invoiceId: null, invoiceError: null, messageId: null, skipped: 'NOT_PAID' };
  // Fully refunded before this job ran: no payment confirmation (the refund flow issued the
  // invoice and its credit note itself).
  if (order.status === 'REFUNDED') {
    return { invoiceId: null, invoiceError: null, messageId: null, skipped: 'REFUNDED' };
  }

  let invoiceId: string | null = null;
  let invoiceError: string | null = null;
  try {
    invoiceId = (await issueInvoice(ctx, orderId))?.invoiceId ?? null;
  } catch (err) {
    // The customer still gets the payment confirmation; the admin issues the invoice later.
    if (!(err instanceof DomainError && PERMANENT_INVOICE_ERRORS.has(err.code))) throw err;
    invoiceError = `${err.code}: ${err.message}`;
  }

  // Tickets before the mail: all-or-nothing and idempotent, a failure retries the whole job.
  const ticketCount = (await ensureOrderTickets(ctx, orderId)).length;

  // The ticket PDF is rendered by the e-mail job when it sends (a failure retries with the
  // job's back-off instead of blocking fulfilment; the admin can resend after a final failure).
  const attachments: EmailAttachment[] = [
    ...(invoiceId ? [{ type: 'invoice' as const, invoiceId }] : []),
    ...(ticketCount > 0 ? [{ type: 'tickets' as const, orderId }] : []),
  ];
  const wantsMail =
    order.channel === 'ONLINE' || (options.sendPaymentMail === true && Boolean(order.email));
  if (!wantsMail) return { invoiceId, invoiceError, ticketCount, messageId: null };
  const messageId = await withTransaction(ctx.db, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`order-paid-mail:${orderId}`}))`);
    // Re-check under a lock: a reversal that committed in the meantime must not get a payment
    // confirmation (and the mail must not suppress the one of the next payment).
    const [current] = await tx
      .select({ status: orders.status, paidAt: orders.paidAt, paidCycle: orders.paidCycle })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('share');
    if (
      !current?.paidAt ||
      (current.status !== 'PAID' && current.status !== 'PARTIALLY_REFUNDED') ||
      (expectedCycle !== undefined && expectedCycle !== current.paidCycle)
    ) {
      return null;
    }
    if (await hasPaymentMailForCycle(tx, orderId, current.paidCycle)) return null;
    const id = await createEmailMessage(ctx, tx, {
      key: 'PAYMENT_RECEIVED_TICKETS',
      orderId,
      attachments,
    });
    await tx
      .update(emailMessages)
      .set({ paidCycle: current.paidCycle })
      .where(eq(emailMessages.id, id));
    return id;
  });
  if (messageId) await dispatchEmailMessage(ctx, messageId);
  return { invoiceId, invoiceError, ticketCount, messageId };
}
