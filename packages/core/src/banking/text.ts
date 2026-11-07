/**
 * Text, money and date helpers shared by the statement parsers.
 */

export type TextEncoding = 'auto' | 'utf-8' | 'windows-1252' | 'iso-8859-1';

/**
 * Decodes statement bytes. `auto`: BOM → UTF-8 / UTF-16; valid UTF-8 → UTF-8; otherwise
 * Windows-1252 (superset of ISO-8859-1 used by German online-banking exports).
 */
export function decodeText(bytes: Uint8Array, encoding: TextEncoding = 'auto'): string {
  if (encoding !== 'auto') {
    return new TextDecoder(encoding === 'iso-8859-1' ? 'windows-1252' : encoding).decode(bytes);
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Collapses whitespace; empty → null. */
export function cleanText(value: string | null | undefined, maxLength = 2000): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  return cleaned === '' ? null : cleaned.slice(0, maxLength);
}

/**
 * Parses a decimal amount string into integer cents without floating point arithmetic.
 * Accepts `1234.56`, `1.234,56`, `-1 234,56 €`, `+12,5`, `12,` (MT940). Returns null when
 * the string is not a number.
 */
export function parseAmountToCents(
  input: string,
  decimalSeparator: 'auto' | ',' | '.' = 'auto',
): number | null {
  let s = input.replace(/[\s '€$£]|EUR|CHF|USD|GBP/gi, '');
  if (s === '') return null;
  let negative = false;
  if (s.startsWith('-') || s.startsWith('−')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  let sep = decimalSeparator;
  if (sep === 'auto') {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma === -1 && lastDot === -1) sep = '.';
    else if (lastComma > lastDot) {
      // "1.234,56" or "12,5" → comma decimal; "1,234" (3 digits, no dot) is ambiguous –
      // statement exports with a comma are German, so treat it as decimal comma.
      sep = ',';
    } else {
      // "1,234.56" or "12.50"; "1.234" alone (3 digits after dot, comma absent) is treated
      // as thousands separator only if more than one dot exists.
      const parts = s.split('.');
      sep = parts.length > 2 ? ',' : '.';
    }
  }
  const thousands = sep === ',' ? '.' : ',';
  s = s.split(thousands).join('');
  const [intPart, fracPart = '', ...rest] = s.split(sep);
  if (rest.length > 0) return null;
  if (!/^\d*$/.test(intPart ?? '') || !/^\d*$/.test(fracPart)) return null;
  if ((intPart ?? '') === '' && fracPart === '') return null;
  if (fracPart.length > 2 && !/^0+$/.test(fracPart.slice(2))) return null;
  const cents = Number(intPart || '0') * 100 + Number((fracPart + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

const pad = (n: number) => String(n).padStart(2, '0');

function validDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Two-digit years: 00–79 → 20xx, 80–99 → 19xx. */
export function expandYear(yy: number): number {
  return yy < 80 ? 2000 + yy : 1900 + yy;
}

export type DateFormat =
  'auto' | 'dd.MM.yyyy' | 'dd.MM.yy' | 'yyyy-MM-dd' | 'dd/MM/yyyy' | 'MM/dd/yyyy';

/** Parses a date string into ISO `YYYY-MM-DD`; null when invalid. */
export function parseDate(input: string, format: DateFormat = 'auto'): string | null {
  const s = input.trim();
  let m: RegExpExecArray | null;
  if (format === 'auto' || format === 'yyyy-MM-dd') {
    m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
    if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (format === 'yyyy-MM-dd') return null;
  }
  if (format === 'MM/dd/yyyy') {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    return m ? validDate(Number(m[3]), Number(m[1]), Number(m[2])) : null;
  }
  if (format === 'dd/MM/yyyy') {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    return m ? validDate(Number(m[3]), Number(m[2]), Number(m[1])) : null;
  }
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(s);
  if (m) {
    if (format === 'dd.MM.yyyy' && m[3]!.length !== 4) return null;
    if (format === 'dd.MM.yy' && m[3]!.length !== 2) return null;
    const year = m[3]!.length === 2 ? expandYear(Number(m[3])) : Number(m[3]);
    return validDate(year, Number(m[2]), Number(m[1]));
  }
  if (format === 'auto') {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return validDate(Number(m[3]), Number(m[2]), Number(m[1]));
    m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  return null;
}

export function isoDate(y: number, m: number, d: number): string | null {
  return validDate(y, m, d);
}

/** Today's calendar date (ISO) in a time zone. */
export function todayIso(timeZone = 'Europe/Berlin', now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
