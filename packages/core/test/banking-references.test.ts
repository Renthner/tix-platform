import { buildPaymentReference, extractPaymentReferences } from '@tix/shared';
import { describe, expect, it } from 'vitest';
import { referenceDistance, transactionReferences } from '../src/banking/matching';

const ref = buildPaymentReference('TIX', 2026, '386416');
const bare = ref.replace(/-/g, '');
const valid = { reference: ref, checksumValid: true };
const prefixes = ['TIX'];

describe('transactionReferences', () => {
  it('reads a hyphen-less reference followed by any end-to-end id', () => {
    for (const letter of 'OQDILSBZ') {
      for (const endToEndId of [`${letter}4711000123`, `${letter}L-99`, 'NOTPROVIDED', null]) {
        const found = transactionReferences(
          { remittanceInformation: `${bare} Karten`, endToEndId },
          prefixes,
        );
        expect(found, `${letter} ${endToEndId}`).toEqual([valid]);
      }
    }
  });

  it('does not glue the remittance and the end-to-end id together', () => {
    // The reference ends the remittance text; the id starts with a look-alike letter.
    const found = transactionReferences(
      { remittanceInformation: bare, endToEndId: 'D4711000123' },
      prefixes,
    );
    expect(found).toEqual([valid]);
  });

  it('falls back to the end-to-end id alone when the remittance holds no valid reference', () => {
    expect(
      transactionReferences({ remittanceInformation: 'Tickets', endToEndId: ref }, prefixes),
    ).toEqual([valid]);
    const wrong = `TIX-2026-386416-${(Number(ref.slice(-1)) + 1) % 10}`;
    expect(
      transactionReferences({ remittanceInformation: wrong, endToEndId: ref }, prefixes)[0],
    ).toEqual(valid);
  });

  it('prefers the remittance when both hold a valid reference', () => {
    const other = buildPaymentReference('TIX', 2026, '772913');
    expect(
      transactionReferences({ remittanceInformation: ref, endToEndId: other }, prefixes),
    ).toEqual([valid]);
  });

  it('ignores a long digit string', () => {
    expect(
      transactionReferences(
        { remittanceInformation: 'TIX-2026-1234567890123', endToEndId: null },
        prefixes,
      ),
    ).toEqual([]);
  });

  it('a valid look-alike with another number length does not suppress the end-to-end id', () => {
    // Remittance 'TIX-2026-255428-0' is a typo (invalid); the end-to-end id holds the real one.
    const real = buildPaymentReference('TIX', 2026, '255428');
    const wrongCheck = `TIX-2026-255428-${(Number(real.slice(-1)) + 1) % 10}`;
    const found = transactionReferences(
      { remittanceInformation: wrongCheck, endToEndId: real },
      prefixes,
    );
    expect(found[0]).toEqual({ reference: real, checksumValid: true });
    // A valid look-alike with 7 digits in the remittance (retry of the tolerant parser) must not
    // block the fallback either.
    let checked = 0;
    for (let n = 100000; n < 100100 && checked < 3; n += 1) {
      for (let d = 0; d < 10 && checked < 3; d += 1) {
        const text = `TIX2026${n}${d} 2 Karten`;
        const parsed = transactionReferences(
          { remittanceInformation: text, endToEndId: null },
          prefixes,
        );
        if (!parsed.some((r) => r.checksumValid && !/^TIX-\d{4}-\d{6}-\d$/.test(r.reference)))
          continue;
        checked += 1;
        const found = transactionReferences(
          { remittanceInformation: text, endToEndId: real },
          prefixes,
        );
        expect(
          found.some((r) => r.reference === real && r.checksumValid),
          text,
        ).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('regression: remittance with a wrong check digit, end-to-end id with the reference', () => {
    // Used to be assigned via the concatenated text; must stay assignable.
    const real = buildPaymentReference('TIX', 2026, '255428');
    expect(real.slice(-1)).toBe('8');
    const found = transactionReferences(
      { remittanceInformation: 'TIX-2026-255428-0', endToEndId: 'TIX-2026-255428-8' },
      prefixes,
    );
    expect(found[0]).toEqual({ reference: 'TIX-2026-255428-8', checksumValid: true });
    expect(found.some((r) => !r.checksumValid && r.reference === 'TIX-2026-255428-0')).toBe(true);
  });

  it('an inserted digit leaves no valid reference and gives the real order a ONE_EDIT hint', () => {
    const real = buildPaymentReference('TIX', 2026, '368963');
    const [p, y, n, c] = real.split('-') as [string, string, string, string];
    for (const sep of ['-', '/', ' ']) {
      for (let i = 0; i <= 6; i += 1) {
        const typed = `${p}${sep}${y}${sep}${n.slice(0, i)}7${n.slice(i)}${sep}${c}`;
        const found = extractPaymentReferences(typed, prefixes);
        if (found.some((r) => r.checksumValid && /-\d{6}-/.test(r.reference))) {
          throw new Error(`phantom for ${typed}`);
        }
        expect(
          found.some((r) => referenceDistance(r.reference, real) === 'ONE_EDIT'),
          typed,
        ).toBe(true);
      }
    }
  });
});
