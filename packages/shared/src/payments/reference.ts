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

/**
 * Finds payment references in free text (remittance information). Tolerant of lower case,
 * missing or different separators, spaces and letters typed instead of digits (O→0, I→1 …).
 * Only references with one of the given prefixes are returned; duplicates removed, valid
 * checksums first.
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
  const pattern = new RegExp(
    `(${prefixPattern})${SEPARATOR}(${DIGITISH}{4})${SEPARATOR}(${DIGITISH}{4,10})${SEPARATOR}(${DIGITISH})(?![0-9])`,
    'g',
  );
  const toDigits = (s: string) => s.replace(/[OQDILSBZ]/g, (c) => DIGIT_LOOKALIKES[c] ?? c);
  const found = new Map<string, ParsedPaymentReference>();
  for (const match of haystack.matchAll(pattern)) {
    const prefix = match[1]!.replace(/\s+/g, '');
    const year = toDigits(match[2]!);
    const number = toDigits(match[3]!);
    const check = toDigits(match[4]!);
    const reference = `${prefix}-${year}-${number}-${check}`;
    if (!found.has(reference))
      found.set(reference, { reference, checksumValid: isValidLuhn(`${year}${number}${check}`) });
  }
  return [...found.values()].sort((a, b) => Number(b.checksumValid) - Number(a.checksumValid));
}
