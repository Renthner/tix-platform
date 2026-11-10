import { z } from 'zod';

export const BACKUP_KINDS = ['MANUAL', 'SCHEDULED', 'PRE_RESTORE'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export const BACKUP_FORMAT_VERSION = 1;
/** Entry names inside the archive. */
export const ARCHIVE_MANIFEST = 'manifest.json';
export const ARCHIVE_DUMP = 'db.dump';
export const ARCHIVE_FILES_PREFIX = 'files/';
export const BACKUP_PREFIX = 'backups/';

const fileStats = z.object({ objects: z.number().int().min(0), bytes: z.number().int().min(0) });

const migrationInfo = z.object({
  /** Millisecond timestamp of the newest applied migration (drizzle `created_at`). */
  when: z.number().int().min(0),
  /** Migration file name when it could be resolved from the code's journal. */
  tag: z.string().nullable(),
  /** Number of applied migrations. */
  count: z.number().int().min(0),
});
export type MigrationInfo = z.infer<typeof migrationInfo>;

/**
 * Description of one backup. Stored twice: as the first entry inside the encrypted archive
 * (`archive` / `files` still unknown then) and, completed, as the unencrypted
 * `manifest.json` next to the archive (this is what the catalogue lists).
 */
export const backupManifestSchema = z.object({
  formatVersion: z.literal(BACKUP_FORMAT_VERSION),
  id: z.uuid(),
  kind: z.enum(BACKUP_KINDS),
  createdAt: z.iso.datetime(),
  appVersion: z.string().max(64),
  lastMigration: migrationInfo,
  postgresVersion: z.string().max(64),
  encryption: z.object({ algorithm: z.literal('AES-256-GCM-STREAM'), keyId: z.string().max(16) }),
  /** Row counts of key tables taken in the same snapshot as the dump. */
  rowCounts: z.record(z.string(), z.number().int().min(0)),
  createdByUserId: z.uuid().nullable().default(null),
  /** Set for archives that were uploaded by an admin (id of the original backup). */
  originalId: z.uuid().optional(),
  /** Known only after the archive was written. */
  archive: z
    .object({ sizeBytes: z.number().int().min(0), sha256: z.string().length(64) })
    .optional(),
  database: z.object({ dumpBytes: z.number().int().min(0) }).optional(),
  files: z.object({ assets: fileStats, documents: fileStats }).optional(),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export const externalStatusSchema = z.object({
  status: z.enum(['NONE', 'UPLOADED', 'FAILED']),
  at: z.iso.datetime().optional(),
  error: z.string().max(500).optional(),
});
export const verifyResultSchema = z.object({
  status: z.enum(['OK', 'FAILED']),
  at: z.iso.datetime(),
  /** Human-readable reason (never contains secrets). */
  detail: z.string().max(1_000).optional(),
  mismatches: z.array(z.string().max(200)).max(50).optional(),
});
/** Mutable sidecar (`state.json`) next to the immutable manifest. */
export const backupStateSchema = z.object({
  external: externalStatusSchema.default({ status: 'NONE' }),
  verify: verifyResultSchema.optional(),
});
export type BackupState = z.infer<typeof backupStateSchema>;
export type VerifyResult = z.infer<typeof verifyResultSchema>;

const compactTimestamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Bucket directory of a backup: `backups/<timestamp>-<kind>-<id>/`. */
export function backupDirectory(
  manifest: Pick<BackupManifest, 'id' | 'kind' | 'createdAt'>,
): string {
  return `${BACKUP_PREFIX}${compactTimestamp(manifest.createdAt)}-${manifest.kind}-${manifest.id}/`;
}

/** Directory of an uploaded archive before validation (id is the upload id). */
export const incomingDirectory = (uploadId: string) => `${BACKUP_PREFIX}incoming-${uploadId}/`;

export const archiveKey = (directory: string) => `${directory}archive.tixbak`;
export const manifestKey = (directory: string) => `${directory}manifest.json`;
export const stateKey = (directory: string) => `${directory}state.json`;

/** Row-count tables captured in every backup (whitelist – used in SQL). */
export const BACKUP_COUNT_TABLES = [
  'events',
  'venues',
  'seats',
  'orders',
  'order_items',
  'payments',
  'refunds',
  'order_adjustments',
  'invoices',
  'tickets',
  'bank_transactions',
  'customers',
  'admin_users',
  'email_messages',
  'media_assets',
  'system_settings',
  'number_sequences',
] as const;
