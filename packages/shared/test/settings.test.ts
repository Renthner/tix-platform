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

  it('requires a {SEQ} token in number patterns', () => {
    expect(() => parseSetting('invoicing', { invoiceNumberPattern: 'RE-{YYYY}' })).toThrow(/SEQ/);
    expect(
      parseSetting('invoicing', { invoiceNumberPattern: 'R{YY}-{SEQ:5}' }).invoiceNumberPattern,
    ).toBe('R{YY}-{SEQ:5}');
  });
});
