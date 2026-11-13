'use server';

import {
  DomainError,
  applyTemplateCategoriesToEvent,
  cloneSeatMap,
  deleteArchivedEvent,
  duplicateEvent,
  getSetting,
  eventTags,
} from '@tix/core';
import {
  events,
  isUniqueViolation,
  mediaAssets,
  seatMaps,
  taxRates,
  ticketTypes,
  venues,
  withTransaction,
} from '@tix/db';
import { EVENT_STATUSES, isMediaKindAllowed } from '@tix/shared';
import { and, eq } from 'drizzle-orm';
import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { redirect } from '@/i18n/navigation';
import type { ActionState, FieldErrorCode } from '@/lib/action-state';
import { isValidTimeZone, zonedWallTimeToUtc } from '@/lib/datetime';
import { SLUG_PATTERN } from '@/lib/slug';
import { requireAdmin } from '@/server/auth';
import { richTextToPlain, sanitizeRichText } from '@/server/rich-text';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { refreshShop } from './shop-refresh';
import { fieldError, flag, formError, success, text, triState, zodFieldErrors } from './form';
import { checklistComplete, getEventWithVenue, publishChecklist } from './queries';

/** Rich text from the editor → sanitised HTML, or null when it contains no visible text. */
function cleanDescription(raw: string | undefined): string | null {
  const html = sanitizeRichText(raw);
  return html && richTextToPlain(html) !== '' ? html : null;
}

const EMPTY_PLAN_WIDTH = 2000;
const EMPTY_PLAN_HEIGHT = 1400;

/** Parses datetime-local fields in the given zone; collects field errors. */
function readDates(
  fd: FormData,
  timeZone: string,
  names: readonly string[],
  errors: Partial<Record<string, FieldErrorCode>>,
): Record<string, Date | null> {
  const out: Record<string, Date | null> = {};
  for (const name of names) {
    const raw = text(fd, name);
    if (!raw) {
      out[name] = null;
      continue;
    }
    const date = zonedWallTimeToUtc(raw, timeZone);
    if (!date) errors[name] = 'invalid';
    out[name] = date;
  }
  return out;
}

const baseSchema = z.object({
  title: z.string().min(1).max(200),
  slug: z.string().min(1).max(80).regex(SLUG_PATTERN, 'slugFormat'),
  timeZone: z.string().min(1).refine(isValidTimeZone, 'timeZone'),
  currency: z
    .string()
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z]{3}$/.test(v), 'invalid'),
  taxRateId: z.uuid(),
});

function checkEventDates(
  d: Record<string, Date | null>,
  errors: Partial<Record<string, FieldErrorCode>>,
): void {
  if (!d.startsAt && !errors.startsAt) errors.startsAt = 'required';
  if (d.startsAt && d.endsAt && d.endsAt <= d.startsAt) errors.endsAt = 'dateOrder';
  if (d.startsAt && d.doorsOpenAt && d.doorsOpenAt > d.startsAt) errors.doorsOpenAt = 'dateOrder';
}

export async function createEventAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const parsed = baseSchema
    .extend({ venueId: z.uuid(), templateId: z.uuid().optional() })
    .safeParse({
      title: text(fd, 'title'),
      slug: text(fd, 'slug'),
      timeZone: text(fd, 'timeZone'),
      currency: text(fd, 'currency'),
      taxRateId: text(fd, 'taxRateId'),
      venueId: text(fd, 'venueId'),
      templateId: text(fd, 'templateId'),
    });
  const errors: Partial<Record<string, FieldErrorCode>> = parsed.success
    ? {}
    : zodFieldErrors(parsed.error);
  const timeZone = parsed.success ? parsed.data.timeZone : 'UTC';
  const dates = readDates(fd, timeZone, ['startsAt', 'endsAt', 'doorsOpenAt'], errors);
  checkEventDates(dates, errors);
  const subtitle = text(fd, 'subtitle');
  if (subtitle && subtitle.length > 300) errors.subtitle = 'tooLong';
  if (!parsed.success || Object.keys(errors).length > 0) return fieldError(errors);
  const data = parsed.data;

  const { db } = getCore();
  const t = await getTranslations('admin.events');
  const [venue] = await db
    .select({ id: venues.id })
    .from(venues)
    .where(eq(venues.id, data.venueId));
  if (!venue) return fieldError({ venueId: 'invalid' });
  const [tax] = await db
    .select({ id: taxRates.id })
    .from(taxRates)
    .where(eq(taxRates.id, data.taxRateId));
  if (!tax) return fieldError({ taxRateId: 'invalid' });
  if (data.templateId) {
    const [template] = await db
      .select({ venueId: seatMaps.venueId })
      .from(seatMaps)
      .where(and(eq(seatMaps.id, data.templateId), eq(seatMaps.kind, 'TEMPLATE')));
    if (!template || template.venueId !== data.venueId) return formError('templateMismatch');
  }

  let eventId: string;
  try {
    eventId = await withTransaction(db, async (tx) => {
      const seatMapId = data.templateId
        ? await cloneSeatMap(tx, data.templateId, { kind: 'EVENT', name: data.title.slice(0, 120) })
        : (
            await tx
              .insert(seatMaps)
              .values({
                venueId: data.venueId,
                kind: 'EVENT',
                name: data.title.slice(0, 120),
                canvasWidth: EMPTY_PLAN_WIDTH,
                canvasHeight: EMPTY_PLAN_HEIGHT,
              })
              .returning({ id: seatMaps.id })
          )[0]!.id;
      const [created] = await tx
        .insert(events)
        .values({
          title: data.title,
          subtitle: subtitle ?? null,
          slug: data.slug,
          venueId: data.venueId,
          seatMapId,
          status: 'DRAFT',
          startsAt: dates.startsAt!,
          endsAt: dates.endsAt,
          doorsOpenAt: dates.doorsOpenAt,
          timeZone: data.timeZone,
          currency: data.currency,
          taxRateId: data.taxRateId,
          description: cleanDescription(text(fd, 'description')),
          orphanSeatRuleEnabled: flag(fd, 'orphanSeatRuleEnabled'),
          createdByUserId: session.userId,
        })
        .returning({ id: events.id });
      if (data.templateId) {
        await applyTemplateCategoriesToEvent(tx, { eventId: created!.id, seatMapId });
      }
      await tx.insert(ticketTypes).values({
        eventId: created!.id,
        name: t('defaultTicketType'),
        isDefault: true,
      });
      await audit(tx, session, 'event.create', 'event', created!.id, {
        title: data.title,
        templateId: data.templateId ?? null,
      });
      return created!.id;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'events_slug_uq')) return fieldError({ slug: 'slugTaken' });
    throw err;
  }
  await refreshShop(eventTags(eventId));
  redirect({ href: `/admin/events/${eventId}`, locale: await getLocale() });
  return success('created');
}

export async function updateEventDetailsAction(
  eventId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const parsed = baseSchema
    .extend({
      subtitle: z.string().max(300).optional(),
      description: z.string().max(200_000).optional(),
    })
    .safeParse({
      title: text(fd, 'title'),
      slug: text(fd, 'slug'),
      timeZone: text(fd, 'timeZone'),
      currency: text(fd, 'currency'),
      taxRateId: text(fd, 'taxRateId'),
      subtitle: text(fd, 'subtitle'),
      description: text(fd, 'description'),
    });
  const errors: Partial<Record<string, FieldErrorCode>> = parsed.success
    ? {}
    : zodFieldErrors(parsed.error);
  const timeZone = parsed.success ? parsed.data.timeZone : 'UTC';
  const dates = readDates(fd, timeZone, ['startsAt', 'endsAt', 'doorsOpenAt'], errors);
  checkEventDates(dates, errors);
  if (!parsed.success || Object.keys(errors).length > 0) return fieldError(errors);

  const values = {
    ...parsed.data,
    subtitle: parsed.data.subtitle ?? null,
    description: cleanDescription(parsed.data.description),
    startsAt: dates.startsAt!,
    endsAt: dates.endsAt,
    doorsOpenAt: dates.doorsOpenAt,
  };
  // Cover image: the picker submits the asset id (empty = no cover). The cover is shown in the
  // shop, so any public image kind (also picked from the library) is accepted, nothing private.
  const coverRaw = text(fd, 'heroImageAssetId');
  let heroImageAssetId: string | null = null;
  if (coverRaw) {
    const id = z.string().uuid().safeParse(coverRaw);
    const [asset] = id.success
      ? await getCore()
          .db.select({ kind: mediaAssets.kind })
          .from(mediaAssets)
          .where(eq(mediaAssets.id, id.data))
      : [];
    if (!id.success || !asset || !isMediaKindAllowed(asset.kind, 'public'))
      return fieldError({ heroImageAssetId: 'invalid' });
    heroImageAssetId = id.data;
  }
  const { db } = getCore();
  try {
    const updated = await db
      .update(events)
      .set({ ...values, heroImageAssetId })
      .where(eq(events.id, eventId))
      .returning({ id: events.id });
    if (updated.length === 0) return formError('notFound');
  } catch (err) {
    if (isUniqueViolation(err, 'events_slug_uq')) return fieldError({ slug: 'slugTaken' });
    throw err;
  }
  await audit(db, session, 'event.update', 'event', eventId, { ...values, heroImageAssetId });
  await refreshShop(eventTags(eventId));
  return success('saved');
}

export async function setEventStatusAction(
  eventId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const status = z.enum(EVENT_STATUSES).safeParse(text(fd, 'status'));
  if (!status.success) return fieldError({ status: 'invalid' });
  const row = await getEventWithVenue(eventId);
  if (!row) return formError('notFound');
  const { event } = row;
  if (status.data === 'PUBLISHED' || status.data === 'POSTPONED') {
    if (!checklistComplete(await publishChecklist(event))) return formError('publishIncomplete');
  }
  const now = new Date();
  await getCore()
    .db.update(events)
    .set({
      status: status.data,
      publishedAt: status.data === 'PUBLISHED' && !event.publishedAt ? now : event.publishedAt,
      cancelledAt: status.data === 'CANCELLED' ? (event.cancelledAt ?? now) : null,
      cancellationReason:
        status.data === 'CANCELLED' ? (text(fd, 'cancellationReason') ?? null) : null,
    })
    .where(eq(events.id, eventId));
  await audit(getCore().db, session, 'event.status', 'event', eventId, {
    from: event.status,
    to: status.data,
  });
  await refreshShop(eventTags(eventId));
  return success(status.data === 'PUBLISHED' ? 'published' : 'saved');
}

const optionalInt = (min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return null;
      const n = Number(v);
      if (!Number.isInteger(n)) {
        ctx.addIssue({ code: 'custom', message: 'invalid' });
        return z.NEVER;
      }
      if (n < min) {
        ctx.addIssue({ code: 'custom', message: 'tooSmall' });
        return z.NEVER;
      }
      if (n > max) {
        ctx.addIssue({ code: 'custom', message: 'tooLarge' });
        return z.NEVER;
      }
      return n;
    });

const salesSchema = z.object({
  maxTicketsPerOrder: optionalInt(1, 10_000),
  maxTicketsPerCustomer: optionalInt(1, 10_000),
  cartLockTtlSeconds: optionalInt(60, 3_600),
  paymentGraceSeconds: optionalInt(0, 3_600),
  bankTransferPaymentTermDays: optionalInt(1, 60),
  bankTransferReminderAfterDays: optionalInt(1, 60),
  bankTransferCancelAfterDays: optionalInt(1, 90),
  bankTransferDisableDaysBeforeEvent: optionalInt(0, 90),
});

export async function updateEventSalesAction(
  eventId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const row = await getEventWithVenue(eventId);
  if (!row) return formError('notFound');
  const cancelMode = text(fd, 'bankTransferCancelMode') ?? 'inherit';
  const parsed = salesSchema.safeParse({
    maxTicketsPerOrder: text(fd, 'maxTicketsPerOrder'),
    maxTicketsPerCustomer: text(fd, 'maxTicketsPerCustomer'),
    cartLockTtlSeconds: text(fd, 'cartLockTtlSeconds'),
    paymentGraceSeconds: text(fd, 'paymentGraceSeconds'),
    bankTransferPaymentTermDays: text(fd, 'bankTransferPaymentTermDays'),
    bankTransferReminderAfterDays: text(fd, 'bankTransferReminderAfterDays'),
    bankTransferCancelAfterDays:
      cancelMode === 'custom' ? text(fd, 'bankTransferCancelAfterDays') : undefined,
    bankTransferDisableDaysBeforeEvent: text(fd, 'bankTransferDisableDaysBeforeEvent'),
  });
  const errors: Partial<Record<string, FieldErrorCode>> = parsed.success
    ? {}
    : zodFieldErrors(parsed.error);
  if (parsed.success) {
    // Effective Vorkasse deadlines must stay ordered: reminder < cancel, cancel >= term.
    const bank = await getSetting(getCore(), 'bankTransfer');
    const term = parsed.data.bankTransferPaymentTermDays ?? bank.paymentTermDays;
    const reminder = parsed.data.bankTransferReminderAfterDays ?? bank.reminderAfterDays;
    // Disabled auto-cancel (own setting or inherited empty global) has no deadline to compare.
    const cancel =
      cancelMode === 'off'
        ? null
        : (parsed.data.bankTransferCancelAfterDays ?? bank.cancelAfterDays);
    if (cancelMode === 'custom' && parsed.data.bankTransferCancelAfterDays === undefined) {
      errors.bankTransferCancelAfterDays = 'required';
    }
    if (cancel !== null) {
      if (cancel < term) errors.bankTransferCancelAfterDays = 'dunningOrder';
      if (reminder >= cancel) errors.bankTransferReminderAfterDays = 'dunningOrder';
    }
  }
  const dates = readDates(
    fd,
    row.event.timeZone,
    ['presaleStartsAt', 'publicSaleStartsAt', 'saleEndsAt'],
    errors,
  );
  if (
    dates.presaleStartsAt &&
    dates.publicSaleStartsAt &&
    dates.presaleStartsAt > dates.publicSaleStartsAt
  ) {
    errors.presaleStartsAt = 'dateOrder';
  }
  const opens = dates.publicSaleStartsAt ?? dates.presaleStartsAt;
  if (dates.saleEndsAt && opens && dates.saleEndsAt <= opens) errors.saleEndsAt = 'dateOrder';
  if (!parsed.success || Object.keys(errors).length > 0) return fieldError(errors);

  const values = {
    ...parsed.data,
    bankTransferAutoCancel: cancelMode === 'off' ? false : null,
    presaleStartsAt: dates.presaleStartsAt,
    publicSaleStartsAt: dates.publicSaleStartsAt,
    saleEndsAt: dates.saleEndsAt,
    salesPaused: flag(fd, 'salesPaused'),
    manualSeatSelectionEnabled: triState(fd, 'manualSeatSelectionEnabled'),
    bestAvailableEnabled: triState(fd, 'bestAvailableEnabled'),
    orphanSeatRuleEnabled: flag(fd, 'orphanSeatRuleEnabled'),
    companionRequiresWheelchair: triState(fd, 'companionRequiresWheelchair'),
    paypalEnabled: triState(fd, 'paypalEnabled'),
    bankTransferEnabled: triState(fd, 'bankTransferEnabled'),
    // Accounts can only be hidden per event (they cannot be forced on when disabled globally).
    customerAccountsEnabled: triState(fd, 'customerAccountsEnabled') === false ? false : null,
  };
  const { db } = getCore();
  await db.update(events).set(values).where(eq(events.id, eventId));
  await audit(db, session, 'event.sales', 'event', eventId, values);
  await refreshShop(eventTags(eventId));
  return success('saved');
}

/**
 * Permanently deletes an ARCHIVED event without orders. The admin must type the event title
 * to confirm. Orders/invoices are accounting records – events with orders are refused.
 */
export async function deleteEventAction(
  eventId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const row = await getEventWithVenue(eventId);
  if (!row) return formError('notFound');
  if (row.event.status !== 'ARCHIVED') return formError('eventNotArchived');
  if ((text(fd, 'confirmTitle') ?? '') !== row.event.title.trim())
    return fieldError({ confirmTitle: 'confirmMismatch' });

  const core = getCore();
  try {
    const deleted = await deleteArchivedEvent(core, eventId);
    await audit(core.db, session, 'event.delete', 'event', eventId, {
      title: deleted.title,
      slug: deleted.slug,
    });
  } catch (err) {
    if (err instanceof DomainError) {
      if (err.code === 'EVENT_HAS_ORDERS') return formError('eventHasOrders');
      if (err.code === 'EVENT_NOT_ARCHIVED') return formError('eventNotArchived');
      if (err.code === 'EVENT_NOT_FOUND') return formError('notFound');
    }
    throw err;
  }
  await refreshShop(eventTags(eventId));
  redirect({ href: '/admin/events?deleted=1', locale: await getLocale() });
  return success('deleted');
}

/**
 * Duplicates an event (settings, seating plan, categories, tariffs, fees, templates …) into a
 * new DRAFT event. The admin gives title, start and optionally a slug; other dates shift by
 * the same offset. Redirects to the new event.
 */
export async function duplicateEventAction(
  sourceEventId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const row = await getEventWithVenue(sourceEventId);
  if (!row) return formError('notFound');
  const errors: Partial<Record<string, FieldErrorCode>> = {};
  const title = text(fd, 'title') ?? '';
  if (!title) errors.title = 'required';
  else if (title.length > 200) errors.title = 'tooLong';
  const slug = text(fd, 'slug');
  if (slug && (slug.length > 80 || !SLUG_PATTERN.test(slug))) errors.slug = 'slugFormat';
  const dates = readDates(fd, row.event.timeZone, ['startsAt'], errors);
  if (!dates.startsAt && !errors.startsAt) errors.startsAt = 'required';
  if (Object.keys(errors).length > 0) return fieldError(errors);

  const core = getCore();
  let newId: string;
  try {
    const created = await duplicateEvent(core, {
      sourceEventId,
      userId: session.userId,
      title,
      slug: slug ?? null,
      startsAt: dates.startsAt!,
    });
    newId = created.eventId;
    await audit(core.db, session, 'event.duplicate', 'event', newId, {
      sourceEventId,
      title,
      slug: created.slug,
    });
  } catch (err) {
    if (err instanceof DomainError) {
      if (err.code === 'SLUG_TAKEN') return fieldError({ slug: 'slugTaken' });
      if (err.code === 'INVALID_DATES') return fieldError({ startsAt: 'dateOrder' });
      if (err.code === 'EVENT_NOT_FOUND') return formError('notFound');
    }
    throw err;
  }
  await refreshShop(eventTags(newId));
  redirect({ href: `/admin/events/${newId}?duplicated=1`, locale: await getLocale() });
  return success('created');
}
