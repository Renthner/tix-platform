'use server';

import {
  DomainError,
  changeEventSeating,
  eventTags,
  removeContingent,
  saveContingent,
} from '@tix/core';
import { EVENT_SEATING_MODES } from '@tix/shared';
import { z } from 'zod';
import type { ActionState, FormErrorCode } from '@/lib/action-state';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { fieldError, formError, success, text } from './form';
import { refreshShop } from './shop-refresh';

/** Core error codes of a seating change / contingent edit → admin form error codes. */
const FORM_ERRORS: Record<string, FormErrorCode> = {
  EVENT_NOT_DRAFT: 'eventNotDraft',
  SEAT_PLAN_IN_USE: 'eventHasOrders',
  SEAT_PLAN_HAS_HOLDS: 'seatingHasHolds',
  SEAT_PLAN_CONFLICT: 'seatingHasHolds',
  TEMPLATE_MISMATCH: 'templateMismatch',
  NOT_FOUND: 'notFound',
  EVENT_NOT_FOUND: 'notFound',
  VENUE_NOT_FOUND: 'notFound',
  CONTINGENT_NOT_FOUND: 'notFound',
  EVENT_NOT_ADMISSION: 'generic',
  CONTINGENT_IN_USE: 'contingentInUse',
  CONTINGENT_CATEGORY_IN_USE: 'contingentCategoryInUse',
  CONTINGENT_CONFLICT: 'contingentConflict',
};

const uuid = z.uuid();

function domainState(err: unknown): ActionState | null {
  if (!(err instanceof DomainError)) return null;
  const field = typeof err.details?.field === 'string' ? err.details.field : null;
  if (err.code === 'VENUE_REQUIRED') return fieldError({ venueId: 'required' });
  if (err.code === 'CONTINGENT_NAME_TAKEN') return fieldError({ name: 'nameTaken' });
  if (err.code === 'CONTINGENT_CAPACITY_TOO_LOW') return fieldError({ capacity: 'tooSmall' });
  if (err.code === 'VALIDATION_FAILED' || (field && err.status === 422)) {
    return field ? fieldError({ [field]: 'invalid' }) : formError('generic');
  }
  const code = FORM_ERRORS[err.code];
  return code ? formError(code) : null;
}

/**
 * Changes seating mode / venue / plan of a DRAFT event without orders (deletes the event's
 * current plan copy – the dialog asks for confirmation first).
 */
export async function changeEventSeatingAction(
  eventId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  if (!uuid.safeParse(eventId).success) return formError('notFound');
  const mode = z.enum(EVENT_SEATING_MODES).safeParse(text(fd, 'seatingMode'));
  if (!mode.success) return fieldError({ seatingMode: 'invalid' });
  const venueId = text(fd, 'venueId') ?? null;
  const templateId = mode.data === 'SEATED' ? (text(fd, 'templateId') ?? null) : null;
  if (mode.data === 'SEATED' && !venueId) return fieldError({ venueId: 'required' });
  if (venueId && !z.uuid().safeParse(venueId).success) return fieldError({ venueId: 'invalid' });
  if (templateId && !z.uuid().safeParse(templateId).success) {
    return fieldError({ templateId: 'invalid' });
  }
  try {
    await changeEventSeating(getCore(), {
      eventId,
      mode: mode.data,
      venueId,
      templateId,
      userId: session.userId,
      audit: (tx, r) =>
        audit(tx, session, 'event.seating.change', 'event', eventId, {
          mode: r.mode,
          venueId: r.venueId,
          templateId,
          seatMapId: r.seatMapId,
          categoriesCreated: r.categoriesCreated,
          scannerEntrancesCleared: r.scannerEntrancesCleared,
        }),
    });
  } catch (err) {
    const state = domainState(err);
    if (state) return state;
    throw err;
  }
  await refreshShop(eventTags(eventId)).catch(() => {});
  return success('saved');
}

const contingentForm = z.object({
  id: z.uuid().optional(),
  name: z.string().min(1).max(120),
  capacity: z.coerce.number().int().min(0).max(1_000_000),
  priceCategoryId: z.uuid(),
  entranceId: z.uuid().optional(),
});

/** Creates or updates a contingent of an admission-only event (any event status). */
export async function saveContingentAction(
  eventId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  if (!uuid.safeParse(eventId).success) return formError('notFound');
  const parsed = contingentForm.safeParse({
    id: text(fd, 'id'),
    name: text(fd, 'name'),
    capacity: text(fd, 'capacity'),
    priceCategoryId: text(fd, 'priceCategoryId'),
    entranceId: text(fd, 'entranceId'),
  });
  if (!parsed.success) {
    const errors: Record<string, 'required' | 'invalid' | 'tooLong'> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '_');
      if (errors[key]) continue;
      errors[key] =
        issue.code === 'invalid_type' || (issue.code === 'too_small' && key === 'name')
          ? 'required'
          : issue.code === 'too_big' && key === 'name'
            ? 'tooLong'
            : 'invalid';
    }
    return fieldError(errors);
  }
  const input = parsed.data;
  try {
    await saveContingent(
      getCore(),
      eventId,
      {
        id: input.id,
        name: input.name,
        capacity: input.capacity,
        priceCategoryId: input.priceCategoryId,
        entranceId: input.entranceId ?? null,
      },
      {
        audit: (tx, r) =>
          audit(
            tx,
            session,
            r.created ? 'event.contingent.create' : 'event.contingent.update',
            'event',
            eventId,
            {
              contingentId: r.id,
              name: input.name,
              capacity: input.capacity,
              priceCategoryId: input.priceCategoryId,
              entranceId: input.entranceId ?? null,
            },
          ),
      },
    );
  } catch (err) {
    const state = domainState(err);
    if (state) return state;
    throw err;
  }
  await refreshShop(eventTags(eventId)).catch(() => {});
  return success(input.id ? 'saved' : 'created');
}

/** Removes a contingent (refused while spots are sold, reserved or held in carts). */
export async function removeContingentAction(
  eventId: string,
  contingentId: string,
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  if (!uuid.safeParse(eventId).success || !uuid.safeParse(contingentId).success) {
    return formError('notFound');
  }
  try {
    await removeContingent(getCore(), eventId, contingentId, {
      audit: (tx, r) =>
        audit(tx, session, 'event.contingent.remove', 'event', eventId, {
          contingentId,
          softRemoved: r.softRemoved,
        }),
    });
  } catch (err) {
    const state = domainState(err);
    if (state) return state;
    throw err;
  }
  await refreshShop(eventTags(eventId)).catch(() => {});
  return success('deleted');
}
