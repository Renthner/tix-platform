/**
 * Simple CSV for Excel (German locale): UTF-8 with BOM, `;` separator, decimal comma, CRLF.
 * Text cells starting with `= + - @` are prefixed with `'` (spreadsheet formula injection –
 * buyer names come from the public). Amounts are passed as `{ raw }` and stay untouched
 * (negative amounts start with `-`).
 */

export type CsvCell = string | number | null | undefined | { raw: string };

/** Euro amount from cents with decimal comma, no thousands separator: -1234 → "-12,34". */
export function formatCsvAmount(cents: number): { raw: string } {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return { raw: `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}` };
}

/** Percentage from basis points: 1900 → "19", 700 → "7", 550 → "5,5". */
export function formatCsvPercent(basisPoints: number): { raw: string } {
  return { raw: String(basisPoints / 100).replace('.', ',') };
}

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'object';
  let s = raw ? value.raw : String(value);
  if (!raw && typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(header: string[], rows: CsvCell[][]): string {
  const lines = [header.map((h) => csvCell({ raw: h })), ...rows.map((r) => r.map(csvCell))];
  return `﻿${lines.map((l) => l.join(';')).join('\r\n')}\r\n`;
}
