'use server';

import { BULK_ORDER_ACTIONS, BULK_ORDER_LIMIT, runBulkOrderAction } from '@tix/core';
import type { BulkOrderOutcome } from '@tix/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { logger } from '@/server/logger';
import { audit } from './audit';

export type BulkOrderState =
  | { status: 'idle' }
  | { status: 'done'; action: string; results: BulkOrderOutcome[] }
  | { status: 'error'; code: 'INVALID' | 'INTERNAL_ERROR' };

const schema = z.object({
  action: z.enum(BULK_ORDER_ACTIONS),
  orderIds: z.array(z.uuid()).min(1).max(BULK_ORDER_LIMIT),
});

/** Bulk action on selected orders of the list (roles of the order list). */
export async function bulkOrderAction(action: string, orderIds: string[]): Promise<BulkOrderState> {
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  const parsed = schema.safeParse({ action, orderIds });
  if (!parsed.success) return { status: 'error', code: 'INVALID' };
  try {
    const core = getCore();
    const results = await runBulkOrderAction(core, {
      action: parsed.data.action,
      orderIds: parsed.data.orderIds,
      userId: session.userId,
    });
    await audit(core.db, session, `orders.bulk.${parsed.data.action}`, 'order', null, {
      requested: parsed.data.orderIds.length,
      done: results.filter((r) => r.outcome === 'done').length,
      skipped: results.filter((r) => r.outcome === 'skipped').length,
      failed: results.filter((r) => r.outcome === 'failed').length,
    });
    revalidatePath('/[locale]/admin/orders', 'layout');
    return { status: 'done', action: parsed.data.action, results };
  } catch (err) {
    logger.error({ err }, '[admin/orders] bulk action failed');
    return { status: 'error', code: 'INTERNAL_ERROR' };
  }
}
