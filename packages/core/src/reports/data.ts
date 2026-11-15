import {
  orderItems,
  orders,
  seatMapRows,
  seatMapSections,
  seats,
  tickets,
  type Executor,
} from '@tix/db';
import type { CheckInState, SectionType, TicketStatus } from '@tix/shared';
import { and, asc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { DomainError } from '../context';
import { selectTicketViews } from '../scanner/ticket-view';

/**
 * Read models of the per-event reports (door staff): the seating occupancy and the guest list.
 * Test orders (`orders.is_test`) never appear; cancelled / expired / refunded orders and voided
 * items do not occupy a seat. Replaced tickets are superseded ones and not listed.
 */

const DEAD_ORDER_STATUSES = ['CANCELLED', 'EXPIRED', 'REFUNDED'] as const;

export type GuestSort = 'name' | 'seat';

export interface GuestListRow {
  ticketId: string;
  name: string;
  orderNumber: string;
  categoryName: string;
  ticketTypeName: string;
  sectionLabel: string;
  rowLabel: string | null;
  seatLabel: string | null;
  ticketStatus: TicketStatus;
  checkInState: CheckInState;
  checkedInAt: Date | null;
}

/** Natural ordering ("2" < "10", "A" < "B"), locale independent enough for door lists. */
export const naturalCompare = (a: string, b: string): number =>
  a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

function seatCompare(a: GuestListRow, b: GuestListRow): number {
  return (
    naturalCompare(a.sectionLabel, b.sectionLabel) ||
    naturalCompare(a.rowLabel ?? '', b.rowLabel ?? '') ||
    naturalCompare(a.seatLabel ?? '', b.seatLabel ?? '') ||
    naturalCompare(a.name, b.name)
  );
}

export function sortGuestList(
  rows: GuestListRow[],
  sort: GuestSort,
  locale = 'en',
): GuestListRow[] {
  const out = [...rows];
  if (sort === 'seat') return out.sort(seatCompare);
  return out.sort(
    (a, b) =>
      a.name.localeCompare(b.name, locale, { sensitivity: 'base' }) ||
      naturalCompare(a.orderNumber, b.orderNumber) ||
      seatCompare(a, b),
  );
}

export async function loadGuestList(
  db: Executor,
  eventId: string,
  sort: GuestSort,
  locale = 'en',
): Promise<GuestListRow[]> {
  const rows = await selectTicketViews(db).where(
    and(
      eq(tickets.eventId, eventId),
      sql`${orders.isTest} = false`,
      sql`${tickets.status} <> 'REPLACED'`,
    ),
  );
  return sortGuestList(
    rows.map((r) => ({
      ticketId: r.id,
      name: (r.attendeeName?.trim() || r.buyerName.trim()) ?? '',
      orderNumber: r.orderNumber,
      categoryName: r.categoryName,
      ticketTypeName: r.ticketTypeName,
      sectionLabel: r.sectionLabel,
      rowLabel: r.rowLabel,
      seatLabel: r.seatLabel,
      ticketStatus: r.status,
      checkInState: r.checkInState,
      checkedInAt: r.firstCheckedInAt,
    })),
    sort,
    locale,
  );
}

// ── Seating occupancy ────────────────────────────────────────────────────

export type OccupancyStatus = 'SOLD' | 'RESERVED' | 'BLOCKED' | 'FREE';

export interface OccupancySeat {
  label: string;
  status: OccupancyStatus;
  /** Ticket holder / buyer, only for SOLD and RESERVED seats. */
  holder: string | null;
}

export interface OccupancyRow {
  label: string;
  seats: OccupancySeat[];
}

export interface OccupancySection {
  name: string;
  type: SectionType;
  rows: OccupancyRow[];
  /** STANDING sections: capacity and the number of active (sold + reserved) tickets. */
  capacity: number | null;
  standingSold: number;
  standingReserved: number;
}

export interface Occupancy {
  sections: OccupancySection[];
  totals: Record<OccupancyStatus, number>;
}

export async function loadOccupancy(db: Executor, seatMapId: string | null): Promise<Occupancy> {
  if (!seatMapId) throw new DomainError('NO_SEAT_MAP', 'The event has no seating plan', 409);
  const sections = await db
    .select()
    .from(seatMapSections)
    .where(and(eq(seatMapSections.seatMapId, seatMapId), isNull(seatMapSections.removedAt)))
    .orderBy(asc(seatMapSections.sortOrder), asc(seatMapSections.name));

  const seatRows = await db
    .select({
      sectionId: seats.sectionId,
      rowId: seats.rowId,
      rowLabel: seatMapRows.label,
      rowSort: seatMapRows.sortOrder,
      seatLabel: seats.label,
      position: seats.position,
      blocked: sql<boolean>`${seats.blockReason} IS NOT NULL`,
      itemStatus: orderItems.status,
      ticketName: tickets.attendeeName,
      itemName: orderItems.attendeeName,
      buyerName: sql<string>`${orders.firstName} || ' ' || ${orders.lastName}`,
      orderId: orders.id,
    })
    .from(seats)
    .innerJoin(seatMapSections, eq(seatMapSections.id, seats.sectionId))
    .leftJoin(seatMapRows, eq(seatMapRows.id, seats.rowId))
    .leftJoin(
      orderItems,
      and(eq(orderItems.seatId, seats.id), inArray(orderItems.status, ['PENDING', 'CONFIRMED'])),
    )
    .leftJoin(
      orders,
      and(
        eq(orders.id, orderItems.orderId),
        eq(orders.isTest, false),
        notInArray(orders.status, [...DEAD_ORDER_STATUSES]),
      ),
    )
    .leftJoin(tickets, and(eq(tickets.orderItemId, orderItems.id), eq(tickets.status, 'VALID')))
    .where(
      and(
        eq(seats.seatMapId, seatMapId),
        isNull(seats.removedAt),
        isNull(seatMapSections.removedAt),
        or(isNull(seats.rowId), isNull(seatMapRows.removedAt)),
      ),
    );

  const standing = await db
    .select({
      sectionId: orderItems.sectionId,
      status: orderItems.status,
      n: sql<number>`count(*)::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orderItems.kind, 'GENERAL_ADMISSION'),
        inArray(
          orderItems.sectionId,
          sections.map((s) => s.id),
        ),
        inArray(orderItems.status, ['PENDING', 'CONFIRMED']),
        eq(orders.isTest, false),
        notInArray(orders.status, [...DEAD_ORDER_STATUSES]),
      ),
    )
    .groupBy(orderItems.sectionId, orderItems.status);

  const totals: Record<OccupancyStatus, number> = { SOLD: 0, RESERVED: 0, BLOCKED: 0, FREE: 0 };
  const out: OccupancySection[] = sections.map((section) => {
    const mine = seatRows.filter((s) => s.sectionId === section.id);
    const rowMap = new Map<string, { label: string; sort: number; seats: typeof mine }>();
    for (const s of mine) {
      const key = s.rowId ?? 'none';
      const row = rowMap.get(key) ?? { label: s.rowLabel ?? '', sort: s.rowSort ?? 0, seats: [] };
      row.seats.push(s);
      rowMap.set(key, row);
    }
    const rows = [...rowMap.values()]
      .sort((a, b) => a.sort - b.sort || naturalCompare(a.label, b.label))
      .map<OccupancyRow>((row) => ({
        label: row.label,
        seats: row.seats
          .sort(
            (a, b) =>
              (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
              naturalCompare(a.seatLabel, b.seatLabel),
          )
          .map<OccupancySeat>((s) => {
            const held = s.orderId !== null && s.itemStatus !== null;
            const status: OccupancyStatus = held
              ? s.itemStatus === 'CONFIRMED'
                ? 'SOLD'
                : 'RESERVED'
              : s.blocked
                ? 'BLOCKED'
                : 'FREE';
            totals[status] += 1;
            const holder = held
              ? s.ticketName?.trim() || s.itemName?.trim() || s.buyerName.trim() || null
              : null;
            return { label: s.seatLabel, status, holder };
          }),
      }));
    const count = (status: 'CONFIRMED' | 'PENDING') =>
      standing
        .filter((r) => r.sectionId === section.id && r.status === status)
        .reduce((sum, r) => sum + r.n, 0);
    const standingSold = section.type === 'STANDING' ? count('CONFIRMED') : 0;
    const standingReserved = section.type === 'STANDING' ? count('PENDING') : 0;
    totals.SOLD += standingSold;
    totals.RESERVED += standingReserved;
    if (section.type === 'STANDING' && section.capacity !== null) {
      totals.FREE += Math.max(0, section.capacity - standingSold - standingReserved);
    }
    return {
      name: section.name,
      type: section.type,
      rows,
      capacity: section.type === 'STANDING' ? section.capacity : null,
      standingSold,
      standingReserved,
    };
  });
  return { sections: out, totals };
}
