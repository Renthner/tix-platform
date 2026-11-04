import { z } from 'zod';
import {
  countryCodeSchema,
  currencyCodeSchema,
  hexColorSchema,
  localeSchema,
  timeZoneSchema,
} from './common';

/**
 * Registry of every global system setting (table `system_settings`).
 *
 * - Each key maps to a Zod schema; values are validated on read and write.
 * - `secret: true` settings are stored AES-256-GCM encrypted (`encrypted_value`) and are
 *   never sent to the browser in clear text.
 * - Defaults below are *initial* values only. They are written to the database by the seed
 *   script and from then on are fully editable in the Admin Portal (Zero Hardcoding rule).
 * - Event-level overrides live on the `events` table (NULL = inherit from these settings).
 */

const optionalUrl = z.url().optional();

const generalSchema = z.object({
  shopName: z.string().trim().min(1).max(120).default('Ticketshop'),
  defaultLocale: localeSchema.default('de-DE'),
  defaultCurrency: currencyCodeSchema.default('EUR'),
  defaultTimeZone: timeZoneSchema.default('Europe/Berlin'),
  supportEmail: z.email().optional(),
});

const brandingSchema = z.object({
  logoAssetId: z.uuid().optional(),
  faviconAssetId: z.uuid().optional(),
  primaryColor: hexColorSchema.default('#111827'),
  accentColor: hexColorSchema.default('#DC2626'),
  imprintUrl: optionalUrl,
  privacyUrl: optionalUrl,
  termsUrl: optionalUrl,
  footerText: z.string().max(2_000).optional(),
});

/** Seller master data printed on invoices (§ 14 UStG). */
const organizerSchema = z.object({
  legalName: z.string().trim().max(200).optional(),
  street: z.string().trim().max(200).optional(),
  postalCode: z.string().trim().max(20).optional(),
  city: z.string().trim().max(120).optional(),
  country: countryCodeSchema.default('DE'),
  vatId: z.string().trim().max(32).optional(),
  taxNumber: z.string().trim().max(32).optional(),
  registerCourt: z.string().trim().max(120).optional(),
  registerNumber: z.string().trim().max(64).optional(),
  representatives: z.string().trim().max(500).optional(),
  email: z.email().optional(),
  phone: z.string().trim().max(64).optional(),
  website: optionalUrl,
});

/**
 * Number patterns. Tokens: {YYYY} {YY} {SEQ:n} (zero padded counter, gapless per pattern scope).
 * Invoice numbers must be unique and sequential (GoBD) – counters live in `number_sequences`.
 */
const numberPattern = z
  .string()
  .min(1)
  .max(64)
  .refine((p) => /\{SEQ(?::\d{1,2})?\}/.test(p), 'Pattern must contain a {SEQ} token');

const invoicingSchema = z.object({
  issueInvoices: z.boolean().default(true),
  orderNumberPattern: numberPattern.default('{YYYY}-{SEQ:6}'),
  invoiceNumberPattern: numberPattern.default('RE-{YYYY}-{SEQ:6}'),
  creditNoteNumberPattern: numberPattern.default('GS-{YYYY}-{SEQ:6}'),
  invoiceFooter: z.string().max(4_000).optional(),
});

const checkoutSchema = z.object({
  /** Standard cart seat lock (Redis TTL). */
  cartLockTtlSeconds: z.number().int().min(60).max(3_600).default(600),
  /** Added once the customer starts payment so seats never expire mid-payment. */
  paymentGraceSeconds: z.number().int().min(0).max(3_600).default(600),
  maxTicketsPerOrder: z.number().int().min(1).max(500).default(10),
  /** Across all orders of the same e-mail address per event. Null = unlimited. */
  maxTicketsPerCustomer: z.number().int().min(1).max(10_000).nullable().default(null),
  manualSeatSelectionEnabled: z.boolean().default(true),
  bestAvailableEnabled: z.boolean().default(true),
  orphanSeatRuleEnabled: z.boolean().default(true),
  requireTermsAcceptance: z.boolean().default(true),
});

const bankTransferSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Prefix of the Verwendungszweck, e.g. TIX → TIX-2026-8492-7. */
    paymentReferencePrefix: z
      .string()
      .regex(/^[A-Z]{2,6}$/, '2–6 upper-case letters')
      .default('TIX'),
    /** Payment term communicated to the customer. */
    paymentTermDays: z.number().int().min(1).max(60).default(5),
    countBusinessDaysOnly: z.boolean().default(true),
    reminderAfterDays: z.number().int().min(1).max(60).default(4),
    cancelAfterDays: z.number().int().min(1).max(90).default(8),
    /** Vorkasse is not offered when the event starts within this many days. */
    disableDaysBeforeEvent: z.number().int().min(0).max(90).default(7),
    /** Tolerated deviation (cents) for automatic matching. 0 = exact amount only. */
    autoMatchToleranceCents: z.number().int().min(0).max(10_000).default(0),
  })
  .refine((v) => v.cancelAfterDays >= v.paymentTermDays, {
    message: 'cancelAfterDays must be >= paymentTermDays',
    path: ['cancelAfterDays'],
  })
  .refine((v) => v.reminderAfterDays < v.cancelAfterDays, {
    message: 'reminderAfterDays must be < cancelAfterDays',
    path: ['reminderAfterDays'],
  });

const paypalSchema = z.object({
  enabled: z.boolean().default(false),
  environment: z.enum(['sandbox', 'live']).default('sandbox'),
  clientId: z.string().max(256).optional(),
  webhookId: z.string().max(128).optional(),
  brandName: z.string().max(127).optional(),
  /** Pending PayPal orders without approval are expired after this many seconds. */
  approvalTimeoutSeconds: z.number().int().min(300).max(10_800).default(1_800),
});
const paypalCredentialsSchema = z.object({ clientSecret: z.string().min(1) });

const smtpSchema = z.object({
  host: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65_535).default(587),
  security: z.enum(['STARTTLS', 'TLS', 'NONE']).default('STARTTLS'),
  fromName: z.string().max(120).optional(),
  fromEmail: z.email().optional(),
  replyTo: z.email().optional(),
  bccAddress: z.email().optional(),
});
const smtpCredentialsSchema = z.object({
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(1_024),
});

const appleWalletSchema = z.object({
  enabled: z.boolean().default(false),
  passTypeIdentifier: z.string().max(255).optional(),
  teamIdentifier: z.string().max(32).optional(),
  organizationName: z.string().max(255).optional(),
});
const appleWalletCertificatesSchema = z.object({
  signerCertificatePem: z.string().min(1),
  signerKeyPem: z.string().min(1),
  signerKeyPassphrase: z.string().optional(),
  wwdrCertificatePem: z.string().min(1),
});

const googleWalletSchema = z.object({
  enabled: z.boolean().default(false),
  issuerId: z.string().max(64).optional(),
});
const googleWalletCredentialsSchema = z.object({ serviceAccountJson: z.string().min(1) });

const scannerSchema = z.object({
  allowCheckOut: z.boolean().default(true),
  offlineModeAllowed: z.boolean().default(true),
  lanSyncEnabled: z.boolean().default(true),
  syncIntervalSeconds: z.number().int().min(5).max(3_600).default(30),
  pairingCodeTtlMinutes: z.number().int().min(1).max(1_440).default(15),
});

const securitySchema = z.object({
  adminSessionTtlHours: z.number().int().min(1).max(720).default(12),
  maxFailedLogins: z.number().int().min(3).max(50).default(5),
  lockoutMinutes: z.number().int().min(1).max(1_440).default(15),
});

/** Optional customer accounts on top of guest checkout. */
const customerAccountsSchema = z.object({
  /** Customers may register to see their orders and re-download tickets. */
  enabled: z.boolean().default(true),
  /** Buying without an account stays possible. */
  guestCheckoutEnabled: z.boolean().default(true),
  sessionTtlDays: z.number().int().min(1).max(365).default(30),
  passwordMinLength: z.number().int().min(8).max(128).default(10),
  emailVerificationTtlHours: z.number().int().min(1).max(168).default(48),
  passwordResetTtlMinutes: z.number().int().min(5).max(1_440).default(60),
  /** Passwordless sign-in via e-mail link. */
  loginLinkEnabled: z.boolean().default(true),
});

export interface SettingDefinition<S extends z.ZodType = z.ZodType> {
  readonly schema: S;
  readonly secret: boolean;
  readonly description: string;
}

const define = <S extends z.ZodType>(def: SettingDefinition<S>) => def;

export const SETTINGS = {
  general: define({
    schema: generalSchema,
    secret: false,
    description: 'Shop name, locale, currency, time zone',
  }),
  branding: define({
    schema: brandingSchema,
    secret: false,
    description: 'Logo, colours, legal links',
  }),
  organizer: define({
    schema: organizerSchema,
    secret: false,
    description: 'Seller data for invoices',
  }),
  invoicing: define({
    schema: invoicingSchema,
    secret: false,
    description: 'Order/invoice number formats',
  }),
  checkout: define({
    schema: checkoutSchema,
    secret: false,
    description: 'Seat lock TTLs, order limits, seat selection rules',
  }),
  bankTransfer: define({
    schema: bankTransferSchema,
    secret: false,
    description: 'Vorkasse terms, dunning and matching',
  }),
  paypal: define({
    schema: paypalSchema,
    secret: false,
    description: 'PayPal Orders v2 configuration',
  }),
  'paypal.credentials': define({
    schema: paypalCredentialsSchema,
    secret: true,
    description: 'PayPal client secret',
  }),
  smtp: define({ schema: smtpSchema, secret: false, description: 'Outgoing mail server' }),
  'smtp.credentials': define({
    schema: smtpCredentialsSchema,
    secret: true,
    description: 'SMTP login',
  }),
  'wallet.apple': define({
    schema: appleWalletSchema,
    secret: false,
    description: 'Apple Wallet pass type',
  }),
  'wallet.apple.certificates': define({
    schema: appleWalletCertificatesSchema,
    secret: true,
    description: 'Apple Pass Type ID certificate + WWDR',
  }),
  'wallet.google': define({
    schema: googleWalletSchema,
    secret: false,
    description: 'Google Wallet issuer',
  }),
  'wallet.google.credentials': define({
    schema: googleWalletCredentialsSchema,
    secret: true,
    description: 'Google service account',
  }),
  scanner: define({
    schema: scannerSchema,
    secret: false,
    description: 'Android check-in app behaviour',
  }),
  security: define({
    schema: securitySchema,
    secret: false,
    description: 'Session and lockout policy (admins and customer accounts)',
  }),
  customerAccounts: define({
    schema: customerAccountsSchema,
    secret: false,
    description: 'Optional customer accounts and guest checkout',
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]['schema']>;
export type SettingInput<K extends SettingKey> = z.input<(typeof SETTINGS)[K]['schema']>;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const PUBLIC_SETTING_KEYS = SETTING_KEYS.filter((k) => !SETTINGS[k].secret);

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

export function parseSetting<K extends SettingKey>(key: K, raw: unknown): SettingValue<K> {
  return SETTINGS[key].schema.parse(raw) as SettingValue<K>;
}

/** Fully-defaulted value of a non-secret setting (used by the seed and as read fallback). */
export function defaultSetting<K extends SettingKey>(key: K): SettingValue<K> {
  if (SETTINGS[key].secret) {
    throw new Error(`Setting "${key}" is secret and has no default value`);
  }
  return parseSetting(key, {});
}
