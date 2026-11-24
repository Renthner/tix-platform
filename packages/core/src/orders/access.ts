import { orderHistory, orders } from '@tix/db';
import { signToken, verifyToken } from '@tix/shared/server';
import { eq, sql } from 'drizzle-orm';
import { DomainError, requireCapability, type CoreContext } from '../context';

/**
 * Guest access to an order: an HMAC-signed, unguessable link (no account needed). It is
 * sent in every order e-mail and shown after checkout; customers with an account see their
 * orders after login as well.
 *
 * Every token embeds `orders.token_version` (claim `v`, omitted while 0 so tokens issued before
 * the version existed stay valid). An admin reset (`revokeOrderAccessTokens`) bumps the version,
 * which invalidates all earlier links; mails sent afterwards carry the new version.
 */
const ORDER_TOKEN_TYPE = 'order';
/** Long enough for event day and later invoice downloads. */
const ORDER_TOKEN_TTL_SECONDS = 3 * 365 * 24 * 3600;

/** Signs a token for the given token version (`orders.token_version`; default 0 = never reset). */
export function orderAccessToken(
  ctx: Pick<CoreContext, 'sessionSecret'>,
  orderId: string,
  tokenVersion = 0,
): string {
  const claims = tokenVersion > 0 ? { oid: orderId, v: tokenVersion } : { oid: orderId };
  return signToken(ORDER_TOKEN_TYPE, claims, ORDER_TOKEN_TTL_SECONDS, ctx.sessionSecret);
}

/** Signs a token for the order's CURRENT token version (reads it from the database). */
export async function issueOrderAccessToken(ctx: CoreContext, orderId: string): Promise<string> {
  const [row] = await ctx.db
    .select({ tokenVersion: orders.tokenVersion })
    .from(orders)
    .where(eq(orders.id, orderId));
  return orderAccessToken(ctx, orderId, row?.tokenVersion ?? 0);
}

/** Signature/expiry check only: order id and embedded version (missing = 0). No database access. */
export function parseOrderAccessToken(
  ctx: Pick<CoreContext, 'sessionSecret'>,
  token: string | null | undefined,
): { orderId: string; version: number } | null {
  const claims = verifyToken<{ oid: string; v?: unknown }>(
    token,
    ORDER_TOKEN_TYPE,
    ctx.sessionSecret,
  );
  if (!claims || typeof claims.oid !== 'string') return null;
  if (claims.v === undefined) return { orderId: claims.oid, version: 0 };
  if (typeof claims.v !== 'number' || !Number.isInteger(claims.v) || claims.v < 0) return null;
  return { orderId: claims.oid, version: claims.v };
}

/** Order id from a valid access token whose version matches the order's current one, else null. */
export async function verifyOrderAccessToken(
  ctx: CoreContext,
  token: string | null | undefined,
): Promise<string | null> {
  const parsed = parseOrderAccessToken(ctx, token);
  if (!parsed) return null;
  const [row] = await ctx.db
    .select({ tokenVersion: orders.tokenVersion })
    .from(orders)
    .where(eq(orders.id, parsed.orderId));
  return row && row.tokenVersion === parsed.version ? parsed.orderId : null;
}

/**
 * Admin reset: invalidates every access link issued so far for this order (e.g. after a link
 * leaked). Links in e-mails sent afterwards (resend) carry the new version.
 */
export async function revokeOrderAccessTokens(
  ctx: CoreContext,
  orderId: string,
  actor: { userId: string | null },
): Promise<{ tokenVersion: number }> {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(orders)
      .set({ tokenVersion: sql`${orders.tokenVersion} + 1` })
      .where(eq(orders.id, orderId))
      .returning({ tokenVersion: orders.tokenVersion });
    if (!row) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    await tx.insert(orderHistory).values({
      orderId,
      type: 'access_tokens_revoked',
      actorType: 'ADMIN',
      actorUserId: actor.userId,
      data: { tokenVersion: row.tokenVersion },
    });
    return { tokenVersion: row.tokenVersion };
  });
}

/** Absolute link to the order page, e.g. https://shop.example/de/orders/2026-000042?t=… */
export function orderUrl(
  ctx: CoreContext,
  order: { id: string; orderNumber: string; locale: string; tokenVersion: number },
): string {
  const base = requireCapability(ctx, 'appUrl');
  const token = encodeURIComponent(orderAccessToken(ctx, order.id, order.tokenVersion));
  return `${base}/${order.locale}/orders/${encodeURIComponent(order.orderNumber)}?t=${token}`;
}
