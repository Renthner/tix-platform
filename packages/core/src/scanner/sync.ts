import { scannerDevices, scannerSyncState, tickets, type Executor } from '@tix/db';
import type { SyncPage } from '@tix/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { CoreContext } from '../context';
import { requireDeviceEvent, type ScannerDeviceAuth } from './devices';
import { selectTicketViews, toSyncTicket, toTicketViews } from './ticket-view';

/**
 * Delta sync of the tickets of one event.
 *
 * Every ticket change stores the writing transaction id in `tickets.sync_xid` (trigger, migration
 * 0028) and bumps `sync_version`. The cursor is an xid HORIZON, not a version number:
 * `pg_snapshot_xmin(pg_current_snapshot())` is the lowest transaction id that may still be running,
 * so every transaction with a smaller id has already committed or aborted and cannot add rows
 * below the horizon anymore. A sync run that reads "everything with sync_xid >= previous horizon"
 * therefore never misses a row, however late its transaction commits (long cancellations, lock
 * waits). Rows may be delivered more than once; clients upsert by ticket id and keep the highest
 * `syncVersion`.
 *
 * The cursor is an opaque string (clients must not parse it):
 *   ""                               full sync
 *   c1.<epoch>.<H>                   next run: all rows with sync_xid >= H
 *   c1.<epoch>.<H>.<xid>.<ticketId>  continuation inside a run: rows after (xid, id); H is the
 *                                    horizon taken when the run started and becomes the cursor
 *                                    handed out when the run completes
 * A cursor of another epoch (database restored) or an unparsable cursor means a full sync.
 */

const XID = /^\d{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type ParsedCursor =
  | { kind: 'full' }
  | { kind: 'horizon'; horizon: string }
  | { kind: 'page'; horizon: string; xid: string; id: string };

function parseCursor(cursor: string, epoch: string): ParsedCursor {
  const parts = cursor.split('.');
  if (parts[0] !== 'c1' || parts[1] !== epoch) return { kind: 'full' };
  const horizon = parts[2];
  if (!horizon || !XID.test(horizon)) return { kind: 'full' };
  if (parts.length === 3) return { kind: 'horizon', horizon };
  const xid = parts[3];
  const id = parts[4];
  if (parts.length === 5 && xid && id && XID.test(xid) && UUID.test(id)) {
    return { kind: 'page', horizon, xid, id };
  }
  return { kind: 'full' };
}

/** Current epoch of the sync state; rotated by backup restores. */
export async function getSyncEpoch(db: Executor): Promise<string> {
  const [row] = await db.select({ epoch: scannerSyncState.syncEpoch }).from(scannerSyncState);
  if (row) return row.epoch;
  const epoch = randomUUID();
  await db.insert(scannerSyncState).values({ id: true, syncEpoch: epoch }).onConflictDoNothing();
  const [created] = await db.select({ epoch: scannerSyncState.syncEpoch }).from(scannerSyncState);
  return created?.epoch ?? epoch;
}

export async function syncTickets(
  ctx: CoreContext,
  device: ScannerDeviceAuth,
  params: { eventId: string; cursor: string; limit: number },
): Promise<SyncPage> {
  await requireDeviceEvent(ctx.db, device.id, params.eventId);
  const epoch = await getSyncEpoch(ctx.db);
  const cursor = parseCursor(params.cursor, epoch);

  // The horizon is read BEFORE the data statement: a smaller (earlier) horizon is always safe.
  let runHorizon: string;
  if (cursor.kind === 'page') {
    runHorizon = cursor.horizon;
  } else {
    const [h] = (
      await ctx.db.execute<{ horizon: string }>(
        sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon`,
      )
    ).rows;
    runHorizon = h!.horizon;
  }

  const position =
    cursor.kind === 'page'
      ? sql`(${tickets.syncXid}, ${tickets.id}) > (${cursor.xid}::xid8, ${cursor.id}::uuid)`
      : cursor.kind === 'horizon'
        ? sql`${tickets.syncXid} >= ${cursor.horizon}::xid8`
        : sql`true`;

  const raw = await selectTicketViews(ctx.db)
    .where(and(eq(tickets.eventId, params.eventId), position))
    .orderBy(asc(tickets.syncXid), asc(tickets.id))
    .limit(params.limit + 1);
  const hasMore = raw.length > params.limit;
  const page = raw.slice(0, params.limit);
  const views = await toTicketViews(ctx.db, page);
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? `c1.${epoch}.${runHorizon}.${last.syncXid}.${last.id}`
      : `c1.${epoch}.${runHorizon}`;

  const highest = page.reduce((max, r) => Math.max(max, r.syncVersion), 0);
  await ctx.db
    .update(scannerDevices)
    .set({
      lastSyncAt: new Date(),
      ...(highest > 0
        ? {
            lastSyncVersion: sql`greatest(coalesce(${scannerDevices.lastSyncVersion}, 0), ${highest})`,
          }
        : {}),
    })
    .where(eq(scannerDevices.id, device.id));
  return {
    tickets: views.map(toSyncTicket),
    nextCursor,
    hasMore,
    syncEpoch: epoch,
    serverTime: new Date().toISOString(),
  };
}
