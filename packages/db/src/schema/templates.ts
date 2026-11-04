import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { TicketLayout } from '@tix/shared';
import { id, timestamps, tstz } from './_columns';
import { adminUsers } from './auth';
import { emailStatusEnum, emailTemplateKeyEnum } from './enums';
import { events } from './events';
import { orders } from './orders';
import { mediaAssets } from './settings';

/**
 * PDF ticket layouts built in the visual designer. `event_id IS NULL` = shared library
 * template. Assigned via `events.ticket_template_id` and overridable per price category.
 */
export const ticketTemplates = pgTable(
  'ticket_templates',
  {
    id: id(),
    eventId: uuid('event_id').references((): AnyPgColumn => events.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    pageWidthMm: real('page_width_mm').notNull(),
    pageHeightMm: real('page_height_mm').notNull(),
    backgroundAssetId: uuid('background_asset_id').references(() => mediaAssets.id, {
      onDelete: 'set null',
    }),
    layout: jsonb('layout').$type<TicketLayout>().notNull(),
    /** Global fallback template when an event has none assigned. */
    isDefault: boolean('is_default').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdByUserId: uuid('created_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    index('ticket_templates_event_idx').on(t.eventId),
    uniqueIndex('ticket_templates_single_default_uq')
      .on(t.isDefault)
      .where(sql`${t.isDefault} AND ${t.eventId} IS NULL`),
    check(
      'ticket_templates_page_size',
      sql`${t.pageWidthMm} BETWEEN 20 AND 2000 AND ${t.pageHeightMm} BETWEEN 20 AND 2000`,
    ),
    check('ticket_templates_default_is_global', sql`NOT ${t.isDefault} OR ${t.eventId} IS NULL`),
  ],
);

/**
 * Apple/Google Wallet appearance. `event_id IS NULL` = global default (one, NULLS NOT DISTINCT).
 * Certificates/credentials live in encrypted system settings.
 */
export const walletPassDesigns = pgTable(
  'wallet_pass_designs',
  {
    id: id(),
    eventId: uuid('event_id').references((): AnyPgColumn => events.id, { onDelete: 'cascade' }),
    backgroundColor: text('background_color').notNull(),
    foregroundColor: text('foreground_color').notNull(),
    labelColor: text('label_color').notNull(),
    logoText: text('logo_text'),
    description: text('description'),
    logoAssetId: uuid('logo_asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    iconAssetId: uuid('icon_asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    stripAssetId: uuid('strip_asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    heroAssetId: uuid('hero_asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    unique('wallet_pass_designs_event_uq').on(t.eventId).nullsNotDistinct(),
    check(
      'wallet_pass_designs_colors',
      sql`${t.backgroundColor} ~ '^#[0-9A-Fa-f]{6}$' AND ${t.foregroundColor} ~ '^#[0-9A-Fa-f]{6}$' AND ${t.labelColor} ~ '^#[0-9A-Fa-f]{6}$'`,
    ),
  ],
);

/**
 * Transactional e-mail templates with {{placeholders}}. A row with `event_id` overrides the
 * global template (`event_id IS NULL`) for that event; one row per key/event/locale.
 */
export const emailTemplates = pgTable(
  'email_templates',
  {
    id: id(),
    key: emailTemplateKeyEnum('key').notNull(),
    eventId: uuid('event_id').references((): AnyPgColumn => events.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    subject: text('subject').notNull(),
    bodyHtml: text('body_html').notNull(),
    /** Plain-text alternative; generated from HTML when NULL. */
    bodyText: text('body_text'),
    isActive: boolean('is_active').notNull().default(true),
    updatedByUserId: uuid('updated_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    unique('email_templates_key_event_locale_uq').on(t.key, t.eventId, t.locale).nullsNotDistinct(),
  ],
);

/** Outbox + delivery log of every e-mail sent through the BullMQ e-mail worker. */
export const emailMessages = pgTable(
  'email_messages',
  {
    id: id(),
    templateKey: emailTemplateKeyEnum('template_key'),
    orderId: uuid('order_id').references((): AnyPgColumn => orders.id, { onDelete: 'set null' }),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    status: emailStatusEnum('status').notNull().default('QUEUED'),
    /** [{ fileName, objectKey, contentType }] */
    attachments: jsonb('attachments'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    providerMessageId: text('provider_message_id'),
    jobId: text('job_id'),
    sentAt: tstz('sent_at'),
    ...timestamps(),
  },
  (t) => [
    index('email_messages_order_idx').on(t.orderId),
    index('email_messages_status_idx').on(t.status, t.createdAt),
    check('email_messages_attempts_nonneg', sql`${t.attempts} >= 0`),
  ],
);
