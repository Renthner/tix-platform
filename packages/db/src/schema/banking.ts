import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { BankConnectionConfig, MatchCandidate } from '@tix/shared';
import { cents, createdAt, currency, id, timestamps, tstz } from './_columns';
import { adminUsers } from './auth';
import {
  allocationMethodEnum,
  bankAdapterEnum,
  bankImportSourceEnum,
  bankImportStatusEnum,
  bankStatementFormatEnum,
  bankSyncStatusEnum,
  bankSyncTriggerEnum,
  bankTxMatchStatusEnum,
  bankTxReviewReasonEnum,
  tanChallengeStatusEnum,
} from './enums';
import { orders, payments } from './orders';

/** Receiving bank accounts (shown in Vorkasse payment instructions). */
export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: id(),
    name: text('name').notNull(),
    accountHolder: text('account_holder').notNull(),
    iban: text('iban').notNull(),
    bic: text('bic'),
    bankCode: text('bank_code'),
    bankName: text('bank_name'),
    currency: currency().notNull(),
    /** The account printed on Vorkasse confirmations. */
    isDefaultForBankTransfer: boolean('is_default_for_bank_transfer').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('bank_accounts_iban_uq').on(t.iban),
    uniqueIndex('bank_accounts_single_default_uq')
      .on(t.isDefaultForBankTransfer)
      .where(sql`${t.isDefaultForBankTransfer}`),
    check('bank_accounts_iban_format', sql`${t.iban} ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'`),
    check(
      'bank_accounts_bic_format',
      sql`${t.bic} IS NULL OR ${t.bic} ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'`,
    ),
    check(
      'bank_accounts_bank_code_format',
      sql`${t.bankCode} IS NULL OR ${t.bankCode} ~ '^[0-9]{8}$'`,
    ),
  ],
);

/**
 * Reconciliation adapters per account: FinTS 3.0, PSD2 (GoCardless / finAPI),
 * file import (CAMT/MT940/CSV) and IMAP watcher. Non-secret parameters in `config`
 * (validated by `bankConnectionConfigSchema`), secrets encrypted in `credentials_encrypted`.
 */
export const bankConnections = pgTable(
  'bank_connections',
  {
    id: id(),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'cascade' }),
    adapter: bankAdapterEnum('adapter').notNull(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /** NULL = manual sync only. */
    pollIntervalSeconds: integer('poll_interval_seconds'),
    config: jsonb('config').$type<BankConnectionConfig>().notNull(),
    credentialsEncrypted: text('credentials_encrypted'),
    /** Adapter runtime state (FinTS system id / BPD+UPD versions, PSD2 requisition …). */
    state: jsonb('state').notNull().default({}),
    consentExpiresAt: tstz('consent_expires_at'),
    lastSyncAt: tstz('last_sync_at'),
    lastSuccessfulSyncAt: tstz('last_successful_sync_at'),
    lastSyncStatus: bankSyncStatusEnum('last_sync_status'),
    lastError: text('last_error'),
    nextSyncAt: tstz('next_sync_at'),
    ...timestamps(),
  },
  (t) => [
    index('bank_connections_account_idx').on(t.bankAccountId),
    index('bank_connections_next_sync_idx')
      .on(t.nextSyncAt)
      .where(sql`${t.isActive}`),
    check(
      'bank_connections_adapter_matches_config',
      sql`${t.config} ->> 'adapter' = ${t.adapter}::text`,
    ),
    check(
      'bank_connections_poll_interval',
      sql`${t.pollIntervalSeconds} IS NULL OR ${t.pollIntervalSeconds} >= 60`,
    ),
  ],
);

export const bankSyncRuns = pgTable(
  'bank_sync_runs',
  {
    id: id(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => bankConnections.id, { onDelete: 'cascade' }),
    trigger: bankSyncTriggerEnum('trigger').notNull(),
    status: bankSyncStatusEnum('status').notNull().default('RUNNING'),
    periodFrom: date('period_from', { mode: 'string' }),
    periodTo: date('period_to', { mode: 'string' }),
    fetchedCount: integer('fetched_count').notNull().default(0),
    importedCount: integer('imported_count').notNull().default(0),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    matchedCount: integer('matched_count').notNull().default(0),
    errorMessage: text('error_message'),
    triggeredByUserId: uuid('triggered_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
  },
  (t) => [
    index('bank_sync_runs_connection_idx').on(t.connectionId, t.startedAt),
    uniqueIndex('bank_sync_runs_single_running_uq')
      .on(t.connectionId)
      .where(sql`${t.status} IN ('RUNNING','TAN_REQUIRED')`),
  ],
);

/**
 * PSD2 strong customer authentication for FinTS: the worker stores the challenge, the
 * Admin UI shows it (text / photoTAN image), the admin submits the TAN which is forwarded
 * to the bank and never persisted.
 */
export const bankTanChallenges = pgTable(
  'bank_tan_challenges',
  {
    id: id(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => bankConnections.id, { onDelete: 'cascade' }),
    syncRunId: uuid('sync_run_id').references(() => bankSyncRuns.id, { onDelete: 'set null' }),
    status: tanChallengeStatusEnum('status').notNull().default('PENDING'),
    tanMethod: text('tan_method'),
    challengeText: text('challenge_text'),
    challengeMediaMimeType: text('challenge_media_mime_type'),
    challengeMediaBase64: text('challenge_media_base64'),
    /** Decoupled (push-TAN / SecureGo) – app approval instead of TAN entry. */
    isDecoupled: boolean('is_decoupled').notNull().default(false),
    expiresAt: tstz('expires_at').notNull(),
    respondedByUserId: uuid('responded_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    respondedAt: tstz('responded_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('bank_tan_challenges_pending_idx')
      .on(t.connectionId)
      .where(sql`${t.status} = 'PENDING'`),
  ],
);

/** Uploaded / IMAP-received statement files. SHA-256 prevents re-importing the same file. */
export const bankStatementImports = pgTable(
  'bank_statement_imports',
  {
    id: id(),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id').references(() => bankConnections.id, {
      onDelete: 'set null',
    }),
    source: bankImportSourceEnum('source').notNull(),
    format: bankStatementFormatEnum('format').notNull(),
    fileName: text('file_name').notNull(),
    objectKey: text('object_key').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    status: bankImportStatusEnum('status').notNull().default('PROCESSING'),
    /** Statement identification from the file (camt Stmt/Id, MT940 :20:). */
    statementId: text('statement_id'),
    periodFrom: date('period_from', { mode: 'string' }),
    periodTo: date('period_to', { mode: 'string' }),
    transactionCount: integer('transaction_count').notNull().default(0),
    importedCount: integer('imported_count').notNull().default(0),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    errors: jsonb('errors'),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    completedAt: tstz('completed_at'),
  },
  (t) => [
    unique('bank_statement_imports_file_uq').on(t.bankAccountId, t.sha256),
    index('bank_statement_imports_account_idx').on(t.bankAccountId, t.createdAt),
  ],
);

/**
 * Booked transactions from any source. `fingerprint` is a SHA-256 over the booking date,
 * signed amount, currency, counterparty IBAN and the normalised remittance text (letters and
 * digits only, first 80) + an occurrence index for identical lines within one batch, so the
 * same booking imported via FinTS *and* a CAMT upload is stored once (see
 * `packages/core/src/banking/fingerprint.ts`).
 */
export const bankTransactions = pgTable(
  'bank_transactions',
  {
    id: id(),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    importId: uuid('import_id').references(() => bankStatementImports.id, { onDelete: 'set null' }),
    syncRunId: uuid('sync_run_id').references(() => bankSyncRuns.id, { onDelete: 'set null' }),
    fingerprint: text('fingerprint').notNull(),
    /** Bank-side id when available (camt AcctSvcrRef, PSD2 transactionId). */
    externalId: text('external_id'),
    bookingDate: date('booking_date', { mode: 'string' }).notNull(),
    valueDate: date('value_date', { mode: 'string' }),
    /** Signed cents: credits > 0, debits < 0. */
    amount: cents('amount').notNull(),
    currency: currency().notNull(),
    counterpartyName: text('counterparty_name'),
    counterpartyIban: text('counterparty_iban'),
    counterpartyBic: text('counterparty_bic'),
    remittanceInformation: text('remittance_information'),
    endToEndId: text('end_to_end_id'),
    /** German GVC / ISO bank transaction code. */
    bankTransactionCode: text('bank_transaction_code'),
    rawData: jsonb('raw_data'),

    // ── Reconciliation ─────────────────────────────────────────────────────
    matchStatus: bankTxMatchStatusEnum('match_status').notNull().default('UNMATCHED'),
    reviewReason: bankTxReviewReasonEnum('review_reason'),
    /** Normalised Verwendungszweck found by the tolerant parser (O→0, spaces, hyphens). */
    extractedReference: text('extracted_reference'),
    matchConfidence: smallint('match_confidence'),
    matchCandidates: jsonb('match_candidates').$type<MatchCandidate[]>(),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    reviewedAt: tstz('reviewed_at'),
    reviewNote: text('review_note'),
    ...timestamps(),
  },
  (t) => [
    unique('bank_transactions_fingerprint_uq').on(t.bankAccountId, t.fingerprint),
    index('bank_transactions_status_idx').on(t.matchStatus, t.bookingDate),
    index('bank_transactions_reference_idx').on(t.extractedReference),
    index('bank_transactions_booking_idx').on(t.bankAccountId, t.bookingDate),
    index('bank_transactions_counterparty_trgm_idx').using(
      'gin',
      sql`${t.counterpartyName} gin_trgm_ops`,
    ),
    check('bank_transactions_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'bank_transactions_review_reason',
      sql`${t.matchStatus} <> 'NEEDS_REVIEW' OR ${t.reviewReason} IS NOT NULL`,
    ),
    check(
      'bank_transactions_confidence_range',
      sql`${t.matchConfidence} IS NULL OR ${t.matchConfidence} BETWEEN 0 AND 100`,
    ),
  ],
);

/**
 * Links money to orders. Supports split payments (n transactions → 1 order) and
 * collective transfers (1 transaction → n orders). Reversal keeps the row for audit.
 */
export const bankTransactionAllocations = pgTable(
  'bank_transaction_allocations',
  {
    id: id(),
    bankTransactionId: uuid('bank_transaction_id')
      .notNull()
      .references(() => bankTransactions.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references((): AnyPgColumn => orders.id, { onDelete: 'restrict' }),
    paymentId: uuid('payment_id').references((): AnyPgColumn => payments.id, {
      onDelete: 'set null',
    }),
    amount: cents('amount').notNull(),
    method: allocationMethodEnum('method').notNull(),
    allocatedByUserId: uuid('allocated_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    note: text('note'),
    reversedAt: tstz('reversed_at'),
    reversedByUserId: uuid('reversed_by_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    /** Why the allocation was reversed (admin input; the original `note` stays untouched). */
    reversalReason: text('reversal_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    index('bank_tx_allocations_tx_idx').on(t.bankTransactionId),
    index('bank_tx_allocations_order_idx').on(t.orderId),
    check('bank_tx_allocations_amount_positive', sql`${t.amount} > 0`),
  ],
);
