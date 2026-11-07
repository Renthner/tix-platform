/**
 * IBAN / BIC helpers (ISO 13616 / ISO 9362). Pure functions, usable in browser and server.
 * Validation = country-specific length (SEPA + common non-SEPA countries) + mod-97 checksum.
 */

/** IBAN lengths per country (ISO 13616 registry, SEPA area and frequent neighbours). */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24,
  AE: 23,
  AT: 20,
  BA: 20,
  BE: 16,
  BG: 22,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  EE: 20,
  ES: 24,
  FI: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IS: 26,
  IT: 27,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  ME: 22,
  MK: 19,
  MT: 31,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  RO: 24,
  RS: 22,
  SA: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  TR: 26,
  UA: 29,
  VA: 22,
  XK: 20,
};

/** Upper case, without spaces, hyphens and dots (as typed or printed in groups of four). */
export function normalizeIban(input: string): string {
  return input.toUpperCase().replace(/[\s\-.]/g, '');
}

function mod97(value: string): number {
  let remainder = 0;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder;
}

/** Validates format, country length (when known) and the mod-97 check digits. */
export function isValidIban(input: string): boolean {
  const iban = normalizeIban(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expected !== undefined && iban.length !== expected) return false;
  return mod97(iban.slice(4) + iban.slice(0, 4)) === 1;
}

/** Printable form in groups of four: `DE89 3704 0044 0532 0130 00`. */
export function formatIban(input: string): string {
  return normalizeIban(input)
    .replace(/(.{4})/g, '$1 ')
    .trim();
}

/** Masked form for lists: `DE89 •••• •••• •••• 3000`. */
export function maskIban(input: string): string {
  const iban = normalizeIban(input);
  if (iban.length < 8) return iban;
  return `${iban.slice(0, 4)} •••• ${iban.slice(-4)}`;
}

export function normalizeBic(input: string): string {
  return input.toUpperCase().replace(/\s/g, '');
}

/** ISO 9362: 4 bank + 2 country + 2 location (+ 3 branch) characters. */
export function isValidBic(input: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(normalizeBic(input));
}

/** National bank code and account number embedded in a German IBAN (else null). */
export function germanAccountFromIban(
  input: string,
): { bankCode: string; accountNumber: string } | null {
  const iban = normalizeIban(input);
  if (!/^DE\d{20}$/.test(iban)) return null;
  return { bankCode: iban.slice(4, 12), accountNumber: iban.slice(12) };
}

/**
 * True when an account identifier from a statement file (IBAN, or `BLZ/account` as used in
 * MT940 field :25:) designates the given IBAN. Unknown formats return true (no evidence).
 */
export function accountIdentifierMatchesIban(identifier: string, iban: string): boolean {
  const target = normalizeIban(iban);
  const raw = identifier.trim().toUpperCase();
  const compact = normalizeIban(raw);
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact) && isValidIban(compact)) {
    return compact === target;
  }
  const national = /^(\d{8})\/(\d{1,10})/.exec(raw.replace(/\s/g, ''));
  if (national) {
    const de = germanAccountFromIban(target);
    if (!de) return true;
    return (
      national[1] === de.bankCode &&
      national[2]!.replace(/^0+/, '') === de.accountNumber.replace(/^0+/, '')
    );
  }
  return true;
}
