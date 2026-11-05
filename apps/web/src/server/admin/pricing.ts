'use server';

import { invalidatePublicSeatMap, seatMapVersion } from '@tix/core';
import {
  events,
  findPgError,
  isUniqueViolation,
  PG_ERROR,
  priceCategories,
  priceCategoryTicketTypes,
  ticketTypes,
  withTransaction,
} from '@tix/db';
import { DISCOUNT_KINDS, SALES_CHANNELS, SEAT_FEATURES } from '@tix/shared';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState, FieldErrorCode } from '@/lib/action-state';
import { parseMoneyToCents, parsePercentToBasisPoints } from '@/lib/money';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { fieldError, flag, formError, success, text, zodFieldErrors } from './form';

/** Pricing changes alter the public seat-map snapshot (prices per tariff) → drop it. */
async function refreshSnapshot(eventId: string): Promise<void> {
  const core = getCore();
  const [event] = await core.db
    .select({ seatMapId: events.seatMapId })
    .from(events)
    .where(eq(events.id, eventId));
  if (!event?.seatMapId) return;
  await invalidatePublicSeatMap(core, eventId, await seatMapVersion(core, event.seatMapId));
}

function money(
  fd: FormData,
  name: string,
  errors: Partial<Record<string, FieldErrorCode>>,
  required: boolean,
) {
  const raw = text(fd, name);
  if (!raw) {
    if (required) errors[name] = 'required';
    return null;
  }
  const cents = parseMoneyToCents(raw);
  if (cents === null) errors[name] = 'money';
  return cents;
}

function isReferenced(err: unknown): boolean {
  const code = findPgError(err)?.code;
  return code === PG_ERROR.FOREIGN_KEY_VIOLATION || code === PG_ERROR.RESTRICT_VIOLATION;
}

async function eventExists(eventId: string): Promise<boolean> {
  const [row] = await getCore()
    .db.select({ id: events.id })
    .from(events)
    .where(eq(events.id, eventId));
  return Boolean(row);
}

// ─── Price categories ───────────────────────────────────────────────────────

const categorySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'invalid'),
  maxTicketsPerOrder: z.coerce.number().int().min(1).max(500).optional(),
  sortOrder: z.coerce.number().int().min(-10_000).max(10_000).default(0),
});

export async function saveCategoryAction(
  eventId: string,
  categoryId: string | null,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  if (!(await eventExists(eventId))) return formError('notFound');
  const parsed = categorySchema.safeParse({
    name: text(fd, 'name'),
    description: text(fd, 'description'),
    color: text(fd, 'color'),
    maxTicketsPerOrder: text(fd, 'maxTicketsPerOrder'),
    sortOrder: text(fd, 'sortOrder'),
  });
  const errors: Partial<Record<string, FieldErrorCode>> = parsed.success
    ? {}
    : zodFieldErrors(parsed.error);
  const basePrice = money(fd, 'basePrice', errors, true);
  if (!parsed.success || Object.keys(errors).length > 0) return fieldError(errors);

  const values = {
    ...parsed.data,
    description: parsed.data.description ?? null,
    maxTicketsPerOrder: parsed.data.maxTicketsPerOrder ?? null,
    basePrice: basePrice!,
    isActive: flag(fd, 'isActive'),
  };
  const { db } = getCore();
  try {
    await withTransaction(db, async (tx) => {
      if (categoryId) {
        const updated = await tx
          .update(priceCategories)
          .set(values)
          .where(and(eq(priceCategories.id, categoryId), eq(priceCategories.eventId, eventId)))
          .returning({ id: priceCategories.id });
        if (updated.length === 0) throw new Error('NOT_FOUND');
        await audit(tx, session, 'pricecategory.update', 'price_category', categoryId, values);
      } else {
        const [created] = await tx
          .insert(priceCategories)
          .values({ ...values, eventId })
          .returning({ id: priceCategories.id });
        // A new category is offered with every tariff by default.
        const types = await tx
          .select({ id: ticketTypes.id })
          .from(ticketTypes)
          .where(eq(ticketTypes.eventId, eventId));
        if (types.length > 0) {
          await tx
            .insert(priceCategoryTicketTypes)
            .values(types.map((t) => ({ priceCategoryId: created!.id, ticketTypeId: t.id })));
        }
        await audit(tx, session, 'pricecategory.create', 'price_category', created!.id, values);
      }
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_FOUND') return formError('notFound');
    if (isUniqueViolation(err, 'price_categories_name_uq'))
      return fieldError({ name: 'nameTaken' });
    throw err;
  }
  await refreshSnapshot(eventId);
  revalidatePath('/', 'layout');
  return success(categoryId ? 'saved' : 'created');
}

export async function deleteCategoryAction(
  eventId: string,
  categoryId: string,
  _prev: ActionState,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const { db } = getCore();
  try {
    const deleted = await db
      .delete(priceCategories)
      .where(and(eq(priceCategories.id, categoryId), eq(priceCategories.eventId, eventId)))
      .returning({ name: priceCategories.name });
    if (deleted.length === 0) return formError('notFound');
    await audit(db, session, 'pricecategory.delete', 'price_category', categoryId, {
      name: deleted[0]!.name,
    });
  } catch (err) {
    if (isReferenced(err)) return formError('inUse');
    throw err;
  }
  await refreshSnapshot(eventId);
  revalidatePath('/', 'layout');
  return success('deleted');
}

// ─── Ticket types (tariffs) ─────────────────────────────────────────────────

const ticketTypeSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  discountKind: z.enum(DISCOUNT_KINDS),
  scannerWarning: z.string().max(200).optional(),
  requiredSeatFeature: z.enum(SEAT_FEATURES).optional(),
  maxPerOrder: z.coerce.number().int().min(1).max(500).optional(),
  sortOrder: z.coerce.number().int().min(-10_000).max(10_000).default(0),
  channels: z.array(z.enum(SALES_CHANNELS)).min(1, 'required'),
});

export async function saveTicketTypeAction(
  eventId: string,
  ticketTypeId: string | null,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  if (!(await eventExists(eventId))) return formError('notFound');
  const parsed = ticketTypeSchema.safeParse({
    name: text(fd, 'name'),
    description: text(fd, 'description'),
    discountKind: text(fd, 'discountKind'),
    scannerWarning: text(fd, 'scannerWarning'),
    requiredSeatFeature: text(fd, 'requiredSeatFeature'),
    maxPerOrder: text(fd, 'maxPerOrder'),
    sortOrder: text(fd, 'sortOrder'),
    channels: fd.getAll('channels').map(String),
  });
  const errors: Partial<Record<string, FieldErrorCode>> = parsed.success
    ? {}
    : zodFieldErrors(parsed.error);
  let discountValue = 0;
  if (parsed.success && parsed.data.discountKind !== 'NONE') {
    const raw = text(fd, 'discountValue');
    if (!raw) errors.discountValue = 'required';
    else if (parsed.data.discountKind === 'PERCENT') {
      const bp = parsePercentToBasisPoints(raw);
      if (bp === null) errors.discountValue = 'percent';
      else discountValue = bp;
    } else {
      const cents = parseMoneyToCents(raw);
      if (cents === null) errors.discountValue = 'money';
      else discountValue = cents;
    }
  }
  const requiresProofAtEntry = flag(fd, 'requiresProofAtEntry');
  if (parsed.success && requiresProofAtEntry && !parsed.data.scannerWarning)
    errors.scannerWarning = 'required';
  if (!parsed.success || Object.keys(errors).length > 0) return fieldError(errors);

  const data = parsed.data;
  const values = {
    name: data.name,
    description: data.description ?? null,
    discountKind: data.discountKind,
    discountValue,
    requiresProofAtEntry,
    scannerWarning: data.scannerWarning ?? null,
    requiredSeatFeature: data.requiredSeatFeature ?? null,
    maxPerOrder: data.maxPerOrder ?? null,
    channels: data.channels,
    isDefault: flag(fd, 'isDefault'),
    isActive: flag(fd, 'isActive'),
    sortOrder: data.sortOrder,
  };
  const { db } = getCore();
  try {
    await withTransaction(db, async (tx) => {
      let id = ticketTypeId;
      if (values.isDefault) {
        // Exactly one default tariff per event (partial unique index).
        await tx
          .update(ticketTypes)
          .set({ isDefault: false })
          .where(
            and(
              eq(ticketTypes.eventId, eventId),
              eq(ticketTypes.isDefault, true),
              ...(ticketTypeId ? [ne(ticketTypes.id, ticketTypeId)] : []),
            ),
          );
      }
      if (ticketTypeId) {
        const updated = await tx
          .update(ticketTypes)
          .set(values)
          .where(and(eq(ticketTypes.id, ticketTypeId), eq(ticketTypes.eventId, eventId)))
          .returning({ id: ticketTypes.id });
        if (updated.length === 0) throw new Error('NOT_FOUND');
      } else {
        const [created] = await tx
          .insert(ticketTypes)
          .values({ ...values, eventId })
          .returning({ id: ticketTypes.id });
        id = created!.id;
        const categories = await tx
          .select({ id: priceCategories.id })
          .from(priceCategories)
          .where(eq(priceCategories.eventId, eventId));
        if (categories.length > 0) {
          await tx
            .insert(priceCategoryTicketTypes)
            .values(categories.map((c) => ({ priceCategoryId: c.id, ticketTypeId: id! })));
        }
      }
      await audit(
        tx,
        session,
        ticketTypeId ? 'tickettype.update' : 'tickettype.create',
        'ticket_type',
        id,
        values,
      );
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_FOUND') return formError('notFound');
    if (isUniqueViolation(err, 'ticket_types_name_uq')) return fieldError({ name: 'nameTaken' });
    throw err;
  }
  await refreshSnapshot(eventId);
  revalidatePath('/', 'layout');
  return success(ticketTypeId ? 'saved' : 'created');
}

export async function deleteTicketTypeAction(
  eventId: string,
  ticketTypeId: string,
  _prev: ActionState,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const { db } = getCore();
  try {
    const deleted = await db
      .delete(ticketTypes)
      .where(and(eq(ticketTypes.id, ticketTypeId), eq(ticketTypes.eventId, eventId)))
      .returning({ name: ticketTypes.name });
    if (deleted.length === 0) return formError('notFound');
    await audit(db, session, 'tickettype.delete', 'ticket_type', ticketTypeId, {
      name: deleted[0]!.name,
    });
  } catch (err) {
    if (isReferenced(err)) return formError('inUse');
    throw err;
  }
  await refreshSnapshot(eventId);
  revalidatePath('/', 'layout');
  return success('deleted');
}

// ─── Availability matrix (category × tariff) ────────────────────────────────

/**
 * Per cell (`<categoryId>:<ticketTypeId>`):
 *  - `offer:<cell>`  "on" when the tariff is offered in the category,
 *  - `mode:<cell>`   default | price | amount | percent,
 *  - `value:<cell>`  fixed price / discount amount (major units) or discount in %.
 * Stored as price_override OR discount_kind + discount_value (never both).
 */
const MATRIX_MODES = ['default', 'price', 'amount', 'percent'] as const;

export async function saveMatrixAction(
  eventId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const { db } = getCore();
  const [categories, types] = await Promise.all([
    db
      .select({ id: priceCategories.id })
      .from(priceCategories)
      .where(eq(priceCategories.eventId, eventId)),
    db.select({ id: ticketTypes.id }).from(ticketTypes).where(eq(ticketTypes.eventId, eventId)),
  ]);
  if (categories.length === 0 && types.length === 0) return formError('notFound');

  const errors: Partial<Record<string, FieldErrorCode>> = {};
  const rows: {
    priceCategoryId: string;
    ticketTypeId: string;
    priceOverride: number | null;
    discountKind: 'FIXED_AMOUNT' | 'PERCENT' | null;
    discountValue: number | null;
  }[] = [];
  for (const c of categories) {
    for (const t of types) {
      const cell = `${c.id}:${t.id}`;
      if (!flag(fd, `offer:${cell}`)) continue;
      const mode = MATRIX_MODES.find((m) => m === text(fd, `mode:${cell}`)) ?? 'default';
      const valueKey = `value:${cell}`;
      const raw = text(fd, valueKey);
      const row = {
        priceCategoryId: c.id,
        ticketTypeId: t.id,
        priceOverride: null as number | null,
        discountKind: null as 'FIXED_AMOUNT' | 'PERCENT' | null,
        discountValue: null as number | null,
      };
      if (mode !== 'default') {
        if (!raw) {
          errors[valueKey] = 'required';
        } else if (mode === 'percent') {
          const bp = parsePercentToBasisPoints(raw);
          if (bp === null) errors[valueKey] = 'percent';
          else Object.assign(row, { discountKind: 'PERCENT', discountValue: bp });
        } else {
          const cents = parseMoneyToCents(raw);
          if (cents === null) errors[valueKey] = 'money';
          else if (mode === 'price') row.priceOverride = cents;
          else Object.assign(row, { discountKind: 'FIXED_AMOUNT', discountValue: cents });
        }
      }
      rows.push(row);
    }
  }
  if (Object.keys(errors).length > 0) return fieldError(errors);

  await withTransaction(db, async (tx) => {
    if (categories.length > 0) {
      await tx.delete(priceCategoryTicketTypes).where(
        inArray(
          priceCategoryTicketTypes.priceCategoryId,
          categories.map((c) => c.id),
        ),
      );
    }
    if (rows.length > 0) await tx.insert(priceCategoryTicketTypes).values(rows);
    await audit(tx, session, 'pricing.matrix', 'event', eventId, { offered: rows.length });
  });
  await refreshSnapshot(eventId);
  revalidatePath('/', 'layout');
  return success('saved');
}
