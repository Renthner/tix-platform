'use server';

import {
  DomainError,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type SecondFactorProof,
  beginPasskeyReauth,
  beginPasskeyRegistration,
  beginTotpSetup,
  changeOwnPassword,
  confirmTotpSetup,
  disableTotp,
  finishPasskeyRegistration,
  regenerateRecoveryCodes,
  regenerateRecoveryCodesWithProof,
  removePasskey,
  renamePasskey,
  requestAdminEmailVerification,
  resetOwnAlertPreferences,
  saveOwnAlertPreferences,
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

/** Saves which warning e-mails the signed-in admin wants (types outside the roles are rejected). */
export async function saveAlertPreferencesAction(
  _prev: SecurityState,
  fd: FormData,
): Promise<SecurityState> {
  const { actor } = await account();
  const types = fd.getAll('types').filter((v): v is string => typeof v === 'string');
  return guarded(async () => {
    await saveOwnAlertPreferences(getCore(), actor, types);
    return ok({ message: 'alertsSaved' });
  });
}

export async function resetAlertPreferencesAction(
  _prev: SecurityState,
  _fd: FormData,
): Promise<SecurityState> {
  const { actor } = await account();
  return guarded(async () => {
    await resetOwnAlertPreferences(getCore(), actor);
    return ok({ message: 'alertsReset' });
  });
}

// ─── Passkeys ─────────────────────────────────────────────────────────────────────────

export type PasskeyBeginResult =
  | { ok: true; options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }
  | { ok: false; state: SecurityState };

/** Proof coming from the browser: a code or a passkey assertion (shape checked here, verified in core). */
function parseProof(raw: unknown): SecondFactorProof | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { code?: unknown; passkey?: { challengeId?: unknown; response?: unknown } };
  if (typeof r.code === 'string' && r.code.length <= 64) return { code: r.code };
  if (r.passkey && typeof r.passkey.challengeId === 'string') {
    return { passkey: { challengeId: r.passkey.challengeId, response: r.passkey.response } };
  }
  return undefined;
}

export type PasskeyProofOptions =
  | { ok: true; options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }
  | { ok: false; state: SecurityState };

/** Challenge for confirming "add a passkey" / "new recovery codes" with an existing passkey. */
export async function passkeyProofOptionsAction(
  purpose: 'add-passkey' | 'recovery-codes',
): Promise<PasskeyProofOptions> {
  const { actor } = await account();
  if (purpose !== 'add-passkey' && purpose !== 'recovery-codes') {
    return { ok: false, state: fail('VALIDATION') };
  }
  if (await limited(actor.userId)) return { ok: false, state: fail('RATE_LIMITED') };
  const bind = await currentAdminTokenHash();
  if (!bind) return { ok: false, state: fail('GENERIC') };
  let result: PasskeyProofOptions | null = null;
  const state = await guarded(async () => {
    result = { ok: true, ...(await beginPasskeyReauth(getCore(), actor.userId, bind, purpose)) };
    return ok();
  });
  return (result as PasskeyProofOptions | null) ?? { ok: false, state };
}

/** New recovery codes for users whose second factor is a passkey (password + passkey / recovery code). */
export async function regenerateRecoveryCodesWithPasskeyAction(
  password: string,
  proof: unknown,
): Promise<SecurityState> {
  const { actor } = await account();
  const parsed = parseProof(proof);
  if (typeof password !== 'string' || password === '' || password.length > 1024 || !parsed) {
    return fail('VALIDATION');
  }
  if (await limited(actor.userId)) return fail('RATE_LIMITED');
  const bind = await currentAdminTokenHash();
  if (!bind) return fail('GENERIC');
  return guarded(async () => {
    const { recoveryCodes } = await regenerateRecoveryCodesWithProof(
      getCore(),
      actor,
      password,
      bind,
      parsed,
    );
    return ok({ message: 'recoveryCodesRegenerated', recoveryCodes });
  });
}

/** Step 1 of adding a passkey: re-confirms the password (+ second factor), returns the options for the browser. */
export async function beginPasskeyRegistrationAction(
  password: string,
  proof?: unknown,
): Promise<PasskeyBeginResult> {
  const { actor } = await account();
  if (typeof password !== 'string' || password === '' || password.length > 1024) {
    return { ok: false, state: fail('VALIDATION') };
  }
  if (await limited(actor.userId)) return { ok: false, state: fail('RATE_LIMITED') };
  const bind = await currentAdminTokenHash();
  if (!bind) return { ok: false, state: fail('GENERIC') };
  let result: PasskeyBeginResult | null = null;
  const state = await guarded(async () => {
    result = {
      ok: true,
      ...(await beginPasskeyRegistration(getCore(), actor, password, bind, parseProof(proof))),
    };
    return ok();
  });
  return (result as PasskeyBeginResult | null) ?? { ok: false, state };
}

/** Step 2: verifies the authenticator's answer and stores the passkey (recovery codes once if it is the first factor). */
export async function finishPasskeyRegistrationAction(
  challengeId: string,
  response: unknown,
  name: string,
): Promise<SecurityState> {
  const { actor } = await account();
  const bind = await currentAdminTokenHash();
  if (!bind) return fail('GENERIC');
  const result = await guarded(async () => {
    const { recoveryCodes } = await finishPasskeyRegistration(getCore(), actor, {
      challengeId,
      response,
      name,
      bind,
      keepSessionTokenHash: bind,
    });
    return ok({ message: 'passkeyAdded', ...(recoveryCodes ? { recoveryCodes } : {}) });
  });
  revalidatePath('/', 'layout');
  return result;
}

export async function renamePasskeyAction(
  _prev: SecurityState,
  fd: FormData,
): Promise<SecurityState> {
  const { actor } = await account();
  const name = str(fd, 'name').trim();
  if (name === '' || name.length > 80) return fail('VALIDATION');
  const result = await guarded(async () => {
    await renamePasskey(getCore(), actor, str(fd, 'id'), name);
    return ok({ message: 'passkeyRenamed' });
  });
  revalidatePath('/', 'layout');
  return result;
}

export async function removePasskeyAction(
  _prev: SecurityState,
  fd: FormData,
): Promise<SecurityState> {
  const { actor } = await account();
  if (str(fd, 'password') === '') return fail('VALIDATION');
  if (await limited(actor.userId)) return fail('RATE_LIMITED');
  const result = await guarded(async () => {
    await removePasskey(getCore(), actor, str(fd, 'id'), str(fd, 'password'));
    return ok({ message: 'passkeyRemoved' });
  });
  revalidatePath('/', 'layout');
  return result;
}
