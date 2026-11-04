import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
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
import type {
  ElementGeometry,
  ElementStyle,
  RowGeometry,
  SeatAttributes,
  SeatMapSettingsInput,
  SectionGeometry,
  SectionLabel,
} from '@tix/shared';
import { id, timestamps, tstz } from './_columns';
import { adminUsers } from './auth';
import {
  seatBlockReasonEnum,
  seatMapElementTypeEnum,
  seatMapKindEnum,
  sectionTypeEnum,
} from './enums';
import { priceCategories } from './events';
import { mediaAssets } from './settings';

export const venues = pgTable(
  'venues',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    street: text('street'),
    postalCode: text('postal_code'),
    city: text('city'),
    country: text('country'),
    /** GPS coordinates – used for Apple Wallet relevance (lock-screen) and maps. */
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    timeZone: text('time_zone').notNull(),
    description: text('description'),
    websiteUrl: text('website_url'),
    imageAssetId: uuid('image_asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('venues_slug_uq').on(t.slug),
    check('venues_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('venues_latitude_range', sql`${t.latitude} IS NULL OR ${t.latitude} BETWEEN -90 AND 90`),
    check(
      'venues_longitude_range',
      sql`${t.longitude} IS NULL OR ${t.longitude} BETWEEN -180 AND 180`,
    ),
    check('venues_country_format', sql`${t.country} IS NULL OR ${t.country} ~ '^[A-Z]{2}$'`),
  ],
);

/**
 * A seating plan. TEMPLATE maps are reusable master layouts of a venue; every event owns
 * exactly one EVENT map – a deep copy of a template (`cloned_from_id`) that carries the
 * sellable inventory.
 *
 * The event copy stays fully editable at any time (e.g. remove seats for a camera
 * position, add a row, re-price a block) without touching the template or other events.
 * Seats that ever appeared in an order cannot be hard-deleted (FK RESTRICT); the editor
 * soft-removes them via `seats.removed_at` so order history and tickets stay intact.
 */
export const seatMaps = pgTable(
  'seat_maps',
  {
    id: id(),
    venueId: uuid('venue_id')
      .notNull()
      .references(() => venues.id, { onDelete: 'restrict' }),
    kind: seatMapKindEnum('kind').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    clonedFromId: uuid('cloned_from_id').references((): AnyPgColumn => seatMaps.id, {
      onDelete: 'set null',
    }),
    canvasWidth: integer('canvas_width').notNull(),
    canvasHeight: integer('canvas_height').notNull(),
    backgroundAssetId: uuid('background_asset_id').references(() => mediaAssets.id, {
      onDelete: 'set null',
    }),
    settings: jsonb('settings').$type<SeatMapSettingsInput>().notNull().default({}),
    /**
     * Incremented on every editor save – clients cache the rendered map by version and
     * reload it when a newer version is broadcast (edits during an ongoing sale).
     */
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    index('seat_maps_venue_idx').on(t.venueId, t.kind),
    unique('seat_maps_id_kind_uq').on(t.id, t.kind),
    check('seat_maps_canvas_positive', sql`${t.canvasWidth} > 0 AND ${t.canvasHeight} > 0`),
    check('seat_maps_version_positive', sql`${t.version} > 0`),
  ],
);

/** Entrances (drawn as markers). Sections and scanner devices are assigned to an entrance. */
export const seatMapEntrances = pgTable(
  'seat_map_entrances',
  {
    id: id(),
    seatMapId: uuid('seat_map_id')
      .notNull()
      .references(() => seatMaps.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    code: text('code').notNull(),
    x: real('x').notNull(),
    y: real('y').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
  },
  (t) => [unique('seat_map_entrances_code_uq').on(t.seatMapId, t.code)],
);

/**
 * Blocks / areas. SEATED sections contain rows + seats. STANDING sections are general
 * admission polygons with a capacity counter: `allocated_count` is incremented with a
 * conditional UPDATE (`… WHERE allocated_count + n <= capacity`) inside the order
 * transaction and guarded by a CHECK constraint, so GA capacity can never be oversold.
 */
export const seatMapSections = pgTable(
  'seat_map_sections',
  {
    id: id(),
    seatMapId: uuid('seat_map_id')
      .notNull()
      .references(() => seatMaps.id, { onDelete: 'cascade' }),
    type: sectionTypeEnum('type').notNull(),
    name: text('name').notNull(),
    /** Printed on tickets, e.g. "Block A", "Parkett links", "Stehplatz". */
    ticketLabel: text('ticket_label').notNull(),
    geometry: jsonb('geometry').$type<SectionGeometry>().notNull(),
    label: jsonb('label').$type<SectionLabel>(),
    color: text('color'),
    sortOrder: integer('sort_order').notNull().default(0),
    entranceId: uuid('entrance_id').references(() => seatMapEntrances.id, {
      onDelete: 'set null',
    }),
    /** Category for STANDING sections; default category for new seats in SEATED sections. */
    priceCategoryId: uuid('price_category_id').references((): AnyPgColumn => priceCategories.id, {
      onDelete: 'set null',
    }),
    capacity: integer('capacity'),
    allocatedCount: integer('allocated_count').notNull().default(0),
    /** Lower = better. Ranks sections for the best-available algorithm. */
    bestAvailablePriority: integer('best_available_priority').notNull().default(100),
    isBestAvailableEnabled: boolean('is_best_available_enabled').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    index('seat_map_sections_map_idx').on(t.seatMapId, t.sortOrder),
    unique('seat_map_sections_name_uq').on(t.seatMapId, t.name),
    check(
      'seat_map_sections_capacity_required',
      sql`${t.type} <> 'STANDING' OR (${t.capacity} IS NOT NULL AND ${t.capacity} >= 0)`,
    ),
    check(
      'seat_map_sections_allocation_within_capacity',
      sql`${t.allocatedCount} >= 0 AND (${t.capacity} IS NULL OR ${t.allocatedCount} <= ${t.capacity})`,
    ),
    check(
      'seat_map_sections_seated_no_allocation',
      sql`${t.type} = 'STANDING' OR ${t.allocatedCount} = 0`,
    ),
  ],
);

/**
 * Rows within a SEATED section. `sort_order` ranks rows front-to-back (best-available).
 * Seats in a row are ordered by `seats.position`; two seats are adjacent iff their
 * positions differ by exactly 1 (aisles are modelled as skipped positions).
 */
export const seatMapRows = pgTable(
  'seat_map_rows',
  {
    id: id(),
    seatMapId: uuid('seat_map_id')
      .notNull()
      .references(() => seatMaps.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => seatMapSections.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    geometry: jsonb('geometry').$type<RowGeometry>().notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('seat_map_rows_label_uq').on(t.sectionId, t.label),
    index('seat_map_rows_map_idx').on(t.seatMapId),
  ],
);

/** Non-inventory drawables: stage, tables, text labels, shapes, images, exits, facilities. */
export const seatMapElements = pgTable(
  'seat_map_elements',
  {
    id: id(),
    seatMapId: uuid('seat_map_id')
      .notNull()
      .references(() => seatMaps.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id').references(() => seatMapSections.id, { onDelete: 'set null' }),
    type: seatMapElementTypeEnum('type').notNull(),
    label: text('label'),
    geometry: jsonb('geometry').$type<ElementGeometry>().notNull(),
    style: jsonb('style').$type<ElementStyle>().notNull().default({}),
    assetId: uuid('asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    zIndex: integer('z_index').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index('seat_map_elements_map_idx').on(t.seatMapId, t.zIndex),
    check('seat_map_elements_image_asset', sql`${t.type} <> 'IMAGE' OR ${t.assetId} IS NOT NULL`),
  ],
);

/**
 * Individual seats. Seats of an EVENT map are the unit of inventory: Redis locks use
 * `seat:{eventId}:{seatId}` and `order_items` has a partial unique index on `seat_id`
 * so a seat can be held by at most one active order item at any time.
 *
 * Removing a seat from an event map sets `removed_at` (not rendered, not sellable); its
 * label/position become free again for a replacement seat. Blocking (`block_reason`) keeps
 * the seat visible but unsellable.
 */
export const seats = pgTable(
  'seats',
  {
    id: id(),
    seatMapId: uuid('seat_map_id')
      .notNull()
      .references(() => seatMaps.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => seatMapSections.id, { onDelete: 'cascade' }),
    rowId: uuid('row_id').references(() => seatMapRows.id, { onDelete: 'cascade' }),
    /** For seats arranged around a TABLE element. */
    tableElementId: uuid('table_element_id').references(() => seatMapElements.id, {
      onDelete: 'set null',
    }),
    /** Seat number as printed ("12", "12a"). */
    label: text('label').notNull(),
    /** Adjacency index within the row/table (orphan-seat rule, best-available). */
    position: integer('position'),
    x: real('x').notNull(),
    y: real('y').notNull(),
    rotation: real('rotation').notNull().default(0),
    priceCategoryId: uuid('price_category_id').references((): AnyPgColumn => priceCategories.id, {
      onDelete: 'set null',
    }),
    /** Lower = better. Precomputed by the editor (row rank, centre distance, view quality). */
    bestAvailableRank: integer('best_available_rank'),
    isWheelchairSpace: boolean('is_wheelchair_space').notNull().default(false),
    isCompanionSeat: boolean('is_companion_seat').notNull().default(false),
    hasRestrictedView: boolean('has_restricted_view').notNull().default(false),
    /** Sperrplatz (press / VIP / technical e.g. FOH). NULL = sellable. */
    blockReason: seatBlockReasonEnum('block_reason'),
    blockNote: text('block_note'),
    blockedAt: tstz('blocked_at'),
    blockedByUserId: uuid('blocked_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    attributes: jsonb('attributes').$type<SeatAttributes>().notNull().default({}),
    /** Soft removal from an event map (e.g. space needed for a camera). */
    removedAt: tstz('removed_at'),
    ...timestamps(),
  },
  (t) => [
    index('seats_map_idx')
      .on(t.seatMapId)
      .where(sql`${t.removedAt} IS NULL`),
    index('seats_section_idx').on(t.sectionId),
    index('seats_category_idx').on(t.priceCategoryId),
    uniqueIndex('seats_row_label_uq')
      .on(t.rowId, t.label)
      .where(sql`${t.rowId} IS NOT NULL AND ${t.removedAt} IS NULL`),
    uniqueIndex('seats_row_position_uq')
      .on(t.rowId, t.position)
      .where(sql`${t.rowId} IS NOT NULL AND ${t.removedAt} IS NULL`),
    uniqueIndex('seats_table_position_uq')
      .on(t.tableElementId, t.position)
      .where(sql`${t.tableElementId} IS NOT NULL AND ${t.removedAt} IS NULL`),
    check('seats_single_parent', sql`${t.rowId} IS NULL OR ${t.tableElementId} IS NULL`),
    check(
      'seats_position_required',
      sql`(${t.rowId} IS NULL AND ${t.tableElementId} IS NULL) OR ${t.position} IS NOT NULL`,
    ),
    check('seats_block_consistency', sql`(${t.blockReason} IS NULL) = (${t.blockedAt} IS NULL)`),
  ],
);
