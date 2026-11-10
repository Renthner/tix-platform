'use server';

import {
  DomainError,
  beginTotpSetup,
  changeOwnPassword,
  confirmTotpSetup,
  disableTotp,
  regenerateRecoveryCodes,
  requestAdminEmailVerification,
  updateOwnProfile,
} from '@tix/core';
import { SUPPORTED_LOCALES, type AppLocale } from '@tix/shared';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import type { SecurityState } from '@/lib/security-state';
import { currentAdminTokenHash, requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { clientIp, enforceRateLimit } from '@/server/http';
import { fail, guarded, ok } from '@/server/security-action';

/** Own account (every role). Reachable while two-factor setup is still being enforced. */
async function account() {
  const session = await requireAdmin([], { allowTwoFactorSetup: true });
  const ip = await clientIp();
  return {
    session,
    actor: { userId: session.userId, ipAddress: ip === '0.0.0.0' ? null : ip },
  };
}

const str = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v : '';
};

async function limited(userId: string): Promise<boolean> {
  try {
    await enforceRateLimit('admin-account', userId, 15, 15 * 60_000);
    return false;
  } catch (err) {
    if (err instanceof DomainError) return true;
    throw err;
  }
}

/** Sends the one-time link that confirms the admin's e-mail address (unlocks the shop link). */
export async function sendEmailVerificationAction(
  _prev: SecurityState,
  _fd: FormData,
): Promise<SecurityState> {
  const { actor } = await account();
  if (await limited(actor.userId)) return fail('RATE_LIMITED');
  const raw = await getLocale();
  const locale = ((SUPPORTED_LOCALES as readonly string[]).includes(raw) ? raw : 'en') as AppLocale;
  return guarded(async () => {
    const { alreadyVerified } = await requestAdminEmailVerification(getCore(), actor, locale);
    revalidatePath('/', 'layout');
    return ok({ message: alreadyVerified ? 'alreadyVerified' : 'verificationSent' });
  });
}

export async function updateProfileAction(
  _prev: SecurityState,
  fd: FormData,
): Promise<SecurityState> {
  const { actor } = await account();
  const name = str(fd, 'displayName').trim();
  if (name === '' || name.length > 120) return fail('VALIDATION');
  const result = await guarded(async () => {
    await updateOwnProfile(getCore(), actor, name);
    return ok({ message: 'profileSaved' });
  });
  revalidatePath('/', 'layout');
  return result;
}

export async function changePasswordAction(
  _prev: SecurityState,
  fd: FormData,
): Promise<SecurityState> {
  const { actor } = await account();
  const next = str(fd, 'newPassword');
  if (next !== str(fd, 'confirmPassword')) return fail('MISMATCH');
  if (str(fd, 'currentPassword') === '' || next === '') return fail('VALIDATION');
  if (await limited(actor.userId)) return fail('RATE_LIMITED');
  return guarded(async () => {
    await changeOwnPassword(
      getCore(),
      actor,
      str(fd, 'currentPassword'),
      next,
      await currentAdminTokenHash(),
    );
    return ok({ message: 'passwordChanged' });
  });
}

export async function startTwoFactorSetupAction(): Promise<SecurityState> {
  const { actor } = await account();
  return guarded(async () => ok({ setup: await beginTotpSetup(getCore(), actor) }));
}

export async function confirmTwoFactorAction(
  _prev: SecurityState,
  fd: FormData,
): Promise<SecurityState> {
  const { actor } = await account();
  if (await limited(actor.userId)) return fail('RATE_LIMITED');
  return guarded(async () => {
    const { recoveryCodes } = await confirmTotpSetup(
      getCore(),
      actor,
      str(fd, 'password'),
      str(fd, 'code'),
      await currentAdminTokenHash(),
    );
    return ok({ message: 'twoFactorEnabled', recoveryCodes });
  });
}

export async function disableTwoFactorAction(
  _prev: SecurityState,
  fd: FormData,
): Promise<SecurityState> {
  const { actor } = await account();
  if (await limited(actor.userId)) return fail('RATE_LIMITED');
  const result = await guarded(async () => {
    await disableTotp(getCore(), actor, str(fd, 'password'), str(fd, 'code'));
    return ok({ message: 'twoFactorDisabled' });
  });
  revalidatePath('/', 'layout');
  return result;
}

export async function regenerateRecoveryCodesAction(
  _prev: SecurityState,
  fd: FormData,
): Promise<SecurityState> {
  const { actor } = await account();
  if (await limited(actor.userId)) return fail('RATE_LIMITED');
  return guarded(async () => {
    const { recoveryCodes } = await regenerateRecoveryCodes(
      getCore(),
      actor,
      str(fd, 'password'),
      str(fd, 'code'),
    );
    return ok({ message: 'recoveryCodesRegenerated', recoveryCodes });
  });
}
