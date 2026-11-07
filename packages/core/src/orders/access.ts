import { signToken, verifyToken } from '@tix/shared/server';
import { requireCapability, type CoreContext } from '../context';

/**
 * Guest access to an order: an HMAC-signed, unguessable link (no account needed). It is
 * sent in every order e-mail and shown after checkout; customers with an account see their
 * orders after login as well.
 */
const ORDER_TOKEN_TYPE = 'order';
/** Long enough for event day and later invoice downloads. */
const ORDER_TOKEN_TTL_SECONDS = 3 * 365 * 24 * 3600;

export function orderAccessToken(ctx: Pick<CoreContext, 'sessionSecret'>, orderId: string): string {
  return signToken(ORDER_TOKEN_TYPE, { oid: orderId }, ORDER_TOKEN_TTL_SECONDS, ctx.sessionSecret);
}

/** Order id from a valid access token, else null. */
export function verifyOrderAccessToken(
  ctx: Pick<CoreContext, 'sessionSecret'>,
  token: string | null | undefined,
): string | null {
  const claims = verifyToken<{ oid: string }>(token, ORDER_TOKEN_TYPE, ctx.sessionSecret);
  return claims && typeof claims.oid === 'string' ? claims.oid : null;
}

/** Absolute link to the order page, e.g. https://shop.example/de/orders/2026-000042?t=… */
export function orderUrl(
  ctx: CoreContext,
  order: { id: string; orderNumber: string; locale: string },
): string {
  const base = requireCapability(ctx, 'appUrl');
  const token = encodeURIComponent(orderAccessToken(ctx, order.id));
  return `${base}/${order.locale}/orders/${encodeURIComponent(order.orderNumber)}?t=${token}`;
}
