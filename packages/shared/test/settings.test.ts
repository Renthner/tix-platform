import { describe, expect, it } from 'vitest';
import { PUBLIC_SETTING_KEYS, SETTINGS, defaultSetting, parseSetting } from '../src';

describe('settings registry', () => {
  it('every non-secret setting has a complete, valid default', () => {
    for (const key of PUBLIC_SETTING_KEYS) {
      expect(() => defaultSetting(key), key).not.toThrow();
    }
  });

  it('secret settings have no defaults', () => {
    expect(SETTINGS['smtp.credentials'].secret).toBe(true);
    expect(() => defaultSetting('smtp.credentials')).toThrow(/secret/);
  });

  it('enforces cross-field rules for Vorkasse dunning', () => {
    expect(() =>
      parseSetting('bankTransfer', {
        paymentTermDays: 10,
        cancelAfterDays: 5,
        reminderAfterDays: 3,
      }),
    ).toThrow(/cancelAfterDays/);
    expect(() =>
      parseSetting('bankTransfer', {
        paymentTermDays: 5,
        cancelAfterDays: 8,
        reminderAfterDays: 8,
      }),
    ).toThrow(/reminderAfterDays/);
  });

  it('allows no automatic cancellation (null) and keeps legacy settings parseable', () => {
    const none = parseSetting('bankTransfer', {
      paymentTermDays: 10,
      reminderAfterDays: 9,
      cancelAfterDays: null,
    });
    expect(none.cancelAfterDays).toBeNull();
    expect(
      parseSetting('bankTransfer', { paymentTermDays: 5, cancelAfterDays: 8 }).cancelAfterDays,
    ).toBe(8);
    // Stored settings without the key fall back to the default.
    expect(parseSetting('bankTransfer', {}).cancelAfterDays).toBe(8);
    expect(() => parseSetting('bankTransfer', { cancelAfterDays: 0 })).toThrow();
  });

  it('requires a {SEQ} token in number patterns', () => {
    expect(() => parseSetting('invoicing', { invoiceNumberPattern: 'RE-{YYYY}' })).toThrow(/SEQ/);
    expect(
      parseSetting('invoicing', { invoiceNumberPattern: 'R{YY}-{SEQ:5}' }).invoiceNumberPattern,
    ).toBe('R{YY}-{SEQ:5}');
  });

  it('applies the admin security defaults to stored rows without the new fields', () => {
    const stored = parseSetting('security', {
      adminSessionTtlHours: 8,
      maxFailedLogins: 5,
      lockoutMinutes: 15,
    });
    expect(stored).toMatchObject({
      adminSessionTtlHours: 8,
      minPasswordLength: 12,
      requireTwoFactor: false,
      inviteTtlHours: 72,
      passwordResetTtlMinutes: 60,
    });
    expect(parseSetting('customerAccounts', {}).loginLinkTtlMinutes).toBe(60);
    expect(() => parseSetting('security', { minPasswordLength: 4 })).toThrow();
    expect(parseSetting('scanner', {})).toMatchObject({
      allowCheckOut: true,
      syncIntervalSeconds: 30,
    });
  });
});
