import { wallMs, wallToInstant } from '../zoned-time';

/**
 * Local-date arithmetic for accounting ranges. Dates are `YYYY-MM-DD` strings in the shop time
 * zone; ranges are inclusive and converted to half-open instants [from 00:00, to+1 00:00).
 */

export const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface LocalDate {
  y: number;
  m: number;
  d: number;
}

export function parseLocalDate(value: string): LocalDate | null {
  const match = LOCAL_DATE.exec(value);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])] as [
    number,
    number,
    number,
  ];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d)
    return null;
  return { y, m, d };
}

const pad = (n: number, l = 2) => String(n).padStart(l, '0');

export const formatLocalDate = ({ y, m, d }: LocalDate): string =>
  `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

/** `YYYYMMDD` as used in DATEV headers. */
export const compactDate = (value: string): string => value.replaceAll('-', '');

/** Local calendar date of an instant in `timeZone`. */
export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const wall = new Date(wallMs(instant, timeZone));
  return { y: wall.getUTCFullYear(), m: wall.getUTCMonth() + 1, d: wall.getUTCDate() };
}

export function addDays(value: string, days: number): string {
  const p = parseLocalDate(value)!;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return formatLocalDate({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}

/** Half-open instant range of the inclusive local dates `from`…`to`. */
export function instantRange(from: string, to: string, timeZone: string): { gte: Date; lt: Date } {
  const f = parseLocalDate(from)!;
  const t = parseLocalDate(to)!;
  return {
    gte: wallToInstant(Date.UTC(f.y, f.m - 1, f.d), timeZone),
    lt: wallToInstant(Date.UTC(t.y, t.m - 1, t.d + 1), timeZone),
  };
}

/** First day of the fiscal year that contains `date` (`fiscalYearStart` = "MM-DD"). */
export function fiscalYearStartOf(date: string, fiscalYearStart: string): string {
  const p = parseLocalDate(date)!;
  const thisYear = `${pad(p.y, 4)}-${fiscalYearStart}`;
  return date >= thisYear ? thisYear : `${pad(p.y - 1, 4)}-${fiscalYearStart}`;
}

/** Last day of the fiscal year that starts on `start`. */
export function fiscalYearEnd(start: string): string {
  const p = parseLocalDate(start)!;
  return addDays(`${pad(p.y + 1, 4)}-${pad(p.m)}-${pad(p.d)}`, -1);
}

export interface RangePresets {
  thisMonth: [string, string];
  lastMonth: [string, string];
  thisQuarter: [string, string];
  lastQuarter: [string, string];
  fiscalYear: [string, string];
  lastFiscalYear: [string, string];
}

/** Quick ranges relative to `today` (local date); the "year" presets follow the fiscal year. */
export function rangePresets(today: string, fiscalYearStart: string): RangePresets {
  const p = parseLocalDate(today)!;
  const monthRange = (y: number, m: number): [string, string] => {
    const first = new Date(Date.UTC(y, m - 1, 1));
    const last = new Date(Date.UTC(y, m, 0));
    const f = (t: Date) =>
      formatLocalDate({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
    return [f(first), f(last)];
  };
  const quarterStartMonth = (m: number) => Math.floor((m - 1) / 3) * 3 + 1;
  const qm = quarterStartMonth(p.m);
  const quarter = (y: number, startMonth: number): [string, string] => [
    monthRange(y, startMonth)[0],
    monthRange(y, startMonth + 2)[1],
  ];
  const lastQ = qm === 1 ? quarter(p.y - 1, 10) : quarter(p.y, qm - 3);
  const fyStart = fiscalYearStartOf(today, fiscalYearStart);
  const prevFyStart = fiscalYearStartOf(addDays(fyStart, -1), fiscalYearStart);
  return {
    thisMonth: monthRange(p.y, p.m),
    lastMonth: p.m === 1 ? monthRange(p.y - 1, 12) : monthRange(p.y, p.m - 1),
    thisQuarter: quarter(p.y, qm),
    lastQuarter: lastQ,
    fiscalYear: [fyStart, fiscalYearEnd(fyStart)],
    lastFiscalYear: [prevFyStart, fiscalYearEnd(prevFyStart)],
  };
}
