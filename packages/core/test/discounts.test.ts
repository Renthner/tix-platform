import { describe, expect, it } from 'vitest';
import { planDiscounts, type DiscountCodeRow } from '../src';

const row = (over: Partial<DiscountCodeRow> = {}): DiscountCodeRow => ({
  id: 'c1',
  code: 'TEST10',
  type: 'PERCENT',
  value: 1000,
  allEvents: true,
  eventIds: [],
  categoryIds: [],
  ticketTypeIds: [],
  validFrom: null,
  validUntil: null,
  maxTotalUses: 1,
  maxUsesPerEmail: null,
  minOrderValue: null,
  discountFees: false,
  stackable: false,
  isActive: true,
  note: null,
  batchId: null,
  createdByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});
const lines = [
  { kind: 'item' as const, eventId: 'e1', categoryId: 'k', ticketTypeId: 't', gross: 3000 },
];

describe('planDiscounts', () => {
  const usage = { total: new Map([['c1', 1]]), perEmail: new Map<string, number>() };

  it('refuses a used-up code, but never for test orders', () => {
    const rows = new Map([['TEST10', row()]]);
    const base = { codes: ['TEST10'], rows, lines, now: new Date(), usage };
    expect(planDiscounts(base).rejected[0]).toMatchObject({ reason: 'USAGE_LIMIT' });
    const test = planDiscounts({ ...base, isTest: true });
    expect(test.rejected).toEqual([]);
    expect(test.applied[0]!.amount).toBe(300);
  });

  it('stacks only stackable codes, each on the price left by the previous one', () => {
    const rows = new Map([
      ['A', row({ id: 'a', code: 'A', stackable: true, maxTotalUses: null })],
      ['B', row({ id: 'b', code: 'B', stackable: true, maxTotalUses: null })],
      ['C', row({ id: 'c', code: 'C', maxTotalUses: null })],
    ]);
    const plan = planDiscounts({ codes: ['A', 'B', 'C'], rows, lines, now: new Date() });
    expect(plan.applied.map((a) => a.amount)).toEqual([300, 270]); // 10 % of 3000, then of 2700
    expect(plan.rejected).toEqual([{ code: 'C', reason: 'NOT_STACKABLE' }]);
    expect(plan.perLine).toEqual([570]);
  });
});
