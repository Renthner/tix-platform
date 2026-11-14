import 'server-only';
import {
  DomainError,
  canAccessEventShop,
  getEventCached,
  getSetting,
  requireShopAccess,
  type AccessDecision,
  type CoreContext,
  type EventRow,
  type ShopActor,
} from '@tix/core';
import { getCore } from './core';
import { clientIp, enforceRateLimit, uuidParam } from './http';
import { ensureSessionId, readPassToken, writePassToken } from './session';
import { getShopActor } from './shop-actor';

export async function loadShopEvent(
  rawEventId: string,
): Promise<{ core: CoreContext; event: EventRow; actor: ShopActor | null }> {
  const core = getCore();
  const event = await getEventCached(core, uuidParam.parse(rawEventId));
  // Draft events exist only for signed-in super-admins; everybody else gets the same 404 as for
  // an unknown id (checked on every request, before any shop data is touched).
  const actor = await getShopActor();
  if (!canAccessEventShop(event, actor)) {
    throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  }
  return { core, event, actor };
}

/** Session + valid QueuePassToken + per-session/IP rate limits for cart mutations. */
export async function authorizeShopMutation(
  core: CoreContext,
  event: EventRow,
  actor: ShopActor | null = null,
): Promise<string> {
  const sid = await ensureSessionId();
  const { seatRequestsPerIpPerMinute } = await getSetting(core, 'checkout');
  await Promise.all([
    enforceRateLimit('shop-session', sid, 120, 60_000),
    // Safety net per IP address (configurable, off when empty / 0).
    seatRequestsPerIpPerMinute
      ? enforceRateLimit('shop-ip', await clientIp(), seatRequestsPerIpPerMinute, 60_000)
      : Promise.resolve(),
  ]);
  await requireShopAccess(core, event, sid, await readPassToken(event.id), actor);
  return sid;
}

export type PublicDecision =
  { status: 'GRANTED'; passExpiresAt: number } | Exclude<AccessDecision, { status: 'GRANTED' }>;

/** Strips the pass token from a decision – it travels only as an HttpOnly cookie. */
export async function respondWithDecision(
  eventId: string,
  decision: AccessDecision,
): Promise<PublicDecision> {
  if (decision.status === 'GRANTED') {
    await writePassToken(eventId, decision.passToken, decision.passExpiresAt);
    return { status: 'GRANTED', passExpiresAt: decision.passExpiresAt };
  }
  return decision;
}
