/**
 * Shop data cache against real PostgreSQL + Redis (throw-away): cached reads stay cached until the
 * code path that changes the data invalidates its tags; the next read returns fresh data.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  events,
  loadRootEnv,
  priceCategories,
  priceCategoryTicketTypes,
  queueAnnouncements,
  seatMaps,
  systemSettings,
  taxRates,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { PUBLIC_MAP_FORMAT } from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCoreContext,
  deleteArchivedEvent,
  eventTags,
  contentLocale,
  getEventCached,
  getPublicSeatMap,
  getPublicSeatMapPayload,
  getSetting,
  getShopAnnouncements,
  getShopEventBySlug,
  getShopEventList,
  getShopQueueConfig,
  invalidateShopCache,
  saveTranslations,
  seatMapVersion,
  shopCache,
  startShopCacheSync,
  type CoreContext,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();
const DAY = 86_400_000;

async function until(check: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe.skipIf(!adminUrl || !redisUrl)('shop data cache (integration)', () => {
  const dbName = `tix_cache_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let subscriber: Redis;
  let ctx: CoreContext;
  let venueId: string;
  let taxRateId: string;
  let eventId: string;
  let seatMapId: string;
  let categoryId: string;
  const slug = `gala-${uuid().slice(0, 6)}`;

  const newMap = async () =>
    (
      await handle.db
        .insert(seatMaps)
        .values({ venueId, kind: 'EVENT', name: 'M', canvasWidth: 100, canvasHeight: 100 })
        .returning({ id: seatMaps.id })
    )[0]!.id;
  const eventRow = () => handle.db.select().from(events).where(eq(events.id, eventId));

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
    subscriber = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${uuid().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      secrets: createSecretBox(parseKeyRing(generateKeyRingEntry('t1'))),
    });
    startShopCacheSync(ctx, subscriber);
    await until(() => shopCache.state === 'synced');

    const db = handle.db;
    const [venue] = await db
      .insert(venues)
      .values({ name: 'Hall', slug: `hall-${uuid().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning();
    venueId = venue!.id;
    const [rate] = await db
      .insert(taxRates)
      .values({ name: `vat-${uuid().slice(0, 6)}`, rateBasisPoints: 1900 })
      .returning();
    taxRateId = rate!.id;
    const [map] = await db
      .insert(seatMaps)
      .values({ venueId, kind: 'EVENT', name: 'Gala', canvasWidth: 500, canvasHeight: 300 })
      .returning();
    seatMapId = map!.id;
    const [ev] = await db
      .insert(events)
      .values({
        venueId,
        seatMapId,
        slug,
        title: 'Gala',
        status: 'PUBLISHED',
        startsAt: new Date(Date.now() + 30 * DAY),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId,
      })
      .returning();
    eventId = ev!.id;
    const [cat] = await db
      .insert(priceCategories)
      .values({ eventId, name: 'Cat 1', color: '#336699', basePrice: 4000 })
      .returning();
    categoryId = cat!.id;
    await db.insert(ticketTypes).values({ eventId, name: 'Normal', isDefault: true });
  });

  afterAll(async () => {
    await handle?.close();
    await Promise.all([redis?.quit(), subscriber?.quit()].map((p) => p?.catch(() => undefined)));
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  it('event page data is served from the cache until an event change invalidates it', async () => {
    const first = await getShopEventBySlug(ctx, slug);
    expect(first?.event.title).toBe('Gala');
    // A change nobody announced is not visible yet (this is what the safety TTL bounds)...
    await handle.db.update(events).set({ subtitle: 'New subtitle' }).where(eq(events.id, eventId));
    expect((await getShopEventBySlug(ctx, slug))?.event.subtitle).toBeNull();
    // ...the admin action invalidates after its commit and the next read is fresh.
    await invalidateShopCache(ctx, eventTags(eventId));
    expect((await getShopEventBySlug(ctx, slug))?.event.subtitle).toBe('New subtitle');
  });

  it('sales pause is visible at once through the hot-path event lookup', async () => {
    expect((await getEventCached(ctx, eventId)).salesPaused).toBe(false);
    await handle.db.update(events).set({ salesPaused: true }).where(eq(events.id, eventId));
    await invalidateShopCache(ctx, eventTags(eventId));
    expect((await getEventCached(ctx, eventId)).salesPaused).toBe(true);
    await handle.db.update(events).set({ salesPaused: false }).where(eq(events.id, eventId));
    await invalidateShopCache(ctx, eventTags(eventId));
    expect((await getEventCached(ctx, eventId)).salesPaused).toBe(false);
  });

  it('an invalidation published by ANOTHER instance reaches this one', async () => {
    await getShopEventBySlug(ctx, slug);
    await handle.db
      .update(events)
      .set({ subtitle: 'From elsewhere' })
      .where(eq(events.id, eventId));
    // Only the Redis message of "another instance" – no local call.
    await redis.publish(ctx.channels.shopCacheInvalidation(), JSON.stringify({ tags: ['events'] }));
    await until(
      async () => (await getShopEventBySlug(ctx, slug))?.event.subtitle === 'From elsewhere',
    );
  });

  it('translations saved through core appear without further action', async () => {
    await getShopEventBySlug(ctx, slug);
    await saveTranslations(ctx, {
      eventId,
      scope: 'event',
      locale: 'de',
      updates: [{ entity: 'event', id: eventId, fields: { title: 'Festabend' } }],
      sanitizeRich: (h) => h,
    });
    const bundle = await getShopEventBySlug(ctx, slug);
    expect(JSON.stringify(bundle?.event.translations)).toContain('Festabend');
  });

  it('price changes: payload (ETag) stays until the shop cache is invalidated, then reflects the new price', async () => {
    const event = await getEventCached(ctx, eventId);
    const before = await getPublicSeatMapPayload(ctx, event, 'en');
    expect(JSON.parse(before.json).categories[0].basePrice).toBe(4000);
    expect(await getPublicSeatMapPayload(ctx, event, 'en')).toBe(before); // same cached object

    await handle.db
      .update(priceCategories)
      .set({ basePrice: 5500 })
      .where(eq(priceCategories.id, categoryId));
    await invalidateShopCache(ctx, eventTags(eventId));

    const after = await getPublicSeatMapPayload(ctx, event, 'en');
    expect(JSON.parse(after.json).categories[0].basePrice).toBe(5500);
    expect(after.etag).not.toBe(before.etag);
    // Different locale = different entry, same content hash for identical JSON.
    expect((await getPublicSeatMapPayload(ctx, event, 'de')).etag).toMatch(/^"[\w-]+"$/);
  });

  it('a snapshot loader overtaken by a committed price change never poisons later reads', async () => {
    const event = await getEventCached(ctx, eventId);
    const [catRow] = await handle.db
      .select({ basePrice: priceCategories.basePrice })
      .from(priceCategories)
      .where(eq(priceCategories.id, categoryId));
    const original = catRow!.basePrice;
    const [genRow] = await handle.db
      .select({ gen: events.publicMapGeneration })
      .from(events)
      .where(eq(events.id, eventId));
    const gen0 = genRow!.gen;
    const version = await seatMapVersion(ctx, seatMapId);
    const staleKey = ctx.keys.seatMapSnapshot(eventId, version, gen0, PUBLIC_MAP_FORMAT);
    await redis.del(staleKey);
    shopCache.clear();

    // Pause the loader right before it stores its snapshot in Redis.
    let release!: () => void;
    let paused!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (paused = r));
    const realSet = redis.set.bind(redis) as (...args: unknown[]) => Promise<unknown>;
    (redis as unknown as { set: unknown }).set = async (...args: unknown[]) => {
      if (String(args[0]).includes(':seatmap:')) {
        paused();
        await gate;
      }
      return realSet(...args);
    };
    try {
      const loader = getPublicSeatMap(ctx, event, { fresh: true });
      await reached;
      // The admin commits the new price while the loader is paused. No invalidation runs at all
      // (as if the post-commit publish failed).
      await handle.db
        .update(priceCategories)
        .set({ basePrice: original + 700 })
        .where(eq(priceCategories.id, categoryId));
      release();
      const stale = await loader;
      expect(stale.categories[0]!.basePrice).toBe(original);
    } finally {
      release();
      (redis as unknown as { set: unknown }).set = realSet;
    }
    try {
      // The stale snapshot did land in Redis, but under a key nobody asks for any more.
      expect(await redis.get(staleKey)).toContain(`"basePrice":${original}`);
      const fresh = await getPublicSeatMap(ctx, event, { fresh: true });
      expect(fresh.categories[0]!.basePrice).toBe(original + 700);
      // Display paths converge as well (stamp cache is at most ~1 s old, or dropped by the tags).
      await invalidateShopCache(ctx, eventTags(eventId));
      const payload = await getPublicSeatMapPayload(ctx, event, 'en');
      expect(JSON.parse(payload.json).categories[0].basePrice).toBe(original + 700);
    } finally {
      await handle.db
        .update(priceCategories)
        .set({ basePrice: original })
        .where(eq(priceCategories.id, categoryId));
      await invalidateShopCache(ctx, eventTags(eventId));
    }
  });

  it('a build overtaken by commits on every attempt is never stored; money callers get a retryable error', async () => {
    const event = await getEventCached(ctx, eventId);
    const [catRow] = await handle.db
      .select({ basePrice: priceCategories.basePrice })
      .from(priceCategories)
      .where(eq(priceCategories.id, categoryId));
    const original = catRow!.basePrice;
    let bumps = 0;
    const bump = () =>
      handle.db
        .update(priceCategories)
        .set({ basePrice: original + 1000 + ++bumps })
        .where(eq(priceCategories.id, categoryId));
    // Every stamp re-read (the one after each build attempt) is preceded by a committed change.
    const wrap = (builder: object): object =>
      new Proxy(builder, {
        get(target, prop, receiver) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
              bump().then(() => (target as unknown as Promise<unknown>).then(resolve, reject));
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function'
            ? (...args: unknown[]) => wrap(value.apply(target, args))
            : value;
        },
      });
    const racingDb = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'select') return typeof value === 'function' ? value.bind(target) : value;
        return (fields?: Record<string, unknown>) => {
          const builder = (value as (f?: unknown) => object).call(target, fields);
          return fields && 'generation' in fields && 'currency' in fields ? wrap(builder) : builder;
        };
      },
    });
    const racing = { ...ctx, db: racingDb } as CoreContext;
    try {
      shopCache.clear();
      await expect(getPublicSeatMap(racing, event, { fresh: true })).rejects.toMatchObject({
        code: 'PRICES_UPDATING',
        status: 503,
      });
      expect(bumps).toBeGreaterThanOrEqual(3);
      // Display callers still get the newest build, but nothing was stored for it.
      shopCache.clear();
      const shown = await getPublicSeatMap(racing, event);
      expect(shown.categories[0]!.basePrice).toBeGreaterThanOrEqual(original + 1000);
      const stamp = await handle.db
        .select({ g: events.publicMapGeneration })
        .from(events)
        .where(eq(events.id, eventId));
      const version = await seatMapVersion(ctx, seatMapId);
      expect(
        await redis.get(ctx.keys.seatMapSnapshot(eventId, version, stamp[0]!.g, PUBLIC_MAP_FORMAT)),
      ).toBeNull();
    } finally {
      await handle.db
        .update(priceCategories)
        .set({ basePrice: original })
        .where(eq(priceCategories.id, categoryId));
      await invalidateShopCache(ctx, eventTags(eventId));
    }
    // Without interference the next money read is consistent again.
    const ok = await getPublicSeatMap(ctx, event, { fresh: true });
    expect(ok.categories[0]!.basePrice).toBe(original);
  });

  it('bumps the generation for every price relevant change (categories, tariffs, matrix, currency)', async () => {
    const gen = async () =>
      (
        await handle.db
          .select({ g: events.publicMapGeneration })
          .from(events)
          .where(eq(events.id, eventId))
      )[0]!.g;
    const g0 = await gen();
    const [tt] = await handle.db
      .insert(ticketTypes)
      .values({ eventId, name: 'Gen tariff' })
      .returning();
    const g1 = await gen();
    expect(g1).toBeGreaterThan(g0);
    await handle.db
      .insert(priceCategoryTicketTypes)
      .values({ priceCategoryId: categoryId, ticketTypeId: tt!.id });
    const g2 = await gen();
    expect(g2).toBeGreaterThan(g1);
    await handle.db
      .update(ticketTypes)
      .set({ description: 'changed' })
      .where(eq(ticketTypes.id, tt!.id));
    const g3 = await gen();
    expect(g3).toBeGreaterThan(g2);
    await handle.db.delete(ticketTypes).where(eq(ticketTypes.id, tt!.id)); // cascades the matrix row
    expect(await gen()).toBeGreaterThan(g3);
    const g4 = await gen();
    await handle.db.update(events).set({ title: 'Gala' }).where(eq(events.id, eventId));
    expect(await gen()).toBe(g4);
    const cachedRow = await getEventCached(ctx, eventId); // still says EUR
    await handle.db.update(events).set({ currency: 'CHF' }).where(eq(events.id, eventId));
    expect(await gen()).toBeGreaterThan(g4);
    // The map carries the currency read with the stamp, not the (possibly cached) row's.
    expect((await getPublicSeatMap(ctx, cachedRow, { fresh: true })).currency).toBe('CHF');
    await handle.db.update(events).set({ currency: 'EUR' }).where(eq(events.id, eventId));
  });

  it('normalises ?locale= before it reaches any cache key (bounded key space)', async () => {
    const event = await getEventCached(ctx, eventId);
    const base = await getPublicSeatMapPayload(ctx, event, undefined);
    const entries = shopCache.stats().entries;
    for (const junk of ['fr', 'zz', 'xx-YY', 'e', 'de-AT', 'DE', 'pt-BR', 'ja', 'sv', 'nl']) {
      await getPublicSeatMapPayload(ctx, event, junk);
    }
    // Unsupported locales collapse to the shop default (same entry, same payload); the supported
    // "de" (also as "de-AT" / "DE") adds exactly one entry.
    expect((await getPublicSeatMapPayload(ctx, event, 'fr')).etag).toBe(base.etag);
    expect(shopCache.stats().entries - entries).toBeLessThanOrEqual(1);
    expect(await contentLocale(ctx, 'xx-YY')).toMatchObject({ locale: 'en' });
    expect(await contentLocale(ctx, 'de-AT')).toMatchObject({ locale: 'de' });
  });

  it('home list: a change shows after invalidation; events that started drop out at read time', async () => {
    const list = await getShopEventList(ctx);
    expect(list.map((r) => r.event.id)).toContain(eventId);
    expect(list.find((r) => r.event.id === eventId)?.fromPrice).toBe(5500);

    const [soon] = await handle.db
      .insert(events)
      .values({
        venueId,
        seatMapId: await newMap(),
        slug: `soon-${uuid().slice(0, 6)}`,
        title: 'Starts in a second',
        status: 'PUBLISHED',
        startsAt: new Date(Date.now() + 1_200),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId,
      })
      .returning();
    await invalidateShopCache(ctx, eventTags(soon!.id));
    expect((await getShopEventList(ctx)).map((r) => r.event.id)).toContain(soon!.id);
    await new Promise((r) => setTimeout(r, 1_400));
    // No invalidation needed: the entry lives at most until the first start.
    expect((await getShopEventList(ctx)).map((r) => r.event.id)).not.toContain(soon!.id);
  });

  it('unpublishing removes the page from the shop immediately', async () => {
    expect(await getShopEventBySlug(ctx, slug)).not.toBeNull();
    await handle.db.update(events).set({ status: 'DRAFT' }).where(eq(events.id, eventId));
    await invalidateShopCache(ctx, eventTags(eventId));
    expect(await getShopEventBySlug(ctx, slug)).toBeNull();
    expect((await getShopEventList(ctx)).map((r) => r.event.id)).not.toContain(eventId);
    await handle.db.update(events).set({ status: 'PUBLISHED' }).where(eq(events.id, eventId));
    await invalidateShopCache(ctx, eventTags(eventId));
    expect(await getShopEventBySlug(ctx, slug)).not.toBeNull();
  });

  it('settings: a save on another instance (config channel) drops the settings cache', async () => {
    expect((await getSetting(ctx, 'general')).shopName).not.toBe('Elsewhere Tickets');
    const current = (await getSetting(ctx, 'general')) as Record<string, unknown>;
    await handle.db
      .insert(systemSettings)
      .values({ key: 'general', value: { ...current, shopName: 'Elsewhere Tickets' } })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: { ...current, shopName: 'Elsewhere Tickets' } },
      });
    expect((await getSetting(ctx, 'general')).shopName).not.toBe('Elsewhere Tickets');
    await redis.publish(ctx.channels.configInvalidation(), JSON.stringify({ setting: 'general' }));
    await until(async () => (await getSetting(ctx, 'general')).shopName === 'Elsewhere Tickets');
  });

  it('announcements: expiry is applied at read time; queue config follows its tag', async () => {
    await handle.db.insert(queueAnnouncements).values({
      eventId,
      message: 'Short lived',
      expiresAt: new Date(Date.now() + 1_000),
    });
    await invalidateShopCache(ctx, ['queue']);
    expect((await getShopAnnouncements(ctx, eventId)).map((a) => a.message)).toEqual([
      'Short lived',
    ]);
    await new Promise((r) => setTimeout(r, 1_200));
    expect(await getShopAnnouncements(ctx, eventId)).toEqual([]);

    expect((await getShopQueueConfig(ctx, eventId)).mode).toBe('OFF');
  });

  it('deleting an event drops its page and plan from the cache', async () => {
    const [temp] = await handle.db
      .insert(events)
      .values({
        venueId,
        seatMapId: await newMap(),
        slug: `temp-${uuid().slice(0, 6)}`,
        title: 'Temp',
        status: 'PUBLISHED',
        startsAt: new Date(Date.now() + 5 * DAY),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId,
      })
      .returning();
    expect(await getShopEventBySlug(ctx, temp!.slug)).not.toBeNull();
    await handle.db.update(events).set({ status: 'ARCHIVED' }).where(eq(events.id, temp!.id));
    await deleteArchivedEvent(ctx, temp!.id);
    expect(await getShopEventBySlug(ctx, temp!.slug)).toBeNull();
    await expect(getEventCached(ctx, temp!.id)).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND' });
  });

  it('keeps the loaded row identical in shape to a direct read (no data lost by caching)', async () => {
    const cached = await getShopEventBySlug(ctx, slug);
    const [direct] = await eventRow();
    expect(cached?.event).toEqual(direct);
  });
});
