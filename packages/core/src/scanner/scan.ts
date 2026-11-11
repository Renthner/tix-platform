import {
  checkInLogs,
  orderItems,
  orders,
  scannerDeviceEvents,
  seatMapEntrances,
  tickets,
  withTransaction,
  type Executor,
} from '@tix/db';
import {
  decideScan,
  isAcceptedResult,
  normalizeTicketCode,
  parseTicketPayload,
  SCAN_CLOCK_SKEW_SECONDS,
  scanColor,
  verifyTicketPayload,
  type LookupQuery,
  type LookupResponse,
  type ScanOutcome,
  type ScanRequest,
} from '@tix/shared';
import type { ScanResult, ScanWarning } from '@tix/shared';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { CoreContext } from '../context';
import { getSetting } from '../settings';
import { eventPublicKeys } from '../tickets/keys';
import { requireDeviceEvent, type ScannerDeviceAuth } from './devices';
import { loadTicketViews, toDecisionTicket, toDisplay, type TicketView } from './ticket-view';

/**
 * Applies scans to tickets. Online scans and uploaded offline scans share ONE code path
 * (`processScans`):
 *
 *  1. Each scan is resolved to a ticket (QR payload: syntax + Ed25519 signature against the
 *     event keys, REVOKED keys never verify; or ticket id / code from the manual lookup).
 *  2. One transaction locks all affected ticket rows `FOR UPDATE ORDER BY id` (stable order, so
 *     concurrent batches cannot deadlock), re-reads their state and decides every scan with the
 *     pure `decideScan` (docs/SCANNER.md) against the CURRENT server state. A batch is applied
 *     in `scanned_at` order.
 *  3. The decision is appended to the immutable journal `check_in_logs` (unique on
 *     `(device_id, client_scan_id)`: a retry returns the recorded decision) and the ticket's
 *     denormalised state is updated.
 *
 * Offline merge (rules in docs/SCANNER.md):
 *  - a scan is STALE when it is older than the ticket's last state-changing scan; a stale scan is
 *    journaled but never changes check_in_state / check_in_count / last_scan_at,
 *  - any check-in older than `first_checked_in_at` moves `first_checked_in_*` to that scan.
 */

type LogRow = typeof checkInLogs.$inferSelect;

interface Planned {
  scan: ScanRequest;
  index: number;
  scannedAt: Date;
  clamped: boolean;
  /** Set when the scan is rejected before any ticket state is looked at. */
  early?: { result: ScanResult; recorded: boolean };
  ticketId?: string;
}

const iso = (d: Date) => d.toISOString();

function outcomeBase(
  scan: ScanRequest,
  result: ScanResult,
  warnings: ScanWarning[],
  view: TicketView | null,
  flags: { duplicate: boolean; recorded: boolean },
): ScanOutcome {
  const warningTexts: Record<string, string> = {};
  if (warnings.includes('DISCOUNT_PROOF_REQUIRED') && view?.scannerWarning) {
    warningTexts.DISCOUNT_PROOF_REQUIRED = view.scannerWarning;
  }
  return {
    clientScanId: scan.clientScanId,
    result,
    color: scanColor(result),
    warnings,
    warningTexts,
    duplicate: flags.duplicate,
    recorded: flags.recorded,
    ticket: view ? toDisplay(view) : null,
    firstScan: view?.firstCheckedInAt
      ? { at: iso(view.firstCheckedInAt), deviceName: view.firstCheckedInDeviceName }
      : null,
  };
}

/** Online scan: one scan, evaluated immediately. */
export async function scanOnline(
  ctx: CoreContext,
  device: ScannerDeviceAuth,
  scan: ScanRequest,
): Promise<ScanOutcome> {
  const [outcome] = await processScans(ctx, device, [scan], { offline: false });
  if (!outcome) throw new Error('scan produced no outcome');
  return outcome;
}

/** Uploads scans taken offline. Idempotent per `clientScanId`; returns one outcome per scan, in order. */
export async function uploadOfflineScans(
  ctx: CoreContext,
  device: ScannerDeviceAuth,
  scans: ScanRequest[],
  options: { sentAt?: string } = {},
): Promise<ScanOutcome[]> {
  return processScans(ctx, device, scans, { offline: true, sentAt: options.sentAt });
}

export async function processScans(
  ctx: CoreContext,
  device: ScannerDeviceAuth,
  scans: ScanRequest[],
  options: { offline: boolean; sentAt?: string },
): Promise<ScanOutcome[]> {
  const settings = await getSetting(ctx, 'scanner');
  const assignmentRows = await ctx.db
    .select()
    .from(scannerDeviceEvents)
    .where(eq(scannerDeviceEvents.deviceId, device.id));
  const assignments = new Map(assignmentRows.map((a) => [a.eventId, a]));
  const now = Date.now();
  // Device clock skew of this request: the server moves every scan time by (serverNow - sentAt).
  const sentAt = options.sentAt ? new Date(options.sentAt).getTime() : null;
  const skewMs = sentAt === null ? 0 : now - sentAt;
  // Without sentAt a device clock up to 5 minutes ahead is tolerated; with it only a few seconds.
  const aheadAllowanceMs = sentAt === null ? SCAN_CLOCK_SKEW_SECONDS * 1000 : 5_000;

  // ── 1. resolve scans to tickets (no locks yet) ───────────────────────────────
  const keyCache = new Map<string, Map<string, string>>();
  const keysOf = async (eventId: string) => {
    let keys = keyCache.get(eventId);
    if (!keys) {
      const rows = await eventPublicKeys(ctx, eventId, { excludeRevoked: true });
      keys = new Map(rows.map((k) => [k.keyId, k.publicKey]));
      keyCache.set(eventId, keys);
    }
    return keys;
  };

  const planned: Planned[] = [];
  const codeLookups: { plan: Planned; code: string }[] = [];
  for (const [index, scan] of scans.entries()) {
    const device_time = new Date(new Date(scan.scannedAt).getTime() + skewMs);
    const clamped = options.offline && device_time.getTime() > now + aheadAllowanceMs;
    const plan: Planned = {
      scan,
      index,
      // Online scans are decided at the server receive time (the device clock is not trusted).
      scannedAt: !options.offline || clamped ? new Date(now) : device_time,
      clamped,
    };
    planned.push(plan);
    if (!assignments.has(scan.eventId)) {
      plan.early = { result: 'REJECTED_WRONG_EVENT', recorded: false };
      continue;
    }
    if (scan.payload !== undefined) {
      const keys = await keysOf(scan.eventId);
      const verified = await verifyTicketPayload(scan.payload, scan.eventId, (_event, keyId) =>
        keys.get(keyId),
      );
      if (verified.ok) plan.ticketId = verified.ticket.ticketId;
      else {
        const result: ScanResult =
          verified.reason === 'MALFORMED'
            ? 'REJECTED_MALFORMED'
            : verified.reason === 'WRONG_EVENT'
              ? 'REJECTED_WRONG_EVENT'
              : 'REJECTED_INVALID_SIGNATURE';
        // A payload of another event that is not parseable at all stays "malformed".
        plan.early = { result, recorded: true };
      }
    } else if (scan.ticketId !== undefined) {
      plan.ticketId = scan.ticketId.toLowerCase();
    } else if (scan.ticketCode !== undefined) {
      codeLookups.push({ plan, code: normalizeTicketCode(scan.ticketCode) });
    }
  }
  if (codeLookups.length > 0) {
    const rows = await ctx.db
      .select({ id: tickets.id, code: tickets.ticketCode, eventId: tickets.eventId })
      .from(tickets)
      .where(
        inArray(
          tickets.ticketCode,
          codeLookups.map((c) => c.code),
        ),
      );
    for (const { plan, code } of codeLookups) {
      const hit = rows.find((r) => r.code === code && r.eventId === plan.scan.eventId);
      if (hit) plan.ticketId = hit.id;
      else plan.early = { result: 'REJECTED_UNKNOWN_TICKET', recorded: true };
    }
  }

  // ── 2. entrances: an entrance deleted in the editor must not poison the whole batch ──
  const requestedEntrances = [
    ...new Set(scans.flatMap((s) => (s.entranceId ? [s.entranceId] : []))),
  ];
  const knownEntrances = new Set(
    requestedEntrances.length > 0
      ? (
          await ctx.db
            .select({ id: seatMapEntrances.id })
            .from(seatMapEntrances)
            .where(inArray(seatMapEntrances.id, requestedEntrances))
        ).map((e) => e.id)
      : [],
  );
  const entranceOf = (scan: ScanRequest, fallback: string | null): string | null =>
    scan.entranceId && knownEntrances.has(scan.entranceId) ? scan.entranceId : fallback;

  const clientIds = scans.map((s) => s.clientScanId);
  const ticketIds = new Set<string>();
  for (const p of planned) if (p.ticketId && !p.early) ticketIds.add(p.ticketId);

  // ── 3. decide + apply atomically ─────────────────────────────────────────────
  const outcomes = new Map<number, ScanOutcome>();
  await withTransaction(ctx.db, async (tx) => {
    const ids = [...ticketIds].sort();
    if (ids.length > 0) {
      await tx
        .select({ id: tickets.id })
        .from(tickets)
        .where(inArray(tickets.id, ids))
        .orderBy(tickets.id)
        .for('update');
    }
    // Read AFTER the lock: a concurrent retry of the same batch that was applied while we
    // waited is visible now (READ COMMITTED) and must not be applied a second time.
    const recordedBefore = await readLogs(tx, device.id, clientIds);
    const viewIds = new Set(ids);
    for (const log of recordedBefore.values()) if (log.ticketId) viewIds.add(log.ticketId);
    const views = new Map<string, TicketView>();
    if (viewIds.size > 0) {
      for (const v of await loadTicketViews(tx, inArray(tickets.id, [...viewIds]))) {
        views.set(v.id, v);
      }
    }
    const doneThisRun = new Map<string, LogRow>();
    const sorted = [...planned].sort(
      (a, b) => a.scannedAt.getTime() - b.scannedAt.getTime() || a.index - b.index,
    );
    for (const plan of sorted) {
      const { scan } = plan;
      const known = recordedBefore.get(scan.clientScanId) ?? doneThisRun.get(scan.clientScanId);
      if (known) {
        outcomes.set(
          plan.index,
          fromLog(scan, known, known.ticketId ? views.get(known.ticketId) : undefined),
        );
        continue;
      }
      if (plan.early && !plan.early.recorded) {
        outcomes.set(
          plan.index,
          outcomeBase(scan, plan.early.result, [], null, { duplicate: false, recorded: false }),
        );
        continue;
      }
      const assignment = assignments.get(scan.eventId)!;
      const entranceId = entranceOf(scan, assignment.entranceId);
      const view = plan.early || !plan.ticketId ? undefined : views.get(plan.ticketId);
      // A ticket of another event is "wrong event", not "unknown".
      const wrongEvent = view !== undefined && view.eventId !== scan.eventId;
      const ticketRow = view && !wrongEvent ? view : undefined;
      // A scan cannot predate the ticket itself (broken device clock): lower bound = issued_at.
      const beforeIssue =
        ticketRow !== undefined && plan.scannedAt.getTime() < ticketRow.issuedAt.getTime();
      const at = beforeIssue ? ticketRow.issuedAt : plan.scannedAt;
      const stale =
        ticketRow !== undefined &&
        ticketRow.lastScanAt !== null &&
        at.getTime() < ticketRow.lastScanAt.getTime();
      const scannedBeforeFirstEntry =
        ticketRow !== undefined &&
        ticketRow.firstCheckedInAt !== null &&
        at.getTime() < ticketRow.firstCheckedInAt.getTime();
      // A check-out of this ticket in the same upload between this scan and the first entry?
      const exitBetween =
        scannedBeforeFirstEntry &&
        ticketRow?.firstCheckedInAt != null &&
        planned.some(
          (other) =>
            other.ticketId === plan.ticketId &&
            other.scan.action === 'CHECK_OUT' &&
            other.scannedAt.getTime() > at.getTime() &&
            other.scannedAt.getTime() < ticketRow.firstCheckedInAt!.getTime(),
        );
      const decision = plan.early
        ? { result: plan.early.result, warnings: [] as ScanWarning[], nextState: null }
        : wrongEvent
          ? {
              result: 'REJECTED_WRONG_EVENT' as ScanResult,
              warnings: [] as ScanWarning[],
              nextState: null,
            }
          : decideScan({
              action: scan.action,
              ticket: view ? toDecisionTicket(view) : null,
              deviceEntranceId: entranceId,
              checkOutAllowed: settings.allowCheckOut && assignment.allowCheckOut,
              stale,
              scannedBeforeFirstEntry,
              exitBetween,
            });
      // Any check-in older than the recorded first entry is the real first one (VALID tickets).
      const movesFirstEntry =
        ticketRow !== undefined &&
        ticketRow.status === 'VALID' &&
        scan.action === 'CHECK_IN' &&
        scannedBeforeFirstEntry &&
        decision.result !== 'REJECTED_TICKET_VOID';
      // Offline check-ins that find the ticket already inside: two entries without a check-out
      // (possible copied ticket) - flagged for the admin views.
      const duplicateEntry =
        options.offline &&
        scan.action === 'CHECK_IN' &&
        decision.result === 'REJECTED_ALREADY_CHECKED_IN';
      const message = duplicateEntry
        ? 'DUPLICATE_ENTRY'
        : stale
          ? movesFirstEntry
            ? 'STALE_SCAN_FIRST_ENTRY'
            : 'STALE_SCAN'
          : plan.clamped
            ? 'DEVICE_CLOCK_AHEAD'
            : beforeIssue
              ? 'SCAN_BEFORE_ISSUE'
              : null;

      // Journal first: the unique (device, client_scan_id) decides who applies the scan. If a
      // concurrent request recorded it meanwhile, nothing below may run a second time.
      const [inserted] = await tx
        .insert(checkInLogs)
        .values({
          eventId: scan.eventId,
          ticketId: ticketRow?.id ?? null,
          deviceId: device.id,
          clientScanId: scan.clientScanId,
          entranceId,
          action: scan.action,
          source: scan.source,
          result: decision.result,
          warnings: decision.warnings,
          // Forensics for rejected scans only (accepted scans reference the ticket).
          rawPayload: isAcceptedResult(decision.result)
            ? null
            : ((scan.payload ?? scan.ticketCode ?? scan.ticketId ?? null)?.slice(0, 512) ?? null),
          message,
          scannedAt: at,
          wasOffline: options.offline,
        })
        .onConflictDoNothing({ target: [checkInLogs.deviceId, checkInLogs.clientScanId] })
        .returning();
      if (!inserted) {
        const existing = (await readLogs(tx, device.id, [scan.clientScanId])).get(
          scan.clientScanId,
        );
        if (existing) {
          doneThisRun.set(scan.clientScanId, existing);
          outcomes.set(
            plan.index,
            fromLog(scan, existing, existing.ticketId ? views.get(existing.ticketId) : undefined),
          );
        }
        continue;
      }
      doneThisRun.set(scan.clientScanId, inserted);

      if (ticketRow && decision.nextState === 'CHECKED_IN') {
        await tx
          .update(tickets)
          .set({
            checkInState: 'CHECKED_IN',
            checkInCount: sql`${tickets.checkInCount} + 1`,
            firstCheckedInAt: ticketRow.firstCheckedInAt ?? at,
            firstCheckedInDeviceId: ticketRow.firstCheckedInAt
              ? ticketRow.firstCheckedInDeviceId
              : device.id,
            lastScanAt: at,
          })
          .where(eq(tickets.id, ticketRow.id));
        if (!ticketRow.firstCheckedInAt) {
          ticketRow.firstCheckedInAt = at;
          ticketRow.firstCheckedInDeviceId = device.id;
          ticketRow.firstCheckedInDeviceName = device.name;
        }
        ticketRow.checkInCount += 1;
        ticketRow.checkInState = 'CHECKED_IN';
        ticketRow.lastScanAt = at;
      } else if (ticketRow && decision.nextState === 'CHECKED_OUT') {
        await tx
          .update(tickets)
          .set({ checkInState: 'CHECKED_OUT', lastScanAt: at })
          .where(eq(tickets.id, ticketRow.id));
        ticketRow.checkInState = 'CHECKED_OUT';
        ticketRow.lastScanAt = at;
      } else if (ticketRow && movesFirstEntry) {
        await tx
          .update(tickets)
          .set({ firstCheckedInAt: at, firstCheckedInDeviceId: device.id })
          .where(eq(tickets.id, ticketRow.id));
        ticketRow.firstCheckedInAt = at;
        ticketRow.firstCheckedInDeviceId = device.id;
        ticketRow.firstCheckedInDeviceName = device.name;
      }

      outcomes.set(
        plan.index,
        outcomeBase(scan, decision.result, decision.warnings, ticketRow ?? null, {
          duplicate: false,
          recorded: true,
        }),
      );
    }
  });

  return planned.map((p) => {
    const outcome = outcomes.get(p.index);
    if (!outcome) throw new Error(`scan ${p.scan.clientScanId} was not processed`);
    return outcome;
  });
}

async function readLogs(
  db: Executor,
  deviceId: string,
  clientScanIds: string[],
): Promise<Map<string, LogRow>> {
  if (clientScanIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(checkInLogs)
    .where(
      and(eq(checkInLogs.deviceId, deviceId), inArray(checkInLogs.clientScanId, clientScanIds)),
    );
  return new Map(rows.flatMap((r) => (r.clientScanId ? [[r.clientScanId, r] as const] : [])));
}

function fromLog(scan: ScanRequest, log: LogRow, view: TicketView | undefined): ScanOutcome {
  return outcomeBase(scan, log.result, log.warnings, view ?? null, {
    duplicate: true,
    recorded: true,
  });
}

// ─── Manual lookup ──────────────────────────────────────────────────────────

const SEAT_STOP_WORDS = new Set([
  'block',
  'bereich',
  'sektor',
  'reihe',
  'row',
  'platz',
  'sitz',
  'seat',
  'nr',
  'no',
  'tisch',
  'table',
]);

const escapeRegex = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

/**
 * Search tickets of an event by attendee / buyer name, ticket code, order number or seat
 * ("Block A Reihe 3 Platz 5", "A 3 5": every word must occur as a whole word in block + row +
 * seat labels). VALID tickets first; at most `limit` results.
 */
export async function lookupTickets(
  ctx: CoreContext,
  device: ScannerDeviceAuth,
  query: LookupQuery,
): Promise<LookupResponse> {
  await requireDeviceEvent(ctx.db, device.id, query.eventId);
  const q = query.q.trim();
  const like = `%${escapeLike(q)}%`;
  const conditions: SQL[] = [
    sql`${tickets.attendeeName} ILIKE ${like}`,
    sql`(${orders.firstName} || ' ' || ${orders.lastName}) ILIKE ${like}`,
    sql`${orders.orderNumber} ILIKE ${like}`,
  ];
  const code = normalizeTicketCode(q);
  if (/^[0-9A-Z]{4,10}$/.test(code)) conditions.push(sql`${tickets.ticketCode} = ${code}`);
  const words = q
    .toLowerCase()
    .split(/[\s,/|:;.-]+/)
    .filter((w) => w.length > 0 && !SEAT_STOP_WORDS.has(w));
  if (words.length >= 2 || words.some((w) => /\d/.test(w))) {
    const place = sql`concat_ws(' ', ${orderItems.sectionLabel}, ${orderItems.rowLabel}, ${orderItems.seatLabel})`;
    conditions.push(
      and(
        ...words.map(
          (w) => sql`${place} ~* ${`(^|[^[:alnum:]])${escapeRegex(w)}([^[:alnum:]]|$)`}`,
        ),
      )!,
    );
  }
  const where = and(eq(tickets.eventId, query.eventId), sql`(${sql.join(conditions, sql` OR `)})`)!;
  const raw = await ctx.db
    .select({ id: tickets.id })
    .from(tickets)
    .innerJoin(orders, eq(orders.id, tickets.orderId))
    .innerJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
    .where(where)
    .orderBy(
      sql`(${tickets.status} = 'VALID') DESC`,
      sql`coalesce(${tickets.attendeeName}, ${orders.lastName})`,
      tickets.id,
    )
    .limit(query.limit);
  if (raw.length === 0) return { tickets: [] };
  const views = await loadTicketViews(
    ctx.db,
    inArray(
      tickets.id,
      raw.map((r) => r.id),
    ),
  );
  const byId = new Map(views.map((v) => [v.id, v]));
  return {
    tickets: raw.flatMap((r) => {
      const v = byId.get(r.id);
      return v
        ? [
            {
              ...toDisplay(v),
              orderNumber: v.orderNumber,
              buyerName: v.buyerName,
              firstCheckedInAt: v.firstCheckedInAt ? iso(v.firstCheckedInAt) : null,
            },
          ]
        : [];
    }),
  };
}
