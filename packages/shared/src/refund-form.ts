import { z } from 'zod';

/**
 * Admin form "cancel a paid order & refund": parsed from the raw field values so the server
 * action and its unit test share one implementation. Checkbox values are "on" when checked.
 */
const cancelPaidFormSchema = z.object({
  orderItemIds: z.array(z.uuid()).min(1).max(500),
  refundFees: z.boolean(),
  notify: z.boolean(),
  confirmed: z.literal(true),
  reason: z.string().max(500).nullable(),
  expectedVersion: z.number().int().nonnegative().optional(),
});

export type CancelPaidFormInput = z.infer<typeof cancelPaidFormSchema>;

/** The subset of `FormData` that is read (shared has no DOM typings). */
export interface FormFields {
  get(name: string): unknown;
  getAll(name: string): unknown[];
}

const checked = (v: unknown) => v === 'on' || v === 'true' || v === '1';

export function parseCancelPaidForm(fd: FormFields): CancelPaidFormInput | null {
  const reason = fd.get('reason');
  const version = fd.get('expectedVersion');
  const parsed = cancelPaidFormSchema.safeParse({
    orderItemIds: [...new Set(fd.getAll('orderItemIds').filter((v) => typeof v === 'string'))],
    refundFees: checked(fd.get('refundFees')),
    notify: checked(fd.get('notify')),
    confirmed: checked(fd.get('confirmed')),
    reason: typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null,
    expectedVersion:
      typeof version === 'string' && /^\d{1,9}$/.test(version) ? Number(version) : undefined,
  });
  return parsed.success ? parsed.data : null;
}
