import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps, tstz } from './_columns';
import { adminUsers } from './auth';
import { events, priceCategories } from './events';
import { orders } from './orders';
import { emailMessages } from './templates';

/**
 * Cancellation of an event with all its orders (admin "cancellation assistant"). The run is the
 * progress / audit record of the long job; the work itself is derived from the live order data
 * every pass, so a run can be resumed (or started again) at any time and never repeats a
 * cancellation. At most one RUNNING run per event.
 */
export const eventCancellationRuns = pgTable(
  'event_cancellation_runs',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    /** RUNNING | COMPLETED | COMPLETED_WITH_ERRORS */
    status: text('status').notNull().default('RUNNING'),
    refundFees: boolean('refund_fees').notNull().default(true),
    notify: boolean('notify').notNull().default(true),
    reason: text('reason'),
    startedByUserId: uuid('started_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    /** Orders found when the run started (preview numbers; informational). */
    totalOrders: integer('total_orders').notNull().default(0),
    cancelledOrders: integer('cancelled_orders').notNull().default(0),
    /** Orders that need a manual decision (unpaid multi-event orders, unpaid orders with money). */
    manualOrders: integer('manual_orders').notNull().default(0),
    failedOrders: integer('failed_orders').notNull().default(0),
    lastError: text('last_error'),
    heartbeatAt: tstz('heartbeat_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('event_cancellation_runs_one_running_uq')
      .on(t.eventId)
      .where(sql`${t.status} = 'RUNNING'`),
    index('event_cancellation_runs_event_idx').on(t.eventId, t.createdAt),
    check(
      'event_cancellation_runs_status_chk',
      sql`${t.status} IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS')`,
    ),
  ],
);

/**
 * Bulk e-mail to the buyers of an event (free text "EVENT_MESSAGE", or the postponement notice
 * "EVENT_POSTPONED"). Recipients are computed when the mailing is sent, in chunks; every
 * address (case-insensitive) is mailed at most once per mailing (`mailing_recipients` unique key
 * + the outbox row in the same transaction), so a resumed run never sends twice.
 */
export const eventMailings = pgTable(
  'event_mailings',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    /** EVENT_MESSAGE | EVENT_POSTPONED */
    kind: text('kind').notNull().default('EVENT_MESSAGE'),
    /** PAID | ACTIVE | CATEGORY */
    audience: text('audience').notNull(),
    categoryId: uuid('category_id').references(() => priceCategories.id, { onDelete: 'set null' }),
    subject: text('subject').notNull(),
    /** Plain text (the mail template turns it into HTML). */
    body: text('body').notNull(),
    /** RUNNING | COMPLETED */
    status: text('status').notNull().default('RUNNING'),
    recipientCount: integer('recipient_count').notNull().default(0),
    sentCount: integer('sent_count').notNull().default(0),
    createdByUserId: uuid('created_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    heartbeatAt: tstz('heartbeat_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
    ...timestamps(),
  },
  (t) => [
    index('event_mailings_event_idx').on(t.eventId, t.createdAt),
    index('event_mailings_running_idx')
      .on(t.status)
      .where(sql`${t.status} = 'RUNNING'`),
    check('event_mailings_status_chk', sql`${t.status} IN ('RUNNING', 'COMPLETED')`),
    check('event_mailings_kind_chk', sql`${t.kind} IN ('EVENT_MESSAGE', 'EVENT_POSTPONED')`),
    check('event_mailings_audience_chk', sql`${t.audience} IN ('PAID', 'ACTIVE', 'CATEGORY')`),
  ],
);

export const eventMailingRecipients = pgTable(
  'event_mailing_recipients',
  {
    id: id(),
    mailingId: uuid('mailing_id')
      .notNull()
      .references(() => eventMailings.id, { onDelete: 'cascade' }),
    /** sha256(lower(e-mail)) hex – the dedupe key (no address is kept here). */
    emailKey: text('email_key').notNull(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    messageId: uuid('message_id').references(() => emailMessages.id, { onDelete: 'set null' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('event_mailing_recipients_uq').on(t.mailingId, t.emailKey)],
);
