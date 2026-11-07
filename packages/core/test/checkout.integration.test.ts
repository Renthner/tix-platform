/**
 * Phase 3 order flow against real PostgreSQL + Redis: checkout pricing (fees, tariffs, tax),
 * order creation (Vorkasse / PayPal), customer and access-code limits, the companion-seat
 * e-mail check, payments, dunning and the PayPal redirect flow (PayPal API mocked).
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  accessCodes,
  bankAccounts,
  createDb,
  emailMessages,
  events,
  fees,
  loadRootEnv,
  orderFees,
  orderHistory,
  orderItems,
  orders,
  payments,
  priceCategories,
  priceCategoryTicketTypes,
  seatMapSections,
  seatMaps,
  taxRates,
  ticketTypes,
  venues,
  webhookEvents,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import {
  checkoutInputSchema,
  extractPaymentReferences,
  type CheckoutInput,
  type SeatMapDocumentInput,
} from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addSeats,
  afterSeatMapSaved,
  completePayPalPayment,
  createCoreContext,
  customerAccountsOffered,
  enterShop,
  extendCartForCheckout,
  getCart,
  getCheckoutOptions,
  getEventById,
  handlePayPalWebhook,
  loadSeatMapDocument,
  placeOrder,
  recordPayment,
  runDunning,
  saveSecretSetting,
  saveSeatMapDocument,
  saveSetting,
  setGeneralAdmission,
  setKeepReserved,
  setTariff,
  startPayPalPayment,
  type CoreContext,
  type EventRow,
  type JobQueues,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)('checkout, payments & dunning (integration)', () => {
  const dbName = `tix_checkout_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let event: EventRow;
  let seatIds: string[] = [];
  let standingId: string;
  let reducedId: string;
  const jobs = { add: vi.fn(async () => undefined), close: async () => {} };

  const sid = () => `k${uuid().slice(0, 8)}`;
  const buyer = (
    method: CheckoutInput['method'],
    expectedTotalGross: number,
    email = 'buyer@example.invalid',
  ): CheckoutInput =>
    checkoutInputSchema.parse({
      method,
      email,
      firstName: 'Erika',
      lastName: 'Example',
      acceptTerms: true,
      expectedTotalGross,
      locale: 'de',
    });
  const takenCode = async (seatId: string) =>
    (await ctx.seats.takenSeats(event.id))[seatId] ?? null;

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
    const [reduced] = await handle.db
      .insert(ticketTypes)
      .values({
        eventId: ev!.id,
        name: 'Reduced',
        discountKind: 'FIXED_AMOUNT',
        discountValue: 500,
        requiresProofAtEntry: true,
        scannerWarning: 'Check proof',
      })
      .returning();
    reducedId = reduced!.id;
    await handle.db.insert(priceCategoryTicketTypes).values([
      { priceCategoryId: category!.id, ticketTypeId: normal!.id },
      { priceCategoryId: category!.id, ticketTypeId: reduced!.id },
    ]);

    const sectionId = uuid();
    standingId = uuid();
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
        {
          id: standingId,
          type: 'STANDING',
          name: 'Floor',
          ticketLabel: 'Floor',
          capacity: 3,
          priceCategoryId: category!.id,
          geometry: { type: 'rect', x: 0, y: 200, width: 400, height: 100 },
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
        // seat 9 = wheelchair space, seat 10 = its companion seat
        isWheelchairSpace: i === 8,
        isCompanionSeat: i === 9,
      })),
    };
    const saved = await saveSeatMapDocument(handle.db, map!.id, doc, null);
    expect(saved.ok).toBe(true);
    if (saved.ok) await afterSeatMapSaved(ctx, saved);
    seatIds = doc.seats!.map((s) => s.id!);
    event = await getEventById(ctx, ev!.id);

    // Fees: 1.50 € per ticket (all methods) + 3 % PayPal surcharge per order.
    await handle.db.insert(fees).values([
      { name: 'Service fee', scope: 'PER_TICKET', calculation: 'FIXED', value: 150 },
      {
        name: 'PayPal fee',
        scope: 'PER_ORDER',
        calculation: 'PERCENT',
        value: 300,
        taxRateId: tax!.id,
        paymentMethods: ['PAYPAL'],
      },
    ]);
    await handle.db.insert(bankAccounts).values({
      name: 'Main',
      accountHolder: 'Example Theatre e.V.',
      iban: 'DE89370400440532013000',
      currency: 'EUR',
      isDefaultForBankTransfer: true,
    });
    await saveSetting(
      ctx,
      'paypal',
      { enabled: true, clientId: 'client-id', webhookId: 'WH-1' },
      null,
    );
    await saveSecretSetting(ctx, 'paypal.credentials', { clientSecret: 'client-secret' }, null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('prices the cart per payment method (tariff discount, per-ticket fee, PayPal surcharge)', async () => {
    const session = sid();
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, [seatIds[0]!, seatIds[1]!]);
    await setTariff(ctx, session, event, seatIds[1]!, reducedId);
    const { quotes, methods } = await getCheckoutOptions(ctx, session);
    expect(methods.every((m) => m.available)).toBe(true);
    const bank = quotes.BANK_TRANSFER;
    expect(bank.subtotalGross).toBe(6000);
    expect(bank.discountTotal).toBe(500);
    expect(bank.feeTotal).toBe(300);
    expect(bank.totalGross).toBe(5800);
    expect(bank.totalNet + bank.totalTax).toBe(5800);
    // PayPal: + 3 % of the ticket total (5500) = 165
    expect(quotes.PAYPAL.totalGross).toBe(5965);
    expect(quotes.PAYPAL.orderFees[0]).toMatchObject({ name: 'PayPal fee', totalGross: 165 });
  });

  it('extends the cart once by the payment grace period when the checkout starts', async () => {
    const session = sid();
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, [seatIds[2]!]);
    const before = (await getCart(ctx, session)).expiresAt!;
    const extended = await extendCartForCheckout(ctx, session);
    expect(extended).toBe(before + 600_000);
    expect(await extendCartForCheckout(ctx, session)).toBe(extended);
    const lockExpiry = await redis.zscore(ctx.keys.seatLockExpiries(event.id), seatIds[2]!);
    expect(Number(lockExpiry)).toBe(extended);
  });

  it('creates a Vorkasse order: reference with check digit, due dates, reservation, outbox mail', async () => {
    const session = sid();
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, [seatIds[3]!, seatIds[4]!]);
    await setGeneralAdmission(ctx, session, event, standingId, 2);

    await expect(
      placeOrder(ctx, { sessionId: session, input: buyer('BANK_TRANSFER', 1) }),
    ).rejects.toMatchObject({ code: 'PRICE_CHANGED', details: { totalGross: 4 * 3150 } });

    const placed = await placeOrder(ctx, {
      sessionId: session,
      input: buyer('BANK_TRANSFER', 4 * 3150),
    });
    expect(placed.status).toBe('AWAITING_PAYMENT');
    const [found] = extractPaymentReferences(`Ticket ${placed.paymentReference}`, ['TIX']);
    expect(found).toMatchObject({ reference: placed.paymentReference, checksumValid: true });

    const [order] = await handle.db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(order!.paymentDueAt!.getTime()).toBeGreaterThan(Date.now());
    expect(order!.autoCancelAt!.getTime()).toBeGreaterThanOrEqual(order!.paymentDueAt!.getTime());
    expect(order!.nextReminderAt!.getTime()).toBeLessThan(order!.autoCancelAt!.getTime());
    const items = await handle.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order!.id));
    expect(items).toHaveLength(4);
    expect(items.every((i) => i.status === 'PENDING')).toBe(true);
    const feeRows = await handle.db
      .select()
      .from(orderFees)
      .where(eq(orderFees.orderId, order!.id));
    expect(feeRows).toMatchObject([{ name: 'Service fee', quantity: 4, totalGross: 600 }]);
    const [section] = await handle.db
      .select({ allocated: seatMapSections.allocatedCount })
      .from(seatMapSections)
      .where(eq(seatMapSections.id, standingId));
    expect(section!.allocated).toBe(2);
    const [mail] = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.orderId, order!.id));
    expect(mail).toMatchObject({
      templateKey: 'ORDER_CONFIRMATION_BANK_TRANSFER',
      status: 'QUEUED',
    });

    // Redis: seats reserved, locks gone, GA capacity consumed, cart cleared.
    expect(await takenCode(seatIds[3]!)).toBe('R');
    expect(await redis.exists(ctx.keys.seatLock(event.id, seatIds[3]!))).toBe(0);
    expect((await ctx.seats.generalAdmissionRemaining(event.id))[standingId]).toBe(1);
    expect((await getCart(ctx, session)).itemCount).toBe(0);

    // Bank payment arrives → PAID, seats sold, fulfilment job queued.
    const paid = await recordPayment(ctx, {
      orderId: order!.id,
      amount: order!.totalGross,
      currency: 'EUR',
      method: 'BANK_TRANSFER',
      actor: { type: 'SYSTEM' },
    });
    expect(paid.status).toBe('PAID');
    expect(await takenCode(seatIds[3]!)).toBe('S');
    expect(jobs.add).toHaveBeenCalledWith(
      'documents',
      'order-paid',
      { orderId: order!.id },
      { jobId: `order-paid-${order!.id}` },
    );
  });

  it('enforces the per-customer limit and the access-code total across orders', async () => {
    await handle.db.update(events).set({ maxTicketsPerCustomer: 3 }).where(eq(events.id, event.id));
    event = await getEventById(ctx, event.id);
    const first = sid();
    await enterShop(ctx, event, first);
    await addSeats(ctx, first, event, [seatIds[5]!, seatIds[6]!]);
    // buyer@example.invalid already holds 4 tickets of this event (previous test)
    await expect(
      placeOrder(ctx, { sessionId: first, input: buyer('BANK_TRANSFER', 6300) }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_LIMIT', details: { max: 3, remaining: 0 } });
    // the cart survives a rejected checkout
    expect((await getCart(ctx, first)).itemCount).toBe(2);

    const [code] = await handle.db
      .insert(accessCodes)
      .values({
        eventId: event.id,
        code: `TOT${uuid().slice(0, 6).toUpperCase()}`,
        type: 'MULTI_USE',
        maxTicketsTotal: 2,
      })
      .returning();
    await redis.set(ctx.keys.queueAccessCode(event.id, first), code!.id);
    const ok = await placeOrder(ctx, {
      sessionId: first,
      input: buyer('BANK_TRANSFER', 6300, 'second@example.invalid'),
    });
    expect(ok.status).toBe('AWAITING_PAYMENT');

    const second = sid();
    await enterShop(ctx, event, second);
    await redis.set(ctx.keys.queueAccessCode(event.id, second), code!.id);
    await addSeats(ctx, second, event, [seatIds[7]!]);
    await expect(
      placeOrder(ctx, {
        sessionId: second,
        input: buyer('BANK_TRANSFER', 3150, 'third@example.invalid'),
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_CODE_LIMIT', details: { remaining: 0 } });
    await redis.del(ctx.keys.queueAccessCode(event.id, second));
    await handle.db
      .update(events)
      .set({ maxTicketsPerCustomer: null })
      .where(eq(events.id, event.id));
    event = await getEventById(ctx, event.id);
    // keep seat 8 in the cart of `second` for the dunning test below
    const dunningOrder = await placeOrder(ctx, {
      sessionId: second,
      input: buyer('BANK_TRANSFER', 3150, 'third@example.invalid'),
    });
    expect(dunningOrder.status).toBe('AWAITING_PAYMENT');
  });

  it('sends one reminder, respects "keep reserved" and cancels overdue Vorkasse orders', async () => {
    const [order] = await handle.db
      .select()
      .from(orders)
      .where(eq(orders.email, 'third@example.invalid'));
    const past = new Date(Date.now() - 60_000);
    await handle.db.update(orders).set({ nextReminderAt: past }).where(eq(orders.id, order!.id));
    expect((await runDunning(ctx)).reminded).toBe(1);
    expect((await runDunning(ctx)).reminded).toBe(0);
    const mails = await handle.db
      .select({ key: emailMessages.templateKey })
      .from(emailMessages)
      .where(eq(emailMessages.orderId, order!.id));
    expect(mails.map((m) => m.key)).toContain('PAYMENT_REMINDER');

    await handle.db.update(orders).set({ autoCancelAt: past }).where(eq(orders.id, order!.id));
    await setKeepReserved(ctx, {
      orderId: order!.id,
      keep: true,
      reason: 'calls tomorrow',
      userId: null,
    });
    expect((await runDunning(ctx)).cancelled).toBe(0);
    await setKeepReserved(ctx, { orderId: order!.id, keep: false, userId: null });
    expect((await runDunning(ctx)).cancelled).toBe(1);
    const [cancelled] = await handle.db.select().from(orders).where(eq(orders.id, order!.id));
    expect(cancelled!.status).toBe('CANCELLED');
    expect(await takenCode(seatIds[7]!)).toBeNull();
  });

  it('settles a small underpayment within the matching tolerance', async () => {
    const [order] = await handle.db
      .select()
      .from(orders)
      .where(eq(orders.email, 'second@example.invalid'));
    const partial = await recordPayment(ctx, {
      orderId: order!.id,
      amount: order!.totalGross - 10,
      currency: 'EUR',
      method: 'BANK_TRANSFER',
      actor: { type: 'SYSTEM' },
      settleShortfallUpTo: 5,
    });
    expect(partial).toMatchObject({ status: 'PARTIAL', outstanding: 10 });
    const paid = await recordPayment(ctx, {
      orderId: order!.id,
      amount: 7,
      currency: 'EUR',
      method: 'BANK_TRANSFER',
      actor: { type: 'SYSTEM' },
      settleShortfallUpTo: 5,
    });
    expect(paid.status).toBe('PAID');
    const history = await handle.db
      .select({ type: orderHistory.type, data: orderHistory.data })
      .from(orderHistory)
      .where(eq(orderHistory.orderId, order!.id));
    expect(history.find((h) => h.type === 'shortfall_written_off')?.data).toMatchObject({
      shortfall: 3,
    });
  });

  it('sells a companion seat alone only to the buyer of its wheelchair space', async () => {
    await handle.db
      .update(events)
      .set({ companionRequiresWheelchair: true })
      .where(eq(events.id, event.id));
    event = await getEventById(ctx, event.id);
    const wheelchair = seatIds[8]!;
    const companion = seatIds[9]!;

    const first = sid();
    await enterShop(ctx, event, first);
    await addSeats(ctx, first, event, [wheelchair]);
    const owner = await placeOrder(ctx, {
      sessionId: first,
      input: buyer('BANK_TRANSFER', 3150, 'owner@example.invalid'),
    });
    await recordPayment(ctx, {
      orderId: owner.orderId,
      amount: 3150,
      currency: 'EUR',
      method: 'BANK_TRANSFER',
      actor: { type: 'SYSTEM' },
    });

    const later = sid();
    await enterShop(ctx, event, later);
    await addSeats(ctx, later, event, [companion]);
    await expect(
      placeOrder(ctx, {
        sessionId: later,
        input: buyer('BANK_TRANSFER', 3150, 'other@example.invalid'),
      }),
    ).rejects.toMatchObject({ code: 'COMPANION_OWNER_MISMATCH' });
    const ok = await placeOrder(ctx, {
      sessionId: later,
      input: buyer('BANK_TRANSFER', 3150, 'OWNER@example.invalid'),
    });
    expect(ok.status).toBe('AWAITING_PAYMENT');
    await handle.db
      .update(events)
      .set({ companionRequiresWheelchair: null })
      .where(eq(events.id, event.id));
    event = await getEventById(ctx, event.id);
  });

  /** Minimal PayPal API double. */
  let paypalOrders = 0;
  function mockPayPal(
    options: { captureStatus?: 'COMPLETED' | 'PENDING'; approved?: boolean } = {},
  ) {
    const calls: string[] = [];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url.replace(/^https:\/\/[^/]+/, '')}`);
        if (url.endsWith('/v1/oauth2/token'))
          return json({ access_token: 'tok', expires_in: 3600 });
        if (url.endsWith('/v2/checkout/orders') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as {
            purchase_units: { amount: { value: string } }[];
          };
          paypalOrders += 1;
          const id = `PP-ORDER-${paypalOrders}`;
          return json({
            id,
            status: 'PAYER_ACTION_REQUIRED',
            amount: body.purchase_units[0]!.amount.value,
            links: [{ rel: 'payer-action', href: `https://paypal.example/approve/${id}` }],
          });
        }
        const orderId = /\/v2\/checkout\/orders\/([^/]+)/.exec(url)?.[1];
        if (url.endsWith('/capture')) {
          return json({
            id: orderId,
            status: 'COMPLETED',
            purchase_units: [
              {
                payments: {
                  captures: [
                    {
                      id: 'CAP-1',
                      status: options.captureStatus ?? 'COMPLETED',
                      amount: { currency_code: 'EUR', value: '32.45' },
                      create_time: new Date().toISOString(),
                    },
                  ],
                },
              },
            ],
          });
        }
        if (url.includes('/v2/checkout/orders/')) {
          return json({
            id: orderId,
            status: options.approved ? 'APPROVED' : 'PAYER_ACTION_REQUIRED',
          });
        }
        if (url.endsWith('/v1/notifications/verify-webhook-signature')) {
          return json({ verification_status: 'SUCCESS' });
        }
        return json({ name: 'NOT_FOUND' }, 404);
      }),
    );
    return calls;
  }

  it('runs the PayPal redirect flow: create, capture, idempotent webhook', async () => {
    const session = sid();
    await enterShop(ctx, event, session);
    // standing spot: 31.50 € + 3 % PayPal fee on 30.00 € (0.90 €) = 32.40 € → use 1 seat
    await setGeneralAdmission(ctx, session, event, standingId, 1);
    const quote = (await getCheckoutOptions(ctx, session)).quotes.PAYPAL;
    expect(quote.totalGross).toBe(3150 + 90);
    // align the mocked capture amount with the order total
    await handle.db.delete(fees).where(eq(fees.name, 'PayPal fee'));
    await handle.db.insert(fees).values({
      name: 'PayPal fee',
      scope: 'PER_ORDER',
      calculation: 'FIXED',
      value: 95,
      taxRateId: event.taxRateId,
      paymentMethods: ['PAYPAL'],
    });
    const placed = await placeOrder(ctx, {
      sessionId: session,
      input: buyer('PAYPAL', 3245, 'pp@example.invalid'),
    });
    expect(placed.status).toBe('PENDING');
    expect(await ctx.seats.generalAdmissionRemaining(event.id)).toMatchObject({ [standingId]: 0 });

    const calls = mockPayPal();
    const started = await startPayPalPayment(ctx, placed.orderId);
    expect(started).toEqual({
      status: 'REDIRECT',
      url: 'https://paypal.example/approve/PP-ORDER-1',
    });
    const [attempt] = await handle.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, placed.orderId));
    expect(attempt).toMatchObject({
      status: 'CREATED',
      providerOrderId: 'PP-ORDER-1',
      amount: 3245,
    });

    expect(await completePayPalPayment(ctx, placed.orderId, 'PP-ORDER-1')).toEqual({
      status: 'PAID',
    });
    expect(await completePayPalPayment(ctx, placed.orderId, 'PP-ORDER-1')).toEqual({
      status: 'PAID',
    });
    const rows = await handle.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, placed.orderId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'CAPTURED', providerCaptureId: 'CAP-1', amount: 3245 });
    expect(calls.filter((c) => c.endsWith('/capture'))).toHaveLength(1);

    const webhook = JSON.stringify({
      id: 'WH-EVT-1',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAP-1',
        status: 'COMPLETED',
        amount: { currency_code: 'EUR', value: '32.45' },
        supplementary_data: { related_ids: { order_id: 'PP-ORDER-1' } },
      },
    });
    const headers = new Headers({
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.paypal.com/cert',
      'paypal-transmission-id': 't-1',
      'paypal-transmission-sig': 'sig',
      'paypal-transmission-time': new Date().toISOString(),
    });
    expect(await handlePayPalWebhook(ctx, headers, webhook)).toBe('PROCESSED');
    expect(await handlePayPalWebhook(ctx, headers, webhook)).toBe('DUPLICATE');
    expect(
      await handlePayPalWebhook(
        ctx,
        new Headers(),
        JSON.stringify({ id: 'WH-EVT-2', event_type: 'X' }),
      ),
    ).toBe('INVALID_SIGNATURE');
    const inbox = await handle.db.select().from(webhookEvents);
    expect(inbox.map((w) => [w.externalId, w.status]).sort()).toEqual([
      ['WH-EVT-1', 'PROCESSED'],
      ['WH-EVT-2', 'IGNORED'],
    ]);
    const [order] = await handle.db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(order).toMatchObject({ status: 'PAID', amountPaid: 3245 });
  });

  it('expires abandoned PayPal orders (after checking PayPal) and releases their spots', async () => {
    // free the standing area again: cancel nothing, just raise capacity via a fresh order
    const session = sid();
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, [seatIds[7]!]);
    const placed = await placeOrder(ctx, {
      sessionId: session,
      input: buyer('PAYPAL', 3245, 'late@example.invalid'),
    });
    mockPayPal();
    await startPayPalPayment(ctx, placed.orderId);
    await handle.db
      .update(orders)
      .set({ createdAt: new Date(Date.now() - 2 * 3600_000) })
      .where(eq(orders.id, placed.orderId));
    const result = await runDunning(ctx);
    expect(result.expired).toBe(1);
    const [order] = await handle.db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(order!.status).toBe('EXPIRED');
    expect(await takenCode(seatIds[7]!)).toBeNull();
    const [attempt] = await handle.db
      .select()
      .from(payments)
      .where(and(eq(payments.orderId, placed.orderId), eq(payments.method, 'PAYPAL')));
    expect(attempt!.status).toBe('CANCELLED');
  });

  it('requires sign-in only where customer accounts are offered', async () => {
    await saveSetting(
      ctx,
      'customerAccounts',
      { enabled: true, guestCheckoutEnabled: false },
      null,
    );
    const session = sid();
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, [seatIds[7]!]);
    await expect(
      placeOrder(ctx, {
        sessionId: session,
        input: buyer('BANK_TRANSFER', 3150, 'guest@example.invalid'),
      }),
    ).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });

    // The event hides sign-in / registration → guests may order.
    await handle.db
      .update(events)
      .set({ customerAccountsEnabled: false })
      .where(eq(events.id, event.id));
    const placed = await placeOrder(ctx, {
      sessionId: session,
      input: buyer('BANK_TRANSFER', 3150, 'guest@example.invalid'),
    });
    expect(placed.status).toBe('AWAITING_PAYMENT');
    expect(customerAccountsOffered({ enabled: true }, [{ customerAccountsEnabled: null }])).toBe(
      true,
    );
    expect(customerAccountsOffered({ enabled: false }, [{ customerAccountsEnabled: null }])).toBe(
      false,
    );
    await saveSetting(ctx, 'customerAccounts', {}, null);
  });
});
