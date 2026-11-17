/**
 * Giving an inactive price-0 category (plan replace / import) a price activates it and offers it in
 * every tariff - against a real PostgreSQL (throwaway database).
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  events,
  loadRootEnv,
  priceCategories,
  priceCategoryTicketTypes,
  taxRates,
  ticketTypes,
  venues,
  withTransaction,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updatePriceCategoryTx, type PriceCategoryUpdateValues } from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('price category update (integration)', () => {
  const dbName = `tix_pcu_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let eventId: string;
  let tariffs: string[];

  const values = (over: Partial<PriceCategoryUpdateValues>): PriceCategoryUpdateValues => ({
    name: 'Cat',
    description: null,
    color: '#112233',
    maxTicketsPerOrder: null,
    sortOrder: 0,
    basePrice: 0,
    isActive: false,
    bestAvailableEnabled: true,
    ...over,
  });

  async function category(name: string, basePrice: number, isActive: boolean) {
    const [row] = await handle.db
      .insert(priceCategories)
      .values({ eventId, name, color: '#112233', basePrice, isActive })
      .returning({ id: priceCategories.id });
    return row!.id;
  }

  const update = (id: string, v: PriceCategoryUpdateValues) =>
    withTransaction(handle.db, (tx) => updatePriceCategoryTx(tx, eventId, id, v));

  const offered = async (id: string) =>
    (
      await handle.db
        .select({ t: priceCategoryTicketTypes.ticketTypeId })
        .from(priceCategoryTicketTypes)
        .where(eq(priceCategoryTicketTypes.priceCategoryId, id))
    )
      .map((r) => r.t)
      .sort();

  const active = async (id: string) =>
    (await handle.db.select().from(priceCategories).where(eq(priceCategories.id, id)))[0]!.isActive;

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
    handle = createDb({ connectionString: url.toString(), poolMax: 3 });
    const db = handle.db;
    const [venue] = await db
      .insert(venues)
      .values({ name: 'Hall', slug: 'hall', timeZone: 'Europe/Berlin' })
      .returning();
    const [rate] = await db
      .insert(taxRates)
      .values({ name: 'vat', rateBasisPoints: 1900 })
      .returning();
    const starts = new Date(Date.now() + 30 * 86_400_000);
    const [ev] = await db
      .insert(events)
      .values({
        venueId: venue!.id,
        slug: 'gala',
        title: 'Gala',
        status: 'DRAFT',
        startsAt: starts,
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: rate!.id,
      })
      .returning();
    eventId = ev!.id;
    const types = await db
      .insert(ticketTypes)
      .values([
        { eventId, name: 'Normal', isDefault: true },
        { eventId, name: 'Reduced', sortOrder: 1 },
      ])
      .returning({ id: ticketTypes.id });
    tariffs = types.map((t) => t.id).sort();
  });

  afterAll(async () => {
    await handle?.close?.();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  it('activates an inactive price-0 category and offers every tariff', async () => {
    const id = await category('Imported', 0, false);
    const result = await update(id, values({ name: 'Imported', basePrice: 2500, isActive: false }));
    expect(result?.activated).toBe(true);
    expect(await active(id)).toBe(true);
    expect(await offered(id)).toEqual(tariffs);
  });

  it('only adds missing matrix rows and never overwrites existing ones', async () => {
    const id = await category('Partial', 0, false);
    await handle.db
      .insert(priceCategoryTicketTypes)
      .values({ priceCategoryId: id, ticketTypeId: tariffs[0]!, priceOverride: 999 });
    await update(id, values({ name: 'Partial', basePrice: 1000 }));
    expect(await offered(id)).toEqual(tariffs);
    const [row] = await handle.db
      .select()
      .from(priceCategoryTicketTypes)
      .where(eq(priceCategoryTicketTypes.priceCategoryId, id))
      .then((r) => r.filter((x) => x.ticketTypeId === tariffs[0]));
    expect(row!.priceOverride).toBe(999);
  });

  it('leaves deliberately deactivated priced categories alone', async () => {
    const id = await category('Off', 1500, false);
    const result = await update(id, values({ name: 'Off', basePrice: 2000, isActive: false }));
    expect(result?.activated).toBe(false);
    expect(await active(id)).toBe(false);
    expect(await offered(id)).toEqual([]);
  });

  it('does nothing special while the price stays 0 or the category is active', async () => {
    const zero = await category('Zero', 0, false);
    expect((await update(zero, values({ name: 'Zero', basePrice: 0 })))?.activated).toBe(false);
    expect(await active(zero)).toBe(false);
    expect(await offered(zero)).toEqual([]);

    const live = await category('Live', 0, true);
    expect(
      (await update(live, values({ name: 'Live', basePrice: 500, isActive: true })))?.activated,
    ).toBe(false);
    expect(await offered(live)).toEqual([]);
  });

  it('returns null for an unknown category or one of another event', async () => {
    expect(await update(randomUUID(), values({}))).toBeNull();
  });
});
