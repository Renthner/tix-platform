/** Wallet passes against real PostgreSQL (throw-away database) with fake storage / HTTP. */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  customers,
  events,
  loadRootEnv,
  orderItems,
  orders,
  priceCategories,
  seatMapSections,
  seatMaps,
  taxRates,
  tickets,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { eq } from 'drizzle-orm';
import forge from 'node-forge';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCoreContext,
  ensureApplePass,
  ensureGoogleSaveUrl,
  ensureOrderTickets,
  checkAppleWalletConfiguration,
  checkGoogleWalletConfiguration,
  resolveWalletDesign,
  saveSecretSetting,
  saveSetting,
  saveWalletPassDesign,
  walletAvailability,
  walletLinksForOrder,
  walletLinksVariable,
  type CoreContext,
  type ObjectStorage,
} from '../src';
import { readZip } from '../src/wallet/zip';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();

const objects = new Map<string, Uint8Array>();
const fakeStorage = {
  put: async (bucket: string, key: string, body: Uint8Array) => {
    objects.set(`${bucket}/${key}`, Buffer.from(body));
  },
  get: async (bucket: string, key: string) => {
    const body = objects.get(`${bucket}/${key}`);
    if (!body) throw new Error('missing');
    return { body, contentType: undefined };
  },
  delete: async (bucket: string, key: string) => {
    objects.delete(`${bucket}/${key}`);
  },
} as unknown as ObjectStorage;

function testChain() {
  const mk = (
    cn: string,
    issuer?: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey },
  ) => {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 86_400_000);
    cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
    const attrs = [{ name: 'commonName', value: cn }];
    cert.setSubject(attrs);
    cert.setIssuer(issuer ? issuer.cert.subject.attributes : attrs);
    cert.sign(issuer?.key ?? keys.privateKey, forge.md.sha256.create());
    return { cert, keys };
  };
  const ca = mk('Test CA');
  const signer = mk('Test Signer', { cert: ca.cert, key: ca.keys.privateKey });
  return {
    wwdrCertificatePem: forge.pki.certificateToPem(ca.cert),
    signerCertificatePem: forge.pki.certificateToPem(signer.cert),
    signerKeyPem: forge.pki.privateKeyToPem(signer.keys.privateKey),
  };
}

describe.skipIf(!adminUrl || !redisUrl)('wallet passes (integration)', () => {
  const dbName = `tix_wallet_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let orderId: string;
  let ticketIds: string[];

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    await runMigrations({
      connectionString: url.toString(),
      migrationsFolder: resolve(import.meta.dirname, '../../db/migrations'),
      log: () => {},
    });
    handle = createDb({ connectionString: url.toString(), poolMax: 10 });
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${uuid().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      secrets: createSecretBox(parseKeyRing(generateKeyRingEntry('t1'))),
      appUrl: 'https://shop.example',
      storage: fakeStorage,
    });
    const db = handle.db;
    const [venue] = await db
      .insert(venues)
      .values({
        name: 'Hall',
        slug: `hall-${uuid().slice(0, 6)}`,
        timeZone: 'Europe/Berlin',
        latitude: 50.1,
        longitude: 8.2,
      })
      .returning();
    const [map] = await db
      .insert(seatMaps)
      .values({
        venueId: venue!.id,
        kind: 'EVENT',
        name: 'Hall',
        canvasWidth: 100,
        canvasHeight: 100,
      })
      .returning();
    const base = {
      seatMapId: map!.id,
      type: 'STANDING' as const,
      capacity: 50,
      geometry: { type: 'rect' as const, x: 0, y: 0, width: 50, height: 50, rotation: 0 },
    };
    const [section] = await db
      .insert(seatMapSections)
      .values({ ...base, name: 'Floor', ticketLabel: 'Floor' })
      .returning();
    const [hidden] = await db
      .insert(seatMapSections)
      .values({ ...base, name: 'Secret', ticketLabel: 'Secret', showLabelOnTicket: false })
      .returning();
    const [rate] = await db
      .insert(taxRates)
      .values({ name: `vat-${uuid().slice(0, 6)}`, rateBasisPoints: 1900 })
      .returning();
    const [ev] = await db
      .insert(events)
      .values({
        venueId: venue!.id,
        seatMapId: map!.id,
        slug: `ev-${uuid().slice(0, 8)}`,
        title: 'Show',
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: rate!.id,
      })
      .returning();
    const [category] = await db
      .insert(priceCategories)
      .values({ eventId: ev!.id, name: 'Cat 1', color: '#336699', basePrice: 2000 })
      .returning();
    const [tt] = await db
      .insert(ticketTypes)
      .values({ eventId: ev!.id, name: 'Normal', isDefault: true })
      .returning();
    const email = `buyer-${uuid().slice(0, 6)}@example.org`;
    const [customer] = await db
      .insert(customers)
      .values({ email, firstName: 'Ann', lastName: 'Example' })
      .returning();
    const [order] = await db
      .insert(orders)
      .values({
        orderNumber: `T-${uuid().slice(0, 8)}`,
        customerId: customer!.id,
        status: 'PAID',
        channel: 'ONLINE',
        paymentMethod: 'PAYPAL',
        email,
        firstName: 'Ann',
        lastName: 'Example',
        billingAddress: { street: 'Weg 1', postalCode: '12345', city: 'Stadt', country: 'DE' },
        locale: 'en',
        currency: 'EUR',
        subtotalGross: 4000,
        feeTotal: 0,
        totalGross: 4000,
        totalNet: 3360,
        totalTax: 640,
        amountPaid: 4000,
        paidAt: new Date(),
      })
      .returning();
    orderId = order!.id;
    await db.insert(orderItems).values(
      [section!.id, hidden!.id].map((sectionId, n) => ({
        orderId,
        eventId: ev!.id,
        kind: 'GENERAL_ADMISSION' as const,
        sectionId,
        priceCategoryId: category!.id,
        ticketTypeId: tt!.id,
        status: 'CONFIRMED' as const,
        sectionLabel: n === 0 ? 'Floor' : 'Secret',
        categoryName: 'Cat 1',
        ticketTypeName: 'Normal',
        unitPriceGross: 2000,
        priceGross: 2000,
        taxRateBasisPoints: 1900,
        priceNet: 1680,
        taxAmount: 320,
      })),
    );
    const issued = await ensureOrderTickets(ctx, orderId);
    const labels = await db
      .select({ id: orderItems.id, label: orderItems.sectionLabel })
      .from(orderItems);
    const labelOf = (itemId: string) => labels.find((l) => l.id === itemId)?.label;
    // [0] = visible block "Floor", [1] = hidden block "Secret"
    ticketIds = [
      issued.find((t) => labelOf(t.orderItemId) === 'Floor')!.id,
      issued.find((t) => labelOf(t.orderItemId) === 'Secret')!.id,
    ];
  });

  afterAll(async () => {
    await handle?.close();
    if (redis) await redis.quit();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('offers nothing while unconfigured and never throws', async () => {
    expect(await walletAvailability(ctx)).toEqual({ apple: false, google: false });
    expect(await walletLinksForOrder(ctx, orderId)).toEqual([]);
    const variable = await walletLinksVariable(ctx, orderId, 'en');
    expect(variable.html).toBe('');
    await expect(ensureApplePass(ctx, ticketIds[0]!)).rejects.toMatchObject({
      code: 'WALLET_DISABLED',
    });
    await expect(ensureGoogleSaveUrl(ctx, ticketIds[0]!)).rejects.toMatchObject({
      code: 'WALLET_DISABLED',
    });
    // Enabled without credentials is still "not available".
    await saveSetting(
      ctx,
      'wallet.apple',
      { enabled: true, passTypeIdentifier: 'pass.test.example', teamIdentifier: 'TEAM123456' },
      null,
    );
    expect((await walletAvailability(ctx)).apple).toBe(false);
    expect((await checkAppleWalletConfiguration(ctx)).ok).toBe(false);
  });

  it('serves a cached signed pkpass honouring show_label_on_ticket', async () => {
    const chain = testChain();
    await saveSecretSetting(ctx, 'wallet.apple.certificates', chain, null);
    expect((await checkAppleWalletConfiguration(ctx)).ok).toBe(true);
    expect((await walletAvailability(ctx)).apple).toBe(true);

    const first = await ensureApplePass(ctx, ticketIds[0]!);
    const files = readZip(first.bytes);
    expect(files.has('signature')).toBe(true);
    const pass = JSON.parse(files.get('pass.json')!.toString());
    expect(pass.serialNumber).toBe(ticketIds[0]);
    expect(pass.locations[0].latitude).toBe(50.1);
    const [row] = await handle.db.select().from(tickets).where(eq(tickets.id, ticketIds[0]!));
    expect(row!.pkpassObjectKey).toContain(ticketIds[0]!);
    expect(objects.has(`documents/${row!.pkpassObjectKey}`)).toBe(true);
    const again = await ensureApplePass(ctx, ticketIds[0]!);
    expect(readZip(again.bytes).get('pass.json')!.toString()).toBe(
      files.get('pass.json')!.toString(),
    );

    // Hidden block label never appears on the pass of the second ticket.
    const hidden = await ensureApplePass(ctx, ticketIds[1]!);
    const hiddenPass = readZip(hidden.bytes).get('pass.json')!.toString();
    expect(hiddenPass).not.toContain('Secret');
    expect(pass.eventTicket.auxiliaryFields[0].value).toContain('Floor');

    // A design change produces a new package.
    await saveWalletPassDesign(handle.db, null, {
      backgroundColor: '#AA0000',
      foregroundColor: '#FFFFFF',
      labelColor: '#EEEEEE',
      logoText: 'Custom',
      description: null,
      logoAssetId: null,
      iconAssetId: null,
      stripAssetId: null,
      heroAssetId: null,
    });
    expect((await resolveWalletDesign(ctx, null)).backgroundColor).toBe('#AA0000');
    const changed = await ensureApplePass(ctx, ticketIds[0]!);
    expect(JSON.parse(readZip(changed.bytes).get('pass.json')!.toString()).backgroundColor).toBe(
      'rgb(170, 0, 0)',
    );
  });

  it('creates class + object once and returns a save link; links reach the e-mail variable', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await saveSetting(
      ctx,
      'wallet.google',
      { enabled: true, issuerId: '3388000000000000009' },
      null,
    );
    await saveSecretSetting(
      ctx,
      'wallet.google.credentials',
      {
        serviceAccountJson: JSON.stringify({
          client_email: 'svc@test.iam.gserviceaccount.com',
          private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        }),
      },
      null,
    );
    const calls: { method: string; url: string; body?: any }[] = [];
    let conflictOnce = true;
    const fakeFetch = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' && init.headers && (init.headers as any)['content-type']
          ? JSON.parse(init.body)
          : undefined;
      calls.push({ method, url, body });
      if (url.includes('oauth2')) {
        return Response.json({ access_token: 'tok', expires_in: 3600 });
      }
      if (method === 'GET' && url.includes('/eventTicketClass/')) {
        return Response.json({ error: { message: 'not found' } }, { status: 404 });
      }
      if (method === 'POST' && url.endsWith('/eventTicketObject') && conflictOnce) {
        conflictOnce = false;
        return Response.json({ error: { message: 'exists' } }, { status: 409 });
      }
      return Response.json({});
    };

    const url = await ensureGoogleSaveUrl(ctx, ticketIds[0]!, fakeFetch);
    expect(url).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\/.+\..+\..+/);
    const sequence = calls.map((c) => `${c.method} ${c.url.split('/v1')[1] ?? 'token'}`);
    expect(sequence[0]).toBe('POST token');
    expect(sequence.slice(1)).toEqual([
      expect.stringMatching(/^GET \/eventTicketClass\//),
      'POST /eventTicketClass',
      'POST /eventTicketObject',
      expect.stringMatching(/^PATCH \/eventTicketObject\//),
    ]);
    const [ev] = await handle.db.select().from(events);
    expect(ev!.googleWalletClassId).toBe(`3388000000000000009.tix_${ev!.id}`);
    const [row] = await handle.db.select().from(tickets).where(eq(tickets.id, ticketIds[0]!));
    expect(row!.googleWalletObjectId).toBe(`3388000000000000009.tix_${ticketIds[0]}`);

    const before = calls.length;
    await ensureGoogleSaveUrl(ctx, ticketIds[0]!, fakeFetch);
    expect(calls.length).toBe(before); // unchanged payloads are not re-sent

    expect((await checkGoogleWalletConfiguration(ctx, fakeFetch)).ok).toBe(true);

    const links = await walletLinksForOrder(ctx, orderId);
    expect(links).toHaveLength(2);
    expect(links[0]!.appleUrl).toMatch(
      new RegExp(
        `^https://shop\\.example/api/orders/${orderId}/tickets/${ticketIds[0]}/pkpass\\?t=`,
      ),
    );
    expect(links[0]!.googleUrl).toContain('/google?t=');
    const variable = await walletLinksVariable(ctx, orderId, 'de');
    expect(variable.html).toContain('Zu Apple Wallet hinzufügen');
    expect(variable.html).toContain('Zu Google Wallet hinzufügen');
    expect(variable.text).toContain('/pkpass?t=');
  });

  it('turns off again when disabled', async () => {
    await saveSetting(ctx, 'wallet.apple', { enabled: false }, null);
    await saveSetting(ctx, 'wallet.google', { enabled: false }, null);
    // settings cache is per process (10 s); invalidate through the public API
    const { invalidateSettings } = await import('../src');
    invalidateSettings();
    expect(await walletAvailability(ctx)).toEqual({ apple: false, google: false });
    expect(await walletLinksForOrder(ctx, orderId)).toEqual([]);
  });
});
