import { describe, expect, it } from 'vitest';
import {
  addPaymentDays,
  buildPaymentReference,
  checkoutInputSchema,
  endOfDayInZone,
  extractPaymentReferences,
  germanHolidays,
  isValidLuhn,
  luhnCheckDigit,
} from '../src';

describe('payment reference', () => {
  it('builds references with a Luhn check digit', () => {
    expect(luhnCheckDigit('7992739871')).toBe(3); // classic Luhn example
    const ref = buildPaymentReference('TIX', 2026, '8492');
    expect(ref).toMatch(/^TIX-2026-8492-\d$/);
    expect(isValidLuhn(ref.replace(/\D/g, ''))).toBe(true);
  });

  it('finds references in sloppy transfer texts', () => {
    const ref = buildPaymentReference('TIX', 2026, '8492');
    const check = ref.slice(-1);
    for (const text of [
      `Tickets ${ref} Danke`,
      `tix 2026 8492 ${check}`,
      `TIX2026-8492${check}`,
      `TIX-2O26-8492-${check}`, // letter O instead of zero
      `TIX - 2026 / 8492 - ${check} Mustermann`,
    ]) {
      const [first] = extractPaymentReferences(text, ['TIX']);
      expect(first, text).toEqual({ reference: ref, checksumValid: true });
    }
    const wrong = `TIX-2026-8492-${(Number(check) + 1) % 10}`;
    expect(extractPaymentReferences(wrong, ['TIX'])[0]?.checksumValid).toBe(false);
    expect(extractPaymentReferences('no reference here', ['TIX'])).toEqual([]);
    const long = buildPaymentReference('TIX', 2026, '849201');
    expect(extractPaymentReferences(long, ['TIX'])[0]?.reference).toBe(long);
  });
});

describe('business days', () => {
  it('knows nationwide and regional holidays', () => {
    const nationwide = germanHolidays(2026);
    expect(nationwide.has('2026-04-03')).toBe(true); // Good Friday 2026
    expect(nationwide.has('2026-05-14')).toBe(true); // Ascension 2026
    expect(nationwide.has('2026-06-04')).toBe(false); // Corpus Christi only regional
    expect(germanHolidays(2026, 'HE').has('2026-06-04')).toBe(true);
    expect(germanHolidays(2026, 'SN').has('2026-11-18')).toBe(true); // Buß- und Bettag
  });

  it('adds business days skipping weekends and holidays', () => {
    // Thu 2026-04-02 + 2 business days: Fri 3rd Good Friday, Mon 6th Easter Monday → Tue 7th, Wed 8th
    const thu = new Date('2026-04-02T10:00:00+02:00');
    expect(addPaymentDays(thu, 2, { businessDaysOnly: true })).toBe('2026-04-08');
    expect(addPaymentDays(thu, 2, { businessDaysOnly: false })).toBe('2026-04-04');
    expect(endOfDayInZone('2026-04-08').toISOString()).toBe('2026-04-08T21:59:59.999Z');
  });
});

describe('checkout input', () => {
  const base = {
    method: 'BANK_TRANSFER',
    firstName: ' Erika ',
    lastName: 'Example',
    acceptTerms: true,
    expectedTotalGross: 3150,
    locale: 'de',
  };

  it('normalises the e-mail address and empty optional fields', () => {
    const parsed = checkoutInputSchema.parse({
      ...base,
      email: '  Erika@Example.ORG ',
      company: '   ',
      phone: '',
    });
    expect(parsed.email).toBe('erika@example.org');
    expect(parsed.firstName).toBe('Erika');
    expect(parsed.company).toBeUndefined();
    expect(parsed.phone).toBeUndefined();
  });

  it('validates the phone number', () => {
    const parse = (phone: string) =>
      checkoutInputSchema.safeParse({ ...base, email: 'a@example.org', phone });
    expect(parse(' +49 (6134) 12-34/56 ').success).toBe(true);
    expect(parse('1234').success).toBe(false);
    expect(parse('call me maybe').success).toBe(false);
    expect(parse('1'.repeat(51)).success).toBe(false);
    expect(parse('   ').success).toBe(true);
  });

  it('rejects invalid e-mails, unknown methods and negative totals', () => {
    expect(checkoutInputSchema.safeParse({ ...base, email: 'nope' }).success).toBe(false);
    expect(
      checkoutInputSchema.safeParse({ ...base, email: 'a@example.org', method: 'CASH' }).success,
    ).toBe(false);
    expect(
      checkoutInputSchema.safeParse({ ...base, email: 'a@example.org', expectedTotalGross: -1 })
        .success,
    ).toBe(false);
  });
});
