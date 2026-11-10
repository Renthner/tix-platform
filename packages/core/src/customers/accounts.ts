import { isIP } from 'node:net';
import {
  customerSessions,
  customerTokens,
  customers,
  events,
  orderItems,
  orders,
  withTransaction,
  type Executor,
} from '@tix/db';
import { rateLimit } from '@tix/redis';
import {
  SUPPORTED_LOCALES,
  localized,
  postalAddressSchema,
  type AppLocale,
  type CustomerTokenPurpose,
  type EmailTemplateKey,
  type OrderStatus,
  type PaymentMethod,
  type PostalAddress,
  normalizeLocale,
} from '@tix/shared';
import {
  generateToken,
  hashPassword,
  hashToken,
  needsRehash,
  verifyPassword,
} from '@tix/shared/server';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, requireCapability, type CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage } from '../email/request';
import { getSetting } from '../settings';

/**
 * Optional customer accounts.
 *
 * One `customers` row per e-mail address (case-insensitive). Guest checkout creates the row
 * without a password; registering sets a password on that same row (`account_created_at`).
 * Because every earlier guest order of the address becomes part of the account, orders are
 * only listed once `email_verified_at` proves ownership of the mailbox.
 *
 * Security properties:
 * - Responses never reveal whether an e-mail address is known (register, password reset,
 *   login link, login errors and the lockout behave identically for unknown addresses).
 * - Sessions and e-mail tokens are random 256-bit values; only their SHA-256 is stored.
 *   E-mail tokens are single-use (atomic conditional UPDATE) and expire.
 * - Pre-account-takeover protection: a password set while the address was unverified is
 *   provisional. When ownership is first proven through a login link, that password and all
 *   sessions opened with it are discarded (the owner sets a new password); a password reset
 *   replaces it and ends all sessions as well.
 * - `customerAccounts.enabled = false` disables every entry point; existing sessions stop
 *   resolving immediately.
 */

const SESSION_TOUCH_INTERVAL_MS = 60_000;
const TOKEN_BYTES = 32;
const MAX_PASSWORD_LENGTH = 1_024;
const DEFAULT_ORDER_LIMIT = 100;
const MAX_ORDER_LIMIT = 500;

// ─── Input schemas (shared with the web forms) ────────────────────────────────────────

const nameSchema = z.string().trim().min(1).max(100);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

/** E-mail as typed by the customer → trimmed, lower-cased, validated. */
export const customerEmailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
const passwordSchema = z.string().min(1).max(MAX_PASSWORD_LENGTH);
const accountLocaleSchema = z.enum(SUPPORTED_LOCALES);

export const registerCustomerSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  email: customerEmailSchema,
  password: passwordSchema,
  locale: accountLocaleSchema,
  /** Locale-independent path to continue with after confirming / signing in. */
  returnPath: z.string().max(1_000).nullish(),
});
export type RegisterCustomerInput = z.input<typeof registerCustomerSchema>;

export const customerLoginSchema = z.object({
  email: customerEmailSchema,
  password: passwordSchema,
});
export type CustomerLoginInput = z.input<typeof customerLoginSchema>;

/** Requests that send an e-mail to an address (login link, password reset). */
export const customerEmailRequestSchema = z.object({
  email: customerEmailSchema,
  locale: accountLocaleSchema,
  returnPath: z.string().max(1_000).nullish(),
});
export type CustomerEmailRequestInput = z.input<typeof customerEmailRequestSchema>;

export const customerProfileSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  phone: optionalText(50),
  /** Complete postal address or null (address is optional for B2C tickets). */
  address: postalAddressSchema.nullable(),
});
export type CustomerProfileInput = z.input<typeof customerProfileSchema>;

// ─── Public types ─────────────────────────────────────────────────────────────────────

export interface CustomerRequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** A resolved customer session (cookie token → customer). */
export interface CustomerSessionRecord {
  customerId: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  address: PostalAddress | null;
  locale: string | null;
  emailVerified: boolean;
  /** False after a passwordless first sign-in (login link) – the customer can set one. */
  hasPassword: boolean;
  /** Set when the session was created by linking a signed-in admin (see admin-link.ts). */
  linkedAdminUserId: string | null;
  expiresAt: Date;
}

export interface CustomerOrderEvent {
  eventId: string;
  title: string;
  subtitle: string | null;
  startsAt: Date;
  timeZone: string;
}

export interface CustomerOrderSummary {
  id: string;
  orderNumber: string;
  createdAt: Date;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  totalGross: number;
  currency: string;
  /** Order items (admitted persons) of all events. */
  ticketCount: number;
  /** Events of the (multi-event) order, earliest first. */
  events: CustomerOrderEvent[];
}

// ─── Errors ───────────────────────────────────────────────────────────────────────────

const accountsDisabled = () =>
  new DomainError('ACCOUNTS_DISABLED', 'Customer accounts are not available', 403);
const invalidCredentials = () =>
  new DomainError('INVALID_CREDENTIALS', 'E-mail address or password is not correct', 401);
const accountLocked = (minutes: number) =>
  new DomainError(
    'ACCOUNT_LOCKED',
    'Too many failed sign-in attempts. Please try again later or sign in via e-mail.',
    423,
    { minutes },
  );
const tokenInvalid = () =>
  new DomainError('TOKEN_INVALID', 'This link is invalid or has expired', 400);
const customerNotFound = () =>
  new DomainError('CUSTOMER_NOT_FOUND', 'Customer account not found', 404);

// ─── Settings & small helpers ─────────────────────────────────────────────────────────

export async function customerAccountsEnabled(ctx: Pick<CoreContext, 'db'>): Promise<boolean> {
  return (await getSetting(ctx, 'customerAccounts')).enabled;
}

async function requireAccounts(ctx: Pick<CoreContext, 'db'>) {
  const settings = await getSetting(ctx, 'customerAccounts');
  if (!settings.enabled) throw accountsDisabled();
  return settings;
}

function assertPasswordStrength(password: string, minLength: number): void {
  if ([...password].length < minLength) {
    throw new DomainError(
      'WEAK_PASSWORD',
      `The password must have at least ${minLength} characters`,
      422,
      { min: minLength },
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new DomainError('PASSWORD_TOO_LONG', 'The password is too long', 422, {
      max: MAX_PASSWORD_LENGTH,
    });
  }
}

/** Shape check before hashing / querying (base64url, sane length). */
function isPlausibleToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(token);
}

const localePrefix = new RegExp(`^/(?:${SUPPORTED_LOCALES.join('|')})(?=/|$|\\?|#)`);

/**
 * Validates a `?next=` return path: only same-origin, relative paths starting with a single
 * "/" are accepted (no scheme, no protocol-relative "//host", no backslashes or control
 * characters). A leading locale segment is removed – the result is locale-independent
 * (e.g. "/checkout") and is prefixed with the current locale when redirecting.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > 1_000) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  if (/[\\\u0000-\u001F\u007F]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, 'http://return.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'http://return.invalid') return null;
  const path = `${url.pathname}${url.search}${url.hash}`.replace(localePrefix, '') || '/';
  // "//host" after URL normalisation / locale stripping (e.g. "/en//evil.example", "/.//evil")
  // would be a protocol-relative URL: reject, never repair.
  if (path.startsWith('//') || path.includes('\\')) return null;
  return path.startsWith('/') ? path : `/${path}`;
}

/** Absolute link to an account page for e-mails, e.g. https://shop.example/de/account/verify?token=… */
function accountUrl(
  ctx: CoreContext,
  locale: AppLocale,
  page: 'verify' | 'reset-password' | 'login-link',
  params: Record<string, string | null | undefined>,
): string {
  const base = requireCapability(ctx, 'appUrl');
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  return `${base}/${locale}/account/${page}?${query.toString()}`;
}

function validIp(ip: string | null | undefined): string | null {
  return ip && isIP(ip) !== 0 && ip !== '0.0.0.0' ? ip : null;
}

const byEmail = (email: string) => sql`lower(${customers.email}) = ${email}`;

/** Rows that are customer *accounts* able to sign in. */
const activeAccount = and(isNotNull(customers.accountCreatedAt), isNull(customers.anonymizedAt));

const verifiedNow = sql`coalesce(${customers.emailVerifiedAt}, now())`;

// ─── Single-use e-mail tokens ─────────────────────────────────────────────────────────

/**
 * Creates a token for `purpose` and returns the clear value (it only travels in the e-mail).
 * Expired tokens of the customer are purged; `replace` also invalidates earlier unused tokens
 * of the same purpose (only the newest password-reset / login link works).
 */
async function issueToken(
  db: Executor,
  customerId: string,
  purpose: CustomerTokenPurpose,
  ttlMs: number,
  replace: boolean,
): Promise<string> {
  await db
    .delete(customerTokens)
    .where(
      and(
        eq(customerTokens.customerId, customerId),
        or(
          lte(customerTokens.expiresAt, sql`now()`),
          replace
            ? and(eq(customerTokens.purpose, purpose), isNull(customerTokens.consumedAt))
            : undefined,
        ),
      ),
    );
  const token = generateToken(TOKEN_BYTES);
  await db.insert(customerTokens).values({
    customerId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return token;
}

/** Atomically marks a valid token as used; returns its customer or null. */
async function consumeToken(
  db: Executor,
  token: unknown,
  purpose: CustomerTokenPurpose,
): Promise<string | null> {
  if (!isPlausibleToken(token)) return null;
  const [row] = await db
    .update(customerTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(customerTokens.tokenHash, hashToken(token)),
        eq(customerTokens.purpose, purpose),
        isNull(customerTokens.consumedAt),
        gt(customerTokens.expiresAt, sql`now()`),
      ),
    )
    .returning({ customerId: customerTokens.customerId });
  return row?.customerId ?? null;
}

const TOKEN_MAIL: Record<
  CustomerTokenPurpose,
  {
    key: Extract<
      EmailTemplateKey,
      'CUSTOMER_EMAIL_VERIFICATION' | 'CUSTOMER_PASSWORD_RESET' | 'CUSTOMER_LOGIN_LINK'
    >;
    page: 'verify' | 'reset-password' | 'login-link';
    variable: 'verificationUrl' | 'resetUrl' | 'loginUrl';
    /** Only the newest link of this purpose stays valid. */
    replace: boolean;
  }
> = {
  EMAIL_VERIFICATION: {
    key: 'CUSTOMER_EMAIL_VERIFICATION',
    page: 'verify',
    variable: 'verificationUrl',
    replace: false,
  },
  PASSWORD_RESET: {
    key: 'CUSTOMER_PASSWORD_RESET',
    page: 'reset-password',
    variable: 'resetUrl',
    replace: true,
  },
  LOGIN_LINK: {
    key: 'CUSTOMER_LOGIN_LINK',
    page: 'login-link',
    variable: 'loginUrl',
    replace: true,
  },
};

type AccountSettings = Awaited<ReturnType<typeof requireAccounts>>;

const tokenTtlMs = (settings: AccountSettings, purpose: CustomerTokenPurpose) =>
  purpose === 'EMAIL_VERIFICATION'
    ? settings.emailVerificationTtlHours * 3_600_000
    : (purpose === 'LOGIN_LINK' ? settings.loginLinkTtlMinutes : settings.passwordResetTtlMinutes) *
      60_000;

/**
 * Issues a single-use token and stores the e-mail carrying its link in the outbox – both in
 * the caller's transaction, so a token never exists without its e-mail. Returns the message
 * id; call `dispatchEmailMessage` after the commit.
 */
async function issueTokenMail(
  ctx: CoreContext,
  tx: Executor,
  settings: AccountSettings,
  customer: { id: string; email: string; firstName: string },
  purpose: CustomerTokenPurpose,
  locale: AppLocale,
  returnPath: string | null,
): Promise<string> {
  const mail = TOKEN_MAIL[purpose];
  const token = await issueToken(
    tx,
    customer.id,
    purpose,
    tokenTtlMs(settings, purpose),
    mail.replace,
  );
  return createEmailMessage(ctx, tx, {
    key: mail.key,
    to: customer.email,
    locale,
    customerId: customer.id,
    variables: {
      firstName: customer.firstName,
      [mail.variable]: accountUrl(ctx, locale, mail.page, { token, next: returnPath }),
    },
  });
}

// ─── Registration & e-mail verification ───────────────────────────────────────────────

/**
 * Registers an account – always with the same neutral outcome ("check your inbox"):
 * - new address → account created, verification e-mail sent;
 * - guest customer of that address → upgraded to an account (password set), verification
 *   e-mail sent; its earlier orders appear once the address is verified;
 * - existing account → nothing changes; the owner receives a login link (or, when login
 *   links are disabled, a password-reset link) instead, so the response reveals nothing.
 */
export async function registerCustomer(
  ctx: CoreContext,
  input: RegisterCustomerInput,
): Promise<void> {
  const settings = await requireAccounts(ctx);
  const data = registerCustomerSchema.parse(input);
  assertPasswordStrength(data.password, settings.passwordMinLength);
  const returnPath = safeReturnPath(data.returnPath);
  // Hash on every path: the response time must not tell whether the address is known.
  const passwordHash = await hashPassword(data.password);
  const mail = (
    tx: Executor,
    customer: { id: string; email: string; firstName: string },
    purpose: CustomerTokenPurpose,
  ) => issueTokenMail(ctx, tx, settings, customer, purpose, data.locale, returnPath);

  const messageId = await withTransaction<string | null>(ctx.db, async (tx) => {
    const select = () =>
      tx
        .select({
          id: customers.id,
          email: customers.email,
          firstName: customers.firstName,
          locale: customers.locale,
          accountCreatedAt: customers.accountCreatedAt,
          anonymizedAt: customers.anonymizedAt,
        })
        .from(customers)
        .where(byEmail(data.email))
        .for('update');

    let [existing] = await select();
    if (!existing) {
      const [created] = await tx
        .insert(customers)
        .values({
          email: data.email,
          firstName: data.firstName,
          lastName: data.lastName,
          locale: data.locale,
          passwordHash,
          accountCreatedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: customers.id, email: customers.email, firstName: customers.firstName });
      if (created) return mail(tx, created, 'EMAIL_VERIFICATION');
      // A concurrent checkout / registration created the row meanwhile.
      [existing] = await select();
      if (!existing) throw new Error('Customer row vanished during registration');
    }

    if (existing.anonymizedAt) return null;

    if (!existing.accountCreatedAt) {
      // Guest → account. The address must be (re-)verified by this registrant before any
      // earlier order becomes visible.
      await tx
        .update(customers)
        .set({
          firstName: data.firstName,
          lastName: data.lastName,
          locale: existing.locale ?? data.locale,
          passwordHash,
          accountCreatedAt: new Date(),
          emailVerifiedAt: null,
          failedLoginCount: 0,
          lockedUntil: null,
        })
        .where(eq(customers.id, existing.id));
      return mail(
        tx,
        { id: existing.id, email: existing.email, firstName: data.firstName },
        'EMAIL_VERIFICATION',
      );
    }

    // Existing account: change nothing, help the owner to sign in instead.
    return mail(tx, existing, settings.loginLinkEnabled ? 'LOGIN_LINK' : 'PASSWORD_RESET');
  });

  if (messageId) await dispatchEmailMessage(ctx, messageId);
}

/**
 * (Re-)sends the verification e-mail to a signed-in customer. Returns `alreadyVerified`
 * when there is nothing to confirm.
 */
export async function sendEmailVerification(
  ctx: CoreContext,
  customerId: string,
  options: { locale: AppLocale; returnPath?: string | null },
): Promise<{ alreadyVerified: boolean }> {
  const settings = await requireAccounts(ctx);
  const locale = accountLocaleSchema.parse(options.locale);
  const messageId = await withTransaction(ctx.db, async (tx) => {
    const [customer] = await tx
      .select({
        id: customers.id,
        email: customers.email,
        firstName: customers.firstName,
        emailVerifiedAt: customers.emailVerifiedAt,
      })
      .from(customers)
      .where(and(eq(customers.id, customerId), activeAccount))
      .for('update');
    if (!customer) throw customerNotFound();
    if (customer.emailVerifiedAt) return null;
    return issueTokenMail(
      ctx,
      tx,
      settings,
      customer,
      'EMAIL_VERIFICATION',
      locale,
      safeReturnPath(options.returnPath),
    );
  });
  if (!messageId) return { alreadyVerified: true };
  await dispatchEmailMessage(ctx, messageId);
  return { alreadyVerified: false };
}

/**
 * Consumes an e-mail verification token. A link opened a second time (or first by a mail
 * scanner) reports `alreadyVerified` instead of an error while the token has not expired.
 *
 * First proof of the address: a password set while it was unverified may stem from someone
 * else, so it is discarded together with all sessions (`passwordCleared`, as in
 * `consumeLoginLink`) – unless the verifying browser holds a session of this very account
 * (`sessionToken`, the registrant confirming in the browser they signed in with): then the
 * password stays and only the other sessions end.
 */
export async function verifyCustomerEmail(
  ctx: CoreContext,
  token: string,
  options: { sessionToken?: string | null } = {},
): Promise<{ customerId: string; alreadyVerified: boolean; passwordCleared?: boolean }> {
  await requireAccounts(ctx);
  return withTransaction(ctx.db, async (tx) => {
    const customerId = await consumeToken(tx, token, 'EMAIL_VERIFICATION');
    if (!customerId) {
      if (!isPlausibleToken(token)) throw tokenInvalid();
      const [used] = await tx
        .select({ customerId: customers.id, verifiedAt: customers.emailVerifiedAt })
        .from(customerTokens)
        .innerJoin(customers, eq(customers.id, customerTokens.customerId))
        .where(
          and(
            eq(customerTokens.tokenHash, hashToken(token)),
            eq(customerTokens.purpose, 'EMAIL_VERIFICATION'),
            isNotNull(customerTokens.consumedAt),
            gt(customerTokens.expiresAt, sql`now()`),
            activeAccount,
          ),
        );
      if (used?.verifiedAt) return { customerId: used.customerId, alreadyVerified: true };
      throw tokenInvalid();
    }
    const [customer] = await tx
      .select({ emailVerifiedAt: customers.emailVerifiedAt, passwordHash: customers.passwordHash })
      .from(customers)
      .where(and(eq(customers.id, customerId), activeAccount))
      .for('update');
    if (!customer) throw tokenInvalid();
    const firstProof = customer.emailVerifiedAt === null;
    let passwordCleared = false;
    if (firstProof) {
      const own = isPlausibleToken(options.sessionToken) ? hashToken(options.sessionToken) : null;
      const [ownSession] = own
        ? await tx
            .select({ tokenHash: customerSessions.tokenHash })
            .from(customerSessions)
            .where(
              and(eq(customerSessions.tokenHash, own), eq(customerSessions.customerId, customerId)),
            )
        : [];
      passwordCleared = customer.passwordHash !== null && !ownSession;
      await tx
        .delete(customerSessions)
        .where(
          and(
            eq(customerSessions.customerId, customerId),
            ownSession && own ? ne(customerSessions.tokenHash, own) : undefined,
          ),
        );
    }
    await tx
      .update(customers)
      .set({
        emailVerifiedAt: verifiedNow,
        ...(passwordCleared ? { passwordHash: null, failedLoginCount: 0, lockedUntil: null } : {}),
      })
      .where(eq(customers.id, customerId));
    return { customerId, alreadyVerified: false, passwordCleared };
  });
}

// ─── Password sign-in & lockout ───────────────────────────────────────────────────────

let dummyHash: Promise<string> | null = null;
const timingDummy = () => (dummyHash ??= hashPassword('tix-timing-dummy-password'));

/**
 * Verifies e-mail + password and returns the customer (the caller creates the session).
 *
 * Lockout: after `security.maxFailedLogins` consecutive failures the account is locked for
 * `security.lockoutMinutes`. Unknown addresses, guests and password-less accounts get the
 * same INVALID_CREDENTIALS / ACCOUNT_LOCKED sequence (counted in Redis) and the same Argon2
 * work, so neither the error nor its timing reveals whether an account exists.
 */
export async function authenticateCustomer(
  ctx: CoreContext,
  input: CustomerLoginInput,
): Promise<{ customerId: string }> {
  await requireAccounts(ctx);
  const security = await getSetting(ctx, 'security');
  const parsed = customerLoginSchema.safeParse(input);
  if (!parsed.success) throw invalidCredentials();
  const { email, password } = parsed.data;

  const [row] = await ctx.db
    .select({
      id: customers.id,
      passwordHash: customers.passwordHash,
      locked: sql<boolean>`coalesce(${customers.lockedUntil} > now(), false)`,
    })
    .from(customers)
    .where(and(byEmail(email), activeAccount));

  if (!row?.passwordHash) {
    const failure = await unknownLoginFailure(ctx, security, email);
    await verifyPassword(await timingDummy(), password);
    throw failure;
  }

  if (row.locked) throw accountLocked(security.lockoutMinutes);

  if (!(await verifyPassword(row.passwordHash, password))) {
    throw await passwordLoginFailure(ctx, security, row.id);
  }

  await clearCustomerLoginFailures(ctx, row.id, row.passwordHash, password);
  return { customerId: row.id };
}

type SecuritySettings = Awaited<ReturnType<typeof getSecuritySettings>>;
const getSecuritySettings = (ctx: Pick<CoreContext, 'db'>) => getSetting(ctx, 'security');

/** Unknown address / guest / password-less account: Redis counter, same sequence as a real account. */
async function unknownLoginFailure(
  ctx: CoreContext,
  security: SecuritySettings,
  email: string,
): Promise<DomainError> {
  const attempt = await rateLimit(
    ctx.redis,
    ctx.keys,
    'customer-login-unknown',
    hashToken(email).slice(0, 40),
    security.maxFailedLogins - 1,
    security.lockoutMinutes * 60_000,
  );
  if (attempt.count > security.maxFailedLogins) return accountLocked(security.lockoutMinutes);
  return attempt.allowed ? invalidCredentials() : accountLocked(security.lockoutMinutes);
}

/** Counts a wrong password of an existing account; returns the error to throw. */
async function passwordLoginFailure(
  ctx: CoreContext,
  security: SecuritySettings,
  customerId: string,
): Promise<DomainError> {
  const reached = sql`${customers.failedLoginCount} + 1 >= ${security.maxFailedLogins}`;
  const [updated] = await ctx.db
    .update(customers)
    .set({
      failedLoginCount: sql`CASE WHEN ${reached} THEN 0 ELSE ${customers.failedLoginCount} + 1 END`,
      lockedUntil: sql`CASE WHEN ${reached}
          THEN now() + make_interval(mins => ${security.lockoutMinutes}::int)
          ELSE ${customers.lockedUntil} END`,
    })
    .where(eq(customers.id, customerId))
    .returning({ locked: sql<boolean>`coalesce(${customers.lockedUntil} > now(), false)` });
  return updated?.locked ? accountLocked(security.lockoutMinutes) : invalidCredentials();
}

async function clearCustomerLoginFailures(
  ctx: CoreContext,
  customerId: string,
  passwordHash: string,
  password: string,
): Promise<void> {
  await ctx.db
    .update(customers)
    .set({
      failedLoginCount: 0,
      lockedUntil: null,
      ...(needsRehash(passwordHash) ? { passwordHash: await hashPassword(password) } : {}),
    })
    // Optimistic guard: a concurrent takeover guard / password change wins.
    .where(and(eq(customers.id, customerId), eq(customers.passwordHash, passwordHash)));
}

export type CustomerPasswordCheck =
  /** Match; `passwordHash` is the verified hash (pass it to `createCustomerSession`). */
  | { status: 'ok'; customerId: string; passwordHash: string }
  /** The password is right but the account is locked (not a failure, no session). */
  | { status: 'locked-match' }
  | { status: 'invalid' };

/**
 * Password check WITHOUT counting a failure (shop sign-in shared with admin accounts): the
 * result for e-mail + password (`invalid` also when customer accounts are disabled). Unknown,
 * locked and password-less accounts do the same Argon2 work.
 * A caller that ends up with no match at all counts it via `countCustomerLoginFailure`.
 */
export async function checkCustomerPassword(
  ctx: CoreContext,
  input: CustomerLoginInput,
): Promise<CustomerPasswordCheck> {
  if (!(await customerAccountsEnabled(ctx))) return { status: 'invalid' };
  const parsed = customerLoginSchema.safeParse(input);
  if (!parsed.success) return { status: 'invalid' };
  const { email, password } = parsed.data;
  const [row] = await ctx.db
    .select({
      id: customers.id,
      passwordHash: customers.passwordHash,
      locked: sql<boolean>`coalesce(${customers.lockedUntil} > now(), false)`,
    })
    .from(customers)
    .where(and(byEmail(email), activeAccount));
  if (!row?.passwordHash) {
    await verifyPassword(await timingDummy(), password);
    return { status: 'invalid' };
  }
  // Locked accounts do the same Argon2 work against the real hash.
  if (!(await verifyPassword(row.passwordHash, password))) return { status: 'invalid' };
  if (row.locked) return { status: 'locked-match' };
  await clearCustomerLoginFailures(ctx, row.id, row.passwordHash, password);
  return { status: 'ok', customerId: row.id, passwordHash: row.passwordHash };
}

/**
 * Counts a failed customer sign-in like `authenticateCustomer` (account row, or the Redis
 * counter for unknown addresses) and returns the error to show: INVALID_CREDENTIALS or
 * ACCOUNT_LOCKED. No password work. Customer accounts disabled: always INVALID_CREDENTIALS.
 */
export async function countCustomerLoginFailure(
  ctx: CoreContext,
  emailInput: string,
): Promise<DomainError> {
  const email = customerEmailSchema.safeParse(emailInput);
  if (!email.success || !(await customerAccountsEnabled(ctx))) return invalidCredentials();
  const security = await getSetting(ctx, 'security');
  const [row] = await ctx.db
    .select({
      id: customers.id,
      passwordHash: customers.passwordHash,
      locked: sql<boolean>`coalesce(${customers.lockedUntil} > now(), false)`,
    })
    .from(customers)
    .where(and(byEmail(email.data), activeAccount));
  if (!row?.passwordHash) return unknownLoginFailure(ctx, security, email.data);
  if (row.locked) return accountLocked(security.lockoutMinutes);
  return passwordLoginFailure(ctx, security, row.id);
}

// ─── Passwordless login link ──────────────────────────────────────────────────────────

/** Sends a sign-in link to an existing account. Always answers neutrally. */
export async function requestLoginLink(
  ctx: CoreContext,
  input: CustomerEmailRequestInput,
): Promise<void> {
  const settings = await requireAccounts(ctx);
  if (!settings.loginLinkEnabled) {
    throw new DomainError('LOGIN_LINK_DISABLED', 'Sign-in via e-mail link is not available', 403);
  }
  await mailSignInLink(ctx, settings, input, 'LOGIN_LINK');
}

/** Login link / password reset for an existing account; unknown addresses get nothing. */
async function mailSignInLink(
  ctx: CoreContext,
  settings: AccountSettings,
  input: CustomerEmailRequestInput,
  purpose: 'LOGIN_LINK' | 'PASSWORD_RESET',
): Promise<void> {
  const data = customerEmailRequestSchema.parse(input);
  const messageId = await withTransaction(ctx.db, async (tx) => {
    const [customer] = await tx
      .select({ id: customers.id, email: customers.email, firstName: customers.firstName })
      .from(customers)
      .where(and(byEmail(data.email), activeAccount))
      .for('update');
    if (!customer) return null;
    return issueTokenMail(
      ctx,
      tx,
      settings,
      customer,
      purpose,
      data.locale,
      safeReturnPath(data.returnPath),
    );
  });
  if (messageId) await dispatchEmailMessage(ctx, messageId);
}

/**
 * Consumes a login link (proves ownership of the address → `email_verified_at`). If the
 * address was not verified before, a password set in the meantime is discarded together with
 * its sessions (`passwordCleared`) – it may have been set by someone else.
 */
export async function consumeLoginLink(
  ctx: CoreContext,
  token: string,
): Promise<{ customerId: string; passwordCleared: boolean }> {
  const settings = await requireAccounts(ctx);
  if (!settings.loginLinkEnabled) {
    throw new DomainError('LOGIN_LINK_DISABLED', 'Sign-in via e-mail link is not available', 403);
  }
  return withTransaction(ctx.db, async (tx) => {
    const customerId = await consumeToken(tx, token, 'LOGIN_LINK');
    if (!customerId) throw tokenInvalid();
    const [customer] = await tx
      .select({ emailVerifiedAt: customers.emailVerifiedAt, passwordHash: customers.passwordHash })
      .from(customers)
      .where(and(eq(customers.id, customerId), activeAccount))
      .for('update');
    if (!customer) throw tokenInvalid();
    const firstProof = customer.emailVerifiedAt === null;
    const passwordCleared = firstProof && customer.passwordHash !== null;
    await tx
      .update(customers)
      .set({
        emailVerifiedAt: verifiedNow,
        failedLoginCount: 0,
        lockedUntil: null,
        ...(passwordCleared ? { passwordHash: null } : {}),
      })
      .where(eq(customers.id, customerId));
    if (firstProof) {
      await tx.delete(customerSessions).where(eq(customerSessions.customerId, customerId));
    }
    return { customerId, passwordCleared };
  });
}

// ─── Password reset ───────────────────────────────────────────────────────────────────

/** Sends a password-reset link to an existing account. Always answers neutrally. */
export async function requestPasswordReset(
  ctx: CoreContext,
  input: CustomerEmailRequestInput,
): Promise<void> {
  const settings = await requireAccounts(ctx);
  await mailSignInLink(ctx, settings, input, 'PASSWORD_RESET');
}

/** Whether a reset link is still usable (does not consume it) – for showing the form. */
export async function isPasswordResetTokenValid(
  ctx: CoreContext,
  token: unknown,
): Promise<boolean> {
  if (!(await customerAccountsEnabled(ctx)) || !isPlausibleToken(token)) return false;
  const [row] = await ctx.db
    .select({ id: customerTokens.id })
    .from(customerTokens)
    .innerJoin(customers, eq(customers.id, customerTokens.customerId))
    .where(
      and(
        eq(customerTokens.tokenHash, hashToken(token)),
        eq(customerTokens.purpose, 'PASSWORD_RESET'),
        isNull(customerTokens.consumedAt),
        gt(customerTokens.expiresAt, sql`now()`),
        activeAccount,
      ),
    );
  return Boolean(row);
}

/**
 * Sets a new password via a reset link: consumes the token, verifies the address, lifts a
 * lockout, revokes every session and every other outstanding sign-in link.
 */
export async function resetCustomerPassword(
  ctx: CoreContext,
  input: { token: string; password: string },
): Promise<{ customerId: string }> {
  const settings = await requireAccounts(ctx);
  assertPasswordStrength(input.password, settings.passwordMinLength);
  if (!isPlausibleToken(input.token)) throw tokenInvalid();
  const passwordHash = await hashPassword(input.password);
  return withTransaction(ctx.db, async (tx) => {
    const customerId = await consumeToken(tx, input.token, 'PASSWORD_RESET');
    if (!customerId) throw tokenInvalid();
    const [updated] = await tx
      .update(customers)
      .set({ passwordHash, emailVerifiedAt: verifiedNow, failedLoginCount: 0, lockedUntil: null })
      .where(and(eq(customers.id, customerId), activeAccount))
      .returning({ id: customers.id });
    if (!updated) throw tokenInvalid();
    await tx.delete(customerSessions).where(eq(customerSessions.customerId, customerId));
    await tx
      .delete(customerTokens)
      .where(
        and(
          eq(customerTokens.customerId, customerId),
          inArray(customerTokens.purpose, ['PASSWORD_RESET', 'LOGIN_LINK']),
          isNull(customerTokens.consumedAt),
        ),
      );
    return { customerId };
  });
}

// ─── Sessions ─────────────────────────────────────────────────────────────────────────

export interface SessionOptions {
  /** Password sign-in: fail (INVALID_CREDENTIALS) unless this hash is still the account's. */
  requirePasswordHash?: string;
  /** Session created by linking this admin: revoked with the admin's access. */
  linkedAdminUserId?: string;
  /** The session never outlives this moment (the admin session's expiry). */
  cap?: Date;
}

/**
 * Opens a session for a customer account. Returns the clear token for the cookie (only its
 * hash is stored) and the cookie lifetime (`customerAccounts.sessionTtlDays`).
 */
export async function createCustomerSession(
  ctx: CoreContext,
  customerId: string,
  meta: CustomerRequestMeta = {},
  options: SessionOptions = {},
): Promise<{ token: string; expiresAt: Date; maxAgeSeconds: number }> {
  const settings = await requireAccounts(ctx);
  let maxAgeSeconds = settings.sessionTtlDays * 86_400;
  if (options.cap) {
    maxAgeSeconds = Math.min(
      maxAgeSeconds,
      Math.max(1, Math.floor((options.cap.getTime() - Date.now()) / 1_000)),
    );
  }
  const expiresAt = new Date(Date.now() + maxAgeSeconds * 1_000);
  const token = generateToken(TOKEN_BYTES);
  await withTransaction(ctx.db, async (tx) => {
    const [customer] = await tx
      .update(customers)
      .set({ lastLoginAt: new Date() })
      .where(
        and(
          eq(customers.id, customerId),
          activeAccount,
          // Password sign-in: the verified hash must still be current (the admin-link takeover
          // guard may have removed it meanwhile; the row lock serialises both).
          options.requirePasswordHash
            ? eq(customers.passwordHash, options.requirePasswordHash)
            : undefined,
        ),
      )
      .returning({ id: customers.id });
    if (!customer) {
      throw options.requirePasswordHash ? invalidCredentials() : customerNotFound();
    }
    await tx
      .delete(customerSessions)
      .where(
        and(
          eq(customerSessions.customerId, customerId),
          lte(customerSessions.expiresAt, sql`now()`),
        ),
      );
    await tx.insert(customerSessions).values({
      tokenHash: hashToken(token),
      customerId,
      expiresAt,
      linkedAdminUserId: options.linkedAdminUserId ?? null,
      ipAddress: validIp(meta.ipAddress),
      userAgent: meta.userAgent ? meta.userAgent.slice(0, 500) : null,
    });
  });
  return { token, expiresAt, maxAgeSeconds };
}

/**
 * Customer of a session token, or null (unknown / expired / revoked token, anonymised
 * customer, accounts disabled). `last_seen_at` is refreshed at most once per minute.
 * Lowering `sessionTtlDays` takes effect for existing sessions immediately.
 */
export async function resolveCustomerSession(
  ctx: CoreContext,
  token: string | null | undefined,
): Promise<CustomerSessionRecord | null> {
  if (!isPlausibleToken(token)) return null;
  const settings = await getSetting(ctx, 'customerAccounts');
  if (!settings.enabled) return null;
  const tokenHash = hashToken(token);
  const [row] = await ctx.db
    .select({
      customerId: customers.id,
      email: customers.email,
      firstName: customers.firstName,
      lastName: customers.lastName,
      phone: customers.phone,
      address: customers.address,
      locale: customers.locale,
      emailVerifiedAt: customers.emailVerifiedAt,
      hasPassword: sql<boolean>`${customers.passwordHash} IS NOT NULL`,
      linkedAdminUserId: customerSessions.linkedAdminUserId,
      expiresAt: customerSessions.expiresAt,
      lastSeenAt: customerSessions.lastSeenAt,
    })
    .from(customerSessions)
    .innerJoin(customers, eq(customers.id, customerSessions.customerId))
    .where(
      and(
        eq(customerSessions.tokenHash, tokenHash),
        gt(customerSessions.expiresAt, sql`now()`),
        gt(
          customerSessions.createdAt,
          sql`now() - make_interval(days => ${settings.sessionTtlDays}::int)`,
        ),
        activeAccount,
      ),
    );
  if (!row) return null;
  if (Date.now() - row.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    await ctx.db
      .update(customerSessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(customerSessions.tokenHash, tokenHash));
  }
  return {
    customerId: row.customerId,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    address: row.address,
    locale: row.locale,
    emailVerified: row.emailVerifiedAt !== null,
    hasPassword: row.hasPassword,
    linkedAdminUserId: row.linkedAdminUserId,
    expiresAt: row.expiresAt,
  };
}

/** Ends one session (logout). Works even when accounts were disabled meanwhile. */
export async function revokeCustomerSession(ctx: CoreContext, token: string): Promise<void> {
  if (!isPlausibleToken(token)) return;
  await ctx.db.delete(customerSessions).where(eq(customerSessions.tokenHash, hashToken(token)));
}

/** Ends all sessions of a customer, optionally keeping the current one. */
export async function revokeAllCustomerSessions(
  ctx: CoreContext,
  customerId: string,
  options: { exceptToken?: string | null } = {},
): Promise<number> {
  const keep = isPlausibleToken(options.exceptToken) ? hashToken(options.exceptToken) : null;
  const removed = await ctx.db
    .delete(customerSessions)
    .where(
      and(
        eq(customerSessions.customerId, customerId),
        keep ? ne(customerSessions.tokenHash, keep) : undefined,
      ),
    )
    .returning({ tokenHash: customerSessions.tokenHash });
  return removed.length;
}

/** Housekeeping for a periodic job: removes expired sessions and long-expired tokens. */
export async function purgeExpiredCustomerAuthData(
  ctx: Pick<CoreContext, 'db'>,
): Promise<{ sessions: number; tokens: number }> {
  const sessions = await ctx.db
    .delete(customerSessions)
    .where(lte(customerSessions.expiresAt, sql`now()`))
    .returning({ tokenHash: customerSessions.tokenHash });
  const tokens = await ctx.db
    .delete(customerTokens)
    .where(lte(customerTokens.expiresAt, sql`now() - interval '1 day'`))
    .returning({ id: customerTokens.id });
  return { sessions: sessions.length, tokens: tokens.length };
}

// ─── Profile & password ───────────────────────────────────────────────────────────────

/**
 * Updates name, phone and postal address. The e-mail address cannot be changed here.
 * Orders keep their own buyer snapshot – past orders are not altered.
 */
export async function updateCustomerProfile(
  ctx: CoreContext,
  customerId: string,
  input: CustomerProfileInput,
): Promise<void> {
  await requireAccounts(ctx);
  const data = customerProfileSchema.parse(input);
  const [updated] = await ctx.db
    .update(customers)
    .set({
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone,
      address: data.address,
    })
    .where(and(eq(customers.id, customerId), activeAccount))
    .returning({ id: customers.id });
  if (!updated) throw customerNotFound();
}

/**
 * Changes (or, for a password-less account, sets) the password. The current password is
 * required when one exists. All other sessions and outstanding sign-in links are revoked;
 * the session given in `keepSessionToken` stays signed in.
 */
export async function changeCustomerPassword(
  ctx: CoreContext,
  customerId: string,
  input: { currentPassword?: string | null; newPassword: string },
  options: { keepSessionToken?: string | null } = {},
): Promise<void> {
  const settings = await requireAccounts(ctx);
  assertPasswordStrength(input.newPassword, settings.passwordMinLength);
  const [customer] = await ctx.db
    .select({ passwordHash: customers.passwordHash })
    .from(customers)
    .where(and(eq(customers.id, customerId), activeAccount));
  if (!customer) throw customerNotFound();
  const currentInvalid = () =>
    new DomainError('CURRENT_PASSWORD_INVALID', 'The current password is not correct', 422);
  if (customer.passwordHash) {
    const current = input.currentPassword ?? '';
    if (current.length === 0 || current.length > MAX_PASSWORD_LENGTH) throw currentInvalid();
    if (!(await verifyPassword(customer.passwordHash, current))) throw currentInvalid();
  }
  const passwordHash = await hashPassword(input.newPassword);
  const keep = isPlausibleToken(options.keepSessionToken)
    ? hashToken(options.keepSessionToken)
    : null;
  await withTransaction(ctx.db, async (tx) => {
    const [updated] = await tx
      .update(customers)
      .set({ passwordHash, failedLoginCount: 0, lockedUntil: null })
      .where(
        and(
          eq(customers.id, customerId),
          activeAccount,
          // Optimistic guard: the password must not have changed since it was verified.
          customer.passwordHash
            ? eq(customers.passwordHash, customer.passwordHash)
            : isNull(customers.passwordHash),
        ),
      )
      .returning({ id: customers.id });
    if (!updated) throw currentInvalid();
    await tx
      .delete(customerSessions)
      .where(
        and(
          eq(customerSessions.customerId, customerId),
          keep ? ne(customerSessions.tokenHash, keep) : undefined,
        ),
      );
    await tx
      .delete(customerTokens)
      .where(
        and(
          eq(customerTokens.customerId, customerId),
          inArray(customerTokens.purpose, ['PASSWORD_RESET', 'LOGIN_LINK']),
          isNull(customerTokens.consumedAt),
        ),
      );
  });
}

// ─── Orders ───────────────────────────────────────────────────────────────────────────

/**
 * Orders linked to the customer (newest first) – empty until the e-mail address has been
 * verified, because registering attaches every earlier guest order of that address.
 */
export async function listCustomerOrders(
  ctx: CoreContext,
  customerId: string,
  options: {
    limit?: number;
    /** Content locale of event texts (default: shop language). */ locale?: string;
  } = {},
): Promise<CustomerOrderSummary[]> {
  await requireAccounts(ctx);
  const [customer] = await ctx.db
    .select({ emailVerifiedAt: customers.emailVerifiedAt })
    .from(customers)
    .where(and(eq(customers.id, customerId), activeAccount));
  if (!customer?.emailVerifiedAt) return [];

  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? DEFAULT_ORDER_LIMIT), 1),
    MAX_ORDER_LIMIT,
  );
  const rows = await ctx.db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      createdAt: orders.createdAt,
      status: orders.status,
      paymentMethod: orders.paymentMethod,
      totalGross: orders.totalGross,
      currency: orders.currency,
    })
    .from(orders)
    .where(eq(orders.customerId, customerId))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(limit);
  if (rows.length === 0) return [];

  const perEvent = await ctx.db
    .select({
      orderId: orderItems.orderId,
      eventId: events.id,
      title: events.title,
      subtitle: events.subtitle,
      translations: events.translations,
      startsAt: events.startsAt,
      timeZone: events.timeZone,
      items: sql<number>`count(*)::int`,
    })
    .from(orderItems)
    .innerJoin(events, eq(events.id, orderItems.eventId))
    .where(
      inArray(
        orderItems.orderId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(orderItems.orderId, events.id)
    .orderBy(asc(events.startsAt), asc(events.title));

  const defaultLocale = normalizeLocale((await getSetting(ctx, 'general')).defaultLocale);
  const byOrder = new Map<string, { events: CustomerOrderEvent[]; ticketCount: number }>();
  for (const row of perEvent) {
    const entry = byOrder.get(row.orderId) ?? { events: [], ticketCount: 0 };
    entry.events.push({
      eventId: row.eventId,
      title: localized(row, 'title', options.locale, defaultLocale),
      subtitle:
        row.subtitle === null ? null : localized(row, 'subtitle', options.locale, defaultLocale),
      startsAt: row.startsAt,
      timeZone: row.timeZone,
    });
    entry.ticketCount += row.items;
    byOrder.set(row.orderId, entry);
  }
  return rows.map((order) => ({
    ...order,
    events: byOrder.get(order.id)?.events ?? [],
    ticketCount: byOrder.get(order.id)?.ticketCount ?? 0,
  }));
}
