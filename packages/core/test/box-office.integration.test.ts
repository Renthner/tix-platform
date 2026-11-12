/**
 * Box office / complimentary sales against real PostgreSQL + Redis (throw-away database, own
 * Redis prefix). No object storage is used: the job queue is a mock, so no PDF is rendered or
 * written.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminUsers,
  createDb,
  customers,
  events,
  fees,
  invoices,
  loadRootEnv,
  orderFees,
  orderHistory,
  orderItems,
  orders,
  payments,
  priceCategories,
  priceCategoryTicketTypes,
  refunds,
  seatMapSections,
  seatMaps,
  taxRates,
  ticketTypes,
  tickets,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { type SeatMapDocumentInput } from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  afterSeatMapSaved,
  cancelPaidOrder,
  backfillMissingInvoices,
  createBoxOfficeOrder,
  getBoxOfficeHold,
  holdBoxOfficeSeats,
  quoteBoxOfficeOrder,
  releaseBoxOfficeHold,
  searchOrders,
  saveSetting,
  createCoreContext,
  enterShop,
  getEventById,
  issueInvoice,
  processPaidOrder,
  saveSeatMapDocument,
  type CoreContext,
  type EventRow,
  type JobQueues,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)('box office & complimentary tickets (integration)', () => {
  const dbName = `tix_boxoffice_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let event: EventRow;
  let seatIds: string[] = [];
  let blockedSeatId: string;
  let standingId: string;
  let normalId: string;
  let userId: string;
  const jobs = { add: vi.fn(async () => 'job'), close: async () => {} };

  const takenCode = async (seatId: string) =>
    (await ctx.seats.takenSeats(event.id))[seatId] ?? null;
  const sell = (
    lines: Parameters<typeof createBoxOfficeOrder>[1]['lines'],
    payment: 'CASH' | 'CARD' | 'COMPLIMENTARY' = 'CASH',
    extra: Partial<Parameters<typeof createBoxOfficeOrder>[1]> = {},
  ) =>
    createBoxOfficeOrder(ctx, {
      userId,
      channel: 'BOX_OFFICE',
      lines,
      payment,
      sendEmail: false,
      ...extra,
    });
  const seatLine = (seatId: string) => ({ eventId: event.id, seatId, ticketTypeId: normalId });

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
      .values({ email: 'door@example.invalid', displayName: 'Door', roles: ['DOOR_STAFF'] })
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
        // Online sale already ended / event is running: the box office still sells.
        startsAt: new Date(Date.now() - 60 * 60 * 1000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: tax!.id,
        orphanSeatRuleEnabled: false,
        maxTicketsPerOrder: 1,
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
    normalId = normal!.id;
    await handle.db
      .insert(priceCategoryTicketTypes)
      .values([{ priceCategoryId: category!.id, ticketTypeId: normal!.id }]);

    const sectionId = uuid();
    const rowId = uuid();
    standingId = uuid();
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
      seats: Array.from({ length: 16 }, (_, i) => ({
        id: uuid(),
        sectionId,
        rowId,
        label: String(i + 1),
        position: i + 1,
        x: 20 + i * 30,
        y: 20,
        priceCategoryId: category!.id,
        ...(i === 13 ? { blockReason: 'PRESS' as const } : {}),
      })),
    };
    const saved = await saveSeatMapDocument(handle.db, map!.id, doc, null);
    expect(saved.ok).toBe(true);
    if (saved.ok) await afterSeatMapSaved(ctx, saved);
    seatIds = doc.seats!.map((s) => s.id!);
    blockedSeatId = seatIds[13]!;
    event = await getEventById(ctx, ev!.id);

    // 1.50 € per ticket for the box office only, 2.00 € per ticket online only.
    await handle.db.insert(fees).values([
      {
        name: 'Box office fee',
        scope: 'PER_TICKET',
        calculation: 'FIXED',
        value: 150,
        channels: ['BOX_OFFICE'],
      },
      // No channel restriction = online only: never charged at the box office.
      { name: 'Legacy fee', scope: 'PER_TICKET', calculation: 'FIXED', value: 99, channels: null },
      {
        name: 'Online fee',
        scope: 'PER_TICKET',
        calculation: 'FIXED',
        value: 200,
        channels: ['ONLINE'],
      },
    ]);
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

  it('cash sale: PAID at once, tickets VALID, Redis sold, box-office fees, no order limits, anonymous buyer', async () => {
    const result = await sell([seatLine(seatIds[0]!), seatLine(seatIds[1]!)], 'CASH');
    // maxTicketsPerOrder = 1 online does not apply; 2 × 30 € + 2 × 1.50 € box-office fee.
    expect(result).toMatchObject({
      status: 'PAID',
      totalGross: 6300,
      ticketCount: 2,
      ticketsReady: true,
    });
    const [order] = await handle.db.select().from(orders).where(eq(orders.id, result.orderId));
    expect(order).toMatchObject({
      status: 'PAID',
      channel: 'BOX_OFFICE',
      paymentMethod: 'CASH',
      amountPaid: 6300,
      customerId: null,
      email: null,
      createdByUserId: userId,
    });
    const items = await handle.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order!.id));
    expect(items.every((i) => i.status === 'CONFIRMED')).toBe(true);
    // Correlated ticketCount subquery of the admin order list must count this order's items only.
    const listed = await searchOrders(ctx, { q: result.orderNumber });
    expect(listed.rows.find((r) => r.id === order!.id)?.ticketCount).toBe(items.length);
    const ticketRows = await handle.db.select().from(tickets).where(eq(tickets.orderId, order!.id));
    expect(ticketRows).toHaveLength(2);
    expect(ticketRows.every((t) => t.status === 'VALID')).toBe(true);
    expect(await takenCode(seatIds[0]!)).toBe('S');
    const [payment] = await handle.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, order!.id));
    expect(payment).toMatchObject({
      method: 'CASH',
      amount: 6300,
      status: 'CAPTURED',
      receivedByUserId: userId,
    });
    const fee = await handle.db.select().from(orderFees).where(eq(orderFees.orderId, order!.id));
    expect(fee.map((f) => f.name)).toEqual(['Box office fee']);
    const history = await handle.db
      .select()
      .from(orderHistory)
      .where(eq(orderHistory.orderId, order!.id));
    expect(history.map((h) => h.type)).toContain('box_office_sale');
    expect(jobs.add).toHaveBeenCalledWith(
      expect.anything(),
      'order-paid',
      expect.objectContaining({ orderId: order!.id, sendPaymentMail: false }),
      expect.anything(),
    );
    // The invoice is issued synchronously after the sale (no job needed).
    expect(
      await handle.db.select().from(invoices).where(eq(invoices.orderId, order!.id)),
    ).toHaveLength(1);
    // Invoice for the anonymous buyer (Kleinbetragsrechnung) works.
    const invoice = await issueInvoice(ctx, order!.id);
    expect(invoice).not.toBeNull();
    if (invoice) {
      const [row] = await handle.db
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoice.invoiceId));
      expect(row!.buyer.name).toBe('Walk-in customer');
    }
    // The paid-order job issues no e-mail without a buyer address.
    const processed = await processPaidOrder(ctx, order!.id, 0, { sendPaymentMail: true });
    expect(processed.messageId).toBeNull();
  });

  it('refuses a seat that is already sold', async () => {
    await expect(sell([seatLine(seatIds[0]!)])).rejects.toMatchObject({ code: 'SEAT_UNAVAILABLE' });
  });

  it('rejects a seat held in another online cart and leaves it untouched', async () => {
    const session = `k${uuid().slice(0, 8)}`;
    await enterShop(ctx, event, session).catch(() => undefined);
    await ctx.seats.lockSeats({
      eventId: event.id,
      sessionId: session,
      seatIds: [seatIds[2]!],
      expiresAt: Date.now() + 60_000,
      maxPerSession: 0,
    });
    await expect(sell([seatLine(seatIds[2]!), seatLine(seatIds[3]!)])).rejects.toMatchObject({
      code: 'SEAT_LOCKED',
    });
    // All-or-nothing: the free seat of the failed request is neither sold nor locked.
    expect(await takenCode(seatIds[3]!)).toBeNull();
    const ok = await sell([seatLine(seatIds[3]!)]);
    expect(ok.ticketCount).toBe(1);
    await ctx.seats.releaseSeats(event.id, session, [seatIds[2]!]);
  });

  it('sells blocked seats only with the explicit toggle; cancelling keeps them blocked online', async () => {
    await expect(sell([seatLine(blockedSeatId)], 'COMPLIMENTARY')).rejects.toMatchObject({
      code: 'SEAT_BLOCKED',
    });
    const result = await sell([seatLine(blockedSeatId)], 'COMPLIMENTARY', { allowBlocked: true });
    expect(result.totalGross).toBe(0);
    expect(await takenCode(blockedSeatId)).toBe('S');
    await cancelPaidOrder(ctx, {
      orderId: result.orderId,
      refundFees: true,
      notify: true,
      userId,
    });
    // Back to "blocked", not "free".
    expect(await takenCode(blockedSeatId)).toBe('B');
  });

  it('complimentary: 0 €, no fees, no invoice; cancelling frees the seat without any refund', async () => {
    const result = await sell([seatLine(seatIds[4]!)], 'COMPLIMENTARY', {
      buyer: { firstName: 'Guest', lastName: 'Of Honour' },
    });
    expect(result).toMatchObject({ totalGross: 0, feeTotal: 0, ticketCount: 1 });
    const [order] = await handle.db.select().from(orders).where(eq(orders.id, result.orderId));
    expect(order).toMatchObject({
      paymentMethod: 'COMPLIMENTARY',
      totalGross: 0,
      amountPaid: 0,
      email: null,
    });
    expect(
      await handle.db.select().from(orderFees).where(eq(orderFees.orderId, order!.id)),
    ).toHaveLength(0);
    expect(await issueInvoice(ctx, order!.id)).toBeNull();
    expect(
      await handle.db.select().from(invoices).where(eq(invoices.orderId, order!.id)),
    ).toHaveLength(0);

    const cancelled = await cancelPaidOrder(ctx, {
      orderId: order!.id,
      refundFees: true,
      notify: true, // nobody to notify – must not fail
      userId,
    });
    expect(cancelled).toMatchObject({ orderStatus: 'REFUNDED', refundTotal: 0, creditNote: null });
    expect(cancelled.refunds).toHaveLength(0);
    expect(
      await handle.db.select().from(refunds).where(eq(refunds.orderId, order!.id)),
    ).toHaveLength(0);
    const ticketRows = await handle.db.select().from(tickets).where(eq(tickets.orderId, order!.id));
    expect(ticketRows.every((t) => t.status === 'REFUNDED')).toBe(true);
    expect(await takenCode(seatIds[4]!)).toBeNull();
    // Bookable again.
    expect((await sell([seatLine(seatIds[4]!)])).ticketCount).toBe(1);
  });

  it('cancelling a cash sale creates a MANUAL refund to-do', async () => {
    const result = await sell([seatLine(seatIds[5]!)], 'CASH');
    const cancelled = await cancelPaidOrder(ctx, {
      orderId: result.orderId,
      refundFees: true,
      notify: false,
      userId,
    });
    expect(cancelled.refundTotal).toBe(3150);
    expect(cancelled.refunds).toEqual([
      expect.objectContaining({ kind: 'MANUAL', method: 'CASH', amount: 3150 }),
    ]);
    expect(await takenCode(seatIds[5]!)).toBeNull();
  });

  it('standing areas: capacity is enforced and spots return on cancel', async () => {
    const line = (quantity: number) => ({
      eventId: event.id,
      sectionId: standingId,
      quantity,
      ticketTypeId: normalId,
    });
    const first = await sell([line(2)], 'CARD');
    expect(first.ticketCount).toBe(2);
    await expect(sell([line(2)])).rejects.toMatchObject({ code: 'SECTION_SOLD_OUT' });
    const [section] = await handle.db
      .select()
      .from(seatMapSections)
      .where(eq(seatMapSections.id, standingId));
    expect(section!.allocatedCount).toBe(2);
    expect((await sell([line(1)])).ticketCount).toBe(1);
    await cancelPaidOrder(ctx, {
      orderId: first.orderId,
      refundFees: false,
      notify: false,
      userId,
    });
    const [after] = await handle.db
      .select()
      .from(seatMapSections)
      .where(eq(seatMapSections.id, standingId));
    expect(after!.allocatedCount).toBe(1);
    expect((await sell([line(2)])).ticketCount).toBe(2);
  });

  it('price override needs a reason and is audited', async () => {
    const line = { ...seatLine(seatIds[6]!), priceOverrideCents: 1000 };
    await expect(sell([line])).rejects.toMatchObject({ code: 'OVERRIDE_REASON_REQUIRED' });
    const result = await sell([line], 'CASH', { priceOverrideReason: 'Volunteer discount' });
    expect(result.totalGross).toBe(1000 + 150);
    const history = await handle.db
      .select()
      .from(orderHistory)
      .where(eq(orderHistory.orderId, result.orderId));
    expect(JSON.stringify(history.find((h) => h.type === 'box_office_sale')!.data)).toContain(
      'Volunteer discount',
    );
  });

  it('e-mail only on request and with an address', async () => {
    await expect(sell([seatLine(seatIds[7]!)], 'CASH', { sendEmail: true })).rejects.toMatchObject({
      code: 'EMAIL_REQUIRED',
    });
    const result = await sell([seatLine(seatIds[7]!)], 'CASH', {
      sendEmail: true,
      buyer: { email: 'Buyer@Example.invalid', firstName: 'Erika', lastName: 'Example' },
    });
    const [order] = await handle.db.select().from(orders).where(eq(orders.id, result.orderId));
    expect(order!.customerId).not.toBeNull();
    expect(jobs.add).toHaveBeenCalledWith(
      expect.anything(),
      'order-paid',
      expect.objectContaining({ orderId: order!.id, sendPaymentMail: true }),
      expect.anything(),
    );
  });

  it('an e-mail-only buyer does not erase the stored name of an existing guest', async () => {
    await handle.db.insert(customers).values({
      email: 'regular@example.invalid',
      firstName: 'Reggie',
      lastName: 'Regular',
      company: 'ACME',
      locale: 'de',
    });
    const result = await sell([seatLine(seatIds[8]!)], 'CASH', {
      locale: 'en',
      buyer: { email: 'regular@example.invalid' },
    });
    const [order] = await handle.db.select().from(orders).where(eq(orders.id, result.orderId));
    const [customer] = await handle.db
      .select()
      .from(customers)
      .where(eq(customers.id, order!.customerId!));
    expect(customer).toMatchObject({
      firstName: 'Reggie',
      lastName: 'Regular',
      company: 'ACME',
      locale: 'de',
    });
  });

  it('held picks: online buyers cannot take them, the sale converts the held locks all-or-nothing', async () => {
    const tabId = uuid();
    const held = await holdBoxOfficeSeats(ctx, {
      userId,
      tabId,
      eventId: event.id,
      seatIds: [seatIds[9]!],
    });
    expect(held.expiresAt).toBeGreaterThan(Date.now());
    const online = await ctx.seats.lockSeats({
      eventId: event.id,
      sessionId: `k${uuid().slice(0, 8)}`,
      seatIds: [seatIds[9]!],
      expiresAt: Date.now() + 60_000,
      maxPerSession: 0,
    });
    expect(online).toMatchObject({ ok: false, reason: 'LOCKED' });
    // A re-opened page restores selection and countdown from the server (stable tab id).
    expect(await getBoxOfficeHold(ctx, { userId, tabId, eventId: event.id })).toEqual({
      seatIds: [seatIds[9]!],
      ga: {},
      expiresAt: held.expiresAt,
    });
    expect(await getBoxOfficeHold(ctx, { userId, tabId: uuid(), eventId: event.id })).toEqual({
      seatIds: [],
      ga: {},
      expiresAt: null,
    });
    const result = await sell([seatLine(seatIds[9]!)], 'CASH', { holdTabId: tabId });
    expect(result.ticketCount).toBe(1);
    expect(await takenCode(seatIds[9]!)).toBe('S');

    // A hold that was released (or expired) cannot be sold; nothing is leaked.
    const tabB = uuid();
    await holdBoxOfficeSeats(ctx, {
      userId,
      tabId: tabB,
      eventId: event.id,
      seatIds: [seatIds[10]!],
    });
    await releaseBoxOfficeHold(ctx, { userId, tabId: tabB, eventId: event.id });
    await expect(sell([seatLine(seatIds[10]!)], 'CASH', { holdTabId: tabB })).rejects.toMatchObject(
      {
        code: 'HOLD_EXPIRED',
      },
    );
    expect(await takenCode(seatIds[10]!)).toBeNull();
    // Another tab's hold is not usable.
    await holdBoxOfficeSeats(ctx, { userId, tabId, eventId: event.id, seatIds: [seatIds[10]!] });
    await expect(sell([seatLine(seatIds[10]!)], 'CASH', { holdTabId: tabB })).rejects.toMatchObject(
      {
        code: 'HOLD_EXPIRED',
      },
    );
    // Blocked seats are rejected by the hold API.
    await expect(
      holdBoxOfficeSeats(ctx, { userId, tabId, eventId: event.id, seatIds: [blockedSeatId] }),
    ).rejects.toMatchObject({ code: 'SEAT_UNAVAILABLE' });
    await releaseBoxOfficeHold(ctx, { userId, tabId, eventId: event.id });
  });

  it('double submit of one hold creates exactly one order', async () => {
    const tabId = uuid();
    await holdBoxOfficeSeats(ctx, { userId, tabId, eventId: event.id, seatIds: [seatIds[10]!] });
    const results = await Promise.allSettled([
      sell([seatLine(seatIds[10]!)], 'CASH', { holdTabId: tabId }),
      sell([seatLine(seatIds[10]!)], 'CASH', { holdTabId: tabId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await handle.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.seatId, seatIds[10]!));
    expect(rows.filter((r) => r.status === 'CONFIRMED')).toHaveLength(1);
  });

  it('two consecutive held sales on one tab both succeed (sale lock is released)', async () => {
    const tabId = uuid();
    await holdBoxOfficeSeats(ctx, { userId, tabId, eventId: event.id, seatIds: [seatIds[14]!] });
    await sell([seatLine(seatIds[14]!)], 'CASH', { holdTabId: tabId });
    await holdBoxOfficeSeats(ctx, { userId, tabId, eventId: event.id, seatIds: [seatIds[15]!] });
    const second = await sell([seatLine(seatIds[15]!)], 'CASH', { holdTabId: tabId });
    expect(second.status).toBe('PAID');
  });

  it('the sweeper issues missing invoices of paid box-office orders', async () => {
    await saveSetting(ctx, 'invoicing', { issueInvoices: false }, null);
    let orderId: string;
    try {
      orderId = (await sell([seatLine(seatIds[5]!)], 'CASH')).orderId;
    } finally {
      await saveSetting(ctx, 'invoicing', { issueInvoices: true }, null);
    }
    expect(
      await handle.db.select().from(invoices).where(eq(invoices.orderId, orderId)),
    ).toHaveLength(0);
    expect((await backfillMissingInvoices(ctx)).issued).toBeGreaterThanOrEqual(1);
    expect(
      await handle.db.select().from(invoices).where(eq(invoices.orderId, orderId)),
    ).toHaveLength(1);
  });

  it('only published events can be sold (draft is refused)', async () => {
    const { id: _id, seatMapId: _map, ...copy } = event;
    const [draft] = await handle.db
      .insert(events)
      .values({ ...copy, slug: `draft-${uuid().slice(0, 6)}`, status: 'DRAFT' })
      .returning();
    await expect(
      sell([{ eventId: draft!.id, seatId: uuid(), ticketTypeId: normalId }]),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_SELLABLE' });
  });

  it('above the small-amount limit an invoice needs name and address (not for complimentary)', async () => {
    await saveSetting(ctx, 'invoicing', { smallAmountInvoiceLimit: 1000 }, null);
    try {
      const quote = await quoteBoxOfficeOrder(ctx, {
        channel: 'BOX_OFFICE',
        payment: 'CASH',
        lines: [seatLine(seatIds[11]!)],
      });
      expect(quote).toMatchObject({ buyerDataRequired: true, smallAmountInvoiceLimit: 1000 });
      await expect(sell([seatLine(seatIds[11]!)])).rejects.toMatchObject({
        code: 'BUYER_DATA_REQUIRED',
      });
      await expect(
        sell([seatLine(seatIds[11]!)], 'CASH', { buyer: { firstName: 'Ann', lastName: 'Lee' } }),
      ).rejects.toMatchObject({ code: 'BUYER_DATA_REQUIRED' });
      const ok = await sell([seatLine(seatIds[11]!)], 'CARD', {
        buyer: {
          firstName: 'Ann',
          lastName: 'Lee',
          address: { street: 'Main St 1', postalCode: '12345', city: 'Town', country: 'DE' },
        },
      });
      expect(ok.ticketCount).toBe(1);
      expect((await sell([seatLine(seatIds[12]!)], 'COMPLIMENTARY')).totalGross).toBe(0);
    } finally {
      await saveSetting(ctx, 'invoicing', { smallAmountInvoiceLimit: 25000 }, null);
    }
    // Back under the default limit no buyer data is needed.
    expect((await sell([seatLine(seatIds[2]!)])).ticketCount).toBe(1);
  });

  it('database: ONLINE orders require customer and e-mail (other channels do not)', async () => {
    const [existing] = await handle.db
      .select()
      .from(orders)
      .where(eq(orders.channel, 'BOX_OFFICE'))
      .limit(1);
    const { id: _id, paymentReference: _ref, ...copy } = existing!;
    const bad = { ...copy, orderNumber: 'X-1', channel: 'ONLINE' as const };
    // Drizzle wraps the driver error: the violated constraint is on the cause.
    const violated = async (insert: PromiseLike<unknown>) => {
      try {
        await insert;
      } catch (err) {
        return (err as { cause?: { constraint?: string } }).cause?.constraint ?? String(err);
      }
      return 'none';
    };
    expect(
      await violated(handle.db.insert(orders).values({ ...bad, customerId: null, email: null })),
    ).toBe('orders_online_has_buyer');
    expect(
      await violated(
        handle.db
          .insert(orders)
          .values({ ...bad, orderNumber: 'X-2', customerId: null, email: 'a@example.invalid' }),
      ),
    ).toBe('orders_online_has_buyer');
    // Positive control: the same anonymous row is fine for the box office.
    await expect(
      handle.db.insert(orders).values({
        ...copy,
        orderNumber: 'X-3',
        channel: 'BOX_OFFICE',
        customerId: null,
        email: null,
      }),
    ).resolves.toBeDefined();
  });
});
