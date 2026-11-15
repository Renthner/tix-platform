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
import { events, priceCategories } from './events';

/**
 * Waiting list of an event ("notify me when tickets are available again"). Double opt-in: an
 * entry only counts (`confirmed_at`) after the address owner clicked the confirmation link.
 * One entry per event and e-mail address (case-insensitive).
 *
 * `armed` implements "at most one notification per availability wave": a confirmed entry that
 * is armed and matches the current availability is notified and disarmed; it is armed again
 * once its area is sold out again (see core `evaluateWaitlist`).
 *
 * Personal data (e-mail, first name) is deleted with the event (cascade), by the retention job
 * after the event started, on unsubscribe and with the customer erasure (GDPR).
 */
export const waitlistEntries = pgTable(
  'waitlist_entries',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    firstName: text('first_name'),
    /** Wanted price category; NULL = any. Cleared when the category is deleted. */
    categoryId: uuid('category_id').references(() => priceCategories.id, { onDelete: 'set null' }),
    /** Number of tickets wanted: notified only when at least that many are available. */
    quantity: integer('quantity').notNull().default(2),
    /** Language of the e-mails. */
    locale: text('locale').notNull(),
    /** Opt-in proof: moment the address owner confirmed. NULL = confirmation pending. */
    confirmedAt: tstz('confirmed_at'),
    confirmationSentAt: tstz('confirmation_sent_at'),
    armed: boolean('armed').notNull().default(true),
    lastNotifiedAt: tstz('last_notified_at'),
    notifiedCount: integer('notified_count').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('waitlist_entries_event_email_uq').on(t.eventId, sql`lower(${t.email})`),
    index('waitlist_entries_event_idx').on(t.eventId, t.confirmedAt),
    index('waitlist_entries_email_idx').on(sql`lower(${t.email})`),
    check('waitlist_entries_quantity_range', sql`${t.quantity} BETWEEN 1 AND 50`),
  ],
);
