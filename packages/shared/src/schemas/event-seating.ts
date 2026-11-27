import { z } from 'zod';
import { EVENT_SEATING_MODES } from '../enums';

/**
 * Seating mode of an event (admin input) and the quantity contingents of admission-only events.
 * Validation messages are the admin field error codes (`required`, `invalid`, `tooLong` …).
 */

export const CONTINGENT_NAME_MAX_LENGTH = 120;
/** Upper bound of one contingent (keeps sums far below the integer limit). */
export const CONTINGENT_MAX_CAPACITY = 1_000_000;

/** Change of seating mode / venue / plan of a DRAFT event (`changeEventSeating`). */
export const changeEventSeatingSchema = z
  .object({
    mode: z.enum(EVENT_SEATING_MODES),
    venueId: z.uuid().nullable(),
    templateId: z.uuid().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'SEATED' && !v.venueId) {
      ctx.addIssue({ code: 'custom', path: ['venueId'], message: 'required' });
    }
    if (v.mode === 'ADMISSION' && v.templateId) {
      ctx.addIssue({ code: 'custom', path: ['templateId'], message: 'invalid' });
    }
  });
export type ChangeEventSeatingInput = z.infer<typeof changeEventSeatingSchema>;

/** Create (no id) or update a contingent (STANDING section of an admission-only event). */
export const contingentInputSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1, 'required').max(CONTINGENT_NAME_MAX_LENGTH, 'tooLong'),
  capacity: z.number().int('invalid').min(0, 'invalid').max(CONTINGENT_MAX_CAPACITY, 'invalid'),
  priceCategoryId: z.uuid(),
  entranceId: z.uuid().nullable().optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
});
export type ContingentInput = z.infer<typeof contingentInputSchema>;
