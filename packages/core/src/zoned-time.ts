/** Wall-clock arithmetic in an IANA time zone (Intl only), used to shift event dates across DST. */

export function wallMs(date: Date, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
}

const offsetAt = (instantMs: number, timeZone: string) =>
  wallMs(new Date(instantMs), timeZone) - Math.floor(instantMs / 1000) * 1000;

/** Wall time (as UTC-encoded ms) → instant. Overlap: earlier instant; gap: lands after the gap. */
export function wallToInstant(wall: number, timeZone: string): Date {
  const day = 86_400_000;
  const before = offsetAt(wall - day, timeZone);
  const after = offsetAt(wall + day, timeZone);
  const candidates = [...new Set([wall - before, wall - after])].sort((a, b) => a - b);
  const exact = candidates.find((i) => i + offsetAt(i, timeZone) === wall);
  return new Date(exact ?? wall - before);
}

/**
 * Returns a function that shifts a date by the wall-clock difference between `from` and `to`
 * in `timeZone`, keeping the local time of day (e.g. doors 18:30 stay 18:30 across DST).
 */
export function wallClockShifter(from: Date, to: Date, timeZone: string) {
  const delta = wallMs(to, timeZone) - wallMs(from, timeZone);
  return (d: Date | null): Date | null =>
    d ? wallToInstant(wallMs(d, timeZone) + delta, timeZone) : null;
}
