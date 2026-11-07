import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FEE_MAX_FIXED_CENTS,
  eventFeeFormSchema,
  eventFeeInputSchema,
  exampleFeeAmount,
  feeOrderSchema,
  formatHundredths,
  globalFeeFormSchema,
  globalFeeInputSchema,
  parseDecimalHundredths,
  parseFeeAmountToCents,
  parsePercentToBp,
  taxRateFormSchema,
  type FeeFormValues,
} from '../src';

const ALL_METHODS = ['PAYPAL', 'BANK_TRANSFER', 'CASH', 'CARD', 'COMPLIMENTARY'] as const;
const ALL_CHANNELS = ['ONLINE', 'BOX_OFFICE', 'ADMIN'] as const;

const form = (overrides: Partial<FeeFormValues> = {}): FeeFormValues => ({
  name: 'Service fee',
  scope: 'PER_TICKET',
  calculation: 'FIXED',
  value: '1,50',
  taxRateId: '',
  paymentMethods: [...ALL_METHODS],
  channels: [...ALL_CHANNELS],
  isActive: true,
  ...overrides,
});

const issues = (result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) => Object.fromEntries((result.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));

describe('decimal parsing', () => {
  it('converts currency units and percentages into hundredths', () => {
    expect(parseDecimalHundredths('12')).toBe(1200);
    expect(parseDecimalHundredths('12.5')).toBe(1250);
    expect(parseDecimalHundredths('12,50')).toBe(1250);
    expect(parseDecimalHundredths('1.234,56')).toBe(123_456);
    expect(parseDecimalHundredths('1,234.56')).toBe(123_456);
    expect(parseDecimalHundredths(' 1 234,5 ')).toBe(123_450);
    expect(parseDecimalHundredths('0,07')).toBe(7);
  });

  it('rejects invalid amounts', () => {
    for (const bad of [
      '',
      ' ',
      '-1',
      '1.234',
      'abc',
      '1,2,3',
      '12.',
      '.5',
      '1e3',
      null,
      undefined,
    ]) {
      expect(parseDecimalHundredths(bad), String(bad)).toBeNull();
    }
  });

  it('limits fixed fees and percentages', () => {
    expect(parseFeeAmountToCents('2,50')).toBe(250);
    expect(parseFeeAmountToCents(String(FEE_MAX_FIXED_CENTS / 100 + 1))).toBeNull();
    expect(parsePercentToBp('7,5')).toBe(750);
    expect(parsePercentToBp('100')).toBe(10_000);
    expect(parsePercentToBp('100.01')).toBeNull();
  });

  it('formats hundredths for input fields', () => {
    expect(formatHundredths(1250, 'money')).toBe('12.50');
    expect(formatHundredths(750, 'percent')).toBe('7.5');
    expect(formatHundredths(1900, 'percent')).toBe('19');
    expect(formatHundredths(5, 'percent')).toBe('0.05');
  });
});

describe('fee form schema', () => {
  it('converts a fixed amount into cents and "all ticked" into null', () => {
    const result = globalFeeFormSchema.safeParse(form());
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      name: 'Service fee',
      scope: 'PER_TICKET',
      calculation: 'FIXED',
      value: 150,
      taxRateId: null,
      paymentMethods: null,
      channels: null,
      isActive: true,
    });
  });

  it('converts percentages into basis points and keeps partial selections', () => {
    const taxRateId = randomUUID();
    const result = globalFeeFormSchema.parse(
      form({
        calculation: 'PERCENT',
        value: '3,25',
        taxRateId,
        paymentMethods: ['PAYPAL', 'PAYPAL'],
        channels: ['ONLINE'],
        sortOrder: '30',
      }),
    );
    expect(result).toMatchObject({
      value: 325,
      taxRateId,
      paymentMethods: ['PAYPAL'],
      channels: ['ONLINE'],
      sortOrder: 30,
    });
  });

  it('reports invalid values with the matching error code', () => {
    expect(issues(globalFeeFormSchema.safeParse(form({ value: '1,505' })))).toEqual({
      value: 'money',
    });
    expect(
      issues(globalFeeFormSchema.safeParse(form({ calculation: 'PERCENT', value: '101' }))),
    ).toEqual({ value: 'percent' });
    expect(issues(globalFeeFormSchema.safeParse(form({ value: '' })))).toEqual({
      value: 'required',
    });
  });

  it('reports all field errors at once', () => {
    const result = globalFeeFormSchema.safeParse(
      form({ name: ' ', value: 'x', paymentMethods: [], taxRateId: 'nope' }),
    );
    expect(issues(result)).toEqual({
      name: 'required',
      value: 'money',
      paymentMethods: 'required',
      taxRateId: 'invalid',
    });
  });

  it('requires an explicit tax rate for PER_ORDER fees', () => {
    expect(issues(globalFeeFormSchema.safeParse(form({ scope: 'PER_ORDER' })))).toEqual({
      taxRateId: 'required',
    });
    const taxRateId = randomUUID();
    expect(globalFeeFormSchema.parse(form({ scope: 'PER_ORDER', taxRateId })).taxRateId).toBe(
      taxRateId,
    );
  });

  it('rejects PER_ORDER for event fees', () => {
    const taxRateId = randomUUID();
    expect(issues(eventFeeFormSchema.safeParse(form({ scope: 'PER_ORDER', taxRateId })))).toEqual({
      scope: 'invalid',
    });
    expect(eventFeeFormSchema.safeParse(form({ scope: 'PER_EVENT' })).success).toBe(true);
  });
});

describe('fee input schema (core)', () => {
  const input = {
    name: 'Booking fee',
    scope: 'PER_EVENT' as const,
    calculation: 'PERCENT' as const,
    value: 500,
    taxRateId: null,
    paymentMethods: null,
    channels: null,
    isActive: true,
  };

  it('accepts canonical values', () => {
    expect(globalFeeInputSchema.parse(input)).toEqual(input);
    expect(eventFeeInputSchema.parse(input)).toEqual(input);
  });

  it('enforces the percent range and the PER_ORDER rules', () => {
    expect(globalFeeInputSchema.safeParse({ ...input, value: 10_001 }).success).toBe(false);
    expect(globalFeeInputSchema.safeParse({ ...input, scope: 'PER_ORDER' }).success).toBe(false);
    const withRate = { ...input, scope: 'PER_ORDER' as const, taxRateId: randomUUID() };
    expect(globalFeeInputSchema.safeParse(withRate).success).toBe(true);
    expect(eventFeeInputSchema.safeParse(withRate).success).toBe(false);
  });

  it('rejects empty lists (use null for "all")', () => {
    expect(globalFeeInputSchema.safeParse({ ...input, channels: [] }).success).toBe(false);
    expect(globalFeeInputSchema.safeParse({ ...input, paymentMethods: ['PAYPAL'] }).success).toBe(
      true,
    );
  });
});

describe('tax rate form schema', () => {
  it('converts the rate into basis points', () => {
    expect(
      taxRateFormSchema.parse({
        name: 'Reduced',
        rate: '7',
        invoiceNote: '',
        isDefault: true,
        isActive: true,
      }),
    ).toEqual({
      name: 'Reduced',
      rateBasisPoints: 700,
      invoiceNote: null,
      isDefault: true,
      isActive: true,
      sortOrder: 0,
    });
    expect(
      taxRateFormSchema.parse({
        name: 'Exempt',
        rate: '0',
        invoiceNote: ' Tax-exempt service. ',
        isDefault: false,
        isActive: true,
        sortOrder: '40',
      }),
    ).toMatchObject({ rateBasisPoints: 0, invoiceNote: 'Tax-exempt service.', sortOrder: 40 });
  });

  it('rejects invalid rates and an inactive default', () => {
    const base = { name: 'X', invoiceNote: '', isDefault: false, isActive: true };
    expect(issues(taxRateFormSchema.safeParse({ ...base, rate: '19,999' }))).toEqual({
      rate: 'percent',
    });
    expect(issues(taxRateFormSchema.safeParse({ ...base, rate: '120' }))).toEqual({
      rate: 'percent',
    });
    expect(
      issues(
        taxRateFormSchema.safeParse({ ...base, rate: '19', isDefault: true, isActive: false }),
      ),
    ).toEqual({ isActive: 'invalid' });
    expect(issues(taxRateFormSchema.safeParse({ ...base, rate: '19', sortOrder: '1.5' }))).toEqual({
      sortOrder: 'invalid',
    });
  });
});

describe('fee helpers', () => {
  it('validates a fee order', () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(feeOrderSchema.safeParse([a, b]).success).toBe(true);
    expect(feeOrderSchema.safeParse([a, a]).success).toBe(false);
    expect(feeOrderSchema.safeParse([]).success).toBe(false);
  });

  it('computes example amounts like the checkout', () => {
    const fixed = { calculation: 'FIXED' as const, value: 150 };
    const percent = { calculation: 'PERCENT' as const, value: 1000 };
    expect(exampleFeeAmount({ ...fixed, scope: 'PER_TICKET' }, 3000, 2)).toBe(300);
    expect(exampleFeeAmount({ ...fixed, scope: 'PER_EVENT' }, 3000, 2)).toBe(150);
    expect(exampleFeeAmount({ ...percent, scope: 'PER_TICKET' }, 3000, 2)).toBe(600);
    expect(exampleFeeAmount({ ...percent, scope: 'PER_ORDER' }, 3000, 2)).toBe(600);
    expect(exampleFeeAmount({ ...percent, scope: 'PER_TICKET' }, 2995)).toBe(300);
  });
});
