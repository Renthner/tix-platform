import { z } from 'zod';
import { SUPPORTED_LOCALES } from '../i18n';
import { postalAddressSchema } from './common';

/** Payment methods selectable in the online checkout. */
export const ONLINE_PAYMENT_METHODS = ['PAYPAL', 'BANK_TRANSFER'] as const;
export type OnlinePaymentMethod = (typeof ONLINE_PAYMENT_METHODS)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

/** Buyer data + payment choice submitted with "Place order". */
export const checkoutInputSchema = z.object({
  method: z.enum(ONLINE_PAYMENT_METHODS),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  company: optionalText(200),
  phone: optionalText(50),
  /** Billing address is optional (B2C tickets); either complete or omitted. */
  address: postalAddressSchema.optional(),
  customerNote: optionalText(1_000),
  acceptTerms: z.boolean(),
  /** Total the customer saw – the order is rejected when the price changed meanwhile. */
  expectedTotalGross: z.number().int().min(0),
  locale: z.enum(SUPPORTED_LOCALES),
});
export type CheckoutInput = z.output<typeof checkoutInputSchema>;
