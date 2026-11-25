import { orders, orderItems, scannerDeviceEvents, scannerDevices, tickets } from '@tix/db';
import type { ScanAction, ScanOutcome } from '@tix/shared';
import { and, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, type CoreContext } from '../context';
import { processScans, ticketSearchConditions } from './scan';
import type { ScannerDeviceAuth } from './devices';
import { loadTicketViews, toDisplay, type TicketView } from './ticket-view';

/**
 * Door staff at a desk / tablet: guest list with manual check-in and check-out in the admin
 * portal. The web desk uses exactly the same decision logic, journal and ticket state as the
 * Android scanner (`processScans`): every admin user gets a private, permanently archived
 * "Web (<name>)" device row (revoked + archived, so it never appears in the device list and can
 * never authenticate; the token hash is not a valid token) that carries the event assignments.
 * The journal and "first scan" displays therefore show `Web (<name>)` as the device.
 */

const webDoorTokenHash = (userId: string) =>
  createHash('sha256').update(`web-door:${userId}`).digest('hex');

export const webDoorDeviceName = (displayName: string) =>
  `Web (${displayName.trim()})`.slice(0, 80);

/** The user's web desk "device", assigned to the event (check-out allowed). Idempotent / race-safe. */
export async function ensureWebDoorDevice(
  ctx: CoreContext,
  params: { userId: string; displayName: string; eventId: string },
): Promise<ScannerDeviceAuth> {
  const name = webDoorDeviceName(params.displayName);
  const tokenHash = webDoorTokenHash(params.userId);
  const now = new Date();
  // Created revoked + archived and never reactivated. Any future "reactivate / un-archive device"
  // path (admin device list, restore tooling) MUST exclude platform = 'web': the token hash is
  // derived from the user id, so an active web desk row must never be able to authenticate.
  await ctx.db
    .insert(scannerDevices)
    .values({
      name,
      tokenHash,
      tokenPrefix: 'web',
      platform: 'web',
      isActive: false,
      revokedAt: now,
      deletedAt: now,
      pairedByUserId: params.userId,
    })
    .onConflictDoNothing({ target: scannerDevices.tokenHash });
  const [device] = await ctx.db
    .select({ id: scannerDevices.id, name: scannerDevices.name })
    .from(scannerDevices)
    .where(eq(scannerDevices.tokenHash, tokenHash));
  if (!device) throw new DomainError('DEVICE_NOT_FOUND', 'Web desk could not be created', 500);
  if (device.name !== name) {
    await ctx.db.update(scannerDevices).set({ name }).where(eq(scannerDevices.id, device.id));
  }
  await ctx.db
    .insert(scannerDeviceEvents)
    .values({ deviceId: device.id, eventId: params.eventId, allowCheckOut: true })
    .onConflictDoNothing();
  return { id: device.id, name };
}

/**
 * Manual check-in / check-out of one ticket through the shared scan pipeline. `clientScanId` is
 * generated once per click by the desk UI: a double click or a retried request repeats the same
 * scan and gets the first outcome back (idempotent per device + clientScanId) instead of a RED
 * "already checked in". Without one (server-side callers) every call is a new scan.
 */
export async function webDoorScan(
  ctx: CoreContext,
  params: {
    userId: string;
    displayName: string;
    eventId: string;
    ticketId: string;
    action: ScanAction;
    clientScanId?: string;
  },
): Promise<ScanOutcome> {
  const device = await ensureWebDoorDevice(ctx, params);
  const [outcome] = await processScans(
    ctx,
    device,
    [
      {
        clientScanId: params.clientScanId?.toLowerCase() ?? randomUUID(),
        eventId: params.eventId,
        action: params.action,
        source: 'MANUAL',
        ticketId: params.ticketId.toLowerCase(),
        scannedAt: new Date().toISOString(),
      },
    ],
    { offline: false },
  );
  if (!outcome) throw new Error('scan produced no outcome');
  return outcome;
}

export const DOOR_STATES = ['ALL', 'NOT_ARRIVED', 'INSIDE', 'OUT'] as const;
export type DoorState = (typeof DOOR_STATES)[number];

export interface DoorGuest {
  id: string;
  ticketCode: string;
  status: TicketView['status'];
  orderNumber: string;
  buyerName: string;
  attendeeName: string | null;
  categoryName: string;
  ticketTypeName: string;
  sectionLabel: string;
  rowLabel: string | null;
  seatLabel: string | null;
  checkInState: TicketView['checkInState'];
  firstCheckedInAt: Date | null;
  firstCheckedInDeviceName: string | null;
  lastScanAt: Date | null;
  requiresProof: boolean;
  scannerWarning: string | null;
  additionalPaymentOpen: boolean;
}

export interface DoorGuestQuery {
  eventId: string;
  q?: string;
  state?: DoorState;
  page?: number;
  pageSize?: number;
}

/** Paged guest list of an event (test orders excluded, valid tickets first). */
export async function listDoorGuests(
  ctx: CoreContext,
  query: DoorGuestQuery,
): Promise<{ guests: DoorGuest[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), 100);
  const page = Math.max(query.page ?? 1, 1);
  const conditions: SQL[] = [eq(tickets.eventId, query.eventId), eq(orders.isTest, false)];
  const q = query.q?.trim();
  if (q && q.length >= 2) conditions.push(sql`(${sql.join(ticketSearchConditions(q), sql` OR `)})`);
  if (query.state === 'NOT_ARRIVED') {
    conditions.push(eq(tickets.status, 'VALID'), eq(tickets.checkInState, 'NONE'));
  } else if (query.state === 'INSIDE') {
    conditions.push(eq(tickets.status, 'VALID'), eq(tickets.checkInState, 'CHECKED_IN'));
  } else if (query.state === 'OUT') {
    conditions.push(eq(tickets.status, 'VALID'), eq(tickets.checkInState, 'CHECKED_OUT'));
  }
  const where = and(...conditions);
  const base = ctx.db
    .select({ id: tickets.id })
    .from(tickets)
    .innerJoin(orders, eq(orders.id, tickets.orderId))
    .innerJoin(orderItems, eq(orderItems.id, tickets.orderItemId));
  const [rows, [totalRow]] = await Promise.all([
    base
      .where(where)
      .orderBy(
        sql`(${tickets.status} = 'VALID') DESC`,
        sql`lower(coalesce(${tickets.attendeeName}, ${orders.lastName}))`,
        tickets.id,
      )
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    ctx.db
      .select({ n: count() })
      .from(tickets)
      .innerJoin(orders, eq(orders.id, tickets.orderId))
      .innerJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
      .where(where),
  ]);
  if (rows.length === 0) return { guests: [], total: totalRow?.n ?? 0, page, pageSize };
  const ids = rows.map((r) => r.id);
  const views = new Map(
    (await loadTicketViews(ctx.db, inArray(tickets.id, ids))).map((v) => [v.id, v]),
  );
  const guests = ids.flatMap((id): DoorGuest[] => {
    const v = views.get(id);
    if (!v) return [];
    const d = toDisplay(v);
    return [
      {
        id: v.id,
        ticketCode: v.ticketCode,
        status: v.status,
        orderNumber: v.orderNumber,
        buyerName: v.buyerName,
        attendeeName: d.attendeeName,
        categoryName: d.categoryName,
        ticketTypeName: d.ticketTypeName,
        sectionLabel: d.sectionLabel,
        rowLabel: d.rowLabel,
        seatLabel: d.seatLabel,
        checkInState: v.checkInState,
        firstCheckedInAt: v.firstCheckedInAt,
        firstCheckedInDeviceName: v.firstCheckedInDeviceName,
        lastScanAt: v.lastScanAt,
        requiresProof: v.requiresProof,
        scannerWarning: v.scannerWarning,
        additionalPaymentOpen: v.additionalPaymentOpen,
      },
    ];
  });
  return { guests, total: totalRow?.n ?? 0, page, pageSize };
}
