'use server';

import { accessCodes, events, isUniqueViolation } from '@tix/db';
import { ACCESS_CODE_TYPES } from '@tix/shared';
import { generateHumanCode } from '@tix/shared/server';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState, FieldErrorCode } from '@/lib/action-state';
import { zonedWallTimeToUtc } from '@/lib/datetime';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { fieldError, flag, formError, success, text, zodFieldErrors } from './form';

const CODE_PATTERN = /^[A-Z0-9-]{4,64}$/;
const BATCH_MAX = 500;

const schema = z.object({
  mode: z.enum(['single', 'batch']),
  code: z.string().optional(),
  count: z.coerce.number().int().min(1).max(BATCH_MAX).optional(),
  prefix: z
    .string()
    .max(20)
    .regex(/^[A-Za-z0-9]*$/, 'codeFormat')
    .optional(),
  label: z.string().max(200).optional(),
  type: z.enum(ACCESS_CODE_TYPES),
  maxRedemptions: z.coerce.number().int().min(1).max(1_000_000).optional(),
  maxTicketsPerOrder: z.coerce.number().int().min(1).max(500).optional(),
  maxTicketsTotal: z.coerce.number().int().min(1).max(1_000_000).optional(),
});

export async function createAccessCodesAction(
  eventId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const { db } = getCore();
  const [event] = await db
    .select({ timeZone: events.timeZone })
    .from(events)
    .where(eq(events.id, eventId));
  if (!event) return formError('notFound');

  const parsed = schema.safeParse({
    mode: text(fd, 'mode') ?? 'single',
    code: text(fd, 'code'),
    count: text(fd, 'count'),
    prefix: text(fd, 'prefix'),
    label: text(fd, 'label'),
    type: text(fd, 'type'),
    maxRedemptions: text(fd, 'maxRedemptions'),
    maxTicketsPerOrder: text(fd, 'maxTicketsPerOrder'),
    maxTicketsTotal: text(fd, 'maxTicketsTotal'),
  });
  const errors: Partial<Record<string, FieldErrorCode>> = parsed.success
    ? {}
    : zodFieldErrors(parsed.error);
  const validFromRaw = text(fd, 'validFrom');
  const validUntilRaw = text(fd, 'validUntil');
  const validFrom = validFromRaw ? zonedWallTimeToUtc(validFromRaw, event.timeZone) : null;
  const validUntil = validUntilRaw ? zonedWallTimeToUtc(validUntilRaw, event.timeZone) : null;
  if (validFromRaw && !validFrom) errors.validFrom = 'invalid';
  if (validUntilRaw && !validUntil) errors.validUntil = 'invalid';
  if (validFrom && validUntil && validFrom >= validUntil) errors.validUntil = 'dateOrder';

  let singleCode: string | null = null;
  if (parsed.success && parsed.data.mode === 'single') {
    singleCode = (parsed.data.code ?? '').toUpperCase().replace(/\s+/g, '');
    if (!singleCode) errors.code = 'required';
    else if (!CODE_PATTERN.test(singleCode)) errors.code = 'codeFormat';
  }
  if (parsed.success && parsed.data.mode === 'batch' && !parsed.data.count)
    errors.count = 'required';
  if (!parsed.success || Object.keys(errors).length > 0) return fieldError(errors);

  const data = parsed.data;
  const base = {
    eventId,
    label: data.label ?? null,
    type: data.type,
    maxRedemptions: data.type === 'SINGLE_USE' ? 1 : (data.maxRedemptions ?? null),
    maxTicketsPerOrder: data.maxTicketsPerOrder ?? null,
    maxTicketsTotal: data.maxTicketsTotal ?? null,
    bypassesQueue: flag(fd, 'bypassesQueue'),
    grantsPresaleAccess: flag(fd, 'grantsPresaleAccess'),
    validFrom,
    validUntil,
    createdByUserId: session.userId,
  };

  if (singleCode) {
    try {
      await db.insert(accessCodes).values({ ...base, code: singleCode });
    } catch (err) {
      if (isUniqueViolation(err, 'access_codes_code_uq')) return fieldError({ code: 'codeTaken' });
      throw err;
    }
    await audit(db, session, 'accesscode.create', 'event', eventId, {
      code: singleCode,
      type: data.type,
    });
  } else {
    const prefix = data.prefix ? `${data.prefix.toUpperCase()}-` : '';
    let created = 0;
    // Random collisions are astronomically rare (32^10); retry a few rounds anyway.
    for (let round = 0; round < 5 && created < data.count!; round += 1) {
      const batch = Array.from({ length: data.count! - created }, () => ({
        ...base,
        code: `${prefix}${generateHumanCode(10)}`,
      }));
      const inserted = await db
        .insert(accessCodes)
        .values(batch)
        .onConflictDoNothing()
        .returning({ id: accessCodes.id });
      created += inserted.length;
    }
    await audit(db, session, 'accesscode.batch', 'event', eventId, {
      count: created,
      type: data.type,
      prefix,
    });
  }
  revalidatePath('/', 'layout');
  return success('created');
}

export async function setAccessCodeActiveAction(
  eventId: string,
  codeId: string,
  active: boolean,
  _prev: ActionState,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const { db } = getCore();
  const updated = await db
    .update(accessCodes)
    .set({ isActive: active })
    .where(and(eq(accessCodes.id, codeId), eq(accessCodes.eventId, eventId)))
    .returning({ code: accessCodes.code });
  if (updated.length === 0) return formError('notFound');
  await audit(
    db,
    session,
    active ? 'accesscode.activate' : 'accesscode.deactivate',
    'access_code',
    codeId,
    {
      code: updated[0]!.code,
    },
  );
  revalidatePath('/', 'layout');
  return success('saved');
}
