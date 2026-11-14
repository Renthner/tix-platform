import { describe, expect, it } from 'vitest';
import {
  chooseInterval,
  parseIsoDate,
  parseStatisticsParams,
  previousPeriod,
  rangeDays,
  resolveRange,
  statisticsFilterToParams,
  todayInZone,
  windowInstants,
} from '../src/statistics/range';
import { parseRedisInfo } from '../src/statistics/system';
import { renderPrometheus } from '../src/statistics/prometheus';
import type { SystemStats } from '../src/statistics/system';

describe('statistics range helpers', () => {
  const NOW = new Date('2026-11-13T23:30:00Z'); // already 2026-11-14 in Berlin

  it('uses the shop time zone for "today"', () => {
    expect(todayInZone(NOW, 'Europe/Berlin')).toBe('2026-11-14');
    expect(todayInZone(NOW, 'America/New_York')).toBe('2026-11-13');
  });

  it('resolves presets', () => {
    expect(resolveRange({ preset: 'today' }, NOW, 'Europe/Berlin')).toEqual({
      preset: 'today',
      from: '2026-11-14',
      to: '2026-11-14',
    });
    expect(resolveRange({ preset: '7d' }, NOW, 'Europe/Berlin')).toMatchObject({
      from: '2026-11-08',
      to: '2026-11-14',
    });
    expect(resolveRange({ preset: '30d' }, NOW, 'Europe/Berlin')).toMatchObject({
      from: '2026-10-16',
    });
    expect(resolveRange({ preset: 'year' }, NOW, 'Europe/Berlin')).toMatchObject({
      from: '2026-01-01',
      to: '2026-11-14',
    });
  });

  it('handles custom ranges: swap, invalid input, upper limit', () => {
    expect(
      resolveRange({ preset: 'custom', from: '2026-03-10', to: '2026-03-01' }, NOW, 'UTC'),
    ).toEqual({ preset: 'custom', from: '2026-03-01', to: '2026-03-10' });
    expect(
      resolveRange({ preset: 'custom', from: 'nope', to: '2026-03-01' }, NOW, 'UTC'),
    ).toMatchObject({
      preset: '30d',
    });
    const huge = resolveRange(
      { preset: 'custom', from: '2000-01-01', to: '2026-01-01' },
      NOW,
      'UTC',
    );
    expect(rangeDays(huge)).toBe(1100);
    expect(huge.to).toBe('2026-01-01');
  });

  it('rejects impossible calendar dates', () => {
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('2026-02-28')).not.toBeNull();
  });

  it('chooses the bucket interval by range length', () => {
    expect(chooseInterval(1)).toBe('hour');
    expect(chooseInterval(2)).toBe('hour');
    expect(chooseInterval(3)).toBe('day');
    expect(chooseInterval(92)).toBe('day');
    expect(chooseInterval(93)).toBe('week');
    expect(chooseInterval(400)).toBe('week');
    expect(chooseInterval(401)).toBe('month');
  });

  it('computes the previous period of the same length', () => {
    expect(previousPeriod({ from: '2026-11-08', to: '2026-11-14' })).toEqual({
      from: '2026-11-01',
      to: '2026-11-07',
    });
    expect(previousPeriod({ from: '2026-03-01', to: '2026-03-01' })).toEqual({
      from: '2026-02-28',
      to: '2026-02-28',
    });
    expect(previousPeriod({ from: '2026-01-01', to: '2026-12-31' }).to).toBe('2025-12-31');
  });

  it('turns local days into instants (DST days are 23 / 25 hours long)', () => {
    const spring = windowInstants({ from: '2026-03-29', to: '2026-03-29' }, 'Europe/Berlin');
    expect(spring.start.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(spring.end.toISOString()).toBe('2026-03-29T22:00:00.000Z');
    const autumn = windowInstants({ from: '2026-10-25', to: '2026-10-25' }, 'Europe/Berlin');
    expect((autumn.end.getTime() - autumn.start.getTime()) / 3_600_000).toBe(25);
  });
});

describe('statistics filter parameters', () => {
  const ID = '0b9c2f2e-7a6b-4c1f-9d3e-1a2b3c4d5e6f';

  it('parses, validates and round-trips', () => {
    const filter = parseStatisticsParams({
      range: 'custom',
      from: '2026-01-01',
      to: '2026-02-01',
      event: [ID, 'not-a-uuid', ID.toUpperCase()],
      channel: ['ONLINE', 'BOGUS'],
      method: 'PAYPAL,CASH',
    });
    expect(filter).toEqual({
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-02-01',
      eventIds: [ID],
      channels: ['ONLINE'],
      methods: ['PAYPAL', 'CASH'],
    });
    expect(
      parseStatisticsParams(Object.fromEntries(statisticsFilterToParams(filter))),
    ).toMatchObject({
      preset: 'custom',
      eventIds: [ID],
    });
  });

  it('falls back to 30 days for unknown presets and caps the event list', () => {
    expect(parseStatisticsParams({ range: 'forever' }).preset).toBe('30d');
    const many = Array.from(
      { length: 40 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(parseStatisticsParams({ event: many }).eventIds).toHaveLength(20);
  });
});

describe('system statistics helpers', () => {
  it('parses INFO output', () => {
    const info = parseRedisInfo(
      '# Memory\r\nused_memory:1024\r\nmaxmemory:0\r\n\r\n# Stats\r\nkeyspace_hits:3\r\n',
    );
    expect(info).toMatchObject({ used_memory: '1024', maxmemory: '0', keyspace_hits: '3' });
  });

  it('renders Prometheus text with escaped labels', () => {
    const stats = {
      generatedAt: '',
      app: {
        version: '1.0.0',
        uptimeSeconds: 5,
        nodeVersion: 'v24',
        rssBytes: 1,
        heapUsedBytes: 2,
      },
      shopCache: {
        state: 'synced',
        entries: 3,
        hits: 90,
        misses: 10,
        coalesced: 4,
        bypasses: 0,
        discarded: 1,
        invalidations: 2,
        flushes: 1,
      },
      postgres: null,
      redis: null,
      queues: [{ name: 'email', waiting: 1, active: 0, delayed: 0, failed: 2 }],
      failedJobs: [],
      waitingRoom: {
        shopSessions: 3,
        events: [{ eventId: String.raw`a"b\c`, title: 'x', waiting: 1, lobby: 0, active: 2 }],
      },
      seatLocks: null,
      realtime: { instances: 1, sockets: 7, versions: ['1'] },
      workers: { live: [], leaderId: null },
      backlog: null,
      errors: ['postgres'],
    } as unknown as SystemStats;
    const text = renderPrometheus(stats);
    expect(text).toContain('tix_queue_jobs{queue="email",state="failed"} 2');
    expect(text).toContain(String.raw`event_id="a\"b\\c"`);
    expect(text).toContain('tix_realtime_sockets 7');
    expect(text).toContain('tix_collect_error{block="postgres"} 1');
    expect(text.match(/# TYPE tix_queue_jobs/g)).toHaveLength(1);
    expect(text.endsWith('\n')).toBe(true);
  });
});
