/**
 * Payment references (Verwendungszweck) for bank transfers: `PREFIX-YYYY-NNNN-C`, e.g.
 * `TIX-2026-8492-7`. The last digit is a Luhn (mod 10) check digit over `YYYY` + `NNNN`,
 * so typos in the transfer text are detected before an order is auto-matched.
 */

/** Luhn check digit for a string of digits. */
export function luhnCheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new Error('luhnCheckDigit expects digits only');
  let sum = 0;
  // Double every second digit starting with the right-most digit (it gets the check digit appended).
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidLuhn(digitsWithCheck: string): boolean {
  if (!/^\d{2,}$/.test(digitsWithCheck)) return false;
  return luhnCheckDigit(digitsWithCheck.slice(0, -1)) === Number(digitsWithCheck.slice(-1));
}

/** Builds a reference from prefix, year and the random/sequential number part. */
export function buildPaymentReference(prefix: string, year: number, number: string): string {
  if (!/^[A-Z]{2,6}$/.test(prefix)) throw new Error('Invalid payment reference prefix');
  if (!/^\d{4,10}$/.test(number)) throw new Error('Invalid payment reference number');
  const yyyy = String(year).padStart(4, '0');
  return `${prefix}-${yyyy}-${number}-${luhnCheckDigit(`${yyyy}${number}`)}`;
}

export interface ParsedPaymentReference {
  /** Canonical form `PREFIX-YYYY-NNNN-C`. */
  reference: string;
  /** Luhn check digit matches. */
  checksumValid: boolean;
}

/** Characters commonly confused with digits in bank transfer texts. */
const DIGIT_LOOKALIKES: Record<string, string> = {
  O: '0',
  Q: '0',
  D: '0',
  I: '1',
  L: '1',
  S: '5',
  B: '8',
  Z: '2',
};
const SEPARATOR = '[\\s\\-_./:]*';
const DIGITISH = '[0-9OQDILSBZ]';

/** Digits of the number part of generated references (`PREFIX-YYYY-NNNNNN-C`). */
export const PAYMENT_REFERENCE_NUMBER_DIGITS = 6;

/**
 * Finds payment references in free text (remittance information). Tolerant of lower case,
 * missing or different separators, spaces / line breaks and letters typed instead of digits
 * (O→0, I→1 …). Only references with one of the given prefixes are returned; duplicates
 * removed, valid checksums first.
 *
 * Rules:
 * - Token boundaries: a check digit typed as a look-alike LETTER only counts when no letter or
 *   digit follows it (otherwise it starts the next word / id, e.g. `…5 OL-99`, `…5Danke`); a real
 *   check digit must not be followed by another digit (a long digit string is no reference).
 * - A separator typed between year and number: only the LONGEST syntactic split is taken, valid
 *   or not. A mistyped extra digit (`TIX-2026-3689638-8`) must never turn into the valid reference
 *   of ANOTHER order (`TIX-2026-368963-8`); it stays invalid and goes to review.
 * - Year and number typed together (`TIX2026NNNNNNC …`): the generated form (6-digit number) is
 *   tried first; when it is not valid, the other splits are tried (longest first) and one with a
 *   valid check digit wins. Exception: when a LONGER split (7-10 digits) has a check digit that
 *   stands apart (`TIX2026NNNNNNN C`), nothing is re-split: it cannot be told from a mistyped extra
 *   digit, so only that longer split is returned (a review case, never another order's reference). The split as typed (generated form, else longest) is then also returned
 *   as an INVALID entry, so what the payer typed stays visible (extracted reference, near-miss hints).
 */
export function extractPaymentReferences(
  text: string | null | undefined,
  prefixes: readonly string[],
): ParsedPaymentReference[] {
  if (!text || prefixes.length === 0) return [];
  const haystack = text.toUpperCase();
  const prefixPattern = prefixes
    .filter((p) => /^[A-Z]{2,6}$/.test(p))
    .map((p) => p.split('').join('\\s*'))
    .join('|');
  if (!prefixPattern) return [];
  const prefixRe = new RegExp(prefixPattern, 'g');
  const headRe = new RegExp(`${SEPARATOR}(${DIGITISH}{4})(${SEPARATOR})`, 'y');
  const tailRes = new Map<number, RegExp>();
  for (let n = 4; n <= 10; n += 1) {
    tailRes.set(
      n,
      new RegExp(`(${DIGITISH}{${n}})${SEPARATOR}([0-9](?![0-9])|[OQDILSBZ](?![0-9A-Z]))`, 'y'),
    );
  }
  const longestFirst = [10, 9, 8, 7, 6, 5, 4];
  const toDigits = (s: string) => s.replace(/[OQDILSBZ]/g, (c) => DIGIT_LOOKALIKES[c] ?? c);
  const found = new Map<string, ParsedPaymentReference>();
  let from = 0;
  while (from <= haystack.length) {
    prefixRe.lastIndex = from;
    const start = prefixRe.exec(haystack);
    if (!start) break;
    const prefix = start[0].replace(/\s+/g, '');
    headRe.lastIndex = start.index + start[0].length;
    const head = headRe.exec(haystack);
    const split = (n: number) => {
      if (!head) return null;
      const tail = tailRes.get(n)!;
      tail.lastIndex = headRe.lastIndex;
      const m = tail.exec(haystack);
      if (!m) return null;
      const year = toDigits(head[1]!);
      const number = toDigits(m[1]!);
      const check = toDigits(m[2]!);
      return {
        parsed: {
          reference: `${prefix}-${year}-${number}-${check}`,
          checksumValid: isValidLuhn(`${year}${number}${check}`),
        },
        end: headRe.lastIndex + m[0].length,
        /** The check digit stands apart from the number (separator / white space between). */
        externalCheck: m[0].length > m[1]!.length + m[2]!.length,
      };
    };
    let keep: { parsed: ParsedPaymentReference; end: number }[] = [];
    const longerSplits = longestFirst.filter((n) => n > PAYMENT_REFERENCE_NUMBER_DIGITS);
    if (head) {
      const longest = longestFirst.map(split).find((c) => c !== null) ?? null;
      if (longest && head[2]!.length > 0) {
        keep = [longest];
      } else if (longest) {
        const generated = split(PAYMENT_REFERENCE_NUMBER_DIGITS);
        const longerWithExternalCheck = longerSplits
          .map(split)
          .some((c) => c !== null && c.externalCheck);
        if (longerWithExternalCheck) {
          // `TIX2026NNNNNNN C`: indistinguishable from a mistyped extra digit, never re-split.
          keep = [longest];
        } else if (generated?.parsed.checksumValid) {
          keep = longest.parsed.checksumValid ? [generated] : [generated, longest];
        } else {
          const retry = longestFirst.map(split).find((c) => c?.parsed.checksumValid) ?? null;
          // What the payer typed: the generated split, else the longest one (both invalid here).
          const typed = [generated, longest].find((c) => c && !c.parsed.checksumValid) ?? null;
          keep = retry ? (typed ? [retry, typed] : [retry]) : [longest];
        }
      }
    }
    if (keep.length > 0) {
      for (const c of keep)
        if (!found.has(c.parsed.reference)) found.set(c.parsed.reference, c.parsed);
      from = Math.max(...keep.map((c) => c.end));
    } else {
      from = start.index + 1;
    }
  }
  return [...found.values()].sort((a, b) => Number(b.checksumValid) - Number(a.checksumValid));
}
