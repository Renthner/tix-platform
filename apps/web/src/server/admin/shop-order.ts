'use server';

import { SHOP_TAGS } from '@tix/core';
import { events, withTransaction } from '@tix/db';
import { shopOrderInputSchema } from '@tix/shared';
import { eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import type { ActionState } from '@/lib/action-state';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { refreshShop } from './shop-refresh';
import { formError, success, text } from './form';

/** Saves the shop order: contiguous 0..n-1 for the given events, all others back to "by date". */
export async function saveShopOrderAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  let raw: unknown;
  try {
    raw = JSON.parse(text(fd, 'order') ?? '[]');
  } catch {
    return formError('generic');
  }
  const parsed = shopOrderInputSchema.safeParse(raw);
  if (!parsed.success) return formError('generic');
  const ids = parsed.data;

  const { db } = getCore();
  const ok = await withTransaction(db, async (tx) => {
    if (ids.length > 0) {
      const found = await tx.select({ id: events.id }).from(events).where(inArray(events.id, ids));
      if (found.length !== ids.length) return false;
    }
    await tx
      .update(events)
      .set({ shopSortOrder: null })
      .where(ids.length > 0 ? notInArray(events.id, ids) : isNotNull(events.shopSortOrder));
    for (const [index, id] of ids.entries()) {
      await tx.update(events).set({ shopSortOrder: index }).where(eq(events.id, id));
    }
    await audit(tx, session, 'event.shopOrder', 'event', null, { order: ids });
    return true;
  });
  if (!ok) return formError('notFound');
  await refreshShop([SHOP_TAGS.events]);
  return success('saved');
}

/** Removes the manual order; the shop is sorted by date again. */
export async function resetShopOrderAction(_prev: ActionState): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const { db } = getCore();
  await withTransaction(db, async (tx) => {
    await tx.update(events).set({ shopSortOrder: null }).where(isNotNull(events.shopSortOrder));
    await audit(tx, session, 'event.shopOrder', 'event', null, { reset: true });
  });
  await refreshShop([SHOP_TAGS.events]);
  return success('reset');
}
