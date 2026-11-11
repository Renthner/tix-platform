import {
  eventSigningKeys,
  orderItems,
  orders,
  priceCategories,
  scannerDevices,
  seatMapSections,
  seats,
  tickets,
  ticketTypes,
  type Executor,
} from '@tix/db';
import type { DecisionTicket, ScanTicketDisplay, SeatFeature, SyncTicket } from '@tix/shared';
import { sql, type SQL } from 'drizzle-orm';
import { openAdjustmentItemIds } from '../orders/adjustment-state';

/**
 * Everything the scanner shows or decides on for a ticket, joined from tickets, order item
 * snapshot, seat, ticket type and the device that checked the ticket in first.
 */

export interface TicketView {
  id: string;
  ticketCode: string;
  status: DecisionTicket['status'];
  eventId: string;
  keyId: string;
  orderId: string;
  orderItemId: string;
  orderNumber: string;
  buyerName: string;
  sectionId: string;
  sectionLabel: string;
  rowLabel: string | null;
  seatLabel: string | null;
  seatFeature: SeatFeature | null;
  categoryId: string;
  categoryName: string;
  ticketTypeId: string;
  ticketTypeName: string;
  requiresProof: boolean;
  scannerWarning: string | null;
  /** Entrance assigned to the ticket's block. */
  entranceId: string | null;
  attendeeName: string | null;
  checkInState: DecisionTicket['checkInState'];
  firstCheckedInAt: Date | null;
  firstCheckedInDeviceId: string | null;
  firstCheckedInDeviceName: string | null;
  checkInCount: number;
  lastScanAt: Date | null;
  syncVersion: number;
  issuedAt: Date;
  /** xid8 of the last sync-relevant change, as decimal text. */
  syncXid: string;
  additionalPaymentOpen: boolean;
}

export const ticketViewColumns = () => ({
  id: tickets.id,
  ticketCode: tickets.ticketCode,
  status: tickets.status,
  eventId: tickets.eventId,
  keyId: eventSigningKeys.keyId,
  orderId: tickets.orderId,
  orderItemId: tickets.orderItemId,
  orderNumber: orders.orderNumber,
  buyerName: sql<string>`${orders.firstName} || ' ' || ${orders.lastName}`,
  sectionId: orderItems.sectionId,
  sectionLabel: orderItems.sectionLabel,
  rowLabel: orderItems.rowLabel,
  seatLabel: orderItems.seatLabel,
  isWheelchairSpace: seats.isWheelchairSpace,
  isCompanionSeat: seats.isCompanionSeat,
  categoryId: orderItems.priceCategoryId,
  categoryName: priceCategories.name,
  ticketTypeId: orderItems.ticketTypeId,
  ticketTypeName: ticketTypes.name,
  requiresProof: ticketTypes.requiresProofAtEntry,
  scannerWarning: ticketTypes.scannerWarning,
  entranceId: seatMapSections.entranceId,
  attendeeName: tickets.attendeeName,
  checkInState: tickets.checkInState,
  firstCheckedInAt: tickets.firstCheckedInAt,
  firstCheckedInDeviceId: tickets.firstCheckedInDeviceId,
  firstCheckedInDeviceName: scannerDevices.name,
  checkInCount: tickets.checkInCount,
  lastScanAt: tickets.lastScanAt,
  syncVersion: tickets.syncVersion,
  issuedAt: tickets.issuedAt,
  syncXid: sql<string>`${tickets.syncXid}::text`,
});

const rawQuery = (db: Executor) => selectTicketViews(db).where(sql`true`);
export type RawTicketView = Awaited<ReturnType<typeof rawQuery>>[number];

/** Base query; callers add `where`, ordering and locking. `extra` adds computed columns. */
export function selectTicketViews<E extends Record<string, SQL>>(db: Executor, extra?: E) {
  return db
    .select({ ...ticketViewColumns(), ...(extra ?? ({} as E)) })
    .from(tickets)
    .innerJoin(orderItems, sql`${orderItems.id} = ${tickets.orderItemId}`)
    .innerJoin(orders, sql`${orders.id} = ${tickets.orderId}`)
    .innerJoin(eventSigningKeys, sql`${eventSigningKeys.id} = ${tickets.signingKeyId}`)
    .innerJoin(priceCategories, sql`${priceCategories.id} = ${orderItems.priceCategoryId}`)
    .innerJoin(ticketTypes, sql`${ticketTypes.id} = ${orderItems.ticketTypeId}`)
    .innerJoin(seatMapSections, sql`${seatMapSections.id} = ${orderItems.sectionId}`)
    .leftJoin(seats, sql`${seats.id} = ${orderItems.seatId}`)
    .leftJoin(scannerDevices, sql`${scannerDevices.id} = ${tickets.firstCheckedInDeviceId}`);
}

export function seatFeatureOf(row: {
  isWheelchairSpace: boolean | null;
  isCompanionSeat: boolean | null;
}): SeatFeature | null {
  if (row.isWheelchairSpace) return 'WHEELCHAIR_SPACE';
  if (row.isCompanionSeat) return 'COMPANION_SEAT';
  return null;
}

/** Adds the open-additional-payment flag (one query for all rows). */
export async function toTicketViews(db: Executor, rows: RawTicketView[]): Promise<TicketView[]> {
  const open = await openAdjustmentItemIds(db, [...new Set(rows.map((r) => r.orderId))]);
  return rows.map((r) => ({
    id: r.id,
    ticketCode: r.ticketCode,
    status: r.status,
    eventId: r.eventId,
    keyId: r.keyId,
    orderId: r.orderId,
    orderItemId: r.orderItemId,
    orderNumber: r.orderNumber,
    buyerName: r.buyerName,
    sectionId: r.sectionId,
    sectionLabel: r.sectionLabel,
    rowLabel: r.rowLabel,
    seatLabel: r.seatLabel,
    seatFeature: seatFeatureOf(r),
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    ticketTypeId: r.ticketTypeId,
    ticketTypeName: r.ticketTypeName,
    requiresProof: r.requiresProof,
    scannerWarning: r.scannerWarning,
    entranceId: r.entranceId,
    attendeeName: r.attendeeName?.trim() || r.buyerName.trim() || null,
    checkInState: r.checkInState,
    firstCheckedInAt: r.firstCheckedInAt,
    firstCheckedInDeviceId: r.firstCheckedInDeviceId,
    firstCheckedInDeviceName: r.firstCheckedInDeviceName,
    checkInCount: r.checkInCount,
    lastScanAt: r.lastScanAt,
    syncVersion: r.syncVersion,
    issuedAt: r.issuedAt,
    syncXid: r.syncXid,
    additionalPaymentOpen: open.has(r.orderItemId),
  }));
}

export async function loadTicketViews(
  db: Executor,
  where: SQL,
  options: { limit?: number } = {},
): Promise<TicketView[]> {
  const query = selectTicketViews(db).where(where);
  const rows = await (options.limit ? query.limit(options.limit) : query);
  return toTicketViews(db, rows);
}

export function toDecisionTicket(view: TicketView): DecisionTicket {
  return {
    status: view.status,
    checkInState: view.checkInState,
    requiresProof: view.requiresProof,
    seatFeature: view.seatFeature,
    additionalPaymentOpen: view.additionalPaymentOpen,
    entranceId: view.entranceId,
  };
}

export function toDisplay(view: TicketView): ScanTicketDisplay {
  return {
    id: view.id,
    ticketCode: view.ticketCode,
    status: view.status,
    attendeeName: view.attendeeName,
    categoryName: view.categoryName,
    ticketTypeName: view.ticketTypeName,
    sectionLabel: view.sectionLabel,
    rowLabel: view.rowLabel,
    seatLabel: view.seatLabel,
    seatFeature: view.seatFeature,
    checkInState: view.checkInState,
  };
}

export function toSyncTicket(view: TicketView): SyncTicket {
  return {
    id: view.id,
    ticketCode: view.ticketCode,
    status: view.status,
    eventId: view.eventId,
    keyId: view.keyId,
    sectionId: view.sectionId,
    sectionLabel: view.sectionLabel,
    rowLabel: view.rowLabel,
    seatLabel: view.seatLabel,
    seatFeature: view.seatFeature,
    categoryId: view.categoryId,
    categoryName: view.categoryName,
    ticketTypeId: view.ticketTypeId,
    attendeeName: view.attendeeName,
    checkInState: view.checkInState,
    firstCheckedInAt: view.firstCheckedInAt?.toISOString() ?? null,
    firstCheckedInDeviceName: view.firstCheckedInDeviceName,
    checkInCount: view.checkInCount,
    lastScanAt: view.lastScanAt?.toISOString() ?? null,
    additionalPaymentOpen: view.additionalPaymentOpen,
    syncVersion: view.syncVersion,
  };
}
