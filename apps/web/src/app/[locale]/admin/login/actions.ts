'use server';

import { DomainError, type PublicKeyCredentialRequestOptionsJSON } from '@tix/core';
import {
  bindFromSecret,
  beginPasskeyLogin,
  countAdminPasskeys,
  beginPasskeySecondFactor,
  checkAdminPassword,
  passkeysAvailable,
  safeReturnPath,
  verifyAdminSecondFactor,
  verifyPasskeyAuthentication,
} from '@tix/core';
import { generateToken } from '@tix/shared/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import {
  checkPendingLogin,
  continueAdminLogin,
  emailSubject,
  finishAdminLogin,
} from '@/server/admin-login';
import {
  clearPendingAdminLogin,
  consumePendingAdminLogin,
  readPendingAdminLogin,
} from '@/server/auth';
import { getCore } from '@/server/core';
import { clientIp, enforceRateLimit } from '@/server/http';
import { cookieDefaults } from '@/server/session';

export interface LoginState {
  step: 'password' | 'code';
  error:
    'INVALID' | 'LOCKED' | 'RATE_LIMITED' | 'INVALID_CODE' | 'EXPIRED' | 'PASSKEY_FAILED' | null;
}

const schema = z.object({ email: z.email().max(254), password: z.string().min(1).max(1024) });

async function limited(bucket: string, subject: string, max: number): Promise<boolean> {
  try {
    await enforceRateLimit(bucket, subject, max, 15 * 60_000);
    return false;
  } catch (err) {
    if (err instanceof DomainError) return true;
    throw err;
  }
}

/** Step 1: e-mail + password. With two-factor on, only a pending cookie is set. */
export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return { step: 'password', error: 'INVALID' };
  const email = parsed.data.email.trim().toLowerCase();
  const ip = await clientIp();
  if (
    (await limited('admin-login-ip', ip, 20)) ||
    (await limited('admin-login-email', emailSubject(email), 10))
  ) {
    return { step: 'password', error: 'RATE_LIMITED' };
  }

  const core = getCore();
  const address = ip === '0.0.0.0' ? null : ip;
  // A locked account answers exactly like a wrong password (no account enumeration).
  const result = await checkAdminPassword(core, email, parsed.data.password, address);
  if (result.status === 'invalid') return { step: 'password', error: 'INVALID' };
  return { step: await continueAdminLogin(result, null, 'admin_portal'), error: null };
}

/** Step 2: authenticator code or recovery code, bound to the pending-login cookie. */
export async function twoFactorAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const code = formData.get('code');
  const pending = await checkPendingLogin();
  if (pending.status === 'expired') return { step: 'password', error: 'EXPIRED' };
  if (pending.status === 'locked') return { step: 'code', error: 'LOCKED' };
  const core = getCore();
  if (typeof code !== 'string' || code.trim() === '')
    return { step: 'code', error: 'INVALID_CODE' };
  const ip = await clientIp();
  if (
    (await limited('admin-2fa-user', pending.userId, 10)) ||
    (await limited('admin-2fa-ip', ip, 30))
  ) {
    return { step: 'code', error: 'RATE_LIMITED' };
  }

  let method: 'totp' | 'recovery_code';
  try {
    method = await verifyAdminSecondFactor(
      core,
      pending.userId,
      code,
      undefined,
      ip === '0.0.0.0' ? null : ip,
    );
  } catch (err) {
    if (err instanceof DomainError) {
      return { step: 'code', error: err.code === 'ACCOUNT_LOCKED' ? 'LOCKED' : 'INVALID_CODE' };
    }
    throw err;
  }
  // One session per pending login: the nonce can only be consumed once.
  const consumed = await consumePendingAdminLogin(pending.nonce, pending.userId);
  await clearPendingAdminLogin();
  if (!consumed) return { step: 'password', error: 'EXPIRED' };
  // `form=shop` + `next` are only sent by the shop's sign-in form; `next` is validated
  // (same-origin relative path) and defaults to the shop start page there.
  const shop = formData.get('form') === 'shop';
  return shop
    ? finishAdminLogin(pending.userId, method, safeReturnPath(formData.get('next')) ?? '/', 'shop')
    : finishAdminLogin(pending.userId, method, null, 'admin_portal');
}

/** Back to the password step. */
export async function cancelTwoFactorAction(): Promise<LoginState> {
  await clearPendingAdminLogin((await readPendingAdminLogin())?.nonce);
  return { step: 'password', error: null };
}

// ─── Passkeys ─────────────────────────────────────────────────────────────────────────

type PasskeyError = NonNullable<LoginState['error']>;
export type PasskeyOptionsResult =
  | { ok: true; options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }
  | { ok: false; error: PasskeyError };

/** Sent by the shop's sign-in form only (`next` is validated; default: the shop start page). */
const shopContextSchema = z.object({ next: z.string().max(2048).nullable() }).nullable();

/** Browser binding of a usernameless sign-in challenge (random secret in a short-lived cookie). */
const PASSKEY_COOKIE = 'tix_admin_pk';
const PASSKEY_COOKIE_TTL_SECONDS = 120;

function passkeyError(err: unknown): PasskeyError {
  if (!(err instanceof DomainError)) throw err;
  if (err.code === 'ACCOUNT_LOCKED') return 'LOCKED';
  if (err.code === 'RATE_LIMITED') return 'RATE_LIMITED';
  return 'PASSKEY_FAILED';
}

/** Usernameless sign-in, step 1: challenge + options for the "Sign in with passkey" button. */
export async function passkeyLoginOptionsAction(): Promise<PasskeyOptionsResult> {
  const core = getCore();
  if (!passkeysAvailable(core)) return { ok: false, error: 'PASSKEY_FAILED' };
  if (await limited('admin-passkey-options-ip', await clientIp(), 60)) {
    return { ok: false, error: 'RATE_LIMITED' };
  }
  const secret = generateToken(16);
  (await cookies()).set(PASSKEY_COOKIE, secret, {
    ...cookieDefaults(PASSKEY_COOKIE_TTL_SECONDS),
    sameSite: 'strict',
  });
  try {
    return { ok: true, ...(await beginPasskeyLogin(core, bindFromSecret(secret))) };
  } catch (err) {
    return { ok: false, error: passkeyError(err) };
  }
}

/**
 * Usernameless sign-in, step 2: verifies the assertion (user verification required, so it counts
 * as password + second factor) and opens the session. Redirects on success.
 */
export async function passkeyLoginVerifyAction(
  challengeId: string,
  response: unknown,
  shopInput: unknown = null,
): Promise<{ error: PasskeyError }> {
  const shop = shopContextSchema.safeParse(shopInput);
  if (!shop.success) return { error: 'PASSKEY_FAILED' };
  const ip = await clientIp();
  if (await limited('admin-passkey-ip', ip, 20)) return { error: 'RATE_LIMITED' };
  const jar = await cookies();
  const secret = jar.get(PASSKEY_COOKIE)?.value;
  jar.delete(PASSKEY_COOKIE);
  if (!secret || secret.length > 100) return { error: 'EXPIRED' };
  let userId: string;
  try {
    ({ userId } = await verifyPasskeyAuthentication(getCore(), {
      purpose: 'login',
      challengeId,
      response,
      bind: bindFromSecret(secret),
      ipAddress: ip === '0.0.0.0' ? null : ip,
    }));
  } catch (err) {
    return { error: passkeyError(err) };
  }
  return shop.data
    ? finishAdminLogin(userId, 'passkey', safeReturnPath(shop.data.next) ?? '/', 'shop')
    : finishAdminLogin(userId, 'passkey', null, 'admin_portal');
}

/** True when the user of the pending password login has a passkey (offers the button in the code step). */
export async function pendingPasskeysAction(): Promise<boolean> {
  const core = getCore();
  if (!passkeysAvailable(core)) return false;
  const pending = await checkPendingLogin();
  return pending.status === 'ok' && (await countAdminPasskeys(core, pending.userId)) > 0;
}

/** Second step of a password login with a passkey instead of a code: options. */
export async function passkeySecondFactorOptionsAction(): Promise<PasskeyOptionsResult> {
  const core = getCore();
  const pending = await checkPendingLogin();
  if (pending.status === 'expired') return { ok: false, error: 'EXPIRED' };
  if (pending.status === 'locked') return { ok: false, error: 'LOCKED' };
  if (await limited('admin-passkey-options-ip', await clientIp(), 60)) {
    return { ok: false, error: 'RATE_LIMITED' };
  }
  try {
    return { ok: true, ...(await beginPasskeySecondFactor(core, pending.userId, pending.nonce)) };
  } catch (err) {
    return { ok: false, error: passkeyError(err) };
  }
}

/** Second step with a passkey: verify, consume the pending login once, open the session. */
export async function passkeySecondFactorVerifyAction(
  challengeId: string,
  response: unknown,
  shopInput: unknown = null,
): Promise<{ error: PasskeyError }> {
  const shop = shopContextSchema.safeParse(shopInput);
  if (!shop.success) return { error: 'PASSKEY_FAILED' };
  const pending = await checkPendingLogin();
  if (pending.status === 'expired') return { error: 'EXPIRED' };
  if (pending.status === 'locked') return { error: 'LOCKED' };
  const ip = await clientIp();
  if (
    (await limited('admin-2fa-user', pending.userId, 10)) ||
    (await limited('admin-2fa-ip', ip, 30))
  ) {
    return { error: 'RATE_LIMITED' };
  }
  try {
    await verifyPasskeyAuthentication(getCore(), {
      purpose: 'second-factor',
      challengeId,
      response,
      bind: pending.nonce,
      expectedUserId: pending.userId,
      ipAddress: ip === '0.0.0.0' ? null : ip,
    });
  } catch (err) {
    return { error: passkeyError(err) };
  }
  const consumed = await consumePendingAdminLogin(pending.nonce, pending.userId);
  await clearPendingAdminLogin();
  if (!consumed) return { error: 'EXPIRED' };
  return shop.data
    ? finishAdminLogin(pending.userId, 'passkey', safeReturnPath(shop.data.next) ?? '/', 'shop')
    : finishAdminLogin(pending.userId, 'passkey', null, 'admin_portal');
}
