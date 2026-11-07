import { z } from 'zod';
import {
  FEE_CALCULATIONS,
  FEE_SCOPES,
  PAYMENT_METHODS,
  SALES_CHANNELS,
  type FeeCalculation,
  type FeeScope,
} from '../enums';

/**
 * Fees & tax rates (admin input).
 *
 * Two layers:
 *  - `*InputSchema` – the canonical input of the core services: money in cents, percentages
 *    in basis points, `null` lists = "all".
 *  - `*FormSchema`  – raw admin form values (decimal strings in currency units / percent,
 *    checkbox lists) converted into the canonical input. Validation messages are the admin
 *    field error codes (`required`, `money`, `percent`, `invalid` …).
 */

export const FEE_NAME_MAX_LENGTH = 120;
export const TAX_RATE_NAME_MAX_LENGTH = 120;
export const TAX_RATE_NOTE_MAX_LENGTH = 1000;
/** Upper bound of a fixed fee (cents) – keeps order totals far below the integer limit. */
export const FEE_MAX_FIXED_CENTS = 100_000_000;
const SORT_ORDER_LIMIT = 1_000_000;

/**
 * Parses a decimal with up to two fraction digits into hundredths (cents / basis points).
 * Accepts "12", "12.5", "12,50", "1.234,50", "1,234.50" and "1 234,50"; returns null for
 * anything else (negative numbers, three fraction digits, letters …).
 */
export function parseDecimalHundredths(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  let s = input.trim().replace(/[\s  ]/g, '');
  if (s === '') return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // the later separator is the decimal separator, the other one groups thousands
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = s.replace(',', '.');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole = '0', fraction = ''] = s.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(value) ? value : null;
}

/** Hundredths → plain decimal for input fields: 1250 → "12.50", 750 → "7.5", 1900 → "19". */
export function formatHundredths(value: number, mode: 'money' | 'percent'): string {
  const fixed = (value / 100).toFixed(2);
  return mode === 'money' ? fixed : fixed.replace(/\.?0+$/, '');
}

/** Currency units (e.g. "2,50") → cents, or null when invalid / out of range. */
export function parseFeeAmountToCents(input: string | null | undefined): number | null {
  const cents = parseDecimalHundredths(input);
  return cents !== null && cents <= FEE_MAX_FIXED_CENTS ? cents : null;
}

/** Percent (e.g. "7,5") → basis points (750), or null when invalid / above 100 %. */
export function parsePercentToBp(input: string | null | undefined): number | null {
  const bp = parseDecimalHundredths(input);
  return bp !== null && bp <= 10_000 ? bp : null;
}

const uniqueList = <T extends string>(values: readonly T[]) => [...new Set(values)];

/** Optional integer text field ("" → undefined). */
const sortOrderField = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? Number(v) : undefined))
  .pipe(z.number('invalid').int('invalid').min(-SORT_ORDER_LIMIT).max(SORT_ORDER_LIMIT).optional());

// ─── Tax rates ──────────────────────────────────────────────────────────────

export const taxRateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(TAX_RATE_NAME_MAX_LENGTH),
    rateBasisPoints: z.number().int().min(0).max(10_000),
    /** Legal note printed on invoices (e.g. small-business or tax-exemption notice). */
    invoiceNote: z.string().trim().max(TAX_RATE_NOTE_MAX_LENGTH).nullable(),
    /** Pre-selected for new events (exactly one default). */
    isDefault: z.boolean(),
    /** Inactive rates are kept for existing events and fees but no longer offered. */
    isActive: z.boolean(),
    sortOrder: z.number().int().min(-SORT_ORDER_LIMIT).max(SORT_ORDER_LIMIT),
  })
  .superRefine((v, ctx) => {
    if (v.isDefault && !v.isActive) {
      ctx.addIssue({ code: 'custom', path: ['isActive'], message: 'invalid' });
    }
  });
export type TaxRateInput = z.infer<typeof taxRateInputSchema>;

/** Raw admin form values of a tax rate. */
export const taxRateFormSchema = z
  .object({
    name: z.string().trim().min(1, 'required').max(TAX_RATE_NAME_MAX_LENGTH),
    /** Percent, e.g. "19" or "7,5". */
    rate: z.string().trim().min(1, 'required'),
    invoiceNote: z.string().trim().max(TAX_RATE_NOTE_MAX_LENGTH).optional(),
    isDefault: z.boolean(),
    isActive: z.boolean(),
    sortOrder: sortOrderField,
  })
  .superRefine((v, ctx) => {
    if (v.rate && parsePercentToBp(v.rate) === null) {
      ctx.addIssue({ code: 'custom', path: ['rate'], message: 'percent' });
    }
    if (v.isDefault && !v.isActive) {
      ctx.addIssue({ code: 'custom', path: ['isActive'], message: 'invalid' });
    }
  })
  .transform((v): TaxRateInput => ({
    name: v.name,
    rateBasisPoints: parsePercentToBp(v.rate)!,
    invoiceNote: v.invoiceNote ? v.invoiceNote : null,
    isDefault: v.isDefault,
    isActive: v.isActive,
    sortOrder: v.sortOrder ?? 0,
  }));
export type TaxRateFormValues = z.input<typeof taxRateFormSchema>;

// ─── Fees ───────────────────────────────────────────────────────────────────

/** Where a fee is defined: globally or on one event (overrides and event-only fees). */
export type FeeTarget = 'GLOBAL' | 'EVENT';

function checkFeeRules(
  v: { scope: FeeScope; calculation: FeeCalculation; value: number; taxRateId: string | null },
  target: FeeTarget,
  ctx: z.RefinementCtx,
): void {
  if (v.calculation === 'PERCENT' && v.value > 10_000) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'percent' });
  }
  if (v.scope === 'PER_ORDER') {
    // PER_ORDER fees are charged once per (multi-event) order – they only exist globally and
    // need an explicit tax rate, because there is no event whose rate could be inherited.
    if (target === 'EVENT') ctx.addIssue({ code: 'custom', path: ['scope'], message: 'invalid' });
    if (!v.taxRateId) ctx.addIssue({ code: 'custom', path: ['taxRateId'], message: 'required' });
  }
}

const feeInputObject = z.object({
  name: z.string().trim().min(1).max(FEE_NAME_MAX_LENGTH),
  scope: z.enum(FEE_SCOPES),
  calculation: z.enum(FEE_CALCULATIONS),
  /** Cents for FIXED, basis points (≤ 10000) of the ticket / event / order amount for PERCENT. */
  value: z.number().int().min(0).max(FEE_MAX_FIXED_CENTS),
  /** null = the event's tax rate (required for PER_ORDER). */
  taxRateId: z.uuid().nullable(),
  /** null = every payment method. */
  paymentMethods: z.array(z.enum(PAYMENT_METHODS)).min(1).transform(uniqueList).nullable(),
  /** null = every sales channel. */
  channels: z.array(z.enum(SALES_CHANNELS)).min(1).transform(uniqueList).nullable(),
  isActive: z.boolean(),
  /** Event-only fees: position among the event's fees. Ignored for global fees and overrides. */
  sortOrder: z.number().int().min(-SORT_ORDER_LIMIT).max(SORT_ORDER_LIMIT).optional(),
});

/** Canonical fee input of the core services (global fees). */
export const globalFeeInputSchema = feeInputObject.superRefine((v, ctx) =>
  checkFeeRules(v, 'GLOBAL', ctx),
);
/** Canonical fee input for event overrides and event-only fees (no PER_ORDER). */
export const eventFeeInputSchema = feeInputObject.superRefine((v, ctx) =>
  checkFeeRules(v, 'EVENT', ctx),
);
export type FeeInput = z.input<typeof feeInputObject>;
export type ParsedFeeInput = z.output<typeof feeInputObject>;

const feeValue = (calculation: FeeCalculation, raw: string) =>
  calculation === 'PERCENT' ? parsePercentToBp(raw) : parseFeeAmountToCents(raw);

function feeFormSchema(target: FeeTarget) {
  return z
    .object({
      name: z.string().trim().min(1, 'required').max(FEE_NAME_MAX_LENGTH),
      scope: z.enum(FEE_SCOPES),
      calculation: z.enum(FEE_CALCULATIONS),
      /** "2,50" (currency units) for FIXED, "5" / "7.5" (percent) for PERCENT. */
      value: z.string().trim().min(1, 'required'),
      /** '' / undefined = the event's tax rate. */
      taxRateId: z
        .string()
        .trim()
        .optional()
        .transform((v) => (v ? v : null))
        .pipe(z.uuid('invalid').nullable()),
      /** Ticked checkboxes; all ticked = every option (stored as null). */
      paymentMethods: z.array(z.enum(PAYMENT_METHODS)).min(1, 'required'),
      channels: z.array(z.enum(SALES_CHANNELS)).min(1, 'required'),
      isActive: z.boolean(),
      sortOrder: sortOrderField,
    })
    .superRefine((v, ctx) => {
      if (v.value && feeValue(v.calculation, v.value) === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: v.calculation === 'PERCENT' ? 'percent' : 'money',
        });
      }
      checkFeeRules({ ...v, value: 0 }, target, ctx);
    })
    .transform((v): ParsedFeeInput => ({
      name: v.name,
      scope: v.scope,
      calculation: v.calculation,
      value: feeValue(v.calculation, v.value)!,
      taxRateId: v.taxRateId,
      paymentMethods: allOrList(v.paymentMethods, PAYMENT_METHODS),
      channels: allOrList(v.channels, SALES_CHANNELS),
      isActive: v.isActive,
      ...(v.sortOrder === undefined ? {} : { sortOrder: v.sortOrder }),
    }));
}

/** Admin form → global fee input. */
export const globalFeeFormSchema = feeFormSchema('GLOBAL');
/** Admin form → event override / event-only fee input (PER_ORDER rejected). */
export const eventFeeFormSchema = feeFormSchema('EVENT');
export type FeeFormValues = z.input<typeof globalFeeFormSchema>;

/** Every option ticked → null ("all", also covers options added later). */
function allOrList<T extends string>(selected: readonly T[], all: readonly T[]): T[] | null {
  const unique = uniqueList(selected);
  return all.every((option) => unique.includes(option)) ? null : unique;
}

/** Order of global fees (complete list of their ids, first = charged first). */
export const feeOrderSchema = z
  .array(z.uuid())
  .min(1)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, 'invalid');

/**
 * Amount of one fee for an example purchase (admin preview; mirrors the checkout pricing).
 * PER_TICKET → for each of `ticketCount` tickets of `ticketPrice`; PER_EVENT / PER_ORDER →
 * once, percentages of the ticket total.
 */
export function exampleFeeAmount(
  fee: { scope: FeeScope; calculation: FeeCalculation; value: number },
  ticketPrice: number,
  ticketCount = 1,
): number {
  const percentOf = (amount: number) => Math.round((amount * fee.value) / 10_000);
  if (fee.scope === 'PER_TICKET') {
    return (fee.calculation === 'FIXED' ? fee.value : percentOf(ticketPrice)) * ticketCount;
  }
  return fee.calculation === 'FIXED' ? fee.value : percentOf(ticketPrice * ticketCount);
}
