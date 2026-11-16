/**
 * Ticket design export / import against real PostgreSQL (throw-away database) with an in-memory
 * object storage – never the shared MinIO buckets.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  events,
  loadRootEnv,
  mediaAssets,
  priceCategories,
  taxRates,
  ticketTemplates,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { seedReferenceData } from '@tix/db/seed';
import { defaultTicketLayout, ticketLayoutSchema } from '@tix/shared';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainError,
  createCoreContext,
  createTicketTemplate,
  exportTicketTemplate,
  getTicketTemplate,
  importTicketTemplate,
  parseTicketDesignFile,
  uploadMediaAsset,
  type CoreContext,
  type ObjectStorage,
} from '../src';
import { solidPng } from './image-fixtures';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!adminUrl || !redisUrl)('ticket design export / import (integration)', () => {
  const dbName = `tix_tpl_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let sourceId: string;
  let eventId: string;
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

  const b64 = async (w: number, h: number, salt: number) =>
    Buffer.from(await solidPng(w, h, salt)).toString('base64');

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

    const background = await uploadMediaAsset(ctx, {
      kind: 'TICKET_BACKGROUND',
      bytes: await solidPng(600, 300, 1),
      fileName: 'bg.png',
      userId: null,
    });
    const logo = await uploadMediaAsset(ctx, {
      kind: 'TICKET_BACKGROUND',
      bytes: await solidPng(100, 100, 2),
      fileName: 'logo.png',
      userId: null,
    });
    const layout = defaultTicketLayout();
    layout.elements.push(
      {
        kind: 'image',
        id: 'logo-a',
        assetId: logo.id,
        x: 5,
        y: 5,
        width: 20,
        height: 20,
        rotation: 0,
        opacity: 0.8,
      },
      {
        kind: 'image',
        id: 'logo-b',
        assetId: logo.id,
        x: 30,
        y: 5,
        width: 10,
        height: 10,
        rotation: 0,
        opacity: 1,
      },
    );
    const row = await createTicketTemplate(ctx, {
      userId: null,
      input: {
        name: 'Source',
        description: 'Round trip',
        pageWidthMm: 160,
        pageHeightMm: 70,
        backgroundAssetId: background.id,
        layout,
      },
    });
    sourceId = row.id;

    const [venue] = await handle.db
      .insert(venues)
      .values({ name: 'V', slug: `v-${randomUUID().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning({ id: venues.id });
    const [rate] = await handle.db.select().from(taxRates).limit(1);
    const [event] = await handle.db
      .insert(events)
      .values({
        venueId: venue!.id,
        title: 'E',
        slug: `e-${randomUUID().slice(0, 6)}`,
        startsAt: new Date(Date.now() + 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: rate!.id,
      } as never)
      .returning({ id: events.id });
    eventId = event!.id;
  });

  afterAll(async () => {
    await handle?.close?.();
    redis?.disconnect();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  const normalise = (f: Awaited<ReturnType<typeof exportTicketTemplate>>) => ({
    ...f,
    exportedAt: '',
  });
  const exported = async () =>
    parseTicketDesignFile(JSON.stringify(await exportTicketTemplate(ctx, sourceId)));

  it('exports without any database ids', async () => {
    const file = await exportTicketTemplate(ctx, sourceId);
    expect(JSON.stringify(file)).not.toContain(sourceId);
    expect(file.images).toHaveLength(1); // the shared logo is embedded once
    expect(file.background).not.toBeNull();
    expect(file.template.layout.elements.filter((e) => e.kind === 'image')).toHaveLength(2);
  });

  it('round trip: export, import, export is identical', async () => {
    const first = await exported();
    const result = await importTicketTemplate(ctx, { file: first, userId: null });
    expect(result.templateId).not.toBe(sourceId);
    const second = await exportTicketTemplate(ctx, result.templateId);
    expect(normalise(second)).toEqual(normalise(first));
    const imported = await getTicketTemplate(handle.db, result.templateId);
    expect(imported?.eventId).toBeNull();
    expect(imported?.isDefault).toBe(false);
    expect(ticketLayoutSchema.safeParse(imported?.layout).success).toBe(true);
  });

  it('imports into an event, with a name override, and refuses unknown events', async () => {
    const file = await exported();
    const result = await importTicketTemplate(ctx, {
      file,
      eventId,
      name: 'Renamed',
      userId: null,
    });
    const row = await getTicketTemplate(handle.db, result.templateId);
    expect(row?.eventId).toBe(eventId);
    expect(row?.name).toBe('Renamed');
    await expect(
      importTicketTemplate(ctx, { file, eventId: randomUUID(), userId: null }),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND' });
  });

  it('assigns to the event or a category, and checks the target before storing anything', async () => {
    const file = await exported();
    const [category] = await handle.db
      .insert(priceCategories)
      .values({ eventId, name: 'Cat', color: '#112233', basePrice: 1000 })
      .returning({ id: priceCategories.id });
    const forEvent = await importTicketTemplate(ctx, {
      file,
      eventId,
      assignTo: 'event',
      userId: null,
    });
    const [ev] = await handle.db.select().from(events).where(eq(events.id, eventId));
    expect(ev!.ticketTemplateId).toBe(forEvent.templateId);
    const forCategory = await importTicketTemplate(ctx, {
      file,
      eventId,
      assignTo: category!.id,
      userId: null,
    });
    const [cat] = await handle.db
      .select()
      .from(priceCategories)
      .where(eq(priceCategories.id, category!.id));
    expect(cat!.ticketTemplateId).toBe(forCategory.templateId);

    // unknown category: refused up front, no template and no new image is left behind
    const fresh = await exported();
    fresh.images[0]!.dataBase64 = await b64(61, 41, 123);
    const assets = (await handle.db.select().from(mediaAssets)).length;
    const templates = (await handle.db.select().from(ticketTemplates)).length;
    await expect(
      importTicketTemplate(ctx, { file: fresh, eventId, assignTo: randomUUID(), userId: null }),
    ).rejects.toMatchObject({ code: 'CATEGORY_NOT_FOUND' });
    expect((await handle.db.select().from(mediaAssets)).length).toBe(assets);
    expect((await handle.db.select().from(ticketTemplates)).length).toBe(templates);
  });

  it('stores images as private ticket-background assets', async () => {
    const file = await exported();
    file.images[0]!.dataBase64 = await b64(120, 90, 77);
    await importTicketTemplate(ctx, { file, userId: null });
    for (const a of await handle.db.select().from(mediaAssets)) {
      expect(a.kind).toBe('TICKET_BACKGROUND');
    }
  });

  it('rejects a file with a fake image and leaves nothing behind', async () => {
    const file = await exported();
    const assets = (await handle.db.select().from(mediaAssets)).length;
    const templates = (await handle.db.select().from(ticketTemplates)).length;
    // Valid new layout image first, then a fake background: the created asset must be removed.
    file.images[0]!.dataBase64 = await b64(50, 50, 99);
    file.background = {
      ...file.background!,
      dataBase64: Buffer.from('<svg onload="alert(1)"/>').toString('base64'),
    };
    await expect(importTicketTemplate(ctx, { file, userId: null })).rejects.toBeInstanceOf(
      DomainError,
    );
    expect((await handle.db.select().from(mediaAssets)).length).toBe(assets);
    expect((await handle.db.select().from(ticketTemplates)).length).toBe(templates);
  });

  it('re-validates a hand-built object', async () => {
    await expect(
      importTicketTemplate(ctx, { file: { format: 'tix-ticket-design' }, userId: null }),
    ).rejects.toThrow();
  });
});
