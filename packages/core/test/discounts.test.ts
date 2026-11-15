import { describe, expect, it } from 'vitest';
import { discountInvoiceNote, planDiscounts, type DiscountCodeRow } from '../src';

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

describe('planDiscounts policy', () => {
  const rows = (...r: DiscountCodeRow[]) => new Map(r.map((x) => [x.code, x]));
  const withFee = [
    ...lines,
    { kind: 'fee' as const, eventId: 'e1', categoryId: null, ticketTypeId: null, gross: 150 },
  ];

  it('refuses a code that would push the total below the minimum payable amount', () => {
    const full = row({ code: 'FULL', value: 10_000, discountFees: true, maxTotalUses: null });
    const plan = planDiscounts({
      codes: ['FULL'],
      rows: rows(full),
      lines: withFee,
      now: new Date(),
      policy: { minimumTotal: 1, maxDiscountPercent: 100 },
    });
    expect(plan.applied).toEqual([]);
    expect(plan.rejected).toEqual([{ code: 'FULL', reason: 'BELOW_MINIMUM_TOTAL' }]);
    expect(plan.perLine).toEqual([0, 0]);
  });

  it('keeps a code that leaves exactly the minimum (fee stays payable)', () => {
    const full = row({ code: 'FULL', value: 10_000, maxTotalUses: null });
    const plan = planDiscounts({
      codes: ['FULL'],
      rows: rows(full),
      lines: withFee,
      now: new Date(),
      policy: { minimumTotal: 150, maxDiscountPercent: 100 },
    });
    expect(plan.applied.map((a) => a.amount)).toEqual([3000]);
    expect(plan.rejected).toEqual([]);
  });

  it('drops stacked codes from the last one until the floor holds', () => {
    const a = row({ id: 'a', code: 'A', value: 5_000, stackable: true, maxTotalUses: null });
    const b = row({ id: 'b', code: 'B', value: 5_000, stackable: true, maxTotalUses: null });
    // A: 3000 -> 1500, B: 1500 -> 750; floor 1000 -> B dropped (1500 left)
    const plan = planDiscounts({
      codes: ['A', 'B'],
      rows: rows(a, b),
      lines,
      now: new Date(),
      policy: { minimumTotal: 1000, maxDiscountPercent: 100 },
    });
    expect(plan.applied.map((x) => x.code)).toEqual(['A']);
    expect(plan.rejected).toEqual([{ code: 'B', reason: 'BELOW_MINIMUM_TOTAL' }]);
    expect(plan.perLine).toEqual([1500]);
  });

  it('blames the code that took effect, never one the rules had not applied', () => {
    const a = row({ id: 'a', code: 'A', value: 5_000, stackable: true, maxTotalUses: null });
    // B never applies (minimum order value above the 30.00 order) and is the last candidate.
    const b = row({
      id: 'b',
      code: 'B',
      value: 1_000,
      stackable: true,
      maxTotalUses: null,
      minOrderValue: 5_000,
    });
    const plan = planDiscounts({
      codes: ['A', 'B'],
      rows: rows(a, b),
      lines,
      now: new Date(),
      policy: { minimumTotal: 2000, maxDiscountPercent: 100 }, // A alone leaves 1500
    });
    expect(plan.applied).toEqual([]);
    expect(plan.rejected).toEqual([
      { code: 'A', reason: 'BELOW_MINIMUM_TOTAL' },
      { code: 'B', reason: 'MIN_ORDER_VALUE', minOrderValue: 5_000 },
    ]);
  });

  it('never refuses an order that is free without a code', () => {
    const free = [{ ...lines[0]!, gross: 0 }];
    const plan = planDiscounts({
      codes: ['TEST10'],
      rows: rows(row({ maxTotalUses: null })),
      lines: free,
      now: new Date(),
      policy: { minimumTotal: 1, maxDiscountPercent: 100 },
    });
    expect(plan.rejected).toEqual([{ code: 'TEST10', reason: 'NOT_VALID_FOR_ITEMS' }]);
  });

  it('refuses percentage codes above the cap but not fixed amounts', () => {
    const p = row({ code: 'P60', value: 6_000, maxTotalUses: null });
    const f = row({ id: 'f', code: 'F', type: 'FIXED', value: 2_500, maxTotalUses: null });
    const policy = { minimumTotal: 0, maxDiscountPercent: 50 };
    const base = { rows: rows(p, f), lines, now: new Date(), policy };
    expect(planDiscounts({ ...base, codes: ['P60'] }).rejected).toEqual([
      { code: 'P60', reason: 'PERCENT_CAP' },
    ]);
    expect(planDiscounts({ ...base, codes: ['F'] }).applied[0]!.amount).toBe(2500);
  });

  it('is unrestricted without a policy (default behaviour)', () => {
    const full = row({ code: 'FULL', value: 10_000, discountFees: true, maxTotalUses: null });
    const plan = planDiscounts({
      codes: ['FULL'],
      rows: rows(full),
      lines: withFee,
      now: new Date(),
    });
    expect(plan.applied[0]!.amount).toBe(3150);
  });
});

describe('discountInvoiceNote', () => {
  const base = {
    policy: 'ALLOW_WITH_NOTE' as const,
    notes: { de: ' Hinweis DE ', en: 'Note EN' },
    onAllDiscounted: false,
    orderLocale: 'de',
    defaultLocale: 'en',
    hasDiscount: true,
    totalGross: 0,
  };

  it('prints the note of the order language on a zero order with ALLOW_WITH_NOTE', () => {
    expect(discountInvoiceNote(base)).toBe('Hinweis DE');
  });

  it('falls back to the shop default language, nothing when empty', () => {
    expect(discountInvoiceNote({ ...base, orderLocale: 'fr' })).toBe('Note EN');
    expect(discountInvoiceNote({ ...base, notes: {} })).toBeNull();
    expect(discountInvoiceNote({ ...base, notes: { de: '   ' } })).toBeNull();
  });

  it('prints nothing with ALLOW / DISALLOW unless it is switched on for every discounted invoice', () => {
    expect(discountInvoiceNote({ ...base, policy: 'ALLOW' })).toBeNull();
    expect(discountInvoiceNote({ ...base, policy: 'DISALLOW' })).toBeNull();
    expect(discountInvoiceNote({ ...base, policy: 'ALLOW', onAllDiscounted: true })).toBe(
      'Hinweis DE',
    );
  });

  it('a discounted invoice with an amount to pay only gets it when switched on', () => {
    expect(discountInvoiceNote({ ...base, totalGross: 500 })).toBeNull();
    expect(discountInvoiceNote({ ...base, totalGross: 500, onAllDiscounted: true })).toBe(
      'Hinweis DE',
    );
  });

  it('never prints on an invoice without a discount code', () => {
    expect(discountInvoiceNote({ ...base, hasDiscount: false, onAllDiscounted: true })).toBeNull();
  });
});
