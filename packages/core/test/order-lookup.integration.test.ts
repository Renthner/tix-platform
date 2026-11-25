/** "Find my order" for guests: neutral behaviour, only matching data sends mail. Throw-away database. */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDb, customers, emailMessages, loadRootEnv, orders, type DbHandle } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createSecretBox, parseKeyRing } from '@tix/shared/server';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoreContext, requestOrderAccessLink, type CoreContext } from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const enabled = process.env.TIX_TEST_THROWAWAY === '1' && adminUrl && redisUrl;

describe.skipIf(!enabled)('requestOrderAccessLink (integration)', () => {
  const dbName = `tix_ol_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;

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
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      appUrl: 'https://shop.example',
      secrets: createSecretBox(parseKeyRing(`k1:${Buffer.alloc(32, 7).toString('base64')}`)),
      jobs: { add: async () => ({}) },
    } as unknown as Parameters<typeof createCoreContext>[0]);
  });

  afterAll(async () => {
    redis?.disconnect();
    await handle?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  async function newOrder(
    over: Partial<typeof orders.$inferInsert> = {},
  ): Promise<typeof orders.$inferSelect> {
    const [customer] = await handle.db
      .insert(customers)
      .values({
        email: `c-${randomUUID().slice(0, 8)}@example.org`,
        firstName: 'Ada',
        lastName: 'Buyer',
        locale: 'en',
      })
      .returning();
    const [order] = await handle.db
      .insert(orders)
      .values({
        orderNumber: `OL-${randomUUID().slice(0, 8)}`,
        customerId: customer!.id,
        status: 'AWAITING_PAYMENT',
        channel: 'ONLINE',
        paymentMethod: 'BANK_TRANSFER',
        email: 'Buyer@Example.org',
        paymentReference: `TIX-2026-${String(Math.floor(Math.random() * 9e5) + 1e5)}-7`,
        paymentDueAt: new Date(Date.now() + 86_400_000),
        firstName: 'Ada',
        lastName: 'Buyer',
        locale: 'en',
        currency: 'EUR',
        subtotalGross: 1000,
        feeTotal: 0,
        totalGross: 1000,
        totalNet: 1000,
        totalTax: 0,
        ...over,
      })
      .returning();
    return order!;
  }
  const mails = async (orderId: string) =>
    (await handle.db.select().from(emailMessages).where(eq(emailMessages.orderId, orderId))).length;

  it('queues the state mail when number and e-mail match (case and spaces tolerant)', async () => {
    const order = await newOrder();
    await requestOrderAccessLink(ctx, {
      orderNumber: ` ${order.orderNumber.toLowerCase()} `,
      email: ' buyer@example.ORG ',
    });
    expect(await mails(order.id)).toBe(1);
  });

  it('sends nothing for a wrong e-mail, an unknown number or a test order', async () => {
    const order = await newOrder();
    const test = await newOrder({ isTest: true });
    await requestOrderAccessLink(ctx, {
      orderNumber: order.orderNumber,
      email: 'other@example.org',
    });
    await requestOrderAccessLink(ctx, { orderNumber: 'NOPE-1', email: 'buyer@example.org' });
    await requestOrderAccessLink(ctx, {
      orderNumber: test.orderNumber,
      email: 'buyer@example.org',
    });
    await requestOrderAccessLink(ctx, { orderNumber: '', email: '' });
    expect(await mails(order.id)).toBe(0);
    expect(await mails(test.id)).toBe(0);
  });

  it('takes about the same time whether or not the data matched', async () => {
    const order = await newOrder();
    const t0 = Date.now();
    await requestOrderAccessLink(ctx, { orderNumber: 'NOPE-2', email: 'x@example.org' });
    const miss = Date.now() - t0;
    const t1 = Date.now();
    await requestOrderAccessLink(ctx, {
      orderNumber: order.orderNumber,
      email: 'buyer@example.org',
    });
    const hit = Date.now() - t1;
    expect(miss).toBeGreaterThanOrEqual(380);
    expect(hit).toBeGreaterThanOrEqual(380);
  });
});
