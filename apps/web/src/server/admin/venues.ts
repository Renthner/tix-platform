'use server';

import { cloneSeatMap } from '@tix/core';
import { events, isUniqueViolation, seatMaps, venues, withTransaction } from '@tix/db';
import { and, count, eq } from 'drizzle-orm';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { redirect } from '@/i18n/navigation';
import type { ActionState } from '@/lib/action-state';
import { isValidTimeZone } from '@/lib/datetime';
import { SLUG_PATTERN } from '@/lib/slug';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { fieldError, flag, formError, success, text, zodFieldErrors } from './form';

const optionalText = (max: number) => z.string().max(max).optional();
const coordinate = (min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return null;
      const n = Number(v.replace(',', '.'));
      if (!Number.isFinite(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: 'invalid' });
        return z.NEVER;
      }
      return n;
    });

/** Only http(s) links – they are rendered as clickable links in the shop. */
const httpUrl = z.url({ protocol: /^https?$/, message: 'url' }).max(2000);

const venueSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(80).regex(SLUG_PATTERN, 'slugFormat'),
  street: optionalText(200),
  postalCode: optionalText(20),
  city: optionalText(120),
  country: z
    .string()
    .optional()
    .transform((v) => v?.toUpperCase())
    .refine((v) => v === undefined || /^[A-Z]{2}$/.test(v), 'country'),
  latitude: coordinate(-90, 90),
  longitude: coordinate(-180, 180),
  timeZone: z.string().min(1).refine(isValidTimeZone, 'timeZone'),
  websiteUrl: httpUrl.optional(),
  mapsUrl: httpUrl.optional(),
  description: optionalText(5000),
  isActive: z.boolean(),
});

function readVenue(fd: FormData) {
  return venueSchema.safeParse({
    name: text(fd, 'name'),
    slug: text(fd, 'slug'),
    street: text(fd, 'street'),
    postalCode: text(fd, 'postalCode'),
    city: text(fd, 'city'),
    country: text(fd, 'country'),
    latitude: text(fd, 'latitude'),
    longitude: text(fd, 'longitude'),
    timeZone: text(fd, 'timeZone'),
    websiteUrl: text(fd, 'websiteUrl'),
    mapsUrl: text(fd, 'mapsUrl'),
    description: text(fd, 'description'),
    isActive: flag(fd, 'isActive'),
  });
}

export async function saveVenueAction(
  venueId: string | null,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const parsed = readVenue(fd);
  if (!parsed.success) return fieldError(zodFieldErrors(parsed.error));
  const values = {
    ...parsed.data,
    street: parsed.data.street ?? null,
    postalCode: parsed.data.postalCode ?? null,
    city: parsed.data.city ?? null,
    country: parsed.data.country ?? null,
    websiteUrl: parsed.data.websiteUrl ?? null,
    mapsUrl: parsed.data.mapsUrl ?? null,
    description: parsed.data.description ?? null,
  };
  const { db } = getCore();
  let id = venueId;
  try {
    if (venueId) {
      const updated = await db
        .update(venues)
        .set(values)
        .where(eq(venues.id, venueId))
        .returning({ id: venues.id });
      if (updated.length === 0) return formError('notFound');
      await audit(db, session, 'venue.update', 'venue', venueId, values);
    } else {
      const [created] = await db.insert(venues).values(values).returning({ id: venues.id });
      id = created!.id;
      await audit(db, session, 'venue.create', 'venue', id, values);
    }
  } catch (err) {
    if (isUniqueViolation(err, 'venues_slug_uq')) return fieldError({ slug: 'slugTaken' });
    throw err;
  }
  revalidatePath('/', 'layout');
  if (!venueId) redirect({ href: `/admin/venues/${id}`, locale: await getLocale() });
  return success('saved');
}

const templateSchema = z.object({
  name: z.string().min(1).max(120),
  canvasWidth: z.coerce.number().int().min(100).max(100_000),
  canvasHeight: z.coerce.number().int().min(100).max(100_000),
});

export async function createTemplateAction(
  venueId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const parsed = templateSchema.safeParse({
    name: text(fd, 'name'),
    canvasWidth: text(fd, 'canvasWidth'),
    canvasHeight: text(fd, 'canvasHeight'),
  });
  if (!parsed.success) return fieldError(zodFieldErrors(parsed.error));
  const { db } = getCore();
  const [venue] = await db.select({ id: venues.id }).from(venues).where(eq(venues.id, venueId));
  if (!venue) return formError('notFound');
  const [map] = await db
    .insert(seatMaps)
    .values({ venueId, kind: 'TEMPLATE', ...parsed.data })
    .returning({ id: seatMaps.id });
  await audit(db, session, 'seatmap.create', 'seat_map', map!.id, parsed.data);
  revalidatePath('/', 'layout');
  redirect({ href: `/admin/seat-maps/${map!.id}`, locale: await getLocale() });
  return success('created');
}

async function loadTemplate(seatMapId: string) {
  const [map] = await getCore()
    .db.select()
    .from(seatMaps)
    .where(and(eq(seatMaps.id, seatMapId), eq(seatMaps.kind, 'TEMPLATE')));
  return map ?? null;
}

export async function renameTemplateAction(
  seatMapId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const name = z.string().min(1).max(120).safeParse(text(fd, 'name'));
  if (!name.success)
    return fieldError({ name: name.error.issues[0]?.code === 'too_big' ? 'tooLong' : 'required' });
  if (!(await loadTemplate(seatMapId))) return formError('notFound');
  const { db } = getCore();
  // Renaming does not change the plan geometry → no version bump (keeps open editors valid).
  await db.update(seatMaps).set({ name: name.data }).where(eq(seatMaps.id, seatMapId));
  await audit(db, session, 'seatmap.rename', 'seat_map', seatMapId, { name: name.data });
  revalidatePath('/', 'layout');
  return success('saved');
}

export async function duplicateTemplateAction(
  seatMapId: string,
  copyName: string,
  _prev: ActionState,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const source = await loadTemplate(seatMapId);
  if (!source) return formError('notFound');
  const { db } = getCore();
  const id = await withTransaction(db, (tx) =>
    cloneSeatMap(tx, seatMapId, { kind: 'TEMPLATE', name: copyName.slice(0, 120) }),
  );
  await audit(db, session, 'seatmap.duplicate', 'seat_map', id, { source: seatMapId });
  revalidatePath('/', 'layout');
  return success('created');
}

export async function deleteTemplateAction(
  seatMapId: string,
  _prev: ActionState,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const source = await loadTemplate(seatMapId);
  if (!source) return formError('notFound');
  const { db } = getCore();
  // Event plans are independent copies (cloned_from_id is SET NULL on delete).
  await db.delete(seatMaps).where(and(eq(seatMaps.id, seatMapId), eq(seatMaps.kind, 'TEMPLATE')));
  await audit(db, session, 'seatmap.delete', 'seat_map', seatMapId, { name: source.name });
  revalidatePath('/', 'layout');
  return success('deleted');
}

/**
 * Deletes a venue together with its master plans. Only possible while no event (of any
 * status) references the venue – events and their order history keep their venue.
 */
export async function deleteVenueAction(venueId: string, _prev: ActionState): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const { db } = getCore();
  const result = await withTransaction(db, async (tx) => {
    const [venue] = await tx
      .select({ id: venues.id, name: venues.name, slug: venues.slug })
      .from(venues)
      .where(eq(venues.id, venueId))
      .for('update');
    if (!venue) return 'notFound' as const;
    const [usage] = await tx.select({ n: count() }).from(events).where(eq(events.venueId, venueId));
    if ((usage?.n ?? 0) > 0) return 'venueHasEvents' as const;
    // Remaining plans are master plans (event plans are deleted with their events).
    await tx.delete(seatMaps).where(eq(seatMaps.venueId, venueId));
    await tx.delete(venues).where(eq(venues.id, venueId));
    return venue;
  });
  if (result === 'notFound' || result === 'venueHasEvents') return formError(result);
  await audit(db, session, 'venue.delete', 'venue', venueId, {
    name: result.name,
    slug: result.slug,
  });
  revalidatePath('/', 'layout');
  redirect({ href: '/admin/venues?deleted=1', locale: await getLocale() });
  return success('deleted');
}
