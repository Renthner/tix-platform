import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { EventInfoBox } from '@tix/shared';
import { cents, createdAt, currency, id, timestamps, tstz, translationsColumn } from './_columns';
import { adminUsers } from './auth';
import {
  accessCodeTypeEnum,
  announcementSeverityEnum,
  discountKindEnum,
  eventStatusEnum,
  feeCalculationEnum,
  feeScopeEnum,
  paymentMethodEnum,
  queueAdmissionOrderEnum,
  queueModeEnum,
  salesChannelEnum,
  seatFeatureEnum,
  seatMapKindEnum,
  signingKeyStatusEnum,
} from './enums';
import { orders } from './orders';
import { mediaAssets, taxRates } from './settings';
import { ticketTemplates } from './templates';
import { seatMaps, venues } from './venues';

export const eventSeries = pgTable(
  'event_series',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    imageAssetId: uuid('image_asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    unique('event_series_slug_uq').on(t.slug),
    check('event_series_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

/**
 * An event (performance). Nullable "override" columns inherit the global value from
 * `system_settings` when NULL – resolution: event override ?? global setting.
 */
export const events = pgTable(
  'events',
  {
    id: id(),
    seriesId: uuid('series_id').references(() => eventSeries.id, { onDelete: 'set null' }),
    venueId: uuid('venue_id')
      .notNull()
      .references((): AnyPgColumn => venues.id, { onDelete: 'restrict' }),
    /** The event's own EVENT-kind seat map (FK below enforces kind = EVENT). */
    seatMapId: uuid('seat_map_id'),
    seatMapKind: seatMapKindEnum('seat_map_kind').notNull().default('EVENT'),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    description: text('description'),
    translations: translationsColumn(),
    status: eventStatusEnum('status').notNull().default('DRAFT'),
    /**
     * Event page layout: rows of blocks side by side (drag & drop in the admin). Read through
     * `normalizePageLayout` (also converts the earlier flat format).
     */
    pageLayout: jsonb('page_layout')
      .$type<unknown>()
      .notNull()
      .default(sql`'[[{"ref":"SHOP","span":1}],[{"ref":"DESCRIPTION","span":1}]]'::jsonb`),
    /** Info boxes (proofs of reduction, accessibility …) shown on the event page. */
    infoBoxes: jsonb('info_boxes')
      .$type<EventInfoBox[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    startsAt: tstz('starts_at').notNull(),
    /** Manual position in the shop listing (ascending); NULL = not placed, sorted by date after the placed ones. */
    shopSortOrder: integer('shop_sort_order'),
    endsAt: tstz('ends_at'),
    doorsOpenAt: tstz('doors_open_at'),
    timeZone: text('time_zone').notNull(),
    heroImageAssetId: uuid('hero_image_asset_id').references(() => mediaAssets.id, {
      onDelete: 'set null',
    }),

    // ── Sales windows ──────────────────────────────────────────────────────
    /** Early access for VIP/presale code holders. */
    presaleStartsAt: tstz('presale_starts_at'),
    publicSaleStartsAt: tstz('public_sale_starts_at'),
    saleEndsAt: tstz('sale_ends_at'),
    /** Emergency stop – all checkouts are rejected while true. */
    salesPaused: boolean('sales_paused').notNull().default(false),

    // ── Money ──────────────────────────────────────────────────────────────
    currency: currency().notNull(),
    taxRateId: uuid('tax_rate_id')
      .notNull()
      .references((): AnyPgColumn => taxRates.id, { onDelete: 'restrict' }),

    // ── Overrides of global `checkout` settings (NULL = inherit) ───────────
    maxTicketsPerOrder: integer('max_tickets_per_order'),
    maxTicketsPerCustomer: integer('max_tickets_per_customer'),
    cartLockTtlSeconds: integer('cart_lock_ttl_seconds'),
    paymentGraceSeconds: integer('payment_grace_seconds'),
    manualSeatSelectionEnabled: boolean('manual_seat_selection_enabled'),
    bestAvailableEnabled: boolean('best_available_enabled'),
    orphanSeatRuleEnabled: boolean('orphan_seat_rule_enabled'),
    /** Companion seats only together with their wheelchair space (NULL = inherit). */
    companionRequiresWheelchair: boolean('companion_requires_wheelchair'),
    /**
     * FALSE = no sign-in / registration offered in the checkout of this event (guest orders
     * only). NULL = global `customerAccounts.enabled`. Accounts cannot be forced on per event.
     */
    customerAccountsEnabled: boolean('customer_accounts_enabled'),

    // ── Overrides of global `paypal` / `bankTransfer` settings ─────────────
    paypalEnabled: boolean('paypal_enabled'),
    bankTransferEnabled: boolean('bank_transfer_enabled'),
    bankTransferPaymentTermDays: integer('bank_transfer_payment_term_days'),
    bankTransferReminderAfterDays: integer('bank_transfer_reminder_after_days'),
    bankTransferCancelAfterDays: integer('bank_transfer_cancel_after_days'),
    /** FALSE = unpaid Vorkasse orders of this event are never cancelled automatically. NULL = use the days override / global. */
    bankTransferAutoCancel: boolean('bank_transfer_auto_cancel'),
    bankTransferDisableDaysBeforeEvent: integer('bank_transfer_disable_days_before_event'),

    // ── Documents & wallet ─────────────────────────────────────────────────
    ticketTemplateId: uuid('ticket_template_id').references((): AnyPgColumn => ticketTemplates.id, {
      onDelete: 'set null',
    }),
    googleWalletClassId: text('google_wallet_class_id'),

    publishedAt: tstz('published_at'),
    cancelledAt: tstz('cancelled_at'),
    cancellationReason: text('cancellation_reason'),
    clonedFromId: uuid('cloned_from_id').references((): AnyPgColumn => events.id, {
      onDelete: 'set null',
    }),
    createdByUserId: uuid('created_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    unique('events_slug_uq').on(t.slug),
    unique('events_seat_map_uq').on(t.seatMapId),
    foreignKey({
      name: 'events_seat_map_fk',
      columns: [t.seatMapId, t.seatMapKind],
      foreignColumns: [seatMaps.id, seatMaps.kind],
    }).onDelete('restrict'),
    index('events_status_starts_idx').on(t.status, t.startsAt),
    index('events_series_idx').on(t.seriesId),
    index('events_venue_idx').on(t.venueId),
    check('events_seat_map_kind_event', sql`${t.seatMapKind} = 'EVENT'`),
    check('events_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('events_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'events_published_has_seat_map',
      sql`${t.status} = 'DRAFT' OR ${t.seatMapId} IS NOT NULL`,
    ),
    check('events_ends_after_start', sql`${t.endsAt} IS NULL OR ${t.endsAt} > ${t.startsAt}`),
    check(
      'events_doors_before_start',
      sql`${t.doorsOpenAt} IS NULL OR ${t.doorsOpenAt} <= ${t.startsAt}`,
    ),
    check(
      'events_presale_before_public',
      sql`${t.presaleStartsAt} IS NULL OR ${t.publicSaleStartsAt} IS NULL OR ${t.presaleStartsAt} <= ${t.publicSaleStartsAt}`,
    ),
    check(
      'events_sale_window',
      sql`${t.saleEndsAt} IS NULL OR ${t.saleEndsAt} > COALESCE(${t.publicSaleStartsAt}, ${t.presaleStartsAt}, '-infinity'::timestamptz)`,
    ),
    check(
      'events_positive_overrides',
      sql`COALESCE(${t.maxTicketsPerOrder}, 1) > 0
        AND COALESCE(${t.maxTicketsPerCustomer}, 1) > 0
        AND COALESCE(${t.cartLockTtlSeconds}, 1) > 0
        AND COALESCE(${t.paymentGraceSeconds}, 0) >= 0
        AND COALESCE(${t.bankTransferPaymentTermDays}, 1) > 0
        AND COALESCE(${t.bankTransferReminderAfterDays}, 1) > 0
        AND COALESCE(${t.bankTransferCancelAfterDays}, 1) > 0
        AND COALESCE(${t.bankTransferDisableDaysBeforeEvent}, 0) >= 0`,
    ),
  ],
);

/** Price categories (Preiskategorien) with colour, base price and optional per-order limit. */
export const priceCategories = pgTable(
  'price_categories',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    translations: translationsColumn(),
    color: text('color').notNull(),
    basePrice: cents('base_price').notNull(),
    maxTicketsPerOrder: integer('max_tickets_per_order'),
    /** Overrides the event's ticket template for this category (e.g. different artwork). */
    ticketTemplateId: uuid('ticket_template_id').references((): AnyPgColumn => ticketTemplates.id, {
      onDelete: 'set null',
    }),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('price_categories_name_uq').on(t.eventId, t.name),
    index('price_categories_event_idx').on(t.eventId, t.sortOrder),
    check('price_categories_price_nonneg', sql`${t.basePrice} >= 0`),
    check('price_categories_color_format', sql`${t.color} ~ '^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$'`),
    check(
      'price_categories_max_per_order_positive',
      sql`${t.maxTicketsPerOrder} IS NULL OR ${t.maxTicketsPerOrder} > 0`,
    ),
  ],
);

/**
 * Ticket types / tariffs (Normal, Schüler/Student, Kind, Rollstuhl, Begleitperson …).
 * The final price per category is `price_category_ticket_types.price_override` if set,
 * otherwise the discount rule applied to `price_categories.base_price`.
 *
 * Flow: seats are selected without a tariff (the `is_default` type is pre-selected); the
 * customer assigns a tariff per seat in the cart. Eligibility is not checked online – it
 * is verified at the door, where the scanner shows `scanner_warning` (YELLOW).
 */
export const ticketTypes = pgTable(
  'ticket_types',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    translations: translationsColumn(),
    discountKind: discountKindEnum('discount_kind').notNull().default('NONE'),
    /** Basis points for PERCENT, cents for FIXED_AMOUNT / FIXED_PRICE. */
    discountValue: integer('discount_value').notNull().default(0),
    /** Proof is checked at entry: scanner shows YELLOW with `scanner_warning`. */
    requiresProofAtEntry: boolean('requires_proof_at_entry').notNull().default(false),
    /** e.g. "Bitte Ermäßigungsnachweis prüfen!" */
    scannerWarning: text('scanner_warning'),
    /** Only sellable on seats having this feature (wheelchair space / companion seat). */
    requiredSeatFeature: seatFeatureEnum('required_seat_feature'),
    maxPerOrder: integer('max_per_order'),
    channels: salesChannelEnum('channels')
      .array()
      .notNull()
      .default(sql`ARRAY['ONLINE','BOX_OFFICE','ADMIN']::sales_channel[]`),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    unique('ticket_types_name_uq').on(t.eventId, t.name),
    uniqueIndex('ticket_types_single_default_uq')
      .on(t.eventId)
      .where(sql`${t.isDefault}`),
    check('ticket_types_discount_nonneg', sql`${t.discountValue} >= 0`),
    check(
      'ticket_types_percent_range',
      sql`${t.discountKind} <> 'PERCENT' OR ${t.discountValue} <= 10000`,
    ),
    check('ticket_types_none_zero', sql`${t.discountKind} <> 'NONE' OR ${t.discountValue} = 0`),
    check(
      'ticket_types_max_per_order_positive',
      sql`${t.maxPerOrder} IS NULL OR ${t.maxPerOrder} > 0`,
    ),
    check('ticket_types_channels_not_empty', sql`cardinality(${t.channels}) > 0`),
    check(
      'ticket_types_proof_warning',
      sql`NOT ${t.requiresProofAtEntry} OR ${t.scannerWarning} IS NOT NULL`,
    ),
  ],
);

/**
 * Which ticket types are offered in which category. A cell may override the tariff's
 * price rule for this category: either a fixed final price (`price_override`) or a
 * category-specific discount (`discount_kind` + `discount_value`, e.g. Cat 1 −5 €, Cat 2 −4 €).
 */
export const priceCategoryTicketTypes = pgTable(
  'price_category_ticket_types',
  {
    priceCategoryId: uuid('price_category_id')
      .notNull()
      .references(() => priceCategories.id, { onDelete: 'cascade' }),
    ticketTypeId: uuid('ticket_type_id')
      .notNull()
      .references(() => ticketTypes.id, { onDelete: 'cascade' }),
    priceOverride: cents('price_override'),
    discountKind: discountKindEnum('discount_kind'),
    /** Basis points for PERCENT, cents for FIXED_AMOUNT / FIXED_PRICE. */
    discountValue: integer('discount_value'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'price_category_ticket_types_pk',
      columns: [t.priceCategoryId, t.ticketTypeId],
    }),
    index('price_category_ticket_types_type_idx').on(t.ticketTypeId),
    check(
      'price_category_ticket_types_override_nonneg',
      sql`${t.priceOverride} IS NULL OR ${t.priceOverride} >= 0`,
    ),
    check(
      'price_category_ticket_types_discount_pair',
      sql`(${t.discountKind} IS NULL) = (${t.discountValue} IS NULL)`,
    ),
    check(
      'price_category_ticket_types_single_override',
      sql`${t.priceOverride} IS NULL OR ${t.discountKind} IS NULL`,
    ),
    check(
      'price_category_ticket_types_discount_range',
      sql`${t.discountValue} IS NULL OR (${t.discountValue} >= 0 AND (${t.discountKind} <> 'PERCENT' OR ${t.discountValue} <= 10000))`,
    ),
  ],
);

/**
 * Service / booking fees – global defaults that can be adjusted per event.
 *
 * - `event_id IS NULL` → global fee. PER_TICKET / PER_EVENT globals apply to every event;
 *   PER_ORDER fees exist only globally and are charged once per (multi-event) order.
 * - `event_id` set, `overrides_fee_id` set → the event's adjustment of a global fee
 *   (different value/calculation, or `is_active = false` to waive it for this event).
 * - `event_id` set, `overrides_fee_id` NULL → additional fee for this event only.
 *
 * Effective fees of an event = active globals not overridden by the event
 *                             + the event's active overrides and additional fees.
 */
export const fees = pgTable(
  'fees',
  {
    id: id(),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'cascade' }),
    overridesFeeId: uuid('overrides_fee_id').references((): AnyPgColumn => fees.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull(),
    translations: translationsColumn(),
    scope: feeScopeEnum('scope').notNull(),
    calculation: feeCalculationEnum('calculation').notNull(),
    /** Cents for FIXED, basis points of the ticket / event subtotal / order amount for PERCENT. */
    value: integer('value').notNull(),
    /** NULL = the event's tax rate (required for PER_ORDER fees, which have no event). */
    taxRateId: uuid('tax_rate_id').references((): AnyPgColumn => taxRates.id, {
      onDelete: 'restrict',
    }),
    /** NULL = all payment methods (allows e.g. a PayPal-only surcharge). */
    paymentMethods: paymentMethodEnum('payment_methods').array(),
    /** NULL = all channels. */
    channels: salesChannelEnum('channels').array(),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index('fees_event_idx').on(t.eventId),
    uniqueIndex('fees_single_override_per_event_uq')
      .on(t.eventId, t.overridesFeeId)
      .where(sql`${t.overridesFeeId} IS NOT NULL`),
    check('fees_value_nonneg', sql`${t.value} >= 0`),
    check('fees_percent_range', sql`${t.calculation} <> 'PERCENT' OR ${t.value} <= 10000`),
    check('fees_per_order_global', sql`${t.scope} <> 'PER_ORDER' OR ${t.eventId} IS NULL`),
    check('fees_per_order_tax_rate', sql`${t.scope} <> 'PER_ORDER' OR ${t.taxRateId} IS NOT NULL`),
    check('fees_override_on_event', sql`${t.overridesFeeId} IS NULL OR ${t.eventId} IS NOT NULL`),
  ],
);

/**
 * Ed25519 key pairs for offline-verifiable ticket QR codes. The public key is shipped to
 * scanners; the private key is secret-box encrypted. One ACTIVE key per event.
 */
export const eventSigningKeys = pgTable(
  'event_signing_keys',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    /** Short key id embedded in payloads/sync data to select the verification key. */
    keyId: text('key_id').notNull(),
    algorithm: text('algorithm').notNull().default('Ed25519'),
    /** Raw 32-byte public key, base64url. */
    publicKey: text('public_key').notNull(),
    privateKeyEncrypted: text('private_key_encrypted').notNull(),
    status: signingKeyStatusEnum('status').notNull().default('ACTIVE'),
    retiredAt: tstz('retired_at'),
    revokedAt: tstz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('event_signing_keys_key_id_uq').on(t.eventId, t.keyId),
    uniqueIndex('event_signing_keys_single_active_uq')
      .on(t.eventId)
      .where(sql`${t.status} = 'ACTIVE'`),
    check('event_signing_keys_algorithm', sql`${t.algorithm} = 'Ed25519'`),
  ],
);

/**
 * Virtual waiting room configuration. `event_id IS NULL` is the global default (exactly one,
 * enforced by NULLS NOT DISTINCT); an event row overrides it completely.
 */
export const queueConfigs = pgTable(
  'queue_configs',
  {
    id: id(),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'cascade' }),
    mode: queueModeEnum('mode').notNull().default('OFF'),
    /** AUTO_THRESHOLD: waiting room activates above this many active shop sessions. */
    activeSessionThreshold: integer('active_session_threshold').notNull(),
    /** Users admitted per admission tick. */
    admissionBatchSize: integer('admission_batch_size').notNull(),
    admissionIntervalSeconds: integer('admission_interval_seconds').notNull(),
    /** Lifetime of the signed QueuePassToken (shopping window). */
    passTokenTtlSeconds: integer('pass_token_ttl_seconds').notNull(),
    /** SCHEDULED_PRE_REGISTRATION: lobby opens this many minutes before sale start (T-0). */
    lobbyOpensMinutesBefore: integer('lobby_opens_minutes_before').notNull().default(60),
    admissionOrder: queueAdmissionOrderEnum('admission_order').notNull().default('RANDOMIZED'),
    /** HYBRID: valid access codes skip the queue. */
    accessCodeBypassesQueue: boolean('access_code_bypasses_queue').notNull().default(true),
    maxQueueSize: integer('max_queue_size'),
    isPaused: boolean('is_paused').notNull().default(false),
    title: text('title'),
    message: text('message'),
    translations: translationsColumn(),
    updatedByUserId: uuid('updated_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    unique('queue_configs_event_uq').on(t.eventId).nullsNotDistinct(),
    check(
      'queue_configs_positive',
      sql`${t.activeSessionThreshold} > 0 AND ${t.admissionBatchSize} > 0
        AND ${t.admissionIntervalSeconds} > 0 AND ${t.passTokenTtlSeconds} >= 60
        AND ${t.lobbyOpensMinutesBefore} >= 0
        AND (${t.maxQueueSize} IS NULL OR ${t.maxQueueSize} > 0)`,
    ),
  ],
);

/** Live organizer announcements pushed to the waiting room via WebSocket (kept for history). */
export const queueAnnouncements = pgTable(
  'queue_announcements',
  {
    id: id(),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'cascade' }),
    severity: announcementSeverityEnum('severity').notNull().default('INFO'),
    message: text('message').notNull(),
    translations: translationsColumn(),
    publishedAt: tstz('published_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at'),
    createdByUserId: uuid('created_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [index('queue_announcements_event_idx').on(t.eventId, t.publishedAt)],
);

/**
 * VIP / presale codes. `event_id IS NULL` = valid for all events.
 * `redemption_count` is incremented with a conditional UPDATE; the CHECK constraint makes
 * over-redemption of single/limited-use codes impossible even under concurrency.
 */
export const accessCodes = pgTable(
  'access_codes',
  {
    id: id(),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'cascade' }),
    /** Normalised upper-case code. */
    code: text('code').notNull(),
    label: text('label'),
    type: accessCodeTypeEnum('type').notNull(),
    maxRedemptions: integer('max_redemptions'),
    redemptionCount: integer('redemption_count').notNull().default(0),
    maxTicketsPerOrder: integer('max_tickets_per_order'),
    /** Total tickets purchasable with this code across all orders. */
    maxTicketsTotal: integer('max_tickets_total'),
    bypassesQueue: boolean('bypasses_queue').notNull().default(true),
    grantsPresaleAccess: boolean('grants_presale_access').notNull().default(true),
    validFrom: tstz('valid_from'),
    validUntil: tstz('valid_until'),
    isActive: boolean('is_active').notNull().default(true),
    createdByUserId: uuid('created_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    unique('access_codes_code_uq').on(t.eventId, t.code).nullsNotDistinct(),
    check('access_codes_code_format', sql`${t.code} ~ '^[A-Z0-9-]{4,64}$'`),
    check('access_codes_single_use', sql`${t.type} <> 'SINGLE_USE' OR ${t.maxRedemptions} = 1`),
    check(
      'access_codes_redemptions',
      sql`${t.redemptionCount} >= 0 AND (${t.maxRedemptions} IS NULL OR (${t.maxRedemptions} > 0 AND ${t.redemptionCount} <= ${t.maxRedemptions}))`,
    ),
    check(
      'access_codes_ticket_limits',
      sql`(${t.maxTicketsPerOrder} IS NULL OR ${t.maxTicketsPerOrder} > 0) AND (${t.maxTicketsTotal} IS NULL OR ${t.maxTicketsTotal} > 0)`,
    ),
    check(
      'access_codes_validity',
      sql`${t.validFrom} IS NULL OR ${t.validUntil} IS NULL OR ${t.validFrom} < ${t.validUntil}`,
    ),
  ],
);

export const accessCodeRedemptions = pgTable(
  'access_code_redemptions',
  {
    id: id(),
    accessCodeId: uuid('access_code_id')
      .notNull()
      .references(() => accessCodes.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').references((): AnyPgColumn => orders.id, { onDelete: 'set null' }),
    email: text('email'),
    /** Waiting-room / shop session that used the code (queue bypass without order). */
    sessionId: text('session_id'),
    ticketCount: integer('ticket_count').notNull().default(0),
    redeemedAt: tstz('redeemed_at').notNull().defaultNow(),
  },
  (t) => [
    index('access_code_redemptions_code_idx').on(t.accessCodeId),
    index('access_code_redemptions_order_idx').on(t.orderId),
    check('access_code_redemptions_ticket_count', sql`${t.ticketCount} >= 0`),
  ],
);
