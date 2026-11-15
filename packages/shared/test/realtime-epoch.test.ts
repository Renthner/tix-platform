import { describe, expect, it } from 'vitest';
import { observeEpoch, shouldRunFullResync, spreadDelayMs } from '../src';

describe('observeEpoch', () => {
  it('the first epoch is remembered without a resync', () => {
    expect(observeEpoch(null, 'a')).toEqual({ known: 'a', changed: false });
  });
  it('the same epoch is no change', () => {
    expect(observeEpoch('a', 'a')).toEqual({ known: 'a', changed: false });
  });
  it('a different epoch means a full resync and is remembered', () => {
    expect(observeEpoch('a', 'b')).toEqual({ known: 'b', changed: true });
  });
  it('ignores malformed announcements', () => {
    for (const bad of [undefined, null, 5, '', {}, 'x'.repeat(129)]) {
      expect(observeEpoch('a', bad)).toBeNull();
    }
  });
});

describe('shouldRunFullResync', () => {
  it('runs when none ran before or the window passed', () => {
    expect(shouldRunFullResync(10_000, null)).toBe(true);
    expect(shouldRunFullResync(10_000, 5_000)).toBe(true);
  });
  it('is suppressed right after another full resync', () => {
    expect(shouldRunFullResync(10_000, 9_000)).toBe(false);
  });
});

describe('spreadDelayMs', () => {
  it('stays within [0, spread)', () => {
    expect(spreadDelayMs(15_000, () => 0)).toBe(0);
    expect(spreadDelayMs(15_000, () => 0.5)).toBe(7_500);
    expect(spreadDelayMs(15_000, () => 1)).toBeLessThan(15_000);
    expect(spreadDelayMs(-5, () => 0.5)).toBe(0);
  });
});
