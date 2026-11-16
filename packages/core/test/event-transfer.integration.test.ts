/**
 * Event export / import and seat plan replacement against real PostgreSQL (throw-away database)
 * with an in-memory object storage – never the shared MinIO buckets.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  emailTemplates,
  eventSigningKeys,
  events,
  fees,
  loadRootEnv,
  mediaAssets,
  orderItems,
  orders,
  priceCategories,
  priceCategoryTicketTypes,
  scannerDeviceEvents,
  scannerDevices,
  seatMapEntrances,
  queueConfigs,
  seatMaps,
  seats,
  taxRates,
  ticketTemplates,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { ticketLayoutSchema } from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { and, count, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainError,
  applyTemplateCategoriesToEvent,
  cloneSeatMap,
  createCoreContext,
  createSymbol,
  exportEvent,
  exportSeatMap,
  importEvent,
  parseEventFile,
  replaceEventSeatPlan,
  saveSeatMapDocument,
  uploadMediaAsset,
  type CoreContext,
  type ObjectStorage,
} from '../src';
import { solidPng } from './image-fixtures';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const DAY = 86_400_000;
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="currentColor"/></svg>';
const sanitize = (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, '');
const failure = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (err) {
    return err instanceof DomainError ? err.code : `OTHER:${String(err)}`;
  }
  return undefined;
};

describe.skipIf(!adminUrl || !redisUrl)('event export / import (integration)', () => {
  const dbName = `tix_evt_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let venueA: string;
  let venueB: string;
  let taxId: string;
  let templateA: string;
  let templateOther: string;
  let sourceEventId: string;
  const stored = new Map<string, Uint8Array>();
  const storage = {
    put: async (_bucket: string, key: string, body: Uint8Array | string) => {
      stored.set(key, typeof body === 'string' ? Buffer.from(body) : body);
    },
    get: async (_bucket: string, key: string) => ({
      body: stored.get(key)!,
      contentType: undefined,
    }),
    delete: async (_bucket: string, key: string) => {
      stored.delete(key);
    },
  } as unknown as ObjectStorage;

  const normalise = (file: Awaited<ReturnType<typeof exportEvent>>) => ({
    ...file,
    exportedAt: '',
    seatPlan: file.seatPlan && { ...file.seatPlan, exportedAt: '' },
  });
  const run = (file: unknown, extra: Partial<Parameters<typeof importEvent>[1]> = {}) =>
    importEvent(ctx, {
      file,
      venueId: venueA,
      userId: null,
      sanitizeRichText: sanitize,
      includeEmailTemplates: true,
      defaultTicketTypeName: 'Standard',
      ...extra,
    });

  /** A plan master with the given plan categories on `venueId`; the first category gets the section. */
  const makeTemplate = async (venueId: string, name: string, categories: string[]) => {
    const [map] = await handle.db
      .insert(seatMaps)
      .values({ venueId, kind: 'TEMPLATE', name, canvasWidth: 1200, canvasHeight: 800 })
      .returning({ id: seatMaps.id });
    const ids = categories.map(() => randomUUID());
    const section = randomUUID();
    const row = randomUUID();
    const seat = (label: string, position: number, category: string | null) => ({
      id: randomUUID(),
      sectionId: section,
      rowId: row,
      label,
      position,
      x: 100 + position * 20,
      y: 200,
      priceCategoryId: category,
    });
    const result = await saveSeatMapDocument(
      handle.db,
      map!.id,
      {
        version: 1,
        name,
        canvasWidth: 1200,
        canvasHeight: 800,
        backgroundAssetId: null,
        categories: categories.map((c, i) => ({
          id: ids[i]!,
          name: c,
          color: i === 0 ? '#FF0000' : '#00AA00',
          sortOrder: i,
        })),
        settings: {},
        entrances: [],
        sections: [
          {
            id: section,
            type: 'SEATED',
            name: 'Parkett',
            ticketLabel: 'Parkett',
            priceCategoryId: ids[0]!,
            geometry: { type: 'rect', x: 50, y: 150, width: 400, height: 200, rotation: 0 },
          },
        ],
        rows: [
          {
            id: row,
            sectionId: section,
            label: 'A',
            geometry: {
              curve: { type: 'straight', start: { x: 100, y: 200 }, end: { x: 300, y: 200 } },
              seatSpacing: 20,
            },
          },
        ],
        elements: [],
        seats: [seat('1', 1, ids[0]!), seat('2', 2, ids[0]!), seat('3', 3, ids[1] ?? null)],
      },
      null,
    );
    expect(result.ok).toBe(true);
    return map!.id;
  };

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
    handle = createDb({ connectionString: url.toString(), poolMax: 8 });
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      secrets: createSecretBox(parseKeyRing(generateKeyRingEntry('t1'))),
      storage,
    });
    const db = handle.db;
    const made = await db
      .insert(venues)
      .values([
        { name: 'A', slug: `a-${randomUUID().slice(0, 6)}`, timeZone: 'Europe/Berlin' },
        { name: 'B', slug: `b-${randomUUID().slice(0, 6)}`, timeZone: 'Europe/Berlin' },
      ])
      .returning({ id: venues.id });
    venueA = made[0]!.id;
    venueB = made[1]!.id;
    const [tax] = await db
      .insert(taxRates)
      .values({ name: 'VAT 19', rateBasisPoints: 1900, isDefault: true })
      .returning({ id: taxRates.id });
    taxId = tax!.id;

    templateA = await makeTemplate(venueA, 'Main hall', ['Premium', 'Standard']);
    templateOther = await makeTemplate(venueB, 'Other hall', ['Premium']);

    // ── Source event: everything the file is supposed to carry ──────────
    const symbol = await createSymbol(db, {
      name: 'Info icon',
      kind: 'ELEMENT',
      svg: SVG,
      colorize: true,
      createdByUserId: null,
    });
    const hero = await uploadMediaAsset(ctx, {
      kind: 'EVENT_IMAGE',
      bytes: await solidPng(640, 360, 21),
      fileName: 'cover.png',
      userId: null,
    });
    const artwork = await uploadMediaAsset(ctx, {
      kind: 'TICKET_BACKGROUND',
      bytes: await solidPng(600, 300, 22),
      fileName: 'bg.png',
      userId: null,
    });
    const logo = await uploadMediaAsset(ctx, {
      kind: 'TICKET_BACKGROUND',
      bytes: await solidPng(100, 100, 23),
      fileName: 'logo.png',
      userId: null,
    });
    const start = new Date(Date.now() + 60 * DAY);
    const boxId = randomUUID();
    const [event] = await db
      .insert(events)
      .values({
        venueId: venueA,
        slug: 'source-show',
        title: 'Source Show',
        subtitle: 'The subtitle',
        description: '<p>Hello</p>',
        translations: { de: { title: 'Quelle', description: '<p>Hallo</p>' } },
        status: 'DRAFT',
        startsAt: start,
        doorsOpenAt: new Date(start.getTime() - 3_600_000),
        endsAt: new Date(start.getTime() + 3 * 3_600_000),
        presaleStartsAt: new Date(start.getTime() - 20 * DAY),
        publicSaleStartsAt: new Date(start.getTime() - 10 * DAY),
        saleEndsAt: new Date(start.getTime() - 3_600_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: taxId,
        shopSortOrder: 4,
        googleWalletClassId: 'old.class',
        seoNoindex: true,
        maxTicketsPerOrder: 6,
        cartLockTtlSeconds: 900,
        paypalEnabled: false,
        orphanSeatRuleEnabled: true,
        bankTransferCancelAfterDays: 10,
        selfServiceEnabled: true,
        selfServiceMaxChanges: 0,
        heroImageAssetId: hero.id,
        infoBoxes: [
          {
            id: boxId,
            title: 'Proof',
            symbolId: symbol.id,
            content: '<p>Bring ID</p>',
            textSize: 'L',
            translations: { de: { title: 'Nachweis' } },
          },
        ],
        pageLayout: [
          [{ ref: 'SHOP', span: 1 }],
          [
            { ref: `box:${boxId}`, span: 2 },
            { ref: 'DESCRIPTION', span: 1 },
          ],
        ],
      })
      .returning();
    sourceEventId = event!.id;
    const mapId = await cloneSeatMap(db, templateA, { kind: 'EVENT', name: 'Source Show' });
    await db
      .update(events)
      .set({ seatMapId: mapId, status: 'PUBLISHED', publishedAt: new Date() })
      .where(eq(events.id, sourceEventId));
    await applyTemplateCategoriesToEvent(db, { eventId: sourceEventId, seatMapId: mapId });
    await db
      .update(priceCategories)
      .set({ basePrice: 5000 })
      .where(and(eq(priceCategories.eventId, sourceEventId), eq(priceCategories.name, 'Premium')));
    await db
      .update(priceCategories)
      .set({ basePrice: 3000, maxTicketsPerOrder: 2 })
      .where(and(eq(priceCategories.eventId, sourceEventId), eq(priceCategories.name, 'Standard')));
    const cats = await db
      .select()
      .from(priceCategories)
      .where(eq(priceCategories.eventId, sourceEventId));
    const [normal] = await db
      .insert(ticketTypes)
      .values({ eventId: sourceEventId, name: 'Normal', isDefault: true })
      .returning();
    const [reduced] = await db
      .insert(ticketTypes)
      .values({
        eventId: sourceEventId,
        name: 'Reduced',
        discountKind: 'FIXED_AMOUNT',
        discountValue: 500,
        requiresProofAtEntry: true,
        scannerWarning: 'Check proof',
        translations: { de: { name: 'Ermäßigt' } },
      })
      .returning();
    for (const c of cats) {
      await db.insert(priceCategoryTicketTypes).values([
        { priceCategoryId: c.id, ticketTypeId: normal!.id },
        {
          priceCategoryId: c.id,
          ticketTypeId: reduced!.id,
          discountKind: 'FIXED_AMOUNT',
          discountValue: c.name === 'Premium' ? 700 : 400,
        },
      ]);
    }
    const [globalFee] = await db
      .insert(fees)
      .values({ name: 'Service', scope: 'PER_TICKET', calculation: 'FIXED', value: 100 })
      .returning();
    await db.insert(fees).values([
      {
        eventId: sourceEventId,
        overridesFeeId: globalFee!.id,
        name: 'Service',
        scope: 'PER_TICKET',
        calculation: 'FIXED',
        value: 0,
        isActive: false,
      },
      {
        eventId: sourceEventId,
        name: 'Presale fee',
        scope: 'PER_EVENT',
        calculation: 'PERCENT',
        value: 250,
        channels: ['ONLINE'],
        translations: { de: { name: 'Vorverkaufsgebühr' } },
      },
    ]);
    const layout = ticketLayoutSchema.parse({
      version: 1,
      qr: { x: 100, y: 10, size: 30 },
      elements: [
        { kind: 'image', id: 'i1', assetId: logo.id, x: 5, y: 5, width: 20, height: 20 },
        { kind: 'text', id: 't1', field: 'EVENT_TITLE', x: 30, y: 5, width: 60, height: 10 },
      ],
    });
    const [template] = await db
      .insert(ticketTemplates)
      .values({
        eventId: sourceEventId,
        name: 'Event layout',
        pageWidthMm: 150,
        pageHeightMm: 80,
        backgroundAssetId: artwork.id,
        layout,
      })
      .returning();
    await db
      .update(events)
      .set({ ticketTemplateId: template!.id })
      .where(eq(events.id, sourceEventId));
    await db.insert(queueConfigs).values({
      eventId: sourceEventId,
      mode: 'AUTO_THRESHOLD',
      activeSessionThreshold: 77,
      admissionBatchSize: 10,
      admissionIntervalSeconds: 5,
      passTokenTtlSeconds: 600,
      title: 'Hold on',
      translations: { de: { title: 'Bitte warten' } },
    });
    await db.insert(emailTemplates).values({
      key: 'ORDER_CONFIRMATION_BANK_TRANSFER',
      eventId: sourceEventId,
      locale: 'en',
      subject: 'Override',
      bodyHtml: '<p>Override</p>',
    });
  });

  afterAll(async () => {
    if (redis) {
      const keys = await redis.keys(`${ctx.keys.prefix}:*`);
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
    }
    await handle?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  it('exports everything event-scoped without ids, codes or secrets', async () => {
    const file = await exportEvent(ctx, sourceEventId, {
      appVersion: '1.2.3',
      includeEmailTemplates: true,
    });
    expect(file).toMatchObject({
      format: 'tix-event',
      version: 1,
      source: { appVersion: '1.2.3', venueName: 'A' },
    });
    expect(file.priceCategories.map((c) => c.name)).toEqual(['Premium', 'Standard']);
    expect(file.ticketTypes).toHaveLength(2);
    expect(file.pricing).toHaveLength(4);
    expect(file.fees).toHaveLength(2);
    expect(file.fees.find((f) => f.overridesGlobal)).toMatchObject({
      overridesGlobal: { name: 'Service', scope: 'PER_TICKET' },
      isActive: false,
    });
    expect(file.queue).toMatchObject({ mode: 'AUTO_THRESHOLD', activeSessionThreshold: 77 });
    expect(file.ticketTemplates).toHaveLength(1);
    expect(file.event.ticketTemplateKey).toBe(file.ticketTemplates[0]!.key);
    expect(file.emailTemplates).toHaveLength(1);
    expect(file.event.infoBoxes).toHaveLength(1);
    expect(file.symbols).toHaveLength(1);
    expect(file.images).toHaveLength(3);
    expect(file.seatPlan?.plan.seats).toHaveLength(3);
    expect(file.seatPlan?.categories.map((c) => c.name)).toEqual(['Premium', 'Standard']);
    const json = JSON.stringify(file);
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(json).not.toMatch(/old\.class|privateKey|shopSortOrder|publishedAt/);
  });

  it('round-trips into a new DRAFT event that exports to the same file', async () => {
    const db = handle.db;
    const first = await exportEvent(ctx, sourceEventId, { includeEmailTemplates: true });
    const result = await run(parseEventFile(JSON.stringify(first)));
    expect(result.slug).toBe('source-show-2');
    expect(result.warnings).toEqual([]);
    expect(result.seatPlan).toMatchObject({ seats: 3, categoriesCreated: 0, unassigned: 0 });

    const [copy] = await db.select().from(events).where(eq(events.id, result.eventId));
    const [source] = await db.select().from(events).where(eq(events.id, sourceEventId));
    expect(copy).toMatchObject({
      status: 'DRAFT',
      publishedAt: null,
      shopSortOrder: null,
      googleWalletClassId: null,
      hadTestOrders: false,
      clonedFromId: null,
      seriesId: null,
      venueId: venueA,
      title: 'Source Show',
      maxTicketsPerOrder: 6,
      paypalEnabled: false,
      seoNoindex: true,
      selfServiceMaxChanges: 0,
    });
    expect(copy!.id).not.toBe(sourceEventId);
    for (const key of ['startsAt', 'doorsOpenAt', 'endsAt', 'presaleStartsAt'] as const) {
      expect(copy![key]!.getTime()).toBe(source![key]!.getTime());
    }
    // fresh ids everywhere, fresh active key, one default tariff
    const [infoBox] = copy!.infoBoxes;
    expect(infoBox!.id).not.toBe(source!.infoBoxes[0]!.id);
    expect(JSON.stringify(copy!.pageLayout)).toContain(`box:${infoBox!.id}`);
    expect(copy!.seatMapId).not.toBe(source!.seatMapId);
    expect(copy!.heroImageAssetId).toBe(source!.heroImageAssetId);
    const keys = await db
      .select()
      .from(eventSigningKeys)
      .where(eq(eventSigningKeys.eventId, result.eventId));
    expect(keys).toMatchObject([{ status: 'ACTIVE' }]);

    // plan seats are assigned to the NEW event's categories
    const newCategories = await db
      .select()
      .from(priceCategories)
      .where(eq(priceCategories.eventId, result.eventId));
    expect(newCategories.map((c) => c.basePrice).sort()).toEqual([3000, 5000]);
    const planSeats = await db.select().from(seats).where(eq(seats.seatMapId, copy!.seatMapId!));
    expect(planSeats).toHaveLength(3);
    for (const s of planSeats) {
      expect(newCategories.map((c) => c.id)).toContain(s.priceCategoryId);
    }

    const second = await exportEvent(ctx, result.eventId, { includeEmailTemplates: true });
    expect(normalise(second)).toEqual(normalise(first));
    // images are shared, not duplicated
    const [assets] = await db.select({ n: count() }).from(mediaAssets);
    expect(assets!.n).toBe(3);
  });

  it('shifts the other dates to a new start and keeps local times', async () => {
    const file = await exportEvent(ctx, sourceEventId);
    const newStart = new Date(new Date(file.event.startsAt).getTime() + 100 * DAY);
    const { eventId } = await run(file, { startsAt: newStart, title: 'Next year' });
    const [copy] = await handle.db.select().from(events).where(eq(events.id, eventId));
    expect(copy!.startsAt.getTime()).toBe(newStart.getTime());
    expect(copy!.title).toBe('Next year');
    // title translation belonged to the old title
    expect(copy!.translations).toEqual({ de: { description: '<p>Hallo</p>' } });
    const delta =
      copy!.publicSaleStartsAt!.getTime() - new Date(file.event.publicSaleStartsAt!).getTime();
    expect(Math.abs(delta - 100 * DAY)).toBeLessThanOrEqual(3_600_000);
  });

  it('handles slugs: explicit conflicts are refused, invalid ones too', async () => {
    const file = await exportEvent(ctx, sourceEventId);
    expect(await failure(run(file, { slug: 'source-show' }))).toBe('SLUG_TAKEN');
    expect(await failure(run(file, { slug: 'Not A Slug' }))).toBe('INVALID_SLUG');
    const { slug } = await run(file, { slug: 'my-own-slug' });
    expect(slug).toBe('my-own-slug');
  });

  it('sanitises every HTML field and drops what the target cannot represent', async () => {
    const file = await exportEvent(ctx, sourceEventId, { includeEmailTemplates: true });
    const evil = '<script>alert(1)</script>';
    const tampered = JSON.parse(JSON.stringify(file)) as typeof file;
    tampered.event.description = `<p>ok</p>${evil}`;
    tampered.event.translations = { de: { description: `<p>x</p>${evil}` }, fr: { title: 'x' } };
    tampered.event.infoBoxes[0]!.content = `<p>b</p>${evil}`;
    tampered.event.infoBoxes[0]!.translations = { de: { content: `<p>c</p>${evil}`, bogus: 'x' } };
    tampered.emailTemplates[0]!.bodyHtml = `<p>m</p>${evil}<img src="javascript:alert(1)" onerror="x()">`;
    tampered.emailTemplates.push({ ...tampered.emailTemplates[0]!, locale: 'fr' });
    tampered.event.taxRate = { name: 'Unknown rate', rateBasisPoints: 500 };
    tampered.fees[0]!.overridesGlobal = { name: 'No such fee', scope: 'PER_TICKET' };
    const result = await run(tampered, { title: 'Tampered' });
    expect(result.warnings.map((w) => w.code).sort()).toEqual([
      'EMAIL_TEMPLATE_SKIPPED',
      'FEE_SKIPPED',
      'TAX_RATE_FALLBACK',
    ]);
    const [copy] = await handle.db.select().from(events).where(eq(events.id, result.eventId));
    expect(copy!.taxRateId).toBe(taxId);
    expect(JSON.stringify(copy)).not.toMatch(/<script|alert\(/);
    expect(copy!.translations).toEqual({ de: { description: '<p>x</p>' } });
    expect(copy!.infoBoxes[0]!.translations).toEqual({ de: { content: '<p>c</p>' } });
    const mails = await handle.db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.eventId, result.eventId));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.bodyHtml).not.toMatch(/script|alert|javascript|onerror/i);
    expect(
      await handle.db.select().from(fees).where(eq(fees.eventId, result.eventId)),
    ).toHaveLength(1);
  });

  it('exports and imports e-mail overrides only for the role that may edit templates', async () => {
    const plain = await exportEvent(ctx, sourceEventId);
    expect(plain.emailTemplates).toEqual([]);
    const full = await exportEvent(ctx, sourceEventId, { includeEmailTemplates: true });
    expect(full.emailTemplates).toHaveLength(1);
    const result = await run(full, { title: 'No mail rights', includeEmailTemplates: false });
    expect(result.warnings).toEqual([
      {
        code: 'EMAIL_TEMPLATE_SKIPPED',
        key: 'ORDER_CONFIRMATION_BANK_TRANSFER',
        locale: 'en',
        reason: 'role',
      },
    ]);
    const mails = await handle.db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.eventId, result.eventId));
    expect(mails).toHaveLength(0);
  });

  it('runs imported e-mail overrides through the editor validation', async () => {
    const file = await exportEvent(ctx, sourceEventId, { includeEmailTemplates: true });
    const base = file.emailTemplates[0]!;
    const tampered = JSON.parse(JSON.stringify(file)) as typeof file;
    tampered.emailTemplates = [
      { ...base, locale: 'en', subject: 'Line\r\nBreak {{firstName}}', bodyHtml: '<p>ok</p>' },
      { ...base, key: 'PAYMENT_REMINDER', locale: 'en', bodyHtml: '<p>{{#if firstName}}open</p>' },
      { ...base, key: 'ORDER_CANCELLED', locale: 'en', subject: ' \r\n ', bodyHtml: '<p>x</p>' },
    ];
    const result = await run(tampered, { title: 'Mail validation' });
    expect(
      result.warnings
        .filter((w) => w.code === 'EMAIL_TEMPLATE_SKIPPED')
        .map(
          (w) =>
            (w as { key: string; reason: string }).key + ':' + (w as { reason: string }).reason,
        )
        .sort(),
    ).toEqual(['ORDER_CANCELLED:invalid', 'PAYMENT_REMINDER:invalid']);
    const mails = await handle.db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.eventId, result.eventId));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe('Line Break {{firstName}}');
  });

  it('matches tax rates by name and rate among active rates, else falls back with a warning', async () => {
    const file = await exportEvent(ctx, sourceEventId);
    const sameName = JSON.parse(JSON.stringify(file)) as typeof file;
    sameName.event.taxRate = {
      ...file.event.taxRate,
      rateBasisPoints: file.event.taxRate.rateBasisPoints + 100,
    };
    const result = await run(sameName, { title: 'Other rate' });
    expect(result.warnings).toContainEqual({
      code: 'TAX_RATE_FALLBACK',
      name: file.event.taxRate.name,
    });

    // an archived rate is not matched either
    const [spare] = await handle.db
      .insert(taxRates)
      .values({ name: 'Spare rate', rateBasisPoints: 700 })
      .returning({ id: taxRates.id });
    await handle.db.update(taxRates).set({ archivedAt: new Date() }).where(eq(taxRates.id, taxId));
    try {
      const second = await run(file, { title: 'Archived rate' });
      expect(second.warnings.map((w) => w.code)).toContain('TAX_RATE_FALLBACK');
      const [copy] = await handle.db
        .select({ taxRateId: events.taxRateId })
        .from(events)
        .where(eq(events.id, second.eventId));
      expect(copy!.taxRateId).toBe(spare!.id);
    } finally {
      await handle.db.update(taxRates).set({ archivedAt: null }).where(eq(taxRates.id, taxId));
    }
  });

  it('creates nothing and removes uploaded images when the file cannot be imported', async () => {
    const db = handle.db;
    const file = await exportEvent(ctx, sourceEventId);
    const [{ n: eventsBefore }] = (await db.select({ n: count() }).from(events)) as [{ n: number }];
    const [{ n: assetsBefore }] = (await db.select({ n: count() }).from(mediaAssets)) as [
      { n: number },
    ];
    // a good new image first, then one that is no image at all
    const fresh = Buffer.from(await solidPng(50, 50, 99)).toString('base64');
    const broken = JSON.parse(JSON.stringify(file)) as typeof file;
    broken.images[0]!.dataBase64 = fresh;
    broken.images[1]!.dataBase64 = Buffer.from('this is not an image').toString('base64');
    expect(await failure(run(broken, { title: 'Broken' }))).toBe('MEDIA_UNSUPPORTED_TYPE');
    expect((await db.select({ n: count() }).from(events))[0]!.n).toBe(eventsBefore);
    expect((await db.select({ n: count() }).from(mediaAssets))[0]!.n).toBe(assetsBefore);

    expect(await failure(run(file, { venueId: randomUUID(), title: 'No venue' }))).toBe(
      'NOT_FOUND',
    );
    const bad = JSON.parse(JSON.stringify(file)) as typeof file;
    bad.event.endsAt = bad.event.startsAt;
    expect(await failure(run(bad))).toMatch(/^OTHER:/); // schema violation (ZodError), nothing stored
    expect((await db.select({ n: count() }).from(events))[0]!.n).toBe(eventsBefore);
  });

  it('imports a minimal event (no plan, no tariffs) with a default tariff', async () => {
    const minimal = parseEventFile(
      JSON.stringify({
        format: 'tix-event',
        version: 1,
        exportedAt: '',
        source: { appVersion: 'x' },
        event: {
          title: 'Bare',
          timeZone: 'Europe/Berlin',
          currency: 'EUR',
          taxRate: { name: 'VAT 19', rateBasisPoints: 1900 },
          startsAt: '2030-01-01T18:00:00.000Z',
        },
      }),
    );
    const { eventId } = await run(minimal);
    const [copy] = await handle.db.select().from(events).where(eq(events.id, eventId));
    expect(copy).toMatchObject({ status: 'DRAFT', seatMapId: null });
    const types = await handle.db
      .select()
      .from(ticketTypes)
      .where(eq(ticketTypes.eventId, eventId));
    expect(types).toMatchObject([{ name: 'Standard', isDefault: true }]);
  });

  describe('seat plan replacement', () => {
    const draft = async (title: string) => {
      const file = await exportEvent(ctx, sourceEventId);
      const { eventId } = await run(file, { title });
      const [event] = await handle.db.select().from(events).where(eq(events.id, eventId));
      return event!;
    };
    const categoryNames = async (eventId: string) =>
      (await handle.db.select().from(priceCategories).where(eq(priceCategories.eventId, eventId)))
        .map((c) => `${c.name}:${c.basePrice}`)
        .sort();

    it('copies another plan of the venue, mapping categories by name', async () => {
      const event = await draft('Replace by template');
      const other = await makeTemplate(venueA, 'Second hall', ['Premium', 'Balcony']);
      const oldMapId = event.seatMapId!;
      const [old] = await handle.db.select().from(seatMaps).where(eq(seatMaps.id, oldMapId));
      const result = await replaceEventSeatPlan(ctx, {
        eventId: event.id,
        source: { kind: 'template', seatMapId: other },
        userId: null,
      });
      expect(result).toMatchObject({
        categoriesReused: 1,
        categoriesCreated: 1,
        unassignedSeats: 0,
      });
      const [after] = await handle.db.select().from(events).where(eq(events.id, event.id));
      expect(after!.seatMapId).toBe(result.seatMapId);
      expect(after!.seatMapId).not.toBe(oldMapId);
      // the old copy is gone with everything in it
      expect(await handle.db.select().from(seatMaps).where(eq(seatMaps.id, oldMapId))).toHaveLength(
        0,
      );
      expect(
        await handle.db.select().from(seats).where(eq(seats.seatMapId, oldMapId)),
      ).toHaveLength(0);
      const [map] = await handle.db
        .select()
        .from(seatMaps)
        .where(eq(seatMaps.id, result.seatMapId));
      expect(map).toMatchObject({ kind: 'EVENT', clonedFromId: other });
      expect(map!.version).toBeGreaterThan(old!.version);
      // Premium keeps its price, Standard stays (unused), Balcony is new and unpriced
      expect(await categoryNames(event.id)).toEqual(['Balcony:0', 'Premium:5000', 'Standard:3000']);
      // a new category is not sellable at 0 until the admin prices and activates it
      const [balcony] = await handle.db
        .select()
        .from(priceCategories)
        .where(and(eq(priceCategories.eventId, event.id), eq(priceCategories.name, 'Balcony')));
      expect(balcony!.isActive).toBe(false);
      const planSeats = await handle.db
        .select()
        .from(seats)
        .where(eq(seats.seatMapId, result.seatMapId));
      expect(planSeats.every((s) => s.priceCategoryId !== null)).toBe(true);
    });

    it('reports cleared scanner entrances, audits inside the transaction and locks the old plan', async () => {
      const event = await draft('Replace scanner');
      const [entrance] = await handle.db
        .insert(seatMapEntrances)
        .values({ seatMapId: event.seatMapId!, name: 'Main', code: 'M', x: 1, y: 1 })
        .returning({ id: seatMapEntrances.id });
      const [device] = await handle.db
        .insert(scannerDevices)
        .values({ name: 'Door 1', tokenHash: randomUUID(), tokenPrefix: 'abcd' })
        .returning({ id: scannerDevices.id });
      await handle.db
        .insert(scannerDeviceEvents)
        .values({ deviceId: device!.id, eventId: event.id, entranceId: entrance!.id });
      const seen: string[] = [];
      const result = await replaceEventSeatPlan(ctx, {
        eventId: event.id,
        source: { kind: 'template', seatMapId: templateA },
        userId: null,
        audit: async (tx, r) => {
          // runs in the swap's transaction: the new plan is already visible there
          const [row] = await tx.select().from(seatMaps).where(eq(seatMaps.id, r.seatMapId));
          seen.push(row ? 'visible' : 'missing');
        },
      });
      expect(result.scannerEntrancesCleared).toBe(1);
      expect(seen).toEqual(['visible']);
      const [assignment] = await handle.db
        .select()
        .from(scannerDeviceEvents)
        .where(eq(scannerDeviceEvents.deviceId, device!.id));
      expect(assignment!.entranceId).toBeNull();
    });

    it('rolls back the swap when the audit callback fails', async () => {
      const event = await draft('Replace audit failure');
      await expect(
        replaceEventSeatPlan(ctx, {
          eventId: event.id,
          source: { kind: 'template', seatMapId: templateA },
          userId: null,
          audit: async () => {
            throw new Error('audit down');
          },
        }),
      ).rejects.toThrow('audit down');
      const [after] = await handle.db.select().from(events).where(eq(events.id, event.id));
      expect(after!.seatMapId).toBe(event.seatMapId);
    });

    it('imports a plan file into the event (no master plan is created)', async () => {
      const event = await draft('Replace by file');
      const mastersBefore = (
        await handle.db.select({ n: count() }).from(seatMaps).where(eq(seatMaps.kind, 'TEMPLATE'))
      )[0]!.n;
      const file = await exportSeatMap(ctx, templateA);
      const result = await replaceEventSeatPlan(ctx, {
        eventId: event.id,
        source: { kind: 'file', file },
        userId: null,
      });
      expect(result).toMatchObject({
        categoriesReused: 2,
        categoriesCreated: 0,
        unassignedSeats: 0,
      });
      const [after] = await handle.db.select().from(events).where(eq(events.id, event.id));
      expect(after!.seatMapId).toBe(result.seatMapId);
      expect(
        (
          await handle.db.select({ n: count() }).from(seatMaps).where(eq(seatMaps.kind, 'TEMPLATE'))
        )[0]!.n,
      ).toBe(mastersBefore);
      expect(await categoryNames(event.id)).toEqual(['Premium:5000', 'Standard:3000']);
    });

    it('keeps seats without a matching category unassigned', async () => {
      const event = await draft('Replace unassigned');
      const file = await exportSeatMap(ctx, templateA);
      file.categories = [];
      file.plan.seats = file.plan.seats.map((s) => ({ ...s, categoryKey: null }));
      file.plan.sections = file.plan.sections.map((s) => ({ ...s, categoryKey: null }));
      const result = await replaceEventSeatPlan(ctx, {
        eventId: event.id,
        source: { kind: 'file', file },
        userId: null,
      });
      expect(result.unassignedSeats).toBe(3);
    });

    it('refuses a plan of another venue, a non-draft event and unknown plans', async () => {
      const event = await draft('Replace guards');
      expect(
        await failure(
          replaceEventSeatPlan(ctx, {
            eventId: event.id,
            source: { kind: 'template', seatMapId: templateOther },
            userId: null,
          }),
        ),
      ).toBe('TEMPLATE_MISMATCH');
      expect(
        await failure(
          replaceEventSeatPlan(ctx, {
            eventId: event.id,
            source: { kind: 'template', seatMapId: randomUUID() },
            userId: null,
          }),
        ),
      ).toBe('NOT_FOUND');
      // a plan that belongs to an event is not a master plan
      expect(
        await failure(
          replaceEventSeatPlan(ctx, {
            eventId: event.id,
            source: { kind: 'template', seatMapId: event.seatMapId! },
            userId: null,
          }),
        ),
      ).toBe('NOT_FOUND');
      expect(
        await failure(
          replaceEventSeatPlan(ctx, {
            eventId: sourceEventId, // PUBLISHED
            source: { kind: 'template', seatMapId: templateA },
            userId: null,
          }),
        ),
      ).toBe('EVENT_NOT_DRAFT');
      expect(
        await failure(
          replaceEventSeatPlan(ctx, {
            eventId: randomUUID(),
            source: { kind: 'template', seatMapId: templateA },
            userId: null,
          }),
        ),
      ).toBe('EVENT_NOT_FOUND');
      const [after] = await handle.db.select().from(events).where(eq(events.id, event.id));
      expect(after!.seatMapId).toBe(event.seatMapId);
    });

    it('refuses when an order item references the event (any status) and leaves the plan alone', async () => {
      const event = await draft('Replace with orders');
      const [order] = await handle.db
        .insert(orders)
        .values({
          orderNumber: `T-${randomUUID().slice(0, 8)}`,
          channel: 'BOX_OFFICE',
          firstName: 'A',
          lastName: 'B',
          locale: 'en',
          currency: 'EUR',
          status: 'CANCELLED',
          cancelledAt: new Date(),
          paymentMethod: 'CASH',
          subtotalGross: 1000,
          totalGross: 1000,
          totalNet: 934,
          totalTax: 66,
        })
        .returning();
      const [seat] = await handle.db
        .select()
        .from(seats)
        .where(eq(seats.seatMapId, event.seatMapId!))
        .limit(1);
      const [category] = await handle.db
        .select()
        .from(priceCategories)
        .where(eq(priceCategories.eventId, event.id))
        .limit(1);
      const [tariff] = await handle.db
        .select()
        .from(ticketTypes)
        .where(eq(ticketTypes.eventId, event.id))
        .limit(1);
      await handle.db.insert(orderItems).values({
        orderId: order!.id,
        eventId: event.id,
        kind: 'SEAT',
        seatId: seat!.id,
        sectionId: seat!.sectionId,
        priceCategoryId: category!.id,
        ticketTypeId: tariff!.id,
        status: 'CANCELLED',
        sectionLabel: 'Parkett',
        categoryName: 'Premium',
        ticketTypeName: 'Normal',
        unitPriceGross: 1000,
        priceGross: 1000,
        taxRateBasisPoints: 700,
        priceNet: 934,
        taxAmount: 66,
      });
      const before = await handle.db
        .select()
        .from(seats)
        .where(eq(seats.seatMapId, event.seatMapId!));
      expect(
        await failure(
          replaceEventSeatPlan(ctx, {
            eventId: event.id,
            source: { kind: 'template', seatMapId: templateA },
            userId: null,
          }),
        ),
      ).toBe('SEAT_PLAN_IN_USE');
      const [after] = await handle.db.select().from(events).where(eq(events.id, event.id));
      expect(after!.seatMapId).toBe(event.seatMapId);
      expect(
        await handle.db.select().from(seats).where(eq(seats.seatMapId, event.seatMapId!)),
      ).toHaveLength(before.length);
    });

    it('refuses while seats are held in carts', async () => {
      const event = await draft('Replace with holds');
      const key = ctx.keys.seatLockExpiries(event.id);
      await redis.zadd(key, Date.now() + 60_000, randomUUID());
      expect(
        await failure(
          replaceEventSeatPlan(ctx, {
            eventId: event.id,
            source: { kind: 'template', seatMapId: templateA },
            userId: null,
          }),
        ),
      ).toBe('SEAT_PLAN_HAS_HOLDS');
      await redis.del(key);
      await replaceEventSeatPlan(ctx, {
        eventId: event.id,
        source: { kind: 'template', seatMapId: templateA },
        userId: null,
      });
    });

    it('rolls back completely when a plan file cannot be imported', async () => {
      const event = await draft('Replace broken');
      const assetsBefore = (await handle.db.select({ n: count() }).from(mediaAssets))[0]!.n;
      const file = await exportSeatMap(ctx, templateA);
      file.background = {
        fileName: 'x.png',
        contentType: 'image/png',
        width: null,
        height: null,
        dataBase64: Buffer.from('nope').toString('base64'),
      };
      expect(
        await failure(
          replaceEventSeatPlan(ctx, {
            eventId: event.id,
            source: { kind: 'file', file },
            userId: null,
          }),
        ),
      ).toBe('MEDIA_UNSUPPORTED_TYPE');
      const [after] = await handle.db.select().from(events).where(eq(events.id, event.id));
      expect(after!.seatMapId).toBe(event.seatMapId);
      expect((await handle.db.select({ n: count() }).from(mediaAssets))[0]!.n).toBe(assetsBefore);
    });
  });
});
