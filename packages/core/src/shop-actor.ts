import { computeSaleState, type EventRow, type SaleState } from './events';

/**
 * Who is using the shop. Core stays auth agnostic: the web layer derives the actor from the admin
 * session on EVERY request (role SUPER_ADMIN, two-factor set-up complete) and passes it down –
 * never from a client supplied flag. Absent = an ordinary customer.
 *
 * A super-admin may test-buy: draft events are visible and sellable, closed sale windows (presale,
 * not started, paused, sale end) are bypassed and the waiting room is skipped unless the admin
 * switched "test the waiting room" on (`queueTest`).
 */
export interface ShopActor {
  superAdmin: boolean;
  /** The super-admin wants to experience the waiting room like a customer. */
  queueTest?: boolean;
}

export type ShopActorLike = ShopActor | null | undefined;

export function isSuperAdminActor(actor: ShopActorLike): actor is ShopActor {
  return actor?.superAdmin === true;
}

/** Super-admins skip the waiting room (no queue slot, no "active shopper") unless testing it. */
export function bypassesQueue(actor: ShopActorLike): boolean {
  return isSuperAdminActor(actor) && !actor.queueTest;
}

/** Draft events exist for the public nowhere; only super-admins may open and buy them. */
export function isDraftEvent(event: Pick<EventRow, 'status'>): boolean {
  return event.status === 'DRAFT';
}

/** The event page / cart / checkout of this event may be used by the actor. */
export function canAccessEventShop(event: Pick<EventRow, 'status'>, actor: ShopActorLike): boolean {
  return !isDraftEvent(event) || isSuperAdminActor(actor);
}

/**
 * Sale state as the shop sees it for this actor.
 *
 * The bypass only WIDENS access, never narrows it: whenever customers could buy (`ON_SALE`), so
 * can the super-admin. Otherwise the closed sale windows (draft, presale, not started, paused,
 * sale end) are bypassed – but only until the event itself starts (then `ENDED`: nobody should
 * buy tickets for something that already began; the box office is the tool for door sales).
 * CANCELLED and ARCHIVED events stay closed for everyone.
 */
export function shopSaleState(event: EventRow, actor: ShopActorLike, now = new Date()): SaleState {
  const base = computeSaleState(event, now);
  if (base === 'ON_SALE' || !isSuperAdminActor(actor)) return base;
  // A draft is judged as if it were published, so its own sale window rules still apply below.
  const effective =
    event.status === 'DRAFT' ? computeSaleState({ ...event, status: 'PUBLISHED' }, now) : base;
  switch (effective) {
    case 'ON_SALE':
    case 'NOT_STARTED':
    case 'PRESALE':
    case 'PAUSED':
      return 'ON_SALE';
    case 'ENDED':
      // Sale end date passed but the event has not started: still bookable for the test.
      return now >= event.startsAt ? 'ENDED' : 'ON_SALE';
    default:
      return effective;
  }
}

/**
 * Shop actor of an admin session: ONLY the SUPER_ADMIN role qualifies (no other role, no
 * "has role X or higher" logic) and only once two-factor set-up is complete, the same bar as the
 * admin API. Everything else – no session, EVENT_MANAGER, FINANCE, … – is an ordinary customer.
 */
export function resolveShopActor(
  session: { roles: readonly string[]; twoFactorSetupRequired: boolean } | null,
  queueTestCookie: boolean,
): ShopActor | null {
  if (!session || session.twoFactorSetupRequired || !session.roles.includes('SUPER_ADMIN')) {
    return null;
  }
  return { superAdmin: true, queueTest: queueTestCookie };
}
