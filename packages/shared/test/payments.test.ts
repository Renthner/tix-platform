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
  describe('token boundaries', () => {
    const ref = buildPaymentReference('TIX', 2026, '386416');
    const check = ref.slice(-1);
    const bare = ref.replace(/-/g, '');
    const spaced = `TIX 2026 386416 ${check}`;
    const valid = { reference: ref, checksumValid: true };

    it('is not fooled by a following id starting with a look-alike letter', () => {
      for (const letter of 'OQDILSBZ') {
        for (const base of [bare, bare.toLowerCase(), spaced, ref]) {
          for (const id of [`${letter}4711000123`, `${letter}${letter}-99`, `${letter}123`]) {
            expect(extractPaymentReferences(`${base} ${id}`, ['TIX'])[0], `${base} ${id}`).toEqual(
              valid,
            );
          }
        }
      }
      expect(extractPaymentReferences(`${bare} NOTPROVIDED`, ['TIX'])[0]).toEqual(valid);
    });

    it('is not fooled by following words or digits', () => {
      for (const tail of [' weitere Worte', 'Danke', ' Dank', 'Lieben Gruss', ' 12345', ' 4711']) {
        expect(extractPaymentReferences(`${bare}${tail}`, ['TIX'])[0], tail).toEqual(valid);
      }
    });

    it('finds two references in one text', () => {
      const other = buildPaymentReference('TIX', 2026, '772913');
      const found = extractPaymentReferences(`${bare} und ${other.replace(/-/g, ' ')}`, ['TIX']);
      expect(found.map((f) => f.reference).sort()).toEqual([ref, other].sort());
      expect(found.every((f) => f.checksumValid)).toBe(true);
    });

    it('reads a reference split by line breaks (MT940 continuation lines)', () => {
      const [a, b] = [`TIX-2026-`, `386416-${check}`];
      expect(
        extractPaymentReferences(
          `Tickets ${a}
${b}
Danke`,
          ['TIX'],
        )[0],
      ).toEqual(valid);
      expect(
        extractPaymentReferences(
          `TIX 2026

386416

${check}`,
          ['TIX'],
        )[0],
      ).toEqual(valid);
    });

    it('does not match a long digit string', () => {
      expect(extractPaymentReferences('TIX-2026-1234567890123', ['TIX'])).toEqual([]);
      expect(extractPaymentReferences('TIX 2026 123456789012 34', ['TIX'])).toEqual([]);
    });

    it('keeps an invalid reference reported as invalid', () => {
      const good = buildPaymentReference('TIX', 2026, '255428');
      const [, , , goodCheck] = good.split('-');
      for (let d = 0; d < 10; d += 1) {
        if (String(d) === goodCheck) continue;
        const wrong = `TIX-2026-255428-${d}`;
        expect(extractPaymentReferences(wrong, ['TIX'])).toEqual([
          { reference: wrong, checksumValid: false },
        ]);
      }
    });

    it('never turns a mistyped extra digit into the valid reference of another order', () => {
      for (const [typed, other] of [
        ['TIX-2026-3689638-8', 'TIX-2026-368963-8'],
        ['TIX/2026/3439281/0', 'TIX-2026-343928-1'],
        ['TIX2026-6218484-9', 'TIX-2026-621848-4'],
        ['TIX-2026-4928415-8X', 'TIX-2026-492841-5'],
      ] as const) {
        const found = extractPaymentReferences(typed, ['TIX']);
        expect(
          found.filter((f) => f.checksumValid),
          typed,
        ).toEqual([]);
        expect(
          found.map((f) => f.reference),
          typed,
        ).not.toContain(other);
        expect(found[0]!.reference.split('-')[2]).toHaveLength(7);
      }
    });

    it('reads unseparated references with a trailing word or id correctly', () => {
      const r = buildPaymentReference('TIX', 2026, '689638');
      const c = r.slice(-1);
      for (const tail of ['Danke', ' OL-99', ' D4711', ' 12345', ' Karten']) {
        const found = extractPaymentReferences(`TIX2026689638${c}${tail}`, ['TIX']);
        expect(found[0], tail).toEqual({ reference: r, checksumValid: true });
        expect(found.filter((f) => f.checksumValid)).toHaveLength(1);
      }
      // classic spelling: check digit set apart, the digits before the gap are exactly 6
      for (const text of [
        `tix2026689638 ${c}`,
        `TIX2026689638 ${c} 2 Karten`,
        `TIX2026689638-${c}`,
      ]) {
        expect(extractPaymentReferences(text, ['TIX'])[0], text).toEqual({
          reference: r,
          checksumValid: true,
        });
      }
    });

    it('a 7-digit run with a set-apart check digit is never re-split (review case)', () => {
      // `TIX20268312426 2 Karten`: indistinguishable from a mistyped extra digit.
      for (const text of [
        'TIX20269831242 6',
        'TIX20269831242-6',
        'TIX20268312426 2 Karten',
        'TIX-20269831242 6',
      ]) {
        const found = extractPaymentReferences(text, ['TIX']);
        expect(
          found.filter((f) => f.checksumValid && /^TIX-\d{4}-\d{6}-\d$/.test(f.reference)),
          text,
        ).toEqual([]);
        expect(found[0]!.reference.split('-')[2], text).toHaveLength(7);
      }
    });

    it('bare reference: a valid generated split also reports a differing invalid longest', () => {
      const r = buildPaymentReference('TIX', 2026, '689638');
      const found = extractPaymentReferences(`TIX2026689638${r.slice(-1)}`, ['TIX']);
      expect(found).toEqual([{ reference: r, checksumValid: true }]);
    });

    it('fuzz: no valid 6-digit phantom after an inserted digit, plain spellings always found', () => {
      let seed = 4242;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      for (let k = 0; k < 2000; k += 1) {
        const number = String(100000 + Math.floor(rnd() * 900000));
        const r = buildPaymentReference('TIX', 2026, number);
        const [p, y, n, c] = r.split('-') as [string, string, string, string];
        for (const sep of ['-', ' ', '/', '.']) {
          const plain = `${p}${sep}${y}${sep}${n}${sep}${c}`;
          expect(extractPaymentReferences(plain, ['TIX'])[0], plain).toEqual({
            reference: r,
            checksumValid: true,
          });
          expect(extractPaymentReferences(plain.toLowerCase(), ['TIX'])[0]).toEqual({
            reference: r,
            checksumValid: true,
          });
          for (let i = 0; i <= 6; i += 1) {
            const d = Math.floor(rnd() * 10);
            const typed = `${p}${sep}${y}${sep}${n.slice(0, i)}${d}${n.slice(i)}${sep}${c}`;
            const phantoms = extractPaymentReferences(typed, ['TIX']).filter(
              (f) =>
                f.checksumValid && f.reference !== r && /^TIX-\d{4}-\d{6}-\d$/.test(f.reference),
            );
            expect(phantoms, typed).toEqual([]);
          }
        }
        const bare = `${p}${y}${n}${c}`;
        for (const tail of ['Danke', ' OL-99', ' D4711000123', ' 12345']) {
          const found = extractPaymentReferences(`${bare}${tail}`, ['TIX']);
          expect(found[0], bare + tail).toEqual({ reference: r, checksumValid: true });
        }
        // year and number typed together, check digit set apart / hyphenated, digit inserted
        for (const gap of [' ', '-', ' - ']) {
          expect(extractPaymentReferences(`${p}${y}${n}${gap}${c}`, ['TIX'])[0]).toEqual({
            reference: r,
            checksumValid: true,
          });
          for (let i = 0; i <= 6; i += 1) {
            const d = Math.floor(rnd() * 10);
            const typed = `${p}${y}${n.slice(0, i)}${d}${n.slice(i)}${gap}${c}`;
            const phantoms = extractPaymentReferences(typed, ['TIX']).filter(
              (f) =>
                f.checksumValid && f.reference !== r && /^TIX-\d{4}-\d{6}-\d$/.test(f.reference),
            );
            expect(phantoms, typed).toEqual([]);
          }
        }
      }
    });
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
