import {
  SEAT_FLAG,
  type PublicSeat,
  type PublicSeatMap,
  type PublicTicketType,
  type SeatDeltaMessage,
} from '@tix/shared';
import type { FieldMap } from '@/lib/field-errors';
import { parseMoneyToCents } from '@/lib/money';
import type { BuyerState, Inventory, Payment, Pick } from './types';

/** Tariffs sellable on a seat / in an area (same rules as the shop cart). */
export function allowedTariffs(
  map: PublicSeatMap,
  categoryId: string,
  flags: number | null,
): PublicTicketType[] {
  return map.ticketTypes.filter((t) => {
    if (t.prices[categoryId] === undefined) return false;
    if (t.requiredSeatFeature === 'WHEELCHAIR_SPACE')
      return flags !== null && (flags & SEAT_FLAG.WHEELCHAIR) !== 0;
    if (t.requiredSeatFeature === 'COMPANION_SEAT')
      return flags !== null && (flags & SEAT_FLAG.COMPANION) !== 0;
    return true;
  });
}

export function defaultTariff(
  map: PublicSeatMap,
  categoryId: string,
  flags: number | null,
): PublicTicketType | null {
  const allowed = allowedTariffs(map, categoryId, flags);
  return (
    allowed.find((t) => t.requiredSeatFeature !== null) ??
    allowed.find((t) => t.isDefault) ??
    allowed[0] ??
    null
  );
}

/** Zod issue path (sell API) → control id. */
export const SELL_FIELDS: FieldMap = {
  'buyer.firstName': 'bo-firstName',
  'buyer.lastName': 'bo-lastName',
  'buyer.email': 'bo-email',
  'buyer.phone': 'bo-phone',
  'buyer.company': 'bo-company',
  'buyer.address': 'bo-street',
  'buyer.address.street': 'bo-street',
  'buyer.address.addressLine2': 'bo-addressLine2',
  'buyer.address.postalCode': 'bo-postalCode',
  'buyer.address.city': 'bo-city',
  'buyer.address.country': 'bo-country',
  note: 'bo-note',
  locale: 'bo-language',
  priceOverrideReason: 'bo-reason',
};

export function emptyBuyer(): BuyerState {
  return {
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    company: '',
    note: '',
    street: '',
    addressLine2: '',
    postalCode: '',
    city: '',
    country: 'DE',
  };
}

export const sectionTotal = (picks: Record<string, number> | undefined) =>
  Object.values(picks ?? {}).reduce((n, q) => n + q, 0);

/** Applies a realtime seat delta to the inventory (pure). */
export function applyInventoryDelta(prev: Inventory, delta: SeatDeltaMessage): Inventory {
  const next: Inventory = {
    ...prev,
    taken: new Set(prev.taken),
    locked: new Set(prev.locked),
    ga: { ...prev.ga },
  };
  for (const [id, s] of delta.seats) {
    if (s === 'F') {
      next.taken.delete(id);
      next.locked.delete(id);
    } else if (s === 'L') {
      next.locked.add(id);
    } else {
      next.taken.add(id);
      next.locked.delete(id);
    }
  }
  if (delta.ga) Object.assign(next.ga, delta.ga);
  return next;
}

/** Sale lines sent to the quote / sell API. */
export function buildLines(
  eventId: string,
  seatPicks: Map<string, Pick>,
  gaPicks: Record<string, Record<string, number>>,
  payment: Payment,
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const [seatId, pick] of seatPicks) {
    const cents =
      payment !== 'COMPLIMENTARY' && pick.override.trim() ? parseMoneyToCents(pick.override) : null;
    result.push({
      eventId,
      seatId,
      ticketTypeId: pick.tariffId,
      ...(cents !== null ? { priceOverrideCents: cents } : {}),
    });
  }
  for (const [sectionId, picks] of Object.entries(gaPicks)) {
    for (const [tariffId, quantity] of Object.entries(picks)) {
      if (quantity > 0) result.push({ eventId, sectionId, quantity, ticketTypeId: tariffId });
    }
  }
  return result;
}

export function sortSeatsForList(seats: PublicSeat[]): PublicSeat[] {
  return [...seats].sort((a, b) =>
    `${a.s}|${a.r}|${String(a.p ?? 0).padStart(6, '0')}`.localeCompare(
      `${b.s}|${b.r}|${String(b.p ?? 0).padStart(6, '0')}`,
    ),
  );
}
