import { orders } from '@tix/db';
import { and, eq, sql } from 'drizzle-orm';
import type { CoreContext } from '../context';
import { enqueueEmail } from '../email';
import { resendableEmail } from './admin';

/** Every request takes at least this long, whether the data matched or not. */
const MIN_DURATION_MS = 400;

const normalise = (value: string) => value.trim().toLowerCase();

/**
 * "Find my order" for guests: when order number and e-mail address belong together, the e-mail of
 * the order's current state (payment instructions / tickets / cancellation – all of them carry the
 * personal access link) is sent to the address on the order. The result never tells whether the
 * data matched: callers show the same neutral answer, and the duration is padded so the response
 * time does not reveal it either. Box office orders (no e-mail) and test orders never match.
 */
export async function requestOrderAccessLink(
  ctx: CoreContext,
  input: { orderNumber: string; email: string },
): Promise<void> {
  const started = Date.now();
  try {
    const orderNumber = input.orderNumber.trim();
    const email = normalise(input.email);
    if (orderNumber && email) {
      const [order] = await ctx.db
        .select({
          id: orders.id,
          status: orders.status,
          method: orders.paymentMethod,
          isTest: orders.isTest,
        })
        .from(orders)
        .where(
          and(
            sql`upper(${orders.orderNumber}) = upper(${orderNumber})`,
            eq(sql`lower(${orders.email})`, email),
          ),
        );
      if (order && !order.isTest) {
        const key = resendableEmail(order.status, order.method);
        if (key) await enqueueEmail(ctx, { key, orderId: order.id });
      }
    }
  } finally {
    const remaining = MIN_DURATION_MS - (Date.now() - started);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}
