import { describe, expect, it } from 'vitest';
import {
  PROBE_RETRY_AFTER_MS,
  isPermanentProbeError,
  stackTag,
  assertThrowawayDatabase,
  isProbeDue,
  type ProbeSettings,
} from '../src';

const weekly: ProbeSettings = {
  probeEnabled: true,
  probeFrequency: 'WEEKLY',
  probeWeekday: 0, // Sunday
  probeTime: '05:00',
};
const TZ = 'UTC';
// 2026-11-15 is a Sunday.
const sundayMorning = new Date('2026-11-15T06:00:00Z');

describe('isProbeDue', () => {
  it('is never due when switched off', () => {
    expect(isProbeDue({ ...weekly, probeEnabled: false }, TZ, sundayMorning, null)).toBe(false);
  });

  it('is due when the latest slot has no attempt yet (also on a fresh install)', () => {
    expect(isProbeDue(weekly, TZ, sundayMorning, null)).toBe(true);
    expect(
      isProbeDue(weekly, TZ, sundayMorning, { at: new Date('2026-11-08T05:00:00Z'), status: 'OK' }),
    ).toBe(true);
  });

  it('is not due again after an attempt for the slot', () => {
    const last = { at: new Date('2026-11-15T05:01:00Z'), status: 'OK' as const };
    expect(isProbeDue(weekly, TZ, sundayMorning, last)).toBe(false);
    expect(isProbeDue(weekly, TZ, new Date('2026-11-18T12:00:00Z'), last)).toBe(false);
  });

  it('catches up a slot missed by days (the probe is not time critical)', () => {
    expect(
      isProbeDue(weekly, TZ, new Date('2026-11-20T12:00:00Z'), {
        at: new Date('2026-11-08T05:01:00Z'),
        status: 'OK',
      }),
    ).toBe(true);
  });

  it('retries a failed probe only after the retry delay', () => {
    const at = new Date('2026-11-15T05:01:00Z');
    const failed = { at, status: 'FAILED' as const };
    expect(isProbeDue(weekly, TZ, new Date(at.getTime() + PROBE_RETRY_AFTER_MS - 1), failed)).toBe(
      false,
    );
    expect(isProbeDue(weekly, TZ, new Date(at.getTime() + PROBE_RETRY_AFTER_MS), failed)).toBe(
      true,
    );
  });

  it('daily frequency uses the time of day', () => {
    const daily = { ...weekly, probeFrequency: 'DAILY' as const };
    const last = { at: new Date('2026-11-14T05:01:00Z'), status: 'OK' as const };
    expect(isProbeDue(daily, TZ, new Date('2026-11-15T04:59:00Z'), last)).toBe(false);
    expect(isProbeDue(daily, TZ, new Date('2026-11-15T05:00:00Z'), last)).toBe(true);
  });
});

describe('assertThrowawayDatabase', () => {
  const live = 'postgres://u:p@db:5432/tix';
  const tag = stackTag(live, 'tix');
  it('derives a stable, stack specific tag', () => {
    expect(tag).toMatch(/^[0-9a-f]{8}$/);
    expect(stackTag(live, 'tix')).toBe(tag);
    expect(stackTag('postgres://u:p@db:5432/other', 'tix')).not.toBe(tag);
    expect(stackTag(live, 'other')).not.toBe(tag);
  });
  it('accepts throwaway names of this stack', () => {
    expect(() => assertThrowawayDatabase(`tix_probe_${tag}_ab12cd34ef56`, live, tag)).not.toThrow();
    expect(() =>
      assertThrowawayDatabase(`tix_verify_${tag}_0123456789abcdef0123`, live, tag),
    ).not.toThrow();
  });
  it('refuses the live database, other stacks and arbitrary names', () => {
    const other = stackTag('postgres://u:p@db:5432/other', 'tix');
    expect(() => assertThrowawayDatabase(`tix_probe_${other}_ab12cd34ef56`, live, tag)).toThrow();
    expect(() => assertThrowawayDatabase('tix_probe_ab12cd34ef56', live, tag)).toThrow();
    expect(() => assertThrowawayDatabase('tix', live, tag)).toThrow();
    expect(() => assertThrowawayDatabase('postgres', live, tag)).toThrow();
    expect(() =>
      assertThrowawayDatabase(`tix_probe_${tag}_x"; DROP DATABASE tix; --`, live, tag),
    ).toThrow();
    expect(() => assertThrowawayDatabase(`tix_probe_${tag}_Upper`, live, tag)).toThrow();
    // Even a throwaway-looking live name is refused.
    const liveName = `tix_probe_${tag}_live`;
    expect(() => assertThrowawayDatabase(liveName, `postgres://u:p@db/${liveName}`, tag)).toThrow();
  });
});

describe('permanent probe failures', () => {
  const failed = (permanent: boolean) => ({
    at: new Date('2026-11-15T05:00:00Z'),
    status: 'FAILED' as const,
    permanent,
  });
  it('are not retried after 6 hours, transient ones are', () => {
    const later = new Date('2026-11-15T12:00:00Z');
    expect(isProbeDue(weekly, TZ, later, failed(false))).toBe(true);
    expect(isProbeDue(weekly, TZ, later, failed(true))).toBe(false);
    expect(isPermanentProbeError('CREATEDB_MISSING: no privilege')).toBe(true);
    expect(isPermanentProbeError('TEST_RESTORE_FAILED: x')).toBe(false);
  });
});
