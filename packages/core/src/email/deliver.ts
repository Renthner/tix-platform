import { emailMessages, orderAdjustments } from '@tix/db';
import { and, eq, lt, or, sql } from 'drizzle-orm';
import type { SendMailOptions } from 'nodemailer';
import { DomainError, requireCapability, type CoreContext } from '../context';
import { renderOrderTicketsPdf } from '../tickets/render';
import { loadInvoicePdf } from '../invoices';
import { getSetting } from '../settings';
import { EmailTemplateMissingError, renderEmail } from './render';
import {
  EMAIL_VARIABLES_CONTEXT,
  parseStoredEmailRequest,
  type EmailAttachment,
  type StoredEmailRequest,
} from './request';
import { estimateMessageBytes, exceedsMaxMessageSize } from './size';
import { TemplateSyntaxError } from './template';
import { isPermanentSmtpError, smtpSender, type MailSender } from './transport';

/** Templates carrying a sign-in / set-password link (never BCC'd). */
const CREDENTIAL_LINK_KEYS: ReadonlySet<string> = new Set([
  'ADMIN_INVITE',
  'ADMIN_PASSWORD_RESET',
  'CUSTOMER_PASSWORD_RESET',
  'CUSTOMER_LOGIN_LINK',
  'CUSTOMER_EMAIL_VERIFICATION',
]);

/** Delivery failed; `permanent` errors are not retried (unknown template, rejected recipient). */
export class EmailDeliveryError extends Error {
  override name = 'EmailDeliveryError';
  constructor(
    message: string,
    readonly permanent: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface DeliverOptions {
  /** Mail sender override (tests, previews); defaults to the SMTP settings. */
  sender?: MailSender;
  /** Last try: a failure marks the message FAILED instead of re-queueing it. */
  finalAttempt?: boolean;
}

export type DeliverResult =
  | { status: 'SENT'; providerMessageId: string | null }
  /** Sent before (job retried after the success was recorded). */
  | { status: 'ALREADY_SENT' }
  /** The additional payment it refers to is no longer open: not sent, marked FAILED. */
  | { status: 'OBSOLETE' };

/** A message stuck in SENDING longer than this is considered abandoned (crashed worker). */
const SENDING_TIMEOUT = sql`now() - interval '2 minutes'`;

/**
 * Renders and sends one outbox message (`email_messages`). Used by the e-mail worker and
 * synchronously by the admin "send test e-mail" action. Updates status, attempts, subject,
 * provider message id and the last error; rethrows failures as `EmailDeliveryError`.
 */
export async function deliverEmailMessage(
  ctx: CoreContext,
  messageId: string,
  options: DeliverOptions = {},
): Promise<DeliverResult> {
  const [message] = await ctx.db
    .update(emailMessages)
    .set({
      status: 'SENDING',
      attempts: sql`${emailMessages.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(emailMessages.id, messageId),
        or(
          eq(emailMessages.status, 'QUEUED'),
          and(eq(emailMessages.status, 'SENDING'), lt(emailMessages.updatedAt, SENDING_TIMEOUT)),
        ),
      ),
    )
    .returning();
  if (!message) {
    const [current] = await ctx.db
      .select({ status: emailMessages.status })
      .from(emailMessages)
      .where(eq(emailMessages.id, messageId));
    if (!current) throw new EmailDeliveryError(`E-mail message ${messageId} not found`, true);
    if (current.status === 'SENT') return { status: 'ALREADY_SENT' };
    if (current.status === 'SENDING') {
      throw new EmailDeliveryError('E-mail message is being sent by another worker', false);
    }
    throw new EmailDeliveryError('E-mail message has failed; retry it explicitly', true);
  }

  const payload = parseStoredEmailRequest(message.attachments);
  let subject: string | undefined;
  try {
    if (!message.templateKey) throw new EmailDeliveryError('Message has no template key', true);
    const variables = payload.variables
      ? requireCapability(ctx, 'secrets').decryptJson<Record<string, string | number | null>>(
          payload.variables,
          EMAIL_VARIABLES_CONTEXT,
        )
      : {};
    // Request / reminder of an additional payment that was paid or cancelled meanwhile.
    if (
      (message.templateKey === 'ADDITIONAL_PAYMENT_REQUEST' ||
        message.templateKey === 'ADDITIONAL_PAYMENT_REMINDER') &&
      typeof variables.adjustmentId === 'string'
    ) {
      const [adjustment] = await ctx.db
        .select({ status: orderAdjustments.status })
        .from(orderAdjustments)
        .where(eq(orderAdjustments.id, variables.adjustmentId));
      if (!adjustment || (adjustment.status !== 'PROPOSED' && adjustment.status !== 'CONFIRMED')) {
        await ctx.db
          .update(emailMessages)
          .set({
            status: 'FAILED',
            lastError: 'obsolete: the additional payment is no longer open',
            updatedAt: new Date(),
          })
          .where(eq(emailMessages.id, messageId));
        return { status: 'OBSOLETE' };
      }
    }
    const invoiceIds = payload.attachments.flatMap((a) =>
      a.type === 'invoice' ? [a.invoiceId] : [],
    );
    const allFiles = await resolveAttachments(ctx, payload.attachments);
    const renderWith = (attached: boolean) =>
      renderEmail(ctx, {
        key: message.templateKey!,
        orderId: message.orderId,
        customerId: payload.customerId,
        eventId: payload.eventId,
        locale: payload.locale,
        to: message.toEmail,
        variables: { ...variables, ticketsAttached: attached ? 'yes' : '' },
        invoiceIds,
      });
    let files = allFiles;
    let ticketsOmitted = false;
    let rendered = await renderWith(allFiles.some((f) => f.isTickets));
    if (allFiles.some((f) => f.isTickets)) {
      const { maxMessageSizeMb } = await getSetting(ctx, 'smtp');
      const estimate = estimateMessageBytes(
        allFiles.map((f) => f.bytes.byteLength),
        Buffer.byteLength(rendered.html) + Buffer.byteLength(rendered.text),
      );
      if (exceedsMaxMessageSize(estimate, maxMessageSizeMb)) {
        // Too large for the mail server: send without the tickets PDF (they stay downloadable).
        console.warn(
          `[email] message ${messageId} would be ~${Math.round(estimate / 1024 / 1024)} MB (limit ${maxMessageSizeMb} MB): sending without the tickets PDF`,
        );
        files = allFiles.filter((f) => !f.isTickets);
        ticketsOmitted = true;
        rendered = await renderWith(false);
      }
    }
    subject = rendered.subject;
    const sender = options.sender ?? (await smtpSender(ctx));
    const mail: SendMailOptions = {
      from: sender.from,
      to: message.toEmail,
      replyTo: sender.replyTo,
      // One-time credential links must not leak into the archive mailbox.
      bcc: CREDENTIAL_LINK_KEYS.has(message.templateKey!) ? undefined : sender.bcc,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      attachments: files.map((f) => ({
        filename: f.fileName,
        content: Buffer.from(f.bytes),
        contentType: f.contentType,
      })),
      headers: { 'Auto-Submitted': 'auto-generated' },
    };
    const info = (await sender.transporter.sendMail(mail)) as { messageId?: string };
    const sentPayload: StoredEmailRequest = {
      ...payload,
      ...(ticketsOmitted ? { ticketsOmitted: true } : {}),
      sentFiles: files.map((f) => ({
        fileName: f.fileName,
        contentType: f.contentType,
        size: f.bytes.byteLength,
      })),
    };
    await ctx.db
      .update(emailMessages)
      .set({
        status: 'SENT',
        subject: rendered.subject,
        sentAt: new Date(),
        providerMessageId: info.messageId ?? null,
        lastError: null,
        attachments: sentPayload,
        updatedAt: new Date(),
      })
      .where(eq(emailMessages.id, messageId));
    return { status: 'SENT', providerMessageId: info.messageId ?? null };
  } catch (err) {
    const permanent =
      (err instanceof EmailDeliveryError && err.permanent) ||
      err instanceof EmailTemplateMissingError ||
      err instanceof TemplateSyntaxError ||
      isPermanentSmtpError(err);
    const text = err instanceof Error ? err.message : String(err);
    await ctx.db
      .update(emailMessages)
      .set({
        status: permanent || options.finalAttempt ? 'FAILED' : 'QUEUED',
        lastError: text.slice(0, 2_000),
        ...(subject ? { subject } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(emailMessages.id, messageId), eq(emailMessages.status, 'SENDING')));
    if (err instanceof EmailDeliveryError) throw err;
    throw new EmailDeliveryError(text, permanent, { cause: err });
  }
}

interface ResolvedFile {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
  /** The order's tickets PDF (the only file dropped when the message gets too large). */
  isTickets?: boolean;
}

async function resolveAttachments(
  ctx: CoreContext,
  attachments: readonly EmailAttachment[],
): Promise<ResolvedFile[]> {
  const files: ResolvedFile[] = [];
  for (const attachment of attachments) {
    if (attachment.type === 'invoice') {
      const pdf = await loadInvoicePdf(ctx, attachment.invoiceId);
      files.push({ fileName: pdf.fileName, contentType: pdf.contentType, bytes: pdf.bytes });
    } else if (attachment.type === 'tickets') {
      try {
        const pdf = await renderOrderTicketsPdf(ctx, attachment.orderId);
        files.push({
          fileName: pdf.fileName,
          contentType: 'application/pdf',
          bytes: pdf.bytes,
          isTickets: true,
        });
      } catch (err) {
        // Tickets voided since the mail was queued (cancelled order): send without the PDF.
        if (!(err instanceof DomainError && err.code === 'NO_TICKETS')) throw err;
      }
    } else {
      const object = await requireCapability(ctx, 'storage').get('documents', attachment.objectKey);
      files.push({
        fileName: attachment.filename,
        contentType: attachment.contentType,
        bytes: object.body,
      });
    }
  }
  return files;
}
