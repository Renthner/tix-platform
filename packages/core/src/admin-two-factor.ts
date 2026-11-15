import type { AdminRole } from '@tix/shared';

/**
 * Pure two-factor policy of the Admin Portal. A user holds a second factor when an authenticator
 * app (TOTP) is confirmed OR at least one passkey is registered (passkeys are always used with
 * user verification, so a passkey is a complete second factor on its own).
 */

export interface TwoFactorFacts {
  hasTotp: boolean;
  passkeyCount: number;
}

export interface TwoFactorPolicySettings {
  /** All admins must have a second factor. */
  requireTwoFactor: boolean;
  /** Users with the SUPER_ADMIN role must have a second factor. */
  requireTwoFactorForSuperAdmins: boolean;
}

export const hasSecondFactor = (facts: TwoFactorFacts): boolean =>
  facts.hasTotp || facts.passkeyCount > 0;

/** True when the security settings demand a second factor from a user with these roles. */
export function isTwoFactorRequired(
  settings: TwoFactorPolicySettings,
  roles: readonly AdminRole[],
): boolean {
  return (
    settings.requireTwoFactor ||
    (settings.requireTwoFactorForSuperAdmins && roles.includes('SUPER_ADMIN'))
  );
}

/** The user must be sent to the setup (account page) before anything else is reachable. */
export function twoFactorSetupRequired(
  facts: TwoFactorFacts,
  roles: readonly AdminRole[],
  settings: TwoFactorPolicySettings,
): boolean {
  return isTwoFactorRequired(settings, roles) && !hasSecondFactor(facts);
}

/**
 * Whether the user may drop a second factor: the facts AFTER the removal must still satisfy the
 * policy. (Every admin keeps a password, so "locked out" in practice means "the required second
 * factor would be missing".)
 */
export function canRemoveSecondFactor(
  after: TwoFactorFacts,
  roles: readonly AdminRole[],
  settings: TwoFactorPolicySettings,
): boolean {
  return !twoFactorSetupRequired(after, roles, settings);
}
