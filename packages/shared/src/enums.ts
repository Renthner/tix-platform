/**
 * Single source of truth for every domain enumeration.
 *
 * The tuples are consumed by:
 *  - `@tix/db` to create PostgreSQL enum types (pgEnum),
 *  - Zod schemas (z.enum) for request validation,
 *  - the web UI for labels/filters.
 *
 * Adding a value requires a new DB migration (`pnpm db:generate`).
 * Never remove or rename a value that may already be persisted.
 */

const values = <const T extends readonly [string, ...string[]]>(...v: T): T => v;

// ─── Identity & access ──────────────────────────────────────────────────────
export const ADMIN_ROLES = values('SUPER_ADMIN', 'EVENT_MANAGER', 'FINANCE', 'DOOR_STAFF');
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Who triggered a state change (order history, audit log). */
export const ACTOR_TYPES = values('SYSTEM', 'ADMIN', 'CUSTOMER', 'WEBHOOK', 'DEVICE');
export type ActorType = (typeof ACTOR_TYPES)[number];

/** Single-use tokens of optional customer accounts. */
export const CUSTOMER_TOKEN_PURPOSES = values('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'LOGIN_LINK');
export type CustomerTokenPurpose = (typeof CUSTOMER_TOKEN_PURPOSES)[number];

// ─── Media / object storage ─────────────────────────────────────────────────
export const MEDIA_ASSET_KINDS = values(
  'EVENT_IMAGE',
  'VENUE_BACKGROUND',
  'TICKET_BACKGROUND',
  'LOGO',
  'WALLET_IMAGE',
  'EMAIL_IMAGE',
  'DOCUMENT',
  'OTHER',
);
export type MediaAssetKind = (typeof MEDIA_ASSET_KINDS)[number];

// ─── Venues & seat maps ─────────────────────────────────────────────────────
/** TEMPLATE = reusable venue layout, EVENT = per-event copy that carries inventory. */
export const SEAT_MAP_KINDS = values('TEMPLATE', 'EVENT');
export type SeatMapKind = (typeof SEAT_MAP_KINDS)[number];

/** SEATED = numbered seats in rows/tables, STANDING = general admission block with capacity counter. */
export const SECTION_TYPES = values('SEATED', 'STANDING');
export type SectionType = (typeof SECTION_TYPES)[number];

/** Non-inventory drawables of the seating editor. */
export const SEAT_MAP_ELEMENT_TYPES = values(
  'STAGE',
  'TABLE',
  'TEXT',
  'SHAPE',
  'LINE',
  'IMAGE',
  'EXIT',
  'FACILITY',
);
export type SeatMapElementType = (typeof SEAT_MAP_ELEMENT_TYPES)[number];

/** Why a seat is withheld from sale (Sperrplätze). */
export const SEAT_BLOCK_REASONS = values('PRESS', 'VIP', 'TECHNICAL', 'ARTIST', 'OTHER');
export type SeatBlockReason = (typeof SEAT_BLOCK_REASONS)[number];

/** Seat features that ticket types can be restricted to (wheelchair + companion). */
export const SEAT_FEATURES = values('WHEELCHAIR_SPACE', 'COMPANION_SEAT');
export type SeatFeature = (typeof SEAT_FEATURES)[number];

/**
 * Effective, derived status of a seat as shown on the public seating chart.
 * Not persisted as such: computed from seats.block_reason, active order items and Redis locks.
 */
export const SEAT_AVAILABILITY = values('AVAILABLE', 'LOCKED', 'RESERVED', 'SOLD', 'BLOCKED');
export type SeatAvailability = (typeof SEAT_AVAILABILITY)[number];

/** What an SVG symbol from the library is meant for. */
export const SYMBOL_KINDS = values('SEAT', 'ELEMENT');
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

/** How the customer's own seats are highlighted on the public seating chart. */
export const SEAT_SELECTION_STYLES = values('RING', 'FILL', 'BOTH');
export type SeatSelectionStyle = (typeof SEAT_SELECTION_STYLES)[number];

/**
 * Seat orientation of a row: ROW = perpendicular to the row curve (plus an optional
 * offset, e.g. 180° to turn the seats around); FIXED = absolute direction for all seats
 * (0° = facing up, 90° = right, -90° = left, 45° = diagonal …).
 */
export const SEAT_ORIENTATION_MODES = values('ROW', 'FIXED');

/** Size presets of info boxes on the event page (text and icon separately). */
export const INFO_BOX_SIZES = values('S', 'M', 'L', 'XL');
export type InfoBoxSize = (typeof INFO_BOX_SIZES)[number];

/** Plan label of wheelchair / companion seats: type icon, seat number, custom text, nothing. */
export const SPECIAL_SEAT_LABEL_MODES = values('ICON', 'NUMBER', 'TEXT', 'NONE');
export type SpecialSeatLabelMode = (typeof SPECIAL_SEAT_LABEL_MODES)[number];
export type SeatOrientationMode = (typeof SEAT_ORIENTATION_MODES)[number];

/** Upper bound of seats / spots handled in one cart request (also best-available). */
export const MAX_SEATS_PER_REQUEST = 50;

// ─── Events & pricing ───────────────────────────────────────────────────────
export const EVENT_STATUSES = values('DRAFT', 'PUBLISHED', 'POSTPONED', 'CANCELLED', 'ARCHIVED');
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const DISCOUNT_KINDS = values('NONE', 'PERCENT', 'FIXED_AMOUNT', 'FIXED_PRICE');
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

/**
 * PER_TICKET – per ticket of the event
 * PER_EVENT  – once per order for each event that has tickets in the order
 * PER_ORDER  – once per order, independent of how many events it contains (global fees only)
 */
export const FEE_SCOPES = values('PER_TICKET', 'PER_EVENT', 'PER_ORDER');
export type FeeScope = (typeof FEE_SCOPES)[number];

export const FEE_CALCULATIONS = values('FIXED', 'PERCENT');
export type FeeCalculation = (typeof FEE_CALCULATIONS)[number];

export const SALES_CHANNELS = values('ONLINE', 'BOX_OFFICE', 'ADMIN');
export type SalesChannel = (typeof SALES_CHANNELS)[number];

/** Ed25519 key lifecycle. RETIRED keys still verify already issued tickets, REVOKED keys do not. */
export const SIGNING_KEY_STATUSES = values('ACTIVE', 'RETIRED', 'REVOKED');
export type SigningKeyStatus = (typeof SIGNING_KEY_STATUSES)[number];

// ─── Virtual waiting room ───────────────────────────────────────────────────
export const QUEUE_MODES = values(
  'OFF',
  'AUTO_THRESHOLD',
  'SCHEDULED_PRE_REGISTRATION',
  'VIP_CODE_ONLY',
  'HYBRID',
);
export type QueueMode = (typeof QUEUE_MODES)[number];

/** How pre-registered lobby participants are ordered at T-0. */
export const QUEUE_ADMISSION_ORDERS = values('FIFO', 'RANDOMIZED');
export type QueueAdmissionOrder = (typeof QUEUE_ADMISSION_ORDERS)[number];

export const ANNOUNCEMENT_SEVERITIES = values('INFO', 'WARNING', 'CRITICAL');
export type AnnouncementSeverity = (typeof ANNOUNCEMENT_SEVERITIES)[number];

export const ACCESS_CODE_TYPES = values('SINGLE_USE', 'MULTI_USE');
export type AccessCodeType = (typeof ACCESS_CODE_TYPES)[number];

// ─── Orders, payments, invoicing ────────────────────────────────────────────
/**
 * PENDING           – checkout started, online payment (PayPal) in flight
 * AWAITING_PAYMENT  – Vorkasse: seats RESERVED_PENDING_PAYMENT in PostgreSQL
 * PAID              – fully paid, tickets issued
 * CANCELLED         – cancelled by admin/customer (seats released)
 * EXPIRED           – payment deadline / PayPal approval window passed (seats released)
 * REFUNDED          – fully refunded after payment
 * PARTIALLY_REFUNDED– some items/amount refunded, remaining tickets stay valid
 */
export const ORDER_STATUSES = values(
  'PENDING',
  'AWAITING_PAYMENT',
  'PAID',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
);
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_ITEM_KINDS = values('SEAT', 'GENERAL_ADMISSION');
export type OrderItemKind = (typeof ORDER_ITEM_KINDS)[number];

/** PENDING and CONFIRMED items occupy inventory; CANCELLED and REFUNDED release it. */
export const ORDER_ITEM_STATUSES = values('PENDING', 'CONFIRMED', 'CANCELLED', 'REFUNDED');
export type OrderItemStatus = (typeof ORDER_ITEM_STATUSES)[number];
export const INVENTORY_HOLDING_ITEM_STATUSES = [
  'PENDING',
  'CONFIRMED',
] as const satisfies readonly OrderItemStatus[];

export const PAYMENT_METHODS = values('PAYPAL', 'BANK_TRANSFER', 'CASH', 'CARD', 'COMPLIMENTARY');
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = values(
  'CREATED',
  'APPROVED',
  'CAPTURED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
);
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** AUTOMATIC = executed via the provider API; MANUAL = open to-do for the finance team. */
export const REFUND_KINDS = values('AUTOMATIC', 'MANUAL');
export type RefundKind = (typeof REFUND_KINDS)[number];

export const REFUND_STATUSES = values('PENDING', 'SUCCEEDED', 'FAILED');
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** Additional payment requested for a paid order (see `order_adjustments`). */
export const ADJUSTMENT_KINDS = values('TARIFF_UPGRADE');
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

/** PROPOSED (customer has not confirmed) → CONFIRMED → PAID, or CANCELLED (admin reset). */
export const ADJUSTMENT_STATUSES = values('PROPOSED', 'CONFIRMED', 'PAID', 'CANCELLED');
export type AdjustmentStatus = (typeof ADJUSTMENT_STATUSES)[number];

/** INVOICE = Rechnung, CREDIT_NOTE = Rechnungskorrektur/Stornorechnung (references the original). */
export const INVOICE_TYPES = values('INVOICE', 'CREDIT_NOTE');
export type InvoiceType = (typeof INVOICE_TYPES)[number];

export const WEBHOOK_EVENT_STATUSES = values('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

// ─── Tickets & check-in ─────────────────────────────────────────────────────
export const TICKET_STATUSES = values('VALID', 'CANCELLED', 'REFUNDED', 'REPLACED');
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const CHECK_IN_STATES = values('NONE', 'CHECKED_IN', 'CHECKED_OUT');
export type CheckInState = (typeof CHECK_IN_STATES)[number];

export const SCAN_ACTIONS = values('CHECK_IN', 'CHECK_OUT');
export type ScanAction = (typeof SCAN_ACTIONS)[number];

export const SCAN_SOURCES = values('CAMERA', 'MANUAL');
export type ScanSource = (typeof SCAN_SOURCES)[number];

/** ACCEPTED → GREEN, ACCEPTED_WITH_WARNING → YELLOW, REJECTED_* → RED. */
export const SCAN_RESULTS = values(
  'ACCEPTED',
  'ACCEPTED_WITH_WARNING',
  'REJECTED_ALREADY_CHECKED_IN',
  'REJECTED_NOT_CHECKED_IN',
  'REJECTED_INVALID_SIGNATURE',
  'REJECTED_WRONG_EVENT',
  'REJECTED_TICKET_VOID',
  'REJECTED_UNKNOWN_TICKET',
  'REJECTED_MALFORMED',
  'REJECTED_CHECK_OUT_NOT_ALLOWED',
);
export type ScanResult = (typeof SCAN_RESULTS)[number];

/** Warning codes attached to ACCEPTED_WITH_WARNING scans. */
export const SCAN_WARNINGS = values(
  'DISCOUNT_PROOF_REQUIRED',
  'WRONG_ENTRANCE',
  'SEAT_FEATURE',
  'ADDITIONAL_PAYMENT_OPEN',
);
export type ScanWarning = (typeof SCAN_WARNINGS)[number];

// ─── Banking & reconciliation ───────────────────────────────────────────────
export const BANK_ADAPTERS = values(
  'FINTS',
  'PSD2_GOCARDLESS',
  'PSD2_FINAPI',
  'FILE_IMPORT',
  'IMAP',
);
export type BankAdapter = (typeof BANK_ADAPTERS)[number];

export const BANK_SYNC_TRIGGERS = values('SCHEDULED', 'MANUAL', 'UPLOAD', 'IMAP');
export type BankSyncTrigger = (typeof BANK_SYNC_TRIGGERS)[number];

export const BANK_SYNC_STATUSES = values(
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TAN_REQUIRED',
  'CANCELLED',
);
export type BankSyncStatus = (typeof BANK_SYNC_STATUSES)[number];

export const TAN_CHALLENGE_STATUSES = values(
  'PENDING',
  'SUBMITTED',
  'COMPLETED',
  'EXPIRED',
  'FAILED',
);
export type TanChallengeStatus = (typeof TAN_CHALLENGE_STATUSES)[number];

export const BANK_STATEMENT_FORMATS = values('CAMT052', 'CAMT053', 'MT940', 'CSV');
export type BankStatementFormat = (typeof BANK_STATEMENT_FORMATS)[number];

export const BANK_IMPORT_SOURCES = values('UPLOAD', 'IMAP', 'FINTS', 'PSD2');
export type BankImportSource = (typeof BANK_IMPORT_SOURCES)[number];

export const BANK_IMPORT_STATUSES = values('PROCESSING', 'COMPLETED', 'FAILED');
export type BankImportStatus = (typeof BANK_IMPORT_STATUSES)[number];

/**
 * UNMATCHED        – imported, matcher not yet run
 * AUTO_MATCHED     – reference + exact amount matched, order fulfilled automatically
 * MANUALLY_MATCHED – resolved by an admin in the Klärfälle dashboard
 * NEEDS_REVIEW     – Klärfall (see review reason)
 * IGNORED          – debit or unrelated credit, explicitly dismissed
 */
export const BANK_TX_MATCH_STATUSES = values(
  'UNMATCHED',
  'AUTO_MATCHED',
  'MANUALLY_MATCHED',
  'NEEDS_REVIEW',
  'IGNORED',
);
export type BankTxMatchStatus = (typeof BANK_TX_MATCH_STATUSES)[number];

export const BANK_TX_REVIEW_REASONS = values(
  'NO_REFERENCE',
  'UNKNOWN_REFERENCE',
  'UNDERPAYMENT',
  'OVERPAYMENT',
  'ORDER_NOT_PAYABLE',
  'AMBIGUOUS',
  'NAME_MATCH_ONLY',
  'CURRENCY_MISMATCH',
);
export type BankTxReviewReason = (typeof BANK_TX_REVIEW_REASONS)[number];

export const ALLOCATION_METHODS = values('AUTO', 'MANUAL');
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];

// ─── Communication ──────────────────────────────────────────────────────────
export const EMAIL_TEMPLATE_KEYS = values(
  'ORDER_CONFIRMATION_BANK_TRANSFER',
  'PAYMENT_RECEIVED_TICKETS',
  'PAYMENT_REMINDER',
  'ORDER_CANCELLED',
  'REFUND_CONFIRMATION',
  'ADDITIONAL_PAYMENT_REQUEST',
  'ADDITIONAL_PAYMENT_REMINDER',
  'ADDITIONAL_PAYMENT_CANCELLED',
  'ADDITIONAL_PAYMENT_RECEIVED',
  'ADDITIONAL_PAYMENT_SETTLED_BY_CREDIT',
  'TICKETS_RESENT',
  'CUSTOMER_EMAIL_VERIFICATION',
  'CUSTOMER_PASSWORD_RESET',
  'CUSTOMER_LOGIN_LINK',
  'SMTP_TEST',
  'ADMIN_INVITE',
  'ADMIN_PASSWORD_RESET',
);
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

export const EMAIL_STATUSES = values('QUEUED', 'SENDING', 'SENT', 'FAILED');
export type EmailStatus = (typeof EMAIL_STATUSES)[number];
