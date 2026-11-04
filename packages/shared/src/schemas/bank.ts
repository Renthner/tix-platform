import { z } from 'zod';
import { BANK_STATEMENT_FORMATS } from '../enums';

/**
 * Per-adapter configuration of a bank connection.
 *  - `config` (bank_connections.config) holds non-secret parameters (plain JSONB).
 *  - `secrets` (bank_connections.credentials_encrypted) is AES-256-GCM encrypted at rest.
 * Bank-specific values (server URL, BLZ, BIC …) are entered by admins – never hard-coded.
 */

const lookbackDays = z.number().int().min(1).max(730).default(30);

export const finTsConfigSchema = z.object({
  adapter: z.literal('FINTS'),
  serverUrl: z.url({ protocol: /^https$/ }),
  bankCode: z.string().regex(/^\d{8}$/, 'BLZ must have 8 digits'),
  bic: z
    .string()
    .regex(/^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/)
    .optional(),
  /** Login name / VR-NetKey / alias. */
  userId: z.string().min(1).max(64),
  customerId: z.string().max(64).optional(),
  /** FinTS product registration number issued by Deutsche Kreditwirtschaft. */
  productId: z.string().min(1).max(64),
  productVersion: z.string().max(16).default('1.0'),
  /** Selected TAN procedure (security function code, e.g. "946" for SecureGo plus). */
  tanMethod: z.string().max(16).optional(),
  tanMediumName: z.string().max(64).optional(),
  lookbackDays,
});

export const goCardlessConfigSchema = z.object({
  adapter: z.literal('PSD2_GOCARDLESS'),
  institutionId: z.string().min(1).max(128),
  secretId: z.string().min(1).max(128),
  requisitionId: z.string().max(128).optional(),
  accountId: z.string().max(128).optional(),
  lookbackDays,
});

export const finApiConfigSchema = z.object({
  adapter: z.literal('PSD2_FINAPI'),
  environment: z.enum(['sandbox', 'live']),
  clientId: z.string().min(1).max(128),
  bankConnectionId: z.string().max(64).optional(),
  accountId: z.string().max(64).optional(),
  lookbackDays,
});

export const csvProfileSchema = z.object({
  delimiter: z.enum([';', ',', '\t']).default(';'),
  encoding: z.enum(['utf-8', 'windows-1252', 'iso-8859-1']).default('utf-8'),
  headerRow: z.number().int().min(0).max(50).default(0),
  dateFormat: z.string().max(32).default('dd.MM.yyyy'),
  decimalSeparator: z.enum([',', '.']).default(','),
  columns: z.object({
    bookingDate: z.string().min(1),
    valueDate: z.string().optional(),
    amount: z.string().min(1),
    currency: z.string().optional(),
    counterpartyName: z.string().optional(),
    counterpartyIban: z.string().optional(),
    remittanceInformation: z.string().min(1),
  }),
});

export const fileImportConfigSchema = z.object({
  adapter: z.literal('FILE_IMPORT'),
  defaultFormat: z.enum(BANK_STATEMENT_FORMATS).default('CAMT053'),
  csvProfile: csvProfileSchema.optional(),
});

export const imapConfigSchema = z.object({
  adapter: z.literal('IMAP'),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65_535).default(993),
  secure: z.boolean().default(true),
  username: z.string().min(1).max(255),
  mailbox: z.string().min(1).max(255).default('INBOX'),
  processedMailbox: z.string().max(255).optional(),
  senderAllowlist: z.array(z.string().max(255)).max(50).default([]),
  subjectFilter: z.string().max(255).optional(),
  attachmentFormats: z.array(z.enum(BANK_STATEMENT_FORMATS)).min(1).default(['CAMT053']),
  csvProfile: csvProfileSchema.optional(),
});

export const bankConnectionConfigSchema = z.discriminatedUnion('adapter', [
  finTsConfigSchema,
  goCardlessConfigSchema,
  finApiConfigSchema,
  fileImportConfigSchema,
  imapConfigSchema,
]);
export type BankConnectionConfig = z.infer<typeof bankConnectionConfigSchema>;

export const bankConnectionSecretsSchema = z.discriminatedUnion('adapter', [
  z.object({ adapter: z.literal('FINTS'), pin: z.string().min(1).max(128) }),
  z.object({ adapter: z.literal('PSD2_GOCARDLESS'), secretKey: z.string().min(1) }),
  z.object({
    adapter: z.literal('PSD2_FINAPI'),
    clientSecret: z.string().min(1),
    userPassword: z.string().optional(),
  }),
  z.object({ adapter: z.literal('FILE_IMPORT') }),
  z.object({ adapter: z.literal('IMAP'), password: z.string().min(1) }),
]);
export type BankConnectionSecrets = z.infer<typeof bankConnectionSecretsSchema>;

/** Candidate list persisted on a bank transaction for the Klärfälle dashboard. */
export const matchCandidateSchema = z.object({
  orderId: z.uuid(),
  orderNumber: z.string(),
  score: z.number().int().min(0).max(100),
  reasons: z.array(z.string()).max(10),
});
export type MatchCandidate = z.infer<typeof matchCandidateSchema>;
