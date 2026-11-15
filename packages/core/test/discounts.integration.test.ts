/** Discount codes against real PostgreSQL + Redis: pricing, invoice lines, VAT, usage limits, credit notes. */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  accessCodes,
  adminUsers,
  invoiceLines,
  invoices,
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
import { and, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addSeats,
  applyDiscountCodeToCart,
  cancelOrder,
  cancelPaidOrder,
  createDiscountCode,
  issueInvoice,
  loadAccountingData,
  removeDiscountCodeFromCart,
  getSalesStatistics,
  afterSeatMapSaved,
  completePayPalPayment,
  createCoreContext,
  customerAccountsOffered,
  discardCart,
  enterShop,
  extendCartForCheckout,
  getCart,
  getCheckoutOptions,
  getEventById,
  handlePayPalWebhook,
  loadSeatMapDocument,
  placeOrder,
  purgeUnverifiedWebhookEvents,
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
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)('discount codes (integration)', () => {
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
      phone: '+49 6134 123456',
      address: {
        street: 'Hauptstrasse 1',
        postalCode: '65462',
        city: 'Ginsheim',
        country: 'DE',
      },
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

  const codeInput = (code: string, over: Record<string, unknown> = {}) =>
    ({
      code,
      type: 'PERCENT',
      value: 1000,
      allEvents: true,
      eventIds: [],
      categoryIds: [],
      ticketTypeIds: [],
      validFrom: null,
      validUntil: null,
      maxTotalUses: null,
      maxUsesPerEmail: null,
      minOrderValue: null,
      discountFees: false,
      stackable: false,
      isActive: true,
      note: null,
      ...over,
    }) as Parameters<typeof createDiscountCode>[1];

  async function cartWith(seats: string[], code?: string) {
    const session = sid();
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, seats);
    if (code) await applyDiscountCodeToCart(ctx, session, code);
    return session;
  }

  it('applies a percent code: discount line, VAT per rate, invoice lines add up', async () => {
    await createDiscountCode(handle.db, codeInput('SPRING10'), null);
    const session = await cartWith([seatIds[0]!, seatIds[1]!], ' spring10 ');
    const { quotes } = await getCheckoutOptions(ctx, session);
    const q = quotes.BANK_TRANSFER;
    expect(q.codeDiscountTotal).toBe(600);
    expect(q.discounts).toHaveLength(1);
    expect(q.feeTotal).toBe(300); // fees are not discounted by default
    expect(q.totalGross).toBe(6000 - 600 + 300);
    expect(q.totalNet + q.totalTax).toBe(q.totalGross);
    expect(q.events[0]!.items.map((i) => i.priceGross)).toEqual([2700, 2700]);

    const placed = await placeOrder(ctx, {
      sessionId: session,
      input: buyer('BANK_TRANSFER', q.totalGross, 'a@example.invalid'),
    });
    const [order] = await handle.db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(order).toMatchObject({ codeDiscountTotal: 600, totalGross: 5700, subtotalGross: 6000 });
    const items = await handle.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, placed.orderId));
    expect(items.map((i) => i.codeDiscountAmount)).toEqual([300, 300]);
    expect(items.every((i) => i.codeDiscountCodes.join() === 'SPRING10')).toBe(true);
    expect(items.every((i) => i.priceGross === 2700)).toBe(true);

    await recordPayment(ctx, {
      orderId: placed.orderId,
      amount: 5700,
      currency: 'EUR',
      method: 'BANK_TRANSFER',
      actor: { type: 'SYSTEM' },
    });
    const issued = await issueInvoice(ctx, placed.orderId);
    const lines = await handle.db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, issued!.invoiceId))
      .orderBy(invoiceLines.position);
    // two tickets at the full price, each followed by its own negative discount line, then the fee
    expect(lines.map((l) => l.totalGross)).toEqual([3000, -300, 3000, -300, 300]);
    const [invoice] = await handle.db
      .select()
      .from(invoices)
      .where(eq(invoices.id, issued!.invoiceId));
    expect(invoice!.totalGross).toBe(5700);
    expect(invoice!.totalNet + invoice!.totalTax).toBe(5700);
    expect(invoice!.taxBreakdown).toHaveLength(1);
    expect(invoice!.taxBreakdown[0]).toMatchObject({ rateBasisPoints: 1900, gross: 5700 });
    // item + discount line carry exactly the stored (reduced) tax of the order items
    const storedTax = items.reduce((s, i) => s + i.taxAmount, 0);
    expect(lines.slice(0, 4).reduce((s, l) => s + l.totalTax, 0)).toBe(storedTax);

    // accounting: revenue booked net of discount (the negative line sits on the same rate)
    const data = await loadAccountingData(
      handle.db,
      { from: '2000-01-01', to: '2100-01-01' },
      'Europe/Berlin',
    );
    const doc = data.documents.find((d) => d.number === invoice!.invoiceNumber)!;
    expect(doc.lines.reduce((s, l) => s + l.gross, 0)).toBe(5700);
    expect(doc.breakdown).toEqual([
      expect.objectContaining({ rateBasisPoints: 1900, gross: 5700 }),
    ]);
  });

  it('rejects unusable codes with stable error codes', async () => {
    await createDiscountCode(handle.db, codeInput('MINVAL', { minOrderValue: 10_000 }), null);
    await createDiscountCode(
      handle.db,
      codeInput('OLDONE', {
        validFrom: new Date('2020-01-01'),
        validUntil: new Date('2020-02-01'),
      }),
      null,
    );
    await createDiscountCode(
      handle.db,
      codeInput('OTHER', { allEvents: false, eventIds: [uuid()] }),
      null,
    );
    const session = await cartWith([seatIds[2]!]);
    for (const [code, expected] of [
      ['NOPE1234', 'DISCOUNT_INVALID'],
      ['MINVAL', 'DISCOUNT_MIN_ORDER_VALUE'],
      ['OLDONE', 'DISCOUNT_EXPIRED'],
      ['OTHER', 'DISCOUNT_NOT_VALID_FOR_ITEMS'],
    ] as const) {
      await expect(applyDiscountCodeToCart(ctx, session, code)).rejects.toMatchObject({
        code: expected,
      });
    }
    // a single code per order unless both are stackable
    await createDiscountCode(handle.db, codeInput('ONE1'), null);
    await createDiscountCode(handle.db, codeInput('TWO2'), null);
    await applyDiscountCodeToCart(ctx, session, 'ONE1');
    await expect(applyDiscountCodeToCart(ctx, session, 'TWO2')).rejects.toMatchObject({
      code: 'DISCOUNT_NOT_STACKABLE',
    });
    await removeDiscountCodeFromCart(ctx, session, 'ONE1');
    await discardCart(ctx, session);
  });

  it('fixed code never exceeds the eligible tickets; 100 % discount makes a free, paid order', async () => {
    await createDiscountCode(handle.db, codeInput('BIG50', { type: 'FIXED', value: 50_000 }), null);
    const s1 = await cartWith([seatIds[3]!], 'BIG50');
    const q1 = (await getCheckoutOptions(ctx, s1)).quotes.BANK_TRANSFER;
    expect(q1.codeDiscountTotal).toBe(3000);
    expect(q1.totalGross).toBe(150); // only the fee is left, never negative
    await discardCart(ctx, s1);

    await createDiscountCode(
      handle.db,
      codeInput('FREE100', { value: 10_000, discountFees: true }),
      null,
    );
    const s2 = await cartWith([seatIds[4]!], 'FREE100');
    const q2 = (await getCheckoutOptions(ctx, s2)).quotes.BANK_TRANSFER;
    expect(q2.totalGross).toBe(0);
    const placed = await placeOrder(ctx, {
      sessionId: s2,
      input: buyer('BANK_TRANSFER', 0, 'free@example.invalid'),
    });
    expect(placed.status).toBe('PAID');
    expect(placed.paymentReference).toBeNull();
    const [order] = await handle.db.select().from(orders).where(eq(orders.id, placed.orderId));
    // Nothing was paid by any method: stored as FREE (statistics must not count PayPal / bank).
    expect(order).toMatchObject({
      totalGross: 0,
      totalNet: 0,
      totalTax: 0,
      paymentDueAt: null,
      paymentMethod: 'FREE',
    });
  });

  it('lets exactly one of two parallel checkouts use the last use of a code', async () => {
    await createDiscountCode(handle.db, codeInput('LASTONE', { maxTotalUses: 1 }), null);
    const a = await cartWith([seatIds[5]!], 'LASTONE');
    const b = await cartWith([seatIds[6]!], 'LASTONE');
    const results = await Promise.allSettled([
      placeOrder(ctx, { sessionId: a, input: buyer('BANK_TRANSFER', 2850, 'a2@example.invalid') }),
      placeOrder(ctx, { sessionId: b, input: buyer('BANK_TRANSFER', 2850, 'b2@example.invalid') }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'DISCOUNT_USAGE_LIMIT' });
    const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
      orderId: string;
    }>;

    // cancelling the unpaid order releases the use
    await cancelOrder(ctx, {
      orderId: winner.value.orderId,
      status: 'CANCELLED',
      actor: { type: 'SYSTEM' },
    });
    const c = await cartWith([seatIds[8]!], 'LASTONE');
    const q = (await getCheckoutOptions(ctx, c)).quotes.BANK_TRANSFER;
    expect(q.codeDiscountTotal).toBe(300);
    await discardCart(ctx, c);
  });

  it('hands out the existing order when a cart with a single-use code is re-submitted', async () => {
    await createDiscountCode(handle.db, codeInput('ONCEONLY', { maxTotalUses: 1 }), null);
    const session = await cartWith([seatIds[3]!], 'ONCEONLY');
    const total = (await getCheckoutOptions(ctx, session)).quotes.BANK_TRANSFER.totalGross;
    // The hand-over after the commit fails (lost response): the cart still holds its seat.
    const spy = vi.spyOn(ctx.seats, 'forceRelease').mockRejectedValue(new Error('redis down'));
    const first = await placeOrder(ctx, {
      sessionId: session,
      input: buyer('BANK_TRANSFER', total, 'once@example.invalid'),
    });
    spy.mockRestore();
    const again = await placeOrder(ctx, {
      sessionId: session,
      input: buyer('BANK_TRANSFER', total, 'once@example.invalid'),
    });
    expect(again.orderId).toBe(first.orderId);
    const [row] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(eq(orders.cartSessionId, session));
    expect(row!.n).toBe(1);
    // A different cart still cannot use the (now spent) code.
    const other = await cartWith([seatIds[7]!]);
    await expect(applyDiscountCodeToCart(ctx, other, 'ONCEONLY')).rejects.toMatchObject({
      code: 'DISCOUNT_USAGE_LIMIT',
    });
    await discardCart(ctx, other);
    await cancelOrder(ctx, {
      orderId: first.orderId,
      status: 'CANCELLED',
      actor: { type: 'SYSTEM' },
    });
  });

  it('limits uses per customer e-mail', async () => {
    await createDiscountCode(handle.db, codeInput('PERMAIL', { maxUsesPerEmail: 1 }), null);
    const first = await cartWith([seatIds[7]!], 'PERMAIL');
    const firstOrder = await placeOrder(ctx, {
      sessionId: first,
      input: buyer('BANK_TRANSFER', 2850, 'same@example.invalid'),
    });
    const second = await cartWith([seatIds[2]!], 'PERMAIL');
    await expect(
      placeOrder(ctx, {
        sessionId: second,
        input: buyer('BANK_TRANSFER', 2850, 'SAME@example.invalid'),
      }),
    ).rejects.toMatchObject({ code: 'DISCOUNT_EMAIL_LIMIT' });
    const other = await placeOrder(ctx, {
      sessionId: second,
      input: buyer('BANK_TRANSFER', 2850, 'other@example.invalid'),
    });
    expect(other.totalGross).toBe(2850);
    for (const orderId of [firstOrder.orderId, other.orderId]) {
      await cancelOrder(ctx, { orderId, status: 'CANCELLED', actor: { type: 'SYSTEM' } });
    }
  });

  it('credit notes of a code-reduced fee line keep unit price x quantity = total', async () => {
    const [user] = await handle.db
      .insert(adminUsers)
      .values({ email: 'fin2@example.invalid', displayName: 'Fin2', roles: ['FINANCE'] })
      .returning({ id: adminUsers.id });
    await createDiscountCode(
      handle.db,
      codeInput('FEECODE', { value: 1000, discountFees: true }),
      null,
    );
    const session = await cartWith([seatIds[2]!, seatIds[3]!], 'FEECODE');
    const q = (await getCheckoutOptions(ctx, session)).quotes.BANK_TRANSFER;
    expect(q.totalGross).toBe(6300 - 630);
    const placed = await placeOrder(ctx, {
      sessionId: session,
      input: buyer('BANK_TRANSFER', q.totalGross, 'feecode@example.invalid'),
    });
    await recordPayment(ctx, {
      orderId: placed.orderId,
      amount: q.totalGross,
      currency: 'EUR',
      method: 'BANK_TRANSFER',
      actor: { type: 'SYSTEM' },
    });
    const invoiceId = (await issueInvoice(ctx, placed.orderId))!.invoiceId;
    const invoiceLinesOf = async (id: string) =>
      handle.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    const feeLine = (await invoiceLinesOf(invoiceId)).find((l) => l.orderFeeId !== null)!;
    // two units at 135 would not add up to the 270 charged: one line at the amount charged
    expect(feeLine).toMatchObject({ quantity: 1, unitPriceGross: 270, totalGross: 270 });

    const items = await handle.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, placed.orderId));
    // cancel one ticket with its fee share, then the rest
    await cancelPaidOrder(ctx, {
      orderId: placed.orderId,
      orderItemIds: [items[0]!.id],
      refundFees: true,
      notify: false,
      userId: user!.id,
    });
    await cancelPaidOrder(ctx, {
      orderId: placed.orderId,
      refundFees: true,
      notify: false,
      userId: user!.id,
    });
    const notes = (
      await handle.db.select().from(invoices).where(eq(invoices.orderId, placed.orderId))
    ).filter((d) => d.type === 'CREDIT_NOTE');
    expect(notes.length).toBeGreaterThanOrEqual(2);
    let credited = 0;
    for (const note of notes) {
      for (const line of await invoiceLinesOf(note.id)) {
        expect(line.quantity * line.unitPriceGross, line.description).toBe(line.totalGross);
      }
      credited += note.totalGross;
    }
    expect(credited).toBe(-q.totalGross);
  });

  it('credits the discounted amounts when a paid order is cancelled', async () => {
    const [user] = await handle.db
      .insert(adminUsers)
      .values({ email: 'fin@example.invalid', displayName: 'Fin', roles: ['FINANCE'] })
      .returning({ id: adminUsers.id });
    await createDiscountCode(handle.db, codeInput('CRED20', { type: 'FIXED', value: 1000 }), null);
    const session = await cartWith([seatIds[2]!, seatIds[3]!], 'CRED20');
    const q = (await getCheckoutOptions(ctx, session)).quotes.BANK_TRANSFER;
    expect(q.totalGross).toBe(6000 - 1000 + 300);
    const placed = await placeOrder(ctx, {
      sessionId: session,
      input: buyer('BANK_TRANSFER', q.totalGross, 'cred@example.invalid'),
    });
    await recordPayment(ctx, {
      orderId: placed.orderId,
      amount: q.totalGross,
      currency: 'EUR',
      method: 'BANK_TRANSFER',
      actor: { type: 'SYSTEM' },
    });
    const items = await handle.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, placed.orderId));
    expect(items.map((i) => i.codeDiscountAmount)).toEqual([500, 500]);
    // cancel ONE ticket: proportional share of the fixed discount (500), not the gross price
    const result = await cancelPaidOrder(ctx, {
      orderId: placed.orderId,
      orderItemIds: [items[0]!.id],
      refundFees: false,
      notify: false,
      userId: user!.id,
    });
    expect(result.creditTotal).toBe(3000 - 500);
    const docs = await handle.db
      .select()
      .from(invoices)
      .where(eq(invoices.orderId, placed.orderId));
    const note = docs.find((c) => c.type === 'CREDIT_NOTE')!;
    expect(note.totalGross).toBe(-2500);
    expect(note.totalNet + note.totalTax).toBe(-2500);
    // the rest incl. fees
    const rest = await cancelPaidOrder(ctx, {
      orderId: placed.orderId,
      refundFees: true,
      notify: false,
      userId: user!.id,
    });
    expect(result.creditTotal + rest.creditTotal).toBe(q.totalGross);
  });

  it('reports the discount per code in the statistics', async () => {
    const stats = await getSalesStatistics(ctx, {
      from: '2000-01-01',
      to: '2100-01-01',
      eventIds: [],
      channels: [],
      methods: [],
    } as never);
    expect(stats.discounts.total).toBeGreaterThan(0);
    expect(stats.discounts.byCode.map((c) => c.code)).toContain('SPRING10');
  });
});
