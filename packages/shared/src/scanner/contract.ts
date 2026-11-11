import { z } from 'zod';
import { CHECK_IN_STATES, SCAN_ACTIONS, SCAN_RESULTS, SCAN_SOURCES, SCAN_WARNINGS } from '../enums';

/**
 * Device API contract (`/api/scanner/v1/*`). Request schemas validate on the server; response
 * schemas document the wire format (docs/SCANNER.md) and are used by the tests.
 */

/** UUIDs are normalised to lower case so string comparisons on the server are safe. */
const uuid = z.uuid().transform((value) => value.toLowerCase());
const isoTime = z.iso.datetime({ offset: true });

export const SCAN_BATCH_MAX = 200;
export const SYNC_PAGE_DEFAULT = 500;
export const SYNC_PAGE_MAX = 1_000;
export const LOOKUP_LIMIT_MAX = 50;
/** A device clock further in the future than this is clamped to the server receive time. */
export const SCAN_CLOCK_SKEW_SECONDS = 300;

// ─── Requests ───────────────────────────────────────────────────────────────

export const pairRequestSchema = z.object({
  code: z.string().trim().min(8).max(32),
  deviceName: z.string().trim().min(1).max(80),
  platform: z.string().trim().max(40).optional(),
  appVersion: z.string().trim().max(40).optional(),
  deviceModel: z.string().trim().max(80).optional(),
});
export type PairRequest = z.infer<typeof pairRequestSchema>;

export const syncQuerySchema = z.object({
  eventId: uuid,
  /** Opaque cursor from the previous response (`nextCursor`); empty / absent = full sync. */
  cursor: z.string().max(200).default(''),
  limit: z.coerce.number().int().min(1).max(SYNC_PAGE_MAX).default(SYNC_PAGE_DEFAULT),
});
export type SyncQuery = z.infer<typeof syncQuerySchema>;

/**
 * One scan. Exactly one of `payload` (camera: the QR text, signature verified by the server),
 * `ticketId` or `ticketCode` (manual lookup result) identifies the ticket.
 */
export const scanRequestSchema = z
  .object({
    clientScanId: uuid,
    eventId: uuid,
    action: z.enum(SCAN_ACTIONS),
    source: z.enum(SCAN_SOURCES),
    /** Longer than a real ticket payload (400) is accepted and answered REJECTED_MALFORMED. */
    payload: z.string().min(1).max(2048).optional(),
    ticketId: uuid.optional(),
    ticketCode: z.string().trim().min(4).max(32).optional(),
    /** Device clock; clamped when it lies in the future. */
    scannedAt: isoTime,
    entranceId: uuid.nullish(),
  })
  .refine(
    (v) => [v.payload, v.ticketId, v.ticketCode].filter((x) => x !== undefined).length === 1,
    { message: 'Exactly one of payload, ticketId, ticketCode is required' },
  );
export type ScanRequest = z.infer<typeof scanRequestSchema>;

export const scanBatchRequestSchema = z.object({
  /**
   * Device clock when the request was sent. The server corrects every scannedAt of the batch by
   * `serverNow - sentAt` (device clock skew). Absent = no correction.
   */
  sentAt: isoTime.optional(),
  scans: z.array(scanRequestSchema).min(1).max(SCAN_BATCH_MAX),
});
export type ScanBatchRequest = z.infer<typeof scanBatchRequestSchema>;

export const lookupQuerySchema = z.object({
  eventId: uuid,
  q: z.string().trim().min(2).max(80),
  limit: z.coerce.number().int().min(1).max(LOOKUP_LIMIT_MAX).default(20),
});
export type LookupQuery = z.infer<typeof lookupQuerySchema>;

// ─── Responses ──────────────────────────────────────────────────────────────

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const pairResponseSchema = z.object({
  apiVersion: z.number().int(),
  deviceId: uuid,
  deviceName: z.string(),
  /** Shown exactly once; send as `Authorization: Bearer <token>`. */
  token: z.string(),
  serverTime: isoTime,
});
export type PairResponse = z.infer<typeof pairResponseSchema>;

const seatFeatureSchema = z.enum(['WHEELCHAIR_SPACE', 'COMPANION_SEAT']);

export const manifestEventSchema = z.object({
  id: uuid,
  title: z.string(),
  subtitle: z.string().nullable(),
  startsAt: isoTime,
  doorsOpenAt: isoTime.nullable(),
  endsAt: isoTime.nullable(),
  timeZone: z.string(),
  venueName: z.string(),
  /** Entrance this device is stationed at (null = not fixed). */
  entranceId: uuid.nullable(),
  /** Global setting AND the permission of this device for the event. */
  allowCheckOut: z.boolean(),
  /** `publicKey` is null for REVOKED keys: delete the key; tickets signed with it are invalid. */
  keys: z.array(
    z.object({
      keyId: z.string(),
      status: z.enum(['ACTIVE', 'RETIRED', 'REVOKED']),
      publicKey: z.string().nullable(),
    }),
  ),
  ticketTypes: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      requiresProof: z.boolean(),
      scannerWarning: z.string().nullable(),
    }),
  ),
  categories: z.array(z.object({ id: uuid, name: z.string(), color: z.string() })),
  entrances: z.array(z.object({ id: uuid, name: z.string(), code: z.string() })),
  /** Block to entrance mapping used for the WRONG_ENTRANCE warning. */
  sections: z.array(z.object({ id: uuid, name: z.string(), entranceId: uuid.nullable() })),
  /** `secret` (base64url, 32 bytes) is null when LAN sync is disabled. */
  lan: z.object({ enabled: z.boolean(), secret: z.string().nullable() }),
});
export type ManifestEvent = z.infer<typeof manifestEventSchema>;

export const manifestSchema = z.object({
  apiVersion: z.number().int(),
  serverTime: isoTime,
  /** Hash of the content (without serverTime): equal etag means nothing changed. */
  etag: z.string(),
  /** Changes when the server database was restored: wipe local tickets and cursors, resync. */
  syncEpoch: z.string(),
  device: z.object({ id: uuid, name: z.string() }),
  settings: z.object({
    offlineModeAllowed: z.boolean(),
    lanSyncEnabled: z.boolean(),
    syncIntervalSeconds: z.number().int(),
  }),
  events: z.array(manifestEventSchema),
});
export type Manifest = z.infer<typeof manifestSchema>;

export const syncTicketSchema = z.object({
  id: uuid,
  ticketCode: z.string(),
  /** Anything but VALID is a tombstone: the ticket must be rejected as void. */
  status: z.enum(['VALID', 'CANCELLED', 'REFUNDED', 'REPLACED']),
  eventId: uuid,
  keyId: z.string(),
  sectionId: uuid,
  sectionLabel: z.string(),
  rowLabel: z.string().nullable(),
  seatLabel: z.string().nullable(),
  seatFeature: seatFeatureSchema.nullable(),
  categoryId: uuid,
  categoryName: z.string(),
  ticketTypeId: uuid,
  attendeeName: z.string().nullable(),
  checkInState: z.enum(CHECK_IN_STATES),
  firstCheckedInAt: isoTime.nullable(),
  firstCheckedInDeviceName: z.string().nullable(),
  checkInCount: z.number().int(),
  lastScanAt: isoTime.nullable(),
  additionalPaymentOpen: z.boolean(),
  syncVersion: z.number().int(),
});
export type SyncTicket = z.infer<typeof syncTicketSchema>;

export const syncPageSchema = z.object({
  tickets: z.array(syncTicketSchema),
  /**
   * Opaque cursor: send it as `cursor` for the next page (hasMore) or the next sync run (!hasMore).
   * Tickets may repeat across runs; upsert by id and keep the highest syncVersion.
   */
  nextCursor: z.string(),
  /** Same as in the manifest; a different value than the stored one = wipe and resync. */
  syncEpoch: z.string(),
  /** More pages are available right now. */
  hasMore: z.boolean(),
  serverTime: isoTime,
});
export type SyncPage = z.infer<typeof syncPageSchema>;

export const scanTicketDisplaySchema = z.object({
  id: uuid,
  ticketCode: z.string(),
  status: z.enum(['VALID', 'CANCELLED', 'REFUNDED', 'REPLACED']),
  attendeeName: z.string().nullable(),
  categoryName: z.string(),
  ticketTypeName: z.string(),
  sectionLabel: z.string(),
  rowLabel: z.string().nullable(),
  seatLabel: z.string().nullable(),
  seatFeature: seatFeatureSchema.nullable(),
  checkInState: z.enum(CHECK_IN_STATES),
});
export type ScanTicketDisplay = z.infer<typeof scanTicketDisplaySchema>;

export const scanOutcomeSchema = z.object({
  clientScanId: uuid,
  result: z.enum(SCAN_RESULTS),
  color: z.enum(['GREEN', 'YELLOW', 'RED']),
  warnings: z.array(z.enum(SCAN_WARNINGS)),
  /** Texts for warnings that carry one (DISCOUNT_PROOF_REQUIRED = the ticket type scanner_warning). */
  warningTexts: z.record(z.string(), z.string()),
  /** The scan had been recorded before (retry): the original decision is returned. */
  duplicate: z.boolean(),
  /** false = not written to the journal (e.g. the event is not assigned to this device). */
  recorded: z.boolean(),
  ticket: scanTicketDisplaySchema.nullable(),
  /** First check-in of the ticket (for REJECTED_ALREADY_CHECKED_IN: who/when got in first). */
  firstScan: z.object({ at: isoTime, deviceName: z.string().nullable() }).nullable(),
});
export type ScanOutcome = z.infer<typeof scanOutcomeSchema>;

export const scanBatchResponseSchema = z.object({
  results: z.array(scanOutcomeSchema),
  serverTime: isoTime,
});
export type ScanBatchResponse = z.infer<typeof scanBatchResponseSchema>;

export const lookupResponseSchema = z.object({
  tickets: z.array(
    scanTicketDisplaySchema.extend({
      orderNumber: z.string(),
      buyerName: z.string(),
      firstCheckedInAt: isoTime.nullable(),
    }),
  ),
});
export type LookupResponse = z.infer<typeof lookupResponseSchema>;

export const appLatestResponseSchema = z.object({
  versionName: z.string(),
  versionCode: z.number().int(),
  sha256: z.string(),
  sizeBytes: z.number().int(),
  notes: z.string().nullable(),
  /** Time-limited signed URL (no further authentication needed). */
  downloadUrl: z.string(),
  /** Seconds the URL stays valid. */
  downloadUrlTtlSeconds: z.number().int(),
});
export type AppLatestResponse = z.infer<typeof appLatestResponseSchema>;
