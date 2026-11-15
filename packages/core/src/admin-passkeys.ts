import { isIP } from 'node:net';
import {
  adminPasskeys,
  adminRecoveryCodes,
  adminSessions,
  adminUsers,
  withTransaction,
} from '@tix/db';
import { generateToken, hashToken } from '@tix/shared/server';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canRemoveSecondFactor } from './admin-two-factor';
import {
  registerAdminFailedAttempt,
  replaceAdminRecoveryCodes,
  revokeAdminSessions,
  verifyAdminPassword,
  verifyAdminSecondFactor,
  writeAdminAudit,
  type AdminActor,
} from './admin-users';
import { DomainError, type CoreContext } from './context';
import { hasSecondFactor } from './admin-two-factor';
import { createEmailMessage, dispatchEmailMessage } from './email/request';
import { formatDateTime } from './format';
import { getSetting } from './settings';

/**
 * WebAuthn passkeys of admin users (registration, passwordless sign-in, second factor).
 *
 * Security properties:
 * - The relying party is derived from the configured public URL (`APP_URL`), never from request
 *   headers; only exactly that origin is accepted. Without a usable URL (IP address, plain http on
 *   a non-localhost host) passkeys are unavailable.
 * - Challenges are random, live in Redis for 2 minutes, are bound to a purpose and to the browser /
 *   user / pending login they were issued to, and are consumed (GETDEL) BEFORE verification: a
 *   failed attempt burns the challenge, a captured response cannot be replayed.
 * - User verification is always required (a passkey alone then equals password + second factor).
 * - Signature counters are checked: a counter that does not advance (while one side is non-zero)
 *   is treated as a cloned authenticator (audited, rejected). Synced passkeys report 0 and are fine.
 * - Registering and removing a passkey needs the current password (rate limited).
 */

export type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';

export const MAX_PASSKEYS_PER_USER = 10;
const CHALLENGE_TTL_SECONDS = 120;
/** EdDSA, ES256, RS256 (what the library supports for `none` attestation without PQC surprises). */
const SUPPORTED_ALGORITHMS = [-8, -7, -257];

const passkeyInvalid = () =>
  new DomainError('PASSKEY_INVALID', 'The passkey could not be verified', 403);

// ─── Relying party ────────────────────────────────────────────────────────────────────

export interface RelyingParty {
  rpID: string;
  origin: string;
}

/** RP id + the single allowed origin from the public URL; null when WebAuthn cannot work there. */
export function resolveRelyingParty(appUrl: string | undefined): RelyingParty | null {
  if (!appUrl) return null;
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (isIP(host) !== 0 || host.startsWith('[')) return null; // rp ids must be domain names
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && host === 'localhost');
  if (!secure) return null;
  return { rpID: host, origin: url.origin };
}

export function passkeysAvailable(ctx: Pick<CoreContext, 'appUrl'>): boolean {
  return resolveRelyingParty(ctx.appUrl) !== null;
}

function relyingParty(ctx: Pick<CoreContext, 'appUrl'>): RelyingParty {
  const rp = resolveRelyingParty(ctx.appUrl);
  if (!rp) {
    throw new DomainError(
      'PASSKEYS_UNAVAILABLE',
      'Passkeys need the public URL to be https (or localhost) with a domain name',
      409,
    );
  }
  return rp;
}

// ─── Challenges (Redis, single use) ───────────────────────────────────────────────────

export type ChallengePurpose =
  | 'register'
  | 'login'
  | 'second-factor'
  | 'restore'
  | 'add-passkey'
  | 'recovery-codes'
  | 'loadtest';

/** Purposes of assertions that re-confirm a signed-in admin (challenge bound to user + `bind`). */
export type ReauthPurpose = 'restore' | 'add-passkey' | 'recovery-codes' | 'loadtest';

export interface ChallengeRecord {
  challenge: string;
  /** User the challenge was issued for (null: usernameless sign-in). */
  userId: string | null;
  /** Opaque value the answer must present again (browser cookie hash, session hash, pending nonce). */
  bind: string;
}

const challengeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const challengeKey = (ctx: Pick<CoreContext, 'keys'>, purpose: ChallengePurpose, id: string) =>
  `${ctx.keys.prefix}:webauthn:${purpose}:${id}`;

/** Stores a challenge and returns its id (handed to the browser next to the options). */
export async function storeChallenge(
  ctx: Pick<CoreContext, 'redis' | 'keys'>,
  purpose: ChallengePurpose,
  record: ChallengeRecord,
): Promise<string> {
  const id = generateToken(18);
  await ctx.redis.set(
    challengeKey(ctx, purpose, id),
    JSON.stringify(record),
    'EX',
    CHALLENGE_TTL_SECONDS,
  );
  return id;
}

/**
 * Atomically consumes a challenge. Null when it is unknown, expired, already used or issued for
 * another purpose / user / binding.
 */
export async function consumeChallenge(
  ctx: Pick<CoreContext, 'redis' | 'keys'>,
  purpose: ChallengePurpose,
  id: unknown,
  expect: { userId?: string | null; bind: string },
): Promise<ChallengeRecord | null> {
  const parsed = challengeIdSchema.safeParse(id);
  if (!parsed.success) return null;
  const raw = await ctx.redis.getdel(challengeKey(ctx, purpose, parsed.data));
  if (!raw) return null;
  let record: ChallengeRecord;
  try {
    record = JSON.parse(raw) as ChallengeRecord;
  } catch {
    return null;
  }
  if (record.bind !== expect.bind) return null;
  if (expect.userId !== undefined && record.userId !== expect.userId) return null;
  return record;
}

// ─── Browser responses (shape validation) ─────────────────────────────────────────────

const b64url = z.string().min(1).max(16_384);
const clientExtensions = z.record(z.string(), z.unknown());

export const registrationResponseSchema = z.object({
  id: b64url,
  rawId: b64url,
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: clientExtensions,
  response: z.object({
    clientDataJSON: b64url,
    attestationObject: b64url,
    authenticatorData: b64url.optional(),
    transports: z.array(z.string().max(32)).max(10).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: b64url.optional(),
  }),
});

export const authenticationResponseSchema = z.object({
  id: b64url,
  rawId: b64url,
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: clientExtensions,
  response: z.object({
    clientDataJSON: b64url,
    authenticatorData: b64url,
    signature: b64url,
    userHandle: b64url.optional(),
  }),
});

export const passkeyNameSchema = z.string().trim().min(1).max(80);

// ─── Listing ──────────────────────────────────────────────────────────────────────────

export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  deviceType: string;
  backedUp: boolean;
}

export async function listOwnPasskeys(
  ctx: Pick<CoreContext, 'db'>,
  userId: string,
): Promise<PasskeySummary[]> {
  return ctx.db
    .select({
      id: adminPasskeys.id,
      name: adminPasskeys.name,
      createdAt: adminPasskeys.createdAt,
      lastUsedAt: adminPasskeys.lastUsedAt,
      deviceType: adminPasskeys.deviceType,
      backedUp: adminPasskeys.backedUp,
    })
    .from(adminPasskeys)
    .where(eq(adminPasskeys.adminUserId, userId))
    .orderBy(asc(adminPasskeys.createdAt), asc(adminPasskeys.id));
}

export async function countAdminPasskeys(
  ctx: Pick<CoreContext, 'db'>,
  userId: string,
): Promise<number> {
  const [row] = await ctx.db
    .select({ n: count() })
    .from(adminPasskeys)
    .where(eq(adminPasskeys.adminUserId, userId));
  return row?.n ?? 0;
}

/** WebAuthn user handle of an admin (stable, opaque to the authenticator). */
const userHandleOf = (userId: string) => new TextEncoder().encode(userId);
const decodeUserHandle = (handle: string) => Buffer.from(handle, 'base64url').toString('utf8');

// ─── Registration ─────────────────────────────────────────────────────────────────────

/** Extra proof of a second factor: an authenticator / recovery code or a passkey assertion. */
export type SecondFactorProof =
  { code: string } | { passkey: { challengeId: unknown; response: unknown } };

/** Throws unless `proof` is a valid code or an assertion for a challenge issued for `purpose`. */
async function verifySecondFactorProof(
  ctx: CoreContext,
  actor: AdminActor & { userId: string },
  bind: string,
  purpose: 'add-passkey' | 'recovery-codes',
  proof: SecondFactorProof | undefined,
): Promise<void> {
  if (proof && 'passkey' in proof) {
    await verifyPasskeyAuthentication(ctx, {
      purpose,
      challengeId: proof.passkey.challengeId,
      response: proof.passkey.response,
      bind,
      expectedUserId: actor.userId,
      ipAddress: actor.ipAddress,
    });
    return;
  }
  if (!proof || typeof proof.code !== 'string' || proof.code.trim() === '') {
    throw new DomainError('INVALID_CODE', 'A second factor is required', 403);
  }
  await verifyAdminSecondFactor(ctx, actor.userId, proof.code, undefined, actor.ipAddress);
}

/**
 * Step 1 of adding a passkey: re-confirms the password, then returns the creation options and the
 * challenge id. `bind` ties the challenge to the current admin session.
 */
export async function beginPasskeyRegistration(
  ctx: CoreContext,
  actor: AdminActor & { userId: string },
  password: string,
  bind: string,
  proof?: SecondFactorProof,
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }> {
  const rp = relyingParty(ctx);
  await verifyAdminPassword(ctx, actor.userId, password);
  const [user] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.id, actor.userId));
  if (!user || !user.isActive) throw new DomainError('ADMIN_USER_NOT_FOUND', 'Not found', 404);
  // A session that only knows the password must not be able to plant its own second factor.
  const factors = {
    hasTotp: user.totpSecretEncrypted !== null,
    passkeyCount: await countAdminPasskeys(ctx, user.id),
  };
  if (hasSecondFactor(factors)) {
    await verifySecondFactorProof(ctx, actor, bind, 'add-passkey', proof);
  }
  const existing = await ctx.db
    .select({ id: adminPasskeys.credentialId, transports: adminPasskeys.transports })
    .from(adminPasskeys)
    .where(eq(adminPasskeys.adminUserId, user.id));
  if (existing.length >= MAX_PASSKEYS_PER_USER) {
    throw new DomainError('PASSKEY_LIMIT', 'The maximum number of passkeys is reached', 409);
  }
  const general = await getSetting(ctx, 'general');
  const options = await generateRegistrationOptions({
    rpName: general.shopName,
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.displayName,
    userID: userHandleOf(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({
      id: c.id,
      transports: c.transports ?? undefined,
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
  });
  const challengeId = await storeChallenge(ctx, 'register', {
    challenge: options.challenge,
    userId: user.id,
    bind,
  });
  return { options, challengeId };
}

/**
 * Step 2: verifies the authenticator's answer and stores the passkey. When the user has no
 * recovery codes yet (no authenticator app), a set is generated and returned once.
 */
export async function finishPasskeyRegistration(
  ctx: CoreContext,
  actor: AdminActor & { userId: string },
  input: {
    challengeId: unknown;
    response: unknown;
    name: unknown;
    /** Browser binding of the challenge (the current admin session hash). */
    bind: string;
    /** Current session: kept (and marked second-factor verified) when this is the first factor. */
    keepSessionTokenHash?: string | null;
  },
): Promise<{ passkey: PasskeySummary; recoveryCodes: string[] | null }> {
  const rp = relyingParty(ctx);
  const response = registrationResponseSchema.safeParse(input.response);
  const name = passkeyNameSchema.safeParse(input.name);
  if (!response.success || !name.success) {
    throw new DomainError('VALIDATION', 'Invalid passkey data', 422);
  }
  const challenge = await consumeChallenge(ctx, 'register', input.challengeId, {
    userId: actor.userId,
    bind: input.bind,
  });
  if (!challenge) throw passkeyInvalid();
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response: response.data as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
    });
  } catch {
    throw passkeyInvalid();
  }
  if (!verified.verified) throw passkeyInvalid();
  const info = verified.registrationInfo;
  const general = await getSetting(ctx, 'general');
  const result = await withTransaction(ctx.db, async (tx) => {
    const [user] = await tx
      .select({
        id: adminUsers.id,
        isActive: adminUsers.isActive,
        totp: adminUsers.totpSecretEncrypted,
        email: adminUsers.email,
        displayName: adminUsers.displayName,
      })
      .from(adminUsers)
      .where(eq(adminUsers.id, actor.userId))
      .for('update');
    if (!user || !user.isActive) throw new DomainError('ADMIN_USER_NOT_FOUND', 'Not found', 404);
    const [have] = await tx
      .select({ n: count() })
      .from(adminPasskeys)
      .where(eq(adminPasskeys.adminUserId, actor.userId));
    if ((have?.n ?? 0) >= MAX_PASSKEYS_PER_USER) {
      throw new DomainError('PASSKEY_LIMIT', 'The maximum number of passkeys is reached', 409);
    }
    const firstFactor = user.totp === null && (have?.n ?? 0) === 0;
    const [row] = await tx
      .insert(adminPasskeys)
      .values({
        adminUserId: actor.userId,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey),
        counter: info.credential.counter,
        transports: info.credential.transports ?? response.data.response.transports ?? null,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        name: name.data,
      })
      .onConflictDoNothing({ target: adminPasskeys.credentialId })
      .returning({
        id: adminPasskeys.id,
        name: adminPasskeys.name,
        createdAt: adminPasskeys.createdAt,
        lastUsedAt: adminPasskeys.lastUsedAt,
        deviceType: adminPasskeys.deviceType,
        backedUp: adminPasskeys.backedUp,
      });
    if (!row) throw new DomainError('PASSKEY_EXISTS', 'This passkey is already registered', 409);
    const [codes] = await tx
      .select({ n: count() })
      .from(adminRecoveryCodes)
      .where(eq(adminRecoveryCodes.userId, actor.userId));
    const recoveryCodes =
      (codes?.n ?? 0) === 0 ? await replaceAdminRecoveryCodes(tx, actor.userId) : null;
    // Like turning on the authenticator app: the first second factor ends every other (possibly
    // password-only) session; the current one counts as second-factor verified.
    if (firstFactor && input.keepSessionTokenHash) {
      await revokeAdminSessions(tx, actor.userId, input.keepSessionTokenHash);
      await tx
        .update(adminSessions)
        .set({ mfaVerifiedAt: new Date() })
        .where(eq(adminSessions.tokenHash, input.keepSessionTokenHash));
    }
    await writeAdminAudit(tx, actor, 'admin_user.passkey_registered', actor.userId, {
      passkeyId: row.id,
      name: name.data,
      deviceType: info.credentialDeviceType,
    });
    // Security notice: the owner learns about every new passkey (outbox, sent after the commit).
    const locale = general.defaultLocale;
    const messageId = await createEmailMessage(ctx, tx, {
      key: 'ADMIN_PASSKEY_ADDED',
      to: user.email,
      locale,
      variables: {
        firstName: user.displayName,
        passkeyName: name.data,
        addedAt: formatDateTime(new Date(), locale, general.defaultTimeZone, 'long'),
        accountUrl: `${ctx.appUrl ?? ''}/${locale}/admin/account`,
      },
    });
    return { passkey: row, recoveryCodes, messageId };
  });
  await dispatchEmailMessage(ctx, result.messageId);
  return { passkey: result.passkey, recoveryCodes: result.recoveryCodes };
}

/**
 * New recovery codes for a user whose second factor is a passkey (no authenticator app): password
 * plus a passkey assertion (challenge from `beginPasskeyReauth(..., 'recovery-codes')`) or an
 * existing recovery code.
 */
export async function regenerateRecoveryCodesWithProof(
  ctx: CoreContext,
  actor: AdminActor & { userId: string },
  password: string,
  bind: string,
  proof: SecondFactorProof,
): Promise<{ recoveryCodes: string[] }> {
  await verifyAdminPassword(ctx, actor.userId, password);
  await verifySecondFactorProof(ctx, actor, bind, 'recovery-codes', proof);
  return withTransaction(ctx.db, async (tx) => {
    const recoveryCodes = await replaceAdminRecoveryCodes(tx, actor.userId);
    await writeAdminAudit(tx, actor, 'admin_user.recovery_codes_regenerate', actor.userId);
    return { recoveryCodes };
  });
}

// ─── Rename / remove ──────────────────────────────────────────────────────────────────

export async function renamePasskey(
  ctx: CoreContext,
  actor: AdminActor & { userId: string },
  passkeyId: string,
  nameInput: unknown,
): Promise<void> {
  const name = passkeyNameSchema.safeParse(nameInput);
  if (!name.success || !z.uuid().safeParse(passkeyId).success) {
    throw new DomainError('VALIDATION', 'Invalid input', 422);
  }
  await withTransaction(ctx.db, async (tx) => {
    const [row] = await tx
      .update(adminPasskeys)
      .set({ name: name.data })
      .where(and(eq(adminPasskeys.id, passkeyId), eq(adminPasskeys.adminUserId, actor.userId)))
      .returning({ id: adminPasskeys.id });
    if (!row) throw new DomainError('PASSKEY_NOT_FOUND', 'Passkey not found', 404);
    await writeAdminAudit(tx, actor, 'admin_user.passkey_renamed', actor.userId, {
      passkeyId,
      name: name.data,
    });
  });
}

/**
 * Removes a passkey (password re-confirmation). Refused while the security settings demand a
 * second factor and this is the user's last one. The user row is locked, so two concurrent
 * removals cannot both pass the check.
 */
export async function removePasskey(
  ctx: CoreContext,
  actor: AdminActor & { userId: string },
  passkeyId: string,
  password: string,
): Promise<void> {
  if (!z.uuid().safeParse(passkeyId).success) {
    throw new DomainError('VALIDATION', 'Invalid input', 422);
  }
  await verifyAdminPassword(ctx, actor.userId, password);
  const security = await getSetting(ctx, 'security');
  await withTransaction(ctx.db, async (tx) => {
    const [user] = await tx
      .select({ roles: adminUsers.roles, totp: adminUsers.totpSecretEncrypted })
      .from(adminUsers)
      .where(eq(adminUsers.id, actor.userId))
      .for('update');
    if (!user) throw new DomainError('ADMIN_USER_NOT_FOUND', 'Not found', 404);
    const own = await tx
      .select({ id: adminPasskeys.id, name: adminPasskeys.name })
      .from(adminPasskeys)
      .where(eq(adminPasskeys.adminUserId, actor.userId));
    const target = own.find((p) => p.id === passkeyId);
    if (!target) throw new DomainError('PASSKEY_NOT_FOUND', 'Passkey not found', 404);
    const remaining = own.length - 1;
    if (
      !canRemoveSecondFactor(
        { hasTotp: user.totp !== null, passkeyCount: remaining },
        user.roles,
        security,
      )
    ) {
      throw new DomainError(
        'TWO_FACTOR_REQUIRED',
        'This is your last second factor and two-factor authentication is mandatory for you',
        409,
      );
    }
    await tx.delete(adminPasskeys).where(eq(adminPasskeys.id, passkeyId));
    // Recovery codes only make sense while some second factor exists.
    if (remaining === 0 && user.totp === null) {
      await tx.delete(adminRecoveryCodes).where(eq(adminRecoveryCodes.userId, actor.userId));
    }
    await writeAdminAudit(tx, actor, 'admin_user.passkey_removed', actor.userId, {
      passkeyId,
      name: target.name,
    });
  });
}

// ─── Authentication ───────────────────────────────────────────────────────────────────

/** Options for the "sign in with passkey" button (usernameless: no allow list). */
export async function beginPasskeyLogin(
  ctx: CoreContext,
  bind: string,
): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }> {
  const rp = relyingParty(ctx);
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: 'required',
  });
  const challengeId = await storeChallenge(ctx, 'login', {
    challenge: options.challenge,
    userId: null,
    bind,
  });
  return { options, challengeId };
}

/** Options for using a passkey as the second step of a password login (bound to the pending login). */
export async function beginPasskeySecondFactor(
  ctx: CoreContext,
  userId: string,
  pendingNonce: string,
): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }> {
  const rp = relyingParty(ctx);
  const credentials = await ctx.db
    .select({ id: adminPasskeys.credentialId, transports: adminPasskeys.transports })
    .from(adminPasskeys)
    .where(eq(adminPasskeys.adminUserId, userId));
  if (credentials.length === 0) throw passkeyInvalid();
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: 'required',
    allowCredentials: credentials.map((c) => ({ id: c.id, transports: c.transports ?? undefined })),
  });
  const challengeId = await storeChallenge(ctx, 'second-factor', {
    challenge: options.challenge,
    userId,
    bind: pendingNonce,
  });
  return { options, challengeId };
}

/**
 * Options for confirming a destructive action (restoring a backup) with a passkey. The challenge is
 * bound to the signed-in user and to `bind` (the action + its target, e.g. the backup), single use,
 * and only accepted by `verifyPasskeyAuthentication` with purpose `restore`.
 */
export async function beginPasskeyReauth(
  ctx: CoreContext,
  userId: string,
  bind: string,
  purpose: ReauthPurpose = 'restore',
): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }> {
  const rp = relyingParty(ctx);
  const credentials = await ctx.db
    .select({ id: adminPasskeys.credentialId, transports: adminPasskeys.transports })
    .from(adminPasskeys)
    .where(eq(adminPasskeys.adminUserId, userId));
  if (credentials.length === 0) throw passkeyInvalid();
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: 'required',
    allowCredentials: credentials.map((c) => ({ id: c.id, transports: c.transports ?? undefined })),
  });
  const challengeId = await storeChallenge(ctx, purpose, {
    challenge: options.challenge,
    userId,
    bind,
  });
  return { options, challengeId };
}

/**
 * Verifies a passkey assertion. For `second-factor` and `restore` the credential must belong to
 * `expectedUserId` (the user of the pending password login / the signed-in admin). Rejects unknown credentials,
 * inactive / locked / invitation-only accounts, wrong user handles, failed signatures and counter
 * regressions (clone suspicion). Failed verifications of a known credential count like a wrong
 * password (shared lockout). Returns the user; the caller opens the session.
 */
export async function verifyPasskeyAuthentication(
  ctx: CoreContext,
  input: {
    purpose: 'login' | 'second-factor' | ReauthPurpose;
    challengeId: unknown;
    response: unknown;
    bind: string;
    expectedUserId?: string;
    ipAddress?: string | null;
  },
): Promise<{ userId: string }> {
  const rp = relyingParty(ctx);
  const parsed = authenticationResponseSchema.safeParse(input.response);
  if (!parsed.success) throw passkeyInvalid();
  const response = parsed.data as AuthenticationResponseJSON;
  const challenge = await consumeChallenge(ctx, input.purpose, input.challengeId, {
    userId: input.purpose === 'login' ? null : (input.expectedUserId ?? ''),
    bind: input.bind,
  });
  if (!challenge) throw passkeyInvalid();

  const [row] = await ctx.db
    .select({ passkey: adminPasskeys, user: adminUsers })
    .from(adminPasskeys)
    .innerJoin(adminUsers, eq(adminUsers.id, adminPasskeys.adminUserId))
    .where(eq(adminPasskeys.credentialId, response.id));
  if (!row) throw passkeyInvalid();
  const { passkey, user } = row;
  if (input.expectedUserId !== undefined && user.id !== input.expectedUserId)
    throw passkeyInvalid();
  if (!user.isActive || !user.passwordHash) throw passkeyInvalid();
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new DomainError('ACCOUNT_LOCKED', 'The account is temporarily locked', 423);
  }
  const fail = async (action: 'login_failed' | 'clone_suspected'): Promise<never> => {
    const locked = await registerAdminFailedAttempt(ctx, user.id, input.ipAddress, 'passkey');
    if (action === 'clone_suspected') {
      await writeAdminAudit(
        ctx.db,
        { userId: user.id, ipAddress: input.ipAddress },
        'admin_user.passkey_clone_suspected',
        user.id,
        { passkeyId: passkey.id },
      );
    }
    if (locked) throw new DomainError('ACCOUNT_LOCKED', 'The account is temporarily locked', 423);
    throw passkeyInvalid();
  };
  // The authenticator echoes the handle we registered; if present it must name this user.
  const handle = response.response.userHandle;
  if (handle !== undefined && decodeUserHandle(handle) !== user.id) return fail('login_failed');

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    // The library checks the signature counter BEFORE the signature, so a forged response with a
    // low counter would look like a clone. It is given counter 0 (its check then never fires) and
    // the regression is judged here, only after the signature proved to be genuine.
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: 0,
        transports: passkey.transports ?? undefined,
      },
      requireUserVerification: true,
    });
  } catch {
    return fail('login_failed');
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    return fail('login_failed');
  }
  // Authentic signature: a counter that did not advance (while one side is non-zero) is a clone.
  const newCounter = verification.authenticationInfo.newCounter;
  if ((newCounter > 0 || passkey.counter > 0) && newCounter <= passkey.counter) {
    return fail('clone_suspected');
  }
  // Conditional on the counter we verified against: a parallel use of the same assertion loses.
  const [updated] = await ctx.db
    .update(adminPasskeys)
    .set({
      counter: verification.authenticationInfo.newCounter,
      backedUp: verification.authenticationInfo.credentialBackedUp,
      lastUsedAt: sql`now()`,
    })
    .where(and(eq(adminPasskeys.id, passkey.id), eq(adminPasskeys.counter, passkey.counter)))
    .returning({ id: adminPasskeys.id });
  if (!updated) return fail('clone_suspected');
  return { userId: user.id };
}

/** Constant helper for callers that need a cookie-bound value without storing the raw cookie. */
export const bindFromSecret = (secret: string): string => hashToken(secret);
