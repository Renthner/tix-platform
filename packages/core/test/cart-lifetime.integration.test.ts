/**
 * Maximum total cart lifetime (checkout setting `maxCartLifetimeMinutes`) against real
 * PostgreSQL + Redis: additions restart the reservation timer only up to the limit, the one-time
 * payment grace period still applies on top, and an expired cart starts a new lifetime.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  events,
  loadRootEnv,
  priceCategories,
  priceCategoryTicketTypes,
  seatMaps,
  taxRates,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import type { SeatMapDocumentInput } from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addSeats,
  afterSeatMapSaved,
  createCoreContext,
  enterShop,
  extendCartForCheckout,
  getCart,
  getEventById,
  removeSeats,
  saveSeatMapDocument,
  saveSetting,
  type CoreContext,
  type EventRow,
  type JobQueues,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)('maximum cart lifetime (integration)', () => {
  const dbName = `tix_cartlife_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let event: EventRow;
  let seatIds: string[] = [];
  const jobs = { add: vi.fn(async () => undefined), close: async () => {} };
  const sid = () => `l${uuid().slice(0, 8)}`;
  const cartHash = (session: string) => ctx.keys.cart(session);
  const setLifetime = (minutes: number | null) =>
    saveSetting(ctx, 'checkout', { maxCartLifetimeMinutes: minutes }, null);

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
        canvasWidth: 800,
        canvasHeight: 600,
      })
      .returning();
    const [tax] = await handle.db
      .insert(taxRates)
      .values({ name: `vat-${uuid().slice(0, 6)}`, rateBasisPoints: 1900 })
      .returning();
    const [ev] = await handle.db
      .insert(events)
      .values({
        venueId: venue!.id,
        seatMapId: map!.id,
        slug: `show-${uuid().slice(0, 6)}`,
        title: 'Show',
        status: 'PUBLISHED',
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: tax!.id,
        orphanSeatRuleEnabled: false,
        maxTicketsPerOrder: 10,
      })
      .returning();
    const [category] = await handle.db
      .insert(priceCategories)
      .values({ eventId: ev!.id, name: 'Cat 1', color: '#336699', basePrice: 3000 })
      .returning();
    const [normal] = await handle.db
      .insert(ticketTypes)
      .values({ eventId: ev!.id, name: 'Normal', isDefault: true })
      .returning();
    await handle.db
      .insert(priceCategoryTicketTypes)
      .values({ priceCategoryId: category!.id, ticketTypeId: normal!.id });

    const sectionId = uuid();
    const rowId = uuid();
    const doc: SeatMapDocumentInput = {
      version: 1,
      name: 'Hall',
      canvasWidth: 800,
      canvasHeight: 600,
      sections: [
        {
          id: sectionId,
          type: 'SEATED',
          name: 'Stalls',
          ticketLabel: 'Stalls',
          geometry: { type: 'rect', x: 0, y: 0, width: 400, height: 100 },
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
      seats: Array.from({ length: 10 }, (_, i) => ({
        id: uuid(),
        sectionId,
        rowId,
        label: String(i + 1),
        position: i + 1,
        x: 20 + i * 30,
        y: 20,
        priceCategoryId: category!.id,
      })),
    };
    const saved = await saveSeatMapDocument(handle.db, map!.id, doc, null);
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

  it('without a limit every addition restarts the timer (previous behaviour)', async () => {
    await setLifetime(null);
    const session = sid();
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, [seatIds[0]!]);
    const first = (await getCart(ctx, session)).expiresAt!;
    // Age the cart: pretend the first seat was added 3 minutes ago.
    await redis.hset(cartHash(session), 'exp', String(first - 180_000));
    await addSeats(ctx, session, event, [seatIds[1]!]);
    expect((await getCart(ctx, session)).expiresAt!).toBeGreaterThan(first - 1_000);
  });

  it('caps the restarted timer at first lock + lifetime and stops extending there', async () => {
    await setLifetime(5);
    const session = sid();
    await enterShop(ctx, event, session);
    const t0 = Date.now();
    await addSeats(ctx, session, event, [seatIds[2]!]);
    const capped = (await getCart(ctx, session)).expiresAt!;
    // Reservation time is 10 min, the lifetime only 5.
    expect(capped).toBeGreaterThanOrEqual(t0 + 300_000);
    expect(capped).toBeLessThan(t0 + 305_000);
    await addSeats(ctx, session, event, [seatIds[3]!]);
    expect((await getCart(ctx, session)).expiresAt).toBe(capped);
    const lockExpiry = await redis.zscore(ctx.keys.seatLockExpiries(event.id), seatIds[3]!);
    expect(Number(lockExpiry)).toBe(capped);
  });

  it('keeps the one-time checkout grace on top of the cap and does not re-arm it at the limit', async () => {
    await setLifetime(5);
    const session = sid();
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, [seatIds[4]!]);
    const capped = (await getCart(ctx, session)).expiresAt!;
    const extended = await extendCartForCheckout(ctx, session);
    expect(extended).toBe(capped + 600_000);
    // At the limit, further seats neither shorten the extended timer nor re-arm the grace period.
    await addSeats(ctx, session, event, [seatIds[5]!]);
    expect((await getCart(ctx, session)).expiresAt).toBe(extended);
    expect(await extendCartForCheckout(ctx, session)).toBe(extended);
  });

  it('does not restart the lifetime when the cart is emptied and refilled', async () => {
    await setLifetime(5);
    const session = sid();
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, [seatIds[8]!]);
    const capped = (await getCart(ctx, session)).expiresAt!;
    await removeSeats(ctx, session, event.id, [seatIds[8]!]);
    await addSeats(ctx, session, event, [seatIds[8]!]);
    expect((await getCart(ctx, session)).expiresAt).toBe(capped);
  });

  it('refuses new seats when less than 30 seconds of the cart lifetime remain', async () => {
    await setLifetime(5);
    const session = sid();
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, [seatIds[9]!]);
    await redis.hset(cartHash(session), 'first', String(Date.now() - 5 * 60_000 + 10_000));
    await expect(addSeats(ctx, session, event, [seatIds[0]!])).rejects.toMatchObject({
      code: 'CART_LIFETIME_REACHED',
    });
    // The seat already held stays reserved.
    expect((await getCart(ctx, session)).itemCount).toBe(1);
    await setLifetime(null);
  });

  it('starts a new lifetime once the cart has expired', async () => {
    await setLifetime(5);
    const session = sid();
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, [seatIds[6]!]);
    await redis.hset(cartHash(session), 'first', String(Date.now() - 4 * 60_000));
    await redis.hset(cartHash(session), 'exp', String(Date.now() - 5_000));
    const t0 = Date.now();
    await addSeats(ctx, session, event, [seatIds[7]!]);
    const fresh = (await getCart(ctx, session)).expiresAt!;
    expect(fresh).toBeGreaterThanOrEqual(t0 + 300_000);
    expect(fresh).toBeLessThan(t0 + 305_000);
    await setLifetime(null);
  });
});
