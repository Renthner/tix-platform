import { describe, expect, it } from 'vitest';
import { resolveCancelDays } from '../src/orders/cancel-terms';

const inherit = { bankTransferCancelAfterDays: null, bankTransferAutoCancel: null };
const own = (days: number) => ({ bankTransferCancelAfterDays: days, bankTransferAutoCancel: null });
const off = { bankTransferCancelAfterDays: null, bankTransferAutoCancel: false };

describe('resolveCancelDays', () => {
  it('uses the global value when events inherit', () => {
    expect(resolveCancelDays([inherit], 8, 5)).toBe(8);
  });

  it('is null when the global value is empty and the event inherits', () => {
    expect(resolveCancelDays([inherit], null, 5)).toBeNull();
  });

  it('lets an event enable auto-cancel with its own days although the global one is off', () => {
    expect(resolveCancelDays([own(10)], null, 5)).toBe(10);
  });

  it('is null when the only event disables auto-cancel (even with global days)', () => {
    expect(resolveCancelDays([off], 8, 5)).toBeNull();
  });

  it('ignores disabled events in multi-event orders and takes the shortest enabled deadline', () => {
    expect(resolveCancelDays([off, own(9), inherit], 12, 5)).toBe(9);
    expect(resolveCancelDays([off, inherit], null, 5)).toBeNull();
    expect(resolveCancelDays([off, off], 8, 5)).toBeNull();
  });

  it('is never shorter than the payment term', () => {
    expect(resolveCancelDays([own(3)], 8, 5)).toBe(5);
  });
});
