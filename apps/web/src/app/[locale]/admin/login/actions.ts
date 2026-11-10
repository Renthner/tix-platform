'use server';

import { DomainError } from '@tix/core';
import {
  checkAdminPassword,
  getAdminLoginBinding,
  safeReturnPath,
  verifyAdminSecondFactor,
} from '@tix/core';
import { z } from 'zod';
import { continueAdminLogin, emailSubject, finishAdminLogin } from '@/server/admin-login';
import {
  clearPendingAdminLogin,
  consumePendingAdminLogin,
  pendingAdminLoginActive,
  readPendingAdminLogin,
} from '@/server/auth';
import { getCore } from '@/server/core';
import { clientIp, enforceRateLimit } from '@/server/http';

export interface LoginState {
  step: 'password' | 'code';
  error: 'INVALID' | 'LOCKED' | 'RATE_LIMITED' | 'INVALID_CODE' | 'EXPIRED' | null;
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
  const pending = await readPendingAdminLogin();
  if (!pending) return { step: 'password', error: 'EXPIRED' };
  const core = getCore();
  const binding = await getAdminLoginBinding(core, pending.userId);
  if (
    !(await pendingAdminLoginActive(pending.nonce, pending.userId)) ||
    !binding ||
    !binding.active ||
    (binding.passwordChangedAt?.getTime() ?? 0) !== pending.passwordChangedAtMs
  ) {
    await clearPendingAdminLogin(pending.nonce);
    return { step: 'password', error: 'EXPIRED' };
  }
  if (binding.locked) return { step: 'code', error: 'LOCKED' };
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
