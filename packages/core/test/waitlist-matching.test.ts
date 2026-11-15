import { describe, expect, it } from 'vitest';
import { matchesAvailability, type WaitlistAvailability } from '../src/waitlist/availability';

const availability: WaitlistAvailability = {
  total: 3,
  byCategory: { a: 1, b: 2, c: 0 },
  capacityByCategory: { a: 5, b: 5, c: 5 },
};

describe('waiting list matching', () => {
  it('any category needs enough tickets in total', () => {
    expect(matchesAvailability({ categoryId: null, quantity: 3 }, availability)).toBe(true);
    expect(matchesAvailability({ categoryId: null, quantity: 4 }, availability)).toBe(false);
  });

  it('respects the category preference and the wanted quantity', () => {
    expect(matchesAvailability({ categoryId: 'b', quantity: 2 }, availability)).toBe(true);
    expect(matchesAvailability({ categoryId: 'a', quantity: 2 }, availability)).toBe(false);
    expect(matchesAvailability({ categoryId: 'c', quantity: 1 }, availability)).toBe(false);
    expect(matchesAvailability({ categoryId: 'unknown', quantity: 1 }, availability)).toBe(false);
  });

  it('treats a quantity below one as one', () => {
    expect(matchesAvailability({ categoryId: 'a', quantity: 0 }, availability)).toBe(true);
  });
});
