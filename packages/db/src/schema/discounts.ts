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
import { cents, createdAt, id, timestamps, tstz } from './_columns';
import { adminUsers } from './auth';
import { discountCodeTypeEnum } from './enums';
import { orders } from './orders';

/**
 * Discount codes (promo codes), entered by the customer in the cart / checkout.
 * Not to be confused with `access_codes` (presale / VIP access to an event).
 *
 * `value` is cents for FIXED (per order) and basis points for PERCENT. Scope lists are plain
 * uuid arrays (empty = unrestricted; `all_events` = every event); ids of deleted events or
 * categories simply never match. Usage is never stored in a counter: it is counted from
 * `order_discounts` of active, non-test orders, so cancelled / expired orders release it
 * automatically; the code row is locked FOR UPDATE while an order is placed (see checkout).
 */
export const discountCodes = pgTable(
  'discount_codes',
  {
    id: id(),
    /** Normalised upper-case code (unique, case-insensitive for the customer). */
    code: text('code').notNull(),
    type: discountCodeTypeEnum('type').notNull(),
    value: integer('value').notNull(),
    allEvents: boolean('all_events').notNull().default(true),
    eventIds: uuid('event_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    categoryIds: uuid('category_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    ticketTypeIds: uuid('ticket_type_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    validFrom: tstz('valid_from'),
    validUntil: tstz('valid_until'),
    maxTotalUses: integer('max_total_uses'),
    maxUsesPerEmail: integer('max_uses_per_email'),
    /** Minimum value of the eligible tickets (cents). */
    minOrderValue: cents('min_order_value'),
    /** Also discount the fees (proportional share of the fee lines). */
    discountFees: boolean('discount_fees').notNull().default(false),
    /** May be combined with other codes in one order (default: one code per order). */
    stackable: boolean('stackable').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    /** Internal note (never shown to customers). */
    note: text('note'),
    /** Codes created together by the bulk generator. */
    batchId: uuid('batch_id'),
    createdByUserId: uuid('created_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('discount_codes_code_uq').on(t.code),
    index('discount_codes_batch_idx')
      .on(t.batchId)
      .where(sql`${t.batchId} IS NOT NULL`),
    check('discount_codes_code_format', sql`${t.code} ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'`),
    check(
      'discount_codes_value',
      sql`${t.value} > 0 AND (${t.type} <> 'PERCENT' OR ${t.value} <= 10000)`,
    ),
    check(
      'discount_codes_limits',
      sql`(${t.maxTotalUses} IS NULL OR ${t.maxTotalUses} > 0)
        AND (${t.maxUsesPerEmail} IS NULL OR ${t.maxUsesPerEmail} > 0)
        AND (${t.minOrderValue} IS NULL OR ${t.minOrderValue} >= 0)`,
    ),
    check(
      'discount_codes_validity',
      sql`${t.validFrom} IS NULL OR ${t.validUntil} IS NULL OR ${t.validFrom} < ${t.validUntil}`,
    ),
  ],
);

/**
 * A discount code used by an order (snapshot of the code, the order keeps its discount even if
 * the code is edited later). `amount` is the whole discount of this code in cents (tickets and
 * the discounted share of fees); `fee_amount` is the part that went to fee lines.
 */
export const orderDiscounts = pgTable(
  'order_discounts',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    discountCodeId: uuid('discount_code_id')
      .notNull()
      .references(() => discountCodes.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    type: discountCodeTypeEnum('type').notNull(),
    value: integer('value').notNull(),
    amount: cents('amount').notNull(),
    feeAmount: cents('fee_amount').notNull().default(0),
    /** Order in which the codes were applied (stacking). */
    position: integer('position').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('order_discounts_order_code_uq').on(t.orderId, t.discountCodeId),
    index('order_discounts_code_idx').on(t.discountCodeId),
    check(
      'order_discounts_amounts',
      sql`${t.amount} > 0 AND ${t.feeAmount} >= 0 AND ${t.feeAmount} <= ${t.amount}`,
    ),
  ],
);
