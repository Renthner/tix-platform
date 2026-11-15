import { z } from 'zod';
import { DISCOUNT_CODE_PATTERN, DISCOUNT_BULK_MAX, normalizeDiscountCode } from '../discount';
import { DISCOUNT_CODE_TYPES } from '../enums';

/**
 * Discount codes (admin input, canonical form of the core services). Money in cents, percent in
 * basis points. Validation messages are the admin field error codes.
 */

export const DISCOUNT_MAX_FIXED_CENTS = 100_000_000;
export const DISCOUNT_NOTE_MAX_LENGTH = 500;
export const DISCOUNT_PREFIX_PATTERN = /^[A-Z0-9]{0,12}$/;

const uuidList = z
  .array(z.uuid())
  .max(500)
  .transform((v) => [...new Set(v)]);

const settingsShape = {
  type: z.enum(DISCOUNT_CODE_TYPES),
  /** Cents (FIXED, per order) or basis points (PERCENT). */
  value: z.number().int().min(1),
  allEvents: z.boolean(),
  eventIds: uuidList,
  categoryIds: uuidList,
  ticketTypeIds: uuidList,
  validFrom: z.date().nullable(),
  validUntil: z.date().nullable(),
  maxTotalUses: z.number().int().min(1).max(10_000_000).nullable(),
  maxUsesPerEmail: z.number().int().min(1).max(10_000_000).nullable(),
  minOrderValue: z.number().int().min(0).max(DISCOUNT_MAX_FIXED_CENTS).nullable(),
  discountFees: z.boolean(),
  stackable: z.boolean(),
  isActive: z.boolean(),
  note: z.string().trim().max(DISCOUNT_NOTE_MAX_LENGTH).nullable(),
};

type Settings = {
  type: (typeof DISCOUNT_CODE_TYPES)[number];
  value: number;
  allEvents: boolean;
  eventIds: string[];
  validFrom: Date | null;
  validUntil: Date | null;
};

function checkSettings(v: Settings, ctx: z.RefinementCtx): void {
  if (v.type === 'PERCENT' && v.value > 10_000) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'percent' });
  }
  if (v.type === 'FIXED' && v.value > DISCOUNT_MAX_FIXED_CENTS) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'money' });
  }
  if (!v.allEvents && v.eventIds.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['eventIds'], message: 'required' });
  }
  if (v.validFrom && v.validUntil && v.validFrom >= v.validUntil) {
    ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'dateOrder' });
  }
}

export const discountCodeInputSchema = z
  .object({
    code: z
      .string()
      .transform(normalizeDiscountCode)
      .pipe(z.string().min(1, 'required').regex(DISCOUNT_CODE_PATTERN, 'codeFormat')),
    ...settingsShape,
  })
  .superRefine(checkSettings);
export type DiscountCodeInput = z.output<typeof discountCodeInputSchema>;

/** Bulk generation: N random single-use codes with the same settings. */
export const discountBulkInputSchema = z
  .object({
    count: z.number().int().min(1).max(DISCOUNT_BULK_MAX),
    prefix: z
      .string()
      .transform((v) => v.replace(/\s+/g, '').toUpperCase())
      .pipe(z.string().regex(DISCOUNT_PREFIX_PATTERN, 'codeFormat')),
    ...settingsShape,
  })
  .superRefine(checkSettings);
export type DiscountBulkInput = z.output<typeof discountBulkInputSchema>;
