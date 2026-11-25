'use server';

import { logger } from '@/server/logger';
import {
  DomainError,
  changeOrderEmail,
  getSetting,
  countMailingRecipients,
  createEventMailing,
  enqueueEventCancellationRun,
  enqueueEventMailing,
  eventTags,
  postponeEvent,
  retryEmailMessage,
  sendEventMailingTest,
  sendOrderMessage,
  startEventCancellation,
} from '@tix/core';
import { emailMessages, events } from '@tix/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { hasLocale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { z } from 'zod';
import { zonedWallTimeToUtc } from '@/lib/datetime';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { flag, text } from './form';
import { refreshShop } from './shop-refresh';

/**
 * Admin actions of the communication features (order message, buyer e-mail change, event
 * cancellation assistant, postponement, bulk mailings). Results carry stable codes translated in
 * `communication.feedback.*` / `communication.errors.*`.
 */
export type CommunicationState =
  | { status: 'idle' }
  | { status: 'success'; message: string; at: number; values?: Record<string, string | number> }
  | { status: 'error'; code: string; at: number };

const ok = (message: string, values?: Record<string, string | number>): CommunicationState => ({
  status: 'success',
  message,
  at: Date.now(),
  ...(values ? { values } : {}),
});
const fail = (code: string): CommunicationState => ({ status: 'error', code, at: Date.now() });

async function run(fn: () => Promise<CommunicationState>): Promise<CommunicationState> {
  try {
    const result = await fn();
    revalidatePath('/[locale]/admin/orders', 'layout');
    revalidatePath('/[locale]/admin/events', 'layout');
    revalidatePath('/[locale]/admin/refunds', 'layout');
    return result;
  } catch (err) {
    if (err instanceof DomainError) return fail(err.code);
    logger.error({ err }, '[admin/communication] action failed');
    return fail('INTERNAL_ERROR');
  }
}

const uuid = z.uuid();

// ── Orders ────────────────────────────────────────────────────────────────────

export async function sendOrderMessageAction(
  orderId: string,
  _prev: CommunicationState,
  fd: FormData,
): Promise<CommunicationState> {
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  if (!uuid.safeParse(orderId).success) return fail('ORDER_NOT_FOUND');
  return run(async () => {
    await sendOrderMessage(getCore(), {
      orderId,
      subject: text(fd, 'subject') ?? '',
      body: text(fd, 'body') ?? '',
      userId: session.userId,
    });
    return ok('messageQueued');
  });
}

export async function changeOrderEmailAction(
  orderId: string,
  _prev: CommunicationState,
  fd: FormData,
): Promise<CommunicationState> {
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  if (!uuid.safeParse(orderId).success) return fail('ORDER_NOT_FOUND');
  const version = Number(text(fd, 'expectedVersion'));
  return run(async () => {
    await changeOrderEmail(getCore(), {
      orderId,
      newEmail: text(fd, 'email') ?? '',
      userId: session.userId,
      overrideLimits: flag(fd, 'overrideLimits'),
      expectedVersion: Number.isInteger(version) ? version : undefined,
    });
    return ok('emailChanged');
  });
}

/** "Send again" of a FAILED outbox message of an order. */
export async function retryOrderEmailAction(
  messageId: string,
  _prev: CommunicationState,
  _fd: FormData,
): Promise<CommunicationState> {
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  if (!uuid.safeParse(messageId).success) return fail('NOT_FOUND');
  return run(async () => {
    const core = getCore();
    const [row] = await core.db
      .select({ orderId: emailMessages.orderId, key: emailMessages.templateKey })
      .from(emailMessages)
      .where(eq(emailMessages.id, messageId));
    if (!row?.orderId) return fail('NOT_FOUND');
    await retryEmailMessage(core, messageId);
    await audit(core.db, session, 'order.email_retried', 'order', row.orderId, {
      messageId,
      template: row.key,
    });
    return ok('emailRetried');
  });
}

// ── Events ────────────────────────────────────────────────────────────────────

/**
 * Cancellation assistant: marks the event cancelled and queues the run that cancels all orders.
 * Also used to run it again (resume) for an already cancelled event.
 */
export async function startEventCancellationAction(
  eventId: string,
  _prev: CommunicationState,
  fd: FormData,
): Promise<CommunicationState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  if (!uuid.safeParse(eventId).success) return fail('EVENT_NOT_FOUND');
  if (text(fd, 'confirm') !== 'CANCEL') return fail('CONFIRMATION_REQUIRED');
  return run(async () => {
    const core = getCore();
    const reason = text(fd, 'reason')?.slice(0, 1000) ?? null;
    const refundFees = flag(fd, 'refundFees');
    const notify = flag(fd, 'notify');
    const { runId, alreadyRunning } = await startEventCancellation(core, {
      eventId,
      reason,
      refundFees,
      notify,
      userId: session.userId,
    });
    await enqueueEventCancellationRun(core, runId);
    await audit(core.db, session, 'event.cancellation.start', 'event', eventId, {
      runId,
      alreadyRunning,
      reason,
      refundFees,
      notify,
    });
    await refreshShop(eventTags(eventId));
    return ok(alreadyRunning ? 'cancellationAlreadyRunning' : 'cancellationStarted');
  });
}

export async function postponeEventAction(
  eventId: string,
  _prev: CommunicationState,
  fd: FormData,
): Promise<CommunicationState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  if (!uuid.safeParse(eventId).success) return fail('EVENT_NOT_FOUND');
  return run(async () => {
    const core = getCore();
    const [event] = await core.db
      .select({ status: events.status, timeZone: events.timeZone })
      .from(events)
      .where(eq(events.id, eventId));
    if (!event) return fail('EVENT_NOT_FOUND');
    if (event.status !== 'PUBLISHED' && event.status !== 'POSTPONED') {
      return fail('EVENT_NOT_LIVE');
    }
    const rawDate = text(fd, 'newStartsAt');
    const newStartsAt = rawDate ? zonedWallTimeToUtc(rawDate, event.timeZone) : null;
    if (rawDate && !newStartsAt) return fail('VALIDATION_FAILED');
    const note = text(fd, 'note')?.slice(0, 2000) ?? null;
    const notify = flag(fd, 'notify');
    const result = await postponeEvent(core, {
      eventId,
      newStartsAt,
      note,
      notify,
      userId: session.userId,
    });
    if (result.mailingId) await enqueueEventMailing(core, result.mailingId);
    await audit(core.db, session, 'event.postponed', 'event', eventId, {
      newStartsAt: newStartsAt?.toISOString() ?? null,
      note,
      notify,
      recipients: result.recipients,
    });
    await refreshShop(eventTags(eventId));
    return ok('postponed', { recipients: result.recipients });
  });
}

/** Allowed values of core `EventMailingAudience`. */
const audienceSchema = z.enum(['PAID', 'ACTIVE', 'CATEGORY']);

const mailingSchema = z.object({
  audience: audienceSchema,
  categoryId: z.uuid().optional(),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
});

function readMailing(fd: FormData) {
  return mailingSchema.safeParse({
    audience: text(fd, 'audience'),
    categoryId: text(fd, 'categoryId'),
    subject: text(fd, 'subject'),
    body: text(fd, 'body'),
  });
}

export async function sendEventMailingAction(
  eventId: string,
  _prev: CommunicationState,
  fd: FormData,
): Promise<CommunicationState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  if (!uuid.safeParse(eventId).success) return fail('EVENT_NOT_FOUND');
  const parsed = readMailing(fd);
  if (!parsed.success) return fail('MESSAGE_REQUIRED');
  return run(async () => {
    const core = getCore();
    const { mailingId, recipients } = await createEventMailing(core, {
      eventId,
      audience: parsed.data.audience,
      categoryId: parsed.data.categoryId ?? null,
      subject: parsed.data.subject,
      body: parsed.data.body,
      userId: session.userId,
    });
    await enqueueEventMailing(core, mailingId);
    return ok('mailingQueued', { recipients });
  });
}

/** Test mail of the message to the admin's own address. */
export async function testEventMailingAction(
  eventId: string,
  _prev: CommunicationState,
  fd: FormData,
): Promise<CommunicationState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  if (!uuid.safeParse(eventId).success) return fail('EVENT_NOT_FOUND');
  const parsed = readMailing(fd);
  if (!parsed.success) return fail('MESSAGE_REQUIRED');
  return run(async () => {
    const core = getCore();
    // The test mail is rendered in the shop default locale: the prefix follows it.
    const configured = (await getSetting(core, 'general')).defaultLocale;
    const locale = hasLocale(routing.locales, configured) ? configured : routing.defaultLocale;
    const t = await getTranslations({ locale, namespace: 'communication' });
    await sendEventMailingTest(core, {
      eventId,
      subject: parsed.data.subject,
      body: parsed.data.body,
      to: session.email,
      locale,
      subjectPrefix: t('testSubjectPrefix'),
    });
    return ok('testQueued', { email: session.email });
  });
}

/** Live recipient count for the audience selection (read-only). */
export async function countEventMailingRecipientsAction(
  eventId: string,
  audience: 'PAID' | 'ACTIVE' | 'CATEGORY',
  categoryId: string | null,
): Promise<number> {
  await requireAdmin(['EVENT_MANAGER']);
  if (!uuid.safeParse(eventId).success) return 0;
  // Server action arguments come from the client: validate them, the type is no guarantee.
  const parsedAudience = audienceSchema.safeParse(audience);
  if (!parsedAudience.success) return 0;
  const parsedCategory = categoryId === null ? null : uuid.safeParse(categoryId);
  if (parsedCategory && !parsedCategory.success) return 0;
  if (parsedAudience.data === 'CATEGORY' && !parsedCategory) return 0;
  return countMailingRecipients(getCore(), {
    eventId,
    audience: parsedAudience.data,
    categoryId: parsedCategory?.data ?? null,
  });
}
