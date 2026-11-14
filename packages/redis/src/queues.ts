/**
 * BullMQ queue names shared by producers (web) and consumers (worker).
 * Processors are registered per phase; the names are fixed here so producers and the
 * worker can never drift apart.
 */
export const QUEUE_NAMES = {
  /** Housekeeping: expired sessions / pairing codes (Phase 1). */
  maintenance: 'maintenance',
  /** Seat-lock expiry sweeper → SEAT_RELEASED broadcasts (Phase 2). */
  seatLocks: 'seat-locks',
  /** FinTS / PSD2 / IMAP polling and statement imports (Phase 3). */
  bankSync: 'bank-sync',
  /** Vorkasse payment reminders and automatic cancellation (Phase 3). */
  dunning: 'dunning',
  /** Ticket PDFs, invoices, Apple/Google Wallet passes (Phase 4). */
  documents: 'documents',
  /** Transactional e-mail dispatch (Phase 4). */
  email: 'email',
  /** Provider refunds (PayPal) and the sweeper for stuck ones (Phase 5). */
  refunds: 'refunds',
  /** Full backups, verification and restore (Phase 5). */
  backups: 'backups',
  /** GDPR retention: e-mail log purge, erasure of expired order data (Phase 5). */
  privacy: 'privacy',
  /** AVIF / WebP variants of uploaded images (backfill of existing assets). */
  media: 'media',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
