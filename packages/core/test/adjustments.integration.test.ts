/**
 * Additional payments for paid orders (tariff change reduced → normal) against real PostgreSQL +
 * Redis (throw-away database, own Redis prefix): propose → confirm → PayPal / bank payment →
 * items, totals, tickets and invoice corrected exactly once; wrong amounts, cancelled adjustments,
 * concurrency, cancellation of paid orders, reminder. PayPal HTTP is mocked; the job queue is a
 * mock, so no PDF is rendered and no object storage is touched.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminUsers,
  bankAccounts,
  bankTransactionAllocations,
  bankTransactions,
  createDb,
  emailMessages,
  events,
  fees,
  invoiceSupersessions,
  invoices,
  loadRootEnv,
  orderAdjustments,
  orderHistory,
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
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { asc, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addSeats,
  afterSeatMapSaved,
  assignBankTransaction,
  cancelAdjustment,
  cancelPaidOrder,
  completePayPalPayment,
  confirmAdjustment,
  countAdjustmentsNeedingAttention,
  createCoreContext,
  enterShop,
  ensureOrderTickets,
  findActiveInvoice,
  issueInvoice,
  deliverEmailMessage,
  changeOrderSeats,
  countInvoiceCorrections,
  countOpenRefunds,
  completeRefundBatch,
  getOrderCredit,
  listOpenRefunds,
  listOrderRefundBatches,
  processPaypalRefund,
  refundOverpayment,
  listInvoiceCorrections,
  repairOrderInvoice,
  reconcileAdjustmentPayPal,
  startPayPalPayment,
  runDunning,
  getAnonymizationBlockers,
  getCheckoutOptions,
  getEventById,
  handlePayPalWebhook,
  listOpenAdjustments,
  loadAccountingData,
  matchBankTransactions,
  placeOrder,
  proposeTariffChange,
  recordManualAdjustmentPayment,
  recordPayment,
  renderEmail,
  parseStoredEmailRequest,
  EMAIL_VARIABLES_CONTEXT,
  reverseBankAllocation,
  saveSecretSetting,
  saveSeatMapDocument,
  saveSetting,
  sendAdjustmentReminders,
  setTariff,
  startAdjustmentPayPalPayment,
  ticketHasOpenAdjustment,
  type CoreContext,
  type EventRow,
  type JobQueues,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)('additional payments / tariff change (integration)', () => {
  const dbName = `tix_adjust_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let event: EventRow;
  let seatIds: string[] = [];
  let userId: string;
  let normalId: string;
  let reducedId: string;
  let bankAccountId: string;
  const jobs = { add: vi.fn(async () => 'job'), close: async () => {} };

  // ── PayPal mock ──────────────────────────────────────────────────────────
  const paypal = {
    created: new Map<string, { amount: string; custom: string }>(),
    approved: new Set<string>(),
    pending: new Set<string>(),
    captures: 0,
    refunds: [] as { captureId: string }[],
    seq: 0,
  };
  const mockPayPal = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const path = url.replace(/^https:\/\/[^/]+/, '');
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        if (path === '/v1/oauth2/token') return json({ access_token: 'tok', expires_in: 3600 });
        if (path === '/v1/notifications/verify-webhook-signature') {
          return json({ verification_status: 'SUCCESS' });
        }
        const method = init?.method ?? 'GET';
        if (path === '/v2/checkout/orders' && method === 'POST') {
          const body = JSON.parse(String(init!.body)) as {
            purchase_units: { amount: { value: string }; custom_id: string }[];
          };
          paypal.seq += 1;
          const id = `PP-${paypal.seq}`;
          paypal.created.set(id, {
            amount: body.purchase_units[0]!.amount.value,
            custom: body.purchase_units[0]!.custom_id,
          });
          return json({
            id,
            status: 'PAYER_ACTION_REQUIRED',
            links: [{ rel: 'payer-action', href: `https://paypal.example/approve/${id}` }],
          });
        }
        const capture = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(path);
        if (capture) {
          const id = capture[1]!;
          if (!paypal.approved.has(id)) {
            return json({ name: 'UNPROCESSABLE', details: [{ issue: 'ORDER_NOT_APPROVED' }] }, 422);
          }
          paypal.captures += 1;
          const capStatus = paypal.pending.has(id) ? 'PENDING' : 'COMPLETED';
          return json({
            id,
            status: 'COMPLETED',
            purchase_units: [
              {
                payments: {
                  captures: [
                    {
                      id: `CAP-${id}`,
                      status: capStatus,
                      amount: { currency_code: 'EUR', value: paypal.created.get(id)!.amount },
                      create_time: new Date().toISOString(),
                    },
                  ],
                },
              },
            ],
          });
        }
        const capGet = /^\/v2\/payments\/captures\/CAP-([^/]+)$/.exec(path);
        if (capGet) {
          const id = capGet[1]!;
          return json({
            id: `CAP-${id}`,
            status: paypal.pending.has(id) ? 'PENDING' : 'COMPLETED',
            amount: { currency_code: 'EUR', value: paypal.created.get(id)!.amount },
            create_time: new Date().toISOString(),
          });
        }
        const order = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(path);
        if (order) {
          const id = order[1]!;
          return json({
            id,
            status: paypal.approved.has(id) ? 'APPROVED' : 'PAYER_ACTION_REQUIRED',
            links: [{ rel: 'payer-action', href: `https://paypal.example/approve/${id}` }],
          });
        }
        const refund = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(path);
        if (refund) {
          paypal.refunds.push({ captureId: refund[1]! });
          return json({ id: `RF-${paypal.refunds.length}`, status: 'COMPLETED' });
        }
        return json({}, 404);
      }),
    );

  // ── Helpers ──────────────────────────────────────────────────────────────
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

  /** Paid order; `reduced` seats carry the reduced tariff (25.00 €), the others normal (30.00 €). */
  async function paidOrder(
    seats: string[],
    method: 'PAYPAL' | 'BANK_TRANSFER',
    reduced: number[] = seats.map((_, i) => i),
  ) {
    const session = `k${uuid().slice(0, 8)}`;
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, seats);
    for (const i of reduced) await setTariff(ctx, session, event, seats[i]!, reducedId);
    const { quotes } = await getCheckoutOptions(ctx, session);
    const total = quotes[method].totalGross;
    const placed = await placeOrder(ctx, { sessionId: session, input: buyer(method, total) });
    const result = await recordPayment(ctx, {
      orderId: placed.orderId,
      amount: total,
      currency: 'EUR',
      method,
      providerCaptureId: method === 'PAYPAL' ? `CAP-${uuid().slice(0, 8)}` : null,
      actor: { type: 'SYSTEM' },
    });
    expect(result.status).toBe('PAID');
    await ensureOrderTickets(ctx, placed.orderId);
    return { orderId: placed.orderId, total };
  }

  const loadOrder = async (orderId: string) => {
    const [order] = await handle.db.select().from(orders).where(eq(orders.id, orderId));
    const items = await handle.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
    const ticketRows = await handle.db
      .select()
      .from(tickets)
      .where(eq(tickets.orderId, orderId))
      .orderBy(asc(tickets.createdAt));
    return { order: order!, items, ticketRows };
  };
  const itemOf = async (orderId: string, seatId: string) =>
    (await loadOrder(orderId)).items.find((i) => i.seatId === seatId)!;
  const adjustmentRow = async (id: string) =>
    (await handle.db.select().from(orderAdjustments).where(eq(orderAdjustments.id, id)))[0]!;
  const historyTypes = async (orderId: string) =>
    (
      await handle.db
        .select({ type: orderHistory.type })
        .from(orderHistory)
        .where(eq(orderHistory.orderId, orderId))
        .orderBy(asc(orderHistory.createdAt))
    ).map((h) => h.type);

  async function propose(orderId: string, seatId: string, extra: { notify?: boolean } = {}) {
    const item = await itemOf(orderId, seatId);
    return proposeTariffChange(ctx, {
      orderId,
      changes: [{ orderItemId: item.id, newTicketTypeId: normalId }],
      reason: 'Reduced tariff does not apply',
      notify: extra.notify ?? true,
      userId,
      canUseCredit: true,
    });
  }

  async function bankCredit(amount: number, text: string) {
    const [row] = await handle.db
      .insert(bankTransactions)
      .values({
        bankAccountId,
        fingerprint: `fp-${uuid()}`,
        bookingDate: '2026-03-01',
        amount,
        currency: 'EUR',
        counterpartyName: 'Erika Example',
        counterpartyIban: 'DE02120300000000202051',
        remittanceInformation: text,
      })
      .returning();
    await matchBankTransactions(ctx, [row!.id]);
    return (
      await handle.db.select().from(bankTransactions).where(eq(bankTransactions.id, row!.id))
    )[0]!;
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
    await seedReferenceData(handle.db, () => {});

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
    normalId = normal!.id;
    reducedId = reduced!.id;
    await handle.db.insert(priceCategoryTicketTypes).values([
      { priceCategoryId: category!.id, ticketTypeId: normal!.id },
      { priceCategoryId: category!.id, ticketTypeId: reduced!.id },
    ]);

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
      seats: Array.from({ length: 60 }, (_, i) => ({
        id: uuid(),
        sectionId,
        rowId,
        label: String(i + 1),
        position: i + 1,
        x: 20 + i * 15,
        y: 20,
        priceCategoryId: category!.id,
      })),
    };
    const saved = await saveSeatMapDocument(handle.db, map!.id, doc, null);
    expect(saved.ok).toBe(true);
    if (saved.ok) await afterSeatMapSaved(ctx, saved);
    seatIds = doc.seats!.map((s) => s.id!);
    event = await getEventById(ctx, ev!.id);

    // 1.50 € service fee per ticket: must stay as sold after a tariff change.
    await handle.db
      .insert(fees)
      .values([{ name: 'Service fee', scope: 'PER_TICKET', calculation: 'FIXED', value: 150 }]);
    const [bank] = await handle.db
      .insert(bankAccounts)
      .values({
        name: 'Main',
        accountHolder: 'Example Theatre e.V.',
        iban: 'DE89370400440532013000',
        currency: 'EUR',
        isDefaultForBankTransfer: true,
      })
      .returning();
    bankAccountId = bank!.id;
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

  // ── Rejections ──────────────────────────────────────────────────────────────

  it('rejects a lower price, a partially refunded order and complimentary orders', async () => {
    mockPayPal();
    const { orderId } = await paidOrder([seatIds[10]!, seatIds[11]!], 'PAYPAL', [0]);
    // Seat 11 is normal (30.00 €): switching to reduced is cheaper.
    const normalItem = await itemOf(orderId, seatIds[11]!);
    await expect(
      proposeTariffChange(ctx, {
        orderId,
        changes: [{ orderItemId: normalItem.id, newTicketTypeId: reducedId }],
        notify: false,
        userId,
      }),
    ).rejects.toMatchObject({ code: 'ADJUSTMENT_NOT_HIGHER' });
    // The same tariff is not a change either.
    const reducedItem = await itemOf(orderId, seatIds[10]!);
    await expect(
      proposeTariffChange(ctx, {
        orderId,
        changes: [{ orderItemId: reducedItem.id, newTicketTypeId: reducedId }],
        notify: false,
        userId,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    // Partially refunded: one ticket cancelled, the rest cannot be changed any more.
    await cancelPaidOrder(ctx, {
      orderId,
      orderItemIds: [normalItem.id],
      refundFees: false,
      notify: false,
      userId,
    });
    expect((await loadOrder(orderId)).order.status).toBe('PARTIALLY_REFUNDED');
    await expect(propose(orderId, seatIds[10]!)).rejects.toMatchObject({
      code: 'ADJUSTMENT_NOT_POSSIBLE_REFUNDED',
    });

    // Complimentary.
    const free = await paidOrder([seatIds[12]!], 'PAYPAL', [0]);
    await handle.db
      .update(orders)
      .set({ paymentMethod: 'COMPLIMENTARY' })
      .where(eq(orders.id, free.orderId));
    await expect(propose(free.orderId, seatIds[12]!)).rejects.toMatchObject({
      code: 'ADJUSTMENT_NOT_POSSIBLE_COMPLIMENTARY',
    });
  });

  // ── PayPal: propose → confirm → capture ──────────────────────────────────────

  it('propose → confirm → PayPal capture corrects items, totals, tickets and invoice exactly once', async () => {
    mockPayPal();
    const { orderId, total } = await paidOrder([seatIds[0]!, seatIds[1]!], 'PAYPAL', [0]);
    expect(total).toBe(2500 + 3000 + 300);
    // An invoice exists after the first payment (issued by the order-paid job in production).
    await issueInvoice(ctx, orderId); // normally issued by the order-paid job
    const before = await loadOrder(orderId);
    const oldTicket = before.ticketRows.find((t) => t.orderItemId === before.items[0]!.id)!;
    const untouchedTicket = before.ticketRows.find((t) => t.orderItemId === before.items[1]!.id)!;

    const proposed = await propose(orderId, seatIds[0]!);
    expect(proposed).toMatchObject({ amount: 500, emailQueued: true, currency: 'EUR' });
    expect(proposed.paymentReference).toMatch(/^TIX-\d{4}-\d{6}-\d$/);

    // Open adjustment: order, item, ticket and totals untouched; ticket stays valid.
    const open = await loadOrder(orderId);
    expect(open.order).toMatchObject({ status: 'PAID', totalGross: 5800, amountPaid: 5800 });
    expect(open.items[0]).toMatchObject({ ticketTypeId: reducedId, priceGross: 2500 });
    expect(open.ticketRows.filter((t) => t.status === 'VALID')).toHaveLength(2);
    expect(await ticketHasOpenAdjustment(handle.db, { orderItemId: open.items[0]!.id })).toBe(true);
    expect(await ticketHasOpenAdjustment(handle.db, { orderItemId: open.items[1]!.id })).toBe(
      false,
    );
    // Only one open adjustment per order.
    await expect(propose(orderId, seatIds[0]!)).rejects.toMatchObject({
      code: 'ADJUSTMENT_ALREADY_OPEN',
    });
    // The request e-mail goes out with the adjustment id; the order link is in the body.
    const [request] = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.templateKey, 'ADDITIONAL_PAYMENT_REQUEST'));
    expect(request).toMatchObject({ orderId, toEmail: 'buyer@example.invalid' });
    const rendered = await renderEmail(ctx, {
      key: 'ADDITIONAL_PAYMENT_REQUEST',
      orderId,
      variables: { adjustmentId: proposed.adjustmentId },
    });
    expect(rendered.missing).toEqual([]);
    expect(rendered.html).toContain('Reduced → Normal');
    expect(rendered.html).toContain('/orders/');
    expect(rendered.subject).toContain('Additional payment');

    // Not payable before the customer confirmed.
    await expect(startAdjustmentPayPalPayment(ctx, proposed.adjustmentId)).rejects.toMatchObject({
      code: 'ADJUSTMENT_NOT_PAYABLE',
    });
    expect(await confirmAdjustment(ctx, { adjustmentId: proposed.adjustmentId, orderId })).toEqual({
      confirmed: true,
    });
    expect(await confirmAdjustment(ctx, { adjustmentId: proposed.adjustmentId, orderId })).toEqual({
      confirmed: false,
    });

    const started = await startAdjustmentPayPalPayment(ctx, proposed.adjustmentId);
    expect(started.status).toBe('REDIRECT');
    const ppId = [...paypal.created.keys()].at(-1)!;
    expect(paypal.created.get(ppId)).toMatchObject({
      amount: '5.00',
      custom: `adj:${proposed.adjustmentId}`,
    });
    // Starting again resumes the same PayPal order (no second one).
    const again = await startAdjustmentPayPalPayment(ctx, proposed.adjustmentId);
    expect(again).toEqual(started);

    // Return without approval: nothing captured, adjustment still open.
    expect(await completePayPalPayment(ctx, orderId, ppId)).toEqual({ status: 'NOT_APPROVED' });
    expect((await adjustmentRow(proposed.adjustmentId)).status).toBe('CONFIRMED');

    paypal.approved.add(ppId);
    const capturesBefore = paypal.captures;
    expect(await completePayPalPayment(ctx, orderId, ppId)).toEqual({ status: 'PAID' });
    // Return page reloaded / webhook after the capture: still one capture, one payment.
    expect(await completePayPalPayment(ctx, orderId, ppId)).toEqual({ status: 'PAID' });
    expect(paypal.captures).toBe(capturesBefore + 1);
    const webhook = (id: string) =>
      handlePayPalWebhook(
        ctx,
        new Headers({
          'paypal-auth-algo': 'a',
          'paypal-cert-url': 'https://paypal.example/cert',
          'paypal-transmission-id': id,
          'paypal-transmission-sig': 's',
          'paypal-transmission-time': new Date().toISOString(),
        }),
        JSON.stringify({
          id,
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource: {
            id: `CAP-${ppId}`,
            amount: { currency_code: 'EUR', value: '5.00' },
            supplementary_data: { related_ids: { order_id: ppId } },
          },
        }),
      );
    expect(await webhook('WH-EVT-1')).toBe('PROCESSED');
    expect(await webhook('WH-EVT-1')).toBe('DUPLICATE');
    expect(await webhook('WH-EVT-2')).toBe('PROCESSED'); // different event, same capture

    const paymentRows = await handle.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId));
    expect(paymentRows).toHaveLength(2);
    const adjustmentPayment = paymentRows.find((p) => p.adjustmentId === proposed.adjustmentId)!;
    expect(adjustmentPayment).toMatchObject({
      method: 'PAYPAL',
      status: 'CAPTURED',
      amount: 500,
      providerCaptureId: `CAP-${ppId}`,
    });

    const after = await loadOrder(orderId);
    // Item shows the normal tariff and price; tax split by the rate used at checkout.
    expect(after.items[0]).toMatchObject({
      ticketTypeId: normalId,
      ticketTypeName: 'Normal',
      unitPriceGross: 3000,
      discountAmount: 0,
      priceGross: 3000,
      priceNet: 2521,
      taxAmount: 479,
    });
    expect(after.items[1]).toMatchObject({ ticketTypeId: normalId, priceGross: 3000 });
    // Totals: +5.00 €, fees as sold, paid in full.
    expect(after.order).toMatchObject({
      status: 'PAID',
      subtotalGross: 6000,
      discountTotal: 0,
      feeTotal: 300,
      totalGross: 6300,
      amountPaid: 6300,
    });
    expect(after.order.totalNet + after.order.totalTax).toBe(6300);
    expect(after.order.version).toBeGreaterThan(before.order.version);
    // Tickets: the changed one replaced by a new VALID one, the other one untouched.
    const replaced = after.ticketRows.find((t) => t.id === oldTicket.id)!;
    expect(replaced.status).toBe('REPLACED');
    const fresh = after.ticketRows.find((t) => t.id === replaced.replacedByTicketId)!;
    expect(fresh).toMatchObject({ status: 'VALID', orderItemId: before.items[0]!.id });
    expect(fresh.qrPayload).not.toBe(oldTicket.qrPayload);
    expect(after.ticketRows.find((t) => t.id === untouchedTicket.id)!.status).toBe('VALID');
    expect(after.ticketRows.filter((t) => t.status === 'VALID')).toHaveLength(2);
    expect(await ticketHasOpenAdjustment(handle.db, { orderItemId: before.items[0]!.id })).toBe(
      false,
    );

    // Invoice: old one negated by a full credit note (superseded) + a new invoice over 63.00 €.
    const docs = await handle.db
      .select()
      .from(invoices)
      .where(eq(invoices.orderId, orderId))
      .orderBy(asc(invoices.issuedAt), asc(invoices.createdAt));
    expect(docs.map((d) => [d.type, d.totalGross])).toEqual([
      ['INVOICE', 5800],
      ['CREDIT_NOTE', -5800],
      ['INVOICE', 6300],
    ]);
    expect(docs[1]!.correctsInvoiceId).toBe(docs[0]!.id);
    const supersessions = await handle.db
      .select()
      .from(invoiceSupersessions)
      .where(eq(invoiceSupersessions.invoiceId, docs[0]!.id));
    expect(supersessions).toHaveLength(1);
    expect((await findActiveInvoice(handle.db, orderId))!.id).toBe(docs[2]!.id);
    expect(new Set(docs.map((d) => d.invoiceNumber)).size).toBe(3);

    // Confirmation e-mail with the new invoice + tickets, once.
    const mails = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.orderId, orderId));
    // A dedicated mail: the credit note (invoice correction), the new invoice and the tickets.
    const confirmations = mails.filter((m) => m.templateKey === 'ADDITIONAL_PAYMENT_RECEIVED');
    expect(confirmations).toHaveLength(1);
    expect(mails.filter((m) => m.templateKey === 'PAYMENT_RECEIVED_TICKETS')).toHaveLength(0);
    const attached = JSON.stringify(confirmations[0]!.attachments);
    expect(attached).toContain(docs[1]!.id);
    expect(attached).toContain(docs[2]!.id);

    // The mail names the received difference (not the new price) and explains the documents.
    const stored = parseStoredEmailRequest(confirmations[0]!.attachments);
    const mailVariables = ctx.secrets!.decryptJson<Record<string, string | number | null>>(
      stored.variables!,
      EMAIL_VARIABLES_CONTEXT,
    );
    const mail = await renderEmail(ctx, {
      key: 'ADDITIONAL_PAYMENT_RECEIVED',
      orderId,
      variables: { ...mailVariables, ticketsAttached: 'yes' },
    });
    expect(mail.missing).toEqual([]);
    expect(mail.text).toContain('additional payment of €5.00');
    expect(mail.text).toContain('Reduced → Normal');
    expect(mail.text).toContain(
      `invoice correction ${docs[1]!.invoiceNumber}, which cancels the original invoice ${docs[0]!.invoiceNumber}`,
    );
    expect(mail.text).toContain(`new invoice ${docs[2]!.invoiceNumber}`);
    expect(mail.text).toContain('total amount of €63.00');
    expect(mail.text).toContain('€58.00 were already paid plus the additional payment of €5.00');

    // The new invoice says what was paid before and with the additional payment.
    expect(docs[2]!.legalNotes).toContain('Previously paid: €58.00');
    expect(docs[2]!.legalNotes).toContain('Additional payment: €5.00');
    expect(docs[2]!.legalNotes).toContain('nothing is due');

    const adjustment = await adjustmentRow(proposed.adjustmentId);
    expect(adjustment.status).toBe('PAID');
    expect(adjustment.paidAt).not.toBeNull();
    expect(await historyTypes(orderId)).toEqual(
      expect.arrayContaining([
        'adjustment_proposed',
        'adjustment_confirmed',
        'adjustment_paid',
        'credit_note_issued',
      ]),
    );

    // Accounting export: payment (adjustment reference) + invoice, credit note and new invoice.
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
    const data = await loadAccountingData(handle.db, { from: day, to: day }, 'Europe/Berlin');
    const exported = data.payments.filter((p) => p.orderNumber === after.order.orderNumber);
    expect(exported.map((p) => p.amount).sort((a, b) => a - b)).toEqual([500, 5800]);
    expect(exported.find((p) => p.amount === 500)!.paymentReference).toBe(
      proposed.paymentReference,
    );
    expect(exported.every((p) => p.voucher === docs[2]!.invoiceNumber)).toBe(true);
    const exportedDocs = data.documents.filter((d) =>
      docs.some((x) => x.invoiceNumber === d.number),
    );
    expect(exportedDocs.map((d) => d.totalGross).sort((a, b) => a - b)).toEqual([
      -5800, 5800, 6300,
    ]);
  });

  it('the frozen invoice note counts net money: a refunded orphan payment is not "previously paid"', async () => {
    mockPayPal();
    const { orderId } = await paidOrder([seatIds[30]!, seatIds[31]!], 'PAYPAL', [0]);
    await issueInvoice(ctx, orderId);
    // A duplicate capture that was refunded in full.
    const [orphan] = await handle.db
      .insert(payments)
      .values({
        orderId,
        method: 'PAYPAL',
        status: 'REFUNDED',
        amount: 700,
        currency: 'EUR',
        capturedAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: payments.id });
    await handle.db.insert(refunds).values({
      orderId,
      paymentId: orphan!.id,
      method: 'PAYPAL',
      kind: 'AUTOMATIC',
      status: 'SUCCEEDED',
      amount: 700,
      currency: 'EUR',
    });
    const proposed = await propose(orderId, seatIds[30]!);
    await confirmAdjustment(ctx, { adjustmentId: proposed.adjustmentId, orderId });
    await startAdjustmentPayPalPayment(ctx, proposed.adjustmentId);
    const ppId = [...paypal.created.keys()].at(-1)!;
    paypal.approved.add(ppId);
    expect(await completePayPalPayment(ctx, orderId, ppId)).toEqual({ status: 'PAID' });
    const active = await findActiveInvoice(handle.db, orderId);
    const [doc] = await handle.db.select().from(invoices).where(eq(invoices.id, active!.id));
    expect(doc!.legalNotes).toContain('Previously paid: €58.00');
    expect(doc!.legalNotes).toContain('Additional payment: €5.00');
  });

  it('a webhook capture without the buyer returning completes the adjustment; amounts never double', async () => {
    mockPayPal();
    const { orderId } = await paidOrder([seatIds[2]!], 'PAYPAL', [0]);
    const proposed = await propose(orderId, seatIds[2]!, { notify: false });
    await confirmAdjustment(ctx, { adjustmentId: proposed.adjustmentId, orderId });
    await startAdjustmentPayPalPayment(ctx, proposed.adjustmentId);
    const ppId = [...paypal.created.keys()].at(-1)!;
    const res = await handlePayPalWebhook(
      ctx,
      new Headers({
        'paypal-auth-algo': 'a',
        'paypal-cert-url': 'https://paypal.example/cert',
        'paypal-transmission-id': 'wh-adj',
        'paypal-transmission-sig': 's',
        'paypal-transmission-time': new Date().toISOString(),
      }),
      JSON.stringify({
        id: `WH-${uuid()}`,
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: `CAP-${ppId}`,
          amount: { currency_code: 'EUR', value: '5.00' },
          supplementary_data: { related_ids: { order_id: ppId } },
        },
      }),
    );
    expect(res).toBe('PROCESSED');
    const { order } = await loadOrder(orderId);
    // Original 25.00 + 1.50 fee + the 5.00 € adjustment – not booked as an overpayment.
    expect(order).toMatchObject({ status: 'PAID', totalGross: 3150, amountPaid: 3150 });
    expect((await adjustmentRow(proposed.adjustmentId)).status).toBe('PAID');
  });

  it('PayPal money for a cancelled adjustment is not captured; a stray capture is refunded', async () => {
    mockPayPal();
    const { orderId } = await paidOrder([seatIds[3]!], 'PAYPAL', [0]);
    const proposed = await propose(orderId, seatIds[3]!, { notify: false });
    await confirmAdjustment(ctx, { adjustmentId: proposed.adjustmentId, orderId });
    await startAdjustmentPayPalPayment(ctx, proposed.adjustmentId);
    const ppId = [...paypal.created.keys()].at(-1)!;
    await cancelAdjustment(ctx, { adjustmentId: proposed.adjustmentId, userId });
    paypal.approved.add(ppId);
    const capturesBefore = paypal.captures;
    expect(await completePayPalPayment(ctx, orderId, ppId)).toEqual({ status: 'NOT_PAYABLE' });
    expect(paypal.captures).toBe(capturesBefore);

    // Money that was captured at PayPal anyway (approved + captured elsewhere) comes back.
    const refundsBefore = paypal.refunds.length;
    await handlePayPalWebhook(
      ctx,
      new Headers({
        'paypal-auth-algo': 'a',
        'paypal-cert-url': 'https://paypal.example/cert',
        'paypal-transmission-id': 'wh-cancelled',
        'paypal-transmission-sig': 's',
        'paypal-transmission-time': new Date().toISOString(),
      }),
      JSON.stringify({
        id: `WH-${uuid()}`,
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: `CAP-${ppId}`,
          amount: { currency_code: 'EUR', value: '5.00' },
          supplementary_data: { related_ids: { order_id: ppId } },
        },
      }),
    );
    expect(paypal.refunds.length).toBe(refundsBefore + 1);
    const { order } = await loadOrder(orderId);
    expect(order).toMatchObject({ totalGross: 2650, amountPaid: 2650 });
  });

  // ── Bank transfer ───────────────────────────────────────────────────────────

  it('bank transfer with the exact amount completes the adjustment, even if still PROPOSED', async () => {
    const { orderId } = await paidOrder([seatIds[4]!, seatIds[5]!], 'BANK_TRANSFER');
    const item4 = await itemOf(orderId, seatIds[4]!);
    const item5 = await itemOf(orderId, seatIds[5]!);
    const proposed = await proposeTariffChange(ctx, {
      orderId,
      changes: [
        { orderItemId: item4.id, newTicketTypeId: normalId },
        { orderItemId: item5.id, newTicketTypeId: normalId },
      ],
      notify: true,
      userId,
    });
    expect(proposed.amount).toBe(1000);
    expect((await adjustmentRow(proposed.adjustmentId)).status).toBe('PROPOSED');

    const credit = await bankCredit(1000, `Nachzahlung ${proposed.paymentReference} Example`);
    expect(credit.matchStatus).toBe('AUTO_MATCHED');
    const adjustment = await adjustmentRow(proposed.adjustmentId);
    expect(adjustment.status).toBe('PAID');
    expect(adjustment.confirmedAt).not.toBeNull();
    const { order, items } = await loadOrder(orderId);
    expect(order).toMatchObject({ totalGross: 6300, amountPaid: 6300, status: 'PAID' });
    expect(items.every((i) => i.ticketTypeId === normalId && i.priceGross === 3000)).toBe(true);
    expect(await historyTypes(orderId)).toContain('adjustment_confirmed');
    const [allocation] = await handle.db
      .select()
      .from(bankTransactionAllocations)
      .where(eq(bankTransactionAllocations.bankTransactionId, credit.id));
    expect(allocation).toMatchObject({ orderId, amount: 1000, method: 'AUTO' });

    // Re-running the matcher / duplicate delivery books nothing twice.
    await matchBankTransactions(ctx, [credit.id]);
    const rows = await handle.db.select().from(payments).where(eq(payments.orderId, orderId));
    expect(rows.filter((p) => p.adjustmentId)).toHaveLength(1);

    // The payment of an adjustment cannot be reversed as a wrong allocation.
    await expect(
      reverseBankAllocation(ctx, { allocationId: allocation!.id, userId, reason: 'test' }),
    ).rejects.toMatchObject({ code: 'REVERSAL_BLOCKED_ADJUSTMENT' });
  });

  it('a wrong amount goes to the Klärfälle; manual assignment completes it with the exact amount', async () => {
    const { orderId } = await paidOrder([seatIds[6]!], 'BANK_TRANSFER');
    const proposed = await propose(orderId, seatIds[6]!, { notify: false });
    await confirmAdjustment(ctx, { adjustmentId: proposed.adjustmentId, orderId });

    const under = await bankCredit(400, `${proposed.paymentReference}`);
    expect(under).toMatchObject({ matchStatus: 'NEEDS_REVIEW', reviewReason: 'UNDERPAYMENT' });
    expect(under.matchCandidates?.[0]).toMatchObject({
      orderId,
      adjustmentId: proposed.adjustmentId,
    });
    expect((await adjustmentRow(proposed.adjustmentId)).status).toBe('CONFIRMED');

    const over = await bankCredit(600, `${proposed.paymentReference}`);
    expect(over).toMatchObject({ matchStatus: 'NEEDS_REVIEW', reviewReason: 'OVERPAYMENT' });
    // The amount must equal the adjustment exactly.
    await expect(
      assignBankTransaction(ctx, {
        transactionId: over.id,
        orderId,
        adjustmentId: proposed.adjustmentId,
        amount: 600,
        userId,
      }),
    ).rejects.toMatchObject({ code: 'ADJUSTMENT_AMOUNT_MISMATCH' });
    const result = await assignBankTransaction(ctx, {
      transactionId: over.id,
      orderId,
      adjustmentId: proposed.adjustmentId,
      userId,
    });
    expect(result).toMatchObject({ payment: 'PAID', unassigned: 100 });
    expect((await adjustmentRow(proposed.adjustmentId)).status).toBe('PAID');
    const { order } = await loadOrder(orderId);
    expect(order).toMatchObject({ totalGross: 3150, amountPaid: 3150 });
  });

  it('the order reference on a PAID order offers the open adjustment as candidate', async () => {
    const { orderId } = await paidOrder([seatIds[7]!], 'BANK_TRANSFER');
    const proposed = await propose(orderId, seatIds[7]!, { notify: false });
    const [row] = await handle.db.select().from(orders).where(eq(orders.id, orderId));
    const credit = await bankCredit(500, `Zahlung ${row!.paymentReference}`);
    expect(credit.matchStatus).toBe('NEEDS_REVIEW');
    expect(credit.matchCandidates?.[0]).toMatchObject({ adjustmentId: proposed.adjustmentId });
  });

  it('manual record by finance completes an open adjustment', async () => {
    const { orderId } = await paidOrder([seatIds[8]!], 'BANK_TRANSFER');
    const proposed = await propose(orderId, seatIds[8]!, { notify: false });
    const result = await recordManualAdjustmentPayment(ctx, {
      adjustmentId: proposed.adjustmentId,
      method: 'CASH',
      note: 'paid at the box office',
      userId,
    });
    expect(result.status).toBe('PAID');
    expect((await adjustmentRow(proposed.adjustmentId)).status).toBe('PAID');
    await expect(
      recordManualAdjustmentPayment(ctx, {
        adjustmentId: proposed.adjustmentId,
        method: 'CASH',
        userId,
      }),
    ).rejects.toMatchObject({ code: 'ADJUSTMENT_NOT_PAYABLE' });
  });

  // ── Cancel / concurrency / paid-order cancellation ────────────────────────────

  it('cancelling the adjustment leaves the order unchanged; later money goes to the Klärfälle', async () => {
    const { orderId } = await paidOrder([seatIds[9]!], 'BANK_TRANSFER');
    const before = await loadOrder(orderId);
    const proposed = await propose(orderId, seatIds[9]!, { notify: false });
    await cancelAdjustment(ctx, { adjustmentId: proposed.adjustmentId, userId });
    const after = await loadOrder(orderId);
    expect(after.items).toEqual(before.items);
    // Cancelling the additional payment touches the tickets on purpose (the scanner must drop its
    // "additional payment open" warning): only the sync bookkeeping may differ.
    const content = (rows: typeof before.ticketRows) =>
      rows.map(({ syncVersion: _v, syncXid: _x, updatedAt: _u, ...rest }) => rest);
    expect(content(after.ticketRows)).toEqual(content(before.ticketRows));
    expect(
      after.ticketRows.every((t) => {
        const old = before.ticketRows.find((x) => x.id === t.id)!;
        return t.syncVersion > old.syncVersion; // the order has a single ticket: the adjusted one
      }),
    ).toBe(true);
    expect(after.order).toMatchObject({
      status: 'PAID',
      totalGross: before.order.totalGross,
      amountPaid: before.order.amountPaid,
    });
    expect(await ticketHasOpenAdjustment(handle.db, { orderItemId: before.items[0]!.id })).toBe(
      false,
    );
    expect((await adjustmentRow(proposed.adjustmentId)).status).toBe('CANCELLED');
    expect(await historyTypes(orderId)).toContain('adjustment_cancelled');
    await expect(
      cancelAdjustment(ctx, { adjustmentId: proposed.adjustmentId, userId }),
    ).rejects.toMatchObject({ code: 'ADJUSTMENT_NOT_OPEN' });
    await expect(
      confirmAdjustment(ctx, { adjustmentId: proposed.adjustmentId, orderId }),
    ).rejects.toMatchObject({ code: 'ADJUSTMENT_NOT_OPEN' });

    const late = await bankCredit(500, proposed.paymentReference);
    expect(late).toMatchObject({ matchStatus: 'NEEDS_REVIEW', reviewReason: 'ORDER_NOT_PAYABLE' });
    expect((await loadOrder(orderId)).order.amountPaid).toBe(before.order.amountPaid);
    // A new proposal is possible after the cancellation.
    expect((await propose(orderId, seatIds[9]!, { notify: false })).amount).toBe(500);
  });

  it('concurrent proposals: exactly one wins', async () => {
    const { orderId } = await paidOrder([seatIds[13]!], 'BANK_TRANSFER');
    const results = await Promise.allSettled([
      propose(orderId, seatIds[13]!, { notify: false }),
      propose(orderId, seatIds[13]!, { notify: false }),
      propose(orderId, seatIds[13]!, { notify: false }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected')
        expect(r.reason).toMatchObject({ code: 'ADJUSTMENT_ALREADY_OPEN' });
    }
    const rows = await handle.db
      .select()
      .from(orderAdjustments)
      .where(eq(orderAdjustments.orderId, orderId));
    expect(rows).toHaveLength(1);
  });

  it('cancelling tickets of a paid order cancels the open adjustment and tells the admin', async () => {
    const { orderId } = await paidOrder([seatIds[14]!, seatIds[15]!], 'BANK_TRANSFER', [0]);
    const proposed = await propose(orderId, seatIds[14]!, { notify: false });
    const other = await itemOf(orderId, seatIds[15]!);
    const result = await cancelPaidOrder(ctx, {
      orderId,
      orderItemIds: [other.id],
      refundFees: false,
      notify: false,
      userId,
    });
    expect(result.cancelledAdjustment).toMatchObject({
      id: proposed.adjustmentId,
      amount: 500,
      reference: proposed.paymentReference,
    });
    expect((await adjustmentRow(proposed.adjustmentId)).status).toBe('CANCELLED');
    expect((await loadOrder(orderId)).order.status).toBe('PARTIALLY_REFUNDED');
  });

  it('a later cancellation refunds both payments (PayPal automatic)', async () => {
    mockPayPal();
    const { orderId } = await paidOrder([seatIds[16]!], 'PAYPAL', [0]);
    const proposed = await propose(orderId, seatIds[16]!, { notify: false });
    await confirmAdjustment(ctx, { adjustmentId: proposed.adjustmentId, orderId });
    await startAdjustmentPayPalPayment(ctx, proposed.adjustmentId);
    const ppId = [...paypal.created.keys()].at(-1)!;
    paypal.approved.add(ppId);
    expect(await completePayPalPayment(ctx, orderId, ppId)).toEqual({ status: 'PAID' });

    const result = await cancelPaidOrder(ctx, { orderId, refundFees: true, notify: false, userId });
    // 30.00 € ticket + 1.50 € fee = 31.50 €, paid as 26.50 € + 5.00 €.
    expect(result).toMatchObject({ orderStatus: 'REFUNDED', creditTotal: 3150, refundTotal: 3150 });
    expect(result.refunds.map((r) => [r.kind, r.amount]).sort()).toEqual([
      ['AUTOMATIC', 2650],
      ['AUTOMATIC', 500],
    ]);
    const refundRows = await handle.db.select().from(refunds).where(eq(refunds.orderId, orderId));
    expect(refundRows).toHaveLength(2);
    // PayPal + PayPal: still one batch (one amount, one credit note), one refund per capture.
    expect(new Set(refundRows.map((r) => r.batchId))).toEqual(new Set([result.batchId]));
    const [batchView] = await listOrderRefundBatches(ctx, orderId);
    expect(batchView).toMatchObject({ totalAmount: 3150, rows: expect.any(Array) });
    expect(batchView!.rows).toHaveLength(2);
    // The credit note refers to the corrected invoice (63 → the new one), not the superseded one.
    const active = await findActiveInvoice(handle.db, orderId);
    const [credit] = await handle.db
      .select()
      .from(invoices)
      .where(eq(invoices.id, result.creditNote!.id));
    expect(credit!.correctsInvoiceId).toBe(active!.id);
    expect(credit!.totalGross).toBe(-3150);
  });

  // ── Reminder / admin list / anonymisation ─────────────────────────────────────

  it('sends one reminder after N days, lists it for the admin and blocks anonymisation', async () => {
    const { orderId } = await paidOrder([seatIds[17]!], 'BANK_TRANSFER');
    const proposed = await propose(orderId, seatIds[17]!);
    expect(await sendAdjustmentReminders(ctx)).toBe(0); // too young
    const past = new Date(Date.now() - 8 * 86_400_000);
    await handle.db
      .update(orderAdjustments)
      .set({ createdAt: past })
      .where(eq(orderAdjustments.id, proposed.adjustmentId));
    const before = await countAdjustmentsNeedingAttention(ctx);
    expect(await sendAdjustmentReminders(ctx)).toBeGreaterThanOrEqual(1);
    expect(await sendAdjustmentReminders(ctx)).toBe(0); // once only
    const mails = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.orderId, orderId));
    expect(mails.filter((m) => m.templateKey === 'ADDITIONAL_PAYMENT_REMINDER')).toHaveLength(1);
    const adjustment = await adjustmentRow(proposed.adjustmentId);
    expect(adjustment.reminderSentAt).not.toBeNull();
    expect(adjustment.status).toBe('PROPOSED'); // never cancelled automatically
    expect(await countAdjustmentsNeedingAttention(ctx)).toBe(before + 1);
    const listed = (await listOpenAdjustments(ctx)).find((a) => a.id === proposed.adjustmentId);
    expect(listed).toMatchObject({ needsAttention: true, amount: 500 });
    const rendered = await renderEmail(ctx, {
      key: 'ADDITIONAL_PAYMENT_REMINDER',
      orderId,
      variables: { adjustmentId: proposed.adjustmentId },
    });
    expect(rendered.missing).toEqual([]);
    expect(rendered.html).toContain('Reduced → Normal');

    const { order } = await loadOrder(orderId);
    const blockers = await getAnonymizationBlockers(handle.db, order.customerId!, order.email!);
    expect(blockers.openOrders.map((o) => o.orderId)).toContain(orderId);
  });
  // ── PENDING capture → COMPLETED later ─────────────────────────────────────────

  it('adjustment: a PENDING capture is booked when it completes (webhook and reconcile)', async () => {
    mockPayPal();
    for (const via of ['webhook', 'reconcile'] as const) {
      const seat = via === 'webhook' ? seatIds[20]! : seatIds[21]!;
      const { orderId } = await paidOrder([seat], 'PAYPAL', [0]);
      const proposed = await propose(orderId, seat, { notify: false });
      await confirmAdjustment(ctx, { adjustmentId: proposed.adjustmentId, orderId });
      await startAdjustmentPayPalPayment(ctx, proposed.adjustmentId);
      const ppId = [...paypal.created.keys()].at(-1)!;
      paypal.approved.add(ppId);
      paypal.pending.add(ppId);
      expect(await completePayPalPayment(ctx, orderId, ppId)).toEqual({ status: 'PENDING' });
      expect((await adjustmentRow(proposed.adjustmentId)).status).toBe('CONFIRMED');
      paypal.pending.delete(ppId);
      if (via === 'webhook') {
        const res = await handlePayPalWebhook(
          ctx,
          new Headers({
            'paypal-auth-algo': 'a',
            'paypal-cert-url': 'https://paypal.example/cert',
            'paypal-transmission-id': 'wh-pending',
            'paypal-transmission-sig': 's',
            'paypal-transmission-time': new Date().toISOString(),
          }),
          JSON.stringify({
            id: `WH-${uuid()}`,
            event_type: 'PAYMENT.CAPTURE.COMPLETED',
            resource: {
              id: `CAP-${ppId}`,
              amount: { currency_code: 'EUR', value: '5.00' },
              supplementary_data: { related_ids: { order_id: ppId } },
            },
          }),
        );
        expect(res).toBe('PROCESSED');
      } else {
        await reconcileAdjustmentPayPal(ctx, proposed.adjustmentId);
      }
      expect((await adjustmentRow(proposed.adjustmentId)).status).toBe('PAID');
      const { order } = await loadOrder(orderId);
      expect(order).toMatchObject({ totalGross: 3150, amountPaid: 3150 });
      const rows = await handle.db.select().from(payments).where(eq(payments.orderId, orderId));
      expect(rows.filter((p) => p.adjustmentId)).toHaveLength(1);
    }
  });

  it('order: a PENDING PayPal capture is booked when it completes (dunning asks PayPal for the capture)', async () => {
    mockPayPal();
    const session = `k${uuid().slice(0, 8)}`;
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, [seatIds[22]!]);
    const { quotes } = await getCheckoutOptions(ctx, session);
    const placed = await placeOrder(ctx, {
      sessionId: session,
      input: buyer('PAYPAL', quotes.PAYPAL.totalGross),
    });
    await startPayPalPayment(ctx, placed.orderId);
    const ppId = [...paypal.created.keys()].at(-1)!;
    paypal.approved.add(ppId);
    paypal.pending.add(ppId);
    expect(await completePayPalPayment(ctx, placed.orderId, ppId)).toEqual({ status: 'PENDING' });
    paypal.pending.delete(ppId);
    await handle.db
      .update(orders)
      .set({ createdAt: new Date(Date.now() - 2 * 3600_000) })
      .where(eq(orders.id, placed.orderId));
    // The dunning job asks PayPal for the capture and books it instead of expiring the order.
    await runDunning(ctx);
    const { order } = await loadOrder(placed.orderId);
    expect(order.status).toBe('PAID');
    const rows = await handle.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, placed.orderId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'CAPTURED', providerCaptureId: `CAP-${ppId}` });
  });

  // ── Changed tickets, outbox, seat change ───────────────────────────────────────

  it('a ticket that changed after the request cancels the adjustment (customer is told)', async () => {
    const { orderId } = await paidOrder([seatIds[23]!], 'BANK_TRANSFER', [0]);
    const proposed = await propose(orderId, seatIds[23]!, { notify: false });
    const item = await itemOf(orderId, seatIds[23]!);
    await handle.db
      .update(orderItems)
      .set({ ticketTypeId: normalId })
      .where(eq(orderItems.id, item.id));
    await expect(
      recordManualAdjustmentPayment(ctx, {
        adjustmentId: proposed.adjustmentId,
        method: 'CASH',
        userId,
      }),
    ).rejects.toMatchObject({ code: 'ADJUSTMENT_NOT_PAYABLE' });
    expect((await adjustmentRow(proposed.adjustmentId)).status).toBe('CANCELLED');
    const mails = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.orderId, orderId));
    expect(mails.map((m) => m.templateKey)).toContain('ADDITIONAL_PAYMENT_CANCELLED');
  });

  it('rejects seat changes of tickets with an open adjustment', async () => {
    const { orderId } = await paidOrder([seatIds[24]!], 'BANK_TRANSFER', [0]);
    await propose(orderId, seatIds[24]!, { notify: false });
    const item = await itemOf(orderId, seatIds[24]!);
    await expect(
      changeOrderSeats(ctx, {
        orderId,
        changes: [{ orderItemId: item.id, newSeatId: uuid() }],
        userId,
        holdSessionId: `boxoffice:${userId}:x`,
        notify: false,
      }),
    ).rejects.toMatchObject({ code: 'ADJUSTMENT_OPEN' });
  });

  it('skips the request mail once the adjustment is closed, tells the customer, and issues one invoice when none existed', async () => {
    const { orderId } = await paidOrder([seatIds[25]!], 'BANK_TRANSFER', [0]);
    const proposed = await propose(orderId, seatIds[25]!, { notify: true });
    const request = (
      await handle.db.select().from(emailMessages).where(eq(emailMessages.orderId, orderId))
    ).filter((m) => m.templateKey === 'ADDITIONAL_PAYMENT_REQUEST');
    await cancelAdjustment(ctx, { adjustmentId: proposed.adjustmentId, userId });
    expect(await deliverEmailMessage(ctx, request[0]!.id)).toEqual({ status: 'OBSOLETE' });
    const [obsolete] = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, request[0]!.id));
    expect(obsolete!.status).toBe('FAILED');
    const keys = (
      await handle.db.select().from(emailMessages).where(eq(emailMessages.orderId, orderId))
    ).map((m) => m.templateKey);
    expect(keys).toContain('ADDITIONAL_PAYMENT_CANCELLED');

    // Paying a new request without any invoice in existence issues a single invoice.
    const again = await propose(orderId, seatIds[25]!, { notify: false });
    await recordManualAdjustmentPayment(ctx, {
      adjustmentId: again.adjustmentId,
      method: 'CASH',
      userId,
    });
    const docs = await handle.db.select().from(invoices).where(eq(invoices.orderId, orderId));
    expect(docs.map((d) => [d.type, d.totalGross])).toEqual([['INVOICE', 3150]]);
  });

  it('a stale invoice (invoicing off) is a finance to-do and is repaired exactly once', async () => {
    const { orderId } = await paidOrder([seatIds[26]!], 'BANK_TRANSFER', [0]);
    await issueInvoice(ctx, orderId);
    await saveSetting(ctx, 'invoicing', { issueInvoices: false }, null);
    try {
      const proposed = await propose(orderId, seatIds[26]!, { notify: false });
      await recordManualAdjustmentPayment(ctx, {
        adjustmentId: proposed.adjustmentId,
        method: 'CASH',
        userId,
      });
      expect(await historyTypes(orderId)).toContain('invoice_correction_needed');
      expect((await listInvoiceCorrections(ctx)).map((c) => c.orderId)).toContain(orderId);
      expect(await countInvoiceCorrections(ctx)).toBeGreaterThanOrEqual(1);
      expect(await repairOrderInvoice(ctx, { orderId, userId })).toEqual({ repaired: true });
      expect(await repairOrderInvoice(ctx, { orderId, userId })).toEqual({ repaired: false });
      expect((await listInvoiceCorrections(ctx)).map((c) => c.orderId)).not.toContain(orderId);
      const docs = await handle.db
        .select()
        .from(invoices)
        .where(eq(invoices.orderId, orderId))
        .orderBy(asc(invoices.issuedAt), asc(invoices.createdAt));
      expect(docs.map((d) => [d.type, d.totalGross])).toEqual([
        ['INVOICE', 2650],
        ['CREDIT_NOTE', -2650],
        ['INVOICE', 3150],
      ]);
    } finally {
      await saveSetting(ctx, 'invoicing', { issueInvoices: true }, null);
    }
  });

  it('concurrent late captures of a cancelled adjustment are refunded once', async () => {
    mockPayPal();
    const { orderId } = await paidOrder([seatIds[27]!], 'PAYPAL', [0]);
    const proposed = await propose(orderId, seatIds[27]!, { notify: false });
    await confirmAdjustment(ctx, { adjustmentId: proposed.adjustmentId, orderId });
    await startAdjustmentPayPalPayment(ctx, proposed.adjustmentId);
    const ppId = [...paypal.created.keys()].at(-1)!;
    await cancelAdjustment(ctx, { adjustmentId: proposed.adjustmentId, userId });
    const before = paypal.refunds.length;
    const hook = (n: number) =>
      handlePayPalWebhook(
        ctx,
        new Headers({
          'paypal-auth-algo': 'a',
          'paypal-cert-url': 'https://paypal.example/cert',
          'paypal-transmission-id': `wh-${n}`,
          'paypal-transmission-sig': 's',
          'paypal-transmission-time': new Date().toISOString(),
        }),
        JSON.stringify({
          id: `WH-${uuid()}`,
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource: {
            id: `CAP-${ppId}`,
            amount: { currency_code: 'EUR', value: '5.00' },
            supplementary_data: { related_ids: { order_id: ppId } },
          },
        }),
      );
    await Promise.all([hook(1), hook(2), hook(3)]);
    expect(paypal.refunds.length).toBe(before + 1);
    const refundRows = await handle.db.select().from(refunds).where(eq(refunds.orderId, orderId));
    expect(refundRows).toHaveLength(1);
  });

  // ── Overpayment credited against a tariff change ─────────────────────────────

  /** Money that arrives although the order is paid already (an overpayment). */
  async function overpay(
    orderId: string,
    amount: number,
    method: 'BANK_TRANSFER' | 'PAYPAL' = 'BANK_TRANSFER',
  ) {
    const result = await recordPayment(ctx, {
      orderId,
      amount,
      currency: 'EUR',
      method,
      providerCaptureId: method === 'PAYPAL' ? `CAP-${uuid().slice(0, 8)}` : null,
      actor: { type: 'SYSTEM' },
    });
    expect(result.status).toBe('ALREADY_PAID');
  }
  const messagesOf = async (orderId: string, key: string) =>
    handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.orderId, orderId))
      .then((rows) => rows.filter((m) => m.templateKey === key));

  it('no overpayment: the full difference is requested as before', async () => {
    const { orderId } = await paidOrder([seatIds[39]!], 'BANK_TRANSFER', [0]);
    const proposed = await propose(orderId, seatIds[39]!, { notify: false });
    expect(proposed).toMatchObject({
      amount: 500,
      difference: 500,
      creditApplied: 0,
      settledByCredit: false,
    });
    expect((await adjustmentRow(proposed.adjustmentId)).status).toBe('PROPOSED');
    await cancelAdjustment(ctx, { adjustmentId: proposed.adjustmentId, userId });
  });

  it('full credit: the tariff change is applied at once without a payment request', async () => {
    const { orderId } = await paidOrder([seatIds[32]!], 'BANK_TRANSFER', [0]);
    await issueInvoice(ctx, orderId);
    // The customer agreed to the dearer tariff by e-mail, transferred 5.00 € more: overpayment.
    await overpay(orderId, 500);
    expect((await loadOrder(orderId)).order).toMatchObject({ totalGross: 2650, amountPaid: 3150 });
    const before = await loadOrder(orderId);

    const proposed = await propose(orderId, seatIds[32]!, { notify: true });
    expect(proposed).toMatchObject({
      amount: 0,
      difference: 500,
      creditApplied: 500,
      settledByCredit: true,
      emailQueued: true,
    });
    const adjustment = await adjustmentRow(proposed.adjustmentId);
    expect(adjustment).toMatchObject({ status: 'PAID', amount: 0, creditApplied: 500 });
    const { order, items, ticketRows } = await loadOrder(orderId);
    // The total grows by the full difference, amount_paid by nothing (the money was there).
    expect(order).toMatchObject({ status: 'PAID', totalGross: 3150, amountPaid: 3150 });
    expect(items[0]).toMatchObject({ ticketTypeId: normalId, priceGross: 3000 });
    const oldTicket = before.ticketRows[0]!;
    expect(ticketRows.find((t) => t.id === oldTicket.id)!.status).toBe('REPLACED');
    expect(ticketRows.filter((t) => t.status === 'VALID')).toHaveLength(1);
    // No payment row for the adjustment; the history says where the money came from.
    const paymentRows = await handle.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId));
    expect(paymentRows.filter((p) => p.adjustmentId)).toHaveLength(0);
    const [paid] = (
      await handle.db.select().from(orderHistory).where(eq(orderHistory.orderId, orderId))
    ).filter((h) => h.type === 'adjustment_paid');
    expect(paid!.data).toMatchObject({
      settledByCredit: true,
      creditUsed: 500,
      amount: 0,
      difference: 500,
      previouslyPaid: 3150,
    });
    // Invoice corrected: credit note + new invoice whose note adds up (31.50 incl. the 5.00 €).
    const active = await findActiveInvoice(handle.db, orderId);
    const [invoice] = await handle.db.select().from(invoices).where(eq(invoices.id, active!.id));
    expect(invoice).toMatchObject({ type: 'INVOICE', totalGross: 3150 });
    expect(invoice!.legalNotes).toContain('Previously paid: €31.50');
    expect(invoice!.legalNotes).toContain('including the overpayment of €5.00');
    expect(invoice!.legalNotes).toContain('nothing is due');
    expect(
      (await handle.db.select().from(invoices).where(eq(invoices.orderId, orderId))).filter(
        (i) => i.type === 'CREDIT_NOTE',
      ),
    ).toHaveLength(1);
    expect((await listInvoiceCorrections(ctx)).some((c) => c.orderId === orderId)).toBe(false);
    // The customer is told: own template, nothing to pay.
    expect(await messagesOf(orderId, 'ADDITIONAL_PAYMENT_RECEIVED')).toHaveLength(0);
    const [mailRow] = await messagesOf(orderId, 'ADDITIONAL_PAYMENT_SETTLED_BY_CREDIT');
    const stored = parseStoredEmailRequest(mailRow!.attachments);
    const mail = await renderEmail(ctx, {
      key: 'ADDITIONAL_PAYMENT_SETTLED_BY_CREDIT',
      orderId,
      variables: {
        ...ctx.secrets!.decryptJson<Record<string, string | number | null>>(
          stored.variables!,
          EMAIL_VARIABLES_CONTEXT,
        ),
        ticketsAttached: 'yes',
      },
    });
    expect(mail.missing).toEqual([]);
    expect(mail.text).toContain('you do not have to pay anything');
    expect(mail.text).toContain('Price difference: €5.00');
    expect(mail.text).toContain('Credited from your earlier payment: −€5.00');
    expect(mail.text).toContain('Still to pay: €0.00');
    // The overpayment is used up: nothing left to credit or refund.
    await expect(
      refundOverpayment(ctx, { orderId, userId, expectedAmount: 500 }),
    ).rejects.toMatchObject({
      code: 'NO_OVERPAYMENT',
    });
  });

  it('partial credit: only the rest is requested; request mail and invoice note add up', async () => {
    const { orderId } = await paidOrder([seatIds[33]!], 'BANK_TRANSFER', [0]);
    await issueInvoice(ctx, orderId);
    await overpay(orderId, 200);

    const proposed = await propose(orderId, seatIds[33]!, { notify: true });
    expect(proposed).toMatchObject({
      amount: 300,
      difference: 500,
      creditApplied: 200,
      settledByCredit: false,
    });
    expect(await adjustmentRow(proposed.adjustmentId)).toMatchObject({
      status: 'PROPOSED',
      amount: 300,
      creditApplied: 200,
    });
    // Order untouched while the rest is open.
    expect((await loadOrder(orderId)).order).toMatchObject({ totalGross: 2650, amountPaid: 2850 });
    const request = await renderEmail(ctx, {
      key: 'ADDITIONAL_PAYMENT_REQUEST',
      orderId,
      variables: { adjustmentId: proposed.adjustmentId },
    });
    expect(request.missing).toEqual([]);
    expect(request.text).toContain('Price difference: €5.00');
    expect(request.text).toContain('Credited from your earlier payment: −€2.00');
    expect(request.text).toContain('Still to pay: €3.00');
    expect(request.text).toContain('additional payment of €3.00');
    // The overpayment is reserved by the open adjustment: it cannot be refunded meanwhile.
    await expect(
      refundOverpayment(ctx, { orderId, userId, expectedAmount: 200 }),
    ).rejects.toMatchObject({
      code: 'NO_OVERPAYMENT',
    });

    await recordManualAdjustmentPayment(ctx, {
      adjustmentId: proposed.adjustmentId,
      method: 'BANK_TRANSFER',
      userId,
    });
    const { order } = await loadOrder(orderId);
    expect(order).toMatchObject({ status: 'PAID', totalGross: 3150, amountPaid: 3150 });
    const active = await findActiveInvoice(handle.db, orderId);
    const [invoice] = await handle.db.select().from(invoices).where(eq(invoices.id, active!.id));
    expect(invoice!.totalGross).toBe(3150);
    // 26.50 + 2.00 overpayment = 28.50 previously paid, + 3.00 additional = 31.50.
    expect(invoice!.legalNotes).toContain('Previously paid: €28.50');
    expect(invoice!.legalNotes).toContain('including the overpayment of €2.00');
    expect(invoice!.legalNotes).toContain('Additional payment: €3.00');
    const [paid] = (
      await handle.db.select().from(orderHistory).where(eq(orderHistory.orderId, orderId))
    ).filter((h) => h.type === 'adjustment_paid');
    expect(paid!.data).toMatchObject({ amount: 300, creditUsed: 200, difference: 500 });
    const [received] = await messagesOf(orderId, 'ADDITIONAL_PAYMENT_RECEIVED');
    const mail = await renderEmail(ctx, {
      key: 'ADDITIONAL_PAYMENT_RECEIVED',
      orderId,
      variables: ctx.secrets!.decryptJson<Record<string, string | number | null>>(
        parseStoredEmailRequest(received!.attachments).variables!,
        EMAIL_VARIABLES_CONTEXT,
      ),
    });
    expect(mail.text).toContain('€28.50 were already paid plus the additional payment of €3.00');
    expect(mail.text).toContain('total amount of €31.50');
  });

  it('credit changed between proposal and payment: shrunk credit is refused, grown credit stays visible', async () => {
    // Shrunk: the overpayment is paid back behind the proposal's back.
    const a = await paidOrder([seatIds[34]!], 'BANK_TRANSFER', [0]);
    await overpay(a.orderId, 200);
    const proposedA = await propose(a.orderId, seatIds[34]!, { notify: false });
    expect(proposedA).toMatchObject({ amount: 300, creditApplied: 200 });
    const [source] = await handle.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, a.orderId))
      .orderBy(asc(payments.createdAt));
    await handle.db.insert(refunds).values({
      orderId: a.orderId,
      paymentId: source!.id,
      method: 'BANK_TRANSFER',
      kind: 'MANUAL',
      status: 'PENDING',
      amount: 200,
      currency: 'EUR',
      overpayment: true,
    });
    await expect(
      recordManualAdjustmentPayment(ctx, {
        adjustmentId: proposedA.adjustmentId,
        method: 'BANK_TRANSFER',
        userId,
      }),
    ).rejects.toMatchObject({
      code: 'ADJUSTMENT_NOT_PAYABLE',
      details: { reason: 'CREDIT_CHANGED' },
    });
    // The request can never be met any more: it is cancelled and the customer is told.
    expect((await adjustmentRow(proposedA.adjustmentId)).status).toBe('CANCELLED');
    expect(await messagesOf(a.orderId, 'ADDITIONAL_PAYMENT_CANCELLED')).toHaveLength(1);

    // Grown: a second overpayment arrives; the adjustment completes, the excess stays as credit.
    await cancelPaidOrder(ctx, {
      orderId: a.orderId,
      refundFees: true,
      notify: false,
      userId,
    });
    const b = await paidOrder([seatIds[34]!], 'BANK_TRANSFER', [0]);
    await overpay(b.orderId, 200);
    const proposedB = await propose(b.orderId, seatIds[34]!, { notify: false });
    expect(proposedB).toMatchObject({ amount: 300, creditApplied: 200 });
    await overpay(b.orderId, 100);
    await recordManualAdjustmentPayment(ctx, {
      adjustmentId: proposedB.adjustmentId,
      method: 'BANK_TRANSFER',
      userId,
    });
    expect((await loadOrder(b.orderId)).order).toMatchObject({
      totalGross: 3150,
      amountPaid: 3250,
    });
    expect((await getOrderCredit(handle.db, b.orderId)).credit).toBe(100);
    expect(await adjustmentRow(proposedB.adjustmentId)).toMatchObject({
      status: 'PAID',
      amount: 300,
      creditApplied: 200,
    });
  });

  it('a refunded (or refund-pending) overpayment is not credited', async () => {
    const { orderId } = await paidOrder([seatIds[35]!], 'BANK_TRANSFER', [0]);
    await overpay(orderId, 500);
    expect((await getOrderCredit(handle.db, orderId)).credit).toBe(500);

    const refund = await refundOverpayment(ctx, { orderId, userId, expectedAmount: 500 });
    expect(refund).toMatchObject({ amount: 500 });
    expect(refund.refunds).toMatchObject([{ kind: 'MANUAL', amount: 500 }]);
    // Pending refund already claims the money.
    expect((await getOrderCredit(handle.db, orderId)).credit).toBe(0);
    const pending = await propose(orderId, seatIds[35]!, { notify: false });
    expect(pending).toMatchObject({ amount: 500, creditApplied: 0, settledByCredit: false });
    await cancelAdjustment(ctx, { adjustmentId: pending.adjustmentId, userId });

    expect(await completeRefundBatch(ctx, { batchId: refund.batchId, userId })).toHaveLength(1);
    const { order } = await loadOrder(orderId);
    // The overpayment refund counts as refunded money of the order (revenue, "refunded" line).
    expect(order).toMatchObject({ status: 'PAID', amountPaid: 3150, amountRefunded: 500 });
    expect((await getOrderCredit(handle.db, orderId)).credit).toBe(0);
    const again = await propose(orderId, seatIds[35]!, { notify: false });
    expect(again).toMatchObject({ amount: 500, creditApplied: 0 });
    await cancelAdjustment(ctx, { adjustmentId: again.adjustmentId, userId });
    // Nothing is left to refund a second time.
    await expect(
      refundOverpayment(ctx, { orderId, userId, expectedAmount: 500 }),
    ).rejects.toMatchObject({
      code: 'NO_OVERPAYMENT',
    });
  });

  it('refunds an overpayment from PayPal automatically, from a bank transfer as one manual to-do', async () => {
    mockPayPal();
    const pp = await paidOrder([seatIds[36]!], 'PAYPAL', [0]);
    await overpay(pp.orderId, 300, 'PAYPAL');
    const open0 = await countOpenRefunds(ctx);
    const ppRefund = await refundOverpayment(ctx, {
      orderId: pp.orderId,
      userId,
      expectedAmount: 300,
    });
    expect(ppRefund.refunds).toMatchObject([{ kind: 'AUTOMATIC', amount: 300, method: 'PAYPAL' }]);
    // The excess came from the second capture: exactly that capture is refunded, 3.00 €.
    const [row] = await handle.db
      .select()
      .from(refunds)
      .where(eq(refunds.id, ppRefund.refunds[0]!.id));
    expect(row).toMatchObject({ overpayment: true, batchId: ppRefund.batchId, amount: 300 });
    expect(jobs.add).toHaveBeenCalled();
    expect(await processPaypalRefund(ctx, row!.id)).toBe('SUCCEEDED');
    expect(paypal.refunds.at(-1)!.captureId).toMatch(/^CAP-/);
    expect(await countOpenRefunds(ctx)).toBe(open0);
    expect((await loadOrder(pp.orderId)).order).toMatchObject({ amountRefunded: 300 });

    const bank = await paidOrder([seatIds[37]!], 'BANK_TRANSFER', [0]);
    await overpay(bank.orderId, 300);
    const bankRefund = await refundOverpayment(ctx, {
      orderId: bank.orderId,
      userId,
      expectedAmount: 300,
    });
    expect(bankRefund.refunds).toMatchObject([{ kind: 'MANUAL', amount: 300 }]);
    const todo = (await listOpenRefunds(ctx)).find((b) => b.batchId === bankRefund.batchId)!;
    expect(todo).toMatchObject({ overpayment: true, totalAmount: 300, creditNoteNumber: null });
    expect(await countOpenRefunds(ctx)).toBe(open0 + 1);
    // No credit note for an overpayment refund, the invoice stays untouched.
    expect(
      (await handle.db.select().from(invoices).where(eq(invoices.orderId, bank.orderId))).filter(
        (i) => i.type === 'CREDIT_NOTE',
      ),
    ).toHaveLength(0);
    // Not for unpaid / cancelled orders.
    await expect(
      refundOverpayment(ctx, { orderId: randomUUID(), userId, expectedAmount: 1 }),
    ).rejects.toMatchObject({
      code: 'ORDER_NOT_FOUND',
    });
    await completeRefundBatch(ctx, { batchId: bankRefund.batchId, userId });
  });

  // ── One refund batch per cancellation ────────────────────────────────────────

  it('cancelling after a tariff change (bank + bank): one batch, one manual transfer, caps per payment', async () => {
    const { orderId } = await paidOrder([seatIds[38]!], 'BANK_TRANSFER', [0]);
    // Both payments come from the same account: one transfer back.
    const [tx0] = await handle.db
      .insert(bankTransactions)
      .values({
        bankAccountId,
        fingerprint: `fp-${uuid()}`,
        bookingDate: '2026-03-01',
        amount: 2650,
        currency: 'EUR',
        counterpartyName: 'Erika Example',
        counterpartyIban: 'DE02120300000000202051',
        remittanceInformation: 'original',
        matchStatus: 'MANUALLY_MATCHED',
      })
      .returning();
    await handle.db
      .update(payments)
      .set({ bankTransactionId: tx0!.id })
      .where(eq(payments.orderId, orderId));
    const proposed = await propose(orderId, seatIds[38]!, { notify: false });
    await bankCredit(500, `Nachzahlung ${proposed.paymentReference} Example`);
    expect((await adjustmentRow(proposed.adjustmentId)).status).toBe('PAID');

    const open0 = await countOpenRefunds(ctx);
    const result = await cancelPaidOrder(ctx, { orderId, refundFees: true, notify: true, userId });
    expect(result).toMatchObject({ creditTotal: 3150, refundTotal: 3150 });
    expect(result.refunds).toHaveLength(2);
    const rows = await handle.db.select().from(refunds).where(eq(refunds.orderId, orderId));
    expect(new Set(rows.map((r) => r.batchId))).toEqual(new Set([result.batchId]));
    // Cap per payment: never more than the payment itself.
    const paymentRows = await handle.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId));
    for (const p of paymentRows) {
      const refunded = rows.filter((r) => r.paymentId === p.id).reduce((s, r) => s + r.amount, 0);
      expect(refunded).toBeLessThanOrEqual(p.amount);
    }
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(3150);

    expect(await countOpenRefunds(ctx)).toBe(open0 + 1);
    const batch = (await listOpenRefunds(ctx)).find((b) => b.batchId === result.batchId)!;
    expect(batch).toMatchObject({
      totalAmount: 3150,
      openAmount: 3150,
      status: 'PENDING',
      creditNoteNumber: result.creditNote!.number,
      canComplete: true,
      canRetry: false,
    });
    expect(batch.rows).toHaveLength(2);
    expect(batch.transfers).toEqual([
      { payerIban: 'DE02120300000000202051', payerName: 'Erika Example', amount: 3150 },
    ]);
    // The order page groups the same way.
    const [byOrder] = await listOrderRefundBatches(ctx, orderId);
    expect(byOrder).toMatchObject({ batchId: result.batchId, totalAmount: 3150 });

    // One click settles all open manual rows, each with its own history entry.
    expect(await completeRefundBatch(ctx, { batchId: result.batchId, userId })).toHaveLength(2);
    expect(await completeRefundBatch(ctx, { batchId: result.batchId, userId })).toHaveLength(0);
    expect(await countOpenRefunds(ctx)).toBe(open0);
    const history = await handle.db
      .select()
      .from(orderHistory)
      .where(eq(orderHistory.orderId, orderId));
    expect(history.filter((h) => h.type === 'refund_completed')).toHaveLength(2);
    expect((await loadOrder(orderId)).order).toMatchObject({
      status: 'REFUNDED',
      amountRefunded: 3150,
    });
    const done = (await listOrderRefundBatches(ctx, orderId))[0]!;
    expect(done).toMatchObject({ status: 'SUCCEEDED', openAmount: 0 });
  });

  it('cancelling after a tariff change (bank + PayPal): one batch, PayPal refunded per capture, bank one to-do', async () => {
    mockPayPal();
    const { orderId } = await paidOrder([seatIds[38]!], 'BANK_TRANSFER', [0]);
    const proposed = await propose(orderId, seatIds[38]!, { notify: false });
    await confirmAdjustment(ctx, { adjustmentId: proposed.adjustmentId, orderId });
    await startAdjustmentPayPalPayment(ctx, proposed.adjustmentId);
    const ppId = [...paypal.created.keys()].at(-1)!;
    paypal.approved.add(ppId);
    expect(await completePayPalPayment(ctx, orderId, ppId)).toEqual({ status: 'PAID' });

    const result = await cancelPaidOrder(ctx, { orderId, refundFees: true, notify: false, userId });
    expect(result.refunds.map((r) => [r.kind, r.amount]).sort()).toEqual([
      ['AUTOMATIC', 500],
      ['MANUAL', 2650],
    ]);
    const batch = (await listOpenRefunds(ctx)).find((b) => b.batchId === result.batchId)!;
    expect(batch).toMatchObject({ totalAmount: 3150, canComplete: true, canRetry: false });
    expect(batch.transfers).toMatchObject([{ amount: 2650 }]);

    // PayPal stays per capture (API constraint).
    const auto = result.refunds.find((r) => r.kind === 'AUTOMATIC')!;
    expect(await processPaypalRefund(ctx, auto.id)).toBe('SUCCEEDED');
    expect(paypal.refunds.at(-1)).toEqual({ captureId: `CAP-${ppId}` });

    // "Mark as refunded" touches the bank row only; the PayPal row was settled by the job.
    const done = await completeRefundBatch(ctx, { batchId: result.batchId, userId });
    const manual = result.refunds.find((r) => r.kind === 'MANUAL')!;
    expect(done).toEqual([manual.id]);
    const [batchDone] = await listOrderRefundBatches(ctx, orderId);
    expect(batchDone).toMatchObject({ status: 'SUCCEEDED', totalAmount: 3150, openAmount: 0 });
  });

  // ── Overpayment after cancellations, credit permissions, write-off ───────────

  it('a whole cancellation pays back the overpayment in the same batch (no invisible excess)', async () => {
    const { orderId } = await paidOrder([seatIds[40]!], 'BANK_TRANSFER', []);
    await issueInvoice(ctx, orderId);
    await overpay(orderId, 2000);
    const result = await cancelPaidOrder(ctx, { orderId, refundFees: true, notify: false, userId });
    // The credit note negates the 31.50 sale, the refund also returns the 20.00 € excess.
    expect(result).toMatchObject({
      orderStatus: 'REFUNDED',
      creditTotal: 3150,
      refundTotal: 5150,
      overpaymentRefunded: 2000,
    });
    const rows = await handle.db.select().from(refunds).where(eq(refunds.orderId, orderId));
    expect(new Set(rows.map((r) => r.batchId))).toEqual(new Set([result.batchId]));
    expect(rows.filter((r) => r.overpayment).reduce((s, r) => s + r.amount, 0)).toBe(2000);
    // Caps per payment hold.
    const paymentRows = await handle.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId));
    for (const p of paymentRows) {
      const refunded = rows.filter((r) => r.paymentId === p.id).reduce((s, r) => s + r.amount, 0);
      expect(refunded).toBeLessThanOrEqual(p.amount);
    }
    const batch = (await listOpenRefunds(ctx)).find((b) => b.batchId === result.batchId)!;
    expect(batch).toMatchObject({
      totalAmount: 5150,
      overpayment: false,
      creditNoteNumber: result.creditNote!.number,
    });
    // Nothing is left over on the REFUNDED order.
    expect((await getOrderCredit(handle.db, orderId)).credit).toBe(0);
    expect(await completeRefundBatch(ctx, { batchId: result.batchId, userId })).toHaveLength(
      rows.length,
    );
    expect((await loadOrder(orderId)).order).toMatchObject({
      status: 'REFUNDED',
      amountRefunded: 5150,
    });
  });

  it('after a partial cancellation the overpayment stays visible and can be refunded', async () => {
    const { orderId } = await paidOrder([seatIds[41]!, seatIds[42]!], 'BANK_TRANSFER', []);
    await overpay(orderId, 1000);
    const first = await itemOf(orderId, seatIds[41]!);
    const cancelled = await cancelPaidOrder(ctx, {
      orderId,
      orderItemIds: [first.id],
      refundFees: true,
      notify: false,
      userId,
    });
    expect(cancelled.orderStatus).toBe('PARTIALLY_REFUNDED');
    expect(cancelled.refundTotal).toBe(3150);
    // Net 41.50 − live value 31.50 (one ticket + its fee) = the real 10.00 € excess.
    expect((await getOrderCredit(handle.db, orderId)).credit).toBe(1000);
    await expect(
      refundOverpayment(ctx, { orderId, userId, expectedAmount: 999 }),
    ).rejects.toMatchObject({ code: 'OVERPAYMENT_CHANGED' });
    const refund = await refundOverpayment(ctx, { orderId, userId, expectedAmount: 1000 });
    expect(refund.amount).toBe(1000);
    expect((await getOrderCredit(handle.db, orderId)).credit).toBe(0);
    // Cancelling the rest: nothing left over.
    const rest = await cancelPaidOrder(ctx, { orderId, refundFees: true, notify: false, userId });
    expect(rest).toMatchObject({ orderStatus: 'REFUNDED', overpaymentRefunded: 0 });
  });

  it('credit needs finance: refused without the flag, settled-by-credit mail ignores notify=false', async () => {
    const { orderId } = await paidOrder([seatIds[43]!], 'BANK_TRANSFER', [0]);
    await overpay(orderId, 500);
    const item = await itemOf(orderId, seatIds[43]!);
    await expect(
      proposeTariffChange(ctx, {
        orderId,
        changes: [{ orderItemId: item.id, newTicketTypeId: normalId }],
        notify: true,
        userId,
      }),
    ).rejects.toMatchObject({ code: 'CREDIT_REQUIRES_FINANCE' });
    expect(
      (await handle.db.select().from(orderAdjustments).where(eq(orderAdjustments.orderId, orderId)))
        .length,
    ).toBe(0);

    const proposed = await propose(orderId, seatIds[43]!, { notify: false });
    expect(proposed.settledByCredit).toBe(true);
    expect(await messagesOf(orderId, 'ADDITIONAL_PAYMENT_SETTLED_BY_CREDIT')).toHaveLength(1);
  });

  it('a written-off shortfall is part of the credit calculation', async () => {
    const session = `k${uuid().slice(0, 8)}`;
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, [seatIds[44]!]);
    const { quotes } = await getCheckoutOptions(ctx, session);
    const total = quotes.BANK_TRANSFER.totalGross;
    const placed = await placeOrder(ctx, {
      sessionId: session,
      input: buyer('BANK_TRANSFER', total),
    });
    const paid = await recordPayment(ctx, {
      orderId: placed.orderId,
      amount: total - 100,
      currency: 'EUR',
      method: 'BANK_TRANSFER',
      settleShortfallUpTo: 100,
      actor: { type: 'SYSTEM' },
    });
    expect(paid.status).toBe('PAID');
    // Net money 31.50 − 1.00 written off: 3.00 € more is a 3.00 € excess, not 2.00 €.
    await overpay(placed.orderId, 300);
    expect((await getOrderCredit(handle.db, placed.orderId)).credit).toBe(300);
  });

  it('the overpayment an open tariff change relies on cannot be reversed', async () => {
    const { orderId } = await paidOrder([seatIds[45]!], 'BANK_TRANSFER', [0]);
    const [row] = await handle.db
      .insert(bankTransactions)
      .values({
        bankAccountId,
        fingerprint: `fp-${uuid()}`,
        bookingDate: '2026-03-01',
        amount: 200,
        currency: 'EUR',
        counterpartyName: 'Erika Example',
        counterpartyIban: 'DE02120300000000202051',
        remittanceInformation: 'extra',
      })
      .returning();
    await assignBankTransaction(ctx, { transactionId: row!.id, orderId, userId });
    const proposed = await propose(orderId, seatIds[45]!, { notify: false });
    expect(proposed).toMatchObject({ amount: 300, creditApplied: 200 });
    const [allocation] = await handle.db
      .select()
      .from(bankTransactionAllocations)
      .where(eq(bankTransactionAllocations.bankTransactionId, row!.id));
    await expect(
      reverseBankAllocation(ctx, { allocationId: allocation!.id, userId, reason: 'wrong' }),
    ).rejects.toMatchObject({ code: 'REVERSAL_BLOCKED_ADJUSTMENT' });
    expect((await getOrderCredit(handle.db, orderId)).credit).toBe(200);
    await cancelAdjustment(ctx, { adjustmentId: proposed.adjustmentId, userId });
    // Without the open request the overpayment can be reversed again.
    await reverseBankAllocation(ctx, { allocationId: allocation!.id, userId, reason: 'wrong' });
  });
});
