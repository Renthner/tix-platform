/**
 * The load test seat plan generator (`scripts/load/make-seatplan.mjs`) against the real plan file
 * validation and importer. The import part runs against a throw-away PostgreSQL database with an
 * in-memory object storage (the plan has no images).
 */
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createDb,
  events,
  loadRootEnv,
  priceCategories,
  seats,
  taxRates,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { seedReferenceData } from '@tix/db/seed';
import { planToDocument, seatMapDocumentSchema } from '@tix/shared';
import { count, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyTemplateCategoriesToEvent,
  cloneSeatMap,
  createCoreContext,
  getPublicSeatMapPayload,
  importSeatMap,
  parseSeatMapFile,
  type CoreContext,
  type ObjectStorage,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

interface Generator {
  buildSeatPlan(options?: { seats?: number; name?: string }): unknown;
  describePlan(file: unknown): {
    seats: number;
    perBlock: Record<string, number>;
    perCategory: Record<string, number>;
    wheelchairSpaces: number;
    companionSeats: number;
  };
}

const generatorUrl = pathToFileURL(
  resolve(import.meta.dirname, '../../../scripts/load/make-seatplan.mjs'),
).href;
const loadGenerator = async () => (await import(/* @vite-ignore */ generatorUrl)) as Generator;

describe('load test seat plan (validation)', () => {
  it('passes the real plan file parser and the editor document schema', async () => {
    const gen = await loadGenerator();
    for (const n of [100, 3600, 12_000]) {
      const text = JSON.stringify(gen.buildSeatPlan({ seats: n }));
      const parsed = parseSeatMapFile(text);
      expect(parsed.plan.seats).toHaveLength(n);
      const doc = planToDocument(parsed, {
        uuid: randomUUID,
        symbolIds: new Map(),
        imageIds: new Map(),
        backgroundAssetId: null,
      });
      expect(seatMapDocumentSchema.safeParse(doc).success).toBe(true);
    }
    const info = gen.describePlan(gen.buildSeatPlan());
    expect(info).toMatchObject({ seats: 3600, wheelchairSpaces: 4, companionSeats: 4 });
  });
});

describe.skipIf(!adminUrl || !redisUrl)('load test seat plan (import)', () => {
  const dbName = `tix_lt_plan_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  const storage = {
    put: async () => {},
    get: async () => ({ body: new Uint8Array(), contentType: undefined }),
    delete: async () => {},
  } as unknown as ObjectStorage;

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
  });

  afterAll(async () => {
    redis?.disconnect();
    await handle?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  it('imports 3,600 seats, creates the event and serves a sensible public map', async () => {
    const gen = await loadGenerator();
    const text = JSON.stringify(gen.buildSeatPlan());
    const [venue] = await handle.db
      .insert(venues)
      .values({ name: 'Load', slug: `load-${randomUUID().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning({ id: venues.id });

    const started = performance.now();
    const imported = await importSeatMap(ctx, {
      venueId: venue!.id,
      file: parseSeatMapFile(text),
      userId: null,
    });
    const importMs = performance.now() - started;
    expect(imported).toMatchObject({ seats: 3600, categories: 3 });

    const event = await handle.db.transaction(async (tx) => {
      const mapId = await cloneSeatMap(tx, imported.seatMapId, { kind: 'EVENT', name: 'Load' });
      const [rate] = await tx.select().from(taxRates).limit(1);
      const [created] = await tx
        .insert(events)
        .values({
          venueId: venue!.id,
          seatMapId: mapId,
          slug: 'load',
          title: 'Load',
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
      ).toBe(3);
      return created!;
    });
    const cats = await handle.db
      .select({ name: priceCategories.name })
      .from(priceCategories)
      .where(eq(priceCategories.eventId, event.id));
    expect(cats.map((c) => c.name).sort()).toEqual(['Cat 1', 'Cat 2', 'Cat 3']);
    const [stored] = await handle.db
      .select({ n: count() })
      .from(seats)
      .where(eq(seats.seatMapId, event.seatMapId!));
    expect(stored!.n).toBe(3600);

    const payload = await getPublicSeatMapPayload(ctx, event);
    const bytes = Buffer.byteLength(payload.json);
    console.log(
      `[load-seatplan] import ${Math.round(importMs)} ms, file ${(Buffer.byteLength(text) / 1048576).toFixed(2)} MB, public map ${(bytes / 1024).toFixed(0)} KB (gzip ${(gzipSync(payload.json).length / 1024).toFixed(0)} KB)`,
    );
    expect(importMs).toBeLessThan(30_000);
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
  });
});
