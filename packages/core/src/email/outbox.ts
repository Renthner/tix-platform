import { emailMessages } from '@tix/db';
import { and, asc, eq, lt } from 'drizzle-orm';
import { DomainError, requireCapability, type CoreContext } from '../context';
import { QUEUE_NAMES } from '../job-queues';
import { formatDateTime } from '../format';
import { getSetting } from '../settings';
import { deliverEmailMessage, EmailDeliveryError } from './deliver';
import { createEmailMessage, dispatchEmailMessage } from './request';

/** BullMQ job states in which a message's job will still run. */
const LIVE_JOB_STATES = new Set([
  'waiting',
  'delayed',
  'active',
  'prioritized',
  'waiting-children',
]);

/**
 * Outbox sweeper: re-dispatches QUEUED messages whose job is gone (Redis outage while
 * enqueueing, flushed queue). Messages whose job is still waiting / in backoff are left alone.
 */
export async function requeueStaleEmails(
  ctx: CoreContext,
  options: { olderThanMinutes?: number; limit?: number } = {},
): Promise<number> {
  const jobs = requireCapability(ctx, 'jobs');
  const stale = await ctx.db
    .select({ id: emailMessages.id, jobId: emailMessages.jobId })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.status, 'QUEUED'),
        lt(
          emailMessages.updatedAt,
          new Date(Date.now() - (options.olderThanMinutes ?? 10) * 60_000),
        ),
      ),
    )
    .orderBy(asc(emailMessages.createdAt))
    .limit(options.limit ?? 200);
  let requeued = 0;
  for (const message of stale) {
    if (message.jobId) {
      const job = await jobs.queue(QUEUE_NAMES.email).getJob(message.jobId);
      if (job && LIVE_JOB_STATES.has(await job.getState())) continue;
    }
    await dispatchEmailMessage(ctx, message.id, `email-${message.id}-${Date.now().toString(36)}`);
    requeued += 1;
  }
  return requeued;
}

/** Sends a FAILED message again (admin action). */
export async function retryEmailMessage(ctx: CoreContext, messageId: string): Promise<void> {
  const [row] = await ctx.db
    .update(emailMessages)
    .set({ status: 'QUEUED', lastError: null, updatedAt: new Date() })
    .where(and(eq(emailMessages.id, messageId), eq(emailMessages.status, 'FAILED')))
    .returning({ id: emailMessages.id });
  if (!row) throw new DomainError('EMAIL_NOT_RETRYABLE', 'Only failed e-mails can be retried', 409);
  await dispatchEmailMessage(ctx, messageId, `email-${messageId}-${Date.now().toString(36)}`);
}

export type TestEmailResult =
  | { ok: true; messageId: string; providerMessageId: string | null }
  | { ok: false; messageId: string | null; error: string };

/**
 * Sends the SMTP_TEST template synchronously with the saved SMTP settings and reports the
 * outcome (the attempt is logged in the outbox like every other e-mail).
 */
export async function sendTestEmail(
  ctx: CoreContext,
  params: { to: string; locale?: string },
): Promise<TestEmailResult> {
  let messageId: string | null = null;
  try {
    const general = await getSetting(ctx, 'general');
    const locale = params.locale ?? general.defaultLocale;
    messageId = await createEmailMessage(ctx, ctx.db, {
      key: 'SMTP_TEST',
      to: params.to,
      locale,
      variables: { sentAt: formatDateTime(new Date(), locale, general.defaultTimeZone, 'long') },
    });
    const result = await deliverEmailMessage(ctx, messageId, { finalAttempt: true });
    return {
      ok: true,
      messageId,
      providerMessageId: result.status === 'SENT' ? result.providerMessageId : null,
    };
  } catch (err) {
    const error =
      err instanceof EmailDeliveryError || err instanceof DomainError || err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, messageId, error };
  }
}
