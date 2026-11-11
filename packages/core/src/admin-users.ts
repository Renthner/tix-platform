import { isIP } from 'node:net';
import {
  adminRecoveryCodes,
  adminSessions,
  adminTokens,
  adminUsers,
  auditLogs,
  customerSessions,
  PG_ERROR,
  findPgError,
  withTransaction,
  type AdminTokenPurpose,
  type Executor,
} from '@tix/db';
import {
  ADMIN_ROLES,
  SUPPORTED_LOCALES,
  type AdminRole,
  type AppLocale,
  type EmailTemplateKey,
} from '@tix/shared';
import {
  generateHumanCode,
  generateToken,
  hashPassword,
  hashToken,
  needsRehash,
  totpUri,
  generateTotpSecret,
  verifyPassword,
  verifyTotp,
} from '@tix/shared/server';
import { rateLimit } from '@tix/redis';
import { and, asc, count, eq, gt, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import qrcode from 'qrcode-generator';
import { z } from 'zod';
import { DomainError, requireCapability, type CoreContext } from './context';
import { createEmailMessage, dispatchEmailMessage } from './email/request';
import { formatDateTime } from './format';
import { getSetting } from './settings';

/**
 * Admin Portal users: invitations, password reset, optional TOTP two-factor authentication,
 * recovery codes, lockout and the user-management operations of SUPER_ADMINs.
 *
 * Security properties:
 * - Invitation / reset links are random 256-bit values; only the SHA-256 is stored, they are
 *   single-use (atomic conditional UPDATE) and expire. Only the newest link of a purpose works.
 * - Password reset requests never reveal whether an address belongs to an admin.
 * - TOTP secrets are encrypted (secret box, bound to the user id); a time step is accepted once
 *   (conditional UPDATE on `totp_last_step`). Recovery codes are single-use (conditional UPDATE).
 * - Wrong passwords and wrong second-factor codes share one atomic failure counter → lockout.
 * - The last active SUPER_ADMIN with a password can never be demoted, deactivated or deleted
 *   (rows are locked FOR UPDATE, so concurrent attempts serialise).
 */

const MAX_PASSWORD_LENGTH = 1_024;
const TOKEN_BYTES = 32;
export const RECOVERY_CODE_COUNT = 10;
const TOTP_SECRET_CONTEXT = (userId: string) => `admin-totp:${userId}`;

export interface AdminActor {
  /** Acting admin (null for system / unauthenticated flows that act on a user themselves). */
  userId: string | null;
  ipAddress?: string | null;
}

// ─── Input schemas ────────────────────────────────────────────────────────────────────

export const adminEmailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const adminDisplayNameSchema = z.string().trim().min(1).max(120);
export const adminRolesSchema = z
  .array(z.enum(ADMIN_ROLES))
  .min(1)
  .transform((roles) => [...new Set(roles)]);
const localeSchema = z.enum(SUPPORTED_LOCALES);

export const inviteAdminSchema = z.object({
  email: adminEmailSchema,
  displayName: adminDisplayNameSchema,
  roles: adminRolesSchema,
  locale: localeSchema,
});
export type InviteAdminInput = z.input<typeof inviteAdminSchema>;

// ─── Errors ───────────────────────────────────────────────────────────────────────────

const notFound = () => new DomainError('ADMIN_USER_NOT_FOUND', 'Admin user not found', 404);
const tokenInvalid = () =>
  new DomainError('TOKEN_INVALID', 'This link is invalid or has expired', 400);
const wrongPassword = () => new DomainError('WRONG_PASSWORD', 'The password is not correct', 403);
const invalidCode = () => new DomainError('INVALID_CODE', 'The code is not correct', 403);

// ─── Helpers ──────────────────────────────────────────────────────────────────────────

const validIp = (ip: string | null | undefined) =>
  ip && isIP(ip) !== 0 && ip !== '0.0.0.0' ? ip : null;

export async function writeAdminAudit(
  db: Executor,
  actor: AdminActor,
  action: string,
  entityId: string | null,
  changes?: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLogs).values({
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    action,
    entityType: 'admin_user',
    entityId,
    changes: changes ?? null,
    ipAddress: validIp(actor.ipAddress),
  });
}

/** Password policy of the security settings. */
export async function assertAdminPasswordPolicy(
  ctx: Pick<CoreContext, 'db'>,
  password: string,
): Promise<void> {
  const { minPasswordLength } = await getSetting(ctx, 'security');
  if ([...password].length < minPasswordLength) {
    throw new DomainError(
      'WEAK_PASSWORD',
      `The password must have at least ${minPasswordLength} characters`,
      422,
      { min: minPasswordLength },
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new DomainError('PASSWORD_TOO_LONG', 'The password is too long', 422, {
      max: MAX_PASSWORD_LENGTH,
    });
  }
}

const isPlausibleToken = (token: unknown): token is string =>
  typeof token === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(token);

export async function revokeAdminSessions(
  db: Executor,
  userId: string,
  exceptTokenHash?: string | null,
): Promise<void> {
  await db
    .delete(adminSessions)
    .where(
      and(
        eq(adminSessions.userId, userId),
        exceptTokenHash ? ne(adminSessions.tokenHash, exceptTokenHash) : undefined,
      ),
    );
  // Without a kept session this is a full revocation: customer sessions that were created by
  // linking this admin (see customers/admin-link.ts) end with it; the person's own survive.
  if (!exceptTokenHash) {
    await db.delete(customerSessions).where(eq(customerSessions.linkedAdminUserId, userId));
  }
}

const hasSuperAdminRole = sql`'SUPER_ADMIN' = ANY(${adminUsers.roles})`;

/**
 * Locks the active super admins that can sign in (always in id order, before any other row of
 * the transaction, so concurrent demotions serialise instead of deadlocking).
 */
async function lockSuperAdmins(tx: Executor): Promise<string[]> {
  const rows = await tx
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(
      and(eq(adminUsers.isActive, true), isNotNull(adminUsers.passwordHash), hasSuperAdminRole),
    )
    .orderBy(asc(adminUsers.id))
    .for('update');
  return rows.map((r) => r.id);
}

/** Throws LAST_SUPER_ADMIN unless another locked super admin remains. */
function assertOtherSuperAdmin(locked: string[], userId: string): void {
  if (!locked.some((id) => id !== userId)) {
    throw new DomainError(
      'LAST_SUPER_ADMIN',
      'The last active super admin cannot be changed this way',
      409,
    );
  }
}

async function loadUser(tx: Executor, userId: string, lock = false) {
  const query = tx.select().from(adminUsers).where(eq(adminUsers.id, userId));
  const [user] = await (lock ? query.for('update') : query);
  if (!user) throw notFound();
  return user;
}

function appLink(
  ctx: CoreContext,
  locale: AppLocale,
  page: 'accept-invite' | 'reset-password' | 'verify-email',
  token: string,
): string {
  return `${requireCapability(ctx, 'appUrl')}/${locale}/admin/${page}?token=${encodeURIComponent(token)}`;
}

async function issueAdminToken(
  db: Executor,
  userId: string,
  purpose: AdminTokenPurpose,
  ttlMs: number,
): Promise<string> {
  // Only the newest link of a purpose stays valid; expired tokens are purged on the way.
  await db
    .delete(adminTokens)
    .where(
      and(
        eq(adminTokens.userId, userId),
        sql`(${adminTokens.expiresAt} <= now() OR (${adminTokens.purpose} = ${purpose} AND ${adminTokens.consumedAt} IS NULL))`,
      ),
    );
  const token = generateToken(TOKEN_BYTES);
  await db.insert(adminTokens).values({
    userId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return token;
}

async function consumeAdminToken(
  db: Executor,
  token: unknown,
  purpose: AdminTokenPurpose,
): Promise<string | null> {
  if (!isPlausibleToken(token)) return null;
  const [row] = await db
    .update(adminTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(adminTokens.tokenHash, hashToken(token)),
        eq(adminTokens.purpose, purpose),
        isNull(adminTokens.consumedAt),
        gt(adminTokens.expiresAt, sql`now()`),
      ),
    )
    .returning({ userId: adminTokens.userId });
  return row?.userId ?? null;
}

/** True when the link is still usable (renders the set-password page vs. an error). */
export async function isAdminTokenValid(
  ctx: Pick<CoreContext, 'db'>,
  token: unknown,
  purpose: AdminTokenPurpose,
): Promise<boolean> {
  if (!isPlausibleToken(token)) return false;
  const [row] = await ctx.db
    .select({ id: adminTokens.id })
    .from(adminTokens)
    .innerJoin(adminUsers, eq(adminUsers.id, adminTokens.userId))
    .where(
      and(
        eq(adminTokens.tokenHash, hashToken(token)),
        eq(adminTokens.purpose, purpose),
        isNull(adminTokens.consumedAt),
        gt(adminTokens.expiresAt, sql`now()`),
        eq(adminUsers.isActive, true),
      ),
    );
  return Boolean(row);
}

async function tokenMail(
  ctx: CoreContext,
  tx: Executor,
  params: {
    key: Extract<
      EmailTemplateKey,
      'ADMIN_INVITE' | 'ADMIN_PASSWORD_RESET' | 'CUSTOMER_EMAIL_VERIFICATION'
    >;
    user: { email: string; displayName: string };
    locale: AppLocale;
    variable: 'inviteUrl' | 'resetUrl' | 'verificationUrl';
    url: string;
    expires: Date;
  },
): Promise<string> {
  const general = await getSetting(ctx, 'general');
  return createEmailMessage(ctx, tx, {
    key: params.key,
    to: params.user.email,
    locale: params.locale,
    variables: {
      firstName: params.user.displayName,
      [params.variable]: params.url,
      expiresAt: formatDateTime(params.expires, params.locale, general.defaultTimeZone, 'long'),
    },
  });
}

// ─── Listing ──────────────────────────────────────────────────────────────────────────

export interface AdminUserSummary {
  id: string;
  email: string;
  displayName: string;
  roles: AdminRole[];
  isActive: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: Date | null;
  invitePending: boolean;
  lockedUntil: Date | null;
  createdAt: Date;
}

const summaryColumns = {
  id: adminUsers.id,
  email: adminUsers.email,
  displayName: adminUsers.displayName,
  roles: adminUsers.roles,
  isActive: adminUsers.isActive,
  totp: adminUsers.totpSecretEncrypted,
  passwordHash: adminUsers.passwordHash,
  lastLoginAt: adminUsers.lastLoginAt,
  lockedUntil: adminUsers.lockedUntil,
  createdAt: adminUsers.createdAt,
};

function toSummary(row: {
  id: string;
  email: string;
  displayName: string;
  roles: AdminRole[];
  isActive: boolean;
  totp: string | null;
  passwordHash: string | null;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  createdAt: Date;
}): AdminUserSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    roles: row.roles,
    isActive: row.isActive,
    twoFactorEnabled: row.totp !== null,
    lastLoginAt: row.lastLoginAt,
    invitePending: row.passwordHash === null,
    lockedUntil: row.lockedUntil,
    createdAt: row.createdAt,
  };
}

export async function listAdminUsers(ctx: Pick<CoreContext, 'db'>): Promise<AdminUserSummary[]> {
  const rows = await ctx.db
    .select(summaryColumns)
    .from(adminUsers)
    .orderBy(asc(sql`lower(${adminUsers.displayName})`), asc(adminUsers.email));
  return rows.map(toSummary);
}

export async function getAdminUserSummary(
  ctx: Pick<CoreContext, 'db'>,
  userId: string,
): Promise<AdminUserSummary | null> {
  const [row] = await ctx.db
    .select(summaryColumns)
    .from(adminUsers)
    .where(eq(adminUsers.id, userId));
  return row ? toSummary(row) : null;
}

// ─── Invitations ──────────────────────────────────────────────────────────────────────

/** Creates the user without a password and e-mails the one-time set-password link. */
export async function inviteAdminUser(
  ctx: CoreContext,
  actor: AdminActor,
  input: InviteAdminInput,
): Promise<{ userId: string }> {
  const data = inviteAdminSchema.parse(input);
  const security = await getSetting(ctx, 'security');
  const { userId, messageId } = await withTransaction(ctx.db, async (tx) => {
    const [existing] = await tx
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(sql`lower(${adminUsers.email}) = ${data.email}`);
    if (existing) throw new DomainError('EMAIL_TAKEN', 'This e-mail address is already used', 409);
    const [user] = await tx
      .insert(adminUsers)
      .values({ email: data.email, displayName: data.displayName, roles: data.roles })
      .returning({ id: adminUsers.id })
      .catch((err: unknown) => {
        // Two concurrent invitations of the same address: the loser gets the same answer.
        if (findPgError(err)?.code === PG_ERROR.UNIQUE_VIOLATION) {
          throw new DomainError('EMAIL_TAKEN', 'This e-mail address is already used', 409);
        }
        throw err;
      });
    const ttlMs = security.inviteTtlHours * 3_600_000;
    const token = await issueAdminToken(tx, user!.id, 'INVITE', ttlMs);
    const messageId = await tokenMail(ctx, tx, {
      key: 'ADMIN_INVITE',
      user: data,
      locale: data.locale,
      variable: 'inviteUrl',
      url: appLink(ctx, data.locale, 'accept-invite', token),
      expires: new Date(Date.now() + ttlMs),
    });
    await writeAdminAudit(tx, actor, 'admin_user.invite', user!.id, {
      email: data.email,
      roles: data.roles,
    });
    return { userId: user!.id, messageId };
  });
  await dispatchEmailMessage(ctx, messageId);
  return { userId };
}

/** New link for a user who has not accepted yet (the earlier link stops working). */
export async function resendAdminInvite(
  ctx: CoreContext,
  actor: AdminActor,
  userId: string,
  locale: AppLocale,
): Promise<void> {
  const security = await getSetting(ctx, 'security');
  const messageId = await withTransaction(ctx.db, async (tx) => {
    const user = await loadUser(tx, userId, true);
    if (user.passwordHash !== null || !user.isActive) {
      throw new DomainError('INVITE_NOT_PENDING', 'This user has already accepted', 409);
    }
    const ttlMs = security.inviteTtlHours * 3_600_000;
    const token = await issueAdminToken(tx, user.id, 'INVITE', ttlMs);
    const id = await tokenMail(ctx, tx, {
      key: 'ADMIN_INVITE',
      user,
      locale,
      variable: 'inviteUrl',
      url: appLink(ctx, locale, 'accept-invite', token),
      expires: new Date(Date.now() + ttlMs),
    });
    await writeAdminAudit(tx, actor, 'admin_user.invite_resend', user.id);
    return id;
  });
  await dispatchEmailMessage(ctx, messageId);
}

/** Sets the first password with the invitation link. Returns the user id. */
export async function acceptAdminInvite(
  ctx: CoreContext,
  token: unknown,
  password: string,
  ipAddress?: string | null,
): Promise<{ userId: string }> {
  // Cheap token check first: no Argon2 work for garbage links.
  if (!(await isAdminTokenValid(ctx, token, 'INVITE'))) throw tokenInvalid();
  await assertAdminPasswordPolicy(ctx, password);
  const passwordHash = await hashPassword(password);
  return withTransaction(ctx.db, async (tx) => {
    const userId = await consumeAdminToken(tx, token, 'INVITE');
    if (!userId) throw tokenInvalid();
    const [updated] = await tx
      .update(adminUsers)
      .set({
        passwordHash,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        // The link only reached the owner of the mailbox.
        emailVerifiedAt: sql`coalesce(${adminUsers.emailVerifiedAt}, now())`,
      })
      .where(
        and(
          eq(adminUsers.id, userId),
          eq(adminUsers.isActive, true),
          isNull(adminUsers.passwordHash),
        ),
      )
      .returning({ id: adminUsers.id });
    if (!updated) throw tokenInvalid();
    await writeAdminAudit(tx, { userId, ipAddress }, 'admin_user.invite_accept', userId);
    return { userId };
  });
}

// ─── Password reset (forgot password) ─────────────────────────────────────────────────

/**
 * Sends a reset link when `email` belongs to an active admin with a password. Always returns
 * normally: the caller shows the same neutral message either way.
 */
export async function requestAdminPasswordReset(
  ctx: CoreContext,
  email: string,
  locale: AppLocale,
  ipAddress?: string | null,
): Promise<void> {
  const normalized = adminEmailSchema.safeParse(email);
  if (!normalized.success) return;
  const security = await getSetting(ctx, 'security');
  const messageId = await withTransaction(ctx.db, async (tx) => {
    const [user] = await tx
      .select()
      .from(adminUsers)
      .where(sql`lower(${adminUsers.email}) = ${normalized.data}`);
    if (!user || !user.isActive || !user.passwordHash) return null;
    const ttlMs = security.passwordResetTtlMinutes * 60_000;
    const token = await issueAdminToken(tx, user.id, 'PASSWORD_RESET', ttlMs);
    const id = await tokenMail(ctx, tx, {
      key: 'ADMIN_PASSWORD_RESET',
      user,
      locale,
      variable: 'resetUrl',
      url: appLink(ctx, locale, 'reset-password', token),
      expires: new Date(Date.now() + ttlMs),
    });
    await writeAdminAudit(
      tx,
      { userId: user.id, ipAddress },
      'admin_user.password_reset_request',
      user.id,
    );
    return id;
  });
  if (messageId) await dispatchEmailMessage(ctx, messageId);
}

/** Sets a new password with the reset link; ends all sessions and clears a lockout. 2FA stays on. */
export async function resetAdminPassword(
  ctx: CoreContext,
  token: unknown,
  password: string,
  ipAddress?: string | null,
): Promise<{ userId: string }> {
  if (!(await isAdminTokenValid(ctx, token, 'PASSWORD_RESET'))) throw tokenInvalid();
  await assertAdminPasswordPolicy(ctx, password);
  const passwordHash = await hashPassword(password);
  return withTransaction(ctx.db, async (tx) => {
    const userId = await consumeAdminToken(tx, token, 'PASSWORD_RESET');
    if (!userId) throw tokenInvalid();
    const [updated] = await tx
      .update(adminUsers)
      .set({
        passwordHash,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        // The reset link only reached the owner of the mailbox.
        emailVerifiedAt: sql`coalesce(${adminUsers.emailVerifiedAt}, now())`,
      })
      .where(and(eq(adminUsers.id, userId), eq(adminUsers.isActive, true)))
      .returning({ id: adminUsers.id });
    if (!updated) throw tokenInvalid();
    await revokeAdminSessions(tx, userId);
    await tx
      .delete(adminTokens)
      .where(and(eq(adminTokens.userId, userId), eq(adminTokens.purpose, 'PASSWORD_RESET')));
    await writeAdminAudit(tx, { userId, ipAddress }, 'admin_user.password_reset', userId);
    return { userId };
  });
}

// ─── Sign-in ──────────────────────────────────────────────────────────────────────────

export type AdminPasswordCheck =
  /**
   * `failedUserId`: wrong password of a usable account whose failure was deferred (`deferFailure`).
   * `passwordMatched`: the password is right but the account is locked (never charged as a failure).
   */
  | { status: 'invalid'; failedUserId?: string; passwordMatched?: boolean }
  | { status: 'ok'; userId: string; twoFactor: boolean; passwordChangedAt: Date | null };

// Constant-time-ish behaviour for unknown e-mails: verify against a fixed dummy hash.
let dummyHash: Promise<string> | null = null;

/**
 * Registers a failed attempt atomically; when the limit is reached the account is locked for
 * `lockoutMinutes` and the counter restarts. While a lock is active nothing changes (parallel
 * wrong guesses neither extend nor clear it). Returns true when the account is now locked.
 * Failures and lock-outs are audited (with the IP) for known accounts.
 */
async function registerFailedAttempt(
  ctx: Pick<CoreContext, 'db'>,
  userId: string,
  ipAddress: string | null | undefined,
  method: 'password' | 'second_factor',
): Promise<boolean> {
  const { maxFailedLogins, lockoutMinutes } = await getSetting(ctx, 'security');
  const [row] = await ctx.db
    .update(adminUsers)
    .set({
      failedLoginCount: sql`CASE WHEN ${adminUsers.failedLoginCount} + 1 >= ${maxFailedLogins} THEN 0 ELSE ${adminUsers.failedLoginCount} + 1 END`,
      lockedUntil: sql`CASE WHEN ${adminUsers.failedLoginCount} + 1 >= ${maxFailedLogins} THEN now() + make_interval(mins => ${lockoutMinutes}) ELSE NULL END`,
    })
    .where(
      and(
        eq(adminUsers.id, userId),
        sql`(${adminUsers.lockedUntil} IS NULL OR ${adminUsers.lockedUntil} <= now())`,
      ),
    )
    .returning({ lockedUntil: adminUsers.lockedUntil });
  // No row: the account is already locked.
  if (!row) return true;
  const locked = row.lockedUntil != null;
  const actor = { userId, ipAddress };
  await writeAdminAudit(
    ctx.db,
    actor,
    locked ? 'admin_user.locked' : 'admin_user.login_failed',
    userId,
    { method },
  );
  return locked;
}

/**
 * First sign-in step: e-mail + password (lockout aware). Does NOT open a session.
 * With `deferFailure` a wrong password is not counted towards the lockout; the caller counts it
 * via `registerAdminPasswordFailure` (shop sign-in: only when no other account matched either).
 */
export async function checkAdminPassword(
  ctx: Pick<CoreContext, 'db'>,
  email: string,
  password: string,
  ipAddress?: string | null,
  options: { deferFailure?: boolean } = {},
): Promise<AdminPasswordCheck> {
  const [user] = await ctx.db
    .select()
    .from(adminUsers)
    .where(sql`lower(${adminUsers.email}) = ${email.trim().toLowerCase()}`);
  // Unknown, pending, inactive and locked accounts all look like a wrong password (same work,
  // same answer); a locked account stays locked, a correct password does not help.
  const locked = Boolean(user?.lockedUntil && user.lockedUntil > new Date());
  if (!user || !user.passwordHash || !user.isActive) {
    dummyHash ??= hashPassword('dummy-password-for-timing');
    await verifyPassword(await dummyHash, password);
    return { status: 'invalid' };
  }
  if (locked) {
    // Same Argon2 work against the real hash; a right password is reported (not as a failure)
    // so the shop form does not charge it to the customer account.
    const matched = await verifyPassword(user.passwordHash, password);
    return matched ? { status: 'invalid', passwordMatched: true } : { status: 'invalid' };
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    if (options.deferFailure) return { status: 'invalid', failedUserId: user.id };
    await registerFailedAttempt(ctx, user.id, ipAddress, 'password');
    return { status: 'invalid' };
  }
  if (needsRehash(user.passwordHash)) {
    await ctx.db
      .update(adminUsers)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(adminUsers.id, user.id));
  }
  return {
    status: 'ok',
    userId: user.id,
    twoFactor: user.totpSecretEncrypted !== null,
    passwordChangedAt: user.passwordChangedAt,
  };
}

/** Counts a deferred wrong-password attempt (see `checkAdminPassword`); true when now locked. */
export function registerAdminPasswordFailure(
  ctx: Pick<CoreContext, 'db'>,
  userId: string,
  ipAddress?: string | null,
): Promise<boolean> {
  return registerFailedAttempt(ctx, userId, ipAddress, 'password');
}

/** Final sign-in step: resets the failure counter and stamps the login (call after 2FA). */
export async function completeAdminLogin(
  ctx: Pick<CoreContext, 'db'>,
  userId: string,
  ipAddress?: string | null,
  method: 'password' | 'totp' | 'recovery_code' = 'password',
  via: 'admin_portal' | 'shop' = 'admin_portal',
): Promise<void> {
  await ctx.db
    .update(adminUsers)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(adminUsers.id, userId));
  await writeAdminAudit(ctx.db, { userId, ipAddress }, 'admin_user.login', userId, {
    method,
    via,
  });
}

/** Details the pending-login cookie is bound to (so a password change invalidates it). */
export async function getAdminLoginBinding(
  ctx: Pick<CoreContext, 'db'>,
  userId: string,
): Promise<{ active: boolean; passwordChangedAt: Date | null; locked: boolean } | null> {
  const [user] = await ctx.db
    .select({
      isActive: adminUsers.isActive,
      passwordChangedAt: adminUsers.passwordChangedAt,
      lockedUntil: adminUsers.lockedUntil,
      passwordHash: adminUsers.passwordHash,
    })
    .from(adminUsers)
    .where(eq(adminUsers.id, userId));
  if (!user || !user.passwordHash) return null;
  return {
    active: user.isActive,
    passwordChangedAt: user.passwordChangedAt,
    locked: Boolean(user.lockedUntil && user.lockedUntil > new Date()),
  };
}

// ─── Recovery codes & second factor ───────────────────────────────────────────────────

/** Crockford normalisation: case, separators and look-alikes (I/L → 1, O → 0) are forgiven. */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

export const formatRecoveryCode = (raw: string): string => raw.match(/.{1,4}/g)!.join('-');

async function replaceRecoveryCodes(tx: Executor, userId: string): Promise<string[]> {
  await tx.delete(adminRecoveryCodes).where(eq(adminRecoveryCodes.userId, userId));
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateHumanCode(16));
  await tx
    .insert(adminRecoveryCodes)
    .values(codes.map((code) => ({ userId, codeHash: hashToken(code) })));
  return codes.map(formatRecoveryCode);
}

const looksLikeTotp = (code: string) => /^\d{6}$/.test(code.replace(/\s/g, ''));

/**
 * Checks a TOTP code (replay protected) or a recovery code (single use) for a user with 2FA
 * enabled. Failures count towards the account lockout. Returns the method used.
 */
export async function verifyAdminSecondFactor(
  ctx: CoreContext,
  userId: string,
  code: string,
  nowMs = Date.now(),
  ipAddress?: string | null,
): Promise<'totp' | 'recovery_code'> {
  const [user] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.id, userId));
  if (!user || !user.isActive || !user.totpSecretEncrypted) throw invalidCode();
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new DomainError('ACCOUNT_LOCKED', 'The account is temporarily locked', 423);
  }
  const input = code.slice(0, 64);
  if (looksLikeTotp(input)) {
    const secret = requireCapability(ctx, 'secrets').decrypt(
      user.totpSecretEncrypted,
      TOTP_SECRET_CONTEXT(userId),
    );
    const step = verifyTotp(secret, input, { nowMs, lastStep: user.totpLastStep });
    if (step !== null) {
      // Atomic: a concurrent use of the same step loses the race.
      const [accepted] = await ctx.db
        .update(adminUsers)
        .set({ totpLastStep: step })
        .where(
          and(
            eq(adminUsers.id, userId),
            sql`(${adminUsers.totpLastStep} IS NULL OR ${adminUsers.totpLastStep} < ${step})`,
          ),
        )
        .returning({ id: adminUsers.id });
      if (accepted) return 'totp';
    }
  } else {
    const normalized = normalizeRecoveryCode(input);
    if (normalized.length === 16) {
      const [used] = await ctx.db
        .update(adminRecoveryCodes)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(adminRecoveryCodes.userId, userId),
            eq(adminRecoveryCodes.codeHash, hashToken(normalized)),
            isNull(adminRecoveryCodes.usedAt),
          ),
        )
        .returning({ id: adminRecoveryCodes.id });
      if (used) return 'recovery_code';
    }
  }
  const locked = await registerFailedAttempt(ctx, userId, ipAddress, 'second_factor');
  if (locked) throw new DomainError('ACCOUNT_LOCKED', 'The account is temporarily locked', 423);
  throw invalidCode();
}

// ─── E-mail address verification (own account) ───────────────────────────────────────

const EMAIL_VERIFY_TTL_MS = 24 * 3_600_000;

/**
 * Sends the one-time link that proves the admin controls the mailbox (needed to link the
 * admin to a customer account in the shop). Reuses the customer verification template.
 */
export async function requestAdminEmailVerification(
  ctx: CoreContext,
  actor: AdminActor & { userId: string },
  locale: AppLocale,
): Promise<{ alreadyVerified: boolean }> {
  const messageId = await withTransaction(ctx.db, async (tx) => {
    const user = await loadUser(tx, actor.userId, true);
    if (user.emailVerifiedAt || !user.isActive) return null;
    const token = await issueAdminToken(tx, user.id, 'EMAIL_VERIFY', EMAIL_VERIFY_TTL_MS);
    const id = await tokenMail(ctx, tx, {
      key: 'CUSTOMER_EMAIL_VERIFICATION',
      user,
      locale,
      variable: 'verificationUrl',
      url: appLink(ctx, locale, 'verify-email', token),
      expires: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
    });
    await writeAdminAudit(tx, actor, 'admin_user.email_verification_request', user.id);
    return id;
  });
  if (!messageId) return { alreadyVerified: true };
  await dispatchEmailMessage(ctx, messageId);
  return { alreadyVerified: false };
}

/** True when the verification link is still usable (renders the confirm button vs. an error). */
export function isAdminEmailVerificationValid(
  ctx: Pick<CoreContext, 'db'>,
  token: unknown,
): Promise<boolean> {
  return isAdminTokenValid(ctx, token, 'EMAIL_VERIFY');
}

/** Consumes the verification link and marks the address as verified. Returns the user id. */
export async function verifyAdminEmail(
  ctx: CoreContext,
  token: unknown,
  ipAddress?: string | null,
): Promise<{ userId: string }> {
  if (!(await isAdminTokenValid(ctx, token, 'EMAIL_VERIFY'))) throw tokenInvalid();
  return withTransaction(ctx.db, async (tx) => {
    const userId = await consumeAdminToken(tx, token, 'EMAIL_VERIFY');
    if (!userId) throw tokenInvalid();
    const [updated] = await tx
      .update(adminUsers)
      .set({ emailVerifiedAt: sql`coalesce(${adminUsers.emailVerifiedAt}, now())` })
      .where(and(eq(adminUsers.id, userId), eq(adminUsers.isActive, true)))
      .returning({ id: adminUsers.id });
    if (!updated) throw tokenInvalid();
    await writeAdminAudit(tx, { userId, ipAddress }, 'admin_user.email_verified', userId);
    return { userId };
  });
}

// ─── Own account ──────────────────────────────────────────────────────────────────────

export interface OwnAccount {
  id: string;
  email: string;
  displayName: string;
  roles: AdminRole[];
  twoFactorEnabled: boolean;
  /** The e-mail address was proven (invitation / reset / verification link). */
  emailVerified: boolean;
  recoveryCodesLeft: number;
  /** All admins must use 2FA (security settings). */
  twoFactorRequired: boolean;
}

export async function getOwnAccount(ctx: CoreContext, userId: string): Promise<OwnAccount> {
  const user = await loadUser(ctx.db, userId);
  const [left] = await ctx.db
    .select({ n: count() })
    .from(adminRecoveryCodes)
    .where(and(eq(adminRecoveryCodes.userId, userId), isNull(adminRecoveryCodes.usedAt)));
  const security = await getSetting(ctx, 'security');
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    roles: user.roles,
    twoFactorEnabled: user.totpSecretEncrypted !== null,
    emailVerified: user.emailVerifiedAt !== null,
    recoveryCodesLeft: left?.n ?? 0,
    twoFactorRequired: security.requireTwoFactor,
  };
}

export async function updateOwnProfile(
  ctx: CoreContext,
  actor: AdminActor & { userId: string },
  displayName: string,
): Promise<void> {
  const name = adminDisplayNameSchema.parse(displayName);
  await withTransaction(ctx.db, async (tx) => {
    await tx.update(adminUsers).set({ displayName: name }).where(eq(adminUsers.id, actor.userId));
    await writeAdminAudit(tx, actor, 'admin_user.profile_update', actor.userId, {
      displayName: name,
    });
  });
}

async function requirePassword(ctx: CoreContext, userId: string, password: string) {
  const user = await loadUser(ctx.db, userId);
  if (!user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
    throw wrongPassword();
  }
  return user;
}

/**
 * Re-confirmation of the signed-in admin's password before a destructive action
 * (WRONG_PASSWORD otherwise). Failures are rate limited per admin.
 */
export async function verifyAdminPassword(
  ctx: CoreContext,
  userId: string,
  password: string,
): Promise<void> {
  const attempt = await rateLimit(ctx.redis, ctx.keys, 'admin-reconfirm', userId, 10, 15 * 60_000);
  if (!attempt.allowed) {
    throw new DomainError('RATE_LIMITED', 'Too many attempts. Please try again later.', 429);
  }
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) throw wrongPassword();
  await requirePassword(ctx, userId, password);
}

/** Changes the own password; all other sessions end (the current one stays). */
export async function changeOwnPassword(
  ctx: CoreContext,
  actor: AdminActor & { userId: string },
  currentPassword: string,
  newPassword: string,
  keepSessionTokenHash: string | null,
): Promise<void> {
  await requirePassword(ctx, actor.userId, currentPassword);
  await assertAdminPasswordPolicy(ctx, newPassword);
  const passwordHash = await hashPassword(newPassword);
  await withTransaction(ctx.db, async (tx) => {
    await tx
      .update(adminUsers)
      .set({ passwordHash, passwordChangedAt: new Date() })
      .where(eq(adminUsers.id, actor.userId));
    await revokeAdminSessions(tx, actor.userId, keepSessionTokenHash);
    await writeAdminAudit(tx, actor, 'admin_user.password_change', actor.userId);
  });
}

export function qrDataUrl(payload: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(payload, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const margin = 4;
  let path = '';
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1)
      if (qr.isDark(r, c)) path += `M${c + margin},${r + margin}h1v1h-1z`;
  }
  const size = n + margin * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export interface TotpSetup {
  /** Base32 secret for manual entry. */
  secret: string;
  uri: string;
  qrDataUrl: string;
}

/** Starts (or restarts) enrolment: stores a pending secret that is not active until confirmed. */
export async function beginTotpSetup(
  ctx: CoreContext,
  actor: AdminActor & { userId: string },
): Promise<TotpSetup> {
  const user = await loadUser(ctx.db, actor.userId);
  if (user.totpSecretEncrypted) {
    throw new DomainError('TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is on', 409);
  }
  const general = await getSetting(ctx, 'general');
  const secret = generateTotpSecret();
  await ctx.db
    .update(adminUsers)
    .set({
      totpPendingSecretEncrypted: requireCapability(ctx, 'secrets').encrypt(
        secret,
        TOTP_SECRET_CONTEXT(actor.userId),
      ),
    })
    .where(eq(adminUsers.id, actor.userId));
  const uri = totpUri({ secret, account: user.email, issuer: general.shopName });
  return { secret, uri, qrDataUrl: qrDataUrl(uri) };
}

/**
 * Confirms the pending secret with the current password and a code, turns 2FA on and returns
 * the recovery codes once. All other sessions of the user end; the current one
 * (`keepSessionTokenHash`) counts as second-factor verified (`mfa_verified_at`, informational:
 * sessions can only be opened after the second step, so the column is not used for access checks).
 */
export async function confirmTotpSetup(
  ctx: CoreContext,
  actor: AdminActor & { userId: string },
  password: string,
  code: string,
  keepSessionTokenHash: string | null = null,
  nowMs = Date.now(),
): Promise<{ recoveryCodes: string[] }> {
  const user = await requirePassword(ctx, actor.userId, password);
  if (user.totpSecretEncrypted || !user.totpPendingSecretEncrypted) {
    throw new DomainError('TWO_FACTOR_NO_SETUP', 'There is no pending two-factor setup', 409);
  }
  const secrets = requireCapability(ctx, 'secrets');
  const secret = secrets.decrypt(user.totpPendingSecretEncrypted, TOTP_SECRET_CONTEXT(user.id));
  const step = verifyTotp(secret, code, { nowMs });
  if (step === null) throw invalidCode();
  return withTransaction(ctx.db, async (tx) => {
    const [enabled] = await tx
      .update(adminUsers)
      .set({
        totpSecretEncrypted: user.totpPendingSecretEncrypted,
        totpPendingSecretEncrypted: null,
        totpLastStep: step,
      })
      .where(
        and(
          eq(adminUsers.id, user.id),
          isNull(adminUsers.totpSecretEncrypted),
          eq(adminUsers.totpPendingSecretEncrypted, user.totpPendingSecretEncrypted!),
        ),
      )
      .returning({ id: adminUsers.id });
    if (!enabled) {
      throw new DomainError('TWO_FACTOR_NO_SETUP', 'There is no pending two-factor setup', 409);
    }
    const recoveryCodes = await replaceRecoveryCodes(tx, user.id);
    await revokeAdminSessions(tx, user.id, keepSessionTokenHash);
    if (keepSessionTokenHash) {
      await tx
        .update(adminSessions)
        .set({ mfaVerifiedAt: new Date() })
        .where(eq(adminSessions.tokenHash, keepSessionTokenHash));
    }
    await writeAdminAudit(tx, actor, 'admin_user.two_factor_enable', user.id);
    return { recoveryCodes };
  });
}

/** Turns 2FA off (own account): needs the password and a current code. */
export async function disableTotp(
  ctx: CoreContext,
  actor: AdminActor & { userId: string },
  password: string,
  code: string,
): Promise<void> {
  const security = await getSetting(ctx, 'security');
  if (security.requireTwoFactor) {
    throw new DomainError(
      'TWO_FACTOR_REQUIRED',
      'Two-factor authentication is mandatory for all admins',
      409,
    );
  }
  await requirePassword(ctx, actor.userId, password);
  await verifyAdminSecondFactor(ctx, actor.userId, code, undefined, actor.ipAddress);
  await withTransaction(ctx.db, async (tx) => {
    await clearTotp(tx, actor.userId);
    await writeAdminAudit(tx, actor, 'admin_user.two_factor_disable', actor.userId);
  });
}

export async function regenerateRecoveryCodes(
  ctx: CoreContext,
  actor: AdminActor & { userId: string },
  password: string,
  code: string,
): Promise<{ recoveryCodes: string[] }> {
  await requirePassword(ctx, actor.userId, password);
  await verifyAdminSecondFactor(ctx, actor.userId, code, undefined, actor.ipAddress);
  return withTransaction(ctx.db, async (tx) => {
    const recoveryCodes = await replaceRecoveryCodes(tx, actor.userId);
    await writeAdminAudit(tx, actor, 'admin_user.recovery_codes_regenerate', actor.userId);
    return { recoveryCodes };
  });
}

async function clearTotp(tx: Executor, userId: string): Promise<void> {
  await tx
    .update(adminUsers)
    .set({ totpSecretEncrypted: null, totpPendingSecretEncrypted: null, totpLastStep: null })
    .where(eq(adminUsers.id, userId));
  await tx.delete(adminRecoveryCodes).where(eq(adminRecoveryCodes.userId, userId));
}

// ─── User management (SUPER_ADMIN) ────────────────────────────────────────────────────

export const updateAdminUserSchema = z.object({
  displayName: adminDisplayNameSchema,
  roles: adminRolesSchema,
});

/** Edits name and roles. A role change ends the user's sessions (not the editor's own). */
export async function updateAdminUser(
  ctx: CoreContext,
  actor: AdminActor,
  userId: string,
  input: z.input<typeof updateAdminUserSchema>,
): Promise<void> {
  const data = updateAdminUserSchema.parse(input);
  await withTransaction(ctx.db, async (tx) => {
    const lockedSupers = await lockSuperAdmins(tx);
    const user = await loadUser(tx, userId, true);
    const wasSuper = user.roles.includes('SUPER_ADMIN');
    if (wasSuper && !data.roles.includes('SUPER_ADMIN') && user.isActive && user.passwordHash) {
      assertOtherSuperAdmin(lockedSupers, userId);
    }
    await tx
      .update(adminUsers)
      .set({ displayName: data.displayName, roles: data.roles })
      .where(eq(adminUsers.id, userId));
    const rolesChanged = [...user.roles].sort().join() !== [...data.roles].sort().join();
    if (rolesChanged && userId !== actor.userId) await revokeAdminSessions(tx, userId);
    await writeAdminAudit(tx, actor, 'admin_user.update', userId, {
      before: { displayName: user.displayName, roles: user.roles },
      after: data,
    });
  });
}

export async function setAdminUserActive(
  ctx: CoreContext,
  actor: AdminActor,
  userId: string,
  active: boolean,
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    if (!active && actor.userId === userId) {
      throw new DomainError('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate yourself', 409);
    }
    const lockedSupers = await lockSuperAdmins(tx);
    const user = await loadUser(tx, userId, true);
    if (user.isActive === active) return;
    if (!active && user.roles.includes('SUPER_ADMIN') && user.passwordHash) {
      assertOtherSuperAdmin(lockedSupers, userId);
    }
    await tx
      .update(adminUsers)
      .set({ isActive: active, failedLoginCount: 0, lockedUntil: null })
      .where(eq(adminUsers.id, userId));
    if (!active) {
      await revokeAdminSessions(tx, userId);
      await tx.delete(adminTokens).where(eq(adminTokens.userId, userId));
    }
    await writeAdminAudit(
      tx,
      actor,
      active ? 'admin_user.reactivate' : 'admin_user.deactivate',
      userId,
    );
  });
}

/** Ends a lockout early (admins can be locked out on purpose by someone guessing their password). */
export async function unlockAdminUser(
  ctx: CoreContext,
  actor: AdminActor,
  userId: string,
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    await loadUser(tx, userId, true);
    await tx
      .update(adminUsers)
      .set({ failedLoginCount: 0, lockedUntil: null })
      .where(eq(adminUsers.id, userId));
    await writeAdminAudit(tx, actor, 'admin_user.unlock', userId);
  });
}

/** Support case: the user lost the authenticator. Clears 2FA and ends the user's sessions. */
export async function resetAdminTwoFactor(
  ctx: CoreContext,
  actor: AdminActor,
  userId: string,
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    const user = await loadUser(tx, userId, true);
    await clearTotp(tx, userId);
    await revokeAdminSessions(tx, userId);
    await writeAdminAudit(tx, actor, 'admin_user.two_factor_reset', userId, {
      hadTwoFactor: user.totpSecretEncrypted !== null,
    });
  });
}

/** Removes an invitation that was never accepted (users who signed in stay for the audit trail). */
export async function deleteAdminInvite(
  ctx: CoreContext,
  actor: AdminActor,
  userId: string,
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    const user = await loadUser(tx, userId, true);
    if (user.passwordHash !== null || user.lastLoginAt !== null) {
      throw new DomainError(
        'USER_HAS_SIGNED_IN',
        'Only invitations that were never accepted can be deleted',
        409,
      );
    }
    await tx.delete(adminUsers).where(eq(adminUsers.id, userId));
    await writeAdminAudit(tx, actor, 'admin_user.delete_invite', userId, { email: user.email });
  });
}

/** True when the user has no 2FA although the security settings demand it. */
export async function adminNeedsTwoFactorSetup(
  ctx: Pick<CoreContext, 'db'>,
  userId: string,
): Promise<boolean> {
  const [user] = await ctx.db
    .select({ totp: adminUsers.totpSecretEncrypted })
    .from(adminUsers)
    .where(eq(adminUsers.id, userId));
  if (!user || user.totp) return false;
  return (await getSetting(ctx, 'security')).requireTwoFactor;
}
