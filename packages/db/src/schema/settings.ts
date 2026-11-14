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
    /**
     * sha256 of the bytes the admin uploaded (the de-duplication key; for legacy rows, whose
     * original was stored unchanged, also the hash of the stored file). Together with
     * `master_sha256` it lets a re-upload of the same picture find the existing asset.
     */
    sha256: text('sha256').notNull(),
    /**
     * sha256 of the stored master bytes (after orientation / metadata normalisation and WebP
     * conversion). NULL for assets created before it existed. Equals `sha256` when the upload
     * was stored unchanged. Seat-plan exports carry the master, so a re-import matches on it.
     */
    masterSha256: text('master_sha256'),
    width: integer('width'),
    height: integer('height'),
    altText: text('alt_text'),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    /** Set once the AVIF / WebP variants were generated (also when none were possible). */
    variantsProcessedAt: tstz('variants_processed_at'),
    /** Processing attempts of the variant generation (a permanently failing asset is given up on). */
    variantsAttempts: integer('variants_attempts').notNull().default(0),
    /**
     * Set once the stored master is known to be normalised (auto-oriented, metadata stripped,
     * WebP converted). New uploads set it on insert; the worker cleans legacy rows once.
     */
    masterNormalisedAt: tstz('master_normalised_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('media_assets_object_uq').on(t.bucket, t.objectKey),
    index('media_assets_kind_idx').on(t.kind, t.createdAt),
    index('media_assets_sha256_idx').on(t.sha256),
    index('media_assets_master_sha256_idx').on(t.masterSha256),
    check('media_assets_size_nonneg', sql`${t.sizeBytes} >= 0`),
    check(
      'media_assets_dimensions_positive',
      sql`(${t.width} IS NULL OR ${t.width} > 0) AND (${t.height} IS NULL OR ${t.height} > 0)`,
    ),
  ],
);

/**
 * Modern-format copies (AVIF / WebP) of a media asset at several widths, stored next to the
 * original in the assets bucket. Derived data: they can be regenerated from the original.
 */
export const mediaAssetVariants = pgTable(
  'media_asset_variants',
  {
    id: id(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => mediaAssets.id, { onDelete: 'cascade' }),
    format: text('format').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('media_asset_variants_uq').on(t.assetId, t.format, t.width),
    unique('media_asset_variants_key_uq').on(t.storageKey),
    check('media_asset_variants_format', sql`${t.format} IN ('avif', 'webp')`),
    check(
      'media_asset_variants_size',
      sql`${t.width} > 0 AND ${t.height} > 0 AND ${t.sizeBytes} >= 0`,
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
