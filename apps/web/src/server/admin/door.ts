'use server';

import { DomainError, webDoorScan } from '@tix/core';
import type { ScanOutcome } from '@tix/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { logger } from '@/server/logger';

export type DoorActionState =
  | { status: 'ok'; outcome: ScanOutcome; ticketId: string; at: number }
  | { status: 'error'; code: string; ticketId: string; at: number };

const schema = z.object({
  eventId: z.uuid(),
  ticketId: z.uuid(),
  action: z.enum(['CHECK_IN', 'CHECK_OUT']),
  /** Generated once per click in the desk UI: a repeated request returns the first outcome. */
  clientScanId: z.uuid(),
});

/**
 * Manual check-in / check-out of one ticket at the web desk (door staff, event managers). The same
 * decision logic and journal as the Android scanner; the journal shows "Web (<name>)".
 */
export async function doorCheckAction(
  eventId: string,
  ticketId: string,
  action: 'CHECK_IN' | 'CHECK_OUT',
  clientScanId: string,
): Promise<DoorActionState> {
  const session = await requireAdmin(['EVENT_MANAGER', 'DOOR_STAFF']);
  const parsed = schema.safeParse({ eventId, ticketId, action, clientScanId });
  if (!parsed.success) return { status: 'error', code: 'INVALID', ticketId, at: Date.now() };
  try {
    const outcome = await webDoorScan(getCore(), {
      userId: session.userId,
      displayName: session.displayName,
      ...parsed.data,
    });
    revalidatePath('/[locale]/admin/door', 'layout');
    return { status: 'ok', outcome, ticketId, at: Date.now() };
  } catch (err) {
    if (err instanceof DomainError) {
      return { status: 'error', code: err.code, ticketId, at: Date.now() };
    }
    logger.error({ err }, '[admin/door] scan failed');
    return { status: 'error', code: 'INTERNAL_ERROR', ticketId, at: Date.now() };
  }
}
