import 'server-only';
import {
  computeSaleState,
  countOpenRefunds,
  getDashboardData,
  getDashboardPreferences,
  getSetting,
  type DashboardData,
  type SaleState,
} from '@tix/core';
import { events } from '@tix/db';
import { EVENT_STATUSES, type DashboardPreferences, type EventStatus } from '@tix/shared';
import { inArray } from 'drizzle-orm';
import { hasRole, type AdminSession } from '@/server/auth';
import { getCore } from '@/server/core';

export interface DashboardPayload extends DashboardData {
  /** Which blocks the signed-in role may see (the client renders only these). */
  sections: { money: boolean; inventory: boolean; checkIn: boolean };
  openRefunds: number;
  /** Sale state per event of `events` (presale, on sale, paused …). */
  saleStates: Record<string, SaleState>;
  /** The signed-in admin's saved settings (statusFilter = the filter this payload was built with). */
  preferences: DashboardPreferences;
  /** Seat colours of the shop (settings → seat display), reused for the inventory bars. */
  colors: { sold: string; locked: string; blocked: string };
}

/** Role-filtered live telemetry: money for FINANCE, inventory for EVENT_MANAGER, check-in for door staff. */
export async function loadDashboard(
  session: AdminSession,
  /** Status filter of the request (the client's current selection); default = the saved one. */
  statuses?: readonly EventStatus[],
): Promise<DashboardPayload> {
  const core = getCore();
  const sections = {
    money: hasRole(session, ['FINANCE']),
    inventory: hasRole(session, ['EVENT_MANAGER']),
    checkIn: hasRole(session, ['DOOR_STAFF', 'EVENT_MANAGER']),
  };
  const saved = await getDashboardPreferences(core, session.userId);
  const statusFilter = statuses && statuses.length > 0 ? [...statuses] : saved.statusFilter;
  // The events table is sorted by date (the saved card order of the former card grid is ignored).
  const [data, openRefunds, display] = await Promise.all([
    getDashboardData(core, { ...sections, statuses: statusFilter }),
    sections.money ? countOpenRefunds(core) : Promise.resolve(0),
    getSetting(core, 'seatDisplay'),
  ]);
  const ids = data.events.map((e) => e.id);
  const saleRows =
    ids.length > 0 ? await core.db.select().from(events).where(inArray(events.id, ids)) : [];
  const now = new Date();
  return {
    ...data,
    sections,
    openRefunds,
    saleStates: Object.fromEntries(saleRows.map((e) => [e.id, computeSaleState(e, now)])),
    preferences: { eventOrder: saved.eventOrder, statusFilter },
    colors: {
      sold: display.soldColor,
      locked: display.inOtherCartColor,
      blocked: display.blockedColor,
    },
  };
}

/** Parses `?statuses=PUBLISHED,DRAFT`; undefined when absent or invalid. */
export function parseStatusesParam(raw: string | null): EventStatus[] | undefined {
  if (!raw) return undefined;
  const parts = [...new Set(raw.split(','))];
  return parts.length > 0 && parts.every((p) => (EVENT_STATUSES as readonly string[]).includes(p))
    ? (parts as EventStatus[])
    : undefined;
}
