import { describe, expect, it } from 'vitest';
import { wallClockShifter, wallMs, wallToInstant } from '../src/zoned-time';

const TZ = 'Europe/Berlin';
const DAY = 86_400_000;
const at = (y: number, m: number, d: number, h: number, min = 0) =>
  wallToInstant(Date.UTC(y, m - 1, d, h, min), TZ);
const hm = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(d);

describe('wallClockShifter', () => {
  it('keeps the local time of day when the start moves by whole days across DST', () => {
    const from = at(2030, 3, 1, 18);
    const to = at(2030, 6, 9, 18); // 100 days later, CET -> CEST
    expect(to.getTime() - from.getTime()).toBe(100 * DAY - 3_600_000);
    const shift = wallClockShifter(from, to, TZ);
    for (const d of [at(2030, 2, 9, 18, 30), at(2030, 3, 1, 17), at(2030, 3, 1, 21)]) {
      const moved = shift(d)!;
      expect(hm(moved)).toBe(hm(d));
    }
    expect(shift(at(2030, 3, 1, 17))!.getTime()).toBe(at(2030, 6, 9, 17).getTime());
    expect(shift(null)).toBeNull();
  });

  it('moves everything with the start when the start time of day changes (relative wall distances stay)', () => {
    const from = at(2030, 3, 1, 18);
    const to = at(2030, 6, 9, 19); // an absolute +100 days would be 19:00 CEST only by accident
    const shift = wallClockShifter(from, to, TZ);
    expect(hm(shift(at(2030, 3, 1, 17))!)).toBe('18:00');
    expect(wallMs(shift(at(2030, 3, 1, 21))!, TZ)).toBe(wallMs(at(2030, 6, 9, 22), TZ));
  });
});
