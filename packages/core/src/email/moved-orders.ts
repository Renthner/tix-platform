import { events, orderItems, orders } from '@tix/db';
import { asc, eq, inArray } from 'drizzle-orm';
import type { CoreContext } from '../context';
import { mailTranslator } from '../i18n/mail-messages';
import { orderUrl } from '../orders/access';
import { escapeHtml, trustedHtml, type TrustedHtml } from './template';

/**
 * `{{movedOrders}}` of CUSTOMER_EMAIL_CHANGED_ORDERS: the orders moved to the customer's new
 * address, each with its order link. The outbox stores only the order ids (`movedOrderIds`); the
 * links are built when the message is rendered, so they always carry the CURRENT token version.
 */

const BUTTON =
  'display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:14px;margin:0 8px 8px 0';

export interface MovedOrderEntry {
  orderNumber: string;
  /** Null without `appUrl` (no absolute link possible). */
  url: string | null;
  /** Event titles of the order (comma-separated), optional. */
  events?: string;
}

/** Trusted HTML + text of the moved-orders list (pure; also used for the editor preview). */
export function movedOrdersVariable(entries: MovedOrderEntry[], locale: string): TrustedHtml {
  if (entries.length === 0) return trustedHtml('', '');
  const t = mailTranslator(locale);
  const html = entries
    .map((entry) => {
      const caption = [t('movedOrders.order', { number: entry.orderNumber }), entry.events]
        .filter(Boolean)
        .join(' · ');
      const button = entry.url
        ? `<p style="margin:0 0 14px"><a href="${escapeHtml(entry.url)}" style="${BUTTON}">${escapeHtml(t('movedOrders.viewOrder'))}</a></p>`
        : '';
      return `<p style="margin:0 0 4px;font-size:14px;font-weight:600">${escapeHtml(caption)}</p>${button}`;
    })
    .join('');
  const text = entries
    .map((entry) => {
      const caption = [t('movedOrders.order', { number: entry.orderNumber }), entry.events]
        .filter(Boolean)
        .join(' · ');
      return entry.url ? `${caption}\n${entry.url}` : caption;
    })
    .join('\n\n');
  return trustedHtml(html, text);
}

/**
 * Loads the stored moved orders for rendering. Only orders that still belong to `recipient` and
 * were not anonymised are listed (an order changed again since must not leak its new link here).
 */
export async function loadMovedOrders(
  ctx: CoreContext,
  orderIds: readonly string[],
  recipient: string | null,
): Promise<MovedOrderEntry[]> {
  if (orderIds.length === 0 || !recipient) return [];
  const rows = await ctx.db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      locale: orders.locale,
      tokenVersion: orders.tokenVersion,
      email: orders.email,
      anonymizedAt: orders.anonymizedAt,
    })
    .from(orders)
    .where(inArray(orders.id, [...orderIds]))
    .orderBy(asc(orders.createdAt), asc(orders.id));
  const wanted = recipient.trim().toLowerCase();
  const kept = rows.filter(
    (row) => !row.anonymizedAt && (row.email ?? '').trim().toLowerCase() === wanted,
  );
  if (kept.length === 0) return [];
  const titles = await ctx.db
    .selectDistinct({ orderId: orderItems.orderId, title: events.title, startsAt: events.startsAt })
    .from(orderItems)
    .innerJoin(events, eq(events.id, orderItems.eventId))
    .where(
      inArray(
        orderItems.orderId,
        kept.map((row) => row.id),
      ),
    )
    .orderBy(asc(events.startsAt));
  return kept.map((row) => ({
    orderNumber: row.orderNumber,
    url: ctx.appUrl ? orderUrl(ctx, row) : null,
    events:
      [...new Set(titles.filter((x) => x.orderId === row.id).map((x) => x.title))].join(', ') ||
      undefined,
  }));
}

/** Parses the stored `movedOrderIds` variable (comma-separated uuids). */
export function parseMovedOrderIds(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^[0-9a-f-]{36}$/i.test(id));
}
