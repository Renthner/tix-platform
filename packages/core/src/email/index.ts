import type { CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage, type EmailRequest } from './request';

export * from './request';
export * from './template';
export * from './render';
export * from './transport';
export * from './deliver';
export * from './outbox';
export * from './sanitize';
export * from './editor';
export * from './template-admin';
export { EMAIL_VARIABLES } from './variables';

/**
 * Transactional e-mail – CONTRACT used by orders, customer accounts and banking.
 *
 * `enqueueEmail` renders nothing synchronously: it stores an `email_messages` row (status
 * QUEUED) and adds a job to the `email` queue; the worker renders the template
 * (`email_templates`, per key/locale with event-specific override, `{{placeholders}}`) and
 * sends it via the SMTP settings.
 *
 * When `orderId` is given the renderer derives recipient, locale and the standard order
 * variables itself ({{firstName}}, {{orderNumber}}, {{amount}}, {{paymentReference}},
 * {{paymentDueDate}}, bank details, {{orderUrl}}, event list …); `variables` adds or
 * overrides values (e.g. {{verificationUrl}} for account mails).
 */
export async function enqueueEmail(
  ctx: CoreContext,
  request: EmailRequest,
): Promise<{ messageId: string }> {
  const messageId = await createEmailMessage(ctx, ctx.db, request);
  await dispatchEmailMessage(ctx, messageId);
  return { messageId };
}
