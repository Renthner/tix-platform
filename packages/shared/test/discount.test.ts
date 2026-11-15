import { describe, expect, it } from 'vitest';
import {
  allocateLargestRemainder,
  applyDiscountRule,
  splitGross,
  type DiscountLine,
  type DiscountRuleInput,
} from '../src';

const rule = (over: Partial<DiscountRuleInput> = {}): DiscountRuleInput => ({
  type: 'PERCENT',
  value: 1000,
  allEvents: true,
  eventIds: [],
  categoryIds: [],
  ticketTypeIds: [],
  minOrderValue: null,
  discountFees: false,
  ...over,
});
const item = (gross: number, over: Partial<DiscountLine> = {}): DiscountLine => ({
  kind: 'item',
  eventId: 'e1',
  categoryId: 'c1',
  ticketTypeId: 't1',
  gross,
  ...over,
});

describe('largest remainder allocation', () => {
  it('always adds up exactly and never exceeds a line', () => {
    for (const [total, weights] of [
      [100, [3333, 3333, 3334]],
      [1, [1000, 1000, 1000]],
      [999, [1, 2, 3, 4000]],
      [10, [10, 0, 0]],
    ] as const) {
      const parts = allocateLargestRemainder(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      parts.forEach((p, i) => expect(p).toBeLessThanOrEqual(weights[i]!));
    }
  });
  it('gives leftover cents to the largest remainder, earlier line on a tie', () => {
    expect(allocateLargestRemainder(1, [1000, 1000, 1000])).toEqual([1, 0, 0]);
    expect(allocateLargestRemainder(2, [100, 101, 99])).toEqual([1, 1, 0]);
  });
});

describe('applyDiscountRule', () => {
  it('percent: rounds half up on the eligible base', () => {
    const r = applyDiscountRule(rule({ value: 1250 }), [item(3333), item(1111)]);
    expect(r).toMatchObject({ ok: true, total: 556 }); // 4444 x 12.5 % = 555.5 -> 556
  });
  it('fixed: capped at the eligible tickets, category scope respected', () => {
    const r = applyDiscountRule(rule({ type: 'FIXED', value: 9999, categoryIds: ['c2'] }), [
      item(2000, { categoryId: 'c2' }),
      item(5000),
    ]);
    expect(r).toMatchObject({ ok: true, total: 2000, perLine: [2000, 0] });
  });
  it('minimum value and scope rejections', () => {
    expect(applyDiscountRule(rule({ minOrderValue: 5000 }), [item(4000)])).toMatchObject({
      ok: false,
      reason: 'MIN_ORDER_VALUE',
    });
    expect(
      applyDiscountRule(rule({ allEvents: false, eventIds: ['x'] }), [item(4000)]),
    ).toMatchObject({ ok: false, reason: 'NOT_VALID_FOR_ITEMS' });
  });
  it('fees are only discounted on request and never when restricted to categories', () => {
    const fee: DiscountLine = {
      kind: 'fee',
      eventId: 'e1',
      categoryId: null,
      ticketTypeId: null,
      gross: 200,
    };
    expect(applyDiscountRule(rule(), [item(1000), fee])).toMatchObject({ total: 100, feeTotal: 0 });
    expect(applyDiscountRule(rule({ discountFees: true }), [item(1000), fee])).toMatchObject({
      total: 120,
      feeTotal: 20,
    });
    expect(
      applyDiscountRule(rule({ discountFees: true, categoryIds: ['c1'] }), [item(1000), fee]),
    ).toMatchObject({ feeTotal: 0 });
  });
  it('VAT per rate stays exact: splits of the reduced prices sum to the lines', () => {
    const gross = [1999, 2001, 1234];
    const r = applyDiscountRule(
      rule({ value: 3333 }),
      gross.map((g) => item(g)),
    );
    if (!r.ok) throw new Error('expected a discount');
    const reduced = gross.map((g, i) => g - r.perLine[i]!);
    const split = reduced.map((g) => splitGross(g, 1900));
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(sum(split.map((x) => x.net + x.tax))).toBe(sum(reduced));
    expect(sum(reduced)).toBe(sum(gross) - r.total);
  });
});
