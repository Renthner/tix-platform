'use server';

import {
  DomainError,
  createDiscountCode,
  createDiscountCodesBulk,
  deleteDiscountCode,
  getSetting,
  setDiscountCodeActive,
  updateDiscountCode,
} from '@tix/core';
import { withTransaction } from '@tix/db';
import {
  discountBulkInputSchema,
  discountCodeInputSchema,
  exceedsPercentCap,
  parseFeeAmountToCents,
  parsePercentToBp,
} from '@tix/shared';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState, FieldErrorCode } from '@/lib/action-state';
import { zonedWallTimeToUtc } from '@/lib/datetime';
import { redirect } from '@/i18n/navigation';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { fieldError, flag, formError, success, text, zodFieldErrors } from './form';

/** Discount codes (admin): EVENT_MANAGER and FINANCE (SUPER_ADMIN always passes). */
const ROLES = ['EVENT_MANAGER', 'FINANCE'] as const;

const optionalInt = (raw: string | undefined) => {
  if (raw === undefined) return null;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
};

/** Raw form → canonical input (field errors are returned as codes). */
async function parseForm(fd: FormData, bulk: boolean) {
  const errors: Partial<Record<string, FieldErrorCode>> = {};
  const { defaultTimeZone } = await getSetting(getCore(), 'general');
  const type = text(fd, 'type') === 'PERCENT' ? 'PERCENT' : 'FIXED';
  const rawValue = text(fd, 'value');
  const value =
    rawValue === undefined
      ? null
      : type === 'PERCENT'
        ? parsePercentToBp(rawValue)
        : parseFeeAmountToCents(rawValue);
  if (rawValue === undefined) errors.value = 'required';
  else if (value === null || value < 1) errors.value = type === 'PERCENT' ? 'percent' : 'money';

  const date = (name: string) => {
    const raw = text(fd, name);
    if (!raw) return null;
    const parsed = zonedWallTimeToUtc(raw, defaultTimeZone);
    if (!parsed) errors[name] = 'invalid';
    return parsed;
  };
  const validFrom = date('validFrom');
  const validUntil = date('validUntil');

  const maxTotalUses = optionalInt(text(fd, 'maxTotalUses'));
  const maxUsesPerEmail = optionalInt(text(fd, 'maxUsesPerEmail'));
  if (Number.isNaN(maxTotalUses)) errors.maxTotalUses = 'invalid';
  if (Number.isNaN(maxUsesPerEmail)) errors.maxUsesPerEmail = 'invalid';
  const rawMin = text(fd, 'minOrderValue');
  const minOrderValue = rawMin === undefined ? null : parseFeeAmountToCents(rawMin);
  if (rawMin !== undefined && minOrderValue === null) errors.minOrderValue = 'money';

  const base = {
    type,
    value: value ?? 0,
    allEvents: text(fd, 'scope') !== 'selected',
    eventIds: fd.getAll('eventIds').map(String),
    categoryIds: fd.getAll('categoryIds').map(String),
    ticketTypeIds: fd.getAll('ticketTypeIds').map(String),
    validFrom,
    validUntil,
    maxTotalUses: Number.isNaN(maxTotalUses) ? null : maxTotalUses,
    maxUsesPerEmail: Number.isNaN(maxUsesPerEmail) ? null : maxUsesPerEmail,
    minOrderValue,
    discountFees: flag(fd, 'discountFees'),
    stackable: flag(fd, 'stackable'),
    isActive: true,
    note: text(fd, 'note') ?? null,
  };
  const parsed = bulk
    ? discountBulkInputSchema.safeParse({
        ...base,
        count: Number(text(fd, 'count') ?? Number.NaN),
        prefix: text(fd, 'prefix') ?? '',
      })
    : discountCodeInputSchema.safeParse({ ...base, code: text(fd, 'code') ?? '' });
  if (!parsed.success) Object.assign(errors, { ...zodFieldErrors(parsed.error), ...errors });
  return { errors, data: parsed.success ? parsed.data : null };
}

function mapError(err: unknown): ActionState {
  if (!(err instanceof DomainError)) throw err;
  if (err.code === 'DISCOUNT_CODE_TAKEN') return fieldError({ code: 'codeTaken' });
  if (err.code === 'DISCOUNT_CODE_NOT_FOUND') return formError('notFound');
  if (err.code === 'DISCOUNT_CODE_USED') return formError('inUse');
  return formError('generic');
}

/** Create (`codeId` null; single code or, with `mode=bulk`, a batch) or update a code. */
export async function saveDiscountCodeAction(
  codeId: string | null,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(ROLES);
  const core = getCore();
  const bulk = !codeId && text(fd, 'mode') === 'bulk';
  const { errors, data } = await parseForm(fd, bulk);
  if (!codeId && !bulk && !text(fd, 'code')) errors.code = 'required';
  // Organiser policy: percentage codes above the configured cap cannot be saved.
  if (
    data &&
    !errors.value &&
    exceedsPercentCap(
      data.type,
      data.value,
      (await getSetting(core, 'checkout')).maxDiscountPercent,
    )
  ) {
    errors.value = 'percentCap';
  }
  if (Object.keys(errors).length > 0 || !data) return fieldError(errors);
  try {
    if (codeId) {
      const { code: _code, ...settings } = data as z.output<typeof discountCodeInputSchema>;
      await withTransaction(core.db, async (tx) => {
        const { before, after } = await updateDiscountCode(tx, codeId, {
          ...settings,
          isActive: flag(fd, 'isActive'),
        });
        await audit(tx, session, 'discount.update', 'discount_code', codeId, {
          code: after.code,
          before: pick(before),
          after: pick(after),
        });
      });
    } else if (bulk) {
      const input = data as z.output<typeof discountBulkInputSchema>;
      const result = await withTransaction(core.db, async (tx) => {
        const created = await createDiscountCodesBulk(tx, input, session.userId);
        await audit(tx, session, 'discount.bulk', 'discount_code', null, {
          batchId: created.batchId,
          count: created.codes.length,
          prefix: input.prefix,
        });
        return created;
      });
      revalidatePath('/', 'layout');
      return redirect({
        href: `/admin/discounts?batch=${result.batchId}`,
        locale: await getLocale(),
      });
    } else {
      const input = data as z.output<typeof discountCodeInputSchema>;
      await withTransaction(core.db, async (tx) => {
        const row = await createDiscountCode(tx, input, session.userId);
        await audit(tx, session, 'discount.create', 'discount_code', row.id, {
          code: row.code,
          type: row.type,
          value: row.value,
        });
      });
    }
  } catch (err) {
    return mapError(err);
  }
  revalidatePath('/', 'layout');
  return success(codeId ? 'saved' : 'created');
}

function pick(row: Record<string, unknown>) {
  const { createdAt: _c, updatedAt: _u, ...rest } = row;
  return rest;
}

export async function setDiscountCodeActiveAction(
  codeId: string,
  isActive: boolean,
  _prev: ActionState,
): Promise<ActionState> {
  const session = await requireAdmin(ROLES);
  try {
    await withTransaction(getCore().db, async (tx) => {
      const row = await setDiscountCodeActive(tx, codeId, isActive);
      await audit(
        tx,
        session,
        isActive ? 'discount.activate' : 'discount.deactivate',
        'discount_code',
        codeId,
        { code: row.code },
      );
    });
  } catch (err) {
    return mapError(err);
  }
  revalidatePath('/', 'layout');
  return success('saved');
}

export async function deleteDiscountCodeAction(
  codeId: string,
  _prev: ActionState,
): Promise<ActionState> {
  const session = await requireAdmin(ROLES);
  try {
    await withTransaction(getCore().db, async (tx) => {
      const row = await deleteDiscountCode(tx, codeId);
      await audit(tx, session, 'discount.delete', 'discount_code', codeId, { code: row.code });
    });
  } catch (err) {
    return mapError(err);
  }
  revalidatePath('/', 'layout');
  return success('deleted');
}
