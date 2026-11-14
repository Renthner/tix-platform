import { createHash } from 'node:crypto';
import {
  eventScannerSecrets,
  events,
  priceCategories,
  scannerDeviceEvents,
  seatMapEntrances,
  seatMapSections,
  ticketTypes,
  venues,
} from '@tix/db';
import {
  APP_VERSION,
  SCANNER_API_VERSION,
  SCAN_WARNING_PRIORITY,
  type Manifest,
} from '@tix/shared';
import { generateToken } from '@tix/shared/server';
import { asc, eq } from 'drizzle-orm';
import { requireCapability, type CoreContext } from '../context';
import { getSetting } from '../settings';
import { ensureEventSigningKey, eventPublicKeys } from '../tickets/keys';
import type { ScannerDeviceAuth } from './devices';
import { getSyncEpoch } from './sync';

const lanAad = (eventId: string) => `scanner-lan:${eventId}`;

/**
 * The event's LAN shared secret (base64url, 32 random bytes), created on first use. Scanners at
 * one venue use it to authenticate peer-to-peer messages with HMAC; it only ever leaves the
 * server inside the manifest of a device that is assigned to the event.
 */
export async function ensureEventLanSecret(ctx: CoreContext, eventId: string): Promise<string> {
  const secrets = requireCapability(ctx, 'secrets');
  const read = async () => {
    const [row] = await ctx.db
      .select({ value: eventScannerSecrets.lanSecretEncrypted })
      .from(eventScannerSecrets)
      .where(eq(eventScannerSecrets.eventId, eventId));
    return row ? secrets.decryptJson<{ secret: string }>(row.value, lanAad(eventId)).secret : null;
  };
  const existing = await read();
  if (existing) return existing;
  await ctx.db
    .insert(eventScannerSecrets)
    .values({
      eventId,
      lanSecretEncrypted: secrets.encryptJson({ secret: generateToken(32) }, lanAad(eventId)),
    })
    .onConflictDoNothing();
  const created = await read();
  if (!created) throw new Error('LAN secret could not be created');
  return created;
}

/** Everything a device needs to scan its assigned events (offline included). */
export async function buildManifest(
  ctx: CoreContext,
  device: ScannerDeviceAuth,
): Promise<Manifest> {
  const settings = await getSetting(ctx, 'scanner');
  const assigned = await ctx.db
    .select({
      id: events.id,
      title: events.title,
      subtitle: events.subtitle,
      startsAt: events.startsAt,
      doorsOpenAt: events.doorsOpenAt,
      endsAt: events.endsAt,
      timeZone: events.timeZone,
      seatMapId: events.seatMapId,
      venueName: venues.name,
      entranceId: scannerDeviceEvents.entranceId,
      deviceAllowsCheckOut: scannerDeviceEvents.allowCheckOut,
    })
    .from(scannerDeviceEvents)
    .innerJoin(events, eq(events.id, scannerDeviceEvents.eventId))
    .innerJoin(venues, eq(venues.id, events.venueId))
    .where(eq(scannerDeviceEvents.deviceId, device.id))
    .orderBy(asc(events.startsAt), asc(events.id));

  const manifestEvents: Manifest['events'] = [];
  for (const ev of assigned) {
    // The key must reach the devices before the first ticket is sold (offline verification).
    await ensureEventSigningKey(ctx, ev.id);
    const [keys, types, categories, entrances, sections] = await Promise.all([
      eventPublicKeys(ctx, ev.id),
      ctx.db
        .select({
          id: ticketTypes.id,
          name: ticketTypes.name,
          requiresProof: ticketTypes.requiresProofAtEntry,
          scannerWarning: ticketTypes.scannerWarning,
        })
        .from(ticketTypes)
        .where(eq(ticketTypes.eventId, ev.id))
        .orderBy(asc(ticketTypes.sortOrder), asc(ticketTypes.id)),
      ctx.db
        .select({
          id: priceCategories.id,
          name: priceCategories.name,
          color: priceCategories.color,
        })
        .from(priceCategories)
        .where(eq(priceCategories.eventId, ev.id))
        .orderBy(asc(priceCategories.id)),
      ev.seatMapId
        ? ctx.db
            .select({
              id: seatMapEntrances.id,
              name: seatMapEntrances.name,
              code: seatMapEntrances.code,
            })
            .from(seatMapEntrances)
            .where(eq(seatMapEntrances.seatMapId, ev.seatMapId))
            .orderBy(asc(seatMapEntrances.sortOrder), asc(seatMapEntrances.id))
        : Promise.resolve([]),
      ev.seatMapId
        ? ctx.db
            .select({
              id: seatMapSections.id,
              name: seatMapSections.name,
              entranceId: seatMapSections.entranceId,
            })
            .from(seatMapSections)
            .where(eq(seatMapSections.seatMapId, ev.seatMapId))
            .orderBy(asc(seatMapSections.id))
        : Promise.resolve([]),
    ]);
    const lanEnabled = settings.lanSyncEnabled;
    manifestEvents.push({
      id: ev.id,
      title: ev.title,
      subtitle: ev.subtitle,
      startsAt: ev.startsAt.toISOString(),
      doorsOpenAt: ev.doorsOpenAt?.toISOString() ?? null,
      endsAt: ev.endsAt?.toISOString() ?? null,
      timeZone: ev.timeZone,
      venueName: ev.venueName,
      entranceId: ev.entranceId,
      allowCheckOut: settings.allowCheckOut && ev.deviceAllowsCheckOut,
      // A revoked key is listed (so the app drops it) but its public key is never shipped.
      keys: keys.map((k) => ({
        keyId: k.keyId,
        status: k.status,
        publicKey: k.status === 'REVOKED' ? null : k.publicKey,
      })),
      ticketTypes: types,
      categories,
      entrances,
      sections,
      lan: {
        enabled: lanEnabled,
        secret: lanEnabled ? await ensureEventLanSecret(ctx, ev.id) : null,
      },
    });
  }

  const content = {
    apiVersion: SCANNER_API_VERSION,
    // Part of the content, so the etag changes with every server upgrade and apps re-read the target version.
    serverVersion: APP_VERSION,
    syncEpoch: await getSyncEpoch(ctx.db),
    device: { id: device.id, name: device.name },
    settings: {
      offlineModeAllowed: settings.offlineModeAllowed,
      lanSyncEnabled: settings.lanSyncEnabled,
      syncIntervalSeconds: settings.syncIntervalSeconds,
      resultColors: settings.resultColors,
      warningPriority: [...SCAN_WARNING_PRIORITY],
      appUpdate: {
        source: settings.appUpdateSource,
        githubRepository: settings.githubRepository,
        defaultChannel: settings.defaultUpdateChannel,
        allowChannelOverride: settings.allowChannelOverride,
      },
    },
    events: manifestEvents,
  };
  const etag = createHash('sha256')
    .update(JSON.stringify(content))
    .digest('base64url')
    .slice(0, 22);
  return { ...content, etag, serverTime: new Date().toISOString() };
}
