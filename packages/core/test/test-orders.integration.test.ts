/**
 * Super-admin test purchases on DRAFT events: shop access per actor, queue bypass, sale-window
 * bypass, test orders (own number series, no invoice number consumed, excluded from statistics
 * and accounting), mixed carts, and the deletion rules. Real PostgreSQL + Redis.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  accessCodeRedemptions,
  accessCodes,
  auditLogs,
  bankAccounts,
  bankTransactionAllocations,
  bankTransactions,
  createDb,
  emailMessages,
  events,
  invoices,
  loadRootEnv,
  numberSequences,
  orderItems,
  orders,
  payments,
  priceCategories,
  priceCategoryTicketTypes,
  refunds,
  seatMaps,
  taxRates,
  ticketTypes,
  tickets,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { seedReferenceData } from '@tix/db/seed';
import { checkoutInputSchema, type CheckoutInput, type SeatMapDocumentInput } from '@tix/shared';
import { extractPdfText } from './pdf-extract';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { and, eq, like, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addSeats,
  afterSeatMapSaved,
  assignBankTransaction,
  buildAccountingCsv,
  cancelAndHideTestOrder,
  cartHasDraftEvents,
  changeEventStatus,
  createCoreContext,
  deleteTestOrder,
  deleteTestOrdersOfEvent,
  ensureApplePass,
  ensureEventSigningKey,
  ensureGoogleSaveUrl,
  enterShop,
  eventPublicKeys,
  getDashboardData,
  getEventById,
  getSalesStatistics,
  getSyncEpoch,
  loadAccountingData,
  matchBankTransaction,
  renderOrderTicketsPdf,
  placeOrder,
  processPaidOrder,
  queueStatus,
  recordPayment,
  renderEmail,
  requireShopAccess,
  saveSecretSetting,
  saveSeatMapDocument,
  saveSetting,
  searchOrders,
  summarizeTestOrders,
  ticketEmailLinks,
  walletLinksForOrder,
  type CoreContext,
  type EventRow,
  type JobQueues,
  type ShopActor,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();

const SUPER: ShopActor = { superAdmin: true };

describe.skipIf(!adminUrl || !redisUrl)('super-admin test purchases (integration)', () => {
  const dbName = `tix_testorders_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let draft: EventRow;
  let published: EventRow;
  let paused: EventRow;
  let draftSeats: string[] = [];
  let publishedSeats: string[] = [];
  let pausedSeats: string[] = [];
  let userId: string;
  const jobs = { add: vi.fn(async () => undefined), close: async () => {} };
  const sid = () => `k${uuid().slice(0, 8)}`;

  const buyer = (method: CheckoutInput['method'], expectedTotalGross: number): CheckoutInput =>
    checkoutInputSchema.parse({
      method,
      email: 'tester@example.invalid',
      firstName: 'Erika',
      lastName: 'Tester',
      phone: '+49 6134 123456',
      address: { street: 'Hauptstrasse 1', postalCode: '65462', city: 'Ginsheim', country: 'DE' },
      acceptTerms: true,
      expectedTotalGross,
      locale: 'de',
    });
  const takenCode = async (event: EventRow, seatId: string) =>
    (await ctx.seats.takenSeats(event.id))[seatId] ?? null;
  const invoiceSequence = async () =>
    (await handle.db.select().from(numberSequences).where(like(numberSequences.scope, 'invoice:%')))
      .map((r) => `${r.scope}=${r.lastValue}`)
      .sort();

  async function createEvent(
    status: EventRow['status'],
    overrides: Partial<typeof events.$inferInsert> = {},
  ): Promise<{ event: EventRow; seatIds: string[] }> {
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
        title: `Show ${status}`,
        status,
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: tax!.id,
        orphanSeatRuleEnabled: false,
        ...overrides,
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
      seats: Array.from({ length: 8 }, (_, i) => ({
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
    return { event: await getEventById(ctx, ev!.id), seatIds: doc.seats!.map((s) => s.id!) };
  }

  /** Cart of one seat → order as the given actor. */
  async function buy(
    event: EventRow,
    seatId: string,
    actor: ShopActor | null,
    method: CheckoutInput['method'] = 'BANK_TRANSFER',
  ) {
    const session = sid();
    await addSeats(ctx, session, event, [seatId]);
    return placeOrder(ctx, {
      sessionId: session,
      input: buyer(method, 3000),
      actor,
    });
  }

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
    await seedReferenceData(handle.db, () => {});
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
    const [user] = (
      await handle.db.execute<{ id: string }>(
        sql`INSERT INTO admin_users (email, display_name, password_hash, roles)
            VALUES ('root@example.invalid', 'Root', 'x', ARRAY['SUPER_ADMIN']::admin_role[])
            RETURNING id`,
      )
    ).rows;
    userId = user!.id;
    await handle.db.insert(bankAccounts).values({
      name: 'Main',
      accountHolder: 'Example Theatre e.V.',
      iban: 'DE89370400440532013000',
      currency: 'EUR',
      isDefaultForBankTransfer: true,
    });
    ({ event: draft, seatIds: draftSeats } = await createEvent('DRAFT'));
    ({ event: published, seatIds: publishedSeats } = await createEvent('PUBLISHED'));
    ({ event: paused, seatIds: pausedSeats } = await createEvent('PUBLISHED', {
      salesPaused: true,
    }));
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

  it('refuses drafts for customers and non super-admin actors, allows them for super-admins', async () => {
    const session = sid();
    await expect(requireShopAccess(ctx, draft, session, undefined)).rejects.toMatchObject({
      code: 'SALE_CLOSED',
    });
    await expect(
      requireShopAccess(ctx, draft, session, undefined, { superAdmin: false }),
    ).rejects.toMatchObject({ code: 'SALE_CLOSED' });
    await expect(requireShopAccess(ctx, draft, session, undefined, SUPER)).resolves.toBeUndefined();
    expect((await enterShop(ctx, draft, session)).status).toBe('CLOSED');
    expect((await enterShop(ctx, draft, session, { superAdmin: false })).status).toBe('CLOSED');
    // A customer cannot place an order on a draft even with a filled cart.
    await addSeats(ctx, session, draft, [draftSeats[7]!]);
    await expect(
      placeOrder(ctx, { sessionId: session, input: buyer('BANK_TRANSFER', 3000) }),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_ON_SALE' });
    await expect(
      placeOrder(ctx, {
        sessionId: session,
        input: buyer('BANK_TRANSFER', 3000),
        actor: { superAdmin: false },
      }),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_ON_SALE' });
    expect(await cartHasDraftEvents(ctx, session)).toBe(true);
  });

  it('bypasses the sale window only for super-admins, on published events too', async () => {
    const session = sid();
    await expect(requireShopAccess(ctx, paused, session, undefined)).rejects.toMatchObject({
      code: 'SALE_CLOSED',
    });
    await expect(
      requireShopAccess(ctx, paused, session, undefined, SUPER),
    ).resolves.toBeUndefined();
    const future = { ...published, publicSaleStartsAt: new Date(Date.now() + 3_600_000) };
    await expect(requireShopAccess(ctx, future, session, undefined)).rejects.toMatchObject({
      code: 'SALE_CLOSED',
    });
    await expect(
      requireShopAccess(ctx, future, session, undefined, SUPER),
    ).resolves.toBeUndefined();
    // Not-yet-started event of a super-admin is a NORMAL order.
    const order = await buy(paused, pausedSeats[0]!, SUPER);
    const [row] = await handle.db.select().from(orders).where(eq(orders.id, order.orderId));
    expect(row!.isTest).toBe(false);
    expect(row!.orderNumber.startsWith('TEST-')).toBe(false);
  });

  it('skips the waiting room for super-admins without using queue capacity, unless testing it', async () => {
    const session = sid();
    const decision = await enterShop(ctx, published, session, SUPER);
    expect(decision.status).toBe('GRANTED');
    expect(await redis.zcard(ctx.keys.queueActive(published.id))).toBe(0);
    expect((await queueStatus(ctx, published, session, SUPER)).status).toBe('GRANTED');
    // No pass cookie needed for the bypassing admin ...
    await expect(
      requireShopAccess(ctx, published, session, undefined, SUPER),
    ).resolves.toBeUndefined();
    // ... but the admin who switched "test the waiting room" on needs a real pass like a customer.
    await expect(
      requireShopAccess(ctx, published, session, undefined, { superAdmin: true, queueTest: true }),
    ).rejects.toMatchObject({ code: 'PASS_REQUIRED' });
    // A pass signed for the bypass is worthless for anybody else.
    if (decision.status !== 'GRANTED') throw new Error('unreachable');
    await expect(
      requireShopAccess(ctx, published, session, decision.passToken, null),
    ).rejects.toMatchObject({ code: 'PASS_REQUIRED' });
    // Queue test mode enters the real flow (mode OFF here → regular pass, counted as active).
    const real = await enterShop(ctx, published, session, { superAdmin: true, queueTest: true });
    expect(real.status).toBe('GRANTED');
    expect(await redis.zcard(ctx.keys.queueActive(published.id))).toBeGreaterThan(0);
    if (real.status !== 'GRANTED') throw new Error('unreachable');
    await expect(
      requireShopAccess(ctx, published, session, real.passToken, {
        superAdmin: true,
        queueTest: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('creates test orders on drafts: own number series, no invoice number consumed, paid fulfilment', async () => {
    const before = await invoiceSequence();
    const order = await buy(draft, draftSeats[0]!, SUPER);
    expect(order.orderNumber).toMatch(/^TEST-\d{4}-\d{4}$/);
    const [row] = await handle.db.select().from(orders).where(eq(orders.id, order.orderId));
    expect(row!.isTest).toBe(true);
    expect(await takenCode(draft, draftSeats[0]!)).toBe('R');

    const paid = await recordPayment(ctx, {
      orderId: order.orderId,
      amount: order.totalGross,
      currency: 'EUR',
      method: 'BANK_TRANSFER',
      actor: { type: 'SYSTEM' },
    });
    expect(paid.status).toBe('PAID');
    const result = await processPaidOrder(ctx, order.orderId);
    expect(result.invoiceId).toBeNull();
    expect(result.ticketCount).toBe(1);
    expect(
      await handle.db.select().from(invoices).where(eq(invoices.orderId, order.orderId)),
    ).toHaveLength(0);
    expect(await invoiceSequence()).toEqual(before);

    // Ticket PDFs carry the watermark.
    const pdf = await renderOrderTicketsPdf(ctx, order.orderId, { store: false });
    const pdfText = await extractPdfText(pdf.bytes);
    expect(JSON.stringify(pdfText)).toContain('TESTBESTELLUNG');

    // Every e-mail of a test order is marked.
    const mail = await renderEmail(ctx, {
      key: 'ORDER_CONFIRMATION_BANK_TRANSFER',
      orderId: order.orderId,
    });
    expect(mail.subject.startsWith('[TEST] ')).toBe(true);
    expect(mail.text).toContain('TESTBESTELLUNG');
    expect(mail.html).toContain('TESTBESTELLUNG');
  });

  it('refuses a cart that mixes draft and published events', async () => {
    const session = sid();
    await addSeats(ctx, session, draft, [draftSeats[1]!]);
    await addSeats(ctx, session, published, [publishedSeats[0]!]);
    await expect(
      placeOrder(ctx, { sessionId: session, input: buyer('BANK_TRANSFER', 6000), actor: SUPER }),
    ).rejects.toMatchObject({ code: 'TEST_ORDER_MIXED_CART' });
  });

  it('keeps test orders out of statistics, dashboard and accounting', async () => {
    const [testOrder] = await handle.db
      .select()
      .from(orders)
      .where(eq(orders.isTest, true))
      .limit(1);
    expect(testOrder!.paidAt).not.toBeNull();
    const stats = await getSalesStatistics(handle, {
      preset: '7d',
      eventIds: [],
      channels: [],
      methods: [],
      now: new Date(Date.now() + 60_000),
    });
    expect(stats.kpis.current.orders).toBe(0);
    expect(stats.kpis.current.revenueGross).toBe(0);
    const dashboard = await getDashboardData(ctx, {
      money: true,
      inventory: false,
      checkIn: false,
    });
    expect(dashboard.kpis?.revenueTodayCents).toBe(0);
    const [realToday] = (
      await handle.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM orders WHERE NOT is_test AND status IN ('AWAITING_PAYMENT','PAID')`,
      )
    ).rows;
    // Only the real orders count (the test order is paid and would add one more).
    expect(dashboard.kpis?.ordersToday).toBe(realToday!.n);
    const day = new Date().toISOString().slice(0, 10);
    const accounting = await loadAccountingData(handle.db, { from: day, to: day }, 'UTC');
    // Test orders never produce documents (no invoice number) – but real money received on one
    // stays visible in the payment lines, marked TEST.
    expect(accounting.documents).toHaveLength(0);
    expect(accounting.payments.length).toBeGreaterThan(0);
    expect(accounting.payments.every((p) => p.isTest)).toBe(true);
    // The order list shows them with a flag and can filter.
    const all = await searchOrders(ctx, {});
    expect(all.rows.some((r) => r.isTest)).toBe(true);
    expect((await searchOrders(ctx, { tests: 'hide' })).rows.some((r) => r.isTest)).toBe(false);
    expect((await searchOrders(ctx, { tests: 'only' })).rows.every((r) => r.isTest)).toBe(true);
  });

  it('deletes unpaid test orders completely and releases their seats', async () => {
    const order = await buy(draft, draftSeats[2]!, SUPER);
    expect(await takenCode(draft, draftSeats[2]!)).toBe('R');
    const [item] = await handle.db
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.orderId));
    expect(item).toBeDefined();
    const result = await deleteTestOrder(ctx, { orderId: order.orderId, userId });
    expect(result).toMatchObject({ deleted: true });
    expect(await handle.db.select().from(orders).where(eq(orders.id, order.orderId))).toHaveLength(
      0,
    );
    expect(
      await handle.db.select().from(orderItems).where(eq(orderItems.orderId, order.orderId)),
    ).toHaveLength(0);
    expect(
      await handle.db.select().from(emailMessages).where(eq(emailMessages.orderId, order.orderId)),
    ).toHaveLength(0);
    expect(await takenCode(draft, draftSeats[2]!)).toBeNull();
    const [audit] = await handle.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'order.test.delete'), eq(auditLogs.entityId, order.orderId)));
    expect(audit?.actorUserId).toBe(userId);
    // The seat can be bought again.
    const again = await buy(draft, draftSeats[2]!, SUPER);
    expect(again.orderId).not.toBe(order.orderId);
    await deleteTestOrder(ctx, { orderId: again.orderId, userId });
  });

  it('refuses to delete real orders, orders with captured money and orders with an open payment', async () => {
    const real = await buy(published, publishedSeats[1]!, null);
    await expect(deleteTestOrder(ctx, { orderId: real.orderId, userId })).rejects.toMatchObject({
      code: 'NOT_A_TEST_ORDER',
    });

    const [paidTest] = await handle.db
      .select()
      .from(orders)
      .where(and(eq(orders.isTest, true), eq(orders.status, 'PAID')));
    const held = await deleteTestOrder(ctx, { orderId: paidTest!.id, userId });
    expect(held).toMatchObject({ deleted: false, blocker: 'MONEY_CAPTURED' });
    expect(await handle.db.select().from(orders).where(eq(orders.id, paidTest!.id))).toHaveLength(
      1,
    );

    const open = await buy(draft, draftSeats[3]!, SUPER);
    await handle.db.insert(payments).values({
      orderId: open.orderId,
      method: 'PAYPAL',
      status: 'CREATED',
      amount: open.totalGross,
      currency: 'EUR',
      providerOrderId: `PP-${uuid()}`,
    });
    // PayPal is not configured here: the reconcile attempt fails and the attempt stays open.
    expect(await deleteTestOrder(ctx, { orderId: open.orderId, userId })).toMatchObject({
      deleted: false,
      blocker: 'PAYMENT_OPEN',
    });
    await handle.db.delete(payments).where(eq(payments.orderId, open.orderId));
    expect(await deleteTestOrder(ctx, { orderId: open.orderId, userId })).toMatchObject({
      deleted: true,
    });
  });

  it('checks open PayPal attempts at PayPal before refusing to delete', async () => {
    await saveSetting(
      ctx,
      'paypal',
      { enabled: true, clientId: 'client-id', webhookId: 'WH-1' },
      null,
    );
    await saveSecretSetting(ctx, 'paypal.credentials', { clientSecret: 'client-secret' }, null);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    try {
      // 1. Abandoned attempt: PayPal says CREATED (never approved) → the attempt is cancelled and
      //    the order becomes deletable.
      const abandoned = await buy(draft, draftSeats[3]!, SUPER);
      const providerOrderId = `PP-${uuid()}`;
      await handle.db.insert(payments).values({
        orderId: abandoned.orderId,
        method: 'PAYPAL',
        status: 'CREATED',
        amount: abandoned.totalGross,
        currency: 'EUR',
        providerOrderId,
      });
      const calls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL, init?: RequestInit) => {
          const url = String(input);
          calls.push(`${init?.method ?? 'GET'} ${url.replace(/^https:\/\/[^/]+/, '')}`);
          if (url.endsWith('/v1/oauth2/token'))
            return json({ access_token: 'tok', expires_in: 3600 });
          return json({ id: providerOrderId, status: 'CREATED' });
        }),
      );
      expect(await deleteTestOrder(ctx, { orderId: abandoned.orderId, userId })).toMatchObject({
        deleted: true,
      });
      expect(calls).toContain(`GET /v2/checkout/orders/${providerOrderId}`);
      vi.unstubAllGlobals();

      // 2. PayPal unreachable: the open attempt keeps the order.
      const unreachable = await buy(draft, draftSeats[3]!, SUPER);
      await handle.db.insert(payments).values({
        orderId: unreachable.orderId,
        method: 'PAYPAL',
        status: 'CREATED',
        amount: unreachable.totalGross,
        currency: 'EUR',
        providerOrderId: `PP-${uuid()}`,
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL) => {
          if (String(input).endsWith('/v1/oauth2/token'))
            return json({ access_token: 'tok', expires_in: 3600 });
          throw new Error('network down');
        }),
      );
      expect(await deleteTestOrder(ctx, { orderId: unreachable.orderId, userId })).toMatchObject({
        deleted: false,
        blocker: 'PAYMENT_OPEN',
      });
      await handle.db.delete(payments).where(eq(payments.orderId, unreachable.orderId));
      expect(await deleteTestOrder(ctx, { orderId: unreachable.orderId, userId })).toMatchObject({
        deleted: true,
      });
    } finally {
      vi.unstubAllGlobals();
      await saveSetting(ctx, 'paypal', { enabled: false, clientId: '', webhookId: '' }, null);
    }
  });

  it('never deletes a test order that held real money, even fully refunded: cancel & hide instead', async () => {
    const [paidTest] = await handle.db
      .select()
      .from(orders)
      .where(and(eq(orders.isTest, true), eq(orders.status, 'PAID')));
    expect(await deleteTestOrder(ctx, { orderId: paidTest!.id, userId })).toMatchObject({
      deleted: false,
      blocker: 'MONEY_CAPTURED',
    });

    const result = await cancelAndHideTestOrder(ctx, { orderId: paidTest!.id, userId });
    expect(result.refundTotal).toBe(paidTest!.totalGross);
    const [after] = await handle.db.select().from(orders).where(eq(orders.id, paidTest!.id));
    expect(['CANCELLED', 'REFUNDED']).toContain(after!.status);
    expect(after!.testHiddenAt).not.toBeNull();
    // Tickets are void, no credit note / invoice exists for a test order.
    expect(
      (await handle.db.select().from(tickets).where(eq(tickets.orderId, paidTest!.id))).every(
        (t) => t.status !== 'VALID',
      ),
    ).toBe(true);
    expect(
      await handle.db.select().from(invoices).where(eq(invoices.orderId, paidTest!.id)),
    ).toHaveLength(0);
    const refundRows = await handle.db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, paidTest!.id));
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]!.method).toBe('BANK_TRANSFER');
    // The finance team pays the bank transfer back and marks the refund as done.
    await handle.db
      .update(refunds)
      .set({ status: 'SUCCEEDED', processedAt: new Date() })
      .where(eq(refunds.id, refundRows[0]!.id));

    // Idempotent; still not deletable although everything was refunded.
    expect((await cancelAndHideTestOrder(ctx, { orderId: paidTest!.id, userId })).refundTotal).toBe(
      0,
    );
    expect(await deleteTestOrder(ctx, { orderId: paidTest!.id, userId })).toMatchObject({
      deleted: false,
      blocker: 'MONEY_CAPTURED',
    });

    // Hidden from the default list, found by the test filter and by search.
    expect((await searchOrders(ctx, {})).rows.some((r) => r.id === paidTest!.id)).toBe(false);
    expect(
      (await searchOrders(ctx, { tests: 'only' })).rows.some((r) => r.id === paidTest!.id),
    ).toBe(true);
    expect(
      (await searchOrders(ctx, { q: paidTest!.orderNumber })).rows.some(
        (r) => r.id === paidTest!.id && r.testHidden,
      ),
    ).toBe(true);

    // Accounting: the payment and the refund stay in the export, marked TEST, never as a document.
    const day = new Date().toISOString().slice(0, 10);
    const accounting = await loadAccountingData(handle.db, { from: day, to: day }, 'UTC');
    expect(accounting.documents).toHaveLength(0);
    const testPayments = accounting.payments.filter((p) => p.orderNumber === paidTest!.orderNumber);
    expect(testPayments).toHaveLength(1);
    expect(testPayments[0]).toMatchObject({
      isTest: true,
      voucher: paidTest!.orderNumber,
      amount: paidTest!.totalGross,
    });
    const testRefunds = accounting.refunds.filter((r) => r.orderNumber === paidTest!.orderNumber);
    expect(testRefunds).toHaveLength(1);
    expect(testRefunds[0]).toMatchObject({ isTest: true, creditNoteNumber: null });
    const csv = buildAccountingCsv('payments', accounting, {}, 'UTC').body;
    expect(csv).toContain(`${paidTest!.orderNumber};`);
    expect(csv.split('\r\n').filter((l) => l.includes(paidTest!.orderNumber))).toSatisfy(
      (lines: string[]) => lines.every((l) => l.endsWith(';TEST')),
    );
  });

  it('refuses to delete a bank-paid test order (allocation exists) and leaves the bank transaction alone', async () => {
    const order = await buy(draft, draftSeats[6]!, SUPER);
    const [account] = await handle.db.select().from(bankAccounts).limit(1);
    const [bankTx] = await handle.db
      .insert(bankTransactions)
      .values({
        bankAccountId: account!.id,
        fingerprint: `fp-${uuid()}`,
        bookingDate: new Date().toISOString().slice(0, 10),
        amount: order.totalGross,
        currency: 'EUR',
        remittanceInformation: order.paymentReference,
        matchStatus: 'AUTO_MATCHED',
        matchCandidates: [{ orderId: order.orderId } as never],
      })
      .returning();
    const paid = await recordPayment(ctx, {
      orderId: order.orderId,
      amount: order.totalGross,
      currency: 'EUR',
      method: 'BANK_TRANSFER',
      bankTransactionId: bankTx!.id,
      bankAllocation: { method: 'AUTO' },
      actor: { type: 'SYSTEM' },
    });
    expect(paid.status).toBe('PAID');
    expect(await deleteTestOrder(ctx, { orderId: order.orderId, userId })).toMatchObject({
      deleted: false,
      blocker: 'MONEY_CAPTURED',
    });
    expect(
      await handle.db
        .select()
        .from(bankTransactionAllocations)
        .where(eq(bankTransactionAllocations.orderId, order.orderId)),
    ).toHaveLength(1);
    const [after] = await handle.db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, bankTx!.id));
    expect(after!.matchStatus).toBe('AUTO_MATCHED');
    expect(after!.matchCandidates).toHaveLength(1);
    // Real money on a test order: cancel & hide pays it back through the normal refund flow.
    const hidden = await cancelAndHideTestOrder(ctx, { orderId: order.orderId, userId });
    expect(hidden.refundTotal).toBe(order.totalGross);
  });

  it('summarises and bulk-deletes the test orders of an event, reporting the ones that can only be cancelled', async () => {
    const { event: bulk, seatIds } = await createEvent('DRAFT');
    const a = await buy(bulk, seatIds[4]!, SUPER);
    const b = await buy(bulk, seatIds[5]!, SUPER);
    await recordPayment(ctx, {
      orderId: b.orderId,
      amount: b.totalGross,
      currency: 'EUR',
      method: 'BANK_TRANSFER',
      actor: { type: 'SYSTEM' },
    });
    const summary = await summarizeTestOrders(ctx, bulk.id);
    expect(summary).toMatchObject({ orders: 2, withMoney: 1, hidden: 0 });
    const result = await deleteTestOrdersOfEvent(ctx, { eventId: bulk.id, userId });
    expect(result.deleted).toBe(1);
    expect(result.kept.map((k) => k.orderId)).toEqual([b.orderId]);
    expect(result.kept.every((k) => k.blocker === 'MONEY_CAPTURED')).toBe(true);
    expect(await handle.db.select().from(orders).where(eq(orders.id, a.orderId))).toHaveLength(0);
    expect(await takenCode(bulk, seatIds[4]!)).toBeNull();
    expect((await summarizeTestOrders(ctx, bulk.id)).orders).toBe(1);
  });

  it('releases access-code redemptions and prunes review candidates when deleting', async () => {
    const { event: ev, seatIds } = await createEvent('DRAFT');
    const order = await buy(ev, seatIds[0]!, SUPER);
    const other = await buy(ev, seatIds[1]!, SUPER);
    const [row] = await handle.db.select().from(orders).where(eq(orders.id, order.orderId));
    const [code] = await handle.db
      .insert(accessCodes)
      .values({
        eventId: ev.id,
        code: `ONCE-${uuid().slice(0, 6).toUpperCase()}`,
        type: 'SINGLE_USE',
        maxRedemptions: 1,
        redemptionCount: 1,
      })
      .returning();
    await handle.db
      .update(orderItems)
      .set({ accessCodeId: code!.id })
      .where(eq(orderItems.orderId, order.orderId));
    await handle.db
      .insert(accessCodeRedemptions)
      .values({ accessCodeId: code!.id, sessionId: row!.cartSessionId });

    const [account] = await handle.db.select().from(bankAccounts).limit(1);
    const tx = async (candidates: { orderId: string }[]) =>
      (
        await handle.db
          .insert(bankTransactions)
          .values({
            bankAccountId: account!.id,
            fingerprint: `fp-${uuid()}`,
            bookingDate: new Date().toISOString().slice(0, 10),
            amount: 1234,
            currency: 'EUR',
            matchStatus: 'NEEDS_REVIEW',
            reviewReason: 'NO_REFERENCE',
            matchCandidates: candidates.map((c) => ({
              ...c,
              orderNumber: 'X',
              score: 50,
            })) as never,
          })
          .returning()
      )[0]!;
    const onlyThis = await tx([{ orderId: order.orderId }]);
    const both = await tx([{ orderId: order.orderId }, { orderId: other.orderId }]);

    expect(await deleteTestOrder(ctx, { orderId: order.orderId, userId })).toMatchObject({
      deleted: true,
    });
    expect(
      await handle.db
        .select()
        .from(accessCodeRedemptions)
        .where(eq(accessCodeRedemptions.accessCodeId, code!.id)),
    ).toHaveLength(0);
    const [codeAfter] = await handle.db
      .select()
      .from(accessCodes)
      .where(eq(accessCodes.id, code!.id));
    expect(codeAfter!.redemptionCount).toBe(0);
    const [a] = await handle.db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, onlyThis.id));
    expect(a!.matchCandidates).toEqual([]);
    const [b] = await handle.db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, both.id));
    expect(b!.matchCandidates!.map((c) => c.orderId)).toEqual([other.orderId]);
    await deleteTestOrder(ctx, { orderId: other.orderId, userId });
  });

  it('rotates the scanner sync epoch only when deleted test orders had tickets', async () => {
    const { event: ev, seatIds } = await createEvent('DRAFT');
    const plain = await buy(ev, seatIds[0]!, SUPER);
    const epoch0 = await getSyncEpoch(handle.db);
    await deleteTestOrder(ctx, { orderId: plain.orderId, userId });
    expect(await getSyncEpoch(handle.db)).toBe(epoch0);

    // A test order with tickets but no money (e.g. marked paid by hand).
    const withTickets = await buy(ev, seatIds[1]!, SUPER);
    await handle.db
      .update(orders)
      .set({ status: 'PAID', paidAt: new Date() })
      .where(eq(orders.id, withTickets.orderId));
    await handle.db
      .update(orderItems)
      .set({ status: 'CONFIRMED' })
      .where(eq(orderItems.orderId, withTickets.orderId));
    expect((await processPaidOrder(ctx, withTickets.orderId)).ticketCount).toBe(1);
    expect(await getSyncEpoch(handle.db)).toBe(epoch0);
    expect(await deleteTestOrder(ctx, { orderId: withTickets.orderId, userId })).toMatchObject({
      deleted: true,
    });
    expect(await getSyncEpoch(handle.db)).not.toBe(epoch0);
  });

  it('does not render or store ticket PDFs of deleted orders', async () => {
    const { event: ev, seatIds } = await createEvent('DRAFT');
    const objects = new Map<string, Uint8Array>();
    const storage = {
      put: vi.fn(async (_bucket: string, key: string, body: Uint8Array) => {
        objects.set(key, body);
      }),
      get: vi.fn(),
      delete: vi.fn(async (_bucket: string, key: string) => {
        objects.delete(key);
      }),
    };
    const storageCtx = { ...ctx, storage: storage as unknown as CoreContext['storage'] };
    const order = await buy(ev, seatIds[0]!, SUPER);
    await handle.db
      .update(orders)
      .set({ status: 'PAID', paidAt: new Date() })
      .where(eq(orders.id, order.orderId));
    await handle.db
      .update(orderItems)
      .set({ status: 'CONFIRMED' })
      .where(eq(orderItems.orderId, order.orderId));
    await processPaidOrder(ctx, order.orderId);

    // The order disappears while the PDF is written: the object is removed again.
    storage.put.mockImplementationOnce(async (_bucket: string, key: string, body: Uint8Array) => {
      objects.set(key, body);
      await deleteTestOrder(ctx, { orderId: order.orderId, userId });
    });
    await expect(renderOrderTicketsPdf(storageCtx, order.orderId)).rejects.toMatchObject({
      code: 'NO_TICKETS',
    });
    expect(objects.size).toBe(0);
    // Afterwards the order is simply gone: nothing is rendered, nothing is written.
    storage.put.mockClear();
    await expect(renderOrderTicketsPdf(storageCtx, order.orderId)).rejects.toMatchObject({
      code: 'ORDER_NOT_FOUND',
    });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('never matches bank transfers to test orders automatically and offers them only on explicit confirmation', async () => {
    const { event: ev, seatIds } = await createEvent('DRAFT');
    const order = await buy(ev, seatIds[0]!, SUPER);
    const [account] = await handle.db.select().from(bankAccounts).limit(1);
    const insertTx = async (over: Partial<typeof bankTransactions.$inferInsert>) =>
      (
        await handle.db
          .insert(bankTransactions)
          .values({
            bankAccountId: account!.id,
            fingerprint: `fp-${uuid()}`,
            bookingDate: new Date().toISOString().slice(0, 10),
            amount: order.totalGross,
            currency: 'EUR',
            ...over,
          })
          .returning()
      )[0]!;

    // Exact reference + exact amount of a TEST order → review, never auto-fulfilled.
    const exact = await insertTx({ remittanceInformation: order.paymentReference });
    const result = await matchBankTransaction(ctx, exact.id);
    expect(result).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'ORDER_NOT_PAYABLE' });
    const [exactAfter] = await handle.db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, exact.id));
    expect(exactAfter!.matchCandidates![0]!.reasons).toContain('TEST_ORDER');
    const [stillOpen] = await handle.db.select().from(orders).where(eq(orders.id, order.orderId));
    expect(stillOpen!.status).toBe('AWAITING_PAYMENT');
    expect(
      await handle.db.select().from(payments).where(eq(payments.orderId, order.orderId)),
    ).toHaveLength(0);

    // Name + amount similarity never proposes a test order.
    const byName = await insertTx({
      counterpartyName: 'Max Muster',
      remittanceInformation: 'Tickets',
    });
    await matchBankTransaction(ctx, byName.id);
    const [byNameAfter] = await handle.db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, byName.id));
    expect((byNameAfter!.matchCandidates ?? []).map((c) => c.orderId)).not.toContain(order.orderId);

    // Manual assignment needs the explicit confirmation.
    await expect(
      assignBankTransaction(ctx, { transactionId: exact.id, orderId: order.orderId, userId }),
    ).rejects.toMatchObject({ code: 'TEST_ORDER_CONFIRM_REQUIRED' });
    const assigned = await assignBankTransaction(ctx, {
      transactionId: exact.id,
      orderId: order.orderId,
      userId,
      confirmTestOrder: true,
    });
    expect(assigned.payment).toBe('PAID');
  });

  it('issues no wallet passes for test orders', async () => {
    const { event: ev, seatIds } = await createEvent('DRAFT');
    const order = await buy(ev, seatIds[0]!, SUPER);
    await handle.db
      .update(orders)
      .set({ status: 'PAID', paidAt: new Date() })
      .where(eq(orders.id, order.orderId));
    await handle.db
      .update(orderItems)
      .set({ status: 'CONFIRMED' })
      .where(eq(orderItems.orderId, order.orderId));
    await processPaidOrder(ctx, order.orderId);
    const [ticket] = await handle.db
      .select()
      .from(tickets)
      .where(eq(tickets.orderId, order.orderId));
    expect(await walletLinksForOrder(ctx, order.orderId)).toEqual([]);
    const links = await ticketEmailLinks(ctx, order.orderId);
    expect(links).toHaveLength(1);
    expect(links[0]!.appleUrl).toBeUndefined();
    expect(links[0]!.googleUrl).toBeUndefined();
    // Refused before any wallet configuration is looked at.
    await expect(ensureApplePass(ctx, ticket!.id)).rejects.toMatchObject({
      code: 'WALLET_TEST_ORDER',
      status: 404,
    });
    await expect(ensureGoogleSaveUrl(ctx, ticket!.id)).rejects.toMatchObject({
      code: 'WALLET_TEST_ORDER',
      status: 404,
    });
  });

  describe('publishing events with test orders', () => {
    const keysOf = async (eventId: string) =>
      (await eventPublicKeys(ctx, eventId)).map((k) => `${k.keyId}:${k.status}`);

    it('refuses to publish while any test order exists, then rotates the ticket key', async () => {
      const { event: ev, seatIds } = await createEvent('DRAFT');
      const before = await ensureEventSigningKey(ctx, ev.id);
      const order = await buy(ev, seatIds[0]!, SUPER);
      const [flagged] = await handle.db.select().from(events).where(eq(events.id, ev.id));
      expect(flagged!.hadTestOrders).toBe(true);

      await expect(
        changeEventStatus(ctx, { eventId: ev.id, status: 'PUBLISHED' }),
      ).rejects.toMatchObject({ code: 'TEST_ORDERS_PRESENT' });
      expect((await getEventById(ctx, ev.id)).status).toBe('DRAFT');

      expect(await deleteTestOrder(ctx, { orderId: order.orderId, userId })).toMatchObject({
        deleted: true,
      });
      const change = await changeEventStatus(ctx, { eventId: ev.id, status: 'PUBLISHED' });
      expect(change).toEqual({ from: 'DRAFT', rotatedKeys: 1 });
      const published = await getEventById(ctx, ev.id);
      expect(published.status).toBe('PUBLISHED');
      expect(published.publishedAt).not.toBeNull();

      // The old key is revoked (scanners drop it with their next manifest sync), a new one is active.
      const keys = await eventPublicKeys(ctx, ev.id);
      expect(keys.find((k) => k.keyId === before.keyId)?.status).toBe('REVOKED');
      expect(keys.filter((k) => k.status === 'ACTIVE')).toHaveLength(1);
      expect(keys.find((k) => k.status === 'ACTIVE')!.keyId).not.toBe(before.keyId);
      expect(
        (await eventPublicKeys(ctx, ev.id, { excludeRevoked: true })).map((k) => k.keyId),
      ).not.toContain(before.keyId);
    });

    it('keeps the key of events that never had test orders and of events that are already live', async () => {
      const { event: ev } = await createEvent('DRAFT');
      const key = await ensureEventSigningKey(ctx, ev.id);
      expect(await changeEventStatus(ctx, { eventId: ev.id, status: 'PUBLISHED' })).toEqual({
        from: 'DRAFT',
        rotatedKeys: 0,
      });
      expect(await keysOf(ev.id)).toEqual([`${key.keyId}:ACTIVE`]);
      // POSTPONED is live as well: no second check, no rotation.
      expect(await changeEventStatus(ctx, { eventId: ev.id, status: 'POSTPONED' })).toMatchObject({
        rotatedKeys: 0,
      });
    });

    it('publishes when only cancelled and hidden test orders (money) remain, rotating the key', async () => {
      const { event: ev, seatIds } = await createEvent('DRAFT');
      const before = await ensureEventSigningKey(ctx, ev.id);
      const order = await buy(ev, seatIds[0]!, SUPER);
      await recordPayment(ctx, {
        orderId: order.orderId,
        amount: order.totalGross,
        currency: 'EUR',
        method: 'BANK_TRANSFER',
        actor: { type: 'SYSTEM' },
      });
      await processPaidOrder(ctx, order.orderId);
      // Not hidden yet: blocks.
      await expect(
        changeEventStatus(ctx, { eventId: ev.id, status: 'PUBLISHED' }),
      ).rejects.toMatchObject({ code: 'TEST_ORDERS_PRESENT' });
      expect(await summarizeTestOrders(ctx, ev.id)).toMatchObject({ orders: 1, hidden: 0 });
      await cancelAndHideTestOrder(ctx, { orderId: order.orderId, userId });
      expect(await summarizeTestOrders(ctx, ev.id)).toMatchObject({ orders: 0, hidden: 1 });
      // Bulk delete leaves the hidden order alone.
      expect(await deleteTestOrdersOfEvent(ctx, { eventId: ev.id, userId })).toEqual({
        deleted: 0,
        kept: [],
      });
      expect(await changeEventStatus(ctx, { eventId: ev.id, status: 'PUBLISHED' })).toEqual({
        from: 'DRAFT',
        rotatedKeys: 1,
      });
      const keys = await eventPublicKeys(ctx, ev.id);
      expect(keys.find((k) => k.keyId === before.keyId)?.status).toBe('REVOKED');
      expect(keys.filter((k) => k.status === 'ACTIVE')).toHaveLength(1);
      // The hidden order and its payment stay.
      expect(
        await handle.db.select().from(orders).where(eq(orders.id, order.orderId)),
      ).toHaveLength(1);
    });

    it('refuses the key rotation when real tickets exist', async () => {
      const { event: ev, seatIds } = await createEvent('PUBLISHED');
      const real = await buy(ev, seatIds[0]!, null);
      await recordPayment(ctx, {
        orderId: real.orderId,
        amount: real.totalGross,
        currency: 'EUR',
        method: 'BANK_TRANSFER',
        actor: { type: 'SYSTEM' },
      });
      expect((await processPaidOrder(ctx, real.orderId)).ticketCount).toBe(1);
      // PUBLISHED → DRAFT keeps real orders real; a test purchase on the draft flags the event.
      await handle.db.update(events).set({ status: 'DRAFT' }).where(eq(events.id, ev.id));
      const draftAgain = await getEventById(ctx, ev.id);
      const test = await buy(draftAgain, seatIds[1]!, SUPER);
      await deleteTestOrder(ctx, { orderId: test.orderId, userId });
      const keysBefore = await keysOf(ev.id);
      await expect(
        changeEventStatus(ctx, { eventId: ev.id, status: 'PUBLISHED' }),
      ).rejects.toMatchObject({ code: 'TEST_KEY_ROTATION_REAL_TICKETS' });
      expect((await getEventById(ctx, ev.id)).status).toBe('DRAFT');
      expect(await keysOf(ev.id)).toEqual(keysBefore);
    });
  });
});
