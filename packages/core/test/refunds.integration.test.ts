/**
 * Cancellation of PAID orders against real PostgreSQL + Redis (throw-away database, own Redis
 * prefix): refunds (PayPal automatic with mocked HTTP, bank transfer as manual to-do), fees,
 * credit notes, seat release, idempotent jobs. No object storage is used: the job queue is a
 * mock, so no PDF is rendered or written (invoice object keys are number based – they must
 * never reach a shared bucket from a test run).
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminUsers,
  bankAccounts,
  bankTransactions,
  createDb,
  emailMessages,
  events,
  fees,
  orderFees,
  invoiceLines,
  invoices,
  loadRootEnv,
  orderItems,
  orders,
  payments,
  priceCategories,
  priceCategoryTicketTypes,
  refundItems,
  refunds,
  seatMaps,
  taxRates,
  ticketTypes,
  tickets,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { checkoutInputSchema, type CheckoutInput, type SeatMapDocumentInput } from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addSeats,
  afterSeatMapSaved,
  backfillMissingTickets,
  cancelPaidOrder,
  completeManualRefund,
  retryRefundBatch,
  countOpenRefunds,
  createCoreContext,
  enterShop,
  ensureOrderTickets,
  getCheckoutOptions,
  getEventById,
  listOpenRefunds,
  getRefundReconcileStatus,
  isRefundReconcilePending,
  listRefundRestoreReviews,
  markRefundsForReconciliation,
  reconcileRefundsAfterRestore,
  recordExistingPayPalOverpaymentRefund,
  recordExistingPayPalRefund,
  refundOverpayment,
  resolveRefundRestoreReview,
  skipRefundReconciliation,
  placeOrder,
  processPaypalRefund,
  recordPayment,
  requeueStaleRefunds,
  retryRefund,
  saveSecretSetting,
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

describe.skipIf(!adminUrl || !redisUrl)('refunds & credit notes (integration)', () => {
  const dbName = `tix_refunds_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let event: EventRow;
  let seatIds: string[] = [];
  let userId: string;
  const jobs = { add: vi.fn(async () => 'job'), close: async () => {} };
  const paypalCalls: { path: string; method: string; requestId: string | null; body: unknown }[] =
    [];
  let paypalRefundStatus = 200;
  let paypalRefundState: 'COMPLETED' | 'PENDING' | 'FAILED' = 'COMPLETED';
  let refundSeq = 0;
  /** PayPal order id → refunds PayPal lists in the order details. */
  const paypalOrderRefunds = new Map<string, unknown[]>();
  /** PayPal refund id → refund resource (GET /v2/payments/refunds/{id}). */
  const paypalRefundDetails = new Map<string, unknown>();
  let paypalOrderStatus = 200;
  /** Runs when PayPal order details are requested (simulates something happening mid-pass). */
  let onOrderFetch: (() => Promise<void>) | null = null;

  const takenCode = async (seatId: string) =>
    (await ctx.seats.takenSeats(event.id))[seatId] ?? null;

  const buyer = (method: CheckoutInput['method'], total: number): CheckoutInput =>
    checkoutInputSchema.parse({
      method,
      email: 'buyer@example.invalid',
      firstName: 'Erika',
      lastName: 'Example',
      phone: '+49 6134 123456',
      address: { street: 'Hauptstrasse 1', postalCode: '65462', city: 'Ginsheim', country: 'DE' },
      acceptTerms: true,
      expectedTotalGross: total,
      locale: 'en',
    });

  /** Places an order for the given seats and pays it (PayPal capture or bank transfer). */
  async function paidOrder(
    seats: string[],
    method: 'PAYPAL' | 'BANK_TRANSFER',
    options: {
      pay?: number;
      bankTransactionId?: string;
      settleShortfallUpTo?: number;
      /** Make the per-ticket fee line 1.00 € in total (indivisible by 3 tickets). */
      oddFee?: boolean;
    } = {},
  ) {
    const session = `k${uuid().slice(0, 8)}`;
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, seats);
    const { quotes } = await getCheckoutOptions(ctx, session);
    let total = quotes[method].totalGross;
    const placed = await placeOrder(ctx, { sessionId: session, input: buyer(method, total) });
    if (options.oddFee) {
      const [fee] = await handle.db
        .select()
        .from(orderFees)
        .where(eq(orderFees.orderId, placed.orderId));
      const tax = 16;
      const d = { gross: 100 - fee!.totalGross, net: 84 - fee!.totalNet, tax: tax - fee!.totalTax };
      await handle.db
        .update(orderFees)
        .set({ totalGross: 100, totalNet: 84, totalTax: tax })
        .where(eq(orderFees.id, fee!.id));
      await handle.db
        .update(orders)
        .set({
          feeTotal: sql`${orders.feeTotal} + ${d.gross}`,
          totalGross: sql`${orders.totalGross} + ${d.gross}`,
          totalNet: sql`${orders.totalNet} + ${d.net}`,
          totalTax: sql`${orders.totalTax} + ${d.tax}`,
        })
        .where(eq(orders.id, placed.orderId));
      total += d.gross;
    }
    const result = await recordPayment(ctx, {
      orderId: placed.orderId,
      amount: options.pay ?? total,
      currency: 'EUR',
      method,
      providerCaptureId: method === 'PAYPAL' ? `CAP-${uuid().slice(0, 8)}` : null,
      bankTransactionId: options.bankTransactionId ?? null,
      settleShortfallUpTo: options.settleShortfallUpTo,
      actor: { type: 'SYSTEM' },
    });
    expect(result.status).toBe('PAID');
    await ensureOrderTickets(ctx, placed.orderId);
    return { orderId: placed.orderId, total };
  }

  const load = async (orderId: string) => {
    const [order] = await handle.db.select().from(orders).where(eq(orders.id, orderId));
    const items = await handle.db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const refundRows = await handle.db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, orderId))
      .orderBy(asc(refunds.createdAt));
    return { order: order!, items, refundRows };
  };

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

    const [user] = await handle.db
      .insert(adminUsers)
      .values({ email: 'finance@example.invalid', displayName: 'Finance', roles: ['FINANCE'] })
      .returning({ id: adminUsers.id });
    userId = user!.id;
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
      .values([{ priceCategoryId: category!.id, ticketTypeId: normal!.id }]);

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
      seats: Array.from({ length: 70 }, (_, i) => ({
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

    // 1.50 € per ticket (all methods) + 3 % PayPal surcharge per order.
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

  const mockPayPal = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        if (url.endsWith('/v1/oauth2/token'))
          return json({ access_token: 'tok', expires_in: 3600 });
        const headers = new Headers(init?.headers);
        paypalCalls.push({
          path: url.replace(/^https:\/\/[^/]+/, ''),
          method: init?.method ?? 'GET',
          requestId: headers.get('paypal-request-id'),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (url.endsWith('/refund')) {
          if (paypalRefundStatus !== 200) {
            return json(
              { name: 'ERR', message: 'refund rejected', details: [{ issue: 'X' }] },
              paypalRefundStatus,
            );
          }
          refundSeq += 1;
          return json({ id: `RF-${refundSeq}`, status: paypalRefundState });
        }
        const orderMatch = /\/v2\/checkout\/orders\/([^/?]+)$/.exec(url);
        if (orderMatch) {
          if (onOrderFetch) await onOrderFetch();
          if (paypalOrderStatus !== 200) {
            return json({ name: 'ERR', message: 'order lookup failed' }, paypalOrderStatus);
          }
          return json({
            id: orderMatch[1],
            purchase_units: [
              { payments: { refunds: paypalOrderRefunds.get(orderMatch[1]!) ?? [] } },
            ],
          });
        }
        if (url.includes('/v2/payments/refunds/')) {
          const refundId = url.split('/').pop()!;
          return json(paypalRefundDetails.get(refundId) ?? { id: refundId, status: 'COMPLETED' });
        }
        return json({}, 404);
      }),
    );

  afterEach(() => {
    vi.unstubAllGlobals();
    paypalRefundStatus = 200;
    paypalRefundState = 'COMPLETED';
    paypalOrderRefunds.clear();
    paypalRefundDetails.clear();
    paypalOrderStatus = 200;
    onOrderFetch = null;
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

  it('cancels a PayPal-paid order: items/tickets refunded, seats bookable again, credit note, automatic refund once', async () => {
    mockPayPal();
    const { orderId, total } = await paidOrder([seatIds[0]!, seatIds[1]!], 'PAYPAL');
    expect(total).toBe(6000 + 300 + 180);
    expect(await takenCode(seatIds[0]!)).toBe('S');

    const result = await cancelPaidOrder(ctx, {
      orderId,
      refundFees: true,
      reason: 'Show cancelled',
      notify: true,
      userId,
    });
    expect(result).toMatchObject({
      orderStatus: 'REFUNDED',
      cancelledItems: 2,
      creditTotal: 6480,
      refundTotal: 6480,
    });
    expect(result.refunds).toHaveLength(1);
    expect(result.refunds[0]).toMatchObject({ kind: 'AUTOMATIC', method: 'PAYPAL', amount: 6480 });

    const { order, items, refundRows } = await load(orderId);
    expect(order.status).toBe('REFUNDED');
    expect(items.every((i) => i.status === 'REFUNDED' && i.refundedAt)).toBe(true);
    const ticketRows = await handle.db.select().from(tickets).where(eq(tickets.orderId, orderId));
    expect(ticketRows).toHaveLength(2);
    expect(ticketRows.every((t) => t.status === 'REFUNDED' && t.voidedAt)).toBe(true);
    // Seats released in the Redis mirror and bookable again.
    expect(await takenCode(seatIds[0]!)).toBeNull();
    const again = `k${uuid().slice(0, 8)}`;
    await enterShop(ctx, event, again);
    await addSeats(ctx, again, event, [seatIds[0]!]);

    // Credit note: negated lines of the invoice (issued on demand), gapless number, linked.
    const [invoice] = await handle.db
      .select()
      .from(invoices)
      .where(eq(invoices.orderId, orderId))
      .orderBy(asc(invoices.issuedAt));
    const [credit] = await handle.db
      .select()
      .from(invoices)
      .where(eq(invoices.id, result.creditNote!.id));
    expect(invoice!.type).toBe('INVOICE');
    expect(credit).toMatchObject({
      type: 'CREDIT_NOTE',
      correctsInvoiceId: invoice!.id,
      totalGross: -6480,
      invoiceNumber: result.creditNote!.number,
    });
    expect(credit!.invoiceNumber).toMatch(/^GS-\d{4}-000001$/);
    expect(credit!.totalNet + credit!.totalTax).toBe(credit!.totalGross);
    expect(credit!.taxBreakdown.reduce((s, e) => s + e.gross, 0)).toBe(-6480);
    const creditLines = await handle.db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, credit!.id));
    const originalLines = await handle.db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoice!.id));
    expect(creditLines).toHaveLength(originalLines.length);
    for (const line of creditLines) {
      const original = originalLines.find(
        (l) => l.orderItemId === line.orderItemId && l.orderFeeId === line.orderFeeId,
      )!;
      expect(line).toMatchObject({
        quantity: -original.quantity,
        totalGross: -original.totalGross,
        totalNet: -original.totalNet,
        totalTax: -original.totalTax,
      });
    }
    expect(refundRows[0]!.creditNoteId).toBe(credit!.id);
    const allocated = await handle.db
      .select()
      .from(refundItems)
      .where(eq(refundItems.refundId, refundRows[0]!.id));
    expect(allocated.reduce((s, r) => s + r.amount, 0)).toBe(6480);

    // E-mail outbox row (credit note attached).
    const [mail] = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.orderId, orderId));
    expect(mail!.templateKey).toBe('REFUND_CONFIRMATION');

    // Executing the refund twice talks to PayPal once, with a per-refund request id.
    const refundId = result.refunds[0]!.id;
    expect(await processPaypalRefund(ctx, refundId)).toBe('SUCCEEDED');
    expect(await processPaypalRefund(ctx, refundId)).toBe('SKIPPED');
    const posts = paypalCalls.filter((c) => c.path.endsWith('/refund'));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.requestId).toBe(`tix-refund-${refundId}-1`);
    expect(posts[0]!.body).toMatchObject({ custom_id: refundId });
    expect(posts[0]!.body).toMatchObject({ amount: { value: '64.80', currency_code: 'EUR' } });
    const after = await load(orderId);
    expect(after.refundRows[0]).toMatchObject({ status: 'SUCCEEDED', providerRefundId: 'RF-1' });
    expect(after.order.amountRefunded).toBe(6480);
    const [payment] = await handle.db.select().from(payments).where(eq(payments.orderId, orderId));
    expect(payment!.status).toBe('REFUNDED');

    // A second cancellation attempt is rejected (double click).
    await expect(
      cancelPaidOrder(ctx, { orderId, refundFees: true, notify: false, userId }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_REFUNDABLE' });
  });

  it('cancels single tickets: fees follow refundFees, two partial refunds of one capture use different request ids', async () => {
    mockPayPal();
    paypalCalls.length = 0;
    const { orderId } = await paidOrder([seatIds[2]!, seatIds[3]!], 'PAYPAL');
    const itemRows = await handle.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));
    const [first, second] = itemRows;

    const one = await cancelPaidOrder(ctx, {
      orderId,
      orderItemIds: [first!.id],
      refundFees: true,
      notify: false,
      userId,
    });
    // ticket price + its per-ticket fee; the per-order PayPal fee stays
    expect(one).toMatchObject({
      orderStatus: 'PARTIALLY_REFUNDED',
      creditTotal: 3150,
      refundTotal: 3150,
    });
    await expect(
      cancelPaidOrder(ctx, {
        orderId,
        orderItemIds: [first!.id],
        refundFees: true,
        notify: false,
        userId,
      }),
    ).rejects.toMatchObject({ code: 'ITEMS_NOT_REFUNDABLE' });
    const validNow = await handle.db.select().from(tickets).where(eq(tickets.orderId, orderId));
    expect(validNow.filter((t) => t.status === 'VALID')).toHaveLength(1);

    // Backfill never re-issues refunded tickets; the remaining one keeps its ticket.
    await backfillMissingTickets(ctx);
    expect(await ensureOrderTickets(ctx, orderId)).toHaveLength(1);
    const ticketRows = await handle.db.select().from(tickets).where(eq(tickets.orderId, orderId));
    expect(ticketRows).toHaveLength(2);

    const two = await cancelPaidOrder(ctx, {
      orderId,
      orderItemIds: [second!.id],
      refundFees: true,
      notify: false,
      userId,
    });
    // remaining per-ticket fee 150 + per-order PayPal fee 180 (nothing active left)
    expect(two).toMatchObject({ orderStatus: 'REFUNDED', creditTotal: 3000 + 150 + 180 });
    expect(await processPaypalRefund(ctx, one.refunds[0]!.id)).toBe('SUCCEEDED');
    expect(await processPaypalRefund(ctx, two.refunds[0]!.id)).toBe('SUCCEEDED');
    const posts = paypalCalls.filter((c) => c.path.endsWith('/refund'));
    expect(posts).toHaveLength(2);
    expect(posts[0]!.path).toBe(posts[1]!.path); // same capture
    expect(posts[0]!.requestId).not.toBe(posts[1]!.requestId);
    const { order } = await load(orderId);
    expect(order.amountRefunded).toBe(3150 + 3330);
    const documents = await handle.db.select().from(invoices).where(eq(invoices.orderId, orderId));
    expect(
      documents
        .filter((i) => i.type === 'CREDIT_NOTE')
        .map((i) => i.totalGross)
        .sort((a, b) => a - b),
    ).toEqual([-3330, -3150]);
    const numbers = documents.map((i) => i.invoiceNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('keeps the fees when refundFees is off', async () => {
    mockPayPal();
    const { orderId } = await paidOrder([seatIds[4]!, seatIds[5]!], 'PAYPAL');
    const result = await cancelPaidOrder(ctx, {
      orderId,
      refundFees: false,
      notify: false,
      userId,
    });
    expect(result).toMatchObject({ orderStatus: 'REFUNDED', creditTotal: 6000, refundTotal: 6000 });
    const [credit] = await handle.db
      .select()
      .from(invoices)
      .where(eq(invoices.id, result.creditNote!.id));
    expect(credit!.totalGross).toBe(-6000);
  });

  it('caps the refund by the money received (written-off shortfall) and records a manual to-do with the payer IBAN', async () => {
    const [bank] = await handle.db.select().from(bankAccounts).limit(1);
    const [bankTx] = await handle.db
      .insert(bankTransactions)
      .values({
        bankAccountId: bank!.id,
        fingerprint: `fp-${uuid()}`,
        bookingDate: '2026-03-01',
        amount: 3100,
        currency: 'EUR',
        counterpartyName: 'Erika Example',
        counterpartyIban: 'DE02120300000000202051',
      })
      .returning();
    const { orderId, total } = await paidOrder([seatIds[6]!], 'BANK_TRANSFER', {
      pay: 3100,
      bankTransactionId: bankTx!.id,
      settleShortfallUpTo: 100,
    });
    expect(total).toBe(3150);

    const open0 = await countOpenRefunds(ctx);
    const result = await cancelPaidOrder(ctx, { orderId, refundFees: true, notify: true, userId });
    // The credit note negates the whole invoice, the refund only the 31.00 € that arrived.
    expect(result).toMatchObject({ creditTotal: 3150, refundTotal: 3100 });
    expect(result.refunds).toMatchObject([
      { kind: 'MANUAL', method: 'BANK_TRANSFER', amount: 3100 },
    ]);
    const [credit] = await handle.db
      .select()
      .from(invoices)
      .where(eq(invoices.id, result.creditNote!.id));
    expect(credit!.totalGross).toBe(-3150);

    expect(await countOpenRefunds(ctx)).toBe(open0 + 1);
    const todo = (await listOpenRefunds(ctx)).find((r) => r.batchId === result.batchId)!;
    expect(todo).toMatchObject({
      status: 'PENDING',
      totalAmount: 3100,
      openAmount: 3100,
      transfers: [
        { payerIban: 'DE02120300000000202051', payerName: 'Erika Example', amount: 3100 },
      ],
      orderId,
      creditNoteNumber: result.creditNote!.number,
    });
    expect(todo.rows).toMatchObject([{ id: result.refunds[0]!.id, kind: 'MANUAL' }]);
    // Manual refunds are not executed by the PayPal job.
    expect(await processPaypalRefund(ctx, result.refunds[0]!.id)).toBe('SKIPPED');

    expect(
      await completeManualRefund(ctx, {
        refundId: result.refunds[0]!.id,
        userId,
        note: 'SEPA 2026-03-05',
      }),
    ).toBe(true);
    expect(await completeManualRefund(ctx, { refundId: result.refunds[0]!.id, userId })).toBe(
      false,
    );
    expect(await countOpenRefunds(ctx)).toBe(open0);
    const after = await load(orderId);
    expect(after.refundRows[0]).toMatchObject({
      status: 'SUCCEEDED',
      completedByUserId: userId,
      note: 'SEPA 2026-03-05',
    });
    expect(after.refundRows[0]!.completedAt).toBeTruthy();
    expect(after.order.amountRefunded).toBe(3100);
    const [payment] = await handle.db.select().from(payments).where(eq(payments.orderId, orderId));
    expect(payment!.status).toBe('REFUNDED');
  });

  it('handles PayPal errors: transient is retried, permanent becomes a FAILED to-do, retry re-queues, PENDING resolves by status poll', async () => {
    mockPayPal();
    const { orderId } = await paidOrder([seatIds[7]!], 'PAYPAL');
    const result = await cancelPaidOrder(ctx, {
      orderId,
      refundFees: false,
      notify: false,
      userId,
    });
    const refundId = result.refunds[0]!.id;

    paypalRefundStatus = 503;
    await expect(processPaypalRefund(ctx, refundId)).rejects.toBeTruthy();
    expect((await load(orderId)).refundRows[0]!.status).toBe('PENDING');

    paypalRefundStatus = 422;
    expect(await processPaypalRefund(ctx, refundId)).toBe('FAILED');
    expect((await load(orderId)).refundRows[0]).toMatchObject({ status: 'FAILED' });
    expect(
      (await listOpenRefunds(ctx)).some(
        (r) => r.rows.some((x) => x.id === refundId) && r.status === 'FAILED',
      ),
    ).toBe(true);

    paypalRefundStatus = 200;
    paypalRefundState = 'PENDING';
    jobs.add.mockClear();
    await retryRefund(ctx, refundId, userId);
    expect(jobs.add).toHaveBeenCalled();
    expect(await processPaypalRefund(ctx, refundId)).toBe('PENDING');
    const pending = (await load(orderId)).refundRows[0]!;
    expect(pending.status).toBe('PENDING');
    expect(pending.providerRefundId).toBeTruthy();

    // The sweeper re-queues it once it is old enough; the next run polls PayPal's state.
    await handle.db
      .update(refunds)
      .set({ updatedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(refunds.id, refundId));
    expect(await requeueStaleRefunds(ctx)).toBeGreaterThanOrEqual(1);
    expect(await processPaypalRefund(ctx, refundId)).toBe('SUCCEEDED');
    expect((await load(orderId)).order.amountRefunded).toBe(3000);
  });

  it('refunds a per-ticket fee remainder when tickets are cancelled one by one (33 + 33 + 34)', async () => {
    const { orderId } = await paidOrder(
      [seatIds[10]!, seatIds[11]!, seatIds[12]!],
      'BANK_TRANSFER',
      {
        oddFee: true,
      },
    );
    const [fee] = await handle.db.select().from(orderFees).where(eq(orderFees.orderId, orderId));
    const items = await handle.db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const credited: number[] = [];
    for (const item of items) {
      const r = await cancelPaidOrder(ctx, {
        orderId,
        orderItemIds: [item.id],
        refundFees: true,
        notify: false,
        userId,
      });
      credited.push(r.creditTotal - 3000);
    }
    expect(credited).toEqual([33, 33, 34]);
    const [after] = await handle.db.select().from(orderFees).where(eq(orderFees.id, fee!.id));
    expect(after!.isRefunded).toBe(true);
    // The credit notes add up to the invoice exactly (no cent drift in net / tax).
    const docs = await handle.db.select().from(invoices).where(eq(invoices.orderId, orderId));
    const sum = (pick: (i: (typeof docs)[number]) => number) =>
      docs.reduce((a, i) => a + pick(i), 0);
    expect(sum((i) => i.totalGross)).toBe(0);
    expect(sum((i) => i.totalNet)).toBe(0);
    expect(sum((i) => i.totalTax)).toBe(0);
  });

  it('retries a refund the provider declined with a new request id', async () => {
    mockPayPal();
    paypalCalls.length = 0;
    const { orderId } = await paidOrder([seatIds[13]!], 'PAYPAL');
    const result = await cancelPaidOrder(ctx, {
      orderId,
      refundFees: false,
      notify: false,
      userId,
    });
    const refundId = result.refunds[0]!.id;
    paypalRefundState = 'FAILED';
    expect(await processPaypalRefund(ctx, refundId)).toBe('FAILED');
    const failed = (await load(orderId)).refundRows[0]!;
    expect(failed.providerRefundId).toBeTruthy();

    paypalRefundState = 'COMPLETED';
    await retryRefund(ctx, refundId, userId);
    const retried = (await load(orderId)).refundRows[0]!;
    expect(retried).toMatchObject({ status: 'PENDING', attempt: 2, providerRefundId: null });
    expect(await processPaypalRefund(ctx, refundId)).toBe('SUCCEEDED');
    const ids = paypalCalls.filter((c) => c.path.endsWith('/refund')).map((c) => c.requestId);
    expect(ids).toEqual([`tix-refund-${refundId}-1`, `tix-refund-${refundId}-2`]);
    const after = await load(orderId);
    expect(after.order.amountRefunded).toBe(3000);
  });

  it('retries the failed PayPal rows of a batch', async () => {
    mockPayPal();
    const { orderId } = await paidOrder([seatIds[8]!], 'PAYPAL');
    const result = await cancelPaidOrder(ctx, {
      orderId,
      refundFees: false,
      notify: false,
      userId,
    });
    paypalRefundStatus = 422;
    expect(await processPaypalRefund(ctx, result.refunds[0]!.id)).toBe('FAILED');
    const batch = (await listOpenRefunds(ctx)).find((b) => b.batchId === result.batchId)!;
    expect(batch).toMatchObject({ status: 'FAILED', canRetry: true, canComplete: false });
    paypalRefundStatus = 200;
    expect(await retryRefundBatch(ctx, { batchId: result.batchId, userId })).toEqual([
      result.refunds[0]!.id,
    ]);
    expect((await load(orderId)).refundRows[0]!.status).toBe('PENDING');
    await expect(retryRefundBatch(ctx, { batchId: result.batchId, userId })).rejects.toMatchObject({
      code: 'REFUND_NOT_RETRYABLE',
    });
  });

  describe('reconcile PayPal refunds after a restore', () => {
    let nextSeat = 20;
    const seat = () => seatIds[nextSeat++]!;
    const eur = (amount: number) => ({ currency_code: 'EUR', value: (amount / 100).toFixed(2) });
    const up = (capture: string) => [
      { rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${capture}` },
    ];
    const remoteRefund = (id: string, status: string, amount: number, customId?: string) => ({
      id,
      status,
      amount: eur(amount),
      ...(customId ? { custom_id: customId } : {}),
    });
    const detail = (
      capture: string,
      id: string,
      status: string,
      amount: number,
      customId?: string,
    ) =>
      paypalRefundDetails.set(id, {
        ...remoteRefund(id, status, amount, customId),
        links: up(capture),
      });
    const captureOf = async (orderId: string) =>
      (await handle.db.select().from(payments).where(eq(payments.orderId, orderId)))[0]!
        .providerCaptureId!;
    const withProviderOrder = async (orderId: string) => {
      const providerOrderId = `PO-${uuid().slice(0, 8)}`;
      await handle.db
        .update(payments)
        .set({ providerOrderId })
        .where(eq(payments.orderId, orderId));
      return providerOrderId;
    };
    const cancelOne = (orderId: string, orderItemIds?: string[]) =>
      cancelPaidOrder(ctx, { orderId, orderItemIds, refundFees: false, notify: false, userId });
    const posts = () => paypalCalls.filter((x) => x.path.endsWith('/refund'));
    const reviewKinds = async () => {
      const rows = await listRefundRestoreReviews(ctx);
      return new Map(rows.map((r) => [r.orderId, r.findings.map((f) => f.kind).sort()]));
    };
    const run = (options: { force?: boolean; pageSize?: number } = { force: true }) =>
      reconcileRefundsAfterRestore(ctx, options);

    beforeEach(async () => {
      await handle.db.execute(sql`UPDATE payments SET provider_order_id = NULL`);
      await handle.db.execute(
        sql`DELETE FROM order_history WHERE type LIKE 'refund_restore_review%'`,
      );
      await handle.db.execute(sql`DELETE FROM refund_reconcile_state`);
      await redis.del(ctx.keys.refundReconcilePending(), ctx.keys.refundReconcileLock());
      paypalCalls.length = 0;
    });

    it('settles PENDING rows from PayPal (no re-send), reads custom_id from the refund resource, records unknown refunds once', async () => {
      mockPayPal();
      const a = await paidOrder([seat()], 'PAYPAL');
      const b = await paidOrder([seat()], 'PAYPAL');
      const c = await paidOrder([seat()], 'PAYPAL');
      const d = await paidOrder([seat()], 'PAYPAL');
      const ra = (await cancelOne(a.orderId)).refunds[0]!;
      const rb = (await cancelOne(b.orderId)).refunds[0]!;
      const rc = (await cancelOne(c.orderId)).refunds[0]!;
      const [poA, poB, poC, poD] = [
        await withProviderOrder(a.orderId),
        await withProviderOrder(b.orderId),
        await withProviderOrder(c.orderId),
        await withProviderOrder(d.orderId),
      ];
      paypalCalls.length = 0;

      // A: refunded after the backup; the order details lack custom_id → the refund resource has it.
      paypalOrderRefunds.set(poA, [remoteRefund('RF-A', 'COMPLETED', ra.amount)]);
      detail(await captureOf(a.orderId), 'RF-A', 'COMPLETED', ra.amount, ra.id);
      // B: declined by PayPal. C: PayPal never saw it. D: refunded in the lost window (no local row).
      paypalOrderRefunds.set(poB, [remoteRefund('RF-B', 'FAILED', rb.amount, rb.id)]);
      paypalOrderRefunds.set(poD, [remoteRefund('RF-D', 'COMPLETED', 1234)]);
      detail(await captureOf(d.orderId), 'RF-D', 'COMPLETED', 1234);

      await markRefundsForReconciliation(ctx, 'test');
      await expect(processPaypalRefund(ctx, rc.id)).rejects.toMatchObject({
        code: 'REFUNDS_RECONCILING',
      });
      expect(await requeueStaleRefunds(ctx)).toBe(0);
      expect(posts()).toHaveLength(0);

      const result = await run();
      expect(result).toMatchObject({
        checked: 4,
        settled: 2,
        reviewed: 1,
        errors: 0,
        complete: true,
      });
      expect(await isRefundReconcilePending(ctx)).toBe(false);
      expect((await load(a.orderId)).refundRows[0]).toMatchObject({
        status: 'SUCCEEDED',
        providerRefundId: 'RF-A',
      });
      expect((await load(a.orderId)).order.status).toBe('REFUNDED');
      expect((await load(b.orderId)).refundRows[0]).toMatchObject({ status: 'FAILED' });
      expect((await load(c.orderId)).refundRows[0]).toMatchObject({ status: 'PENDING' });
      expect(posts()).toHaveLength(0);

      // C was never sent: the normal job sends it with the unchanged request id.
      expect(await processPaypalRefund(ctx, rc.id)).toBe('SUCCEEDED');
      expect(posts().map((x) => x.requestId)).toEqual([`tix-refund-${rc.id}-1`]);
      // From now on PayPal lists that refund as well.
      const sentId = (await load(c.orderId)).refundRows[0]!.providerRefundId!;
      paypalOrderRefunds.set(poC, [remoteRefund(sentId, 'COMPLETED', rc.amount, rc.id)]);

      // D: not booked, visible for review – once; resolved reviews stay resolved.
      expect([...(await reviewKinds()).entries()]).toEqual([[d.orderId, ['UNKNOWN_AT_PAYPAL']]]);
      await markRefundsForReconciliation(ctx, 'test');
      expect(await run()).toMatchObject({ reviewed: 1, complete: true });
      expect(await listRefundRestoreReviews(ctx)).toHaveLength(1);
      await resolveRefundRestoreReview(ctx, { orderId: d.orderId, userId });
      expect(await listRefundRestoreReviews(ctx)).toHaveLength(0);
      await markRefundsForReconciliation(ctx, 'test');
      await run();
      expect(await listRefundRestoreReviews(ctx)).toHaveLength(0);
      await expect(
        resolveRefundRestoreReview(ctx, { orderId: d.orderId, userId }),
      ).rejects.toMatchObject({ code: 'REFUND_REVIEW_NOT_FOUND' });
    });

    it('holds automatic refunds of an order under review and records the existing PayPal refund instead of refunding twice', async () => {
      mockPayPal();
      const o = await paidOrder([seat(), seat()], 'PAYPAL');
      const po = await withProviderOrder(o.orderId);
      const cap = await captureOf(o.orderId);
      // One ticket (30 €) was refunded at PayPal in the lost window.
      paypalOrderRefunds.set(po, [remoteRefund('RF-X', 'COMPLETED', 3000)]);
      detail(cap, 'RF-X', 'COMPLETED', 3000);
      await markRefundsForReconciliation(ctx, 'test');
      await run();
      expect((await reviewKinds()).get(o.orderId)).toEqual(['UNKNOWN_AT_PAYPAL']);

      // A normal cancellation would refund the same money a second time: rejected.
      paypalCalls.length = 0;
      await expect(cancelOne(o.orderId)).rejects.toMatchObject({ code: 'REFUND_REVIEW_OPEN' });
      expect(posts()).toHaveLength(0);
      const items = (await load(o.orderId)).items;
      const record = (ids: string[], refundId = 'RF-X') =>
        recordExistingPayPalRefund(ctx, {
          orderId: o.orderId,
          providerRefundId: refundId,
          orderItemIds: ids,
          refundFees: false,
          notify: false,
          userId,
        });
      // Both tickets do not add up to the PayPal amount.
      await expect(record(items.map((i) => i.id))).rejects.toMatchObject({
        code: 'REFUND_EXISTING_MISMATCH',
      });
      // A refund that is not completed at PayPal cannot be recorded.
      detail(cap, 'RF-P', 'PENDING', 3000);
      await expect(record([items[0]!.id], 'RF-P')).rejects.toMatchObject({
        code: 'PAYPAL_REFUND_NOT_COMPLETED',
      });
      // A refund of another capture neither.
      detail('OTHER-CAPTURE', 'RF-O', 'COMPLETED', 3000);
      await expect(record([items[0]!.id], 'RF-O')).rejects.toMatchObject({
        code: 'PAYPAL_REFUND_MISMATCH',
      });
      expect((await load(o.orderId)).order.status).toBe('PAID');

      const result = await record([items[0]!.id]);
      expect(result.refunds).toHaveLength(1);
      expect(result.refunds[0]).toMatchObject({ kind: 'AUTOMATIC', amount: 3000 });
      expect(result.creditNote).not.toBeNull();
      const after = await load(o.orderId);
      expect(after.order.status).toBe('PARTIALLY_REFUNDED');
      expect(after.order.amountRefunded).toBe(3000);
      expect(after.refundRows).toHaveLength(1);
      expect(after.refundRows[0]).toMatchObject({ status: 'SUCCEEDED', providerRefundId: 'RF-X' });
      expect(posts()).toHaveLength(0); // nothing was sent to PayPal
      expect(await listRefundRestoreReviews(ctx)).toHaveLength(0); // resolved with the recording
      await expect(record([items[1]!.id])).rejects.toMatchObject({
        code: 'PAYPAL_REFUND_ALREADY_RECORDED',
      });

      // The hold is gone: the second ticket is refunded normally, exactly once.
      const second = (await cancelOne(o.orderId, [items[1]!.id])).refunds[0]!;
      expect(await processPaypalRefund(ctx, second.id)).toBe('SUCCEEDED');
      expect(posts()).toHaveLength(1);
    });

    it('holds a pending automatic refund while its order is under review, and the webhook creates a finding', async () => {
      mockPayPal();
      const o = await paidOrder([seat()], 'PAYPAL');
      const refund = (await cancelOne(o.orderId)).refunds[0]!;
      const { recordRefundReview } = await import('../src/orders/refund-state');
      await recordRefundReview(handle.db, o.orderId, [
        { kind: 'EXTERNAL_REFUND_NOTICE', ref: 'RF-W', amount: 3000, currency: 'EUR' },
      ]);
      await expect(processPaypalRefund(ctx, refund.id)).rejects.toMatchObject({
        code: 'REFUNDS_REVIEW_OPEN',
      });
      expect(posts()).toHaveLength(0);
      expect((await reviewKinds()).get(o.orderId)).toEqual(['EXTERNAL_REFUND_NOTICE']);
      await resolveRefundRestoreReview(ctx, { orderId: o.orderId, userId });
      expect(await processPaypalRefund(ctx, refund.id)).toBe('SUCCEEDED');
    });

    it('groups remote refunds per row (COMPLETED > PENDING > FAILED), flags double payouts and amount mismatches, never reuses a request id', async () => {
      mockPayPal();
      const mk = async () => {
        const o = await paidOrder([seat()], 'PAYPAL');
        const r = (await cancelOne(o.orderId)).refunds[0]!;
        return { o, r, po: await withProviderOrder(o.orderId) };
      };
      const dbl = await mk();
      const mixed = await mk();
      const pend = await mk();
      const allFail = await mk();
      const mism = await mk();
      const lost = await mk(); // locally SUCCEEDED with a PayPal id, PayPal shows nothing
      const manual = await mk(); // completed by hand by finance: never flagged
      const amt = dbl.r.amount;
      paypalOrderRefunds.set(dbl.po, [
        remoteRefund('D1', 'COMPLETED', amt, dbl.r.id),
        remoteRefund('D2', 'COMPLETED', amt, dbl.r.id),
      ]);
      paypalOrderRefunds.set(mixed.po, [
        remoteRefund('M1', 'FAILED', amt, mixed.r.id),
        remoteRefund('M2', 'COMPLETED', amt, mixed.r.id),
      ]);
      paypalOrderRefunds.set(pend.po, [
        remoteRefund('P1', 'FAILED', amt, pend.r.id),
        remoteRefund('P2', 'PENDING', amt, pend.r.id),
      ]);
      paypalOrderRefunds.set(allFail.po, [
        remoteRefund('F1', 'FAILED', amt, allFail.r.id),
        remoteRefund('F2', 'CANCELLED', amt, allFail.r.id),
      ]);
      paypalOrderRefunds.set(mism.po, [remoteRefund('X1', 'COMPLETED', amt - 500, mism.r.id)]);
      await handle.db
        .update(refunds)
        .set({ status: 'SUCCEEDED', providerRefundId: 'RF-LOST' })
        .where(eq(refunds.id, lost.r.id));
      await handle.db
        .update(refunds)
        .set({ status: 'SUCCEEDED', completedByUserId: userId })
        .where(eq(refunds.id, manual.r.id));

      await markRefundsForReconciliation(ctx, 'test');
      expect(await run()).toMatchObject({ checked: 7, complete: true, errors: 0 });

      expect((await load(dbl.o.orderId)).refundRows[0]).toMatchObject({ status: 'SUCCEEDED' });
      expect((await load(mixed.o.orderId)).refundRows[0]).toMatchObject({
        status: 'SUCCEEDED',
        providerRefundId: 'M2',
      });
      expect((await load(pend.o.orderId)).refundRows[0]).toMatchObject({
        status: 'PENDING',
        providerRefundId: 'P2',
      });
      const failed = (await load(allFail.o.orderId)).refundRows[0]!;
      expect(failed.status).toBe('FAILED');
      expect(failed.attempt).toBeGreaterThanOrEqual(2);
      // S1: amount differs → not settled
      expect((await load(mism.o.orderId)).refundRows[0]).toMatchObject({ status: 'PENDING' });

      const kinds = await reviewKinds();
      expect(kinds.get(dbl.o.orderId)).toEqual(['DOUBLE_REFUND_AT_PAYPAL']);
      expect(kinds.get(mism.o.orderId)).toEqual(['AMOUNT_MISMATCH']);
      expect(kinds.get(lost.o.orderId)).toEqual(['LOCAL_SUCCEEDED_NOT_AT_PAYPAL']);
      expect(kinds.has(mixed.o.orderId)).toBe(false);
      expect(kinds.has(pend.o.orderId)).toBe(false);
      expect(kinds.has(allFail.o.orderId)).toBe(false);
      expect(kinds.has(manual.o.orderId)).toBe(false);

      // The retry of the declined row uses a request id PayPal has never seen (attempt 3).
      await retryRefund(ctx, failed.id, userId);
      paypalCalls.length = 0;
      expect(await processPaypalRefund(ctx, failed.id)).toBe('SUCCEEDED');
      expect(posts().map((x) => x.requestId)).toEqual([`tix-refund-${failed.id}-3`]);
    });

    it('keeps the durable marker (DB is authoritative), single flight, back-off, token compare and the audited override', async () => {
      mockPayPal();
      const o = await paidOrder([seat()], 'PAYPAL');
      const r = (await cancelOne(o.orderId)).refunds[0]!;
      await withProviderOrder(o.orderId);

      const token = await markRefundsForReconciliation(ctx, 'test');
      await redis.del(ctx.keys.refundReconcilePending()); // Redis lost: the DB row still blocks
      expect(await isRefundReconcilePending(ctx)).toBe(true);
      await expect(processPaypalRefund(ctx, r.id)).rejects.toMatchObject({
        code: 'REFUNDS_RECONCILING',
      });
      expect(await getRefundReconcileStatus(ctx)).toMatchObject({ pending: true, token });

      // Single flight: a pass holding the lock makes a second one skip.
      await redis.set(ctx.keys.refundReconcileLock(), 'other', 'PX', 60_000);
      expect(await run()).toMatchObject({ skipped: 'LOCKED', complete: false });
      await redis.del(ctx.keys.refundReconcileLock());

      // A failing pass keeps the marker, records the error and backs off.
      paypalOrderStatus = 503;
      const failing = await run();
      expect(failing).toMatchObject({ complete: false });
      expect(failing.errors).toBeGreaterThan(0);
      const status = await getRefundReconcileStatus(ctx);
      expect(status).toMatchObject({ pending: true, attempts: 1 });
      expect(status.lastError).toBeTruthy();
      expect(await run({ force: false })).toMatchObject({ skipped: 'BACKOFF' });
      paypalOrderStatus = 200;

      // A newer restore sets a new marker while an older pass is still running: the older pass
      // must not clear it.
      onOrderFetch = async () => {
        onOrderFetch = null;
        await markRefundsForReconciliation(ctx, 'second restore');
      };
      const older = await run();
      expect(older.complete).toBe(true);
      const afterOlder = await getRefundReconcileStatus(ctx);
      expect(afterOlder.pending).toBe(true);
      expect(afterOlder.token).not.toBe(token);
      expect(afterOlder.reason).toBe('second restore');

      // The second restore's own pass completes and clears both the row and the flag.
      expect(await run()).toMatchObject({ complete: true });
      expect(await isRefundReconcilePending(ctx)).toBe(false);
      expect((await getRefundReconcileStatus(ctx)).lastSuccessAt).toBeTruthy();

      // SUPER_ADMIN override clears an unfinished marker.
      await markRefundsForReconciliation(ctx, 'third');
      await skipRefundReconciliation(ctx);
      expect(await isRefundReconcilePending(ctx)).toBe(false);
    });

    it('treats 404 as unchecked when automatic refunds exist (review hold) and alerts when most orders are unknown', async () => {
      mockPayPal();
      const o = await paidOrder([seat()], 'PAYPAL');
      const r = (await cancelOne(o.orderId)).refunds[0]!;
      await withProviderOrder(o.orderId);
      paypalOrderStatus = 404;
      await markRefundsForReconciliation(ctx, 'test');
      expect(await run()).toMatchObject({
        checked: 1,
        notFound: 1,
        unchecked: 1,
        reviewed: 0,
        complete: true,
      });
      expect((await reviewKinds()).get(o.orderId)).toEqual(['UNCHECKED_AT_PAYPAL']);
      await expect(processPaypalRefund(ctx, r.id)).rejects.toMatchObject({
        code: 'REFUNDS_REVIEW_OPEN',
      });

      // Wrong environment / account restored: nothing is known → alert, marker stays.
      await handle.db.execute(
        sql`UPDATE payments SET provider_order_id = 'PO-' || id::text WHERE provider_capture_id IS NOT NULL`,
      );
      await markRefundsForReconciliation(ctx, 'test');
      const result = await run();
      expect(result).toMatchObject({ alert: 'MOSTLY_NOT_FOUND', complete: false });
      expect(await getRefundReconcileStatus(ctx)).toMatchObject({
        pending: true,
        alert: 'MOSTLY_NOT_FOUND',
      });
      await skipRefundReconciliation(ctx);
    });

    it('marker: only a missing table is tolerated, and only before the restore', async () => {
      const failing = (code: string | undefined, wrap = false) => {
        const pgError = Object.assign(new Error('boom'), code ? { code } : {});
        const error = wrap ? Object.assign(new Error('query failed'), { cause: pgError }) : pgError;
        return {
          redis: ctx.redis,
          keys: ctx.keys,
          db: {
            insert: () => ({
              values: () => ({
                onConflictDoUpdate: async () => {
                  throw error;
                },
              }),
            }),
          },
        } as unknown as Pick<CoreContext, 'redis' | 'keys' | 'db'>;
      };
      // Before the database is replaced the table may be missing (older schema): tolerated.
      await expect(
        markRefundsForReconciliation(failing('42P01', true), 'test', undefined, 'pre'),
      ).resolves.toBeTruthy();
      // Any other error, or the same error after the migrations, is not.
      await expect(
        markRefundsForReconciliation(failing('42501'), 'test', undefined, 'pre'),
      ).rejects.toThrow('boom');
      await expect(
        markRefundsForReconciliation(failing('42P01'), 'test', undefined, 'post'),
      ).rejects.toThrow('boom');
      await redis.del(ctx.keys.refundReconcilePending());
    });

    it('a pass that lost its lock stops and leaves the marker alone', async () => {
      mockPayPal();
      const a = await paidOrder([seat()], 'PAYPAL');
      const b = await paidOrder([seat()], 'PAYPAL');
      await withProviderOrder(a.orderId);
      await withProviderOrder(b.orderId);
      await markRefundsForReconciliation(ctx, 'test');
      onOrderFetch = async () => {
        onOrderFetch = null;
        // Taken over / expired while the first order was being checked.
        await redis.set(ctx.keys.refundReconcileLock(), 'someone-else', 'PX', 60_000);
      };
      const result = await run();
      expect(result).toMatchObject({ skipped: 'LOCKED', complete: false });
      expect(result.checked).toBe(1); // the second order was never touched
      expect(await redis.get(ctx.keys.refundReconcileLock())).toBe('someone-else');
      expect(await isRefundReconcilePending(ctx)).toBe(true);
      await redis.del(ctx.keys.refundReconcileLock());
      expect(await run()).toMatchObject({ complete: true });
    });

    it('a FAILED local row whose PayPal refund is still pending goes back to PENDING; FAILED rows get their attempt counter raised', async () => {
      mockPayPal();
      const x = await paidOrder([seat()], 'PAYPAL');
      const y = await paidOrder([seat()], 'PAYPAL');
      const rx = (await cancelOne(x.orderId)).refunds[0]!;
      const ry = (await cancelOne(y.orderId)).refunds[0]!;
      for (const r of [rx, ry]) {
        await handle.db
          .update(refunds)
          .set({ status: 'FAILED', failureMessage: 'declined' })
          .where(eq(refunds.id, r.id));
      }
      const pox = await withProviderOrder(x.orderId);
      const poy = await withProviderOrder(y.orderId);
      paypalOrderRefunds.set(pox, [remoteRefund('XP', 'PENDING', rx.amount, rx.id)]);
      paypalOrderRefunds.set(poy, [
        remoteRefund('Y1', 'FAILED', ry.amount, ry.id),
        remoteRefund('Y2', 'FAILED', ry.amount, ry.id),
        remoteRefund('Y3', 'CANCELLED', ry.amount, ry.id),
      ]);
      await markRefundsForReconciliation(ctx, 'test');
      expect(await run()).toMatchObject({ complete: true });
      expect((await load(x.orderId)).refundRows[0]).toMatchObject({
        status: 'PENDING',
        providerRefundId: 'XP',
        failureMessage: null,
      });
      const rowY = (await load(y.orderId)).refundRows[0]!;
      expect(rowY.status).toBe('FAILED');
      expect(rowY.attempt).toBeGreaterThanOrEqual(3);
      // The retry creates a request id PayPal has not seen.
      await retryRefund(ctx, ry.id, userId);
      expect((await load(y.orderId)).refundRows[0]!.attempt).toBeGreaterThanOrEqual(4);
    });

    it('records an existing PayPal refund against the capture it belongs to (second capture of the order)', async () => {
      mockPayPal();
      const o = await paidOrder([seat()], 'PAYPAL');
      const first = (
        await handle.db.select().from(payments).where(eq(payments.orderId, o.orderId))
      )[0]!;
      // An additional payment (tariff upgrade) came in later with its own, newer capture.
      await handle.db.insert(payments).values({
        orderId: o.orderId,
        method: 'PAYPAL',
        status: 'CAPTURED',
        amount: 1000,
        currency: 'EUR',
        providerCaptureId: `CAP-2-${uuid().slice(0, 6)}`,
        capturedAt: new Date(Date.now() + 60_000),
      });
      detail(first.providerCaptureId!, 'RF-Y', 'COMPLETED', 3000);
      const items = (await load(o.orderId)).items;
      const result = await recordExistingPayPalRefund(ctx, {
        orderId: o.orderId,
        providerRefundId: 'RF-Y',
        orderItemIds: [items[0]!.id],
        refundFees: false,
        notify: false,
        userId,
      });
      expect(result.refunds[0]).toMatchObject({ kind: 'AUTOMATIC', amount: 3000 });
      const rows = (await load(o.orderId)).refundRows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'SUCCEEDED',
        providerRefundId: 'RF-Y',
        paymentId: first.id,
      });
      expect(posts()).toHaveLength(0);
    });

    it('records an existing PayPal refund of an overpayment (no tickets) and holds overpayment refunds under review', async () => {
      mockPayPal();
      const o = await paidOrder([seat()], 'PAYPAL');
      const overCapture = `CAP-OV-${uuid().slice(0, 6)}`;
      await recordPayment(ctx, {
        orderId: o.orderId,
        amount: 500,
        currency: 'EUR',
        method: 'PAYPAL',
        providerCaptureId: overCapture,
        actor: { type: 'SYSTEM' },
      });
      const { recordRefundReview } = await import('../src/orders/refund-state');
      await recordRefundReview(handle.db, o.orderId, [
        { kind: 'UNKNOWN_AT_PAYPAL', ref: 'RF-OV', amount: 500, currency: 'EUR' },
      ]);
      // A normal overpayment refund would pay the 5 € twice: held.
      await expect(
        refundOverpayment(ctx, { orderId: o.orderId, userId, expectedAmount: 500 }),
      ).rejects.toMatchObject({ code: 'REFUND_REVIEW_OPEN' });

      detail(overCapture, 'RF-OV', 'COMPLETED', 500);
      paypalCalls.length = 0;
      const result = await recordExistingPayPalOverpaymentRefund(ctx, {
        orderId: o.orderId,
        userId,
        providerRefundId: 'RF-OV',
      });
      expect(result.amount).toBe(500);
      const after = await load(o.orderId);
      expect(after.refundRows).toHaveLength(1);
      expect(after.refundRows[0]).toMatchObject({
        overpayment: true,
        status: 'SUCCEEDED',
        providerRefundId: 'RF-OV',
        amount: 500,
      });
      expect(after.order.status).toBe('PAID'); // an overpayment refund keeps the order as it is
      expect(after.order.amountRefunded).toBe(500);
      expect(posts()).toHaveLength(0);
      expect(await listRefundRestoreReviews(ctx)).toHaveLength(0);
    });

    it('pages through all candidates and only checks captures within the refund window (or with open refunds)', async () => {
      mockPayPal();
      const fresh = [];
      for (let i = 0; i < 4; i += 1) fresh.push(await paidOrder([seat()], 'PAYPAL'));
      const old = await paidOrder([seat()], 'PAYPAL');
      const oldOpen = await paidOrder([seat()], 'PAYPAL');
      await cancelOne(oldOpen.orderId); // PENDING automatic refund
      for (const o of [...fresh, old, oldOpen]) await withProviderOrder(o.orderId);
      await handle.db
        .update(payments)
        .set({ capturedAt: new Date(Date.now() - 200 * 86_400_000) })
        .where(inArray(payments.orderId, [old.orderId, oldOpen.orderId]));
      await markRefundsForReconciliation(ctx, 'test');
      // 4 fresh + the old capture with an open refund; the old plain capture is outside PayPal's window.
      expect(await run({ force: true, pageSize: 2 })).toMatchObject({
        checked: 5,
        complete: true,
      });
    });
  });
});
