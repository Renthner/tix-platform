/**
 * Seat plan export / import against real PostgreSQL (throw-away database) with an in-memory
 * object storage – never the shared MinIO buckets.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  loadRootEnv,
  events,
  mediaAssets,
  priceCategories,
  priceCategoryTicketTypes,
  seatMaps,
  taxRates,
  ticketTypes,
  seats,
  svgSymbols,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { seedReferenceData } from '@tix/db/seed';
import { count, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainError,
  applyTemplateCategoriesToEvent,
  cloneSeatMap,
  createCoreContext,
  createSymbol,
  exportSeatMap,
  getPublicSeatMap,
  importSeatMap,
  loadSeatMapDocument,
  parseSeatMapFile,
  saveSeatMapDocument,
  uploadMediaAsset,
  type CoreContext,
} from '../src';
import type { ObjectStorage } from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

function pngBytes(width: number, height: number, salt: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  b[33] = salt;
  return b;
}

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="currentColor"/></svg>';

describe.skipIf(!adminUrl || !redisUrl)('seat plan export / import (integration)', () => {
  const dbName = `tix_plan_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let venueA: string;
  let venueB: string;
  let sourceMapId: string;
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

  const normalise = (file: Awaited<ReturnType<typeof exportSeatMap>>) => ({
    ...file,
    exportedAt: '',
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
    handle = createDb({ connectionString: url.toString(), poolMax: 5 });
    await seedReferenceData(handle.db, () => {});
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      storage,
    });

    const made = await handle.db
      .insert(venues)
      .values([
        { name: 'A', slug: `a-${randomUUID().slice(0, 6)}`, timeZone: 'Europe/Berlin' },
        { name: 'B', slug: `b-${randomUUID().slice(0, 6)}`, timeZone: 'Europe/Berlin' },
      ])
      .returning({ id: venues.id });
    venueA = made[0]!.id;
    venueB = made[1]!.id;

    // Source plan: block with a row (wheelchair + companion + blocked seat + custom symbol),
    // a stage with a symbol, an entrance and a background image.
    const symbol = await createSymbol(handle.db, {
      name: 'Custom chair',
      kind: 'SEAT',
      svg: SVG,
      colorize: true,
      createdByUserId: null,
    });
    const background = await uploadMediaAsset(ctx, {
      kind: 'VENUE_BACKGROUND',
      bytes: pngBytes(800, 600, 11),
      fileName: 'hall.png',
      userId: null,
    });
    const [map] = await handle.db
      .insert(seatMaps)
      .values({
        venueId: venueA,
        kind: 'TEMPLATE',
        name: 'Main hall',
        canvasWidth: 1200,
        canvasHeight: 800,
      })
      .returning({ id: seatMaps.id });
    sourceMapId = map!.id;
    const entrance = randomUUID();
    const section = randomUUID();
    const row = randomUUID();
    const seat = (label: string, position: number, extra: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      sectionId: section,
      rowId: row,
      label,
      position,
      x: 100 + position * 20,
      y: 200,
      ...extra,
    });
    const premium = randomUUID();
    const wheelchair = seat('1', 1, { isWheelchairSpace: true });
    const result = await saveSeatMapDocument(
      handle.db,
      sourceMapId,
      {
        version: 1,
        name: 'Main hall',
        canvasWidth: 1200,
        canvasHeight: 800,
        backgroundAssetId: background.id,
        categories: [{ id: premium, name: 'Premium', color: '#FF0000', sortOrder: 0 }],
        settings: { defaultSeatSymbolId: symbol.id, wheelchairLabel: { mode: 'TEXT', text: 'R' } },
        entrances: [{ id: entrance, name: 'Main', code: 'A', x: 10, y: 10 }],
        sections: [
          {
            id: section,
            type: 'SEATED',
            name: 'Parkett',
            ticketLabel: 'Parkett',
            priceCategoryId: premium,
            geometry: { type: 'rect', x: 50, y: 150, width: 400, height: 200, rotation: 0 },
            entranceId: entrance,
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
              seatOrientation: { mode: 'ROW', angle: 180 },
            },
          },
        ],
        elements: [
          {
            id: randomUUID(),
            type: 'STAGE',
            label: 'Stage',
            geometry: {
              type: 'rect',
              x: 100,
              y: 20,
              width: 300,
              height: 80,
              rotation: 0,
              cornerRadius: 0,
            },
            style: { symbolId: symbol.id, fill: '#333333' },
          },
        ],
        seats: [
          wheelchair,
          seat('2', 2, { isCompanionSeat: true, companionOfSeatId: wheelchair.id }),
          seat('3', 3, { blockReason: 'PRESS', blockNote: 'Press desk' }),
          seat('4', 4, { symbolId: symbol.id, rotation: 30, priceCategoryId: premium }),
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  afterAll(async () => {
    redis?.disconnect();
    await handle?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  it('exports without database ids and round-trips through an import', async () => {
    const first = await exportSeatMap(ctx, sourceMapId, { appVersion: '1.2.3' });
    expect(first).toMatchObject({
      format: 'tix-seatmap',
      version: 2,
      source: { appVersion: '1.2.3' },
    });
    expect(first.plan.seats).toHaveLength(4);
    expect(first.symbols).toHaveLength(1);
    expect(first.background?.contentType).toBe('image/png');
    const json = JSON.stringify(first);
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    const companion = first.plan.seats.find((s) => s.isCompanionSeat)!;
    const wheelchair = first.plan.seats.find((s) => s.isWheelchairSpace)!;
    expect(companion.companionOfSeatId).toBe(wheelchair.id);
    expect(first.plan.seats.find((s) => s.blockReason === 'PRESS')?.blockNote).toBe('Press desk');

    const imported = await importSeatMap(ctx, { venueId: venueB, file: first, userId: null });
    expect(imported).toMatchObject({ seats: 4, symbolsCreated: 0, symbolsReused: 1 });
    const [map] = await handle.db
      .select()
      .from(seatMaps)
      .where(eq(seatMaps.id, imported.seatMapId));
    expect(map).toMatchObject({ kind: 'TEMPLATE', venueId: venueB, name: 'Main hall' });

    const second = await exportSeatMap(ctx, imported.seatMapId, { appVersion: '1.2.3' });
    expect(normalise(second)).toEqual(normalise(first));
    // The source plan is untouched and the background asset is shared, not duplicated.
    expect((await loadSeatMapDocument(handle.db, sourceMapId))?.seats).toHaveLength(4);
    const [assets] = await handle.db.select({ n: count() }).from(mediaAssets);
    expect(assets!.n).toBe(1);
  });

  it('creates the symbol (suffixed on a name clash) when the target does not have it', async () => {
    const file = await exportSeatMap(ctx, sourceMapId);
    // Different content under the same name, and the original content removed → new symbol.
    await handle.db
      .update(svgSymbols)
      .set({ markup: '<rect x="1" y="1" width="8" height="8"></rect>' })
      .where(eq(svgSymbols.name, 'Custom chair'));
    const result = await importSeatMap(ctx, {
      venueId: venueB,
      file,
      name: 'Imported',
      userId: null,
    });
    expect(result).toMatchObject({ symbolsCreated: 1, symbolsReused: 0 });
    const names = (await handle.db.select({ name: svgSymbols.name }).from(svgSymbols)).map(
      (s) => s.name,
    );
    expect(names).toContain('Custom chair (2)');
    const [map] = await handle.db.select().from(seatMaps).where(eq(seatMaps.id, result.seatMapId));
    expect(map?.name).toBe('Imported');
  });

  it('maps built-in symbols to the target copy and keeps category assignments', async () => {
    const file = await exportSeatMap(ctx, sourceMapId);
    const seeded = (await handle.db.select().from(svgSymbols)).find((s) => s.builtinKey);
    expect(seeded).toBeTruthy();
    const withBuiltin = {
      ...file,
      symbols: [
        {
          ...file.symbols[0]!,
          svg: SVG.replace('<circle', '<rect width="1" height="1"/><circle'),
          builtinKey: seeded!.builtinKey,
          kind: seeded!.kind,
        },
      ],
      categories: [{ key: 'cat1', name: 'Premium', color: '#ff0000' }],
      plan: {
        ...file.plan,
        seats: file.plan.seats.map((s, i) => (i === 0 ? { ...s, categoryKey: 'cat1' } : s)),
      },
    };
    const result = await importSeatMap(ctx, { venueId: venueB, file: withBuiltin, userId: null });
    expect(result.categories).toBe(1);
    expect(result.symbolsReused).toBe(1);
    const doc = await loadSeatMapDocument(handle.db, result.seatMapId);
    expect(doc?.categories.map((c) => c.name)).toEqual(['Premium']);
    expect(doc?.seats.filter((s) => s.priceCategoryId === doc.categories[0]!.id)).toHaveLength(2);
    expect(doc?.settings.defaultSeatSymbolId).toBe(seeded!.id);
  });

  it('re-sanitises malicious SVG', async () => {
    const file = await exportSeatMap(ctx, sourceMapId);
    const evil = {
      ...file,
      symbols: [
        {
          ...file.symbols[0]!,
          name: 'Evil',
          svg: '<svg viewBox="0 0 10 10" onload="x()"><script>alert(1)</script><image href="http://evil/x.png"/><circle cx="5" cy="5" r="4" onclick="y()" style="fill:url(#a)"/><foreignObject><div/></foreignObject></svg>',
        },
      ],
    };
    const result = await importSeatMap(ctx, { venueId: venueB, file: evil, userId: null });
    const doc = await loadSeatMapDocument(handle.db, result.seatMapId);
    const id = doc!.settings.defaultSeatSymbolId!;
    const [row] = await handle.db.select().from(svgSymbols).where(eq(svgSymbols.id, id));
    expect(row!.markup).toBe('<circle cx="5" cy="5" r="4"></circle>');
    expect(row!.markup).not.toMatch(/script|onclick|image|style|foreignObject/i);
    // A symbol without any drawable shape is rejected.
    const empty = {
      ...file,
      symbols: [{ ...file.symbols[0]!, svg: '<svg viewBox="0 0 1 1"><script>1</script></svg>' }],
    };
    await expect(
      importSeatMap(ctx, { venueId: venueB, file: empty, userId: null }),
    ).rejects.toMatchObject({
      code: 'SVG_EMPTY',
    });
  });

  it('rejects invalid files and leaves nothing behind', async () => {
    const before = (await handle.db.select({ n: count() }).from(seatMaps))[0]!.n;
    const file = await exportSeatMap(ctx, sourceMapId);
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return err instanceof DomainError ? err.code : 'other';
      }
      return 'none';
    };
    expect(code(() => parseSeatMapFile('not json'))).toBe('SEATMAP_FILE_INVALID');
    expect(code(() => parseSeatMapFile('{"format":"other"}'))).toBe('SEATMAP_FILE_INVALID');
    expect(code(() => parseSeatMapFile(JSON.stringify({ ...file, version: 3 })))).toBe(
      'SEATMAP_VERSION_UNSUPPORTED',
    );
    expect(
      code(() =>
        parseSeatMapFile(JSON.stringify({ ...file, plan: { ...file.plan, seats: [{}] } })),
      ),
    ).toBe('SEATMAP_FILE_INVALID');
    expect(code(() => parseSeatMapFile(' '.repeat(41 * 1024 * 1024)))).toBe(
      'SEATMAP_FILE_TOO_LARGE',
    );

    // Dangling reference: seat points at an unknown row.
    const broken = {
      ...file,
      plan: { ...file.plan, seats: file.plan.seats.map((s) => ({ ...s, rowId: 'nope' })) },
    };
    await expect(
      importSeatMap(ctx, { venueId: venueB, file: broken, userId: null }),
    ).rejects.toMatchObject({
      code: 'SEATMAP_FILE_INVALID',
    });
    // Not an image: rejected by the upload pipeline.
    const badImage = {
      ...file,
      background: {
        ...file.background!,
        dataBase64: Buffer.from('<html></html>').toString('base64'),
      },
    };
    await expect(
      importSeatMap(ctx, { venueId: venueB, file: badImage, userId: null }),
    ).rejects.toMatchObject({
      code: 'MEDIA_UNSUPPORTED_TYPE',
    });
    // Database failure after the upload: the newly stored image is removed again.
    const fresh = {
      ...file,
      background: {
        ...file.background!,
        dataBase64: Buffer.from(pngBytes(800, 600, 99)).toString('base64'),
      },
    };
    const assetsBefore = (await handle.db.select({ n: count() }).from(mediaAssets))[0]!.n;
    await expect(
      importSeatMap(ctx, { venueId: randomUUID(), file: fresh, userId: null }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await handle.db.select({ n: count() }).from(mediaAssets))[0]!.n).toBe(assetsBefore);
    expect((await handle.db.select({ n: count() }).from(seatMaps))[0]!.n).toBe(before);
    expect(
      (
        await handle.db.select({ n: count() }).from(seats).where(eq(seats.seatMapId, randomUUID()))
      )[0]!.n,
    ).toBe(0);
  });

  it('exports plan categories with assignments and creates them on import', async () => {
    const file = await exportSeatMap(ctx, sourceMapId);
    expect(file.categories).toEqual([
      { key: 'cat1', name: 'Premium', color: '#FF0000', translations: {} },
    ]);
    expect(file.plan.sections[0]!.categoryKey).toBe('cat1');
    expect(file.plan.seats.filter((s) => s.categoryKey === 'cat1')).toHaveLength(1);
  });

  async function createEvent(mapId: string, venueId: string, slug: string, withMap = true) {
    const [rate] = await handle.db.select().from(taxRates).limit(1);
    const [event] = await handle.db
      .insert(events)
      .values({
        venueId,
        seatMapId: mapId,
        slug,
        title: slug,
        status: 'DRAFT',
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: rate!.id,
      })
      .returning();
    await handle.db
      .insert(ticketTypes)
      .values({ eventId: event!.id, name: 'Normal', isDefault: true });
    return event!;
  }

  it('creates price categories and assignments when an event is created from an imported plan', async () => {
    const file = await exportSeatMap(ctx, sourceMapId);
    const imported = await importSeatMap(ctx, { venueId: venueB, file, userId: null });
    const event = await handle.db.transaction(async (tx) => {
      const mapId = await cloneSeatMap(tx, imported.seatMapId, { kind: 'EVENT', name: 'Gig' });
      const [rate] = await tx.select().from(taxRates).limit(1);
      const [created] = await tx
        .insert(events)
        .values({
          venueId: venueB,
          seatMapId: mapId,
          slug: 'gig',
          title: 'Gig',
          status: 'DRAFT',
          startsAt: new Date(Date.now() + 30 * 86_400_000),
          timeZone: 'Europe/Berlin',
          currency: 'EUR',
          taxRateId: rate!.id,
        })
        .returning();
      await tx
        .insert(ticketTypes)
        .values({ eventId: created!.id, name: 'Normal', isDefault: true });
      expect(
        await applyTemplateCategoriesToEvent(tx, { eventId: created!.id, seatMapId: mapId }),
      ).toBe(1);
      return created!;
    });
    const cats = await handle.db
      .select()
      .from(priceCategories)
      .where(eq(priceCategories.eventId, event.id));
    expect(cats).toHaveLength(1);
    expect(cats[0]).toMatchObject({ name: 'Premium', color: '#FF0000', basePrice: 0 });
    const doc = await loadSeatMapDocument(handle.db, event.seatMapId!);
    expect(doc?.sections[0]!.priceCategoryId).toBe(cats[0]!.id);
    expect(doc?.seats.filter((s) => s.priceCategoryId === cats[0]!.id)).toHaveLength(1);
    const leftovers = await handle.db
      .select({ n: count() })
      .from(seats)
      .where(eq(seats.seatMapId, event.seatMapId!));
    expect(leftovers[0]!.n).toBe(4);

    // Without a matrix price the category has no tariff price → not sellable.
    const publicMap = await getPublicSeatMap(ctx, event);
    expect(publicMap.categories.map((c) => c.id)).toContain(cats[0]!.id);
    expect(publicMap.ticketTypes.every((t) => t.prices[cats[0]!.id] === undefined)).toBe(true);
    expect(await handle.db.select().from(priceCategoryTicketTypes)).toHaveLength(0);

    // The event plan exports its price categories (no prices) and imports them as plan categories.
    const eventFile = await exportSeatMap(ctx, event.seatMapId!);
    expect(eventFile.categories).toEqual([
      { key: 'cat1', name: 'Premium', color: '#FF0000', translations: {} },
    ]);
    expect(JSON.stringify(eventFile)).not.toContain('basePrice');
    const again = await importSeatMap(ctx, { venueId: venueB, file: eventFile, userId: null });
    expect(again.categories).toBe(1);
  });

  it('reuses an existing category of the event with the same name', async () => {
    const file = await exportSeatMap(ctx, sourceMapId);
    const imported = await importSeatMap(ctx, { venueId: venueB, file, userId: null });
    const mapId = await handle.db.transaction((tx) =>
      cloneSeatMap(tx, imported.seatMapId, { kind: 'EVENT', name: 'Reuse' }),
    );
    const event = await createEvent(mapId, venueB, 'reuse');
    const [existing] = await handle.db
      .insert(priceCategories)
      .values({ eventId: event.id, name: 'Premium', color: '#00FF00', basePrice: 5000 })
      .returning();
    const created = await handle.db.transaction((tx) =>
      applyTemplateCategoriesToEvent(tx, { eventId: event.id, seatMapId: mapId }),
    );
    expect(created).toBe(0);
    const doc = await loadSeatMapDocument(handle.db, mapId);
    expect(doc?.seats.filter((s) => s.priceCategoryId === existing!.id)).toHaveLength(1);
  });

  it('saves master plan categories through the editor save and rejects unknown references', async () => {
    const doc = (await loadSeatMapDocument(handle.db, sourceMapId))!;
    const bad = await saveSeatMapDocument(
      handle.db,
      sourceMapId,
      { ...doc, categories: [], seats: doc.seats },
      null,
    );
    expect(bad).toMatchObject({ ok: false, status: 422 });
    const ok = await saveSeatMapDocument(handle.db, sourceMapId, doc, null);
    expect(ok.ok).toBe(true);
  });
});
