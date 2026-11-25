import { createHash } from 'node:crypto';
import {
  auditLogs,
  eventMailingRecipients,
  eventMailings,
  events,
  orderItems,
  orders,
  priceCategories,
  venues,
  withTransaction,
  type Executor,
} from '@tix/db';
import { and, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, requireCapability, type CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage } from '../email';
import { formatDateTime } from '../format';
import { QUEUE_NAMES } from '../job-queues';
import { coreLog } from '../log';
import { getSetting } from '../settings';
import { holderTicketUrls } from '../tickets/holder';
import { loadEventHolderRecipients } from './event-holders';
import { changeEventStatus } from './test-orders';

/**
 * Bulk e-mail to the buyers of an event: free-text messages (`EVENT_MESSAGE`, event tab
 * "Communication") and the postponement notice (`EVENT_POSTPONED`).
 *
 * Audiences: PAID = orders with paid, active tickets of the event; ACTIVE = additionally unpaid
 * orders that still hold tickets; CATEGORY = active tickets (paid or not) of one price category.
 * One mail per e-mail address (case-insensitive) and mailing, to the buyer's newest matching order
 * (so the mail's order link / locale make sense). Holders of passed-on tickets that fall in the
 * audience (CATEGORY: the ticket's category) are recipients too – deduplicated against buyers and
 * each other, without the order link (they get their ticket page). Test orders and box-office
 * sales without an address never receive anything.
 *
 * Sending is chunked and resumable: each recipient is claimed with an insert on
 * `event_mailing_recipients` (unique per mailing and address hash) in the same transaction as its
 * outbox row, so a crashed or repeated run never sends twice. The e-mail queue paces delivery.
 */

export const EVENT_MAILING_JOB = 'run-event-mailing';
export type EventMailingAudience = 'PAID' | 'ACTIVE' | 'CATEGORY';
export type EventMailingKind = 'EVENT_MESSAGE' | 'EVENT_POSTPONED';
const CHUNK = 50;
export const STALE_MAILING_AFTER_MS = 10 * 60 * 1000;

export interface MailingAudienceInput {
  eventId: string;
  audience: EventMailingAudience;
  categoryId?: string | null;
}

export interface MailingRecipient {
  email: string;
  /** Buyer: the order the mail links to. Holder: the source order (envelope only, never linked). */
  orderId: string;
  locale: string;
  /** Set for the holder of a passed-on ticket (gets the ticket page link instead of the order). */
  holder?: { ticketId: string; name: string | null };
}

/** Same rule as the outbox (`createEmailMessage` refuses anything else with INVALID_RECIPIENT). */
const emailAddress = z.email();

const emailKey = (email: string) =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

/** Distinct recipients (newest matching order per address). */
export async function loadMailingRecipients(
  db: Executor,
  input: MailingAudienceInput,
): Promise<MailingRecipient[]> {
  if (input.audience === 'CATEGORY' && !input.categoryId) {
    throw new DomainError('CATEGORY_REQUIRED', 'Choose a price category', 422);
  }
  const statuses =
    input.audience === 'PAID'
      ? (['PAID', 'PARTIALLY_REFUNDED'] as const)
      : (['PENDING', 'AWAITING_PAYMENT', 'PAID', 'PARTIALLY_REFUNDED'] as const);
  const rows = await db
    .selectDistinct({
      id: orders.id,
      email: orders.email,
      locale: orders.locale,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .innerJoin(
      orderItems,
      and(
        eq(orderItems.orderId, orders.id),
        eq(orderItems.eventId, input.eventId),
        input.audience === 'PAID'
          ? eq(orderItems.status, 'CONFIRMED')
          : inArray(orderItems.status, ['PENDING', 'CONFIRMED']),
        input.audience === 'CATEGORY'
          ? eq(orderItems.priceCategoryId, input.categoryId!)
          : undefined,
      ),
    )
    .where(
      and(eq(orders.isTest, false), isNotNull(orders.email), inArray(orders.status, [...statuses])),
    )
    .orderBy(desc(orders.createdAt), desc(orders.id));
  const seen = new Set<string>();
  const result: MailingRecipient[] = [];
  for (const row of rows) {
    const email = row.email!.trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    result.push({ email, orderId: row.id, locale: row.locale });
  }
  // Holders of passed-on tickets in the audience; an address that is already a buyer gets the
  // buyer version only.
  const holders = await loadEventHolderRecipients(db, {
    eventId: input.eventId,
    paidOnly: input.audience === 'PAID',
    categoryId: input.audience === 'CATEGORY' ? input.categoryId : null,
  });
  for (const h of holders) {
    const key = h.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      email: h.email,
      orderId: h.orderId,
      locale: h.locale,
      holder: { ticketId: h.ticketId, name: h.holderName },
    });
  }
  return result;
}

export async function countMailingRecipients(
  ctx: CoreContext,
  input: MailingAudienceInput,
): Promise<number> {
  return (await loadMailingRecipients(ctx.db, input)).length;
}

async function loadEventInfo(db: Executor, eventId: string) {
  const [row] = await db
    .select({
      id: events.id,
      title: events.title,
      startsAt: events.startsAt,
      timeZone: events.timeZone,
      postponedNewStartsAt: events.postponedNewStartsAt,
      postponementNote: events.postponementNote,
      venueName: venues.name,
      venueCity: venues.city,
    })
    .from(events)
    .innerJoin(venues, eq(venues.id, events.venueId))
    .where(eq(events.id, eventId));
  if (!row) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  return row;
}

type EventInfo = Awaited<ReturnType<typeof loadEventInfo>>;

function mailVariables(
  mailing: { kind: string; subject: string; body: string },
  event: EventInfo,
  locale: string,
) {
  const common = {
    eventTitle: event.title,
    eventDate: formatDateTime(event.startsAt, locale, event.timeZone),
    eventVenue: [event.venueName, event.venueCity].filter(Boolean).join(', '),
  };
  if (mailing.kind === 'EVENT_POSTPONED') {
    return {
      ...common,
      eventNewDate: event.postponedNewStartsAt
        ? formatDateTime(event.postponedNewStartsAt, locale, event.timeZone)
        : null,
      eventPostponementNote: mailing.body.trim() || null,
    };
  }
  return { ...common, messageSubject: mailing.subject, messageBody: mailing.body };
}

export interface CreateEventMailingParams extends MailingAudienceInput {
  kind?: EventMailingKind;
  subject: string;
  body: string;
  userId: string | null;
}

/** Creates the mailing (RUNNING) – the caller queues `EVENT_MAILING_JOB` afterwards. */
export async function createEventMailing(
  ctx: CoreContext,
  params: CreateEventMailingParams,
): Promise<{ mailingId: string; recipients: number }> {
  const subject = params.subject.trim();
  const body = params.body.trim();
  const kind = params.kind ?? 'EVENT_MESSAGE';
  if (kind === 'EVENT_MESSAGE' && (!subject || !body)) {
    throw new DomainError('MESSAGE_REQUIRED', 'Subject and text are required', 422);
  }
  await loadEventInfo(ctx.db, params.eventId);
  const recipients = await countMailingRecipients(ctx, params);
  if (recipients === 0) {
    throw new DomainError('NO_RECIPIENTS', 'No buyer matches the selected recipients', 409);
  }
  const [row] = await ctx.db
    .insert(eventMailings)
    .values({
      eventId: params.eventId,
      kind,
      audience: params.audience,
      categoryId: params.audience === 'CATEGORY' ? params.categoryId! : null,
      subject,
      body,
      recipientCount: recipients,
      createdByUserId: params.userId,
    })
    .returning({ id: eventMailings.id });
  await ctx.db.insert(auditLogs).values({
    actorType: params.userId ? 'ADMIN' : 'SYSTEM',
    actorUserId: params.userId,
    action: 'event.mailing.create',
    entityType: 'event',
    entityId: params.eventId,
    changes: null,
    metadata: { mailingId: row!.id, kind, audience: params.audience, recipients },
  });
  return { mailingId: row!.id, recipients };
}

export const eventMailingJobId = (mailingId: string) => `mailing-${mailingId}`;

/**
 * Queues the mailing under one stable job id: a job that is still waiting / in back-off / running
 * is left alone, a finished or failed one is replaced. Returns false when a live job exists.
 */
export async function enqueueEventMailing(ctx: CoreContext, mailingId: string): Promise<boolean> {
  const jobs = requireCapability(ctx, 'jobs');
  return jobs.addUnlessLive(
    QUEUE_NAMES.email,
    EVENT_MAILING_JOB,
    { mailingId },
    {
      jobId: eventMailingJobId(mailingId),
      attempts: 20,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  );
}

/**
 * Sweeper: re-queues RUNNING mailings without a heartbeat for a while whose job is gone (a job
 * that is only waiting in its retry back-off is not duplicated).
 */
export async function resumeStaleEventMailings(ctx: CoreContext): Promise<number> {
  const stale = await ctx.db
    .select({ id: eventMailings.id })
    .from(eventMailings)
    .where(
      and(
        eq(eventMailings.status, 'RUNNING'),
        lt(eventMailings.heartbeatAt, new Date(Date.now() - STALE_MAILING_AFTER_MS)),
      ),
    );
  let requeued = 0;
  for (const m of stale) {
    if (!(await enqueueEventMailing(ctx, m.id))) continue;
    await ctx.db
      .update(eventMailings)
      .set({ heartbeatAt: new Date() })
      .where(eq(eventMailings.id, m.id));
    requeued += 1;
  }
  return requeued;
}

/**
 * Queues the next chunk of mails. Returns how many were queued and how many recipients are left.
 */
export async function sendEventMailingChunk(
  ctx: CoreContext,
  mailingId: string,
  limit = CHUNK,
): Promise<{ queued: number; remaining: number }> {
  const [mailing] = await ctx.db
    .select()
    .from(eventMailings)
    .where(eq(eventMailings.id, mailingId));
  if (!mailing) throw new DomainError('MAILING_NOT_FOUND', 'Mailing not found', 404);
  if (mailing.status !== 'RUNNING') return { queued: 0, remaining: 0 };
  const event = await loadEventInfo(ctx.db, mailing.eventId);
  const recipients = await loadMailingRecipients(ctx.db, {
    eventId: mailing.eventId,
    audience: mailing.audience as EventMailingAudience,
    categoryId: mailing.categoryId,
  });
  const done = new Set(
    (
      await ctx.db
        .select({ key: eventMailingRecipients.emailKey })
        .from(eventMailingRecipients)
        .where(eq(eventMailingRecipients.mailingId, mailingId))
    ).map((r) => r.key),
  );
  const todo = recipients.filter((r) => !done.has(emailKey(r.email)));
  let queued = 0;
  for (const recipient of todo.slice(0, limit)) {
    // An unusable stored address (createEmailMessage would refuse it with INVALID_RECIPIENT) must
    // not abort the whole mailing: the recipient is claimed without a message (skipped).
    const deliverable = emailAddress.safeParse(recipient.email).success;
    const messageId = await withTransaction(ctx.db, async (tx) => {
      const [claimed] = await tx
        .insert(eventMailingRecipients)
        .values({ mailingId, emailKey: emailKey(recipient.email), orderId: recipient.orderId })
        .onConflictDoNothing()
        .returning({ id: eventMailingRecipients.id });
      if (!claimed) return null;
      if (!deliverable) {
        coreLog.warn(
          { mailingId, orderId: recipient.orderId },
          '[event-mailing] invalid recipient address, skipped',
        );
        return null;
      }
      const id = recipient.holder
        ? // Holder of a passed-on ticket: no order link / data (like the other holder mails, the
          // order id only goes into the envelope), the ticket page instead.
          await createEmailMessage(ctx, tx, {
            key: mailing.kind as EventMailingKind,
            to: recipient.email,
            eventId: mailing.eventId,
            locale: recipient.locale,
            sourceOrderId: recipient.orderId,
            variables: {
              ...mailVariables(mailing, event, recipient.locale),
              ticketHolder: 'yes',
              firstName: recipient.holder.name,
              ticketPageUrl:
                holderTicketUrls(ctx, { id: recipient.holder.ticketId }, recipient.locale)?.page ??
                null,
            },
          })
        : await createEmailMessage(ctx, tx, {
            key: mailing.kind as EventMailingKind,
            orderId: recipient.orderId,
            to: recipient.email,
            eventId: mailing.eventId,
            locale: recipient.locale,
            variables: mailVariables(mailing, event, recipient.locale),
          });
      await tx
        .update(eventMailingRecipients)
        .set({ messageId: id })
        .where(eq(eventMailingRecipients.id, claimed.id));
      return id;
    });
    if (messageId) {
      queued += 1;
      await dispatchEmailMessage(ctx, messageId).catch((err: unknown) =>
        coreLog.error({ err }, '[event-mailing] mail stored but not queued (outbox retries)'),
      );
    }
  }
  const remaining = Math.max(todo.length - Math.min(todo.length, limit), 0);
  await ctx.db
    .update(eventMailings)
    .set({
      sentCount: sql`${eventMailings.sentCount} + ${queued}`,
      heartbeatAt: new Date(),
      ...(remaining === 0 ? { status: 'COMPLETED', finishedAt: new Date() } : {}),
    })
    .where(eq(eventMailings.id, mailingId));
  return { queued, remaining };
}

/** Sends all chunks of the mailing (the worker job). */
export async function runEventMailing(ctx: CoreContext, mailingId: string): Promise<number> {
  let total = 0;
  for (;;) {
    const { queued, remaining } = await sendEventMailingChunk(ctx, mailingId);
    total += queued;
    if (remaining === 0) return total;
  }
}

/** One test mail of the (not yet saved) message to the admin's own address. */
export async function sendEventMailingTest(
  ctx: CoreContext,
  params: {
    eventId: string;
    subject: string;
    body: string;
    to: string;
    locale?: string;
    /** Marks the subject as a test (translated by the caller, e.g. "[TEST] "). */
    subjectPrefix?: string;
  },
): Promise<{ messageId: string }> {
  const event = await loadEventInfo(ctx.db, params.eventId);
  const general = await getSetting(ctx, 'general');
  const locale = params.locale ?? general.defaultLocale;
  const messageId = await createEmailMessage(ctx, ctx.db, {
    key: 'EVENT_MESSAGE',
    to: params.to,
    eventId: params.eventId,
    locale,
    variables: {
      ...mailVariables(
        {
          kind: 'EVENT_MESSAGE',
          subject: `${params.subjectPrefix ?? ''}${params.subject.trim()}`,
          body: params.body,
        },
        event,
        locale,
      ),
      orderNumber: '—',
    },
  });
  await dispatchEmailMessage(ctx, messageId);
  return { messageId };
}

export interface PostponeEventParams {
  eventId: string;
  /** Announced new date (informational; the real date is changed in the event details). */
  newStartsAt?: Date | null;
  note?: string | null;
  notify: boolean;
  userId: string;
}

/**
 * POSTPONED: the event stays on sale, tickets stay valid. Optionally mails every buyer (also
 * unpaid orders) the new date and a note.
 */
export async function postponeEvent(
  ctx: CoreContext,
  params: PostponeEventParams,
): Promise<{ mailingId: string | null; recipients: number }> {
  await changeEventStatus(ctx, { eventId: params.eventId, status: 'POSTPONED' });
  await ctx.db
    .update(events)
    .set({
      postponedNewStartsAt: params.newStartsAt ?? null,
      postponementNote: params.note?.trim() || null,
    })
    .where(eq(events.id, params.eventId));
  if (!params.notify) return { mailingId: null, recipients: 0 };
  const recipients = await countMailingRecipients(ctx, {
    eventId: params.eventId,
    audience: 'ACTIVE',
  });
  if (recipients === 0) return { mailingId: null, recipients: 0 };
  const created = await createEventMailing(ctx, {
    eventId: params.eventId,
    kind: 'EVENT_POSTPONED',
    audience: 'ACTIVE',
    subject: '',
    body: params.note?.trim() ?? '',
    userId: params.userId,
  });
  return { mailingId: created.mailingId, recipients: created.recipients };
}

export interface EventMailingView {
  id: string;
  kind: string;
  audience: string;
  subject: string;
  status: string;
  recipientCount: number;
  sentCount: number;
  createdAt: Date;
}

export async function listEventMailings(
  db: Executor,
  eventId: string,
): Promise<EventMailingView[]> {
  return db
    .select({
      id: eventMailings.id,
      kind: eventMailings.kind,
      audience: eventMailings.audience,
      subject: eventMailings.subject,
      status: eventMailings.status,
      recipientCount: eventMailings.recipientCount,
      sentCount: eventMailings.sentCount,
      createdAt: eventMailings.createdAt,
    })
    .from(eventMailings)
    .where(eq(eventMailings.eventId, eventId))
    .orderBy(desc(eventMailings.createdAt))
    .limit(20);
}

/** Price categories of an event for the audience filter. */
export async function listMailingCategories(db: Executor, eventId: string) {
  return db
    .select({ id: priceCategories.id, name: priceCategories.name })
    .from(priceCategories)
    .where(eq(priceCategories.eventId, eventId))
    .orderBy(priceCategories.name);
}
