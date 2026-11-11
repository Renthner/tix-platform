import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, id, timestamps, tstz } from './_columns';
import { adminUsers } from './auth';
import { scanActionEnum, scanResultEnum, scanSourceEnum, scanWarningEnum } from './enums';
import { events } from './events';
import { tickets } from './orders';
import { seatMapEntrances } from './venues';

/**
 * Paired Android scanners. The device authenticates with a long random API token of which
 * only the SHA-256 is stored; `token_prefix` helps admins identify a device.
 */
export const scannerDevices = pgTable(
  'scanner_devices',
  {
    id: id(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    platform: text('platform'),
    appVersion: text('app_version'),
    deviceModel: text('device_model'),
    isActive: boolean('is_active').notNull().default(true),
    revokedAt: tstz('revoked_at'),
    /**
     * Archived ("deleted") by an admin: hidden from the device list, kept so the scan journal and
     * `tickets.first_checked_in_device_id` still resolve the device name. Revoked devices only.
     */
    deletedAt: tstz('deleted_at'),
    pairedByUserId: uuid('paired_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    lastSeenAt: tstz('last_seen_at'),
    lastSyncAt: tstz('last_sync_at'),
    /** Highest `tickets.sync_version` acknowledged by the device. */
    lastSyncVersion: bigint('last_sync_version', { mode: 'number' }),
    ...timestamps(),
  },
  (t) => [
    unique('scanner_devices_token_hash_uq').on(t.tokenHash),
    check('scanner_devices_revoked_inactive', sql`${t.revokedAt} IS NULL OR NOT ${t.isActive}`),
    check(
      'scanner_devices_deleted_revoked',
      sql`${t.deletedAt} IS NULL OR ${t.revokedAt} IS NOT NULL`,
    ),
  ],
);

/** Which events a device may scan, and at which entrance it is stationed. */
export const scannerDeviceEvents = pgTable(
  'scanner_device_events',
  {
    deviceId: uuid('device_id')
      .notNull()
      .references(() => scannerDevices.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references((): AnyPgColumn => events.id, { onDelete: 'cascade' }),
    entranceId: uuid('entrance_id').references((): AnyPgColumn => seatMapEntrances.id, {
      onDelete: 'set null',
    }),
    allowCheckOut: boolean('allow_check_out').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'scanner_device_events_pk', columns: [t.deviceId, t.eventId] }),
    index('scanner_device_events_event_idx').on(t.eventId),
  ],
);

/** One-time QR pairing codes shown in the Admin Portal and scanned by the app. */
export const devicePairingCodes = pgTable(
  'device_pairing_codes',
  {
    id: id(),
    codeHash: text('code_hash').notNull(),
    label: text('label'),
    eventId: uuid('event_id').references((): AnyPgColumn => events.id, { onDelete: 'cascade' }),
    entranceId: uuid('entrance_id').references((): AnyPgColumn => seatMapEntrances.id, {
      onDelete: 'set null',
    }),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
    deviceId: uuid('device_id').references(() => scannerDevices.id, { onDelete: 'set null' }),
    createdByUserId: uuid('created_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('device_pairing_codes_hash_uq').on(t.codeHash),
    index('device_pairing_codes_expires_idx').on(t.expiresAt),
  ],
);

/**
 * Events (with entrance and check-out permission per event) a pairing code grants. The code is
 * exchanged by the app for a device token; these rows are copied to `scanner_device_events`.
 * (The legacy single `event_id` / `entrance_id` columns of the code itself are unused.)
 */
export const devicePairingCodeEvents = pgTable(
  'device_pairing_code_events',
  {
    codeId: uuid('code_id')
      .notNull()
      .references(() => devicePairingCodes.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references((): AnyPgColumn => events.id, { onDelete: 'cascade' }),
    entranceId: uuid('entrance_id').references((): AnyPgColumn => seatMapEntrances.id, {
      onDelete: 'set null',
    }),
    allowCheckOut: boolean('allow_check_out').notNull().default(true),
  },
  (t) => [primaryKey({ name: 'device_pairing_code_events_pk', columns: [t.codeId, t.eventId] })],
);

/**
 * Per-event secret that scanners at one venue share (distributed in the manifest) to
 * authenticate peer-to-peer (LAN) messages with HMAC. Stored encrypted (secret box, AAD
 * `scanner-lan:<event id>`), created on first use.
 */
export const eventScannerSecrets = pgTable('event_scanner_secrets', {
  eventId: uuid('event_id')
    .primaryKey()
    .references((): AnyPgColumn => events.id, { onDelete: 'cascade' }),
  lanSecretEncrypted: text('lan_secret_encrypted').notNull(),
  createdAt: createdAt(),
});

/**
 * Singleton: the sync epoch of the scanner delta sync. Backup restores rotate it (inside the
 * restore transaction); devices that see a new epoch wipe their local tickets and resync.
 */
export const scannerSyncState = pgTable(
  'scanner_sync_state',
  {
    id: boolean('id').primaryKey().default(true),
    syncEpoch: text('sync_epoch').notNull(),
  },
  (t) => [check('scanner_sync_state_singleton', sql`${t.id}`)],
);

/** Uploaded signed APKs of the Android scanner app (object in the documents bucket). */
export const scannerApkReleases = pgTable(
  'scanner_apk_releases',
  {
    id: id(),
    versionName: text('version_name').notNull(),
    versionCode: integer('version_code').notNull(),
    objectKey: text('object_key').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    notes: text('notes'),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    /** The release offered to devices and staff downloads. At most one. */
    isCurrent: boolean('is_current').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique('scanner_apk_releases_version_code_uq').on(t.versionCode),
    uniqueIndex('scanner_apk_releases_single_current_uq')
      .on(t.isCurrent)
      .where(sql`${t.isCurrent}`),
    check('scanner_apk_releases_version_code_pos', sql`${t.versionCode} > 0`),
  ],
);

/**
 * Immutable scan journal (online + uploaded offline scans). `(device_id, client_scan_id)`
 * makes offline batch uploads idempotent. The current state per ticket is denormalised on
 * `tickets.check_in_state`.
 */
export const checkInLogs = pgTable(
  'check_in_logs',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references((): AnyPgColumn => events.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id').references((): AnyPgColumn => tickets.id, { onDelete: 'set null' }),
    deviceId: uuid('device_id').references(() => scannerDevices.id, { onDelete: 'set null' }),
    /** UUID generated on the device per scan. */
    clientScanId: uuid('client_scan_id'),
    staffUserId: uuid('staff_user_id').references(() => adminUsers.id, { onDelete: 'set null' }),
    entranceId: uuid('entrance_id').references((): AnyPgColumn => seatMapEntrances.id, {
      onDelete: 'set null',
    }),
    action: scanActionEnum('action').notNull(),
    source: scanSourceEnum('source').notNull(),
    result: scanResultEnum('result').notNull(),
    warnings: scanWarningEnum('warnings')
      .array()
      .notNull()
      .default(sql`'{}'::scan_warning[]`),
    /** Raw scanned content, truncated to 512 chars (for forensic analysis of rejects). */
    rawPayload: text('raw_payload'),
    message: text('message'),
    /** Device clock at scan time. */
    scannedAt: tstz('scanned_at').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    wasOffline: boolean('was_offline').notNull().default(false),
  },
  (t) => [
    unique('check_in_logs_client_scan_uq').on(t.deviceId, t.clientScanId),
    index('check_in_logs_event_idx').on(t.eventId, t.scannedAt),
    index('check_in_logs_ticket_idx').on(t.ticketId, t.scannedAt),
    check(
      'check_in_logs_raw_payload_len',
      sql`${t.rawPayload} IS NULL OR char_length(${t.rawPayload}) <= 512`,
    ),
  ],
);
