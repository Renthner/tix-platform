/**
 * Live status polled by the order page: a payment recorded by hand in the admin must change what
 * the page compares (status / paid amount), like the automatic channels do. Throw-away database.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { adminUsers, createDb, customers, loadRootEnv, orders, type DbHandle } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createSecretBox, parseKeyRing } from '@tix/shared/server';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCoreContext,
  getOrderLiveStatus,
  recordManualPayment,
  type CoreContext,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const enabled = process.env.TIX_TEST_THROWAWAY === '1' && adminUrl && redisUrl;

describe.skipIf(!enabled)('getOrderLiveStatus (integration)', () => {
  const dbName = `tix_ls_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let userId: string;

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
    const [user] = await handle.db
      .insert(adminUsers)
      .values({ email: 'finance@example.invalid', displayName: 'Finance', roles: ['FINANCE'] })
      .returning({ id: adminUsers.id });
    userId = user!.id;
  });

  afterAll(async () => {
    redis?.disconnect();
    await handle?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  async function newBankTransferOrder(): Promise<string> {
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
        orderNumber: `LS-${randomUUID().slice(0, 8)}`,
        customerId: customer!.id,
        status: 'AWAITING_PAYMENT',
        channel: 'ONLINE',
        paymentMethod: 'BANK_TRANSFER',
        email: customer!.email,
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
      })
      .returning();
    return order!.id;
  }

  it('returns null for an unknown order', async () => {
    expect(await getOrderLiveStatus(ctx, randomUUID())).toBeNull();
  });

  it('reflects partial and full payments recorded by hand in the admin', async () => {
    const orderId = await newBankTransferOrder();
    expect(await getOrderLiveStatus(ctx, orderId)).toEqual({
      status: 'AWAITING_PAYMENT',
      amountPaid: 0,
      adjustment: null,
      validTickets: 0,
      invoices: 0,
    });

    const partial = await recordManualPayment(ctx, {
      orderId,
      amount: 400,
      method: 'BANK_TRANSFER',
      userId,
    });
    expect(partial.status).toBe('PARTIAL');
    expect(await getOrderLiveStatus(ctx, orderId)).toMatchObject({
      status: 'AWAITING_PAYMENT',
      amountPaid: 400,
    });

    const full = await recordManualPayment(ctx, {
      orderId,
      amount: 600,
      method: 'BANK_TRANSFER',
      userId,
    });
    expect(full.status).toBe('PAID');
    expect(await getOrderLiveStatus(ctx, orderId)).toMatchObject({
      status: 'PAID',
      amountPaid: 1000,
    });
  });
});
