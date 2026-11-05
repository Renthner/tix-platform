/**
 * Time-zone aware conversions between `<input type="datetime-local">` wall-clock values
 * (interpreted in an IANA time zone, e.g. the event's) and UTC instants.
 *
 * The conversion uses Intl only (no dependencies): the zone offset is evaluated at a first
 * guess and re-evaluated at the corrected instant, which handles DST transitions:
 *  - wall times inside a "spring forward" gap resolve to the instant after the gap,
 *  - ambiguous wall times in a "fall back" overlap resolve to the earlier instant.
 */

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function zoneParts(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const out: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** Offset of the zone at the given instant in milliseconds (local − UTC). */
function offsetAt(instantMs: number, timeZone: string): number {
  const p = zoneParts(new Date(instantMs), timeZone);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** "2026-12-24T19:30" in `timeZone` → UTC Date. Returns null for malformed input. */
export function zonedWallTimeToUtc(local: string, timeZone: string): Date | null {
  const m = LOCAL_PATTERN.exec(local.trim());
  if (!m || !isValidTimeZone(timeZone)) return null;
  const [, y, mo, d, h, mi, s] = m;
  const wall = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
  );
  if (Number.isNaN(wall)) return null;
  // Offsets a day before/after cover both sides of any DST transition near this wall time.
  const offsetBefore = offsetAt(wall - DAY_MS, timeZone);
  const offsetAfter = offsetAt(wall + DAY_MS, timeZone);
  const candidates = [...new Set([wall - offsetBefore, wall - offsetAfter])].sort((a, b) => a - b);
  // Overlap: both candidates show the requested wall time → take the earlier one.
  const exact = candidates.find((instant) => instant + offsetAt(instant, timeZone) === wall);
  if (exact !== undefined) return new Date(exact);
  // Gap: the wall time does not exist → keep the pre-transition offset, which lands after the gap.
  return new Date(wall - offsetBefore);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC Date → "YYYY-MM-DDTHH:mm" wall time in `timeZone` (value for datetime-local inputs). */
export function utcToZonedWallTime(date: Date | null | undefined, timeZone: string): string {
  if (!date) return '';
  const p = zoneParts(date, isValidTimeZone(timeZone) ? timeZone : 'UTC');
  const pad = (n: number | undefined) => String(n ?? 0).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Human readable date/time in a given zone and locale. */
export function formatInZone(
  date: Date | null | undefined,
  timeZone: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  if (!date) return '–';
  return new Intl.DateTimeFormat(locale, {
    ...options,
    timeZone: isValidTimeZone(timeZone) ? timeZone : 'UTC',
  }).format(date);
}
