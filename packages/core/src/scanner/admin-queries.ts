import {
  checkInLogs,
  orderItems,
  orders,
  scannerDevices,
  seatMapEntrances,
  tickets,
} from '@tix/db';
import type { ScanResult, ScanWarning } from '@tix/shared';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { CoreContext } from '../context';

/** Read models of the admin "check-in" views: live statistics and the scan journal. */

export interface CheckInStats {
  /** All VALID tickets of the event. */
  valid: number;
  /** VALID tickets currently inside. */
  checkedIn: number;
  /** VALID tickets that checked out again (can re-enter). */
  checkedOut: number;
  /** VALID tickets never scanned. */
  notArrived: number;
  /** Cancelled / refunded / replaced tickets. */
  voided: number;
  /** Check-ins journaled as DUPLICATE_ENTRY (two entries without a check-out: possible copied ticket). */
  duplicateEntries: number;
  /** Journal counts per result. */
  results: Partial<Record<ScanResult, number>>;
  /** Accepted check-ins per entrance the scan happened at (null = entrance not set). */
  byEntrance: { entranceId: string | null; entranceName: string | null; checkIns: number }[];
  lastScanAt: Date | null;
}

export async function getCheckInStats(ctx: CoreContext, eventId: string): Promise<CheckInStats> {
  const [counts] = await ctx.db
    .select({
      valid: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'VALID')::int`,
      checkedIn: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'VALID' AND ${tickets.checkInState} = 'CHECKED_IN')::int`,
      checkedOut: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'VALID' AND ${tickets.checkInState} = 'CHECKED_OUT')::int`,
      voided: sql<number>`count(*) FILTER (WHERE ${tickets.status} <> 'VALID')::int`,
    })
    .from(tickets)
    .where(eq(tickets.eventId, eventId));
  const resultRows = await ctx.db
    .select({ result: checkInLogs.result, n: sql<number>`count(*)::int` })
    .from(checkInLogs)
    .where(eq(checkInLogs.eventId, eventId))
    .groupBy(checkInLogs.result);
  const entranceRows = await ctx.db
    .select({
      entranceId: checkInLogs.entranceId,
      entranceName: seatMapEntrances.name,
      checkIns: sql<number>`count(*)::int`,
    })
    .from(checkInLogs)
    .leftJoin(seatMapEntrances, eq(seatMapEntrances.id, checkInLogs.entranceId))
    .where(
      and(
        eq(checkInLogs.eventId, eventId),
        eq(checkInLogs.action, 'CHECK_IN'),
        sql`${checkInLogs.result} IN ('ACCEPTED','ACCEPTED_WITH_WARNING')`,
      ),
    )
    .groupBy(checkInLogs.entranceId, seatMapEntrances.name)
    .orderBy(seatMapEntrances.name);
  const [dup] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(checkInLogs)
    .where(and(eq(checkInLogs.eventId, eventId), eq(checkInLogs.message, 'DUPLICATE_ENTRY')));
  const [last] = await ctx.db
    .select({ at: sql<Date | null>`max(${checkInLogs.scannedAt})` })
    .from(checkInLogs)
    .where(eq(checkInLogs.eventId, eventId));
  const valid = counts?.valid ?? 0;
  const checkedIn = counts?.checkedIn ?? 0;
  const checkedOut = counts?.checkedOut ?? 0;
  return {
    valid,
    checkedIn,
    checkedOut,
    notArrived: valid - checkedIn - checkedOut,
    voided: counts?.voided ?? 0,
    duplicateEntries: dup?.n ?? 0,
    results: Object.fromEntries(resultRows.map((r) => [r.result, r.n])),
    byEntrance: entranceRows,
    lastScanAt: last?.at ? new Date(last.at) : null,
  };
}

export interface ScanLogEntry {
  id: string;
  scannedAt: Date;
  receivedAt: Date;
  action: 'CHECK_IN' | 'CHECK_OUT';
  source: 'CAMERA' | 'MANUAL';
  result: ScanResult;
  warnings: ScanWarning[];
  wasOffline: boolean;
  message: string | null;
  deviceId: string | null;
  deviceName: string | null;
  entranceName: string | null;
  ticketId: string | null;
  ticketCode: string | null;
  attendeeName: string | null;
  seat: { sectionLabel: string; rowLabel: string | null; seatLabel: string | null } | null;
}

export async function listScanLog(
  ctx: CoreContext,
  params: {
    eventId: string;
    result?: ScanResult;
    deviceId?: string;
    /** Free text: every word must match order number, ticket code, seat label, attendee or buyer name. */
    search?: string;
    page?: number;
    pageSize?: number;
  },
): Promise<{ entries: ScanLogEntry[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 200);
  const filters: SQL[] = [eq(checkInLogs.eventId, params.eventId)];
  if (params.result) filters.push(eq(checkInLogs.result, params.result));
  if (params.deviceId) filters.push(eq(checkInLogs.deviceId, params.deviceId));
  const words = (params.search ?? '')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 8);
  for (const word of words) {
    const like = `%${word.replace(/[\\%_]/g, '\\$&')}%`;
    filters.push(
      sql`(${orders.orderNumber} ILIKE ${like}
        OR ${tickets.ticketCode} ILIKE ${like}
        OR ${tickets.attendeeName} ILIKE ${like}
        OR concat_ws(' ', ${orders.firstName}, ${orders.lastName}) ILIKE ${like}
        OR concat_ws(' ', ${orderItems.sectionLabel}, ${orderItems.rowLabel}, ${orderItems.seatLabel}) ILIKE ${like})`,
    );
  }
  const where = and(...filters);
  const [total] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(checkInLogs)
    .leftJoin(tickets, eq(tickets.id, checkInLogs.ticketId))
    .leftJoin(orders, eq(orders.id, tickets.orderId))
    .leftJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
    .where(where);
  const totalCount = total?.n ?? 0;
  // Clamp to the last page so a stale page number (e.g. after a filter change) still shows rows.
  const page = Math.min(
    Math.max(params.page ?? 1, 1),
    Math.max(1, Math.ceil(totalCount / pageSize)),
  );
  const rows = await ctx.db
    .select({
      id: checkInLogs.id,
      scannedAt: checkInLogs.scannedAt,
      receivedAt: checkInLogs.receivedAt,
      action: checkInLogs.action,
      source: checkInLogs.source,
      result: checkInLogs.result,
      warnings: checkInLogs.warnings,
      wasOffline: checkInLogs.wasOffline,
      message: checkInLogs.message,
      deviceId: checkInLogs.deviceId,
      deviceName: scannerDevices.name,
      entranceName: seatMapEntrances.name,
      ticketId: checkInLogs.ticketId,
      ticketCode: tickets.ticketCode,
      attendeeName: tickets.attendeeName,
      sectionLabel: orderItems.sectionLabel,
      rowLabel: orderItems.rowLabel,
      seatLabel: orderItems.seatLabel,
    })
    .from(checkInLogs)
    .leftJoin(scannerDevices, eq(scannerDevices.id, checkInLogs.deviceId))
    .leftJoin(seatMapEntrances, eq(seatMapEntrances.id, checkInLogs.entranceId))
    .leftJoin(tickets, eq(tickets.id, checkInLogs.ticketId))
    .leftJoin(orders, eq(orders.id, tickets.orderId))
    .leftJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
    .where(where)
    .orderBy(desc(checkInLogs.scannedAt), desc(checkInLogs.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return {
    entries: rows.map((r) => ({
      id: r.id,
      scannedAt: r.scannedAt,
      receivedAt: r.receivedAt,
      action: r.action,
      source: r.source,
      result: r.result,
      warnings: r.warnings,
      wasOffline: r.wasOffline,
      message: r.message,
      deviceId: r.deviceId,
      deviceName: r.deviceName,
      entranceName: r.entranceName,
      ticketId: r.ticketId,
      ticketCode: r.ticketCode,
      attendeeName: r.attendeeName,
      seat: r.sectionLabel
        ? { sectionLabel: r.sectionLabel, rowLabel: r.rowLabel, seatLabel: r.seatLabel }
        : null,
    })),
    total: totalCount,
    page,
    pageSize,
  };
}

/** Devices that appear in the event's journal (filter choices). */
export async function listScanLogDevices(
  ctx: CoreContext,
  eventId: string,
): Promise<{ id: string; name: string; deleted: boolean }[]> {
  return ctx.db
    .selectDistinct({
      id: scannerDevices.id,
      name: scannerDevices.name,
      deleted: sql<boolean>`${scannerDevices.deletedAt} IS NOT NULL`,
    })
    .from(checkInLogs)
    .innerJoin(scannerDevices, eq(scannerDevices.id, checkInLogs.deviceId))
    .where(eq(checkInLogs.eventId, eventId))
    .orderBy(scannerDevices.name);
}
