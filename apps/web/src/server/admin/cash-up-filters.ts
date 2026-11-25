import 'server-only';
import { formatLocalDate, localDateOf, parseLocalDate, type CashUpFilter } from '@tix/core';
import type { AdminSession } from '@/server/auth';

/** Door staff see only their own counter sales; every other role may pick a seller. */
export function isOwnSalesOnly(session: Pick<AdminSession, 'roles'>): boolean {
  const roles = session.roles;
  return (
    !roles.includes('SUPER_ADMIN') &&
    !roles.includes('FINANCE') &&
    !roles.includes('EVENT_MANAGER') &&
    roles.includes('DOOR_STAFF')
  );
}

/** Parses the cash-up query (default: today in the shop time zone, all events, all sellers). */
export function parseCashUpFilter(
  sp: Record<string, string | undefined>,
  session: Pick<AdminSession, 'roles' | 'userId'>,
  timeZone: string,
  now = new Date(),
): CashUpFilter {
  const today = formatLocalDate(localDateOf(now, timeZone));
  const from = sp.from && parseLocalDate(sp.from) ? sp.from : today;
  const to = sp.to && parseLocalDate(sp.to) ? sp.to : from > today ? from : today;
  const uuid = /^[0-9a-f-]{36}$/i;
  return {
    from,
    to: to < from ? from : to,
    timeZone,
    eventId: uuid.test(sp.event ?? '') ? sp.event : undefined,
    sellerUserId: isOwnSalesOnly(session)
      ? session.userId
      : uuid.test(sp.seller ?? '')
        ? sp.seller
        : undefined,
  };
}
