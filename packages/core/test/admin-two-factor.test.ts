import { describe, expect, it } from 'vitest';
import {
  canRemoveSecondFactor,
  hasSecondFactor,
  isTwoFactorRequired,
  resolveRelyingParty,
  twoFactorSetupRequired,
} from '../src';

const off = { requireTwoFactor: false, requireTwoFactorForSuperAdmins: false };
const all = { requireTwoFactor: true, requireTwoFactorForSuperAdmins: false };
const supers = { requireTwoFactor: false, requireTwoFactorForSuperAdmins: true };
const none = { hasTotp: false, passkeyCount: 0 };

describe('two-factor policy', () => {
  it('counts an authenticator app or a passkey as a second factor', () => {
    expect(hasSecondFactor(none)).toBe(false);
    expect(hasSecondFactor({ hasTotp: true, passkeyCount: 0 })).toBe(true);
    expect(hasSecondFactor({ hasTotp: false, passkeyCount: 1 })).toBe(true);
  });

  it('requires 2FA for everyone, only for super admins, or for nobody', () => {
    expect(isTwoFactorRequired(off, ['SUPER_ADMIN'])).toBe(false);
    expect(isTwoFactorRequired(all, ['EVENT_MANAGER'])).toBe(true);
    expect(isTwoFactorRequired(supers, ['SUPER_ADMIN'])).toBe(true);
    expect(isTwoFactorRequired(supers, ['EVENT_MANAGER', 'SUPER_ADMIN'])).toBe(true);
    expect(isTwoFactorRequired(supers, ['EVENT_MANAGER', 'FINANCE'])).toBe(false);
  });

  it('demands setup only while the policy applies and no factor exists', () => {
    expect(twoFactorSetupRequired(none, ['SUPER_ADMIN'], supers)).toBe(true);
    expect(twoFactorSetupRequired(none, ['FINANCE'], supers)).toBe(false);
    expect(
      twoFactorSetupRequired({ hasTotp: false, passkeyCount: 1 }, ['SUPER_ADMIN'], supers),
    ).toBe(false);
    expect(
      twoFactorSetupRequired({ hasTotp: true, passkeyCount: 0 }, ['SUPER_ADMIN'], supers),
    ).toBe(false);
    expect(twoFactorSetupRequired(none, ['DOOR_STAFF'], all)).toBe(true);
    expect(twoFactorSetupRequired(none, ['SUPER_ADMIN'], off)).toBe(false);
  });

  it('refuses to remove the last factor only when 2FA is required for the user', () => {
    expect(canRemoveSecondFactor(none, ['SUPER_ADMIN'], supers)).toBe(false);
    expect(canRemoveSecondFactor(none, ['FINANCE'], supers)).toBe(true);
    expect(canRemoveSecondFactor(none, ['FINANCE'], all)).toBe(false);
    expect(canRemoveSecondFactor(none, ['SUPER_ADMIN'], off)).toBe(true);
    expect(canRemoveSecondFactor({ hasTotp: true, passkeyCount: 0 }, ['SUPER_ADMIN'], all)).toBe(
      true,
    );
    expect(canRemoveSecondFactor({ hasTotp: false, passkeyCount: 1 }, ['SUPER_ADMIN'], all)).toBe(
      true,
    );
  });
});

describe('relying party', () => {
  it('derives rp id and the single allowed origin from the public URL', () => {
    expect(resolveRelyingParty('https://shop.example.org')).toEqual({
      rpID: 'shop.example.org',
      origin: 'https://shop.example.org',
    });
    expect(resolveRelyingParty('https://shop.example.org:8443/base')).toEqual({
      rpID: 'shop.example.org',
      origin: 'https://shop.example.org:8443',
    });
    expect(resolveRelyingParty('http://localhost:8080')).toEqual({
      rpID: 'localhost',
      origin: 'http://localhost:8080',
    });
  });

  it('is unavailable for IP addresses, plain http hosts and garbage', () => {
    expect(resolveRelyingParty(undefined)).toBeNull();
    expect(resolveRelyingParty('not a url')).toBeNull();
    expect(resolveRelyingParty('https://192.168.1.20')).toBeNull();
    expect(resolveRelyingParty('https://[::1]:8443')).toBeNull();
    expect(resolveRelyingParty('http://shop.example.org')).toBeNull();
  });
});
