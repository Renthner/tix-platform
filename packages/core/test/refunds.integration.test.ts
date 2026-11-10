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
import { asc, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
const redisUrl = process.env.REDIS_URL;
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
      seats: Array.from({ length: 14 }, (_, i) => ({
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
        if (url.includes('/v2/payments/refunds/')) {
          return json({ id: url.split('/').pop(), status: 'COMPLETED' });
        }
        return json({}, 404);
      }),
    );

  afterEach(() => {
    vi.unstubAllGlobals();
    paypalRefundStatus = 200;
    paypalRefundState = 'COMPLETED';
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
});
