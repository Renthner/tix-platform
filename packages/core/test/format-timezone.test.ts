import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  formatInZone,
  utcToZonedWallTime,
  zonedWallTimeToUtc,
} from '../../../apps/web/src/lib/datetime';
import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatTime, yearIn } from '../src/format';
import { localDateOf } from '../src/accounting/dates';
import { formatDatevTimestamp } from '../src/accounting/datev';

const BERLIN = 'Europe/Berlin';

describe('server-side date formatting uses the given zone, not the container TZ', () => {
  // 2026-10-25 is the end of DST: 20 Oct is CEST (UTC+2), 10 Nov is CET (UTC+1).
  it('renders the same wall time on both sides of the DST change', () => {
    const summer = new Date('2026-10-20T17:30:00Z'); // 19:30 CEST
    const winter = new Date('2026-11-10T18:30:00Z'); // 19:30 CET
    expect(formatTime(summer, 'de', BERLIN)).toBe('19:30');
    expect(formatTime(winter, 'de', BERLIN)).toBe('19:30');
    expect(formatDateTime(winter, 'de', BERLIN, 'medium')).toContain('19:30');
  });

  it('does not shift the calendar date near midnight', () => {
    const lateWinter = new Date('2026-11-10T23:30:00Z'); // 00:30 on 11 Nov in Berlin
    expect(formatDate(lateWinter, 'de', BERLIN, 'medium')).toBe('11.11.2026');
    expect(localDateOf(lateWinter, BERLIN)).toMatchObject({ y: 2026, m: 11, d: 11 });
    const lateSummer = new Date('2026-10-20T22:30:00Z'); // 00:30 on 21 Oct (CEST)
    expect(formatDate(lateSummer, 'de', BERLIN, 'medium')).toBe('21.10.2026');
    expect(yearIn(new Date('2026-12-31T23:30:00Z'), BERLIN)).toBe('2027');
  });

  it('DATEV timestamps follow the shop zone in summer and winter', () => {
    expect(formatDatevTimestamp(new Date('2026-10-20T17:30:00Z'), BERLIN)).toMatch(
      /^20261020193000/,
    );
    expect(formatDatevTimestamp(new Date('2026-11-10T18:30:00Z'), BERLIN)).toMatch(
      /^20261110193000/,
    );
  });
});

// ── Web helpers + next-intl (admin/shop tables) ────────────────────────────────────────────────

describe('web helpers across the 2026 DST change (Europe/Berlin)', () => {
  it('formatInZone / utcToZonedWallTime / zonedWallTimeToUtc round trip', () => {
    for (const [iso, wall] of [
      ['2026-10-20T17:30:00Z', '2026-10-20T19:30'],
      ['2026-11-10T18:30:00Z', '2026-11-10T19:30'],
    ] as const) {
      const d = new Date(iso);
      expect(utcToZonedWallTime(d, BERLIN)).toBe(wall);
      expect(zonedWallTimeToUtc(wall, BERLIN)?.toISOString()).toBe(d.toISOString());
      expect(formatInZone(d, BERLIN, 'de', { timeStyle: 'short' })).toBe('19:30');
    }
  });

  it('next-intl formatter without an explicit zone follows the configured shop zone', () => {
    const req = createRequire(
      resolve(__dirname, '../../../apps/web/node_modules/next-intl/package.json'),
    );
    const { createFormatter } = req('use-intl/core') as {
      createFormatter: (config: { locale: string; timeZone?: string }) => {
        dateTime: (value: Date, options: Intl.DateTimeFormatOptions) => string;
      };
    };
    const d = new Date('2026-11-10T18:30:00Z'); // 19:30 in Berlin, 18:30 in UTC (the old output)
    const shop = createFormatter({ locale: 'de', timeZone: BERLIN });
    expect(shop.dateTime(d, { timeStyle: 'short' })).toBe('19:30');
    expect(shop.dateTime(new Date('2026-10-20T17:30:00Z'), { timeStyle: 'short' })).toBe('19:30');
  });
});
