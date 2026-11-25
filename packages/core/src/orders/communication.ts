import { auditLogs, emailMessages, orderHistory, orders, withTransaction } from '@tix/db';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { EmailStatus } from '@tix/shared';
import { DomainError, type CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage } from '../email';
import { coreLog } from '../log';

/**
 * Admin communication on a single order: a free-text message to the buyer (ORDER_MESSAGE, framed
 * by the shop branding) and the e-mail history of the order.
 */

const messageSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
});

export async function sendOrderMessage(
  ctx: CoreContext,
  params: { orderId: string; subject: string; body: string; userId: string },
): Promise<{ messageId: string }> {
  const parsed = messageSchema.safeParse({ subject: params.subject, body: params.body });
  if (!parsed.success)
    throw new DomainError('MESSAGE_REQUIRED', 'Subject and text are required', 422);
  const { subject, body } = parsed.data;
  const messageId = await withTransaction(ctx.db, async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, email: orders.email, orderNumber: orders.orderNumber })
      .from(orders)
      .where(eq(orders.id, params.orderId));
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (!order.email) {
      throw new DomainError('ORDER_HAS_NO_EMAIL', 'The order has no e-mail address', 409);
    }
    const id = await createEmailMessage(ctx, tx, {
      key: 'ORDER_MESSAGE',
      orderId: order.id,
      variables: { messageSubject: subject, messageBody: body },
    });
    // The text itself stays in the (encrypted) outbox; the history records that and what subject.
    await tx.insert(orderHistory).values({
      orderId: order.id,
      type: 'message_sent',
      actorType: 'ADMIN',
      actorUserId: params.userId,
      data: { subject, messageId: id },
    });
    await tx.insert(auditLogs).values({
      actorType: 'ADMIN',
      actorUserId: params.userId,
      action: 'order.message_sent',
      entityType: 'order',
      entityId: order.id,
      changes: null,
      metadata: { subject, messageId: id },
    });
    return id;
  });
  await dispatchEmailMessage(ctx, messageId).catch((err: unknown) =>
    coreLog.error({ err }, '[order-message] mail stored but not queued (outbox retries)'),
  );
  return { messageId };
}

export interface OrderEmailRow {
  id: string;
  templateKey: string | null;
  toEmail: string;
  /** Rendered subject once sent; a placeholder (`[KEY]`) before. */
  subject: string;
  status: EmailStatus;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
  /** FAILED and still renderable: "send again" is possible. */
  retryable: boolean;
}

/**
 * E-mails of an order (newest first). Mails to ticket holders carry no order id and are not
 * listed (only `sourceOrderId` in their envelope, for GDPR erasure).
 */
export async function listOrderEmails(
  ctx: Pick<CoreContext, 'db'>,
  orderId: string,
  limit = 100,
): Promise<OrderEmailRow[]> {
  const rows = await ctx.db
    .select({
      id: emailMessages.id,
      templateKey: emailMessages.templateKey,
      toEmail: emailMessages.toEmail,
      subject: emailMessages.subject,
      status: emailMessages.status,
      attempts: emailMessages.attempts,
      lastError: emailMessages.lastError,
      createdAt: emailMessages.createdAt,
      sentAt: emailMessages.sentAt,
      purged: sql<boolean>`coalesce(${emailMessages.attachments} ? 'purgedAt', false)`,
    })
    .from(emailMessages)
    .where(eq(emailMessages.orderId, orderId))
    .orderBy(desc(emailMessages.createdAt))
    .limit(limit);
  return rows.map(({ purged, ...row }) => ({
    ...row,
    retryable: row.status === 'FAILED' && !purged,
  }));
}
