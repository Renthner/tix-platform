import { describe, expect, it } from 'vitest';
import {
  accountIdentifierMatchesIban,
  formatIban,
  germanAccountFromIban,
  isValidBic,
  isValidIban,
  maskIban,
  normalizeIban,
} from '../src/banking/iban';

describe('IBAN helpers', () => {
  it('normalises and validates (mod 97 + country length)', () => {
    expect(normalizeIban(' de89 3704-0044 0532.0130 00 ')).toBe('DE89370400440532013000');
    expect(isValidIban('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(isValidIban('DE89370400440532013001')).toBe(false); // checksum
    expect(isValidIban('DE8937040044053201300')).toBe(false); // length for DE
    expect(isValidIban('GB82WEST12345698765432')).toBe(true);
    expect(isValidIban('XX00')).toBe(false);
  });

  it('formats and masks', () => {
    expect(formatIban('DE89370400440532013000')).toBe('DE89 3704 0044 0532 0130 00');
    expect(maskIban('DE89370400440532013000')).toBe('DE89 •••• 3000');
  });

  it('validates BICs', () => {
    expect(isValidBic('TESTDEFF')).toBe(true);
    expect(isValidBic('testdeffxxx')).toBe(true);
    expect(isValidBic('TEST1EFF')).toBe(false);
  });

  it('matches statement account identifiers against an IBAN', () => {
    const iban = 'DE89370400440532013000';
    expect(germanAccountFromIban(iban)).toEqual({
      bankCode: '37040044',
      accountNumber: '0532013000',
    });
    expect(accountIdentifierMatchesIban('DE89370400440532013000', iban)).toBe(true);
    expect(accountIdentifierMatchesIban('37040044/532013000', iban)).toBe(true);
    expect(accountIdentifierMatchesIban('37040044/0532013000EUR', iban)).toBe(true);
    expect(accountIdentifierMatchesIban('DE02120300000000202051', iban)).toBe(false);
    expect(accountIdentifierMatchesIban('12030000/202051', iban)).toBe(false);
    expect(accountIdentifierMatchesIban('Girokonto', iban)).toBe(true);
  });
});
