import { z } from 'zod';
import { SEAT_SELECTION_STYLES } from '../enums';
import { SUPPORTED_LOCALES } from '../i18n';
import { accountingSchema } from './accounting';
import { GERMAN_STATES } from '../payments/business-days';
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
  defaultLocale: localeSchema.default('en'),
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
  /** Sanitised rich-text HTML (legacy values are plain text). */
  footerText: z.string().max(10_000).optional(),
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
  /** Box office: above this gross total (cents) an invoice needs the buyer's name and address (Kleinbetragsrechnung limit). */
  smallAmountInvoiceLimit: z.number().int().min(0).max(100_000_000).default(25_000),
});

const checkoutSchema = z.object({
  /** Standard cart seat lock (Redis TTL). */
  cartLockTtlSeconds: z.number().int().min(60).max(3_600).default(600),
  /** Added once the customer starts payment so seats never expire mid-payment. */
  paymentGraceSeconds: z.number().int().min(0).max(3_600).default(600),
  /**
   * Maximum total lifetime of a cart (minutes since its first seat was locked): adding seats
   * restarts the reservation timer, but never beyond this limit. The one-time payment grace
   * period comes on top. Null = off (every addition restarts the timer).
   */
  maxCartLifetimeMinutes: z.number().int().min(5).max(1_440).nullable().default(null),
  /**
   * Safety net per client IP address (the primary limits are per browser session): orders
   * placed per 10 minutes. Null / 0 = off.
   */
  checkoutsPerIpPer10Min: z.number().int().min(0).max(100_000).nullable().default(null),
  /** Safety net per client IP address: seat selection requests per minute. Null / 0 = off. */
  seatRequestsPerIpPerMinute: z.number().int().min(0).max(100_000).nullable().default(600),
  /** Tickets per order (cart). Null = unlimited. */
  maxTicketsPerOrder: z.number().int().min(1).max(10_000).nullable().default(10),
  /** Across all orders of the same e-mail address per event. Null = unlimited. */
  maxTicketsPerCustomer: z.number().int().min(1).max(10_000).nullable().default(null),
  manualSeatSelectionEnabled: z.boolean().default(true),
  bestAvailableEnabled: z.boolean().default(true),
  orphanSeatRuleEnabled: z.boolean().default(true),
  /** Companion seats can only be booked together with their wheelchair space. */
  companionSeatsRequireWheelchair: z.boolean().default(true),
  requireTermsAcceptance: z.boolean().default(true),
  /** Phone number is mandatory in the online checkout. */
  requirePhone: z.boolean().default(true),
  /** Billing address is mandatory in the online checkout (invoice). */
  requireBillingAddress: z.boolean().default(true),
  /**
   * Cancelling a paid order: pre-selected answer to "refund the service fees as well?" (the admin
   * can change it per cancellation).
   */
  refundFeesByDefault: z.boolean().default(false),
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
    /** Federal state whose regional public holidays are skipped (null = nationwide ones only). */
    holidayRegion: z.enum(GERMAN_STATES).nullable().default(null),
    reminderAfterDays: z.number().int().min(1).max(60).default(4),
    /** Days after which an unpaid additional-payment request (tariff change) gets one reminder. */
    adjustmentReminderDays: z.number().int().min(1).max(60).default(7),
    /** Days until unpaid orders are cancelled automatically. Null = no automatic cancellation. */
    cancelAfterDays: z.number().int().min(1).max(90).nullable().default(8),
    /** Vorkasse is not offered when the event starts within this many days. */
    disableDaysBeforeEvent: z.number().int().min(0).max(90).default(7),
    /** Tolerated deviation (cents) for automatic matching. 0 = exact amount only. */
    autoMatchToleranceCents: z.number().int().min(0).max(10_000).default(0),
  })
  .refine((v) => v.cancelAfterDays === null || v.cancelAfterDays >= v.paymentTermDays, {
    message: 'cancelAfterDays must be >= paymentTermDays',
    path: ['cancelAfterDays'],
  })
  .refine((v) => v.cancelAfterDays === null || v.reminderAfterDays < v.cancelAfterDays, {
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

export const SMTP_SECURITY_MODES = ['STARTTLS', 'TLS', 'NONE'] as const;
export type SmtpSecurityMode = (typeof SMTP_SECURITY_MODES)[number];

/** Outgoing mail server. Without `username` the server is used without authentication. */
const smtpSchema = z.object({
  host: z.string().trim().max(255).optional(),
  port: z.number().int().min(1).max(65_535).default(587),
  /** STARTTLS (587, upgrade required), TLS (465, implicit) or NONE (local relays only). */
  security: z.enum(SMTP_SECURITY_MODES).default('STARTTLS'),
  username: z.string().trim().max(255).optional(),
  fromName: z.string().trim().max(120).optional(),
  fromEmail: z.email().optional(),
  replyTo: z.email().optional(),
  /** Blind copy of every outgoing e-mail (archive mailbox). */
  bccAddress: z.email().optional(),
  /** Mails with ticket PDFs above this size (MB) are sent without the tickets PDF. */
  maxMessageSizeMb: z.number().int().min(1).max(100).default(25),
});
/** SMTP password (the user name is a plain setting so admins can see it). */
const smtpCredentialsSchema = z.object({
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
  issuerId: z.string().trim().max(64).optional(),
  /** Prefix of class / object ids below the issuer (letters, digits, `_` `-`). */
  classPrefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .default('tix'),
});
const googleWalletCredentialsSchema = z.object({ serviceAccountJson: z.string().min(1) });

/** Screen colours of the scan result (hex). Keys match the scanner manifest `resultColors`. */
const scanResultColorsSchema = z.object({
  accepted: hexColorSchema.default('#16A34A'),
  rejected: hexColorSchema.default('#DC2626'),
  /** Warning DISCOUNT_PROOF_REQUIRED. */
  discountProof: hexColorSchema.default('#FACC15'),
  /** Warning SEAT_FEATURE (wheelchair space / companion seat). */
  seatFeature: hexColorSchema.default('#14B8A6'),
  /** Warning WRONG_ENTRANCE. */
  wrongEntrance: hexColorSchema.default('#2563EB'),
  /** Warning ADDITIONAL_PAYMENT_OPEN. */
  additionalPaymentOpen: hexColorSchema.default('#F97316'),
});
export type ScanResultColors = z.infer<typeof scanResultColorsSchema>;
export const SCAN_RESULT_COLOR_KEYS = Object.keys(
  scanResultColorsSchema.shape,
) as (keyof ScanResultColors)[];

/** Where the check-in app finds updates: GitHub releases of the open-source project, or APKs uploaded here. */
export const APP_UPDATE_SOURCES = ['GITHUB', 'SERVER'] as const;
export type AppUpdateSource = (typeof APP_UPDATE_SOURCES)[number];
/** `stable` = newest final release, `next` = newest release including alpha / beta / rc. */
export const APP_UPDATE_CHANNELS = ['stable', 'next'] as const;
export type AppUpdateChannel = (typeof APP_UPDATE_CHANNELS)[number];
/** GitHub `owner/repo`. */
export const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
/** `owner/repo` without `.` / `..` segments (they would alter the API path). */
export function isValidGithubRepository(value: string): boolean {
  return (
    value.length <= 140 &&
    GITHUB_REPOSITORY_PATTERN.test(value) &&
    value.split('/').every((part) => part !== '.' && part !== '..')
  );
}

const scannerSchema = z.object({
  resultColors: scanResultColorsSchema.default(() => scanResultColorsSchema.parse({})),
  allowCheckOut: z.boolean().default(true),
  offlineModeAllowed: z.boolean().default(true),
  lanSyncEnabled: z.boolean().default(true),
  syncIntervalSeconds: z.number().int().min(5).max(3_600).default(30),
  pairingCodeTtlMinutes: z.number().int().min(1).max(1_440).default(15),
  /** Update source of the app (see docs/SCANNER.md "App updates"). */
  appUpdateSource: z.enum(APP_UPDATE_SOURCES).default('GITHUB'),
  /** Empty = the repository built into the app (set by the release build). */
  githubRepository: z
    .string()
    .trim()
    .refine((v) => v === '' || isValidGithubRepository(v))
    .default(''),
  defaultUpdateChannel: z.enum(APP_UPDATE_CHANNELS).default('stable'),
  /** Operators may pick another channel in the app settings. */
  allowChannelOverride: z.boolean().default(true),
  /**
   * Address the app uses to reach this server (pairing QR code, API base), e.g.
   * `http://192.168.1.20:8080` on a venue network. Empty = the public shop URL.
   */
  serverUrl: z
    .union([z.literal(''), z.url({ protocol: /^https?$/ })])
    .transform((v) => (v === '' ? undefined : v.replace(/\/+$/, '')))
    .optional(),
});

const securitySchema = z.object({
  adminSessionTtlHours: z.number().int().min(1).max(720).default(12),
  maxFailedLogins: z.number().int().min(3).max(50).default(5),
  lockoutMinutes: z.number().int().min(1).max(1_440).default(15),
  /** Minimum length of admin passwords (set / change). */
  minPasswordLength: z.number().int().min(8).max(128).default(12),
  /** Every admin must use an authenticator app (TOTP); users without one are forced to set it up. */
  requireTwoFactor: z.boolean().default(false),
  /** Validity of the invitation link for new admin users. */
  inviteTtlHours: z.number().int().min(1).max(720).default(72),
  /** Validity of the admin password reset link. */
  passwordResetTtlMinutes: z.number().int().min(5).max(1_440).default(60),
});

/** How seats are drawn on the public seating chart (colours of the non-free states). */
const seatDisplaySchema = z.object({
  /** Seats currently in another customer's cart (not bought yet). */
  inOtherCartColor: hexColorSchema.default('#F59E0B'),
  /** Sold / reserved seats. */
  soldColor: hexColorSchema.default('#D4D4D8'),
  /** Seats blocked by the organiser (press, technical …). */
  blockedColor: hexColorSchema.default('#E4E4E7'),
  /** Draw a cross on sold and blocked seats. */
  markUnavailableWithCross: z.boolean().default(true),
  /** Ring colour of the customer's own selection. */
  selectionColor: hexColorSchema.default('#18181B'),
  /** How the customer's own seats are marked: ring around the seat, filled, or both. */
  selectionStyle: z.enum(SEAT_SELECTION_STYLES).default('RING'),
  /** Seat change editor (admin): the order's seats that stay as they are. */
  seatChangeCurrentColor: hexColorSchema.default('#2563EB'),
  /** Seat change editor: a seat that is being replaced once an alternative is picked. */
  seatChangeReplacedColor: hexColorSchema.default('#DC2626'),
  /** Seat change editor: the chosen alternative seat. */
  seatChangeNewColor: hexColorSchema.default('#16A34A'),
});

/** Maximum event cards per row on the shop home page. */
export const SHOP_EVENTS_PER_ROW_MAX = 6;

/** Layout of the shop home page event list. */
const shopLayoutSchema = z.object({
  /** Event cards per row on wide screens (fewer on narrower screens, always 1 on phones).
   *  Values above the maximum stored by older versions (up to 10) are clamped on read. */
  eventsPerRow: z
    .preprocess(
      (v) => (typeof v === 'number' && v > SHOP_EVENTS_PER_ROW_MAX ? SHOP_EVENTS_PER_ROW_MAX : v),
      z.number().int().min(1).max(SHOP_EVENTS_PER_ROW_MAX),
    )
    .default(3),
});

/** Maximum length of a custom cookie notice text (per locale). */
export const COOKIE_NOTICE_TEXT_MAX = 400;

/**
 * Information bar about the strictly necessary cookies of the shop (information only, no
 * consent). The list of cookies itself is a technical fact and lives in code.
 */
const cookieNoticeSchema = z.object({
  enabled: z.boolean().default(true),
  /** Optional replacement of the default notice text per locale (empty = default text). */
  texts: z.record(z.string(), z.string().trim().max(COOKIE_NOTICE_TEXT_MAX)).default({}),
});

export const START_PAGE_LAYOUTS = ['ABOVE', 'OVERLAY'] as const;
export type StartPageLayout = (typeof START_PAGE_LAYOUTS)[number];
export const START_PAGE_MAX_GALLERY = 4;
export const START_PAGE_MODES = ['BUILDER', 'HTML'] as const;
export const START_PAGE_BUTTON_ALIGNS = ['LEFT', 'CENTER', 'RIGHT'] as const;
export type StartPageButtonAlign = (typeof START_PAGE_BUTTON_ALIGNS)[number];
export type StartPageMode = (typeof START_PAGE_MODES)[number];
/** Maximum size of the custom start page HTML per locale (characters). */
export const START_PAGE_HTML_MAX = 200_000;

/** Button target: an https URL or a path inside the shop ("/events", not "//host"). */
export const startPageLinkSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    if (/\s/.test(v)) return false;
    if (v.startsWith('/')) return !v.startsWith('//') && !v.includes('\\');
    try {
      return new URL(v).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'url');

const startPageTextSchema = z.object({
  headline: z.string().trim().max(200).optional(),
  subheadline: z.string().trim().max(400).optional(),
  /** Sanitised rich-text HTML. */
  body: z.string().max(20_000).optional(),
  buttonLabel: z.string().trim().max(80).optional(),
  heroAlt: z.string().trim().max(200).optional(),
  /** Alt texts of the gallery images, same order as `galleryAssetIds` (empty = decorative). */
  galleryAlt: z.array(z.string().trim().max(200)).max(START_PAGE_MAX_GALLERY).optional(),
  /** Custom HTML (mode HTML), sanitised on save and on render. */
  html: z.string().max(START_PAGE_HTML_MAX).optional(),
});
export type StartPageText = z.output<typeof startPageTextSchema>;

/** Shop home page while no event is published (nothing configured = built-in text). */
const startPageSchema = z.object({
  /** BUILDER = structured fields below; HTML = the per-locale custom HTML replaces them. */
  mode: z.enum(START_PAGE_MODES).default('BUILDER'),
  layout: z.enum(START_PAGE_LAYOUTS).default('ABOVE'),
  /** Public media assets (kind EVENT_IMAGE). */
  heroAssetId: z.uuid().optional(),
  galleryAssetIds: z.array(z.uuid()).max(START_PAGE_MAX_GALLERY).default([]),
  buttonUrl: startPageLinkSchema.optional(),
  /** Horizontal position of the button. */
  buttonAlign: z.enum(START_PAGE_BUTTON_ALIGNS).default('LEFT'),
  /** Per UI locale; missing fields fall back to the shop default locale. */
  texts: z.partialRecord(z.enum(SUPPORTED_LOCALES), startPageTextSchema).default({}),
});
export type StartPageSettings = z.output<typeof startPageSchema>;

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
  /** Validity of the passwordless sign-in link (default = the former shared reset lifetime). */
  loginLinkTtlMinutes: z.number().int().min(5).max(1_440).default(60),
});

export const BACKUP_FREQUENCIES = ['DAILY', 'WEEKLY'] as const;
export type BackupFrequency = (typeof BACKUP_FREQUENCIES)[number];

/** Scheduled full backups (database + object storage), retention and the optional external S3 target. */
const backupSchema = z.object({
  scheduleEnabled: z.boolean().default(false),
  frequency: z.enum(BACKUP_FREQUENCIES).default('DAILY'),
  /** Weekly runs only: 0 = Sunday … 6 = Saturday (shop time zone). */
  weekday: z.number().int().min(0).max(6).default(1),
  /** Local time of day (shop time zone), HH:MM. */
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('03:00'),
  /** Scheduled backups kept (oldest are deleted); manual backups are kept until deleted. */
  keepScheduled: z.number().int().min(1).max(365).default(14),
  /**
   * Manual and safety (pre-restore) backups older than this many days are deleted; 0 = keep until
   * deleted by hand. They contain personal data: GDPR Art. 17 may require a limit. The newest
   * verified backup is never deleted.
   */
  manualMaxAgeDays: z.number().int().min(0).max(3_650).default(0),
  /** Largest backup file accepted by the upload (counted while streaming). */
  maxUploadMb: z.number().int().min(1).max(1_048_576).default(20_480),
  /** Restore needs a second factor (authenticator / recovery code); users without 2FA cannot restore. */
  restoreRequiresTwoFactor: z.boolean().default(true),
  externalEnabled: z.boolean().default(false),
  externalEndpoint: z.url().optional(),
  externalBucket: z.string().trim().min(3).max(63).optional(),
  externalRegion: z.string().trim().min(1).max(64).default('us-east-1'),
  /** Key prefix inside the external bucket (no leading slash). */
  externalPrefix: z.string().trim().max(200).default(''),
  externalForcePathStyle: z.boolean().default(true),
  /** Allow plain http:// endpoints (default: https only). */
  allowInsecureEndpoint: z.boolean().default(false),
  /** Allow endpoints resolving to loopback / private / link-local addresses (e.g. a LAN MinIO). */
  allowPrivateNetwork: z.boolean().default(false),
  /** A failed scheduled backup is reported to this address (in addition to the dashboard). */
  alertEmail: z.email().optional(),
});
/** Data protection (GDPR): retention periods of personal data outside the accounting records. */
const privacySchema = z.object({
  /** Stored e-mail variables / error texts of delivered messages are erased after this many days; 0 = keep. */
  emailRetentionDays: z.number().int().min(0).max(3_650).default(365),
  /**
   * Invoices and credit notes must be kept this many years after the end of the year of issue.
   * Billing data of anonymised customers stays on their orders until then.
   */
  invoiceRetentionYears: z.number().int().min(1).max(30).default(10),
  /** Personal fields of stored payment webhooks (payer, name, e-mail, address) are erased after this many days; 0 = keep. */
  webhookRetentionDays: z.number().int().min(0).max(3_650).default(90),
});
const backupCredentialsSchema = z.object({
  accessKeyId: z.string().min(1).max(256),
  secretAccessKey: z.string().min(1).max(1_024),
});

/** First-steps checklist on the admin dashboard. */
const setupChecklistSchema = z.object({
  /** Hidden by a super admin ("Hide"); the card also disappears by itself once everything is done. */
  dismissed: z.boolean().default(false),
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
    description: 'Admin sessions, lockout, passwords, two-factor and invitations',
  }),
  seatDisplay: define({
    schema: seatDisplaySchema,
    secret: false,
    description: 'Colours of seats in other carts, sold and blocked seats',
  }),
  shopLayout: define({
    schema: shopLayoutSchema,
    secret: false,
    description: 'Event list layout of the shop home page',
  }),
  cookieNotice: define({
    schema: cookieNoticeSchema,
    secret: false,
    description: 'Information bar about the strictly necessary cookies of the shop',
  }),
  startPage: define({
    schema: startPageSchema,
    secret: false,
    description: 'Shop home page while no event is published',
  }),
  customerAccounts: define({
    schema: customerAccountsSchema,
    secret: false,
    description: 'Optional customer accounts and guest checkout',
  }),
  privacy: define({
    schema: privacySchema,
    secret: false,
    description: 'Data retention periods (GDPR)',
  }),
  backup: define({
    schema: backupSchema,
    secret: false,
    description: 'Scheduled backups, retention and external S3 target',
  }),
  accounting: define({
    schema: accountingSchema,
    secret: false,
    description: 'Accounting export: chart of accounts, DATEV master data',
  }),
  setupChecklist: define({
    schema: setupChecklistSchema,
    secret: false,
    description: 'Dashboard first-steps checklist state',
  }),
  'backup.external.credentials': define({
    schema: backupCredentialsSchema,
    secret: true,
    description: 'Access keys of the external backup target',
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
