import { describe, expect, it } from 'vitest';
import {
  effectiveMinimumTotal,
  exceedsPercentCap,
  fullDiscountWarning,
  parseSetting,
  violatesMinimumTotal,
} from '../src';

describe('full discount policy', () => {
  it('keeps the original behaviour by default', () => {
    const checkout = parseSetting('checkout', {});
    expect(checkout.fullDiscountPolicy).toBe('ALLOW');
    expect(checkout.minimumOrderTotalAfterDiscounts).toBe(0);
    expect(checkout.maxDiscountPercent).toBe(100);
    expect(effectiveMinimumTotal(checkout)).toBe(0);
    const invoicing = parseSetting('invoicing', {});
    expect(invoicing.zeroValueInvoice).toBe('INVOICE');
    expect(invoicing.zeroValueInvoiceNote).toEqual({});
    expect(invoicing.discountNoteOnAllInvoices).toBe(false);
    expect(parseSetting('accounting', {}).zeroValueDocuments).toBe('INCLUDE');
  });

  it('DISALLOW always requires at least one cent, the configured minimum can be higher', () => {
    const base = { minimumOrderTotalAfterDiscounts: 0 };
    expect(effectiveMinimumTotal({ ...base, fullDiscountPolicy: 'DISALLOW' })).toBe(1);
    expect(effectiveMinimumTotal({ ...base, fullDiscountPolicy: 'ALLOW_WITH_NOTE' })).toBe(0);
    expect(
      effectiveMinimumTotal({
        fullDiscountPolicy: 'DISALLOW',
        minimumOrderTotalAfterDiscounts: 500,
      }),
    ).toBe(500);
    // The minimum also applies when full discounts are allowed.
    expect(
      effectiveMinimumTotal({ fullDiscountPolicy: 'ALLOW', minimumOrderTotalAfterDiscounts: 500 }),
    ).toBe(500);
  });

  it('only refuses totals that a code pushed below the floor', () => {
    expect(violatesMinimumTotal(0, 3000, 1)).toBe(true);
    expect(violatesMinimumTotal(1, 3000, 1)).toBe(false);
    // An order that is free without any code is never refused.
    expect(violatesMinimumTotal(0, 0, 1)).toBe(false);
    expect(violatesMinimumTotal(0, 3000, 0)).toBe(false);
  });

  it('percentage cap applies to PERCENT codes only (basis points)', () => {
    expect(exceedsPercentCap('PERCENT', 10_000, 100)).toBe(false);
    expect(exceedsPercentCap('PERCENT', 5_001, 50)).toBe(true);
    expect(exceedsPercentCap('PERCENT', 5_000, 50)).toBe(false);
    expect(exceedsPercentCap('FIXED', 99_999_999, 10)).toBe(false);
  });

  it('warns for codes that can make an order free', () => {
    expect(fullDiscountWarning({ type: 'PERCENT', value: 10_000 }, null)).toBe('FULL_PERCENT');
    expect(fullDiscountWarning({ type: 'PERCENT', value: 9_999 }, null)).toBeNull();
    expect(fullDiscountWarning({ type: 'FIXED', value: 3_000 }, 3_000)).toBe('FIXED_COVERS_PRICE');
    expect(fullDiscountWarning({ type: 'FIXED', value: 2_999 }, 3_000)).toBeNull();
    expect(fullDiscountWarning({ type: 'FIXED', value: 100 }, null)).toBe('FIXED_MAY_COVER_PRICE');
  });

  it('validates the new settings', () => {
    expect(() => parseSetting('checkout', { fullDiscountPolicy: 'MAYBE' })).toThrow();
    expect(() => parseSetting('checkout', { maxDiscountPercent: 0 })).toThrow();
    expect(() => parseSetting('checkout', { maxDiscountPercent: 101 })).toThrow();
    expect(() => parseSetting('invoicing', { zeroValueInvoice: 'SOMETIMES' })).toThrow();
    expect(() =>
      parseSetting('invoicing', { zeroValueInvoiceNote: { de: 'x'.repeat(1001) } }),
    ).toThrow();
    expect(() => parseSetting('invoicing', { zeroValueInvoiceNote: { xx: 'x' } })).toThrow();
  });
});
