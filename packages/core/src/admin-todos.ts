import { accessCodes, bankTransactions, orders, waitlistEntries } from '@tix/db';
import { and, count, eq, gt, isNotNull, lt, sql } from 'drizzle-orm';
import type { CoreContext } from './context';
import { countAdjustmentsNeedingAttention } from './orders/adjustments';
import { countOpenRefunds } from './orders/refunds';

/** Access codes ending within this many days count as "expiring". */
export const EXPIRING_CODE_DAYS = 7;

export interface AdminTodoCounts {
  /** Bank transactions in the Klärfälle queue. */
  bankReview: number;
  /** Unpaid Vorkasse orders past their payment deadline. */
  overdueTransfers: number;
  openRefunds: number;
  openAdjustments: number;
  /** Confirmed waiting-list entries still waiting for tickets (armed). */
  waitlistPending: number;
  /** Active access codes that expire within `EXPIRING_CODE_DAYS` days. */
  expiringCodes: number;
}

/** Counts behind the dashboard to-do tiles and the navigation badges (cheap indexed counts). */
export async function getAdminTodoCounts(
  ctx: Pick<CoreContext, 'db'>,
  now = new Date(),
): Promise<AdminTodoCounts> {
  const one = async <T extends { n: number }>(q: PromiseLike<T[]>) => (await q)[0]?.n ?? 0;
  const soon = new Date(now.getTime() + EXPIRING_CODE_DAYS * 86_400_000);
  const [
    bankReview,
    overdueTransfers,
    openRefunds,
    openAdjustments,
    waitlistPending,
    expiringCodes,
  ] = await Promise.all([
    one(
      ctx.db
        .select({ n: count() })
        .from(bankTransactions)
        .where(eq(bankTransactions.matchStatus, 'NEEDS_REVIEW')),
    ),
    one(
      ctx.db
        .select({ n: count() })
        .from(orders)
        .where(
          and(
            eq(orders.status, 'AWAITING_PAYMENT'),
            eq(orders.isTest, false),
            lt(orders.paymentDueAt, now),
          ),
        ),
    ),
    countOpenRefunds(ctx),
    countAdjustmentsNeedingAttention(ctx),
    one(
      ctx.db
        .select({ n: count() })
        .from(waitlistEntries)
        .where(and(isNotNull(waitlistEntries.confirmedAt), eq(waitlistEntries.armed, true))),
    ),
    one(
      ctx.db
        .select({ n: count() })
        .from(accessCodes)
        .where(
          and(
            eq(accessCodes.isActive, true),
            gt(accessCodes.validUntil, now),
            lt(accessCodes.validUntil, soon),
            sql`(${accessCodes.maxRedemptions} IS NULL OR ${accessCodes.redemptionCount} < ${accessCodes.maxRedemptions})`,
          ),
        ),
    ),
  ]);
  return {
    bankReview,
    overdueTransfers,
    openRefunds,
    openAdjustments,
    waitlistPending,
    expiringCodes,
  };
}

/** Klärfälle in the bank review queue (navigation badge). */
export async function countBankReview(ctx: Pick<CoreContext, 'db'>): Promise<number> {
  const [row] = await ctx.db
    .select({ n: count() })
    .from(bankTransactions)
    .where(eq(bankTransactions.matchStatus, 'NEEDS_REVIEW'));
  return row?.n ?? 0;
}
