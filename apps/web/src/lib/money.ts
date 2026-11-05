/** Money helpers for admin forms: amounts are entered in major units, stored as cents. */

/** Parses "12", "12.5", "12,50", "1.234,50" or "1,234.50" into integer cents (null if invalid). */
export function parseMoneyToCents(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  let s = input.trim().replace(/\s| /g, '');
  if (s === '') return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // the later separator is the decimal separator
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = s.replace(',', '.');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, fraction = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= 2_000_000_000 ? cents : null;
}

/** Integer cents → "12.50" for input fields. */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2);
}

export function formatMoney(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

/** "7.5" (percent) → 750 basis points; null if invalid or outside 0–100. */
export function parsePercentToBasisPoints(input: string | null | undefined): number | null {
  if (!input) return null;
  const s = input.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const bp = Math.round(Number(s) * 100);
  return bp >= 0 && bp <= 10_000 ? bp : null;
}

export function basisPointsToInput(bp: number | null | undefined): string {
  if (bp === null || bp === undefined) return '';
  return String(bp / 100);
}
