import { customers, emailMessages, invoices, orders, tickets, type Executor } from '@tix/db';
import type { EmailTemplateKey } from '@tix/shared';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, requireCapability, type CoreContext } from '../context';
import { QUEUE_NAMES } from '../job-queues';

export interface EmailRequest {
  key: EmailTemplateKey;
  /** Recipient; defaults to the order's e-mail when `orderId` is set. */
  to?: string;
  /** BCP-47 / app locale (en, de); defaults to the order's locale, then the shop default. */
  locale?: string;
  orderId?: string | null;
  customerId?: string | null;
  /** Event whose template override should be preferred (defaults to the order's first event). */
  eventId?: string | null;
  variables?: Record<string, string | number | null | undefined>;
  /** Omitted for PAYMENT_RECEIVED_TICKETS → the order's invoice is attached automatically. */
  attachments?: EmailAttachment[];
}

export type EmailAttachment =
  /** Invoice / credit note PDF – rendered on demand if it does not exist yet. */
  | { type: 'invoice'; invoiceId: string }
  /** The order's tickets as one PDF (rendered when the mail is sent, so retries re-render). */
  | { type: 'tickets'; orderId: string }
  /** Any stored object (bucket "documents"). */
  | { type: 'object'; objectKey: string; filename: string; contentType: string };

/**
 * What the worker needs to render a queued message, persisted in `email_messages.attachments`
 * (JSONB) until the table gets dedicated columns. Extra variables may contain single-use
 * links (password reset, login) and are therefore stored encrypted.
 */
export interface StoredEmailRequest {
  v: 1;
  attachments: EmailAttachment[];
  locale: string | null;
  eventId: string | null;
  customerId: string | null;
  /** SecretBox envelope of the JSON `variables` (null when none). */
  variables: string | null;
  /** Files attached when the message was sent (delivery log). */
  /** The tickets PDF was left out because the message would exceed the maximum mail size. */
  ticketsOmitted?: boolean;
  /** Set when the stored variables were erased (retention / GDPR): the message cannot be re-sent. */
  purgedAt?: string;
  sentFiles?: { fileName: string; contentType: string; size: number }[];
}

export const EMAIL_VARIABLES_CONTEXT = 'email-message:variables';

/** Retries of the e-mail job: 30 s, 1, 2, 4, 8, 16, 32 min → ~1 h until FAILED. */
export const EMAIL_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 30_000 },
} as const;

const emailAddress = z.email();

async function hasValidTickets(db: Executor, orderId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.orderId, orderId), eq(tickets.status, 'VALID')))
    .limit(1);
  return Boolean(row);
}

export function parseStoredEmailRequest(raw: unknown): StoredEmailRequest {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as { v?: unknown }).v === 1) {
    return raw as StoredEmailRequest;
  }
  // Rows written by other tools: a plain attachment list.
  return {
    v: 1,
    attachments: Array.isArray(raw) ? (raw as EmailAttachment[]) : [],
    locale: null,
    eventId: null,
    customerId: null,
    variables: null,
  };
}

/**
 * Inserts the outbox row (status QUEUED) without dispatching it – use inside a transaction
 * and call `dispatchEmailMessage` after the commit.
 */
export async function createEmailMessage(
  ctx: CoreContext,
  db: Executor,
  request: EmailRequest,
): Promise<string> {
  let to = request.to?.trim();
  if (!to && request.orderId) {
    const [order] = await db
      .select({ email: orders.email })
      .from(orders)
      .where(eq(orders.id, request.orderId));
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    to = order.email ?? undefined;
  }
  if (!to && request.customerId) {
    const [customer] = await db
      .select({ email: customers.email })
      .from(customers)
      .where(eq(customers.id, request.customerId));
    if (!customer) throw new DomainError('CUSTOMER_NOT_FOUND', 'Customer not found', 404);
    to = customer.email;
  }
  if (!to || !emailAddress.safeParse(to).success) {
    throw new DomainError('INVALID_RECIPIENT', 'E-mail recipient is missing or invalid', 422);
  }
  const variables = Object.fromEntries(
    Object.entries(request.variables ?? {}).filter(([, v]) => v !== undefined),
  );
  let attachments = request.attachments;
  if (attachments === undefined && request.key === 'PAYMENT_RECEIVED_TICKETS' && request.orderId) {
    // The payment confirmation always carries the invoice (also when an admin resends it).
    const [invoice] = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.orderId, request.orderId), eq(invoices.type, 'INVOICE')))
      .orderBy(desc(invoices.issuedAt))
      .limit(1);
    attachments = [
      ...(invoice ? [{ type: 'invoice' as const, invoiceId: invoice.id }] : []),
      ...((await hasValidTickets(db, request.orderId))
        ? [{ type: 'tickets' as const, orderId: request.orderId }]
        : []),
    ];
  }
  if (attachments === undefined && request.key === 'TICKETS_RESENT' && request.orderId) {
    attachments = (await hasValidTickets(db, request.orderId))
      ? [{ type: 'tickets', orderId: request.orderId }]
      : [];
  }
  const payload: StoredEmailRequest = {
    v: 1,
    attachments: attachments ?? [],
    locale: request.locale ?? null,
    eventId: request.eventId ?? null,
    customerId: request.customerId ?? null,
    variables:
      Object.keys(variables).length > 0
        ? requireCapability(ctx, 'secrets').encryptJson(variables, EMAIL_VARIABLES_CONTEXT)
        : null,
  };
  const [row] = await db
    .insert(emailMessages)
    .values({
      templateKey: request.key,
      orderId: request.orderId ?? null,
      toEmail: to,
      // Replaced by the rendered subject when the worker sends the message.
      subject: `[${request.key}]`,
      status: 'QUEUED',
      attachments: payload,
    })
    .returning({ id: emailMessages.id });
  return row!.id;
}

/**
 * Adds the send job for a QUEUED message. Queue failures are recorded on the row instead of
 * thrown: the outbox sweeper re-dispatches such messages, the caller's work is already done.
 */
export async function dispatchEmailMessage(
  ctx: CoreContext,
  messageId: string,
  jobId = `email-${messageId}`,
): Promise<void> {
  const jobs = requireCapability(ctx, 'jobs');
  try {
    await jobs.add(QUEUE_NAMES.email, 'send', { messageId }, { jobId, ...EMAIL_JOB_OPTIONS });
    await ctx.db.update(emailMessages).set({ jobId }).where(eq(emailMessages.id, messageId));
  } catch (err) {
    await ctx.db
      .update(emailMessages)
      .set({
        lastError: `Could not be queued: ${err instanceof Error ? err.message : String(err)}`,
      })
      .where(eq(emailMessages.id, messageId));
  }
}
