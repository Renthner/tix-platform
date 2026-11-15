import { describe, expect, it } from 'vitest';
import { REDACTED, parseAuditDate, redactAuditValue } from '../src';

describe('redactAuditValue', () => {
  it('masks secret-looking keys at any depth and leaves the rest', () => {
    const out = redactAuditValue({
      before: { smtpPassword: 'a', host: 'h' },
      after: [{ apiKey: 'k', accessToken: 't', client_secret: 's', name: 'n' }],
      n: 3,
      nothing: null,
    });
    expect(out).toEqual({
      before: { smtpPassword: REDACTED, host: 'h' },
      after: [{ apiKey: REDACTED, accessToken: REDACTED, client_secret: REDACTED, name: 'n' }],
      n: 3,
      nothing: null,
    });
  });
  it('masks camelCase keys that contain pin / tan / otp / recovery / iban as words', () => {
    const out = redactAuditValue({
      fintsPin: '1',
      pinCode: '2',
      tanMedium: '3',
      otp_code: '4',
      recoveryCodes: ['5'],
      payerIban: 'DE00',
      spinner: 'ok',
      distance: 'ok',
    });
    expect(out).toEqual({
      fintsPin: REDACTED,
      pinCode: REDACTED,
      tanMedium: REDACTED,
      otp_code: REDACTED,
      recoveryCodes: REDACTED,
      payerIban: REDACTED,
      spinner: 'ok',
      distance: 'ok',
    });
  });
  it('does not mutate the input', () => {
    const input = { password: 'x' };
    redactAuditValue(input);
    expect(input.password).toBe('x');
  });
});

describe('parseAuditDate', () => {
  it('accepts YYYY-MM-DD only', () => {
    expect(parseAuditDate('2026-11-15')?.toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(parseAuditDate('15.11.2026')).toBeUndefined();
    expect(parseAuditDate('2026-13-45')).toBeUndefined();
    expect(parseAuditDate(undefined)).toBeUndefined();
  });
});
