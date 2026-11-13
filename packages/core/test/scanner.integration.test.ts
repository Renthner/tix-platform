/**
 * Android scanner server side against real PostgreSQL (throw-away database): pairing, device
 * auth, manifest, delta sync incl. tombstones and the settle window, online scan decisions,
 * idempotent retries, concurrency, offline batch merge, lookup, admin read models and APK
 * releases (fake object storage).
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  checkInLogs,
  createDb,
  customers,
  devicePairingCodes,
  eventSigningKeys,
  events,
  orderAdjustments,
  orderItems,
  orders,
  priceCategories,
  scannerDeviceEvents,
  scannerDevices,
  scannerSyncState,
  seatMapEntrances,
  seatMapSections,
  seatMaps,
  seats,
  taxRates,
  tickets,
  ticketTypes,
  venues,
  loadRootEnv,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import {
  buildPairingUri,
  APP_VERSION,
  buildTicketPayload,
  scanColor,
  type ScanRequest,
  type SyncTicket,
} from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { and, eq, like, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { carryForwardSql } from '../src/backup/pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APK_MIN_BYTES,
  appLatestInfo,
  githubStaffDownloadUrl,
  authenticateDevice,
  buildManifest,
  createApkDownloadToken,
  createCoreContext,
  createPairingCode,
  deleteApkRelease,
  deleteScannerDevice,
  listScanLogDevices,
  ensureEventSigningKey,
  ensureOrderTickets,
  exchangePairingCode,
  getCheckInStats,
  getSyncEpoch,
  getPairingCodeStatus,
  listApkReleases,
  listScanLog,
  listScannerDevices,
  lookupTickets,
  openApkForToken,
  registerApkRelease,
  revokeEventSigningKey,
  revokeScannerDevice,
  saveSetting,
  scanOnline,
  setCurrentApkRelease,
  syncTickets,
  updateScannerDevice,
  uploadOfflineScans,
  voidTicketsForItems,
  type CoreContext,
  type ScannerDeviceAuth,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)('scanner server side (integration)', () => {
  const dbName = `tix_scanner_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let dbUrl = '';
  let redis: Redis;
  let ctx: CoreContext;
  let eventId: string;
  let otherEventId: string;
  let sectionId: string;
  let seatedSectionId: string;
  let northId: string;
  let southId: string;
  let categoryId: string;
  let normalTypeId: string;
  let reducedTypeId: string;
  let wheelchairSeatId: string;
  let mapId: string;
  let seq = 0;
  const storageObjects = new Map<string, Uint8Array>();

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    dbUrl = url.toString();
    await runMigrations({
      connectionString: url.toString(),
      migrationsFolder: resolve(import.meta.dirname, '../../db/migrations'),
      log: () => {},
    });
    handle = createDb({ connectionString: url.toString(), poolMax: 30 });
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${uuid().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      appUrl: 'http://192.168.1.20:8080',
      secrets: createSecretBox(parseKeyRing(generateKeyRingEntry('t1'))),
      storage: {
        put: async (_b: string, key: string, body: Uint8Array | string) => {
          storageObjects.set(key, typeof body === 'string' ? new TextEncoder().encode(body) : body);
        },
        getStream: async (_b: string, key: string) => {
          const body = storageObjects.get(key);
          if (!body) throw new Error('missing');
          return {
            stream: new Blob([body as unknown as ArrayBuffer]).stream(),
            contentType: undefined,
          };
        },
        get: async (_b: string, key: string) => {
          const body = storageObjects.get(key);
          if (!body) throw new Error('missing');
          return { body, contentType: undefined };
        },
        delete: async (_b: string, key: string) => {
          storageObjects.delete(key);
        },
      } as unknown as CoreContext['storage'],
    });

    const [venue] = await handle.db
      .insert(venues)
      .values({ name: 'Hall', slug: `hall-${uuid().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning();
    const [map] = await handle.db
      .insert(seatMaps)
      .values({
        venueId: venue!.id,
        kind: 'EVENT',
        name: 'Hall',
        canvasWidth: 100,
        canvasHeight: 100,
      })
      .returning();
    const [north, south] = await handle.db
      .insert(seatMapEntrances)
      .values([
        { seatMapId: map!.id, name: 'North', code: 'N', x: 0, y: 0 },
        { seatMapId: map!.id, name: 'South', code: 'S', x: 1, y: 1 },
      ])
      .returning();
    northId = north!.id;
    southId = south!.id;
    const geometry = { type: 'rect' as const, x: 0, y: 0, width: 50, height: 50, rotation: 0 };
    const [floor] = await handle.db
      .insert(seatMapSections)
      .values({
        seatMapId: map!.id,
        type: 'STANDING',
        capacity: 500,
        geometry,
        name: 'Floor',
        ticketLabel: 'Floor',
        entranceId: northId,
      })
      .returning();
    const [seated] = await handle.db
      .insert(seatMapSections)
      .values({
        seatMapId: map!.id,
        type: 'SEATED',
        geometry,
        name: 'Stalls',
        ticketLabel: 'Stalls',
        entranceId: northId,
      })
      .returning();
    sectionId = floor!.id;
    seatedSectionId = seated!.id;
    const [wheelchair] = await handle.db
      .insert(seats)
      .values({
        seatMapId: map!.id,
        sectionId: seatedSectionId,
        label: '7',
        x: 1,
        y: 1,
        isWheelchairSpace: true,
      })
      .returning();
    wheelchairSeatId = wheelchair!.id;
    mapId = map!.id;
    const [rate] = await handle.db
      .insert(taxRates)
      .values({ name: `vat-${uuid().slice(0, 6)}`, rateBasisPoints: 1900 })
      .returning();
    const mkEvent = async (title: string, seatMapId: string | null) => {
      const [ev] = await handle.db
        .insert(events)
        .values({
          venueId: venue!.id,
          seatMapId,
          slug: `ev-${uuid().slice(0, 8)}`,
          title,
          startsAt: new Date(Date.now() + 30 * 86_400_000),
          timeZone: 'Europe/Berlin',
          currency: 'EUR',
          taxRateId: rate!.id,
        })
        .returning();
      return ev!.id;
    };
    eventId = await mkEvent('Show', map!.id);
    otherEventId = await mkEvent('Other show', null);
    const [category] = await handle.db
      .insert(priceCategories)
      .values({ eventId, name: 'Cat 1', color: '#336699', basePrice: 2000 })
      .returning();
    categoryId = category!.id;
    const [normal, reduced] = await handle.db
      .insert(ticketTypes)
      .values([
        { eventId, name: 'Normal', isDefault: true },
        {
          eventId,
          name: 'Reduced',
          requiresProofAtEntry: true,
          scannerWarning: 'Please check the proof!',
        },
      ])
      .returning();
    normalTypeId = normal!.id;
    reducedTypeId = reduced!.id;
  });

  afterAll(async () => {
    await handle?.close();
    if (redis) await redis.quit();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  // ─── helpers ───────────────────────────────────────────────────────────────

  /** A new wheelchair space (an active order item holds a seat exclusively). */
  async function freshSeat(): Promise<string> {
    const [seat] = await handle.db
      .insert(seats)
      .values({
        seatMapId: mapId,
        sectionId: seatedSectionId,
        label: '7',
        x: 1,
        y: 1,
        isWheelchairSpace: true,
      })
      .returning();
    return seat!.id;
  }

  async function pairDevice(
    name: string,
    opts: { entranceId?: string | null; allowCheckOut?: boolean; events?: string[] } = {},
  ): Promise<ScannerDeviceAuth & { token: string }> {
    const created = await createPairingCode(ctx, {
      createdByUserId: null,
      label: name,
      assignments: (opts.events ?? [eventId]).map((id) => ({
        eventId: id,
        entranceId: id === eventId ? (opts.entranceId ?? null) : null,
        allowCheckOut: opts.allowCheckOut ?? true,
      })),
    });
    const paired = await exchangePairingCode(ctx, { code: created.code, deviceName: 'Pixel' });
    return { id: paired.deviceId, name: paired.deviceName, token: paired.token };
  }

  async function makeTickets(
    items: {
      ticketTypeId?: string;
      seatId?: string;
      attendeeName?: string;
      sectionId?: string;
    }[],
  ) {
    seq += 1;
    const email = `buyer${seq}-${uuid().slice(0, 6)}@example.org`;
    const [customer] = await handle.db
      .insert(customers)
      .values({ email, firstName: 'Ann', lastName: `Buyer${seq}` })
      .returning();
    const total = items.length * 2000;
    const [order] = await handle.db
      .insert(orders)
      .values({
        orderNumber: `T-${uuid().slice(0, 8).toUpperCase()}`,
        customerId: customer!.id,
        status: 'PAID',
        channel: 'ONLINE',
        paymentMethod: 'PAYPAL',
        email,
        firstName: 'Ann',
        lastName: `Buyer${seq}`,
        billingAddress: { street: 'Weg 1', postalCode: '12345', city: 'Stadt', country: 'DE' },
        locale: 'en',
        currency: 'EUR',
        subtotalGross: total,
        feeTotal: 0,
        totalGross: total,
        totalNet: total - 320 * items.length,
        totalTax: 320 * items.length,
        amountPaid: total,
        paidAt: new Date(),
      })
      .returning();
    const rows = await handle.db
      .insert(orderItems)
      .values(
        items.map((item, n) => ({
          orderId: order!.id,
          eventId,
          kind: item.seatId ? ('SEAT' as const) : ('GENERAL_ADMISSION' as const),
          seatId: item.seatId ?? null,
          sectionId: item.sectionId ?? (item.seatId ? seatedSectionId : sectionId),
          priceCategoryId: categoryId,
          ticketTypeId: item.ticketTypeId ?? normalTypeId,
          status: 'CONFIRMED' as const,
          sectionLabel: item.seatId ? 'Stalls' : 'Floor',
          rowLabel: item.seatId ? 'B' : null,
          seatLabel: item.seatId ? '7' : null,
          categoryName: 'Cat 1',
          ticketTypeName: 'Normal',
          unitPriceGross: 2000,
          priceGross: 2000,
          taxRateBasisPoints: 1900,
          priceNet: 1680,
          taxAmount: 320,
          attendeeName: item.attendeeName ?? (n === 0 ? null : `Guest ${seq}-${n}`),
        })),
      )
      .returning();
    const issued = await ensureOrderTickets(ctx, order!.id);
    // Issued two hours ago: offline scans of the tests ("an hour ago") are not before issue.
    await handle.db
      .update(tickets)
      .set({ issuedAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(tickets.orderId, order!.id));
    const byItem = new Map(issued.map((t) => [t.orderItemId, t]));
    return {
      order: order!,
      items: rows,
      tickets: rows.map((r) => byItem.get(r.id)!),
    };
  }

  const scanReq = (
    t: { id: string; qrPayload: string },
    over: Partial<ScanRequest> = {},
  ): ScanRequest =>
    ({
      clientScanId: uuid(),
      eventId,
      action: 'CHECK_IN',
      source: 'CAMERA',
      payload: t.qrPayload,
      scannedAt: new Date().toISOString(),
      ...over,
    }) as ScanRequest;

  const ticketRow = async (id: string) =>
    (await handle.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;

  // ─── pairing & auth ────────────────────────────────────────────────────────

  describe('pairing and device authentication', () => {
    it('creates a code with QR payload, exchanges it once and authenticates the token', async () => {
      const created = await createPairingCode(ctx, {
        createdByUserId: null,
        label: 'Door A',
        assignments: [{ eventId, entranceId: northId, allowCheckOut: false }],
      });
      expect(created.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
      expect(created.qrPayload).toBe(buildPairingUri('http://192.168.1.20:8080', created.code));
      expect((await getPairingCodeStatus(ctx, created.id)).status).toBe('PENDING');

      // typed with alias characters and lower case
      const typed = created.code.toLowerCase().replace('-', ' ');
      const paired = await exchangePairingCode(ctx, { code: typed, deviceName: 'Pixel 8' });
      expect(paired.deviceName).toBe('Door A');
      expect(paired.token).toMatch(/^tixd_/);
      const status = await getPairingCodeStatus(ctx, created.id);
      expect(status.status).toBe('CONSUMED');
      expect(status.deviceId).toBe(paired.deviceId);

      await expect(
        exchangePairingCode(ctx, { code: created.code, deviceName: 'Other' }),
      ).rejects.toMatchObject({ code: 'INVALID_PAIRING_CODE' });

      const [row] = await handle.db
        .select()
        .from(scannerDevices)
        .where(eq(scannerDevices.id, paired.deviceId));
      expect(row!.tokenHash).not.toContain(paired.token); // only the hash is stored
      expect(row!.tokenHash).toHaveLength(64);
      const device = await authenticateDevice(ctx, `Bearer ${paired.token}`, {
        appVersion: '1.2.3',
      });
      expect(device).toEqual({ id: paired.deviceId, name: 'Door A' });
      const [after] = await handle.db
        .select()
        .from(scannerDevices)
        .where(eq(scannerDevices.id, paired.deviceId));
      expect(after!.appVersion).toBe('1.2.3');
      const list = await listScannerDevices(ctx);
      const listed = list.find((d) => d.id === paired.deviceId)!;
      expect(listed.assignments).toMatchObject([
        { eventId, entranceId: northId, entranceName: 'North', allowCheckOut: false },
      ]);
    });

    it('lets exactly one of many concurrent exchanges win', async () => {
      const created = await createPairingCode(ctx, {
        createdByUserId: null,
        assignments: [{ eventId, allowCheckOut: true }],
      });
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, n) =>
          exchangePairingCode(ctx, { code: created.code, deviceName: `Phone ${n}` }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const phones = await handle.db
        .select({ id: scannerDevices.id })
        .from(scannerDevices)
        .where(like(scannerDevices.name, 'Phone %'));
      expect(phones).toHaveLength(1);
    });

    it('rejects expired, unknown and malformed codes and tokens', async () => {
      const created = await createPairingCode(ctx, {
        createdByUserId: null,
        assignments: [{ eventId, allowCheckOut: true }],
      });
      await handle.db
        .update(devicePairingCodes)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(devicePairingCodes.id, created.id));
      expect((await getPairingCodeStatus(ctx, created.id)).status).toBe('EXPIRED');
      await expect(
        exchangePairingCode(ctx, { code: created.code, deviceName: 'x' }),
      ).rejects.toMatchObject({ code: 'INVALID_PAIRING_CODE' });
      await expect(
        exchangePairingCode(ctx, { code: 'ZZZZZ-ZZZZZ', deviceName: 'x' }),
      ).rejects.toMatchObject({ code: 'INVALID_PAIRING_CODE' });
      await expect(authenticateDevice(ctx, undefined)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
        status: 401,
      });
      await expect(authenticateDevice(ctx, 'Bearer tixd_nonsense1234567')).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
      await expect(authenticateDevice(ctx, 'Basic abcdefghijkl')).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('validates assignments (unknown event, foreign entrance, none)', async () => {
      await expect(
        createPairingCode(ctx, { createdByUserId: null, assignments: [] }),
      ).rejects.toMatchObject({ code: 'NO_EVENTS' });
      await expect(
        createPairingCode(ctx, {
          createdByUserId: null,
          assignments: [{ eventId: uuid(), allowCheckOut: true }],
        }),
      ).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND' });
      await expect(
        createPairingCode(ctx, {
          createdByUserId: null,
          assignments: [{ eventId: otherEventId, entranceId: northId, allowCheckOut: true }],
        }),
      ).rejects.toMatchObject({ code: 'ENTRANCE_NOT_FOUND' });
    });

    it('stops accepting the token as soon as the device is revoked', async () => {
      const d = await pairDevice('Revoke me');
      await authenticateDevice(ctx, `Bearer ${d.token}`);
      await revokeScannerDevice(ctx, d.id);
      await expect(authenticateDevice(ctx, `Bearer ${d.token}`)).rejects.toMatchObject({
        code: 'DEVICE_REVOKED',
        status: 401,
      });
      await revokeScannerDevice(ctx, d.id); // idempotent
      await expect(revokeScannerDevice(ctx, uuid())).rejects.toMatchObject({ status: 404 });
    });

    it('renames a device and replaces its assignments', async () => {
      const d = await pairDevice('Old name');
      await updateScannerDevice(ctx, d.id, {
        name: 'New name',
        assignments: [
          { eventId, entranceId: southId, allowCheckOut: false },
          { eventId: otherEventId, allowCheckOut: true },
        ],
      });
      const listed = (await listScannerDevices(ctx)).find((x) => x.id === d.id)!;
      expect(listed.name).toBe('New name');
      expect(listed.assignments.map((a) => a.eventId).sort()).toEqual(
        [eventId, otherEventId].sort(),
      );
      await expect(updateScannerDevice(ctx, d.id, { name: '  ' })).rejects.toMatchObject({
        code: 'INVALID_NAME',
      });
    });
  });

  // ─── manifest ──────────────────────────────────────────────────────────────

  describe('manifest', () => {
    it('delivers events, keys, tariffs, entrances and a stable LAN secret', async () => {
      const d = await pairDevice('Manifest device', { entranceId: southId });
      await ensureEventSigningKey(ctx, eventId);
      const m1 = await buildManifest(ctx, d);
      expect(m1.device).toEqual({ id: d.id, name: d.name });
      const ev = m1.events.find((e) => e.id === eventId)!;
      expect(ev).toMatchObject({
        title: 'Show',
        entranceId: southId,
        allowCheckOut: true,
        venueName: 'Hall',
      });
      expect(ev.keys.some((k) => k.status === 'ACTIVE' && k.publicKey)).toBe(true);
      expect(ev.ticketTypes.find((t) => t.name === 'Reduced')).toMatchObject({
        requiresProof: true,
        scannerWarning: 'Please check the proof!',
      });
      expect(ev.categories).toEqual([{ id: categoryId, name: 'Cat 1', color: '#336699' }]);
      expect(ev.entrances.map((e) => e.code).sort()).toEqual(['N', 'S']);
      expect(ev.sections.find((s) => s.id === sectionId)?.entranceId).toBe(northId);
      expect(ev.lan.enabled).toBe(true);
      expect(ev.lan.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const m2 = await buildManifest(ctx, d);
      expect(m2.events.find((e) => e.id === eventId)!.lan.secret).toBe(ev.lan.secret);
      expect(m2.etag).toBe(m1.etag);

      // other devices of the same event share the secret; unrelated events are not delivered
      const d2 = await pairDevice('Second device');
      const m3 = await buildManifest(ctx, d2);
      expect(m3.events.find((e) => e.id === eventId)!.lan.secret).toBe(ev.lan.secret);
      expect(m3.events.some((e) => e.id === otherEventId)).toBe(false);
    });

    it('withholds the LAN secret when LAN sync is off and never ships revoked public keys', async () => {
      const d = await pairDevice('Settings device');
      await saveSetting(ctx, 'scanner', { lanSyncEnabled: false, allowCheckOut: false }, null);
      try {
        const m = await buildManifest(ctx, d);
        const ev = m.events.find((e) => e.id === eventId)!;
        expect(ev.lan).toEqual({ enabled: false, secret: null });
        expect(ev.allowCheckOut).toBe(false);
        expect(m.settings.lanSyncEnabled).toBe(false);
      } finally {
        await saveSetting(ctx, 'scanner', {}, null);
      }
      const evForKeys = await handle.db
        .select()
        .from(eventSigningKeys)
        .where(eq(eventSigningKeys.eventId, otherEventId));
      expect(evForKeys).toHaveLength(0);
    });

    it('ships result colours and warning priority; colour changes change the etag', async () => {
      const d = await pairDevice('Colour device');
      const m1 = await buildManifest(ctx, d);
      expect(m1.settings.resultColors).toEqual({
        accepted: '#16A34A',
        rejected: '#DC2626',
        discountProof: '#FACC15',
        seatFeature: '#14B8A6',
        wrongEntrance: '#2563EB',
        additionalPaymentOpen: '#F97316',
      });
      expect(m1.settings.warningPriority).toEqual([
        'DISCOUNT_PROOF_REQUIRED',
        'WRONG_ENTRANCE',
        'ADDITIONAL_PAYMENT_OPEN',
        'SEAT_FEATURE',
      ]);
      await saveSetting(ctx, 'scanner', { resultColors: { seatFeature: '#00FF00' } }, null);
      try {
        const m2 = await buildManifest(ctx, d);
        expect(m2.settings.resultColors.seatFeature).toBe('#00FF00');
        expect(m2.etag).not.toBe(m1.etag);
      } finally {
        await saveSetting(ctx, 'scanner', {}, null);
      }
    });

    it('ships the app update settings; changing them changes the etag', async () => {
      const d = await pairDevice('Update device');
      const m1 = await buildManifest(ctx, d);
      expect(m1.settings.appUpdate).toEqual({
        source: 'GITHUB',
        githubRepository: '',
        defaultChannel: 'stable',
        allowChannelOverride: true,
      });
      await saveSetting(
        ctx,
        'scanner',
        { appUpdateSource: 'SERVER', defaultUpdateChannel: 'next', githubRepository: 'a/b' },
        null,
      );
      try {
        const m2 = await buildManifest(ctx, d);
        expect(m2.settings.appUpdate).toEqual({
          source: 'SERVER',
          githubRepository: 'a/b',
          defaultChannel: 'next',
          allowChannelOverride: true,
        });
        expect(m2.etag).not.toBe(m1.etag);
        // The staff link points at the release of the server's own version, whatever the channel.
        expect(await githubStaffDownloadUrl(ctx)).toBe(
          `https://github.com/a/b/releases/tag/v${APP_VERSION}`,
        );
        expect(m2.serverVersion).toBe(APP_VERSION);
        await saveSetting(ctx, 'scanner', { githubRepository: 'a/b' }, null);
        expect(await githubStaffDownloadUrl(ctx)).toBe(
          `https://github.com/a/b/releases/tag/v${APP_VERSION}`,
        );
      } finally {
        await saveSetting(ctx, 'scanner', {}, null);
      }
      // No repository on the server: no GitHub link (the app uses its built-in repository).
      expect(await githubStaffDownloadUrl(ctx)).toBeNull();
    });

    it('rotates the LAN secret when a device is revoked or unassigned from the event', async () => {
      const keep = await pairDevice('LAN keeper');
      const revoked = await pairDevice('LAN revoked');
      const moved = await pairDevice('LAN moved');
      const secretOf = async () =>
        (await buildManifest(ctx, keep)).events.find((e) => e.id === eventId)!.lan.secret;
      const s0 = await secretOf();
      const etag0 = (await buildManifest(ctx, keep)).etag;
      expect(s0).toBeTruthy();

      await revokeScannerDevice(ctx, revoked.id);
      const s1 = await secretOf();
      expect(s1).not.toBe(s0);
      expect((await buildManifest(ctx, keep)).etag).not.toBe(etag0);
      expect(await secretOf()).toBe(s1); // stable until the next rotation

      await updateScannerDevice(ctx, moved.id, {
        assignments: [{ eventId: otherEventId, allowCheckOut: true }],
      });
      expect(await secretOf()).not.toBe(s1);
    });

    it('lists revoked keys without their public key', async () => {
      const d = await pairDevice('Key device', { events: [otherEventId] });
      const key = await ensureEventSigningKey(ctx, otherEventId);
      await revokeEventSigningKey(ctx, otherEventId, key.keyId);
      const m = await buildManifest(ctx, d);
      const keys = m.events.find((e) => e.id === otherEventId)!.keys;
      expect(keys.find((k) => k.keyId === key.keyId)).toEqual({
        keyId: key.keyId,
        status: 'REVOKED',
        publicKey: null,
      });
      expect(keys.some((k) => k.status === 'ACTIVE' && k.publicKey)).toBe(true);
    });
  });

  // ─── delta sync ────────────────────────────────────────────────────────────

  describe('restore carry-forward', () => {
    it('rewrites sync_xid of all tickets and rotates the epoch', async () => {
      const { tickets: made } = await makeTickets([{}, {}]);
      await handle.db.execute(
        sql`UPDATE tickets SET sync_xid = '0'::xid8 WHERE id = ${made[0]!.id}`,
      );
      // (the trigger rewrites it already; the statement of carryForwardSql must keep that working)
      const before = await getSyncEpoch(handle.db);
      const statements = carryForwardSql({ counters: new Map(), sequences: new Map() });
      await handle.db.execute(sql.raw(statements));
      const rows = await handle.db.execute<{ x: string }>(
        sql`SELECT sync_xid::text AS x FROM tickets WHERE id IN (${made[0]!.id}, ${made[1]!.id})`,
      );
      for (const r of rows.rows) expect(r.x).not.toBe('0');
      expect(await getSyncEpoch(handle.db)).not.toBe(before);
    });
  });

  describe('delta sync (xid horizon cursor)', () => {
    /** Follows hasMore until the run is complete; returns the tickets of the run and the next cursor. */
    async function drain(d: ScannerDeviceAuth, cursor = '', limit = 1_000) {
      const all: SyncTicket[] = [];
      let next = cursor;
      let epoch = '';
      for (let guard = 0; guard < 1_000; guard += 1) {
        const page = await syncTickets(ctx, d, { eventId, cursor: next, limit });
        all.push(...page.tickets);
        next = page.nextCursor;
        epoch = page.syncEpoch;
        if (!page.hasMore) return { tickets: all, cursor: next, epoch };
      }
      throw new Error('sync did not terminate');
    }
    const byId = (list: SyncTicket[], id: string) => list.filter((t) => t.id === id);
    const latest = (list: SyncTicket[], id: string) =>
      byId(list, id).sort((a, b) => b.syncVersion - a.syncVersion)[0];

    it('pages with an opaque cursor and delivers tombstones and check-ins', async () => {
      const d = await pairDevice('Sync device');
      const { tickets: made, items } = await makeTickets([{}, {}, {}]);
      const first = await syncTickets(ctx, d, { eventId, cursor: '', limit: 2 });
      expect(first.hasMore).toBe(true);
      expect(first.tickets).toHaveLength(2);
      expect(first.nextCursor).toMatch(/^c1\.[^.]+\.\d+\.\d+\.[0-9a-f-]{36}$/);
      const run = await drain(d);
      expect(run.cursor).toMatch(/^c1\.[^.]+\.\d+$/);
      for (const t of made) expect(byId(run.tickets, t.id)).toHaveLength(1);
      expect(latest(run.tickets, made[1]!.id)).toMatchObject({
        status: 'VALID',
        eventId,
        sectionLabel: 'Floor',
        categoryName: 'Cat 1',
        checkInState: 'NONE',
        additionalPaymentOpen: false,
        ticketCode: made[1]!.ticketCode,
      });

      // a later run delivers the change as a tombstone
      await handle.db.transaction(async (tx) => {
        await voidTicketsForItems(tx as never, [items[0]!.id], 'CANCELLED');
      });
      const afterVoid = await drain(d, run.cursor);
      expect(latest(afterVoid.tickets, made[0]!.id)?.status).toBe('CANCELLED');

      // and a check-in (with the device name of the first scan)
      await scanOnline(ctx, d, scanReq(made[1]!));
      const afterScan = await drain(d, afterVoid.cursor);
      expect(latest(afterScan.tickets, made[1]!.id)).toMatchObject({
        checkInState: 'CHECKED_IN',
        firstCheckedInDeviceName: d.name,
        checkInCount: 1,
      });
      const [row] = await handle.db
        .select()
        .from(scannerDevices)
        .where(eq(scannerDevices.id, d.id));
      expect(row!.lastSyncAt).not.toBeNull();
      expect(row!.lastSyncVersion).toBeGreaterThan(0);
    });

    it('never skips a version whose transaction commits late', async () => {
      const d = await pairDevice('Late commit device');
      const { tickets: made } = await makeTickets([{}, {}]);
      const base = await drain(d);

      // Transaction A bumps ticket 1 but stays open; B bumps ticket 2 and commits.
      const a = new pg.Client({ connectionString: dbUrl });
      await a.connect();
      try {
        await a.query('BEGIN');
        await a.query(`UPDATE tickets SET attendee_name = 'Late A' WHERE id = $1`, [made[0]!.id]);
        await handle.db
          .update(tickets)
          .set({ attendeeName: 'Early B' })
          .where(eq(tickets.id, made[1]!.id));

        const during = await drain(d, base.cursor);
        expect(latest(during.tickets, made[1]!.id)?.attendeeName).toBe('Early B');
        // (earlier rows may repeat; the uncommitted change must not be visible yet)
        expect(byId(during.tickets, made[0]!.id).some((t) => t.attendeeName === 'Late A')).toBe(
          false,
        );

        await a.query('COMMIT');
        const after = await drain(d, during.cursor);
        expect(latest(after.tickets, made[0]!.id)?.attendeeName).toBe('Late A');
      } finally {
        await a.query('ROLLBACK').catch(() => undefined);
        await a.end();
      }
    });

    it('bumps tickets when an additional payment opens, settles or is cancelled', async () => {
      const d = await pairDevice('Adjustment device');
      const { order, items, tickets: made } = await makeTickets([{ ticketTypeId: reducedTypeId }]);
      let cursor = (await drain(d)).cursor;
      const next = async () => {
        const run = await drain(d, cursor);
        cursor = run.cursor;
        return latest(run.tickets, made[0]!.id);
      };
      const [adjustment] = await handle.db
        .insert(orderAdjustments)
        .values({
          orderId: order.id,
          status: 'PROPOSED',
          amount: 500,
          currency: 'EUR',
          paymentReference: `TIX-2026-${100000 + seq}-1`,
          items: [
            {
              orderItemId: items[0]!.id,
              fromPriceCategoryId: categoryId,
              fromTicketTypeId: reducedTypeId,
              toTicketTypeId: normalTypeId,
              fromName: 'Reduced',
              toName: 'Normal',
              fromPriceGross: 1500,
              toPriceGross: 2000,
            },
          ],
        })
        .returning();
      let seen = await next();
      expect(seen).toMatchObject({ status: 'VALID', additionalPaymentOpen: true });
      let version = seen!.syncVersion;

      for (const [status, open] of [
        ['CONFIRMED', true],
        ['PAID', false],
      ] as const) {
        await handle.db
          .update(orderAdjustments)
          .set({ status })
          .where(eq(orderAdjustments.id, adjustment!.id));
        seen = await next();
        expect(seen!.additionalPaymentOpen).toBe(open);
        expect(seen!.syncVersion).toBeGreaterThan(version);
        version = seen!.syncVersion;
      }
    });

    it('bumps for item snapshot and seat flag changes, not for generated file references', async () => {
      const d = await pairDevice('Item device');
      const seatId = await freshSeat();
      const { items, tickets: made } = await makeTickets([{}, { seatId }]);
      const version = async (id: string) => (await ticketRow(id)).syncVersion;
      let cursor = (await drain(d)).cursor;

      const v0 = await version(made[0]!.id);
      await handle.db
        .update(orderItems)
        .set({ attendeeName: 'Renamed Guest' })
        .where(eq(orderItems.id, items[0]!.id));
      expect(await version(made[0]!.id)).toBeGreaterThan(v0);
      const run = await drain(d, cursor);
      cursor = run.cursor;
      expect(latest(run.tickets, made[0]!.id)?.syncVersion).toBeGreaterThan(v0);

      // generated PDF / pass references and unrelated item changes do not bump
      const v1 = await version(made[0]!.id);
      await handle.db
        .update(tickets)
        .set({ pdfObjectKey: 'x.pdf', pkpassObjectKey: 'x.pkpass', googleWalletObjectId: 'g' })
        .where(eq(tickets.id, made[0]!.id));
      await handle.db
        .update(orderItems)
        .set({ status: 'CONFIRMED' })
        .where(eq(orderItems.id, items[0]!.id));
      expect(await version(made[0]!.id)).toBe(v1);

      // wheelchair -> companion seat is visible on the scanner
      const v2 = await version(made[1]!.id);
      await handle.db
        .update(seats)
        .set({ isWheelchairSpace: false, isCompanionSeat: true })
        .where(eq(seats.id, seatId));
      expect(await version(made[1]!.id)).toBeGreaterThan(v2);
      const seatRun = await drain(d, cursor);
      expect(latest(seatRun.tickets, made[1]!.id)?.seatFeature).toBe('COMPANION_SEAT');
    });

    it('treats a cursor of another epoch as a full sync and reports the new epoch', async () => {
      const d = await pairDevice('Epoch device');
      const { tickets: made } = await makeTickets([{}]);
      const run = await drain(d);
      const manifest = await buildManifest(ctx, d);
      expect(manifest.syncEpoch).toBe(run.epoch);

      await handle.db.update(scannerSyncState).set({ syncEpoch: `epoch-${uuid()}` });
      const after = await drain(d, run.cursor);
      expect(after.epoch).not.toBe(run.epoch);
      expect(byId(after.tickets, made[0]!.id)).toHaveLength(1); // everything again
      expect((await buildManifest(ctx, d)).etag).not.toBe(manifest.etag);
      // garbage cursors are a full sync, too
      const garbage = await drain(d, 'nonsense');
      expect(byId(garbage.tickets, made[0]!.id)).toHaveLength(1);
    });

    it('does not sync events that are not assigned to the device', async () => {
      const d = await pairDevice('Scoped device');
      await expect(
        syncTickets(ctx, d, { eventId: otherEventId, cursor: '', limit: 10 }),
      ).rejects.toMatchObject({ code: 'EVENT_NOT_ASSIGNED', status: 403 });
    });
  });

  // ─── online scans ──────────────────────────────────────────────────────────

  describe('online scans', () => {
    it('GREEN, then RED already checked in with first scan info', async () => {
      const a = await pairDevice('Entrance A');
      const b = await pairDevice('Entrance B');
      const { tickets: made } = await makeTickets([{ attendeeName: 'Max Muster' }]);
      const first = await scanOnline(ctx, a, scanReq(made[0]!));
      expect(first).toMatchObject({
        result: 'ACCEPTED',
        color: 'GREEN',
        warnings: [],
        duplicate: false,
        recorded: true,
        ticket: {
          attendeeName: 'Max Muster',
          categoryName: 'Cat 1',
          sectionLabel: 'Floor',
          checkInState: 'CHECKED_IN',
        },
      });
      const second = await scanOnline(ctx, b, scanReq(made[0]!));
      expect(second.result).toBe('REJECTED_ALREADY_CHECKED_IN');
      expect(second.color).toBe('RED');
      expect(second.firstScan).toEqual({ at: expect.any(String), deviceName: 'Entrance A' });
      const row = await ticketRow(made[0]!.id);
      expect(row.checkInState).toBe('CHECKED_IN');
      expect(row.checkInCount).toBe(1);
      expect(row.firstCheckedInDeviceId).toBe(a.id);
    });

    it('is idempotent for a retried clientScanId', async () => {
      const d = await pairDevice('Retry device');
      const { tickets: made } = await makeTickets([{}]);
      const req = scanReq(made[0]!);
      const one = await scanOnline(ctx, d, req);
      const again = await scanOnline(ctx, d, req);
      expect(one.result).toBe('ACCEPTED');
      expect(again).toMatchObject({ result: 'ACCEPTED', duplicate: true });
      expect((await ticketRow(made[0]!.id)).checkInCount).toBe(1);
      const logs = await handle.db
        .select()
        .from(checkInLogs)
        .where(and(eq(checkInLogs.deviceId, d.id), eq(checkInLogs.clientScanId, req.clientScanId)));
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ wasOffline: false, source: 'CAMERA', result: 'ACCEPTED' });
    });

    it('YELLOW for proof, seat feature, wrong entrance and open additional payment', async () => {
      const d = await pairDevice('South door', { entranceId: southId });
      const {
        tickets: made,
        order,
        items,
      } = await makeTickets([{ ticketTypeId: reducedTypeId, seatId: await freshSeat() }]);
      await handle.db.insert(orderAdjustments).values({
        orderId: order.id,
        status: 'CONFIRMED',
        amount: 500,
        currency: 'EUR',
        paymentReference: `TIX-2026-${200000 + seq}-1`,
        items: [
          {
            orderItemId: items[0]!.id,
            fromPriceCategoryId: categoryId,
            fromTicketTypeId: reducedTypeId,
            toTicketTypeId: normalTypeId,
            fromName: 'Reduced',
            toName: 'Normal',
            fromPriceGross: 1500,
            toPriceGross: 2000,
          },
        ],
      });
      const out = await scanOnline(ctx, d, scanReq(made[0]!));
      expect(out.result).toBe('ACCEPTED_WITH_WARNING');
      expect(scanColor(out.result)).toBe('YELLOW');
      expect(out.warnings).toEqual([
        'DISCOUNT_PROOF_REQUIRED',
        'WRONG_ENTRANCE',
        'SEAT_FEATURE',
        'ADDITIONAL_PAYMENT_OPEN',
      ]);
      expect(out.warningTexts).toEqual({ DISCOUNT_PROOF_REQUIRED: 'Please check the proof!' });
      expect(out.ticket).toMatchObject({
        seatFeature: 'WHEELCHAIR_SPACE',
        rowLabel: 'B',
        seatLabel: '7',
      });
      expect((await ticketRow(made[0]!.id)).checkInState).toBe('CHECKED_IN');
    });

    it('RED for void tickets, tampered and malformed codes, unknown tickets and other events', async () => {
      const d = await pairDevice('Red device');
      const { tickets: made, items } = await makeTickets([{}, {}]);
      await handle.db.transaction(async (tx) => {
        await voidTicketsForItems(tx as never, [items[0]!.id], 'REFUNDED');
      });
      expect((await scanOnline(ctx, d, scanReq(made[0]!))).result).toBe('REJECTED_TICKET_VOID');

      const p = made[1]!.qrPayload;
      const tampered = `${p.slice(0, -10)}${p.at(-10) === 'A' ? 'B' : 'A'}${p.slice(-9)}`;
      expect((await scanOnline(ctx, d, scanReq({ id: '', qrPayload: tampered }))).result).toBe(
        'REJECTED_INVALID_SIGNATURE',
      );
      expect(
        (await scanOnline(ctx, d, scanReq({ id: '', qrPayload: 'https://example.org/x' }))).result,
      ).toBe('REJECTED_MALFORMED');
      expect((await ticketRow(made[1]!.id)).checkInState).toBe('NONE');

      // genuine signature for a ticket id that does not exist on the server
      const key = await ensureEventSigningKey(ctx, eventId);
      const ghost = await buildTicketPayload(
        { keyId: key.keyId, eventId, ticketId: uuid(), seatInfo: 'x' },
        key.signer,
      );
      const unknown = await scanOnline(ctx, d, scanReq({ id: '', qrPayload: ghost }));
      expect(unknown.result).toBe('REJECTED_UNKNOWN_TICKET');
      expect(unknown.ticket).toBeNull();

      // a ticket of another event
      const otherKey = await ensureEventSigningKey(ctx, otherEventId);
      const foreign = await buildTicketPayload(
        { keyId: otherKey.keyId, eventId: otherEventId, ticketId: uuid(), seatInfo: '' },
        otherKey.signer,
      );
      expect((await scanOnline(ctx, d, scanReq({ id: '', qrPayload: foreign }))).result).toBe(
        'REJECTED_WRONG_EVENT',
      );
    });

    it('rejects tickets signed with a revoked key', async () => {
      const d = await pairDevice('Revoked key device');
      const key = await ensureEventSigningKey(ctx, eventId);
      const { tickets: made } = await makeTickets([{}]);
      expect(made[0]!.qrPayload).toContain(`/${key.keyId}.`);
      await revokeEventSigningKey(ctx, eventId, key.keyId);
      expect((await scanOnline(ctx, d, scanReq(made[0]!))).result).toBe(
        'REJECTED_INVALID_SIGNATURE',
      );
    });

    it('does not record scans for events the device is not assigned to', async () => {
      const d = await pairDevice('Scoped scan device');
      const { tickets: made } = await makeTickets([{}]);
      const out = await scanOnline(ctx, d, scanReq(made[0]!, { eventId: otherEventId }));
      expect(out).toMatchObject({ result: 'REJECTED_WRONG_EVENT', recorded: false });
      expect((await ticketRow(made[0]!.id)).checkInState).toBe('NONE');
    });

    it('supports manual check-in by ticket code / id and check-out with permissions', async () => {
      const allowed = await pairDevice('Out allowed');
      const denied = await pairDevice('Out denied', { allowCheckOut: false });
      const { tickets: made } = await makeTickets([{}, {}]);
      const manual = (t: { ticketCode: string }, over: Partial<ScanRequest> = {}) =>
        ({
          clientScanId: uuid(),
          eventId,
          action: 'CHECK_IN',
          source: 'MANUAL',
          ticketCode: t.ticketCode.toLowerCase(),
          scannedAt: new Date().toISOString(),
          ...over,
        }) as ScanRequest;

      expect((await scanOnline(ctx, allowed, manual(made[0]!))).result).toBe('ACCEPTED');
      // not checked in yet -> cannot check out
      expect(
        (await scanOnline(ctx, allowed, manual(made[1]!, { action: 'CHECK_OUT' }))).result,
      ).toBe('REJECTED_NOT_CHECKED_IN');
      // permission is per device and event
      expect(
        (await scanOnline(ctx, denied, manual(made[0]!, { action: 'CHECK_OUT' }))).result,
      ).toBe('REJECTED_CHECK_OUT_NOT_ALLOWED');
      expect((await ticketRow(made[0]!.id)).checkInState).toBe('CHECKED_IN');
      const out = await scanOnline(ctx, allowed, manual(made[0]!, { action: 'CHECK_OUT' }));
      expect(out.result).toBe('ACCEPTED');
      expect(out.ticket!.checkInState).toBe('CHECKED_OUT');
      // re-entry, count 2, first entry untouched
      const before = await ticketRow(made[0]!.id);
      const reentry = await scanOnline(ctx, denied, {
        ...manual(made[0]!),
        ticketCode: undefined,
        ticketId: made[0]!.id,
      } as ScanRequest);
      expect(reentry.result).toBe('ACCEPTED');
      const after = await ticketRow(made[0]!.id);
      expect(after.checkInCount).toBe(2);
      expect(after.firstCheckedInAt!.getTime()).toBe(before.firstCheckedInAt!.getTime());
      expect(after.firstCheckedInDeviceId).toBe(allowed.id);
      // unknown code
      expect((await scanOnline(ctx, allowed, manual({ ticketCode: 'ZZZZZZZZZZ' }))).result).toBe(
        'REJECTED_UNKNOWN_TICKET',
      );
    });

    it('admits a ticket exactly once under concurrent scans from many devices', async () => {
      const devices = await Promise.all(
        Array.from({ length: 6 }, (_, n) => pairDevice(`Concurrent ${n}`)),
      );
      const { tickets: made } = await makeTickets([{}, {}, {}]);
      const results = await Promise.all(
        made.flatMap((t) => devices.map((d) => scanOnline(ctx, d, scanReq(t)))),
      );
      for (const t of made) {
        const forTicket = results.filter((r) => r.ticket?.id === t.id);
        expect(forTicket.filter((r) => r.result === 'ACCEPTED')).toHaveLength(1);
        expect(forTicket.filter((r) => r.result === 'REJECTED_ALREADY_CHECKED_IN')).toHaveLength(
          devices.length - 1,
        );
        expect((await ticketRow(t.id)).checkInCount).toBe(1);
      }
    });
  });

  // ─── offline batches ───────────────────────────────────────────────────────

  describe('offline batch upload', () => {
    const base = Date.now() - 3_600_000;
    const at = (offsetMinutes: number) => new Date(base + offsetMinutes * 60_000).toISOString();

    it('applies a batch in scanned_at order incl. re-entry and reports per scan', async () => {
      const d = await pairDevice('Offline A');
      const { tickets: made } = await makeTickets([{}]);
      const t = made[0]!;
      // deliberately shuffled in the request
      const reentry = scanReq(t, { scannedAt: at(30) });
      const first = scanReq(t, { scannedAt: at(0) });
      const dup = scanReq(t, { scannedAt: at(10) });
      const out = scanReq(t, { scannedAt: at(20), action: 'CHECK_OUT' });
      const results = await uploadOfflineScans(ctx, d, [reentry, out, dup, first]);
      expect(results.map((r) => r.clientScanId)).toEqual(
        [reentry, out, dup, first].map((s) => s.clientScanId),
      );
      expect(results.map((r) => r.result)).toEqual([
        'ACCEPTED', // re-entry
        'ACCEPTED', // check out
        'REJECTED_ALREADY_CHECKED_IN', // second scan at the door
        'ACCEPTED', // first entry
      ]);
      const row = await ticketRow(t.id);
      expect(row.checkInState).toBe('CHECKED_IN');
      expect(row.checkInCount).toBe(2);
      expect(row.firstCheckedInAt!.toISOString()).toBe(first.scannedAt);
      const logs = await handle.db.select().from(checkInLogs).where(eq(checkInLogs.ticketId, t.id));
      expect(logs).toHaveLength(4);
      expect(logs.every((l) => l.wasOffline)).toBe(true);
      expect(logs.find((l) => l.clientScanId === first.clientScanId)!.scannedAt.toISOString()).toBe(
        first.scannedAt,
      );
    });

    it('is idempotent: re-uploading the same batch returns the recorded decisions', async () => {
      const d = await pairDevice('Offline B');
      const { tickets: made } = await makeTickets([{}, {}]);
      const batch = [
        scanReq(made[0]!, { scannedAt: at(1) }),
        scanReq(made[1]!, { scannedAt: at(2) }),
        scanReq(made[0]!, { scannedAt: at(3) }),
      ];
      const one = await uploadOfflineScans(ctx, d, batch);
      const two = await uploadOfflineScans(ctx, d, batch);
      expect(two.map((r) => r.result)).toEqual(one.map((r) => r.result));
      expect(two.every((r) => r.duplicate)).toBe(true);
      expect(one.some((r) => r.duplicate)).toBe(false);
      for (const t of made) expect((await ticketRow(t.id)).checkInCount).toBe(1);
      const count = await handle.db
        .select()
        .from(checkInLogs)
        .where(eq(checkInLogs.deviceId, d.id));
      expect(count).toHaveLength(3);
      // concurrent retries of one batch
      const batch2 = [scanReq(made[0]!, { scannedAt: at(4), action: 'CHECK_OUT' })];
      const racers = await Promise.all(
        Array.from({ length: 5 }, () => uploadOfflineScans(ctx, d, batch2)),
      );
      expect(new Set(racers.map((r) => r[0]!.result)).size).toBe(1);
      expect(
        await handle.db.select().from(checkInLogs).where(eq(checkInLogs.deviceId, d.id)),
      ).toHaveLength(4);
    });

    it('applies a batch once even when retries of the whole batch run concurrently', async () => {
      const d = await pairDevice('Offline retry race');
      const { tickets: made } = await makeTickets([{}]);
      const batch = [
        scanReq(made[0]!, { scannedAt: at(1) }),
        scanReq(made[0]!, { scannedAt: at(2), action: 'CHECK_OUT' }),
        scanReq(made[0]!, { scannedAt: at(3) }),
      ];
      const runs = await Promise.all(
        Array.from({ length: 5 }, () => uploadOfflineScans(ctx, d, batch)),
      );
      for (const run of runs) {
        expect(run.map((r) => r.result)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED']);
      }
      const row = await ticketRow(made[0]!.id);
      expect(row.checkInCount).toBe(2);
      expect(row.checkInState).toBe('CHECKED_IN');
      const logs = await handle.db.select().from(checkInLogs).where(eq(checkInLogs.deviceId, d.id));
      expect(logs).toHaveLength(3);
    });

    it('never fails a batch because of an unknown entrance or an oversized payload', async () => {
      const d = await pairDevice('Offline poison', { entranceId: northId });
      const { tickets: made } = await makeTickets([{}]);
      const results = await uploadOfflineScans(ctx, d, [
        scanReq(made[0]!, { scannedAt: at(1), entranceId: uuid() }),
        scanReq({ id: '', qrPayload: `tix://v1/${'a'.repeat(600)}` }, { scannedAt: at(2) }),
      ]);
      expect(results.map((r) => r.result)).toEqual(['ACCEPTED', 'REJECTED_MALFORMED']);
      const [log] = await handle.db
        .select()
        .from(checkInLogs)
        .where(eq(checkInLogs.clientScanId, results[0]!.clientScanId));
      expect(log!.entranceId).toBe(northId); // fell back to the device assignment
      expect(log!.rawPayload).toBeNull(); // accepted scans keep no raw payload
      const [long] = await handle.db
        .select()
        .from(checkInLogs)
        .where(eq(checkInLogs.clientScanId, results[1]!.clientScanId));
      expect(long!.rawPayload).toHaveLength(512);
    });

    it('lets two devices upload overlapping batches concurrently without corrupting state', async () => {
      const a = await pairDevice('Offline C1');
      const b = await pairDevice('Offline C2');
      const { tickets: made } = await makeTickets(Array.from({ length: 12 }, () => ({})));
      const batchFor = (offset: number, reverse: boolean) => {
        const list = made.map((t, n) => scanReq(t, { scannedAt: at(offset + n) }));
        return reverse ? list.reverse() : list;
      };
      const [ra, rb] = await Promise.all([
        uploadOfflineScans(ctx, a, batchFor(0, false)),
        uploadOfflineScans(ctx, b, batchFor(0.5, true)),
      ]);
      for (const t of made) {
        const rows = [...ra, ...rb].filter((r) => r.ticket?.id === t.id);
        expect(rows).toHaveLength(2);
        // Depending on which upload wins the lock the other one is a plain duplicate or a stale
        // check-in that is older than the first entry (also accepted); the state is the same.
        expect(rows.filter((r) => r.result === 'ACCEPTED')).toHaveLength(1);
        expect(rows.filter((r) => r.result === 'REJECTED_ALREADY_CHECKED_IN')).toHaveLength(1);
        const row = await ticketRow(t.id);
        expect(row.checkInCount).toBe(1);
        expect(row.checkInState).toBe('CHECKED_IN');
        expect(row.firstCheckedInDeviceId).toBe(a.id); // the earliest scan owns the first entry
      }
    });

    it('scenario A: a late check-in from another device cannot undo a check-out', async () => {
      const a = await pairDevice('Scenario A online');
      const b = await pairDevice('Scenario A offline');
      const { tickets: made } = await makeTickets([{}]);
      const t = made[0]!;
      // Online scans are decided at the server receive time (the device clock is ignored).
      expect((await scanOnline(ctx, a, scanReq(t, { scannedAt: at(-500) }))).result).toBe(
        'ACCEPTED',
      );
      await new Promise((r) => setTimeout(r, 30));
      const out = await scanOnline(
        ctx,
        a,
        scanReq(t, { scannedAt: at(-400), action: 'CHECK_OUT' }),
      );
      expect(out.result).toBe('ACCEPTED');
      let row = await ticketRow(t.id);
      expect(row.firstCheckedInAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
      // B scanned the guest between check-in and check-out while offline and uploads afterwards
      const between = new Date((row.firstCheckedInAt!.getTime() + row.lastScanAt!.getTime()) / 2);
      const lastScan = row.lastScanAt!.toISOString();
      const [late] = await uploadOfflineScans(ctx, b, [
        scanReq(t, { scannedAt: between.toISOString() }),
      ]);
      expect(late!.result).toBe('REJECTED_ALREADY_CHECKED_IN');
      row = await ticketRow(t.id);
      expect(row.checkInState).toBe('CHECKED_OUT');
      expect(row.checkInCount).toBe(1);
      expect(row.lastScanAt!.toISOString()).toBe(lastScan);
      expect(row.firstCheckedInDeviceId).toBe(a.id);
      // the guest can come back later: GREEN
      const again = await scanOnline(ctx, a, scanReq(t));
      expect(again).toMatchObject({ result: 'ACCEPTED', color: 'GREEN' });
      row = await ticketRow(t.id);
      expect(row.checkInState).toBe('CHECKED_IN');
      expect(row.checkInCount).toBe(2);
    });

    for (const order of ['A first', 'C first'] as const) {
      it(`copied ticket without a check-out: one ACCEPTED, one DUPLICATE_ENTRY (${order})`, async () => {
        const a = await pairDevice(`Copy A ${order}`);
        const c = await pairDevice(`Copy C ${order}`);
        const { tickets: made } = await makeTickets([{}]);
        const t = made[0]!;
        const aIn = scanReq(t, { scannedAt: at(0) });
        const cIn = scanReq(t, { scannedAt: at(15) });
        const uploads =
          order === 'A first'
            ? [uploadOfflineScans(ctx, a, [aIn]), null]
            : [null, uploadOfflineScans(ctx, c, [cIn])];
        const first = await (uploads[0] ?? uploads[1]!);
        const second = await (order === 'A first'
          ? uploadOfflineScans(ctx, c, [cIn])
          : uploadOfflineScans(ctx, a, [aIn]));
        const results = [first[0]!, second[0]!];
        expect(results.filter((r) => r.result === 'ACCEPTED')).toHaveLength(1);
        expect(results.filter((r) => r.result === 'REJECTED_ALREADY_CHECKED_IN')).toHaveLength(1);
        const row = await ticketRow(t.id);
        expect(row.checkInState).toBe('CHECKED_IN');
        expect(row.checkInCount).toBe(1);
        expect(row.firstCheckedInDeviceId).toBe(a.id); // the earliest entry owns the stay
        expect(row.firstCheckedInAt!.toISOString()).toBe(at(0));
        const logs = await handle.db
          .select()
          .from(checkInLogs)
          .where(eq(checkInLogs.ticketId, t.id));
        const rejected = logs.filter((l) => l.result === 'REJECTED_ALREADY_CHECKED_IN');
        expect(rejected).toHaveLength(1);
        expect(rejected[0]!.message).toBe('DUPLICATE_ENTRY');
        const stats = await getCheckInStats(ctx, eventId);
        expect(stats.duplicateEntries).toBeGreaterThan(0);
      });
    }

    it('scenario B: out-of-order uploads of two devices keep the newest state and the earliest entry', async () => {
      const a = await pairDevice('Scenario B A');
      const c = await pairDevice('Scenario B C');
      const { tickets: made } = await makeTickets([{}]);
      const t = made[0]!;
      const aIn = scanReq(t, { scannedAt: at(0) });
      const aOut = scanReq(t, { scannedAt: at(10), action: 'CHECK_OUT' });
      const cIn = scanReq(t, { scannedAt: at(15) });
      const [cRes] = await uploadOfflineScans(ctx, c, [cIn]);
      expect(cRes!.result).toBe('ACCEPTED');
      const aRes = await uploadOfflineScans(ctx, a, [aIn, aOut]);
      // the batch proves a check-out between the two entries, so both entries were real:
      // historic entry (older than the first recorded one) and historic exit are both accepted ...
      expect(aRes.map((r) => r.result)).toEqual(['ACCEPTED', 'ACCEPTED']);
      // ... but the newer entry of C stays the current state
      const row = await ticketRow(t.id);
      expect(row.checkInState).toBe('CHECKED_IN');
      expect(row.checkInCount).toBe(1);
      expect(row.lastScanAt!.toISOString()).toBe(at(15));
      expect(row.firstCheckedInDeviceId).toBe(a.id);
      expect(row.firstCheckedInAt!.toISOString()).toBe(at(0));
      const logs = await handle.db.select().from(checkInLogs).where(eq(checkInLogs.ticketId, t.id));
      expect(logs.find((l) => l.clientScanId === aOut.clientScanId)!.message).toBe('STALE_SCAN');
      expect(logs.find((l) => l.clientScanId === aIn.clientScanId)!.message).toBe(
        'STALE_SCAN_FIRST_ENTRY',
      );
    });

    it('corrects the device clock per batch with sentAt and never predates the ticket', async () => {
      const d = await pairDevice('Skewed device');
      const { tickets: made } = await makeTickets([{}, {}]);
      // The device clock runs two hours behind: it sends at "now - 2h" and scanned 10 minutes before.
      const sentAt = new Date(Date.now() - 2 * 3_600_000);
      const scannedOnDevice = new Date(sentAt.getTime() - 600_000).toISOString();
      const scan = scanReq(made[0]!, { scannedAt: scannedOnDevice });
      const [res] = await uploadOfflineScans(ctx, d, [scan], { sentAt: sentAt.toISOString() });
      expect(res!.result).toBe('ACCEPTED');
      const [log] = await handle.db
        .select()
        .from(checkInLogs)
        .where(eq(checkInLogs.clientScanId, scan.clientScanId));
      expect(Math.abs(log!.scannedAt.getTime() - (Date.now() - 600_000))).toBeLessThan(5_000);

      // lower bound: a scan cannot be older than the ticket
      const issued = new Date(Date.now() - 600_000);
      await handle.db.update(tickets).set({ issuedAt: issued }).where(eq(tickets.id, made[1]!.id));
      const early = scanReq(made[1]!, { scannedAt: at(0) });
      const [r2] = await uploadOfflineScans(ctx, d, [early]);
      expect(r2!.result).toBe('ACCEPTED');
      const [log2] = await handle.db
        .select()
        .from(checkInLogs)
        .where(eq(checkInLogs.clientScanId, early.clientScanId));
      expect(log2!.scannedAt.toISOString()).toBe(issued.toISOString());
      expect(log2!.message).toBe('SCAN_BEFORE_ISSUE');
    });

    it('moves the first entry to a late upload of an earlier scan', async () => {
      const online = await pairDevice('Online late');
      const offline = await pairDevice('Offline early');
      const { tickets: made } = await makeTickets([{}]);
      const t = made[0]!;
      const onlineScan = await scanOnline(ctx, online, scanReq(t, { scannedAt: at(30) }));
      expect(onlineScan.result).toBe('ACCEPTED');
      const [late] = await uploadOfflineScans(ctx, offline, [scanReq(t, { scannedAt: at(5) })]);
      // Older than the first recorded entry but no check-out in between: a duplicate entry that
      // still owns the first entry.
      expect(late!.result).toBe('REJECTED_ALREADY_CHECKED_IN');
      expect(late!.firstScan).toEqual({ at: expect.any(String), deviceName: 'Offline early' });
      const row = await ticketRow(t.id);
      expect(row.firstCheckedInDeviceId).toBe(offline.id);
      expect(row.firstCheckedInAt!.toISOString()).toBe(at(5));
      expect(row.checkInCount).toBe(1);
      expect(row.checkInState).toBe('CHECKED_IN');
      expect(row.lastScanAt!.toISOString()).not.toBe(at(5)); // a stale scan never moves last_scan_at
      const [log] = await handle.db
        .select()
        .from(checkInLogs)
        .where(and(eq(checkInLogs.deviceId, offline.id), eq(checkInLogs.ticketId, t.id)));
      expect(log!.message).toBe('DUPLICATE_ENTRY');
    });

    it('rejects voided tickets and signature problems when uploading, and clamps future clocks', async () => {
      const d = await pairDevice('Offline D');
      const { tickets: made, items } = await makeTickets([{}, {}]);
      await handle.db.transaction(async (tx) => {
        await voidTicketsForItems(tx as never, [items[0]!.id], 'CANCELLED');
      });
      const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
      const results = await uploadOfflineScans(ctx, d, [
        scanReq(made[0]!, { scannedAt: at(1) }),
        scanReq(made[1]!, { scannedAt: future }),
        scanReq(
          {
            id: '',
            qrPayload: `${made[1]!.qrPayload.slice(0, -10)}${made[1]!.qrPayload.at(-10) === 'A' ? 'B' : 'A'}${made[1]!.qrPayload.slice(-9)}`,
          },
          { scannedAt: at(2) },
        ),
      ]);
      expect(results.map((r) => r.result)).toEqual([
        'REJECTED_TICKET_VOID',
        'ACCEPTED',
        'REJECTED_INVALID_SIGNATURE',
      ]);
      const row = await ticketRow(made[1]!.id);
      expect(row.firstCheckedInAt!.getTime()).toBeLessThan(Date.now() + 60_000);
      const [log] = await handle.db
        .select()
        .from(checkInLogs)
        .where(eq(checkInLogs.clientScanId, results[1]!.clientScanId));
      expect(log!.message).toBe('DEVICE_CLOCK_AHEAD');
    });
  });

  // ─── lookup, stats, log ────────────────────────────────────────────────────

  describe('lookup and admin read models', () => {
    it('finds tickets by name, code, order number and seat', async () => {
      const d = await pairDevice('Lookup device');
      const { tickets: made, order } = await makeTickets([
        { attendeeName: 'Zaphod Beeblebrox' },
        { seatId: await freshSeat(), attendeeName: 'Trillian Astra' },
      ]);
      const byName = await lookupTickets(ctx, d, { eventId, q: 'zaphod', limit: 10 });
      expect(byName.tickets.map((t) => t.id)).toEqual([made[0]!.id]);
      expect(byName.tickets[0]).toMatchObject({
        orderNumber: order.orderNumber,
        attendeeName: 'Zaphod Beeblebrox',
      });
      expect(
        (
          await lookupTickets(ctx, d, { eventId, q: made[1]!.ticketCode.toLowerCase(), limit: 10 })
        ).tickets.map((t) => t.id),
      ).toEqual([made[1]!.id]);
      expect(
        (await lookupTickets(ctx, d, { eventId, q: order.orderNumber, limit: 10 })).tickets,
      ).toHaveLength(2);
      for (const q of ['Block Stalls Reihe B Platz 7', 'stalls b 7', 'B 7']) {
        const hits = await lookupTickets(ctx, d, { eventId, q, limit: 50 });
        expect(
          hits.tickets.some((t) => t.id === made[1]!.id),
          q,
        ).toBe(true);
      }
      expect(
        (await lookupTickets(ctx, d, { eventId, q: 'stalls b 8', limit: 50 })).tickets.some(
          (t) => t.id === made[1]!.id,
        ),
      ).toBe(false);
      expect(
        (await lookupTickets(ctx, d, { eventId, q: 'nobody-here', limit: 10 })).tickets,
      ).toEqual([]);
      await expect(
        lookupTickets(ctx, d, { eventId: otherEventId, q: 'zaphod', limit: 10 }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('reports statistics and a filterable journal', async () => {
      const d = await pairDevice('Stats device', { entranceId: northId });
      const { tickets: made } = await makeTickets([{}, {}, {}]);
      const before = await getCheckInStats(ctx, eventId);
      await scanOnline(ctx, d, scanReq(made[0]!));
      await scanOnline(ctx, d, scanReq(made[1]!));
      await scanOnline(ctx, d, scanReq(made[1]!, { action: 'CHECK_OUT' }));
      await scanOnline(ctx, d, scanReq(made[0]!));
      const stats = await getCheckInStats(ctx, eventId);
      expect(stats.checkedIn - before.checkedIn).toBe(1);
      expect(stats.checkedOut - before.checkedOut).toBe(1);
      expect(stats.valid - before.valid).toBe(0);
      expect(stats.notArrived + stats.checkedIn + stats.checkedOut).toBe(stats.valid);
      expect(
        stats.byEntrance.find((e) => e.entranceId === northId)!.checkIns,
      ).toBeGreaterThanOrEqual(2);
      expect(stats.results.ACCEPTED).toBeGreaterThan(0);

      const log = await listScanLog(ctx, { eventId, deviceId: d.id, pageSize: 2 });
      expect(log.total).toBe(4);
      expect(log.entries).toHaveLength(2);
      expect(log.entries[0]).toMatchObject({ deviceName: 'Stats device', entranceName: 'North' });
      const rejected = await listScanLog(ctx, {
        eventId,
        deviceId: d.id,
        result: 'REJECTED_ALREADY_CHECKED_IN',
      });
      expect(rejected.total).toBe(1);
      expect(rejected.entries[0]).toMatchObject({
        ticketCode: made[0]!.ticketCode,
        seat: { sectionLabel: 'Floor' },
      });
      const page2 = await listScanLog(ctx, { eventId, deviceId: d.id, pageSize: 2, page: 2 });
      expect(page2.entries).toHaveLength(2);
    });

    it('pages and searches the journal together with the filters', async () => {
      const d = await pairDevice('Search device', { entranceId: northId });
      const { tickets: made } = await makeTickets([
        { attendeeName: 'Qwerty Percent%Name' },
        { attendeeName: 'Qwerty Plain' },
        { attendeeName: 'Other Person' },
      ]);
      for (const t of made) await scanOnline(ctx, d, scanReq(t));
      await scanOnline(ctx, d, scanReq(made[0]!)); // rejected duplicate

      const all = await listScanLog(ctx, { eventId, deviceId: d.id, pageSize: 3 });
      expect(all.total).toBe(4);
      expect(all.entries).toHaveLength(3);
      const p2 = await listScanLog(ctx, { eventId, deviceId: d.id, pageSize: 3, page: 2 });
      expect(p2.entries).toHaveLength(1);
      expect(new Set([...all.entries, ...p2.entries].map((e) => e.id)).size).toBe(4);
      // Out-of-range page falls back to the last page.
      expect((await listScanLog(ctx, { eventId, deviceId: d.id, pageSize: 3, page: 9 })).page).toBe(
        2,
      );

      const byName = await listScanLog(ctx, { eventId, deviceId: d.id, search: 'qWeRtY' });
      expect(byName.total).toBe(3);
      // Several words must all match (any field).
      expect(
        (await listScanLog(ctx, { eventId, deviceId: d.id, search: 'qwerty plain' })).total,
      ).toBe(1);
      // % and _ are literals, not wildcards.
      expect((await listScanLog(ctx, { eventId, deviceId: d.id, search: 't%N' })).total).toBe(2);
      expect((await listScanLog(ctx, { eventId, deviceId: d.id, search: '%' })).total).toBe(2);
      expect(
        (await listScanLog(ctx, { eventId, deviceId: d.id, search: 'Qwerty_Plain' })).total,
      ).toBe(0);
      // Ticket code, seat and order number.
      const code = made[2]!.ticketCode;
      expect(
        (await listScanLog(ctx, { eventId, deviceId: d.id, search: code.toLowerCase() })).total,
      ).toBe(1);
      expect((await listScanLog(ctx, { eventId, deviceId: d.id, search: 'floor' })).total).toBe(4);
      const [ord] = await handle.db
        .select({ n: orders.orderNumber })
        .from(tickets)
        .innerJoin(orders, eq(orders.id, tickets.orderId))
        .where(eq(tickets.id, made[1]!.id));
      expect(
        (await listScanLog(ctx, { eventId, deviceId: d.id, search: ord!.n.toLowerCase() })).total,
      ).toBeGreaterThanOrEqual(1);
      // Search combined with the result filter and paging.
      const combo = await listScanLog(ctx, {
        eventId,
        deviceId: d.id,
        search: 'Percent',
        result: 'REJECTED_ALREADY_CHECKED_IN',
        pageSize: 1,
      });
      expect(combo.total).toBe(1);
      expect(combo.entries[0]?.ticketCode).toBe(made[0]!.ticketCode);
      // Newest first.
      const times = all.entries.map((e) => e.scannedAt.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });
  });

  describe('deleting revoked devices', () => {
    it('archives only revoked devices and keeps the scan history readable', async () => {
      const gone = await pairDevice('Retired phone');
      const other = await pairDevice('Other door');
      const { tickets: made } = await makeTickets([{}]);
      await scanOnline(ctx, gone, scanReq(made[0]!));

      await expect(deleteScannerDevice(ctx, gone.id)).rejects.toMatchObject({
        code: 'DEVICE_NOT_REVOKED',
        status: 409,
      });
      expect((await listScannerDevices(ctx)).some((x) => x.id === gone.id)).toBe(true);

      await revokeScannerDevice(ctx, gone.id);
      await deleteScannerDevice(ctx, gone.id);

      expect((await listScannerDevices(ctx)).some((x) => x.id === gone.id)).toBe(false);
      expect((await listScannerDevices(ctx)).some((x) => x.id === other.id)).toBe(true);
      const [row] = await handle.db
        .select({ deletedAt: scannerDevices.deletedAt })
        .from(scannerDevices)
        .where(eq(scannerDevices.id, gone.id));
      expect(row?.deletedAt).toBeInstanceOf(Date);
      expect(
        await handle.db
          .select()
          .from(scannerDeviceEvents)
          .where(eq(scannerDeviceEvents.deviceId, gone.id)),
      ).toHaveLength(0);
      expect(
        await handle.db
          .select()
          .from(devicePairingCodes)
          .where(eq(devicePairingCodes.deviceId, gone.id)),
      ).toHaveLength(0);

      // The token stays unusable; the device cannot be changed or revoked again.
      await expect(authenticateDevice(ctx, `Bearer ${gone.token}`)).rejects.toMatchObject({
        code: 'DEVICE_REVOKED',
        status: 401,
      });
      await expect(updateScannerDevice(ctx, gone.id, { name: 'x' })).rejects.toMatchObject({
        status: 404,
      });
      await expect(revokeScannerDevice(ctx, gone.id)).rejects.toMatchObject({ status: 404 });
      await expect(deleteScannerDevice(ctx, gone.id)).rejects.toMatchObject({
        code: 'DEVICE_NOT_FOUND',
        status: 404,
      });
      await expect(deleteScannerDevice(ctx, uuid())).rejects.toMatchObject({ status: 404 });

      // Audit trail: journal and "first scanned by" still carry the device name.
      const log = await listScanLog(ctx, { eventId, deviceId: gone.id });
      expect(log.entries[0]).toMatchObject({ deviceName: 'Retired phone' });
      expect(await listScanLogDevices(ctx, eventId)).toContainEqual({
        id: gone.id,
        name: 'Retired phone',
        deleted: true,
      });
      const again = await scanOnline(ctx, other, scanReq(made[0]!));
      expect(again.firstScan?.deviceName).toBe('Retired phone');
    });
  });

  // ─── APK releases ──────────────────────────────────────────────────────────

  describe('APK releases', () => {
    const apk = (extra = 0) => {
      const bytes = new Uint8Array(APK_MIN_BYTES + 10 + extra);
      bytes.set([0x50, 0x4b, 0x03, 0x04]);
      return bytes;
    };

    it('validates, stores, switches the current release and serves signed links', async () => {
      await expect(
        registerApkRelease(ctx, {
          bytes: new Uint8Array(5000),
          versionName: '1.0.0',
          versionCode: 1,
          uploadedByUserId: null,
          makeCurrent: true,
        }),
      ).rejects.toMatchObject({ code: 'NOT_AN_APK' });
      await expect(
        registerApkRelease(ctx, {
          bytes: apk(),
          versionName: 'bad name!',
          versionCode: 1,
          uploadedByUserId: null,
          makeCurrent: true,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_VERSION_NAME' });
      await expect(appLatestInfo(ctx)).resolves.toBeNull();

      const r1 = await registerApkRelease(ctx, {
        bytes: apk(),
        versionName: '1.0.0',
        versionCode: 1,
        notes: 'first',
        uploadedByUserId: null,
        makeCurrent: true,
      });
      expect(r1).toMatchObject({ isCurrent: true, sizeBytes: apk().length });
      expect(r1.sha256).toMatch(/^[0-9a-f]{64}$/);
      await expect(
        registerApkRelease(ctx, {
          bytes: apk(),
          versionName: '1.0.1',
          versionCode: 1,
          uploadedByUserId: null,
          makeCurrent: true,
        }),
      ).rejects.toMatchObject({ code: 'VERSION_CODE_EXISTS' });
      const r2 = await registerApkRelease(ctx, {
        bytes: apk(1),
        versionName: '1.1.0',
        versionCode: 2,
        uploadedByUserId: null,
        makeCurrent: true,
      });
      const listed = await listApkReleases(ctx);
      expect(listed.map((r) => [r.versionCode, r.isCurrent])).toEqual([
        [2, true],
        [1, false],
      ]);

      const latest = await appLatestInfo(ctx);
      expect(latest).toMatchObject({
        versionName: '1.1.0',
        versionCode: 2,
        sizeBytes: r2.sizeBytes,
      });
      expect(latest!.downloadUrl).toMatch(
        /^http:\/\/192\.168\.1\.20:8080\/api\/scanner\/v1\/app\/download\?t=/,
      );
      const token = new URL(latest!.downloadUrl).searchParams.get('t')!;
      const file = await openApkForToken(ctx, token);
      expect(file.release.id).toBe(r2.id);
      expect((await new Response(file.stream).arrayBuffer()).byteLength).toBe(r2.sizeBytes);
      await expect(openApkForToken(ctx, token + 'x')).rejects.toMatchObject({
        code: 'INVALID_LINK',
      });
      const expired = createApkDownloadToken(ctx, 'current', -10);
      await expect(openApkForToken(ctx, expired)).rejects.toMatchObject({ code: 'INVALID_LINK' });
      expect((await openApkForToken(ctx, createApkDownloadToken(ctx, 'current'))).release.id).toBe(
        r2.id,
      );

      await setCurrentApkRelease(ctx, r1.id);
      expect((await openApkForToken(ctx, createApkDownloadToken(ctx, 'current'))).release.id).toBe(
        r1.id,
      );
      await expect(deleteApkRelease(ctx, r1.id)).rejects.toMatchObject({
        code: 'RELEASE_IS_CURRENT',
      });
      await deleteApkRelease(ctx, r2.id);
      expect(storageObjects.has(r2.objectKey)).toBe(false);
      expect(await listApkReleases(ctx)).toHaveLength(1);
    });
  });
});
