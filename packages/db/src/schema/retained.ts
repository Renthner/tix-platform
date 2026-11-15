import { pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * Schema `retained` lives OUTSIDE `public` on purpose: it is excluded from backups and survives
 * a restore (which replaces `public`). Contains no personal data and no foreign keys.
 */
export const retainedSchema = pgSchema('retained');

/**
 * Erasure ledger (GDPR Art. 17): which customers were anonymised and when. After a restore
 * from an older backup the entries are replayed, so erased personal data never comes back.
 */
/**
 * Waiting-list entries removed on request (unsubscribe link, admin removal, customer erasure).
 * Only the entry id is kept – no personal data – so a restore from an older backup can delete the
 * entries again (`replayErasureLedger`).
 */
export const waitlistRemovals = retainedSchema.table('waitlist_removals', {
  entryId: uuid('entry_id').primaryKey(),
  removedAt: timestamp('removed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const erasures = retainedSchema.table(
  'erasures',
  {
    customerId: uuid('customer_id').notNull(),
    scope: text('scope').notNull(),
    erasedAt: timestamp('erased_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('erasures_customer_scope_uq').on(t.customerId, t.scope)],
);
