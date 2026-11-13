/**
 * Content translations against real PostgreSQL + Redis (throw-away database): resolution in the
 * public plan / cart / checkout snapshots / order documents, per-locale saving, copying through
 * event duplication and plan export / import.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  bankAccounts,
  createDb,
  events,
  fees,
  loadRootEnv,
  orderFees,
  orderItems,
  orders,
  priceCategories,
  priceCategoryTicketTypes,
  queueConfigs,
  seatMapEntrances,
  seatMapSections,
  seatMaps,
  taxRates,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { seedReferenceData } from '@tix/db/seed';
import {
  checkoutInputSchema,
  type CheckoutInput,
  type EventInfoBox,
  type SeatMapDocumentInput,
} from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { withTransaction } from '@tix/db';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addSeats,
  applyTemplateCategoriesToEvent,
  cloneSeatMap,
  loadGlobalTranslationItems,
  saveGlobalTranslations,
  afterSeatMapSaved,
  createCoreContext,
  duplicateEvent,
  effectiveQueueConfig,
  enterShop,
  eventTranslationCompleteness,
  exportSeatMap,
  getCart,
  getEventById,
  getLocalizedPublicSeatMap,
  getOrderView,
  importSeatMap,
  loadOrderDocumentData,
  loadSeatMapDocument,
  loadTranslationItems,
  parseSeatMapFile,
  placeOrder,
  renderEmail,
  saveSeatMapDocument,
  saveSetting,
  saveTranslations,
  type CoreContext,
  type EventRow,
  type JobQueues,
  type ObjectStorage,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();

const sanitize = (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, '').trim();

describe.skipIf(!adminUrl || !redisUrl)('content translations (integration)', () => {
  const dbName = `tix_i18n_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let event: EventRow;
  let venueId: string;
  let mapId: string;
  let categoryId: string;
  let typeId: string;
  let sectionId: string;
  let seatIds: string[] = [];
  let boxId: string;
  let globalFeeId: string;
  const jobs = { add: vi.fn(async () => undefined), close: async () => {} };

  const buyer = (locale: string, total: number, email: string): CheckoutInput =>
    checkoutInputSchema.parse({
      method: 'BANK_TRANSFER',
      email,
      firstName: 'Erika',
      lastName: 'Example',
      phone: '+49 6134 123456',
      address: { street: 'Hauptstrasse 1', postalCode: '65462', city: 'Ginsheim', country: 'DE' },
      acceptTerms: true,
      expectedTotalGross: total,
      locale,
    });

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
      appUrl: 'https://shop.example.org/',
      secrets: createSecretBox(parseKeyRing(generateKeyRingEntry())),
      jobs: jobs as unknown as JobQueues,
      storage: {
        put: async () => undefined,
        get: async () => ({ body: new Uint8Array(), contentType: undefined }),
        delete: async () => undefined,
      } as unknown as ObjectStorage,
    });
    const db = handle.db;
    // The shop's base language is German; English is the translation language.
    await seedReferenceData(db, () => {});
    await saveSetting(ctx, 'general', { defaultLocale: 'de' }, null);

    const [venue] = await db
      .insert(venues)
      .values({
        name: 'Stadthalle',
        slug: `hall-${uuid().slice(0, 6)}`,
        timeZone: 'Europe/Berlin',
        translations: { en: { name: 'City Hall' } },
      })
      .returning();
    venueId = venue!.id;
    const [map] = await db
      .insert(seatMaps)
      .values({ venueId, kind: 'EVENT', name: 'Hall', canvasWidth: 800, canvasHeight: 600 })
      .returning();
    mapId = map!.id;
    const [tax] = await db
      .insert(taxRates)
      .values({ name: `vat-${uuid().slice(0, 6)}`, rateBasisPoints: 1900 })
      .returning();
    boxId = uuid();
    const infoBoxes: EventInfoBox[] = [
      {
        id: boxId,
        title: 'Barrierefrei',
        symbolId: null,
        content: '<p>Rollstuhlplätze vorhanden</p>',
        translations: { en: { title: 'Accessible', content: '<p>Wheelchair spaces</p>' } },
      },
    ];
    const [ev] = await db
      .insert(events)
      .values({
        venueId,
        seatMapId: mapId,
        slug: `show-${uuid().slice(0, 6)}`,
        title: 'Galaabend',
        subtitle: 'Mit Orchester',
        description: '<p>Beschreibung</p>',
        translations: { en: { title: 'Gala night', subtitle: 'With orchestra' } },
        infoBoxes,
        status: 'PUBLISHED',
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: tax!.id,
        orphanSeatRuleEnabled: false,
      })
      .returning();
    const [category] = await db
      .insert(priceCategories)
      .values({
        eventId: ev!.id,
        name: 'Kategorie 1',
        color: '#336699',
        basePrice: 3000,
        translations: { en: { name: 'Category 1' } },
      })
      .returning();
    categoryId = category!.id;
    const [normal] = await db
      .insert(ticketTypes)
      .values({
        eventId: ev!.id,
        name: 'Normalpreis',
        isDefault: true,
        translations: { en: { name: 'Standard' } },
      })
      .returning();
    typeId = normal!.id;
    await db
      .insert(priceCategoryTicketTypes)
      .values({ priceCategoryId: categoryId, ticketTypeId: typeId });
    const [globalFee] = await db
      .insert(fees)
      .values({
        name: 'Servicegebühr',
        scope: 'PER_TICKET',
        calculation: 'FIXED',
        value: 150,
        translations: { en: { name: 'Service fee' } },
      })
      .returning();
    globalFeeId = globalFee!.id;
    await db.insert(bankAccounts).values({
      name: 'Main',
      accountHolder: 'Example e.V.',
      iban: 'DE89370400440532013000',
      currency: 'EUR',
      isDefaultForBankTransfer: true,
    });
    await db.insert(queueConfigs).values({
      eventId: ev!.id,
      activeSessionThreshold: 100,
      admissionBatchSize: 10,
      admissionIntervalSeconds: 30,
      passTokenTtlSeconds: 900,
      title: 'Warteraum',
      message: 'Bitte warten',
      translations: { en: { title: 'Waiting room', message: 'Please wait' } },
    });

    sectionId = uuid();
    const rowId = uuid();
    const entranceId = uuid();
    const doc: SeatMapDocumentInput = {
      version: 1,
      name: 'Hall',
      canvasWidth: 800,
      canvasHeight: 600,
      settings: {
        wheelchairLabel: { mode: 'TEXT', text: 'R' },
        translations: { en: { wheelchairLabelText: 'W' } },
      },
      entrances: [
        {
          id: entranceId,
          name: 'Haupteingang',
          code: 'A',
          x: 10,
          y: 10,
          translations: { en: { name: 'Main entrance' } },
        },
      ],
      sections: [
        {
          id: sectionId,
          type: 'SEATED',
          name: 'Parkett',
          ticketLabel: 'Parkett links',
          geometry: { type: 'rect', x: 0, y: 0, width: 400, height: 100 },
          translations: { en: { name: 'Stalls', ticketLabel: 'Stalls left' } },
        },
      ],
      rows: [
        {
          id: rowId,
          sectionId,
          label: 'A',
          sortOrder: 1,
          geometry: {
            curve: { type: 'straight', start: { x: 20, y: 20 }, end: { x: 300, y: 20 } },
            seatSpacing: 30,
          },
        },
      ],
      elements: [
        {
          id: uuid(),
          type: 'STAGE',
          label: 'Bühne',
          geometry: { type: 'rect', x: 0, y: 300, width: 200, height: 50 },
          translations: { en: { label: 'Stage' } },
        },
      ],
      seats: Array.from({ length: 4 }, (_, i) => ({
        id: uuid(),
        sectionId,
        rowId,
        label: String(i + 1),
        position: i + 1,
        x: 20 + i * 30,
        y: 20,
        priceCategoryId: categoryId,
      })),
    };
    const saved = await saveSeatMapDocument(db, mapId, doc, null);
    expect(saved.ok).toBe(true);
    if (saved.ok) await afterSeatMapSaved(ctx, saved);
    seatIds = doc.seats!.map((s) => s.id!);
    event = await getEventById(ctx, ev!.id);
  });

  afterAll(async () => {
    await handle?.close();
    if (redis) {
      const keys = await redis.keys(`${ctx.keys.prefix}:*`);
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('serves the public plan in the requested language from one shared snapshot', async () => {
    const en = await getLocalizedPublicSeatMap(ctx, event, 'en');
    expect(en.categories[0]!.name).toBe('Category 1');
    expect(en.ticketTypes[0]!.name).toBe('Standard');
    expect(en.sections[0]).toMatchObject({ name: 'Stalls', ticketLabel: 'Stalls left' });
    expect(en.elements.find((e) => e.type === 'STAGE')!.label).toBe('Stage');
    expect(en.entrances[0]!.name).toBe('Main entrance');
    expect(en.settings.wheelchairLabel?.text).toBe('W');
    const de = await getLocalizedPublicSeatMap(ctx, event, 'de');
    expect(de.categories[0]!.name).toBe('Kategorie 1');
    expect(de.sections[0]!.name).toBe('Parkett');
    expect(de.settings.wheelchairLabel?.text).toBe('R');
    // Unknown language → base text.
    expect((await getLocalizedPublicSeatMap(ctx, event, 'fr')).sections[0]!.name).toBe('Parkett');
    expect((await getLocalizedPublicSeatMap(ctx, event)).sections[0]!.name).toBe('Parkett');
  });

  it('resolves the waiting room config translations next to the base text', async () => {
    const queue = await effectiveQueueConfig(ctx, event.id);
    expect(queue.title).toBe('Warteraum');
    expect(queue.translations.en).toEqual({ title: 'Waiting room', message: 'Please wait' });
  });

  it('shows cart names in the requested language and snapshots them in the order locale', async () => {
    const session = `k${uuid().slice(0, 8)}`;
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, [seatIds[0]!]);
    const cartEn = await getCart(ctx, session, 'en');
    expect(cartEn.events[0]!.title).toBe('Gala night');
    expect(cartEn.events[0]!.venueName).toBe('City Hall');
    expect(cartEn.events[0]!.items[0]).toMatchObject({
      sectionLabel: 'Stalls left',
      categoryName: 'Category 1',
    });
    const cartDe = await getCart(ctx, session, 'de');
    expect(cartDe.events[0]!.title).toBe('Galaabend');
    expect(cartDe.events[0]!.items[0]).toMatchObject({
      sectionLabel: 'Parkett links',
      categoryName: 'Kategorie 1',
    });

    const placed = await placeOrder(ctx, {
      sessionId: session,
      input: buyer('en', 3000 + 150, 'en@example.invalid'),
    });
    const [item] = await handle.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, placed.orderId));
    expect(item).toMatchObject({
      sectionLabel: 'Stalls left',
      categoryName: 'Category 1',
      ticketTypeName: 'Standard',
    });
    const feeRows = await handle.db
      .select()
      .from(orderFees)
      .where(eq(orderFees.orderId, placed.orderId));
    expect(feeRows.map((f) => f.name)).toEqual(['Service fee']);

    // Documents + order view follow the order locale.
    const data = await loadOrderDocumentData(handle.db, placed.orderId);
    expect(data!.events[0]).toMatchObject({ title: 'Gala night', venueName: 'City Hall' });
    expect(data!.events[0]!.subtitle).toBe('With orchestra');
    const view = await getOrderView(ctx, placed.orderId);
    expect(view!.events[0]).toMatchObject({ title: 'Gala night', venueName: 'City Hall' });

    // E-mails of the order show the English event / venue / item texts.
    const mail = await renderEmail(ctx, {
      key: 'ORDER_CONFIRMATION_BANK_TRANSFER',
      orderId: placed.orderId,
    });
    expect(mail.locale).toBe('en');
    expect(mail.html).toContain('Gala night');
    expect(mail.html).not.toContain('Galaabend');

    // A German order stays German (and old snapshots are never rewritten).
    const session2 = `k${uuid().slice(0, 8)}`;
    await enterShop(ctx, event, session2);
    await addSeats(ctx, session2, event, [seatIds[1]!]);
    const placedDe = await placeOrder(ctx, {
      sessionId: session2,
      input: buyer('de', 3150, 'de@example.invalid'),
    });
    const [itemDe] = await handle.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, placedDe.orderId));
    expect(itemDe).toMatchObject({ sectionLabel: 'Parkett links', categoryName: 'Kategorie 1' });
    expect((await loadOrderDocumentData(handle.db, placedDe.orderId))!.events[0]!.title).toBe(
      'Galaabend',
    );
    const [orderRow] = await handle.db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(orderRow!.locale).toBe('en');
  });

  it('saves one locale without touching other locales or base texts', async () => {
    // A foreign locale entry (legacy data) must survive saves for English.
    await handle.db
      .update(priceCategories)
      .set({ translations: { en: { name: 'Category 1' }, fr: { name: 'Catégorie 1' } } as never })
      .where(eq(priceCategories.id, categoryId));
    await saveTranslations(ctx, {
      eventId: event.id,
      scope: 'pricing',
      locale: 'en',
      sanitizeRich: sanitize,
      updates: [
        {
          entity: 'priceCategory',
          id: categoryId,
          fields: { name: 'First category', description: '' },
        },
        { entity: 'ticketType', id: typeId, fields: { name: 'Regular' } },
      ],
    });
    const [category] = await handle.db
      .select()
      .from(priceCategories)
      .where(eq(priceCategories.id, categoryId));
    expect(category).toMatchObject({ name: 'Kategorie 1', basePrice: 3000, color: '#336699' });
    expect(category!.translations).toEqual({
      en: { name: 'First category' },
      fr: { name: 'Catégorie 1' },
    });
    // Public plan reflects the change immediately (snapshot invalidated).
    expect((await getLocalizedPublicSeatMap(ctx, event, 'en')).categories[0]!.name).toBe(
      'First category',
    );
    expect((await getLocalizedPublicSeatMap(ctx, event, 'de')).categories[0]!.name).toBe(
      'Kategorie 1',
    );

    // A blank value removes the translation again (shop falls back to the base text).
    await saveTranslations(ctx, {
      eventId: event.id,
      scope: 'pricing',
      locale: 'en',
      sanitizeRich: sanitize,
      updates: [{ entity: 'priceCategory', id: categoryId, fields: { name: '  ' } }],
    });
    const [cleared] = await handle.db
      .select()
      .from(priceCategories)
      .where(eq(priceCategories.id, categoryId));
    expect(cleared!.translations).toEqual({ fr: { name: 'Catégorie 1' } });
    await handle.db
      .update(priceCategories)
      .set({ translations: { en: { name: 'Category 1' } } })
      .where(eq(priceCategories.id, categoryId));
  });

  it('sanitises translated rich text with the supplied sanitiser and merges info boxes', async () => {
    await saveTranslations(ctx, {
      eventId: event.id,
      scope: 'event',
      locale: 'en',
      sanitizeRich: sanitize,
      updates: [
        {
          entity: 'event',
          id: event.id,
          fields: { description: '<p>Hello</p><script>alert(1)</script>', title: 'Gala night' },
        },
      ],
    });
    await saveTranslations(ctx, {
      eventId: event.id,
      scope: 'shopPage',
      locale: 'en',
      sanitizeRich: sanitize,
      updates: [
        {
          entity: 'infoBox',
          id: boxId,
          fields: { content: '<p>Spaces</p><script>x()</script>' },
        },
      ],
    });
    const fresh = await getEventById(ctx, event.id);
    expect(fresh.translations.en).toEqual({
      title: 'Gala night',
      subtitle: 'With orchestra',
      description: '<p>Hello</p>',
    });
    expect(fresh.title).toBe('Galaabend');
    expect(fresh.infoBoxes[0]!.translations!.en).toEqual({
      title: 'Accessible',
      content: '<p>Spaces</p>',
    });
    expect(fresh.infoBoxes[0]).toMatchObject({ title: 'Barrierefrei' });
  });

  it('rejects the default language, wrong scope and rows of other events', async () => {
    const base = { eventId: event.id, sanitizeRich: sanitize };
    await expect(
      saveTranslations(ctx, {
        ...base,
        scope: 'pricing',
        locale: 'de',
        updates: [{ entity: 'priceCategory', id: categoryId, fields: { name: 'x' } }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_LOCALE' });
    await expect(
      saveTranslations(ctx, {
        ...base,
        scope: 'pricing',
        locale: 'en',
        updates: [{ entity: 'event', id: event.id, fields: { title: 'x' } }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ENTITY' });
    await expect(
      saveTranslations(ctx, {
        ...base,
        scope: 'pricing',
        locale: 'en',
        updates: [{ entity: 'priceCategory', id: uuid(), fields: { name: 'x' } }],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      saveTranslations(ctx, {
        ...base,
        scope: 'pricing',
        locale: 'en',
        updates: [{ entity: 'priceCategory', id: categoryId, fields: { name: 'y'.repeat(200) } }],
      }),
    ).rejects.toMatchObject({ code: 'TRANSLATION_TOO_LONG' });
  });

  it('the event fees scope cannot write global fees (finance-only); they are read-only there', async () => {
    await expect(
      saveTranslations(ctx, {
        eventId: event.id,
        sanitizeRich: sanitize,
        scope: 'fees',
        locale: 'en',
        updates: [{ entity: 'fee', id: globalFeeId, fields: { name: 'Hacked' } }],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const groups = await loadTranslationItems(ctx, event.id, 'fees', 'en');
    expect(groups.find((g) => g.key === 'globalFees')?.readOnly).toBe(true);
  });

  it('loads the translation view per tab and reports completeness', async () => {
    const groups = await loadTranslationItems(ctx, event.id, 'fees', 'en');
    const globalFee = groups.flatMap((g) => g.items).find((i) => i.id === globalFeeId)!;
    expect(globalFee.fields[0]).toMatchObject({
      name: 'name',
      base: 'Servicegebühr',
      value: 'Service fee',
    });
    const completeness = await eventTranslationCompleteness(ctx, event.id);
    expect(completeness.en!.total).toBeGreaterThan(5);
    expect(completeness.en!.done).toBeGreaterThan(5);
    expect(completeness.en!.done).toBeLessThanOrEqual(completeness.en!.total);
    expect(completeness.de).toBeUndefined();
  });

  it('keeps translations when the event is duplicated (title translations are dropped)', async () => {
    const copy = await duplicateEvent(ctx, {
      sourceEventId: event.id,
      title: 'Galaabend II',
      startsAt: new Date(Date.now() + 60 * 86_400_000),
      userId: null as never,
    });
    const [copied] = await handle.db.select().from(events).where(eq(events.id, copy.eventId));
    expect(copied!.translations.en).toEqual({
      subtitle: 'With orchestra',
      description: '<p>Hello</p>',
    });
    expect(copied!.infoBoxes[0]!.translations!.en!.title).toBe('Accessible');
    const [cat] = await handle.db
      .select()
      .from(priceCategories)
      .where(eq(priceCategories.eventId, copy.eventId));
    expect(cat!.translations.en!.name).toBe('Category 1');
    const [queue] = await handle.db
      .select()
      .from(queueConfigs)
      .where(eq(queueConfigs.eventId, copy.eventId));
    expect(queue!.translations.en!.message).toBe('Please wait');
    const [section] = await handle.db
      .select()
      .from(seatMapSections)
      .where(eq(seatMapSections.seatMapId, copied!.seatMapId!));
    expect(section!.translations.en).toEqual({ name: 'Stalls', ticketLabel: 'Stalls left' });
    const [entrance] = await handle.db
      .select()
      .from(seatMapEntrances)
      .where(eq(seatMapEntrances.seatMapId, copied!.seatMapId!));
    expect(entrance!.translations.en!.name).toBe('Main entrance');
    const [map] = await handle.db
      .select()
      .from(seatMaps)
      .where(eq(seatMaps.id, copied!.seatMapId!));
    expect(map!.settings.translations?.en?.wheelchairLabelText).toBe('W');
  });

  it('keeps translations through a base-language plan save (editor round trip)', async () => {
    const doc = await loadSeatMapDocument(handle.db, mapId);
    expect(doc!.sections[0]!.translations.en!.name).toBe('Stalls');
    const renamed = {
      ...doc!,
      sections: doc!.sections.map((s) => ({ ...s, name: 'Parkett neu' })),
    };
    const saved = await saveSeatMapDocument(handle.db, mapId, renamed, null);
    expect(saved.ok).toBe(true);
    const after = await loadSeatMapDocument(handle.db, mapId);
    expect(after!.sections[0]).toMatchObject({ name: 'Parkett neu' });
    expect(after!.sections[0]!.translations.en).toEqual({
      name: 'Stalls',
      ticketLabel: 'Stalls left',
    });
    // Settings translations the editor did not send are kept.
    const noTr = { ...after!, settings: { ...after!.settings, translations: undefined } };
    const saved2 = await saveSeatMapDocument(handle.db, mapId, noTr, null);
    expect(saved2.ok).toBe(true);
    expect((await loadSeatMapDocument(handle.db, mapId))!.settings.translations?.en).toEqual({
      wheelchairLabelText: 'W',
    });
  });

  it('exports plan translations (file version 2), re-imports them and still reads version 1', async () => {
    const file = await exportSeatMap(ctx, mapId);
    expect(file.version).toBe(2);
    expect(file.plan.sections[0]!.translations.en!.name).toBe('Stalls');
    expect(file.plan.elements[0]!.translations.en!.label).toBe('Stage');
    expect(file.plan.entrances[0]!.translations.en!.name).toBe('Main entrance');
    expect(file.plan.settings.translations?.en?.wheelchairLabelText).toBe('W');

    const imported = await importSeatMap(ctx, { venueId, file, userId: null });
    const doc = await loadSeatMapDocument(handle.db, imported.seatMapId);
    expect(doc!.sections[0]!.translations.en!.ticketLabel).toBe('Stalls left');
    expect(doc!.elements[0]!.translations.en!.label).toBe('Stage');
    expect(doc!.entrances[0]!.translations.en!.name).toBe('Main entrance');
    expect(doc!.settings.translations?.en?.wheelchairLabelText).toBe('W');

    // A version 1 file (no translations anywhere) imports with empty translations.
    const v1 = JSON.parse(JSON.stringify(file)) as Record<string, unknown> & {
      version: number;
      plan: {
        settings: Record<string, unknown>;
        sections: Record<string, unknown>[];
        elements: Record<string, unknown>[];
        entrances: Record<string, unknown>[];
      };
    };
    v1.version = 1;
    delete v1.plan.settings.translations;
    for (const list of [v1.plan.sections, v1.plan.elements, v1.plan.entrances]) {
      for (const item of list) delete item.translations;
    }
    const parsed = parseSeatMapFile(JSON.stringify(v1));
    const importedV1 = await importSeatMap(ctx, { venueId, file: parsed, userId: null });
    const docV1 = await loadSeatMapDocument(handle.db, importedV1.seatMapId);
    expect(docV1!.sections[0]!.translations).toEqual({});
    expect(() => parseSeatMapFile(JSON.stringify({ ...v1, version: 3 }))).toThrow();
  });
  it('translates global fees and the global waiting room without touching base texts', async () => {
    await saveGlobalTranslations(ctx, {
      scope: 'globalFees',
      locale: 'en',
      sanitizeRich: sanitize,
      updates: [{ entity: 'fee', id: globalFeeId, fields: { name: 'Booking fee' } }],
    });
    const [fee] = await handle.db.select().from(fees).where(eq(fees.id, globalFeeId));
    expect(fee).toMatchObject({ name: 'Servicegebühr', value: 150 });
    expect(fee!.translations.en).toEqual({ name: 'Booking fee' });
    const items = await loadGlobalTranslationItems(ctx, 'globalFees', 'en');
    expect(items[0]!.items[0]!.fields[0]!.value).toBe('Booking fee');
    // Event-level rows cannot be saved through the global scope.
    await expect(
      saveGlobalTranslations(ctx, {
        scope: 'globalFees',
        locale: 'en',
        sanitizeRich: sanitize,
        updates: [{ entity: 'priceCategory', id: categoryId, fields: { name: 'x' } }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ENTITY' });
    // The seeded global waiting room config can be translated as well.
    const queue = (await loadGlobalTranslationItems(ctx, 'globalQueue', 'en'))[0]!.items[0]!;
    await saveGlobalTranslations(ctx, {
      scope: 'globalQueue',
      locale: 'en',
      sanitizeRich: sanitize,
      updates: [{ entity: 'queueConfig', id: queue.id, fields: { message: 'Please wait' } }],
    });
    const after = (await loadGlobalTranslationItems(ctx, 'globalQueue', 'en'))[0]!.items[0]!;
    expect(after.fields.find((f) => f.name === 'message')!.value).toBe('Please wait');
  });

  it('carries master plan category translations into the event and the plan file', async () => {
    const [master] = await handle.db
      .insert(seatMaps)
      .values({ venueId, kind: 'TEMPLATE', name: 'Master', canvasWidth: 500, canvasHeight: 300 })
      .returning();
    const catId = uuid();
    const doc = {
      version: 1,
      name: 'Master',
      canvasWidth: 500,
      canvasHeight: 300,
      categories: [
        { id: catId, name: 'Rang 1', color: '#112233', translations: { en: { name: 'Tier 1' } } },
      ],
    } satisfies SeatMapDocumentInput;
    expect((await saveSeatMapDocument(handle.db, master!.id, doc, null)).ok).toBe(true);
    expect((await loadSeatMapDocument(handle.db, master!.id))!.categories[0]!.translations).toEqual(
      {
        en: { name: 'Tier 1' },
      },
    );

    const file = await exportSeatMap(ctx, master!.id);
    expect(file.categories[0]!.translations.en!.name).toBe('Tier 1');
    const imported = await importSeatMap(ctx, { venueId, file, userId: null });
    expect(
      (await loadSeatMapDocument(handle.db, imported.seatMapId))!.categories[0]!.translations,
    ).toEqual({ en: { name: 'Tier 1' } });

    const [tax] = await handle.db.select().from(taxRates).limit(1);
    const [fresh] = await handle.db
      .insert(events)
      .values({
        venueId,
        slug: `tpl-${uuid().slice(0, 6)}`,
        title: 'From master',
        startsAt: new Date(Date.now() + 40 * 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: tax!.id,
      })
      .returning();
    await withTransaction(handle.db, async (tx) => {
      const copyId = await cloneSeatMap(tx, master!.id, { kind: 'EVENT', name: 'Copy' });
      await applyTemplateCategoriesToEvent(tx, { eventId: fresh!.id, seatMapId: copyId });
    });
    const created = await handle.db
      .select()
      .from(priceCategories)
      .where(eq(priceCategories.eventId, fresh!.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: 'Rang 1', translations: { en: { name: 'Tier 1' } } });
  });
});
