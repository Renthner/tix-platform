import { adminAlerts } from '@tix/db';
import type { AdminAlertType } from '@tix/shared';
import { desc } from 'drizzle-orm';
import type { CoreContext } from '../context';
import type { AlertDetails } from './checks';

export interface AlertHistoryRow {
  id: string;
  type: AdminAlertType;
  details: AlertDetails;
  firstSeenAt: Date;
  lastSentAt: Date | null;
  sendCount: number;
  resolvedAt: Date | null;
}

/** Newest alerts first (admin System page). */
export async function listAlertHistory(
  ctx: Pick<CoreContext, 'db'>,
  limit = 50,
): Promise<AlertHistoryRow[]> {
  const rows = await ctx.db
    .select({
      id: adminAlerts.id,
      type: adminAlerts.type,
      details: adminAlerts.details,
      firstSeenAt: adminAlerts.firstSeenAt,
      lastSentAt: adminAlerts.lastSentAt,
      sendCount: adminAlerts.sendCount,
      resolvedAt: adminAlerts.resolvedAt,
    })
    .from(adminAlerts)
    .orderBy(desc(adminAlerts.firstSeenAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, type: r.type as AdminAlertType }));
}
