import { z } from 'zod';

/** Monetary amounts are always integer minor units (cents). Never floats. */
export const centsSchema = z.number().int().min(0).max(2_000_000_000);

/** Percentages are stored as basis points: 1900 = 19.00 %. */
export const basisPointsSchema = z.number().int().min(0).max(10_000);

export const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'Expected a hex color like #1A2B3C');

export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, 'Expected ISO 4217 code');
export const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/, 'Expected ISO 3166-1 alpha-2');
export const localeSchema = z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/, 'Expected BCP 47 tag');

export const timeZoneSchema = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown IANA time zone');

export const postalAddressSchema = z.object({
  street: z.string().trim().min(1).max(200),
  addressLine2: z.string().trim().max(200).optional(),
  postalCode: z.string().trim().min(1).max(20),
  city: z.string().trim().min(1).max(120),
  country: countryCodeSchema,
});
export type PostalAddress = z.infer<typeof postalAddressSchema>;

/** Snapshot of a party (seller/buyer) frozen onto an invoice. */
export const partySnapshotSchema = z.object({
  name: z.string().min(1),
  company: z.string().optional(),
  address: postalAddressSchema.optional(),
  email: z.email().optional(),
  vatId: z.string().optional(),
  taxNumber: z.string().optional(),
  registerCourt: z.string().optional(),
  registerNumber: z.string().optional(),
  representatives: z.string().optional(),
});
export type PartySnapshot = z.infer<typeof partySnapshotSchema>;

export const taxBreakdownEntrySchema = z.object({
  rateBasisPoints: basisPointsSchema,
  net: z.number().int(),
  tax: z.number().int(),
  gross: z.number().int(),
  note: z.string().optional(),
});
export type TaxBreakdownEntry = z.infer<typeof taxBreakdownEntrySchema>;
