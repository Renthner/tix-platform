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
export const erasures = retainedSchema.table(
  'erasures',
  {
    customerId: uuid('customer_id').notNull(),
    scope: text('scope').notNull(),
    erasedAt: timestamp('erased_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('erasures_customer_scope_uq').on(t.customerId, t.scope)],
);
