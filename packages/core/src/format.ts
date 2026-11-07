/**
 * Locale-aware formatting for generated documents (e-mails, invoices). Amounts are integer
 * cents, percentages basis points; dates are formatted in an explicit IANA time zone so the
 * output does not depend on the server's time zone.
 */

export function formatMoney(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

export function formatPercent(basisPoints: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(
    basisPoints / 10_000,
  );
}

/** Date only, e.g. "14. November 2026" / "November 14, 2026". */
export function formatDate(
  date: Date,
  locale: string,
  timeZone: string,
  style: 'long' | 'medium' = 'long',
): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: style, timeZone }).format(date);
}

/** Event date with weekday and time, e.g. "Saturday, 14 November 2026 at 19:30". */
export function formatDateTime(
  date: Date,
  locale: string,
  timeZone: string,
  dateStyle: 'full' | 'long' | 'medium' = 'full',
): string {
  return new Intl.DateTimeFormat(locale, { dateStyle, timeStyle: 'short', timeZone }).format(date);
}

export function formatTime(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone }).format(date);
}

/** Calendar year of a timestamp in a time zone. */
export function yearIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en', { year: 'numeric', timeZone }).format(date);
}

/** IBAN in groups of four for printing: DE89 3704 0044 0532 0130 00. */
export function formatIban(iban: string): string {
  return iban
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/(.{4})/g, '$1 ')
    .trim();
}
