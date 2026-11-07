/**
 * Business days for payment terms (Zahlungsfrist): Monday–Friday without German public
 * holidays – nationwide ones always, regional ones for the configured federal state.
 * Dates are calendar days in the given IANA time zone (default Europe/Berlin).
 */

export const GERMAN_STATES = [
  'BW',
  'BY',
  'BE',
  'BB',
  'HB',
  'HH',
  'HE',
  'MV',
  'NI',
  'NW',
  'RP',
  'SL',
  'SN',
  'ST',
  'SH',
  'TH',
] as const;
export type GermanState = (typeof GERMAN_STATES)[number];

/** Easter Sunday (Gregorian) – anonymous Gregorian algorithm. Returns [month 1-12, day]. */
function easterSunday(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** ISO date `days` after the given ISO date (UTC arithmetic on calendar dates). */
export function addCalendarDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return iso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Public holidays (ISO dates) of a year: nationwide plus those of `state` (if given). */
export function germanHolidays(year: number, state: GermanState | null = null): Set<string> {
  const [em, ed] = easterSunday(year);
  const easter = iso(year, em, ed);
  const rel = (days: number) => addCalendarDays(easter, days);
  const days = new Set<string>([
    iso(year, 1, 1), // Neujahr
    rel(-2), // Karfreitag
    rel(1), // Ostermontag
    iso(year, 5, 1), // Tag der Arbeit
    rel(39), // Christi Himmelfahrt
    rel(50), // Pfingstmontag
    iso(year, 10, 3), // Tag der Deutschen Einheit
    iso(year, 12, 25),
    iso(year, 12, 26),
  ]);
  if (!state) return days;
  const add = (states: GermanState[], date: string) => {
    if (states.includes(state)) days.add(date);
  };
  add(['BW', 'BY', 'ST'], iso(year, 1, 6)); // Heilige Drei Könige
  add(['BE', 'MV'], iso(year, 3, 8)); // Internationaler Frauentag (MV since 2023)
  add(['BW', 'BY', 'HE', 'NW', 'RP', 'SL'], rel(60)); // Fronleichnam
  add(['SL'], iso(year, 8, 15)); // Mariä Himmelfahrt (statewide in SL)
  add(['TH'], iso(year, 9, 20)); // Weltkindertag
  add(['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH'], iso(year, 10, 31)); // Reformationstag
  add(['BW', 'BY', 'NW', 'RP', 'SL'], iso(year, 11, 1)); // Allerheiligen
  if (state === 'SN') {
    // Buß- und Bettag: Wednesday before 23 November
    const nov23 = new Date(Date.UTC(year, 10, 23));
    const back = (nov23.getUTCDay() - 3 + 7) % 7 || 7;
    days.add(addCalendarDays(iso(year, 11, 23), -back));
  }
  return days;
}

/** Calendar date (ISO) of an instant in a time zone. */
export function isoDateInZone(at: Date, timeZone = 'Europe/Berlin'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function isBusinessDay(isoDate: string, state: GermanState | null = null): boolean {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !germanHolidays(y, state).has(isoDate);
}

/**
 * Due date `days` after `from`: business days (Mon–Fri without holidays) or calendar days.
 * Returns the ISO calendar date; the payment is due at the end of that day.
 */
export function addPaymentDays(
  from: Date,
  days: number,
  options: { businessDaysOnly: boolean; state?: GermanState | null; timeZone?: string },
): string {
  let date = isoDateInZone(from, options.timeZone);
  if (!options.businessDaysOnly) return addCalendarDays(date, days);
  let remaining = days;
  while (remaining > 0) {
    date = addCalendarDays(date, 1);
    if (isBusinessDay(date, options.state ?? null)) remaining -= 1;
  }
  return date;
}

/** End of an ISO calendar day (23:59:59.999) in a time zone, as an instant. */
export function endOfDayInZone(isoDate: string, timeZone = 'Europe/Berlin'): Date {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  // Start from UTC midnight of the next day and correct by the zone offset at that instant.
  const guess = Date.UTC(y, m - 1, d + 1);
  const offsetMinutes = zoneOffsetMinutes(new Date(guess), timeZone);
  return new Date(guess - offsetMinutes * 60_000 - 1);
}

function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}
