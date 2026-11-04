import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { basisPoints, createdAt, id, timestamps, tstz } from './_columns';
import { adminUsers } from './auth';
import { mediaAssetKindEnum } from './enums';

/**
 * Global configuration store. Keys and value schemas are defined in
 * `@tix/shared` → `SETTINGS`. Exactly one of `value` (plain JSON) or
 * `encrypted_value` (secret-box envelope, for `secret: true` keys) is set.
 */
export const systemSettings = pgTable(
  'system_settings',
  {
    key: text('key').primaryKey(),
    value: jsonb('value'),
    encryptedValue: text('encrypted_value'),
    updatedByUserId: uuid('updated_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    check('system_settings_one_value', sql`num_nonnulls(${t.value}, ${t.encryptedValue}) = 1`),
  ],
);

/**
 * Files uploaded by admins (event images, venue backgrounds, ticket backgrounds, logos,
 * wallet images). Binary data lives in S3/MinIO; this table is the catalogue.
 * Generated documents (ticket PDFs, invoices, .pkpass) are referenced directly by object key.
 */
export const mediaAssets = pgTable(
  'media_assets',
  {
    id: id(),
    kind: mediaAssetKindEnum('kind').notNull(),
    bucket: text('bucket').notNull(),
    objectKey: text('object_key').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    width: integer('width'),
    height: integer('height'),
    altText: text('alt_text'),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('media_assets_object_uq').on(t.bucket, t.objectKey),
    index('media_assets_kind_idx').on(t.kind, t.createdAt),
    index('media_assets_sha256_idx').on(t.sha256),
    check('media_assets_size_nonneg', sql`${t.sizeBytes} >= 0`),
    check(
      'media_assets_dimensions_positive',
      sql`(${t.width} IS NULL OR ${t.width} > 0) AND (${t.height} IS NULL OR ${t.height} > 0)`,
    ),
  ],
);

/**
 * VAT rates (e.g. 19 %, 7 %, 0 % § 19 UStG Kleinunternehmer, 0 % § 4 Nr. 20 UStG).
 * Orders snapshot the rate in basis points, so editing a rate never alters past invoices.
 */
export const taxRates = pgTable(
  'tax_rates',
  {
    id: id(),
    name: text('name').notNull(),
    rateBasisPoints: basisPoints('rate_basis_points').notNull(),
    /** Mandatory legal note printed on invoices (e.g. "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet."). */
    invoiceNote: text('invoice_note'),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: tstz('archived_at'),
    ...timestamps(),
  },
  (t) => [
    unique('tax_rates_name_uq').on(t.name),
    uniqueIndex('tax_rates_single_default_uq')
      .on(t.isDefault)
      .where(sql`${t.isDefault}`),
    check('tax_rates_rate_range', sql`${t.rateBasisPoints} BETWEEN 0 AND 10000`),
  ],
);

/**
 * Gapless counters for order, invoice and credit-note numbers (GoBD: sequential, no gaps).
 * Allocation happens inside the business transaction via
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so a rolled-back transaction never
 * consumes a number. Scope key examples: `invoice:2026`, `order:2026`.
 */
export const numberSequences = pgTable(
  'number_sequences',
  {
    scope: text('scope').primaryKey(),
    lastValue: bigint('last_value', { mode: 'number' }).notNull().default(0),
    ...timestamps(),
  },
  (t) => [check('number_sequences_nonneg', sql`${t.lastValue} >= 0`)],
);
