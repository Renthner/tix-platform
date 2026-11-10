import { z } from 'zod';
import { BANK_STATEMENT_FORMATS } from '../enums';

/**
 * Per-adapter configuration of a bank connection.
 *  - `config` (bank_connections.config) holds non-secret parameters (plain JSONB).
 *  - `secrets` (bank_connections.credentials_encrypted) is AES-256-GCM encrypted at rest.
 *  - `state` (bank_connections.state) is runtime data written by the adapters.
 * Bank-specific values (server URL, bank code, product registration …) are entered by admins
 * in the Admin Portal – never hard-coded.
 */

const lookbackDays = z.number().int().min(1).max(730).default(30);

/** Adapters with an implementation (PSD2_GOCARDLESS stays in the enum for old rows only). */
export const SUPPORTED_BANK_ADAPTERS = ['FINTS', 'PSD2_FINAPI', 'FILE_IMPORT', 'IMAP'] as const;
export type SupportedBankAdapter = (typeof SUPPORTED_BANK_ADAPTERS)[number];

/** Adapters that fetch data on their own (scheduled polling / "sync now"). */
export const POLLING_BANK_ADAPTERS = ['FINTS', 'PSD2_FINAPI', 'IMAP'] as const;

// ─── FinTS 3.0 (PIN/TAN) ─────────────────────────────────────────────────────
export const finTsConfigSchema = z.object({
  adapter: z.literal('FINTS'),
  /** FinTS server URL of the bank (HTTPS). */
  serverUrl: z.url({ protocol: /^https$/ }),
  /** German bank code (BLZ). */
  bankCode: z.string().regex(/^\d{8}$/),
  /** Login name / alias of the online-banking user. */
  userId: z.string().min(1).max(64),
  /** Customer id when it differs from the login name (rare). */
  customerId: z.string().max(64).optional(),
  /**
   * FinTS product registration number issued by the German banking industry
   * (Deutsche Kreditwirtschaft) to the operator of this installation.
   */
  productId: z.string().min(1).max(64),
  productVersion: z.string().min(1).max(16).default('1.0'),
  /** Security function code of the selected TAN procedure (from the bank's parameter data). */
  tanMethodId: z.number().int().min(1).max(999).optional(),
  /** TAN medium (device name) when the bank requires one for the procedure. */
  tanMediumName: z.string().max(64).optional(),
  /** Request CAMT (HKCAZ) instead of MT940 (HKKAZ) when the bank supports both. */
  preferCamt: z.boolean().default(true),
  lookbackDays,
});

// ─── PSD2 via GoCardless (legacy, not implemented) ───────────────────────────
export const goCardlessConfigSchema = z.object({
  adapter: z.literal('PSD2_GOCARDLESS'),
  institutionId: z.string().min(1).max(128),
  secretId: z.string().min(1).max(128),
  requisitionId: z.string().max(128).optional(),
  accountId: z.string().max(128).optional(),
  lookbackDays,
});

// ─── PSD2 via finAPI Access V2 + Web Form 2.0 ────────────────────────────────
export const FINAPI_ENVIRONMENTS = ['sandbox', 'live'] as const;
export const finApiConfigSchema = z.object({
  adapter: z.literal('PSD2_FINAPI'),
  environment: z.enum(FINAPI_ENVIRONMENTS),
  clientId: z.string().min(1).max(128),
  /** Optional Web Form 2.0 profile id (set up by the provider's support). */
  webFormProfileId: z.uuid().optional(),
  /**
   * Ask the provider to refresh the bank data (background update, max. 4×/day without the
   * user being present) before downloading. Disable when the provider's automatic batch
   * update is booked for the client.
   */
  backgroundUpdate: z.boolean().default(true),
  lookbackDays,
});

// ─── Statement files: CSV profile ────────────────────────────────────────────
export const CSV_COLUMN_KEYS = [
  'bookingDate',
  'valueDate',
  'amount',
  'creditDebitIndicator',
  'currency',
  'counterpartyName',
  'counterpartyIban',
  'counterpartyBic',
  'remittanceInformation',
  'endToEndId',
  'bookingText',
  'status',
] as const;
export type CsvColumnKey = (typeof CSV_COLUMN_KEYS)[number];

const columnName = z.string().min(1).max(100).optional();
export const CSV_DATE_FORMATS = [
  'auto',
  'dd.MM.yyyy',
  'dd.MM.yy',
  'yyyy-MM-dd',
  'dd/MM/yyyy',
  'MM/dd/yyyy',
] as const;
export type CsvDateFormat = (typeof CSV_DATE_FORMATS)[number];

export const csvProfileSchema = z.object({
  delimiter: z.enum(['auto', ';', ',', '\t']).default('auto'),
  encoding: z.enum(['auto', 'utf-8', 'windows-1252', 'iso-8859-1']).default('auto'),
  /** 1-based line number of the header row; null = detect automatically. */
  headerRow: z.number().int().min(1).max(50).nullable().default(null),
  dateFormat: z.enum(CSV_DATE_FORMATS).default('auto'),
  decimalSeparator: z.enum(['auto', ',', '.']).default('auto'),
  /** Header name per field; fields left empty are detected from common header names. */
  columns: z
    .object({
      bookingDate: columnName,
      valueDate: columnName,
      amount: columnName,
      creditDebitIndicator: columnName,
      currency: columnName,
      counterpartyName: columnName,
      counterpartyIban: columnName,
      counterpartyBic: columnName,
      remittanceInformation: columnName,
      endToEndId: columnName,
      bookingText: columnName,
      status: columnName,
    })
    .default({}),
});
export type CsvProfile = z.infer<typeof csvProfileSchema>;

export const STATEMENT_FORMAT_HINTS = ['AUTO', ...BANK_STATEMENT_FORMATS] as const;
export type StatementFormatHint = (typeof STATEMENT_FORMAT_HINTS)[number];

export const fileImportConfigSchema = z.object({
  adapter: z.literal('FILE_IMPORT'),
  /** AUTO = detect from content (ZIP archives are unpacked). */
  formatHint: z.enum(STATEMENT_FORMAT_HINTS).default('AUTO'),
  csvProfile: csvProfileSchema.prefault({}),
});

// ─── IMAP mailbox watcher ────────────────────────────────────────────────────
export const imapConfigSchema = z.object({
  adapter: z.literal('IMAP'),
  host: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9.-]+$/),
  port: z.number().int().min(1).max(65_535).default(993),
  /** Implicit TLS (993). false = plain connection upgraded via STARTTLS when offered. */
  secure: z.boolean().default(true),
  username: z.string().min(1).max(255),
  mailbox: z.string().min(1).max(255).default('INBOX'),
  /** Processed mails are moved here; empty = they stay and get flagged instead. */
  processedMailbox: z.string().max(255).optional(),
  /** Accepted senders: full addresses or `@domain`; empty = any sender. */
  senderAllowlist: z.array(z.string().min(3).max(255)).max(50).default([]),
  /** Case-insensitive text the subject must contain. */
  subjectFilter: z.string().max(255).optional(),
  attachmentFormats: z
    .array(z.enum(BANK_STATEMENT_FORMATS))
    .min(1)
    .default([...BANK_STATEMENT_FORMATS]),
  /** Only mails received within this many days are searched. */
  lookbackDays: z.number().int().min(1).max(365).default(14),
  csvProfile: csvProfileSchema.prefault({}),
});

export const bankConnectionConfigSchema = z.discriminatedUnion('adapter', [
  finTsConfigSchema,
  goCardlessConfigSchema,
  finApiConfigSchema,
  fileImportConfigSchema,
  imapConfigSchema,
]);
export type BankConnectionConfig = z.infer<typeof bankConnectionConfigSchema>;
export type FinTsConfig = z.infer<typeof finTsConfigSchema>;
export type FinApiConfig = z.infer<typeof finApiConfigSchema>;
export type FileImportConfig = z.infer<typeof fileImportConfigSchema>;
export type ImapConfig = z.infer<typeof imapConfigSchema>;

export const bankConnectionSecretsSchema = z.discriminatedUnion('adapter', [
  z.object({ adapter: z.literal('FINTS'), pin: z.string().min(1).max(128) }),
  z.object({ adapter: z.literal('PSD2_GOCARDLESS'), secretKey: z.string().min(1) }),
  z.object({
    adapter: z.literal('PSD2_FINAPI'),
    clientSecret: z.string().min(1).max(512),
    /** Password of the provider-side user created for this connection (generated). */
    userPassword: z.string().max(128).optional(),
  }),
  z.object({ adapter: z.literal('FILE_IMPORT') }),
  z.object({ adapter: z.literal('IMAP'), password: z.string().min(1).max(512) }),
]);
export type BankConnectionSecrets = z.infer<typeof bankConnectionSecretsSchema>;

// ─── Adapter runtime state (bank_connections.state) ──────────────────────────
export const finTsTanMethodSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  isDecoupled: z.boolean(),
  activeTanMedia: z.array(z.string()).default([]),
  tanMediumRequired: z.boolean().default(false),
});
export type FinTsTanMethodInfo = z.infer<typeof finTsTanMethodSchema>;

export const FINTS_SETUP_ISSUES = [
  'TAN_METHOD_REQUIRED',
  'TAN_MEDIUM_REQUIRED',
  'ACCOUNT_NOT_FOUND',
  'STATEMENTS_NOT_SUPPORTED',
] as const;
export type FinTsSetupIssue = (typeof FINTS_SETUP_ISSUES)[number];

export const finTsStateSchema = z.object({
  /** Fingerprint of server URL / bank code / user – banking information is reset on change. */
  identity: z.string().optional(),
  /** Opaque lib-fints banking information (BPD, UPD, system id). */
  bankingInformation: z.unknown().optional(),
  bankName: z.string().optional(),
  tanMethods: z.array(finTsTanMethodSchema).default([]),
  accounts: z
    .array(
      z.object({
        iban: z.string().optional(),
        accountNumber: z.string(),
        currency: z.string().optional(),
        product: z.string().optional(),
        holder: z.string().optional(),
      }),
    )
    .default([]),
  bankMessages: z.array(z.object({ subject: z.string(), text: z.string() })).default([]),
  setupIssue: z.enum(FINTS_SETUP_ISSUES).nullable().default(null),
});
export type FinTsState = z.infer<typeof finTsStateSchema>;

export const finApiStateSchema = z.object({
  userId: z.string().optional(),
  bankConnectionId: z.number().int().nullish(),
  accountId: z.number().int().nullish(),
  bankName: z.string().nullish(),
  /** Accounts of the imported bank connection (shown when the IBAN was not found). */
  accounts: z
    .array(z.object({ id: z.number().int(), iban: z.string().nullable().optional() }))
    .default([]),
  webForm: z
    .object({
      id: z.string(),
      url: z.string(),
      expiresAt: z.string(),
      status: z.string(),
      purpose: z.enum(['IMPORT', 'UPDATE']),
    })
    .nullish(),
  /** The provider needs the user (consent renewal / SCA) before data can be refreshed. */
  userActionRequired: z.boolean().default(false),
  lastErrorCode: z.string().nullish(),
});
export type FinApiState = z.infer<typeof finApiStateSchema>;

export const imapStateSchema = z.object({
  lastCheckedAt: z.string().optional(),
  processedMessages: z.number().int().default(0),
});
export type ImapState = z.infer<typeof imapStateSchema>;

// ─── Reconciliation ──────────────────────────────────────────────────────────
export const MATCH_CANDIDATE_REASONS = [
  /** The order's payment reference appears with a valid check digit. */
  'REFERENCE',
  /** Reference found but its check digit is wrong (typo). */
  'REFERENCE_CHECKSUM',
  /** Reference differs from the order's by one digit / one swap. */
  'REFERENCE_SIMILAR',
  /** Sender name resembles the buyer's name. */
  'NAME',
  /** Amount equals the outstanding amount. */
  'AMOUNT',
  /** Amount within the configured tolerance of the outstanding amount. */
  'AMOUNT_NEAR',
  'ORDER_NOT_PAYABLE',
  'ALREADY_PAID',
  'CURRENCY',
  /** The money fits an additional payment (tariff change) of the order, see `adjustmentId`. */
  'ADJUSTMENT',
] as const;
export type MatchCandidateReason = (typeof MATCH_CANDIDATE_REASONS)[number];

/** Candidate list persisted on a bank transaction for the Klärfälle dashboard. */
export const matchCandidateSchema = z.object({
  orderId: z.uuid(),
  orderNumber: z.string(),
  score: z.number().int().min(0).max(100),
  reasons: z.array(z.enum(MATCH_CANDIDATE_REASONS)).max(10),
  /** Set when the candidate is an open additional payment of the order (assign to it). */
  adjustmentId: z.uuid().optional(),
});
export type MatchCandidate = z.infer<typeof matchCandidateSchema>;
