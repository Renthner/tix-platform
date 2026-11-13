/**
 * Hardening of money flows against real PostgreSQL + Redis:
 *  - dunning auto-cancel guard evaluated on the locked row (partial payment / keep-reserved race),
 *  - bank payment + allocation atomicity, repair of legacy payments without allocation,
 *    ALREADY_PAID during automatic matching → overpayment review, no throw after commit,
 *  - guest checkout never overwrites phone / address of a registered customer account.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  bankTransactionAllocations,
  bankTransactions,
  createDb,
  customers,
  loadRootEnv,
  orders,
  payments,
  withTransaction,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { buildPaymentReference } from '@tix/shared';
import { createSecretBox, parseKeyRing } from '@tix/shared/server';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assignBankTransaction,
  cancelOrder,
  createCoreContext,
  invalidateSettings,
  matchBankTransaction,
  recordPayment,
  runDunning,
  saveBankAccount,
  upsertCustomer,
  type CoreContext,
  type JobQueues,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

/** Hook that runs right before the matcher books a payment (simulates a concurrent change). */
const hooks: { beforeRecordPayment?: () => Promise<void> } = {};
vi.mock('../src/orders/fulfillment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/orders/fulfillment')>();
  return {
    ...actual,
    recordPayment: async (...args: Parameters<typeof actual.recordPayment>) => {
      await hooks.beforeRecordPayment?.();
      return actual.recordPayment(...args);
    },
  };
});

describe.skipIf(!adminUrl || !redisUrl)('payment hardening (integration)', () => {
  const dbName = `tix_hard_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let customerId: string;
  let seq = 0;
  let accountId: string;
  const failingJobs = {
    add: vi.fn(async () => {
      throw new Error('redis down');
    }),
    close: async () => {},
  };

  async function createOrder(
    total: number,
    options: Partial<typeof orders.$inferInsert> = {},
  ): Promise<{ id: string; reference: string }> {
    seq += 1;
    const reference = buildPaymentReference('TIX', 2026, String(7000 + seq));
    const [row] = await handle.db
      .insert(orders)
      .values({
        orderNumber: `H-${seq}-${randomUUID().slice(0, 4)}`,
        customerId,
        status: 'AWAITING_PAYMENT',
        channel: 'ONLINE',
        paymentMethod: 'BANK_TRANSFER',
        email: 'buyer@example.invalid',
        firstName: 'Max',
        lastName: 'Mustermann',
        locale: 'de',
        currency: 'EUR',
        subtotalGross: total,
        totalGross: total,
        totalNet: total,
        totalTax: 0,
        paymentReference: reference,
        paymentDueAt: new Date('2026-03-10T23:00:00Z'),
        createdAt: new Date('2026-03-01T10:00:00Z'),
        ...options,
      })
      .returning({ id: orders.id });
    return { id: row!.id, reference };
  }

  async function createCredit(amount: number, reference: string): Promise<string> {
    seq += 1;
    const [row] = await handle.db
      .insert(bankTransactions)
      .values({
        bankAccountId: accountId,
        fingerprint: `hard-${seq}-${randomUUID()}`,
        bookingDate: '2026-03-02',
        amount,
        currency: 'EUR',
        counterpartyName: 'Max Mustermann',
        remittanceInformation: reference,
        matchStatus: 'UNMATCHED',
      })
      .returning({ id: bankTransactions.id });
    return row!.id;
  }

  const orderRow = async (id: string) =>
    (await handle.db.select().from(orders).where(eq(orders.id, id)))[0]!;
  const txRow = async (id: string) =>
    (await handle.db.select().from(bankTransactions).where(eq(bankTransactions.id, id)))[0]!;
  const allocations = (txId: string) =>
    handle.db
      .select()
      .from(bankTransactionAllocations)
      .where(eq(bankTransactionAllocations.bankTransactionId, txId));

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
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      secrets: createSecretBox(parseKeyRing(`k1:${randomBytes(32).toString('base64')}`)),
      jobs: failingJobs as unknown as JobQueues,
    });
    invalidateSettings();
    const account = await saveBankAccount(ctx, null, {
      name: 'Main account',
      accountHolder: 'Example Club',
      iban: 'DE89 3704 0044 0532 0130 00',
      bic: 'TESTDEFFXXX',
      currency: 'EUR',
      isDefaultForBankTransfer: true,
      isActive: true,
    });
    accountId = account.id;
    const [customer] = await handle.db
      .insert(customers)
      .values({ email: 'buyer@example.invalid', firstName: 'Max', lastName: 'Mustermann' })
      .returning({ id: customers.id });
    customerId = customer!.id;
  });

  afterAll(async () => {
    invalidateSettings();
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

  // ─── A2: dunning guard ────────────────────────────────────────────────────────

  describe('dunning auto-cancel guard', () => {
    const now = new Date('2026-04-01T12:00:00Z');
    const due = new Date('2026-03-31T12:00:00Z');
    const guard = { now };
    const base = {
      status: 'CANCELLED',
      reason: 'PAYMENT_OVERDUE',
      actor: { type: 'SYSTEM' },
    } as const;

    it('does not cancel when a partial payment arrived after the selection', async () => {
      const order = await createOrder(5000, { autoCancelAt: due, amountPaid: 0 });
      // The dunning job selected the order, then a partial payment was recorded.
      await handle.db.update(orders).set({ amountPaid: 1000 }).where(eq(orders.id, order.id));
      const done = await cancelOrder(ctx, {
        orderId: order.id,
        ...base,
        onlyIfUnpaidAndDue: guard,
      });
      expect(done).toBe(false);
      expect((await orderRow(order.id)).status).toBe('AWAITING_PAYMENT');
    });

    it('does not cancel when an admin set keep-reserved after the selection', async () => {
      const order = await createOrder(5000, { autoCancelAt: due });
      await handle.db.update(orders).set({ keepReserved: true }).where(eq(orders.id, order.id));
      const done = await cancelOrder(ctx, {
        orderId: order.id,
        ...base,
        onlyIfUnpaidAndDue: guard,
      });
      expect(done).toBe(false);
      expect((await orderRow(order.id)).status).toBe('AWAITING_PAYMENT');
    });

    it('does not cancel when the deadline was moved into the future', async () => {
      const order = await createOrder(5000, { autoCancelAt: new Date('2026-05-01T00:00:00Z') });
      expect(
        await cancelOrder(ctx, { orderId: order.id, ...base, onlyIfUnpaidAndDue: guard }),
      ).toBe(false);
    });

    it('cancels an unprotected overdue order and keeps other callers unguarded', async () => {
      const order = await createOrder(5000, { autoCancelAt: due });
      expect(
        await cancelOrder(ctx, { orderId: order.id, ...base, onlyIfUnpaidAndDue: guard }),
      ).toBe(true);
      expect((await orderRow(order.id)).status).toBe('CANCELLED');
      // Without the guard (admin cancellation) keep-reserved does not matter to cancelOrder.
      const kept = await createOrder(5000, { keepReserved: true });
      expect(await cancelOrder(ctx, { orderId: kept.id, ...base })).toBe(true);
    });

    it('runDunning skips orders protected in the meantime', async () => {
      const order = await createOrder(5000, { autoCancelAt: due, keepReserved: true });
      const result = await runDunning(ctx, now);
      expect(result.cancelled).toBe(0);
      expect((await orderRow(order.id)).status).toBe('AWAITING_PAYMENT');
    });
  });

  // ─── A3: bank payment + allocation ────────────────────────────────────────────

  describe('bank payment and allocation', () => {
    it('writes payment and allocation together and survives a failing job queue', async () => {
      const order = await createOrder(4990);
      const txId = await createCredit(4990, order.reference);
      const result = await matchBankTransaction(ctx, txId);
      expect(result).toMatchObject({ status: 'AUTO_MATCHED', orderIds: [order.id] });
      expect((await orderRow(order.id)).status).toBe('PAID');
      // The `order-paid` job could not be queued (Redis down): no exception, state intact.
      expect(failingJobs.add).toHaveBeenCalled();
      const rows = await allocations(txId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ amount: 4990, method: 'AUTO', orderId: order.id });
      expect(rows[0]!.paymentId).not.toBeNull();
    });

    it('recordPayment with bankAllocation is idempotent for the same bank transaction', async () => {
      const order = await createOrder(1500);
      const txId = await createCredit(1500, order.reference);
      const receipt = {
        orderId: order.id,
        amount: 1500,
        currency: 'EUR',
        method: 'BANK_TRANSFER' as const,
        bankTransactionId: txId,
        actor: { type: 'SYSTEM' as const },
        bankAllocation: { method: 'AUTO' as const },
      };
      const first = await recordPayment(ctx, receipt);
      const second = await recordPayment(ctx, receipt);
      expect(first.status).toBe('PAID');
      expect(second.status).toBe('DUPLICATE');
      expect(await allocations(txId)).toHaveLength(1);
    });

    it('repairs a payment without allocation before assigning, so the money cannot be used twice', async () => {
      const first = await createOrder(3000);
      const second = await createOrder(3000);
      const txId = await createCredit(3000, first.reference);
      // Legacy / crashed state: payment committed, allocation never written.
      await handle.db.insert(payments).values({
        orderId: first.id,
        method: 'BANK_TRANSFER',
        status: 'CAPTURED',
        amount: 3000,
        currency: 'EUR',
        bankTransactionId: txId,
        capturedAt: new Date(),
      });
      await handle.db
        .update(orders)
        .set({ status: 'PAID', amountPaid: 3000, paidAt: new Date() })
        .where(eq(orders.id, first.id));
      expect(await allocations(txId)).toHaveLength(0);

      await expect(
        assignBankTransaction(ctx, {
          transactionId: txId,
          orderId: second.id,
          userId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'TX_RESOLVED' });
      const rows = await allocations(txId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ orderId: first.id, amount: 3000 });
      expect((await orderRow(second.id)).amountPaid).toBe(0);
    });

    it('repairs before matching: a transaction with an orphan payment is not matched again', async () => {
      const first = await createOrder(2000);
      const other = await createOrder(2000);
      const txId = await createCredit(2000, other.reference);
      await handle.db.insert(payments).values({
        orderId: first.id,
        method: 'BANK_TRANSFER',
        status: 'CAPTURED',
        amount: 2000,
        currency: 'EUR',
        bankTransactionId: txId,
        capturedAt: new Date(),
      });
      const result = await matchBankTransaction(ctx, txId);
      expect(result?.status).toBe('MANUALLY_MATCHED');
      expect((await orderRow(other.id)).status).toBe('AWAITING_PAYMENT');
      expect(await allocations(txId)).toHaveLength(1);
    });

    it('routes an order that became paid concurrently to the review queue as overpayment', async () => {
      const order = await createOrder(2500);
      const txId = await createCredit(2500, order.reference);
      hooks.beforeRecordPayment = async () => {
        // PayPal (or another transfer) completed the order between matching and booking.
        await handle.db
          .update(orders)
          .set({ status: 'PAID', amountPaid: 2500, paidAt: new Date() })
          .where(eq(orders.id, order.id));
      };
      try {
        const result = await matchBankTransaction(ctx, txId);
        expect(result).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'OVERPAYMENT' });
      } finally {
        hooks.beforeRecordPayment = undefined;
      }
      const tx = await txRow(txId);
      expect(tx).toMatchObject({ matchStatus: 'NEEDS_REVIEW', reviewReason: 'OVERPAYMENT' });
      // The money is booked (overpayment on the order) and allocated – a human decides on the refund.
      expect((await orderRow(order.id)).amountPaid).toBe(5000);
      expect(await allocations(txId)).toHaveLength(1);
    });
  });

  // ─── A6a: guest checkout vs registered account ────────────────────────────────

  describe('upsertCustomer', () => {
    const address = {
      street: 'Neue Strasse 5',
      postalCode: '10115',
      city: 'Berlin',
      country: 'DE',
    };
    const input = (email: string) => ({
      email,
      firstName: 'Guest',
      lastName: 'Buyer',
      company: undefined,
      phone: '+49 30 999999',
      address,
      locale: 'de' as const,
    });

    it('keeps phone and address of a registered account', async () => {
      const stored = {
        street: 'Alte Strasse 1',
        postalCode: '65462',
        city: 'Ginsheim',
        country: 'DE',
      };
      await handle.db.insert(customers).values({
        email: 'registered@example.invalid',
        firstName: 'Reg',
        lastName: 'Istered',
        passwordHash: '$argon2id$placeholder',
        accountCreatedAt: new Date(),
        phone: '+49 6134 1',
        address: stored,
      });
      const id = await withTransaction(handle.db, (tx) =>
        upsertCustomer(tx, input('Registered@Example.invalid')),
      );
      const [row] = await handle.db.select().from(customers).where(eq(customers.id, id));
      expect(row).toMatchObject({ phone: '+49 6134 1', address: stored, firstName: 'Reg' });
    });

    it('still refreshes phone and address of a guest-only record', async () => {
      await handle.db.insert(customers).values({
        email: 'guest@example.invalid',
        firstName: 'Old',
        lastName: 'Name',
        phone: '+49 1',
      });
      const id = await withTransaction(handle.db, (tx) =>
        upsertCustomer(tx, input('guest@example.invalid')),
      );
      const [row] = await handle.db.select().from(customers).where(eq(customers.id, id));
      expect(row).toMatchObject({ phone: '+49 30 999999', address, firstName: 'Guest' });
    });
  });
});
