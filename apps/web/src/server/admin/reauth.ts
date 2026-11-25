import {
  DomainError,
  type ReauthPurpose,
  checkAdminPassword,
  verifyAdminSecondFactor,
  verifyPasskeyAuthentication,
} from '@tix/core';
import type { getCore } from '@/server/core';
import { logger } from '@/server/logger';
import { clientIp } from '@/server/http';
import { text } from './form';

/** Why a fresh confirmation (password + second factor / passkey) was refused. */
export type ReauthError =
  | 'password'
  | 'twoFactorSetupRequired'
  | 'passkeyInvalid'
  | 'locked'
  | 'twoFactorRequired'
  | 'twoFactorInvalid';

/**
 * Fresh password, authenticator / recovery code or passkey (when the user has 2FA) for a dangerous
 * action. `purpose` + `bind` tie a passkey challenge to that one action (a challenge issued for a
 * restore is useless for the load test mode and vice versa). `requireTwoFactor`: refuse accounts
 * without a second factor. Returns the reason to show, or null when confirmed.
 */
export async function reauthenticate(
  core: ReturnType<typeof getCore>,
  session: { userId: string; email: string },
  fd: FormData,
  options: { purpose: ReauthPurpose; bind: string; requireTwoFactor: boolean },
): Promise<ReauthError | null> {
  const password = fd.get('password');
  // Unknown / inactive / locked accounts and wrong passwords all answer "invalid".
  const check = await checkAdminPassword(
    core,
    session.email,
    typeof password === 'string' ? password : '',
    await clientIp(),
  );
  if (check.status !== 'ok' || check.userId !== session.userId) return 'password';
  if (options.requireTwoFactor && !check.twoFactor) return 'twoFactorSetupRequired';
  if (check.twoFactor) {
    // Either a fresh passkey assertion (challenge bound to this action, single use) or a
    // TOTP / recovery code.
    const passkeyResponse = text(fd, 'passkeyResponse');
    const code = text(fd, 'code');
    if (passkeyResponse) {
      let response: unknown;
      try {
        response = JSON.parse(passkeyResponse);
      } catch (err) {
        logger.warn({ err }, '[admin] passkey response JSON invalid');
        return 'passkeyInvalid';
      }
      const ip = await clientIp();
      try {
        const { userId } = await verifyPasskeyAuthentication(core, {
          purpose: options.purpose,
          challengeId: text(fd, 'passkeyChallengeId'),
          response,
          bind: options.bind,
          expectedUserId: session.userId,
          ipAddress: ip === '0.0.0.0' ? null : ip,
        });
        if (userId !== session.userId) return 'passkeyInvalid';
      } catch (err) {
        if (err instanceof DomainError) {
          return err.code === 'ACCOUNT_LOCKED' ? 'locked' : 'passkeyInvalid';
        }
        throw err;
      }
    } else {
      if (!code) return 'twoFactorRequired';
      try {
        await verifyAdminSecondFactor(core, session.userId, code);
      } catch (err) {
        if (err instanceof DomainError) {
          return err.code === 'ACCOUNT_LOCKED' ? 'locked' : 'twoFactorInvalid';
        }
        throw err;
      }
    }
  }
  return null;
}
