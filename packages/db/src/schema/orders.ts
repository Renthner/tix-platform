import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  inet,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { PartySnapshot, PostalAddress, TaxBreakdownEntry } from '@tix/shared';
import { basisPoints, cents, createdAt, currency, id, timestamps, tstz } from './_columns';
import { adminUsers } from './auth';
import {
  actorTypeEnum,
  adjustmentKindEnum,
  adjustmentStatusEnum,
  checkInStateEnum,
  customerTokenPurposeEnum,
  feeScopeEnum,
  invoiceTypeEnum,
  orderItemKindEnum,
  orderItemStatusEnum,
  orderStatusEnum,
  paymentMethodEnum,
  paymentStatusEnum,
  refundKindEnum,
  refundStatusEnum,
  salesChannelEnum,
  ticketStatusEnum,
  webhookEventStatusEnum,
} from './enums';
import {
  accessCodes,
  eventSigningKeys,
  events,
  fees,
  priceCategories,
  ticketTypes,
} from './events';
import { bankTransactions } from './banking';
import { scannerDevices } from './checkin';
import { seatMapSections, seats } from './venues';

/**
 * Customers. Exactly one record per e-mail address (case-insensitive).
 *
 * - Guest checkout creates/updates the record without a password.
 * - A customer *account* exists once `password_hash` is set. Because guest orders are
 *   already linked by e-mail, registering makes all earlier orders of that address visible –
 *   therefore orders are only shown after `email_verified_at` proves address ownership.
 * Orders keep their own buyer snapshot; editing the profile never alters past orders.
 */
export const customers = pgTable(
  'customers',
  {
    id: id(),
    email: text('email').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    company: text('company'),
    phone: text('phone'),
    address: jsonb('address').$type<PostalAddress>(),
    locale: text('locale'),
    marketingConsentAt: tstz('marketing_consent_at'),

    // ── Optional customer account ──────────────────────────────────────────
    /** Argon2id PHC string; NULL = guest without account. */
    passwordHash: text('password_hash'),
    accountCreatedAt: tstz('account_created_at'),
    emailVerifiedAt: tstz('email_verified_at'),
    lastLoginAt: tstz('last_login_at'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: tstz('locked_until'),

    /** GDPR erasure: personal data replaced, row kept for accounting references. */
    anonymizedAt: tstz('anonymized_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('customers_email_uq').on(sql`lower(${t.email})`),
    index('customers_name_trgm_idx').using(
      'gin',
      sql`(${t.firstName} || ' ' || ${t.lastName}) gin_trgm_ops`,
    ),
    check(
      'customers_account_created',
      sql`${t.passwordHash} IS NULL OR ${t.accountCreatedAt} IS NOT NULL`,
    ),
    check('customers_failed_login_count_nonneg', sql`${t.failedLoginCount} >= 0`),
  ],
);

/** Server-side customer account sessions (only the SHA-256 of the token is stored). */
export const customerSessions = pgTable(
  'customer_sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    expiresAt: tstz('expires_at').notNull(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    /** Set for sessions created by linking a signed-in admin (revoked with the admin's access). */
    linkedAdminUserId: uuid('linked_admin_user_id').references(() => adminUsers.id, {
      onDelete: 'cascade',
    }),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    index('customer_sessions_customer_idx').on(t.customerId),
    index('customer_sessions_expires_idx').on(t.expiresAt),
  ],
);

/** Single-use tokens for e-mail verification, password reset and passwordless login links. */
export const customerTokens = pgTable(
  'customer_tokens',
  {
    id: id(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    purpose: customerTokenPurposeEnum('purpose').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('customer_tokens_hash_uq').on(t.tokenHash),
    index('customer_tokens_customer_idx').on(t.customerId, t.purpose),
    index('customer_tokens_expires_idx').on(t.expiresAt),
  ],
);

/**
 * Orders. One order can contain tickets for several events (multi-event cart); the event
 * is therefore stored per `order_items` row, not on the order. All amounts are integer
 * cents, gross (B2C pricing) with the net/tax split persisted for invoicing. CHECK
 * constraints keep the totals arithmetically consistent. All items share `currency`.
 */
export const orders = pgTable(
  'orders',
  {
    id: id(),
    /** Human-readable, sequential order number (pattern from `invoicing` settings). */
    orderNumber: text('order_number').notNull(),
    /** NULL only for box-office / admin orders without buyer data (see orders_online_has_buyer). */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    status: orderStatusEnum('status').notNull(),
    channel: salesChannelEnum('channel').notNull(),
    paymentMethod: paymentMethodEnum('payment_method').notNull(),

    // ── Buyer snapshot (anonymous box-office sales: email NULL, names empty) ──
    email: text('email'),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    company: text('company'),
    phone: text('phone'),
    billingAddress: jsonb('billing_address').$type<PostalAddress>(),
    locale: text('locale').notNull(),

    // ── Money ──────────────────────────────────────────────────────────────
    currency: currency().notNull(),
    /** Σ item list prices before discounts. */
    subtotalGross: cents('subtotal_gross').notNull(),
    discountTotal: cents('discount_total').notNull().default(0),
    feeTotal: cents('fee_total').notNull().default(0),
    totalGross: cents('total_gross').notNull(),
    totalNet: cents('total_net').notNull(),
    totalTax: cents('total_tax').notNull(),
    amountPaid: cents('amount_paid').notNull().default(0),
    amountRefunded: cents('amount_refunded').notNull().default(0),

    // ── Vorkasse / dunning ─────────────────────────────────────────────────
    /** Verwendungszweck with Luhn check digit, e.g. TIX-2026-8492-7. */
    paymentReference: text('payment_reference'),
    paymentDueAt: tstz('payment_due_at'),
    nextReminderAt: tstz('next_reminder_at'),
    reminderCount: integer('reminder_count').notNull().default(0),
    lastReminderAt: tstz('last_reminder_at'),
    /** Cancel-after date for unpaid Vorkasse orders (skipped while keep_reserved). */
    autoCancelAt: tstz('auto_cancel_at'),
    keepReserved: boolean('keep_reserved').notNull().default(false),
    keepReservedReason: text('keep_reserved_reason'),
    keepReservedByUserId: uuid('keep_reserved_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),

    // ── Context ────────────────────────────────────────────────────────────
    /** Redis cart session that held the seat locks when the order was created. */
    cartSessionId: text('cart_session_id'),
    termsAcceptedAt: tstz('terms_accepted_at'),
    customerNote: text('customer_note'),
    internalNote: text('internal_note'),
    createdByUserId: uuid('created_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    ipAddress: inet('ip_address'),

    paidAt: tstz('paid_at'),
    /** Incremented whenever a bank allocation reversal undoes a payment: tells paid cycles apart. */
    paidCycle: integer('paid_cycle').notNull().default(0),
    cancelledAt: tstz('cancelled_at'),
    expiredAt: tstz('expired_at'),
    cancellationReason: text('cancellation_reason'),
    /** Optimistic concurrency token for admin edits. */
    version: integer('version').notNull().default(1),
    /** GDPR erasure: contact data of this order was replaced (see `customers/privacy.ts`). */
    anonymizedAt: tstz('anonymized_at'),
    /**
     * Set when the customer was anonymised while invoices still bind the order's billing data
     * (GoBD): name, company and billing address stay until this date, then the retention job
     * erases them. NULL = nothing retained.
     */
    personalDataRetainedUntil: tstz('personal_data_retained_until'),
    ...timestamps(),
  },
  (t) => [
    index('orders_retention_idx')
      .on(t.personalDataRetainedUntil)
      .where(sql`${t.personalDataRetainedUntil} IS NOT NULL`),
    unique('orders_order_number_uq').on(t.orderNumber),
    unique('orders_payment_reference_uq').on(t.paymentReference),
    index('orders_status_created_idx').on(t.status, t.createdAt),
    index('orders_email_idx').on(sql`lower(${t.email})`),
    index('orders_customer_idx').on(t.customerId),
    index('orders_created_idx').on(t.createdAt),
    index('orders_paid_at_idx')
      .on(t.paidAt)
      .where(sql`${t.paidAt} IS NOT NULL`),
    index('orders_awaiting_due_idx')
      .on(t.autoCancelAt)
      .where(sql`${t.status} = 'AWAITING_PAYMENT'`),
    index('orders_awaiting_reminder_idx')
      .on(t.nextReminderAt)
      .where(sql`${t.status} = 'AWAITING_PAYMENT'`),
    index('orders_pending_created_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'PENDING'`),
    index('orders_name_trgm_idx').using(
      'gin',
      sql`(${t.firstName} || ' ' || ${t.lastName}) gin_trgm_ops`,
    ),
    check(
      'orders_online_has_buyer',
      sql`${t.channel} <> 'ONLINE' OR (${t.customerId} IS NOT NULL AND ${t.email} IS NOT NULL)`,
    ),
    check('orders_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'orders_payment_reference_format',
      sql`${t.paymentReference} IS NULL OR ${t.paymentReference} ~ '^[A-Z]{2,6}-[0-9]{4}-[0-9]{4,10}-[0-9]$'`,
    ),
    check(
      'orders_amounts_nonneg',
      sql`${t.subtotalGross} >= 0 AND ${t.discountTotal} >= 0 AND ${t.feeTotal} >= 0
        AND ${t.totalGross} >= 0 AND ${t.totalNet} >= 0 AND ${t.totalTax} >= 0
        AND ${t.amountPaid} >= 0 AND ${t.amountRefunded} >= 0`,
    ),
    check(
      'orders_total_consistent',
      sql`${t.totalGross} = ${t.subtotalGross} - ${t.discountTotal} + ${t.feeTotal}`,
    ),
    check('orders_tax_split_consistent', sql`${t.totalGross} = ${t.totalNet} + ${t.totalTax}`),
    check('orders_refund_le_paid', sql`${t.amountRefunded} <= ${t.amountPaid}`),
    check(
      'orders_paid_at',
      sql`${t.status} NOT IN ('PAID','REFUNDED','PARTIALLY_REFUNDED') OR ${t.paidAt} IS NOT NULL`,
    ),
    check('orders_cancelled_at', sql`${t.status} <> 'CANCELLED' OR ${t.cancelledAt} IS NOT NULL`),
    check('orders_expired_at', sql`${t.status} <> 'EXPIRED' OR ${t.expiredAt} IS NOT NULL`),
    check(
      'orders_awaiting_has_terms',
      sql`${t.status} <> 'AWAITING_PAYMENT' OR (${t.paymentReference} IS NOT NULL AND ${t.paymentDueAt} IS NOT NULL)`,
    ),
    check('orders_reminder_count_nonneg', sql`${t.reminderCount} >= 0`),
    check('orders_version_positive', sql`${t.version} > 0`),
  ],
);

/**
 * One row per admitted person (seat or GA spot) – for any event of the order.
 * Price/label fields are snapshots.
 *
 * Tariff selection: customers first pick seats; the ticket type (normal / reduced …) is
 * chosen per seat in the cart and stored in `ticket_type_id` at checkout. Proof of
 * eligibility is checked at the door (scanner warning), never during purchase.
 *
 * DOUBLE-BOOKING GUARD: `order_items_active_seat_uq` is a partial unique index on
 * `seat_id` over PENDING/CONFIRMED items. Even if the Redis lock layer were bypassed,
 * PostgreSQL rejects a second active item for the same seat (SQLSTATE 23505).
 */
export const orderItems = pgTable(
  'order_items',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references((): AnyPgColumn => events.id, { onDelete: 'restrict' }),
    kind: orderItemKindEnum('kind').notNull(),
    seatId: uuid('seat_id').references((): AnyPgColumn => seats.id, { onDelete: 'restrict' }),
    sectionId: uuid('section_id')
      .notNull()
      .references((): AnyPgColumn => seatMapSections.id, { onDelete: 'restrict' }),
    priceCategoryId: uuid('price_category_id')
      .notNull()
      .references((): AnyPgColumn => priceCategories.id, { onDelete: 'restrict' }),
    ticketTypeId: uuid('ticket_type_id')
      .notNull()
      .references((): AnyPgColumn => ticketTypes.id, { onDelete: 'restrict' }),
    status: orderItemStatusEnum('status').notNull(),
    /** VIP/presale code that unlocked this item (codes are event-scoped). */
    accessCodeId: uuid('access_code_id').references((): AnyPgColumn => accessCodes.id, {
      onDelete: 'set null',
    }),

    // ── Snapshots ──────────────────────────────────────────────────────────
    sectionLabel: text('section_label').notNull(),
    rowLabel: text('row_label'),
    seatLabel: text('seat_label'),
    entranceLabel: text('entrance_label'),
    categoryName: text('category_name').notNull(),
    ticketTypeName: text('ticket_type_name').notNull(),
    unitPriceGross: cents('unit_price_gross').notNull(),
    discountAmount: cents('discount_amount').notNull().default(0),
    priceGross: cents('price_gross').notNull(),
    taxRateBasisPoints: basisPoints('tax_rate_basis_points').notNull(),
    priceNet: cents('price_net').notNull(),
    taxAmount: cents('tax_amount').notNull(),

    attendeeName: text('attendee_name'),
    cancelledAt: tstz('cancelled_at'),
    refundedAt: tstz('refunded_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('order_items_active_seat_uq')
      .on(t.seatId)
      .where(sql`${t.seatId} IS NOT NULL AND ${t.status} IN ('PENDING','CONFIRMED')`),
    index('order_items_order_idx').on(t.orderId),
    index('order_items_event_status_idx').on(t.eventId, t.status),
    index('order_items_section_idx').on(t.sectionId),
    index('order_items_category_idx').on(t.priceCategoryId),
    index('order_items_access_code_idx')
      .on(t.accessCodeId)
      .where(sql`${t.accessCodeId} IS NOT NULL`),
    check('order_items_kind_seat', sql`(${t.kind} = 'SEAT') = (${t.seatId} IS NOT NULL)`),
    check(
      'order_items_amounts_nonneg',
      sql`${t.unitPriceGross} >= 0 AND ${t.discountAmount} >= 0 AND ${t.priceGross} >= 0
        AND ${t.priceNet} >= 0 AND ${t.taxAmount} >= 0`,
    ),
    check(
      'order_items_price_consistent',
      sql`${t.priceGross} = ${t.unitPriceGross} - ${t.discountAmount}`,
    ),
    check('order_items_tax_split', sql`${t.priceGross} = ${t.priceNet} + ${t.taxAmount}`),
    check('order_items_tax_rate_range', sql`${t.taxRateBasisPoints} BETWEEN 0 AND 10000`),
  ],
);

/**
 * Fee lines of an order (snapshot of the effective `fees` at checkout).
 * `event_id` is set for PER_TICKET / PER_EVENT fees and NULL for PER_ORDER fees.
 */
export const orderFees = pgTable(
  'order_fees',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').references((): AnyPgColumn => events.id, { onDelete: 'restrict' }),
    feeId: uuid('fee_id').references((): AnyPgColumn => fees.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    scope: feeScopeEnum('scope').notNull(),
    quantity: integer('quantity').notNull(),
    unitAmountGross: cents('unit_amount_gross').notNull(),
    totalGross: cents('total_gross').notNull(),
    taxRateBasisPoints: basisPoints('tax_rate_basis_points').notNull(),
    totalNet: cents('total_net').notNull(),
    totalTax: cents('total_tax').notNull(),
    isRefunded: boolean('is_refunded').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('order_fees_order_idx').on(t.orderId),
    check('order_fees_quantity_positive', sql`${t.quantity} > 0`),
    check('order_fees_event_scope', sql`(${t.scope} = 'PER_ORDER') = (${t.eventId} IS NULL)`),
    check(
      'order_fees_amounts',
      sql`${t.unitAmountGross} >= 0 AND ${t.totalGross} >= 0 AND ${t.totalNet} >= 0 AND ${t.totalTax} >= 0
        AND ${t.totalGross} = ${t.totalNet} + ${t.totalTax}`,
    ),
  ],
);

/**
 * Monotonic change counter for ticket rows. Android scanners pull deltas with
 * `sync_version > lastSeen`; a trigger (migration 0002) bumps it on every UPDATE.
 */
export const ticketSyncVersionSeq = pgSequence('ticket_sync_version_seq', {
  startWith: 1,
  increment: 1,
});

/**
 * Issued tickets. One VALID ticket per order item; re-issuing (seat change, name change)
 * marks the old ticket REPLACED and creates a new one with a fresh signature.
 */
export const tickets = pgTable(
  'tickets',
  {
    id: id(),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references((): AnyPgColumn => events.id, { onDelete: 'restrict' }),
    /** Short human code for manual lookup at the door / support. */
    ticketCode: text('ticket_code').notNull(),
    status: ticketStatusEnum('status').notNull().default('VALID'),
    signingKeyId: uuid('signing_key_id')
      .notNull()
      .references((): AnyPgColumn => eventSigningKeys.id, { onDelete: 'restrict' }),
    /** Full signed QR content, see docs/TICKETS.md (tix://v1/{keyId}.{eventId}.{ticketId}.{seatInfo}.{signature}). */
    qrPayload: text('qr_payload').notNull(),
    attendeeName: text('attendee_name'),
    pdfObjectKey: text('pdf_object_key'),
    pkpassObjectKey: text('pkpass_object_key'),
    googleWalletObjectId: text('google_wallet_object_id'),

    // ── Check-in state (denormalised from check_in_logs for O(1) scanner lookups) ──
    checkInState: checkInStateEnum('check_in_state').notNull().default('NONE'),
    firstCheckedInAt: tstz('first_checked_in_at'),
    firstCheckedInDeviceId: uuid('first_checked_in_device_id').references(
      (): AnyPgColumn => scannerDevices.id,
      { onDelete: 'set null' },
    ),
    lastScanAt: tstz('last_scan_at'),
    checkInCount: integer('check_in_count').notNull().default(0),

    issuedAt: tstz('issued_at').notNull().defaultNow(),
    voidedAt: tstz('voided_at'),
    replacedByTicketId: uuid('replaced_by_ticket_id').references((): AnyPgColumn => tickets.id, {
      onDelete: 'set null',
    }),
    syncVersion: bigint('sync_version', { mode: 'number' })
      .notNull()
      .default(sql`nextval('ticket_sync_version_seq')`),
    ...timestamps(),
  },
  (t) => [
    unique('tickets_ticket_code_uq').on(t.ticketCode),
    uniqueIndex('tickets_single_valid_per_item_uq')
      .on(t.orderItemId)
      .where(sql`${t.status} = 'VALID'`),
    index('tickets_order_idx').on(t.orderId),
    index('tickets_event_sync_idx').on(t.eventId, t.syncVersion),
    index('tickets_attendee_trgm_idx').using('gin', sql`${t.attendeeName} gin_trgm_ops`),
    check('tickets_void_consistency', sql`(${t.status} = 'VALID') = (${t.voidedAt} IS NULL)`),
    check(
      'tickets_check_in_consistency',
      sql`${t.checkInState} = 'NONE' OR ${t.firstCheckedInAt} IS NOT NULL`,
    ),
    check('tickets_check_in_count_nonneg', sql`${t.checkInCount} >= 0`),
  ],
);

/** Payment attempts/receipts (PayPal captures, bank transfers, box-office cash/card). */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    method: paymentMethodEnum('method').notNull(),
    status: paymentStatusEnum('status').notNull(),
    amount: cents('amount').notNull(),
    currency: currency().notNull(),
    /** PayPal order id. */
    providerOrderId: text('provider_order_id'),
    /** PayPal capture id. */
    providerCaptureId: text('provider_capture_id'),
    bankTransactionId: uuid('bank_transaction_id').references(
      (): AnyPgColumn => bankTransactions.id,
      { onDelete: 'restrict' },
    ),
    /** Set when the money pays an additional-payment request (`order_adjustments`), not the order itself. */
    adjustmentId: uuid('adjustment_id').references((): AnyPgColumn => orderAdjustments.id, {
      onDelete: 'restrict',
    }),
    receivedByUserId: uuid('received_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    providerResponse: jsonb('provider_response'),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    capturedAt: tstz('captured_at'),
    ...timestamps(),
  },
  (t) => [
    index('payments_order_idx').on(t.orderId),
    uniqueIndex('payments_provider_order_uq')
      .on(t.method, t.providerOrderId)
      .where(sql`${t.providerOrderId} IS NOT NULL`),
    uniqueIndex('payments_provider_capture_uq')
      .on(t.providerCaptureId)
      .where(sql`${t.providerCaptureId} IS NOT NULL`),
    index('payments_bank_tx_idx').on(t.bankTransactionId),
    index('payments_adjustment_idx')
      .on(t.adjustmentId)
      .where(sql`${t.adjustmentId} IS NOT NULL`),
    check('payments_amount_nonneg', sql`${t.amount} >= 0`),
    check('payments_captured_at', sql`${t.status} <> 'CAPTURED' OR ${t.capturedAt} IS NOT NULL`),
  ],
);

/** One ticket of an adjustment: old and new tariff with the prices (gross, cents). */
export interface AdjustmentItemSnapshot {
  orderItemId: string;
  /** Price category of the ticket when proposed (a seat change to another category invalidates it). */
  fromPriceCategoryId: string;
  fromTicketTypeId: string;
  toTicketTypeId: string;
  fromName: string;
  toName: string;
  fromPriceGross: number;
  toPriceGross: number;
}

/**
 * Additional payment for a PAID order (tariff upgrade, e.g. reduced → normal). While it is open
 * (PROPOSED / CONFIRMED) the order, its items and tickets stay untouched; only the payment of
 * the adjustment (`payments.adjustment_id`) applies the new tariffs, re-issues the tickets and
 * corrects the invoice. At most one open adjustment per order. Cancelling resets everything.
 */
export const orderAdjustments = pgTable(
  'order_adjustments',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    status: adjustmentStatusEnum('status').notNull().default('PROPOSED'),
    kind: adjustmentKindEnum('kind').notNull().default('TARIFF_UPGRADE'),
    /**
     * Cash still to pay for the adjustment (cents). 0 = settled completely by credit (the order
     * was overpaid); `amount + credit_applied` is the price difference of the changed tickets.
     */
    amount: cents('amount').notNull(),
    /** Overpayment of the order credited against the price difference (cents). */
    creditApplied: cents('credit_applied').notNull().default(0),
    currency: currency().notNull(),
    /** Own Verwendungszweck (same format as orders, unique across orders and adjustments). */
    paymentReference: text('payment_reference').notNull(),
    items: jsonb('items').$type<AdjustmentItemSnapshot[]>().notNull(),
    reason: text('reason'),
    createdByUserId: uuid('created_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    confirmedAt: tstz('confirmed_at'),
    reminderSentAt: tstz('reminder_sent_at'),
    paidAt: tstz('paid_at'),
    cancelledAt: tstz('cancelled_at'),
    cancelledBy: text('cancelled_by'),
    ...timestamps(),
  },
  (t) => [
    unique('order_adjustments_payment_reference_uq').on(t.paymentReference),
    index('order_adjustments_order_idx').on(t.orderId),
    uniqueIndex('order_adjustments_one_open_uq')
      .on(t.orderId)
      .where(sql`${t.status} IN ('PROPOSED','CONFIRMED')`),
    index('order_adjustments_open_idx')
      .on(t.createdAt)
      .where(sql`${t.status} IN ('PROPOSED','CONFIRMED')`),
    check('order_adjustments_amount_nonneg', sql`${t.amount} >= 0`),
    check('order_adjustments_credit_nonneg', sql`${t.creditApplied} >= 0`),
    check('order_adjustments_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'order_adjustments_reference_format',
      sql`${t.paymentReference} ~ '^[A-Z]{2,6}-[0-9]{4}-[0-9]{4,10}-[0-9]$'`,
    ),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'restrict' }),
    method: paymentMethodEnum('method').notNull(),
    /**
     * AUTOMATIC = executed through the provider API (PayPal capture refund); MANUAL = "Erstattung
     * offen" to-do – somebody transfers the money and marks it done (bank transfer, cash, card).
     */
    kind: refundKindEnum('kind').notNull().default('AUTOMATIC'),
    status: refundStatusEnum('status').notNull().default('PENDING'),
    /**
     * All refund rows created by one cancellation / overpayment refund share a batch (one amount
     * and one credit note for the admin); PayPal needs one row per capture. Default: own batch.
     */
    batchId: uuid('batch_id').notNull().defaultRandom(),
    /** Pays back an overpayment (no order items / fees, no credit note); counts as refunded money. */
    overpayment: boolean('overpayment').notNull().default(false),
    amount: cents('amount').notNull(),
    currency: currency().notNull(),
    reason: text('reason'),
    /** PayPal request-id generation: a retry after a definite provider failure starts a new one. */
    attempt: integer('attempt').notNull().default(1),
    /** Whether the admin chose to refund service fees with this cancellation. */
    refundFees: boolean('refund_fees').notNull().default(false),
    /** Payer account snapshot (from the bank transaction of the payment) for manual refunds. */
    payerIban: text('payer_iban'),
    payerName: text('payer_name'),
    providerRefundId: text('provider_refund_id'),
    creditNoteId: uuid('credit_note_id').references((): AnyPgColumn => invoices.id, {
      onDelete: 'restrict',
    }),
    requestedByUserId: uuid('requested_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    failureMessage: text('failure_message'),
    processedAt: tstz('processed_at'),
    /** Manual refunds: who marked the transfer as done, when, and an optional remark. */
    completedByUserId: uuid('completed_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    completedAt: tstz('completed_at'),
    note: text('note'),
    ...timestamps(),
  },
  (t) => [
    index('refunds_order_idx').on(t.orderId),
    index('refunds_batch_idx').on(t.batchId),
    /** Open to-dos: manual refunds waiting for a transfer and failed automatic ones. */
    index('refunds_open_idx')
      .on(t.createdAt)
      .where(sql`${t.status} IN ('PENDING','FAILED')`),
    uniqueIndex('refunds_provider_refund_uq')
      .on(t.providerRefundId)
      .where(sql`${t.providerRefundId} IS NOT NULL`),
    check('refunds_amount_positive', sql`${t.amount} > 0`),
  ],
);

/**
 * What a refund pays back: an order item (ticket price) or a fee line. `amount` is the money
 * actually returned with that refund row (can be below the item price when the order was only
 * partly paid); exactly one of `order_item_id` / `order_fee_id` is set.
 */
export const refundItems = pgTable(
  'refund_items',
  {
    id: id(),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refunds.id, { onDelete: 'cascade' }),
    orderItemId: uuid('order_item_id').references(() => orderItems.id, { onDelete: 'restrict' }),
    orderFeeId: uuid('order_fee_id').references(() => orderFees.id, { onDelete: 'restrict' }),
    amount: cents('amount').notNull(),
  },
  (t) => [
    uniqueIndex('refund_items_item_uq')
      .on(t.refundId, t.orderItemId)
      .where(sql`${t.orderItemId} IS NOT NULL`),
    uniqueIndex('refund_items_fee_uq')
      .on(t.refundId, t.orderFeeId)
      .where(sql`${t.orderFeeId} IS NOT NULL`),
    index('refund_items_item_idx').on(t.orderItemId),
    index('refund_items_fee_idx').on(t.orderFeeId),
    check('refund_items_amount_nonneg', sql`${t.amount} >= 0`),
    check(
      'refund_items_target',
      sql`(${t.orderItemId} IS NOT NULL)::int + (${t.orderFeeId} IS NOT NULL)::int = 1`,
    ),
  ],
);

/**
 * Invoices and credit notes. Immutable once written (GoBD) – enforced by trigger in
 * migration 0002; only `pdf_object_key` may be filled in after asynchronous rendering.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    type: invoiceTypeEnum('type').notNull(),
    invoiceNumber: text('invoice_number').notNull(),
    correctsInvoiceId: uuid('corrects_invoice_id').references((): AnyPgColumn => invoices.id, {
      onDelete: 'restrict',
    }),
    issuedAt: tstz('issued_at').notNull().defaultNow(),
    seller: jsonb('seller').$type<PartySnapshot>().notNull(),
    buyer: jsonb('buyer').$type<PartySnapshot>().notNull(),
    currency: currency().notNull(),
    totalNet: integer('total_net').notNull(),
    totalTax: integer('total_tax').notNull(),
    totalGross: integer('total_gross').notNull(),
    taxBreakdown: jsonb('tax_breakdown').$type<TaxBreakdownEntry[]>().notNull(),
    legalNotes: text('legal_notes'),
    pdfObjectKey: text('pdf_object_key'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('invoices_number_uq').on(t.invoiceNumber),
    index('invoices_order_idx').on(t.orderId),
    check(
      'invoices_credit_note_reference',
      sql`(${t.type} = 'CREDIT_NOTE') = (${t.correctsInvoiceId} IS NOT NULL)`,
    ),
    check('invoices_totals', sql`${t.totalGross} = ${t.totalNet} + ${t.totalTax}`),
  ],
);

/**
 * Invoice lines. A multi-event order yields lines for several performances, so the date of
 * supply (Leistungsdatum, § 14 UStG) is stored per line – the event start for ticket lines.
 */
export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: id(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    description: text('description').notNull(),
    serviceDate: tstz('service_date'),
    quantity: integer('quantity').notNull(),
    unitPriceGross: integer('unit_price_gross').notNull(),
    taxRateBasisPoints: basisPoints('tax_rate_basis_points').notNull(),
    totalNet: integer('total_net').notNull(),
    totalTax: integer('total_tax').notNull(),
    totalGross: integer('total_gross').notNull(),
    orderItemId: uuid('order_item_id').references(() => orderItems.id, { onDelete: 'restrict' }),
    orderFeeId: uuid('order_fee_id').references(() => orderFees.id, { onDelete: 'restrict' }),
  },
  (t) => [
    unique('invoice_lines_position_uq').on(t.invoiceId, t.position),
    check('invoice_lines_quantity_nonzero', sql`${t.quantity} <> 0`),
    check('invoice_lines_totals', sql`${t.totalGross} = ${t.totalNet} + ${t.totalTax}`),
  ],
);

/**
 * An invoice that a credit note cancelled completely because the sale was undone (bank allocation
 * reversed). The next payment of the order issues a new invoice; the superseded one stays for the
 * audit trail. Kept in its own table: invoices are immutable (GoBD trigger).
 */
export const invoiceSupersessions = pgTable('invoice_supersessions', {
  invoiceId: uuid('invoice_id')
    .primaryKey()
    .references(() => invoices.id, { onDelete: 'restrict' }),
  creditNoteId: uuid('credit_note_id')
    .notNull()
    .references(() => invoices.id, { onDelete: 'restrict' }),
  createdAt: createdAt(),
});

/** Order history / state machine log (admin order timeline, customer account view). */
export const orderHistory = pgTable(
  'order_history',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** e.g. `created`, `status_changed`, `reminder_sent`, `seat_changed`, `tickets_resent`. */
    type: text('type').notNull(),
    fromStatus: orderStatusEnum('from_status'),
    toStatus: orderStatusEnum('to_status'),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => adminUsers.id, { onDelete: 'set null' }),
    data: jsonb('data'),
    createdAt: createdAt(),
  },
  (t) => [index('order_history_order_idx').on(t.orderId, t.createdAt)],
);

/** Idempotent inbox for payment provider webhooks (PayPal). */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    signatureValid: boolean('signature_valid').notNull(),
    status: webhookEventStatusEnum('status').notNull().default('RECEIVED'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    processedAt: tstz('processed_at'),
  },
  (t) => [
    unique('webhook_events_external_uq').on(t.provider, t.externalId),
    index('webhook_events_status_idx').on(t.status, t.receivedAt),
  ],
);
