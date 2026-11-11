import {
  devicePairingCodeEvents,
  devicePairingCodes,
  eventScannerSecrets,
  events,
  scannerDeviceEvents,
  scannerDevices,
  seatMapEntrances,
  withTransaction,
  type Executor,
} from '@tix/db';
import {
  buildPairingUri,
  formatPairingCode,
  normalizePairingCode,
  PAIRING_CODE_LENGTH,
  type PairRequest,
} from '@tix/shared';
import { generateHumanCode, generateToken, hashToken } from '@tix/shared/server';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import { getSetting } from '../settings';

/**
 * Device pairing, token authentication and admin management of paired Android scanners.
 * Device tokens (`tixd_<random>`) are stored only as SHA-256; revoking a device makes the token
 * useless immediately (every API call looks the device up).
 */

const DEVICE_TOKEN_PREFIX = 'tixd_';
const LAST_SEEN_THROTTLE_MS = 30_000;

export interface ScannerDeviceAuth {
  id: string;
  name: string;
}

export interface DeviceAssignment {
  eventId: string;
  entranceId?: string | null;
  allowCheckOut: boolean;
}

// ─── Server URL ─────────────────────────────────────────────────────────────

/**
 * Address the app talks to: `scanner.serverUrl`, else the public shop URL. `reachableFromPhone`
 * is false for localhost (a phone cannot open it) so the admin UI can warn.
 */
export async function resolveScannerServerUrl(ctx: CoreContext): Promise<{
  url: string | null;
  reachableFromPhone: boolean;
  explicit: boolean;
  /** Plain http:// to a public host: the device token would travel in clear text. */
  insecure: boolean;
}> {
  const settings = await getSetting(ctx, 'scanner');
  const url = settings.serverUrl ?? ctx.appUrl ?? null;
  if (!url) return { url: null, reachableFromPhone: false, explicit: false, insecure: false };
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return {
      url,
      reachableFromPhone: false,
      explicit: Boolean(settings.serverUrl),
      insecure: false,
    };
  }
  const local = host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
  return {
    url,
    reachableFromPhone: !local,
    explicit: Boolean(settings.serverUrl),
    insecure: url.startsWith('http://') && !local && !isPrivateHost(host),
  };
}

/** Private network / link-local / single-label / .local hosts (plain http is acceptable there). */
function isPrivateHost(host: string): boolean {
  if (!host.includes('.') && !host.includes(':')) return true;
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return host.startsWith('[fe80') || host.startsWith('[fd') || host.startsWith('[fc');
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

// ─── Pairing codes ──────────────────────────────────────────────────────────

async function assertAssignments(db: Executor, assignments: readonly DeviceAssignment[]) {
  if (assignments.length === 0) {
    throw new DomainError('NO_EVENTS', 'Select at least one event', 422);
  }
  const ids = assignments.map((a) => a.eventId);
  if (new Set(ids).size !== ids.length) {
    throw new DomainError('DUPLICATE_EVENT', 'An event can only be assigned once', 422);
  }
  const rows = await db
    .select({ id: events.id, seatMapId: events.seatMapId })
    .from(events)
    .where(inArray(events.id, ids));
  if (rows.length !== ids.length) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  const seatMapOf = new Map(rows.map((r) => [r.id, r.seatMapId]));
  const entranceIds = assignments.flatMap((a) => (a.entranceId ? [a.entranceId] : []));
  if (entranceIds.length > 0) {
    const entrances = await db
      .select({ id: seatMapEntrances.id, seatMapId: seatMapEntrances.seatMapId })
      .from(seatMapEntrances)
      .where(inArray(seatMapEntrances.id, entranceIds));
    const mapOfEntrance = new Map(entrances.map((e) => [e.id, e.seatMapId]));
    for (const a of assignments) {
      if (!a.entranceId) continue;
      const map = seatMapOf.get(a.eventId);
      if (!map || mapOfEntrance.get(a.entranceId) !== map) {
        throw new DomainError('ENTRANCE_NOT_FOUND', 'Entrance does not belong to the event', 422);
      }
    }
  }
}

export interface CreatedPairingCode {
  id: string;
  /** Display form `ABCDE-FGHJK`. */
  code: string;
  /** Content of the QR code (`tixscan://pair?...`). */
  qrPayload: string;
  serverUrl: string;
  expiresAt: Date;
}

export async function createPairingCode(
  ctx: CoreContext,
  params: {
    createdByUserId: string | null;
    label?: string | null;
    assignments: DeviceAssignment[];
  },
): Promise<CreatedPairingCode> {
  const server = await resolveScannerServerUrl(ctx);
  if (!server.url) {
    throw new DomainError(
      'SERVER_URL_MISSING',
      'Set the scanner server address in the scanner settings first',
      422,
    );
  }
  const settings = await getSetting(ctx, 'scanner');
  await assertAssignments(ctx.db, params.assignments);
  const label = params.label?.trim().slice(0, 80) || null;
  const expiresAt = new Date(Date.now() + settings.pairingCodeTtlMinutes * 60_000);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = generateHumanCode(PAIRING_CODE_LENGTH);
    const created = await withTransaction(ctx.db, async (tx) => {
      const [row] = await tx
        .insert(devicePairingCodes)
        .values({
          codeHash: hashToken(code),
          label,
          expiresAt,
          createdByUserId: params.createdByUserId,
        })
        .onConflictDoNothing()
        .returning({ id: devicePairingCodes.id });
      if (!row) return null;
      await tx.insert(devicePairingCodeEvents).values(
        params.assignments.map((a) => ({
          codeId: row.id,
          eventId: a.eventId,
          entranceId: a.entranceId ?? null,
          allowCheckOut: a.allowCheckOut,
        })),
      );
      return row.id;
    });
    if (created) {
      return {
        id: created,
        code: formatPairingCode(code),
        qrPayload: buildPairingUri(server.url, code),
        serverUrl: server.url,
        expiresAt,
      };
    }
  }
  throw new Error('Could not allocate a unique pairing code');
}

export interface PairingCodeStatus {
  status: 'PENDING' | 'CONSUMED' | 'EXPIRED';
  expiresAt: Date;
  deviceId: string | null;
  deviceName: string | null;
}

export async function getPairingCodeStatus(
  ctx: CoreContext,
  codeId: string,
): Promise<PairingCodeStatus> {
  const [row] = await ctx.db
    .select({
      expiresAt: devicePairingCodes.expiresAt,
      consumedAt: devicePairingCodes.consumedAt,
      deviceId: devicePairingCodes.deviceId,
      deviceName: scannerDevices.name,
    })
    .from(devicePairingCodes)
    .leftJoin(scannerDevices, eq(scannerDevices.id, devicePairingCodes.deviceId))
    .where(eq(devicePairingCodes.id, codeId));
  if (!row) throw new DomainError('PAIRING_CODE_NOT_FOUND', 'Pairing code not found', 404);
  return {
    status: row.consumedAt
      ? 'CONSUMED'
      : row.expiresAt.getTime() <= Date.now()
        ? 'EXPIRED'
        : 'PENDING',
    expiresAt: row.expiresAt,
    deviceId: row.deviceId,
    deviceName: row.deviceName,
  };
}

/** Deletes an unused pairing code (it can no longer be exchanged). */
export async function deletePairingCode(ctx: CoreContext, codeId: string): Promise<void> {
  await ctx.db
    .delete(devicePairingCodes)
    .where(and(eq(devicePairingCodes.id, codeId), isNull(devicePairingCodes.consumedAt)));
}

export interface PairedDevice {
  deviceId: string;
  deviceName: string;
  token: string;
}

/**
 * Exchanges a pairing code for a device token. The code is consumed by one conditional UPDATE,
 * so of two concurrent exchanges exactly one wins. The clear token is returned only here.
 */
export async function exchangePairingCode(
  ctx: CoreContext,
  request: PairRequest,
): Promise<PairedDevice> {
  const codeHash = hashToken(normalizePairingCode(request.code));
  return withTransaction(ctx.db, async (tx) => {
    const [code] = await tx
      .update(devicePairingCodes)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(devicePairingCodes.codeHash, codeHash),
          isNull(devicePairingCodes.consumedAt),
          gt(devicePairingCodes.expiresAt, sql`now()`),
        ),
      )
      .returning({
        id: devicePairingCodes.id,
        label: devicePairingCodes.label,
        createdByUserId: devicePairingCodes.createdByUserId,
      });
    if (!code) {
      throw new DomainError(
        'INVALID_PAIRING_CODE',
        'The pairing code is invalid, expired or already used',
        400,
      );
    }
    const token = `${DEVICE_TOKEN_PREFIX}${generateToken(32)}`;
    const name = code.label ?? request.deviceName;
    const [device] = await tx
      .insert(scannerDevices)
      .values({
        name,
        tokenHash: hashToken(token),
        tokenPrefix: token.slice(0, DEVICE_TOKEN_PREFIX.length + 6),
        platform: request.platform ?? null,
        appVersion: request.appVersion ?? null,
        deviceModel: request.deviceModel ?? null,
        pairedByUserId: code.createdByUserId,
        lastSeenAt: new Date(),
      })
      .returning({ id: scannerDevices.id });
    if (!device) throw new Error('Device insert failed');
    const grants = await tx
      .select()
      .from(devicePairingCodeEvents)
      .where(eq(devicePairingCodeEvents.codeId, code.id));
    if (grants.length > 0) {
      await tx.insert(scannerDeviceEvents).values(
        grants.map((g) => ({
          deviceId: device.id,
          eventId: g.eventId,
          entranceId: g.entranceId,
          allowCheckOut: g.allowCheckOut,
        })),
      );
    }
    await tx
      .update(devicePairingCodes)
      .set({ deviceId: device.id })
      .where(eq(devicePairingCodes.id, code.id));
    return { deviceId: device.id, deviceName: name, token };
  });
}

// ─── Authentication ─────────────────────────────────────────────────────────

/**
 * Resolves `Authorization: Bearer <token>` to an active device and records `last_seen_at`
 * (at most every 30 s) and the app version. 401 for unknown tokens (`INVALID_TOKEN`) and
 * revoked devices (`DEVICE_REVOKED`).
 */
export async function authenticateDevice(
  ctx: CoreContext,
  authorization: string | null | undefined,
  options: { appVersion?: string | null } = {},
): Promise<ScannerDeviceAuth> {
  const match = /^Bearer\s+(\S{10,200})$/i.exec(authorization?.trim() ?? '');
  const token = match?.[1];
  if (!token?.startsWith(DEVICE_TOKEN_PREFIX)) {
    throw new DomainError('INVALID_TOKEN', 'Missing or invalid device token', 401);
  }
  const [device] = await ctx.db
    .select({
      id: scannerDevices.id,
      name: scannerDevices.name,
      isActive: scannerDevices.isActive,
      revokedAt: scannerDevices.revokedAt,
      deletedAt: scannerDevices.deletedAt,
      lastSeenAt: scannerDevices.lastSeenAt,
      appVersion: scannerDevices.appVersion,
    })
    .from(scannerDevices)
    .where(eq(scannerDevices.tokenHash, hashToken(token)));
  if (!device) throw new DomainError('INVALID_TOKEN', 'Missing or invalid device token', 401);
  if (!device.isActive || device.revokedAt || device.deletedAt) {
    throw new DomainError('DEVICE_REVOKED', 'This device has been revoked', 401);
  }
  const version = options.appVersion?.trim().slice(0, 40) || null;
  const stale =
    !device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS;
  if (stale || (version && version !== device.appVersion)) {
    await ctx.db
      .update(scannerDevices)
      .set({ lastSeenAt: new Date(), ...(version ? { appVersion: version } : {}) })
      .where(eq(scannerDevices.id, device.id));
  }
  return { id: device.id, name: device.name };
}

// ─── Admin ──────────────────────────────────────────────────────────────────

export interface ScannerDeviceListItem {
  id: string;
  name: string;
  tokenPrefix: string;
  platform: string | null;
  appVersion: string | null;
  deviceModel: string | null;
  isActive: boolean;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
  lastSyncAt: Date | null;
  createdAt: Date;
  assignments: {
    eventId: string;
    eventTitle: string;
    entranceId: string | null;
    entranceName: string | null;
    allowCheckOut: boolean;
  }[];
}

export async function listScannerDevices(ctx: CoreContext): Promise<ScannerDeviceListItem[]> {
  const devices = await ctx.db
    .select()
    .from(scannerDevices)
    .where(isNull(scannerDevices.deletedAt))
    .orderBy(asc(scannerDevices.revokedAt), asc(scannerDevices.name));
  if (devices.length === 0) return [];
  const grants = await ctx.db
    .select({
      deviceId: scannerDeviceEvents.deviceId,
      eventId: scannerDeviceEvents.eventId,
      eventTitle: events.title,
      entranceId: scannerDeviceEvents.entranceId,
      entranceName: seatMapEntrances.name,
      allowCheckOut: scannerDeviceEvents.allowCheckOut,
    })
    .from(scannerDeviceEvents)
    .innerJoin(events, eq(events.id, scannerDeviceEvents.eventId))
    .leftJoin(seatMapEntrances, eq(seatMapEntrances.id, scannerDeviceEvents.entranceId))
    .orderBy(asc(events.startsAt));
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    tokenPrefix: d.tokenPrefix,
    platform: d.platform,
    appVersion: d.appVersion,
    deviceModel: d.deviceModel,
    isActive: d.isActive,
    revokedAt: d.revokedAt,
    lastSeenAt: d.lastSeenAt,
    lastSyncAt: d.lastSyncAt,
    createdAt: d.createdAt,
    assignments: grants
      .filter((g) => g.deviceId === d.id)
      .map(({ deviceId: _deviceId, ...rest }) => rest),
  }));
}

/** Renames a device and/or replaces its event assignments (entrance + check-out per event). */
export async function updateScannerDevice(
  ctx: CoreContext,
  deviceId: string,
  patch: { name?: string; assignments?: DeviceAssignment[] },
): Promise<void> {
  if (patch.assignments) await assertAssignments(ctx.db, patch.assignments);
  await withTransaction(ctx.db, async (tx) => {
    const [device] = await tx
      .select({ id: scannerDevices.id })
      .from(scannerDevices)
      .where(and(eq(scannerDevices.id, deviceId), isNull(scannerDevices.deletedAt)))
      .for('update');
    if (!device) throw new DomainError('DEVICE_NOT_FOUND', 'Device not found', 404);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name || name.length > 80) {
        throw new DomainError('INVALID_NAME', 'The name must be 1 to 80 characters', 422);
      }
      await tx
        .update(scannerDevices)
        .set({ name, updatedAt: new Date() })
        .where(eq(scannerDevices.id, deviceId));
    }
    if (patch.assignments) {
      // Events the device no longer scans: it must not be able to keep using their LAN secret.
      const before = await tx
        .select({ eventId: scannerDeviceEvents.eventId })
        .from(scannerDeviceEvents)
        .where(eq(scannerDeviceEvents.deviceId, deviceId));
      const kept = new Set(patch.assignments.map((a) => a.eventId));
      await rotateLanSecrets(
        tx,
        before.map((b) => b.eventId).filter((id) => !kept.has(id)),
      );
      await tx.delete(scannerDeviceEvents).where(eq(scannerDeviceEvents.deviceId, deviceId));
      await tx.insert(scannerDeviceEvents).values(
        patch.assignments.map((a) => ({
          deviceId,
          eventId: a.eventId,
          entranceId: a.entranceId ?? null,
          allowCheckOut: a.allowCheckOut,
        })),
      );
    }
  });
}

/** Revokes a device: its token is rejected from now on. Idempotent. */
export async function revokeScannerDevice(ctx: CoreContext, deviceId: string): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    const rows = await tx
      .update(scannerDevices)
      .set({
        isActive: false,
        revokedAt: sql`coalesce(${scannerDevices.revokedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(and(eq(scannerDevices.id, deviceId), isNull(scannerDevices.deletedAt)))
      .returning({ id: scannerDevices.id });
    if (rows.length === 0) throw new DomainError('DEVICE_NOT_FOUND', 'Device not found', 404);
    // The revoked device knows the LAN secrets of its events: rotate them (other devices pick
    // the new secret up with their next manifest).
    const assigned = await tx
      .select({ eventId: scannerDeviceEvents.eventId })
      .from(scannerDeviceEvents)
      .where(eq(scannerDeviceEvents.deviceId, deviceId));
    await rotateLanSecrets(
      tx,
      assigned.map((a) => a.eventId),
    );
  });
}

/**
 * Deletes a revoked device from the admin: the row is archived (`deleted_at`), not removed, so
 * the scan journal and "first scanned by" still show its name. Its event assignments and
 * pairing codes are dropped. 409 `DEVICE_NOT_REVOKED` for active devices, 404 for unknown or
 * already deleted ones.
 */
export async function deleteScannerDevice(ctx: CoreContext, deviceId: string): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    const [device] = await tx
      .select({ revokedAt: scannerDevices.revokedAt, isActive: scannerDevices.isActive })
      .from(scannerDevices)
      .where(and(eq(scannerDevices.id, deviceId), isNull(scannerDevices.deletedAt)))
      .for('update');
    if (!device) throw new DomainError('DEVICE_NOT_FOUND', 'Device not found', 404);
    if (!device.revokedAt || device.isActive) {
      throw new DomainError(
        'DEVICE_NOT_REVOKED',
        'Only revoked devices can be deleted; revoke the device first',
        409,
      );
    }
    await tx.delete(scannerDeviceEvents).where(eq(scannerDeviceEvents.deviceId, deviceId));
    await tx.delete(devicePairingCodes).where(eq(devicePairingCodes.deviceId, deviceId));
    await tx
      .update(scannerDevices)
      .set({ deletedAt: sql`now()`, updatedAt: new Date() })
      .where(eq(scannerDevices.id, deviceId));
  });
}

/** Drops the LAN secrets of the events; the manifest creates fresh ones on demand. */
async function rotateLanSecrets(db: Executor, eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;
  await db.delete(eventScannerSecrets).where(inArray(eventScannerSecrets.eventId, eventIds));
}

/** Events a pairing / assignment form offers, with their entrances. */
export interface ScannerEventOption {
  id: string;
  title: string;
  startsAt: Date;
  status: string;
  entrances: { id: string; name: string; code: string }[];
}

export async function listScannerEventOptions(ctx: CoreContext): Promise<ScannerEventOption[]> {
  const rows = await ctx.db
    .select({
      id: events.id,
      title: events.title,
      startsAt: events.startsAt,
      status: events.status,
      seatMapId: events.seatMapId,
    })
    .from(events)
    .where(sql`${events.status} <> 'ARCHIVED'`)
    .orderBy(asc(events.startsAt));
  const mapIds = rows.flatMap((r) => (r.seatMapId ? [r.seatMapId] : []));
  const entrances =
    mapIds.length > 0
      ? await ctx.db
          .select({
            id: seatMapEntrances.id,
            seatMapId: seatMapEntrances.seatMapId,
            name: seatMapEntrances.name,
            code: seatMapEntrances.code,
          })
          .from(seatMapEntrances)
          .where(inArray(seatMapEntrances.seatMapId, mapIds))
          .orderBy(asc(seatMapEntrances.sortOrder), asc(seatMapEntrances.name))
      : [];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    startsAt: r.startsAt,
    status: r.status,
    entrances: entrances
      .filter((e) => e.seatMapId === r.seatMapId)
      .map(({ seatMapId: _s, ...rest }) => rest),
  }));
}

/** The device's assignment for an event, or a 403 when the event is not assigned to it. */
export async function requireDeviceEvent(
  db: Executor,
  deviceId: string,
  eventId: string,
): Promise<{ entranceId: string | null; allowCheckOut: boolean }> {
  const [row] = await db
    .select({
      entranceId: scannerDeviceEvents.entranceId,
      allowCheckOut: scannerDeviceEvents.allowCheckOut,
    })
    .from(scannerDeviceEvents)
    .where(
      and(eq(scannerDeviceEvents.deviceId, deviceId), eq(scannerDeviceEvents.eventId, eventId)),
    );
  if (!row)
    throw new DomainError('EVENT_NOT_ASSIGNED', 'This event is not assigned to the device', 403);
  return row;
}
