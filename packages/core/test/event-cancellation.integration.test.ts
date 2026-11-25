/**
 * Event cancellation assistant, buyer mailings and order e-mail change against real PostgreSQL +
 * Redis (throw-away database). Job queue is a mock: nothing is rendered or sent, the outbox rows
 * (email_messages) are asserted instead.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminUsers,
  bankAccounts,
  bankTransactions,
  checkInLogs,
  createDb,
  emailMessages,
  eventCancellationRuns,
  eventMailingRecipients,
  eventMailings,
  events,
  fees,
  loadRootEnv,
  orderHistory,
  orderItems,
  orders,
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
import { checkoutInputSchema, type CheckoutInput, type SeatMapDocumentInput } from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addSeats,
  afterSeatMapSaved,
  cancelOrder,
  changeEventStatus,
  changeOrderEmail,
  collectFindings,
  createCoreContext,
  createEventMailing,
  DomainError,
  enqueueEventCancellationRun,
  enterShop,
  ensureOrderTickets,
  getCheckoutOptions,
  getEventById,
  getSetting,
  JobQueues,
  matchBankTransaction,
  loadMailingRecipients,
  resumeStaleEventCancellationRuns,
  resumeStaleEventMailings,
  runDunning,
  saveSecretSetting,
  saveSetting,
  placeOrder,
  postponeEvent,
  previewEventCancellation,
  recordPayment,
  runEventCancellation,
  saveSeatMapDocument,
  sendEventMailingChunk,
  searchOrdersForExport,
  sendPaymentReminderNow,
  startEventCancellation,
  startPayPalPayment,
  webDoorScan,
  type CoreContext,
  type EventRow,
  type OrderExportCursor,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)('event cancellation & communication (integration)', () => {
  const dbName = `tix_evcancel_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let userId: string;
  let venueId: string;
  let taxId: string;
  const jobs = { add: vi.fn(async () => 'job'), close: async () => {} };

  interface Fixture {
    event: EventRow;
    seatIds: string[];
    categoryId: string;
  }

  async function makeEvent(title: string): Promise<Fixture> {
    const [map] = await handle.db
      .insert(seatMaps)
      .values({ venueId, kind: 'EVENT', name: title, canvasWidth: 800, canvasHeight: 600 })
      .returning();
    const [ev] = await handle.db
      .insert(events)
      .values({
        venueId,
        seatMapId: map!.id,
        slug: `show-${uuid().slice(0, 8)}`,
        title,
        status: 'PUBLISHED',
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: taxId,
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
      name: title,
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
      seats: Array.from({ length: 20 }, (_, i) => ({
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
    return {
      event: await getEventById(ctx, ev!.id),
      seatIds: doc.seats!.map((s) => s.id!),
      categoryId: category!.id,
    };
  }

  const buyer = (method: CheckoutInput['method'], total: number, email: string): CheckoutInput =>
    checkoutInputSchema.parse({
      method,
      email,
      firstName: 'Erika',
      lastName: 'Example',
      phone: '+49 6134 123456',
      address: { street: 'Hauptstrasse 1', postalCode: '65462', city: 'Ginsheim', country: 'DE' },
      acceptTerms: true,
      expectedTotalGross: total,
      locale: 'en',
    });

  /** Places an order for seats of one or more events; optionally pays it. */
  async function order(
    picks: { fx: Fixture; seats: string[] }[],
    method: 'PAYPAL' | 'BANK_TRANSFER',
    options: { pay?: boolean; email?: string } = {},
  ) {
    const session = `k${uuid().slice(0, 8)}`;
    for (const p of picks) {
      await enterShop(ctx, p.fx.event, session);
      await addSeats(ctx, session, p.fx.event, p.seats);
    }
    const { quotes } = await getCheckoutOptions(ctx, session);
    const total = quotes[method].totalGross;
    const placed = await placeOrder(ctx, {
      sessionId: session,
      input: buyer(method, total, options.email ?? `buyer-${uuid().slice(0, 6)}@example.invalid`),
    });
    if (options.pay) {
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
    }
    return placed.orderId;
  }

  const mails = (orderId: string, key: string) =>
    handle.db
      .select()
      .from(emailMessages)
      .where(and(eq(emailMessages.orderId, orderId), eq(emailMessages.templateKey, key as never)));

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
      .values({
        email: 'manager@example.invalid',
        displayName: 'Manager',
        roles: ['EVENT_MANAGER'],
      })
      .returning({ id: adminUsers.id });
    userId = user!.id;
    const [venue] = await handle.db
      .insert(venues)
      .values({ name: 'Hall', slug: `hall-${uuid().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning();
    venueId = venue!.id;
    const [tax] = await handle.db
      .insert(taxRates)
      .values({ name: `vat-${uuid().slice(0, 6)}`, rateBasisPoints: 1900 })
      .returning();
    taxId = tax!.id;
    await handle.db
      .insert(fees)
      .values([{ name: 'Service fee', scope: 'PER_TICKET', calculation: 'FIXED', value: 150 }]);
    await saveSetting(
      ctx,
      'paypal',
      { enabled: true, clientId: 'client-id', webhookId: 'WH-1' },
      null,
    );
    await saveSecretSetting(ctx, 'paypal.credentials', { clientSecret: 'client-secret' }, null);
    await handle.db.insert(bankAccounts).values({
      name: 'Main',
      accountHolder: 'Example Theatre e.V.',
      iban: 'DE89370400440532013000',
      currency: 'EUR',
      isDefaultForBankTransfer: true,
    });
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

  it('cancels unpaid, paid (PayPal, bank) and the event part of multi-event orders; re-runs change nothing', async () => {
    const a = await makeEvent('Cancelled Show');
    const b = await makeEvent('Other Show');
    const unpaid = await order([{ fx: a, seats: [a.seatIds[0]!] }], 'BANK_TRANSFER');
    const paypal = await order([{ fx: a, seats: [a.seatIds[1]!, a.seatIds[2]!] }], 'PAYPAL', {
      pay: true,
    });
    const bank = await order([{ fx: a, seats: [a.seatIds[3]!] }], 'BANK_TRANSFER', { pay: true });
    const multi = await order(
      [
        { fx: a, seats: [a.seatIds[4]!] },
        { fx: b, seats: [b.seatIds[0]!] },
      ],
      'PAYPAL',
      { pay: true },
    );
    const unpaidMulti = await order(
      [
        { fx: a, seats: [a.seatIds[5]!] },
        { fx: b, seats: [b.seatIds[1]!] },
      ],
      'BANK_TRANSFER',
    );

    const preview = await previewEventCancellation(ctx, a.event.id);
    expect(preview.unpaid.orders).toBe(1);
    expect(preview.manual.orders).toBe(1);
    expect(preview.paid.orders).toBe(3);
    expect(preview.paid.multiEventOrders).toBe(1);
    expect(preview.paid.byMethod.map((m) => m.method).sort()).toEqual(['BANK_TRANSFER', 'PAYPAL']);

    const started = await startEventCancellation(ctx, {
      eventId: a.event.id,
      reason: 'Illness',
      refundFees: true,
      notify: true,
      userId,
    });
    expect(started.alreadyRunning).toBe(false);
    // A second start while the run is open returns the same run.
    const again = await startEventCancellation(ctx, {
      eventId: a.event.id,
      refundFees: true,
      notify: true,
      userId,
    });
    expect(again).toEqual({ runId: started.runId, alreadyRunning: true });

    const result = await runEventCancellation(ctx, started.runId);
    expect(result).toMatchObject({
      status: 'COMPLETED',
      cancelledOrders: 4,
      manualOrders: 1,
      failedOrders: 0,
    });

    const [ev] = await handle.db.select().from(events).where(eq(events.id, a.event.id));
    expect(ev!.status).toBe('CANCELLED');

    const status = async (id: string) =>
      (await handle.db.select({ s: orders.status }).from(orders).where(eq(orders.id, id)))[0]!.s;
    expect(await status(unpaid)).toBe('CANCELLED');
    expect(await status(paypal)).toBe('REFUNDED');
    expect(await status(bank)).toBe('REFUNDED');
    expect(await status(multi)).toBe('PARTIALLY_REFUNDED');
    expect(await status(unpaidMulti)).toBe('AWAITING_PAYMENT');

    // Multi-event order: the other event's ticket stays valid.
    const multiItems = await handle.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, multi));
    expect(multiItems.find((i) => i.eventId === b.event.id)!.status).toBe('CONFIRMED');
    expect(multiItems.find((i) => i.eventId === a.event.id)!.status).toBe('REFUNDED');
    const validOther = await handle.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.orderId, multi), eq(tickets.eventId, b.event.id)));
    expect(validOther.length).toBeGreaterThan(0);
    expect(validOther.every((t) => t.status === 'VALID')).toBe(true);

    // Refund rows: PayPal automatic (fees included), bank transfer = manual to-do.
    const paypalRefunds = await handle.db.select().from(refunds).where(eq(refunds.orderId, paypal));
    expect(paypalRefunds.length).toBeGreaterThan(0);
    expect(paypalRefunds.every((r) => r.kind === 'AUTOMATIC' && r.refundFees)).toBe(true);
    expect(paypalRefunds.reduce((s, r) => s + r.amount, 0)).toBe(2 * 3000 + 2 * 150);
    const bankRefunds = await handle.db.select().from(refunds).where(eq(refunds.orderId, bank));
    expect(bankRefunds.length).toBeGreaterThan(0);
    expect(bankRefunds.every((r) => r.kind === 'MANUAL')).toBe(true);

    // Seats are bookable again; the manual order still holds its seat.
    const taken = await ctx.seats.takenSeats(a.event.id);
    expect(taken[a.seatIds[0]!]).toBeUndefined();
    expect(taken[a.seatIds[1]!]).toBeUndefined();
    expect(taken[a.seatIds[5]!]).toBeDefined();

    // Exactly one EVENT_CANCELLED mail per cancelled order, naming the cancelled event.
    for (const id of [unpaid, paypal, bank, multi]) {
      expect((await mails(id, 'EVENT_CANCELLED')).length).toBe(1);
    }
    expect((await mails(unpaidMulti, 'EVENT_CANCELLED')).length).toBe(0);
    const [paidMail] = await mails(paypal, 'EVENT_CANCELLED');
    const payload = paidMail!.attachments as { attachments: { type: string }[]; eventId: string };
    expect(payload.eventId).toBe(a.event.id);
    expect(payload.attachments.some((x) => x.type === 'invoice')).toBe(true);

    // Idempotent: a fresh run finds nothing to cancel and creates no further mail / refund rows.
    const refundCount = (await handle.db.select().from(refunds)).length;
    const second = await startEventCancellation(ctx, {
      eventId: a.event.id,
      refundFees: true,
      notify: true,
      userId,
    });
    expect(second.alreadyRunning).toBe(false);
    const rerun = await runEventCancellation(ctx, second.runId);
    expect(rerun.cancelledOrders).toBe(0);
    expect(rerun.manualOrders).toBe(1);
    expect((await handle.db.select().from(refunds)).length).toBe(refundCount);
    expect((await mails(paypal, 'EVENT_CANCELLED')).length).toBe(1);
    const runs = await handle.db
      .select()
      .from(eventCancellationRuns)
      .where(eq(eventCancellationRuns.eventId, a.event.id));
    expect(runs.length).toBe(2);
  });

  it('mails buyers once per address and honours the audience filter', async () => {
    const fx = await makeEvent('Mailing Show');
    const shared = 'same@example.invalid';
    const first = await order([{ fx, seats: [fx.seatIds[0]!] }], 'PAYPAL', {
      pay: true,
      email: shared,
    });
    const second = await order([{ fx, seats: [fx.seatIds[1]!] }], 'PAYPAL', {
      pay: true,
      email: shared.toUpperCase(),
    });
    const other = await order([{ fx, seats: [fx.seatIds[2]!] }], 'PAYPAL', { pay: true });
    const unpaid = await order([{ fx, seats: [fx.seatIds[3]!] }], 'BANK_TRANSFER');

    const paidOnly = await loadMailingRecipients(handle.db, {
      eventId: fx.event.id,
      audience: 'PAID',
    });
    expect(paidOnly.length).toBe(2);
    const everyone = await loadMailingRecipients(handle.db, {
      eventId: fx.event.id,
      audience: 'ACTIVE',
    });
    expect(everyone.length).toBe(3);
    expect([first, second]).toContain(
      everyone.find((r) => r.email.toLowerCase() === shared)!.orderId,
    );
    const byCategory = await loadMailingRecipients(handle.db, {
      eventId: fx.event.id,
      audience: 'CATEGORY',
      categoryId: fx.categoryId,
    });
    expect(byCategory.length).toBe(3);

    const { mailingId, recipients } = await createEventMailing(ctx, {
      eventId: fx.event.id,
      audience: 'PAID',
      subject: 'Doors open earlier',
      body: 'Line one\n\nLine <b>two</b>',
      userId,
    });
    expect(recipients).toBe(2);
    expect(await sendEventMailingChunk(ctx, mailingId, 1)).toEqual({ queued: 1, remaining: 1 });
    expect(await sendEventMailingChunk(ctx, mailingId, 10)).toEqual({ queued: 1, remaining: 0 });
    // Finished: running it again sends nothing.
    expect(await sendEventMailingChunk(ctx, mailingId, 10)).toEqual({ queued: 0, remaining: 0 });
    const sent = await handle.db
      .select()
      .from(emailMessages)
      .where(
        and(
          inArray(emailMessages.orderId, [first, second, other, unpaid]),
          eq(emailMessages.templateKey, 'EVENT_MESSAGE'),
        ),
      );
    expect(sent.length).toBe(2);
    const claimed = await handle.db
      .select()
      .from(eventMailingRecipients)
      .where(eq(eventMailingRecipients.mailingId, mailingId));
    expect(claimed.length).toBe(2);
    await expect(
      createEventMailing(ctx, {
        eventId: fx.event.id,
        audience: 'PAID',
        subject: ' ',
        body: 'x',
        userId,
      }),
    ).rejects.toMatchObject({ code: 'MESSAGE_REQUIRED' });
  });

  /** Mails to an address (holder mails carry no order id). */
  const mailsTo = (email: string, key: string) =>
    handle.db
      .select()
      .from(emailMessages)
      .where(
        and(
          sql`lower(${emailMessages.toEmail}) = ${email.toLowerCase()}`,
          eq(emailMessages.templateKey, key as never),
        ),
      );

  /** Hands the given tickets of an order over to `holderEmail` (as the transfer flow would). */
  async function passOn(orderId: string, index: number[], holderEmail: string, name: string) {
    const list = await handle.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.orderId, orderId), eq(tickets.status, 'VALID')))
      .orderBy(tickets.ticketCode);
    expect(list.length).toBeGreaterThan(Math.max(...index));
    await handle.db
      .update(tickets)
      .set({ holderEmail, attendeeName: name })
      .where(
        inArray(
          tickets.id,
          index.map((i) => list[i]!.id),
        ),
      );
  }

  it('sends holders of passed-on tickets the holder cancellation notice (once, never to the buyer address)', async () => {
    const fx = await makeEvent('Holder Cancel Show');
    const buyerEmail = `holder-buyer-${uuid().slice(0, 6)}@example.invalid`;
    const holderEmail = `holder-a-${uuid().slice(0, 6)}@example.invalid`;
    const placed = await order(
      [{ fx, seats: [fx.seatIds[0]!, fx.seatIds[1]!, fx.seatIds[2]!, fx.seatIds[3]!] }],
      'PAYPAL',
      { pay: true, email: buyerEmail },
    );
    // Two tickets to one holder, one "passed on" to the buyer's own address (other case), one kept.
    await passOn(placed, [0, 1], holderEmail, 'Hanna Holder');
    await passOn(placed, [2], ` ${buyerEmail.toUpperCase()} `, 'Erika Example');

    const { runId } = await startEventCancellation(ctx, {
      eventId: fx.event.id,
      reason: 'Storm',
      refundFees: true,
      notify: true,
      userId,
    });
    expect((await runEventCancellation(ctx, runId)).cancelledOrders).toBe(1);

    expect((await mails(placed, 'EVENT_CANCELLED')).length).toBe(1);
    const holderMails = await mailsTo(holderEmail, 'EVENT_CANCELLED_HOLDER');
    expect(holderMails.length).toBe(1);
    expect(holderMails[0]!.orderId).toBeNull();
    const envelope = holderMails[0]!.attachments as { sourceOrderId: string; eventId: string };
    expect(envelope.sourceOrderId).toBe(placed);
    expect(envelope.eventId).toBe(fx.event.id);
    // The holder version replaces the generic "ticket no longer valid" mail.
    expect((await mailsTo(holderEmail, 'TICKET_HOLDER_CANCELLED')).length).toBe(0);
    // The buyer's own address only gets the buyer mail.
    expect((await mailsTo(buyerEmail, 'EVENT_CANCELLED_HOLDER')).length).toBe(0);
    expect((await mailsTo(buyerEmail, 'TICKET_HOLDER_CANCELLED')).length).toBe(0);
    expect((await mailsTo(buyerEmail, 'EVENT_CANCELLED')).length).toBe(1);

    // A re-run finds no valid ticket and sends nothing again.
    const again = await startEventCancellation(ctx, {
      eventId: fx.event.id,
      refundFees: true,
      notify: true,
      userId,
    });
    await runEventCancellation(ctx, again.runId);
    expect((await mailsTo(holderEmail, 'EVENT_CANCELLED_HOLDER')).length).toBe(1);
    expect((await mails(placed, 'EVENT_CANCELLED')).length).toBe(1);
  });

  it('mailings and the postponement notice reach holders of passed-on tickets once', async () => {
    const fx = await makeEvent('Holder Mailing Show');
    const buyerA = `mail-a-${uuid().slice(0, 6)}@example.invalid`;
    const buyerB = `mail-b-${uuid().slice(0, 6)}@example.invalid`;
    const holder = `mail-h-${uuid().slice(0, 6)}@example.invalid`;
    const first = await order([{ fx, seats: [fx.seatIds[0]!, fx.seatIds[1]!] }], 'PAYPAL', {
      pay: true,
      email: buyerA,
    });
    const second = await order([{ fx, seats: [fx.seatIds[2]!, fx.seatIds[3]!] }], 'PAYPAL', {
      pay: true,
      email: buyerB,
    });
    // The holder gets tickets from both buyers; buyer B also passed one on to buyer A.
    await passOn(first, [0], holder, 'Hanna Holder');
    await passOn(second, [0], holder.toUpperCase(), 'Hanna Holder');
    await passOn(second, [1], buyerA, 'Erika Example');

    const recipients = await loadMailingRecipients(handle.db, {
      eventId: fx.event.id,
      audience: 'PAID',
    });
    expect(recipients.map((r) => r.email.toLowerCase()).sort()).toEqual(
      [buyerA, buyerB, holder].sort(),
    );
    expect(recipients.filter((r) => r.holder).length).toBe(1);
    const byCategory = await loadMailingRecipients(handle.db, {
      eventId: fx.event.id,
      audience: 'CATEGORY',
      categoryId: fx.categoryId,
    });
    expect(byCategory.length).toBe(3);

    const { mailingId, recipients: count } = await createEventMailing(ctx, {
      eventId: fx.event.id,
      audience: 'PAID',
      subject: 'Parking',
      body: 'Use the north car park.',
      userId,
    });
    expect(count).toBe(3);
    expect(await sendEventMailingChunk(ctx, mailingId, 10)).toEqual({ queued: 3, remaining: 0 });
    expect(await sendEventMailingChunk(ctx, mailingId, 10)).toEqual({ queued: 0, remaining: 0 });
    const holderMails = await mailsTo(holder, 'EVENT_MESSAGE');
    expect(holderMails.length).toBe(1);
    expect(holderMails[0]!.orderId).toBeNull();
    expect((await mailsTo(buyerA, 'EVENT_MESSAGE')).length).toBe(1);
    expect((await mailsTo(buyerB, 'EVENT_MESSAGE')).length).toBe(1);

    const postponed = await postponeEvent(ctx, {
      eventId: fx.event.id,
      newStartsAt: new Date(Date.now() + 60 * 86_400_000),
      note: 'New date below.',
      notify: true,
      userId,
    });
    expect(postponed.recipients).toBe(3);
    await sendEventMailingChunk(ctx, postponed.mailingId!, 10);
    expect((await mailsTo(holder, 'EVENT_POSTPONED')).length).toBe(1);
    expect((await mailsTo(buyerA, 'EVENT_POSTPONED')).length).toBe(1);
  });

  const orderStatus = async (id: string) =>
    (await handle.db.select({ s: orders.status }).from(orders).where(eq(orders.id, id)))[0]!.s;

  it('cancelOrder guard re-checks "nothing paid, only this event" on the locked row', async () => {
    const a = await makeEvent('Guard Show');
    const b = await makeEvent('Guard Other');
    const partly = await order([{ fx: a, seats: [a.seatIds[0]!] }], 'BANK_TRANSFER');
    // A partial payment that the (unlocked) classification did not see.
    await handle.db.update(orders).set({ amountPaid: 100 }).where(eq(orders.id, partly));
    const multi = await order(
      [
        { fx: a, seats: [a.seatIds[1]!] },
        { fx: b, seats: [b.seatIds[0]!] },
      ],
      'BANK_TRANSFER',
    );
    const clean = await order([{ fx: a, seats: [a.seatIds[2]!] }], 'BANK_TRANSFER');
    const guard = { onlyIfNothingPaid: { eventId: a.event.id } };
    const cancel = (orderId: string) =>
      cancelOrder(ctx, { orderId, status: 'CANCELLED', actor: { type: 'SYSTEM' }, ...guard });
    expect(await cancel(partly)).toBe(false);
    expect(await cancel(multi)).toBe(false);
    expect(await cancel(clean)).toBe(true);
    expect(await orderStatus(partly)).toBe('AWAITING_PAYMENT');
    expect(await orderStatus(multi)).toBe('AWAITING_PAYMENT');
    expect(await orderStatus(clean)).toBe('CANCELLED');
  });

  it('skips the notice for an unusable address but still cancels; leftovers end the run with errors', async () => {
    const fx = await makeEvent('Bad Address Show');
    const broken = await order([{ fx, seats: [fx.seatIds[0]!] }], 'BANK_TRANSFER');
    await handle.db.update(orders).set({ email: 'not-an-address' }).where(eq(orders.id, broken));
    // Paid order whose item of the event is not CONFIRMED: the paid path skips it in every pass.
    const stuck = await order([{ fx, seats: [fx.seatIds[1]!] }], 'PAYPAL', { pay: true });
    await handle.db
      .update(orderItems)
      .set({ status: 'PENDING' })
      .where(eq(orderItems.orderId, stuck));

    const { runId } = await startEventCancellation(ctx, {
      eventId: fx.event.id,
      refundFees: true,
      notify: true,
      userId,
    });
    const result = await runEventCancellation(ctx, runId);
    expect(await orderStatus(broken)).toBe('CANCELLED');
    expect((await mails(broken, 'EVENT_CANCELLED')).length).toBe(0);
    // SKIPPED orders trigger further passes (bounded) and are reported instead of a silent COMPLETED.
    expect(result.status).toBe('COMPLETED_WITH_ERRORS');
    expect(result.cancelledOrders).toBe(1);
    const [run] = await handle.db
      .select()
      .from(eventCancellationRuns)
      .where(eq(eventCancellationRuns.id, runId));
    expect(run!.lastError).toMatch(/^ORDERS_LEFT: 1 /);
  });

  it('refuses to un-cancel during a run; a run whose event was taken back ends instead of retrying', async () => {
    const fx = await makeEvent('Taken Back Show');
    await order([{ fx, seats: [fx.seatIds[0]!] }], 'BANK_TRANSFER');
    const { runId } = await startEventCancellation(ctx, {
      eventId: fx.event.id,
      refundFees: true,
      notify: false,
      userId,
    });
    await expect(
      changeEventStatus(ctx, { eventId: fx.event.id, status: 'PUBLISHED' }),
    ).rejects.toMatchObject({ code: 'EVENT_CANCELLATION_RUNNING' });
    // A status change that slipped in before the run row existed (written directly here).
    await handle.db.update(events).set({ status: 'PUBLISHED' }).where(eq(events.id, fx.event.id));
    const result = await runEventCancellation(ctx, runId);
    expect(result.status).toBe('COMPLETED_WITH_ERRORS');
    expect(result.cancelledOrders).toBe(0);
    const [run] = await handle.db
      .select()
      .from(eventCancellationRuns)
      .where(eq(eventCancellationRuns.id, runId));
    expect(run!.lastError).toMatch(/^EVENT_NOT_CANCELLED/);
    expect(run!.finishedAt).not.toBeNull();
    // The run is over: leaving CANCELLED is possible again.
    await handle.db.update(events).set({ status: 'CANCELLED' }).where(eq(events.id, fx.event.id));
    await expect(
      changeEventStatus(ctx, { eventId: fx.event.id, status: 'PUBLISHED' }),
    ).resolves.toMatchObject({ from: 'CANCELLED' });
  });

  it('sweepers and resume only (re-)queue when the job is gone or finished', async () => {
    const fx = await makeEvent('Sweeper Show');
    const { runId } = await startEventCancellation(ctx, {
      eventId: fx.event.id,
      refundFees: true,
      notify: false,
      userId,
    });
    await handle.db
      .update(eventCancellationRuns)
      .set({ heartbeatAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(eventCancellationRuns.id, runId));
    const existing = { getState: vi.fn(async () => 'delayed'), remove: vi.fn(async () => {}) };
    const queue = { getJob: vi.fn(async () => existing as unknown), add: vi.fn(async () => ({})) };
    const fakeJobs = Object.create(JobQueues.prototype) as JobQueues;
    (fakeJobs as unknown as { queue: () => typeof queue }).queue = () => queue;
    const sweepCtx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: ctx.keys.prefix,
      sessionSecret: 'x'.repeat(48),
      jobs: fakeJobs,
    });
    // Job still waiting in its back-off: nothing is duplicated, heartbeat untouched.
    expect(await resumeStaleEventCancellationRuns(sweepCtx)).toBe(0);
    expect(queue.getJob).toHaveBeenCalledWith(`event-cancel-${runId}`);
    expect(queue.add).not.toHaveBeenCalled();
    // Job failed for good: it is removed and queued again under the same id.
    existing.getState.mockResolvedValue('failed');
    expect(await resumeStaleEventCancellationRuns(sweepCtx)).toBe(1);
    expect(existing.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'run-event-cancellation',
      { runId },
      expect.objectContaining({ jobId: `event-cancel-${runId}` }),
    );
    // Explicit resume (admin button) of a completed job queues work as well.
    existing.getState.mockResolvedValue('completed');
    expect(await enqueueEventCancellationRun(sweepCtx, runId)).toBe(true);
    expect(queue.add).toHaveBeenCalledTimes(2);
    // Mailings: same rule.
    const mailingFx = await makeEvent('Sweeper Mailing');
    await order([{ fx: mailingFx, seats: [mailingFx.seatIds[0]!] }], 'PAYPAL', { pay: true });
    const { mailingId } = await createEventMailing(ctx, {
      eventId: mailingFx.event.id,
      audience: 'PAID',
      subject: 'Hello',
      body: 'Text',
      userId,
    });
    await handle.db
      .update(eventMailings)
      .set({ heartbeatAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(eventMailings.id, mailingId));
    existing.getState.mockResolvedValue('active');
    expect(await resumeStaleEventMailings(sweepCtx)).toBe(0);
    expect(queue.getJob).toHaveBeenLastCalledWith(`mailing-${mailingId}`);
  });

  it('a mailing skips recipients with an unusable address and finishes', async () => {
    const fx = await makeEvent('Mailing Skip Show');
    const bad = await order([{ fx, seats: [fx.seatIds[0]!] }], 'PAYPAL', { pay: true });
    await handle.db.update(orders).set({ email: 'broken address' }).where(eq(orders.id, bad));
    const good = await order([{ fx, seats: [fx.seatIds[1]!] }], 'PAYPAL', { pay: true });
    const { mailingId, recipients } = await createEventMailing(ctx, {
      eventId: fx.event.id,
      audience: 'PAID',
      subject: 'Note',
      body: 'Text',
      userId,
    });
    expect(recipients).toBe(2);
    expect(await sendEventMailingChunk(ctx, mailingId, 10)).toEqual({ queued: 1, remaining: 0 });
    const [mailing] = await handle.db
      .select()
      .from(eventMailings)
      .where(eq(eventMailings.id, mailingId));
    expect(mailing!.status).toBe('COMPLETED');
    const claims = await handle.db
      .select()
      .from(eventMailingRecipients)
      .where(eq(eventMailingRecipients.mailingId, mailingId));
    expect(claims.length).toBe(2);
    expect(claims.find((c) => c.orderId === bad)!.messageId).toBeNull();
    expect(claims.find((c) => c.orderId === good)!.messageId).not.toBeNull();
  });

  it('web door: a repeated click (same clientScanId) records one scan and returns its outcome', async () => {
    const fx = await makeEvent('Door Show');
    const orderId = await order([{ fx, seats: [fx.seatIds[0]!] }], 'PAYPAL', { pay: true });
    const [ticket] = await handle.db.select().from(tickets).where(eq(tickets.orderId, orderId));
    const clientScanId = uuid();
    const scan = (id: string) =>
      webDoorScan(ctx, {
        userId,
        displayName: 'Manager',
        eventId: fx.event.id,
        ticketId: ticket!.id,
        action: 'CHECK_IN',
        clientScanId: id,
      });
    const first = await scan(clientScanId);
    const repeat = await scan(clientScanId);
    expect(first.color).toBe('GREEN');
    expect(repeat.color).toBe('GREEN');
    expect(repeat.result).toBe(first.result);
    const logs = await handle.db
      .select()
      .from(checkInLogs)
      .where(eq(checkInLogs.ticketId, ticket!.id));
    expect(logs.length).toBe(1);
    // A new click (new id) is a new scan: already inside.
    const second = await scan(uuid());
    expect(second.result).toBe('REJECTED_ALREADY_CHECKED_IN');
  });

  it('a manual payment reminder consumes the scheduled one (no second reminder from dunning)', async () => {
    const fx = await makeEvent('Reminder Show');
    const orderId = await order([{ fx, seats: [fx.seatIds[0]!] }], 'BANK_TRANSFER');
    await handle.db
      .update(orders)
      .set({ nextReminderAt: new Date(Date.now() + 60_000) })
      .where(eq(orders.id, orderId));
    expect(await sendPaymentReminderNow(ctx, { orderId, userId })).toBe('SENT');
    const [after] = await handle.db.select().from(orders).where(eq(orders.id, orderId));
    expect(after!.nextReminderAt).toBeNull();
    await runDunning(ctx, new Date(Date.now() + 120_000));
    expect((await mails(orderId, 'PAYMENT_REMINDER')).length).toBe(1);
  });

  it('order export pages by keyset (microsecond timestamps, rows added meanwhile do not shift pages)', async () => {
    const fx = await makeEvent('Export Show');
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(await order([{ fx, seats: [fx.seatIds[i]!] }], 'BANK_TRANSFER'));
    }
    // Same millisecond, different microseconds: a JS Date cursor would skip / repeat rows.
    for (const [i, id] of ids.entries()) {
      await handle.db
        .update(orders)
        .set({
          createdAt: sql`'2026-01-01 10:00:00.123'::timestamptz + ${`${i} microseconds`}::interval`,
        })
        .where(eq(orders.id, id));
    }
    const search = { eventId: fx.event.id };
    const seen: string[] = [];
    let after: OrderExportCursor | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await searchOrdersForExport(ctx, search, { after, limit: 1 });
      seen.push(...result.rows.map((r) => r.id));
      if (page === 0) {
        // A new order arriving during the export (newest) must not shift the next pages.
        ids.push(await order([{ fx, seats: [fx.seatIds[5]!] }], 'BANK_TRANSFER'));
      }
      if (!result.next) break;
      after = result.next;
    }
    expect(seen).toEqual([ids[2], ids[1], ids[0]]);
  });

  it('changes the order e-mail: new customer, new token, notice to the old address without order link', async () => {
    const fx = await makeEvent('Email Show');
    const orderId = await order([{ fx, seats: [fx.seatIds[0]!] }], 'PAYPAL', {
      pay: true,
      email: 'old@example.invalid',
    });
    const [before] = await handle.db.select().from(orders).where(eq(orders.id, orderId));
    await expect(
      changeOrderEmail(ctx, { orderId, newEmail: 'OLD@example.invalid', userId }),
    ).rejects.toMatchObject({ code: 'EMAIL_UNCHANGED' });
    await expect(
      changeOrderEmail(ctx, { orderId, newEmail: 'nope', userId }),
    ).rejects.toBeInstanceOf(DomainError);

    const result = await changeOrderEmail(ctx, {
      orderId,
      newEmail: 'new@example.invalid',
      userId,
    });
    expect(result.previousEmail).toBe('old@example.invalid');
    const [after] = await handle.db.select().from(orders).where(eq(orders.id, orderId));
    expect(after!.email).toBe('new@example.invalid');
    expect(after!.customerId).not.toBe(before!.customerId);
    expect(after!.tokenVersion).toBe(before!.tokenVersion + 1);
    // Name / address stay as invoiced.
    expect(after!.firstName).toBe(before!.firstName);

    const newMail = (await mails(orderId, 'ORDER_EMAIL_CHANGED'))[0]!;
    expect(newMail.toEmail).toBe('new@example.invalid');
    const oldMail = (
      await handle.db
        .select()
        .from(emailMessages)
        .where(eq(emailMessages.templateKey, 'ORDER_EMAIL_CHANGED_OLD'))
    ).find((m) => m.toEmail === 'old@example.invalid')!;
    expect(oldMail.orderId).toBeNull();
    const history = await handle.db
      .select()
      .from(orderHistory)
      .where(and(eq(orderHistory.orderId, orderId), eq(orderHistory.type, 'email_changed')));
    expect(history.length).toBe(1);
  });

  it('an order holding tickets of a cancelled event is not paid automatically and raises an alert', async () => {
    const a = await makeEvent('Cancelled Later');
    const b = await makeEvent('Still On');
    // Multi-event orders: the assistant leaves unpaid ones for a manual decision.
    const bankOrder = await order(
      [
        { fx: a, seats: [a.seatIds[0]!] },
        { fx: b, seats: [b.seatIds[0]!] },
      ],
      'BANK_TRANSFER',
    );
    const paypalOrder = await order(
      [
        { fx: a, seats: [a.seatIds[1]!] },
        { fx: b, seats: [b.seatIds[1]!] },
      ],
      'PAYPAL',
    );
    await changeEventStatus(ctx, { eventId: a.event.id, status: 'CANCELLED' });

    // PayPal: the payment is not even started (no PayPal call).
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await expect(startPayPalPayment(ctx, paypalOrder)).rejects.toMatchObject({
        code: 'ORDER_EVENT_CANCELLED',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }

    // Bank transfer with the exact reference and amount: review queue instead of auto-fulfilment.
    const [o] = await handle.db.select().from(orders).where(eq(orders.id, bankOrder));
    const [account] = await handle.db.select({ id: bankAccounts.id }).from(bankAccounts).limit(1);
    const [tx] = await handle.db
      .insert(bankTransactions)
      .values({
        bankAccountId: account!.id,
        fingerprint: `fp-${uuid()}`,
        bookingDate: new Date().toISOString().slice(0, 10),
        amount: o!.totalGross,
        currency: 'EUR',
        counterpartyName: 'Erika Example',
        remittanceInformation: o!.paymentReference,
      })
      .returning({ id: bankTransactions.id });
    const result = await matchBankTransaction(ctx, tx!.id);
    expect(result).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'ORDER_NOT_PAYABLE' });
    const [row] = await handle.db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, tx!.id));
    expect(row!.matchCandidates).toMatchObject([
      { orderId: bankOrder, reasons: expect.arrayContaining(['EVENT_CANCELLED']) },
    ]);
    expect((await handle.db.select().from(orders).where(eq(orders.id, bankOrder)))[0]!.status).toBe(
      'AWAITING_PAYMENT',
    );

    // Paid anyway (e.g. assigned by hand / capture race): an admin alert, the tickets mail does
    // not count the cancelled event's ticket.
    const alertSettings = await getSetting(ctx, 'alerts');
    const before = await collectFindings(ctx, {}, alertSettings, new Date());
    expect(before.findings.filter((f) => f.type === 'PAID_CANCELLED_EVENT')).toEqual([]);
    const paid = await recordPayment(ctx, {
      orderId: bankOrder,
      amount: o!.totalGross,
      currency: 'EUR',
      method: 'BANK_TRANSFER',
      actor: { type: 'SYSTEM' },
    });
    expect(paid.status).toBe('PAID');
    const after = await collectFindings(ctx, {}, alertSettings, new Date());
    expect(after.evaluated.has('PAID_CANCELLED_EVENT')).toBe(true);
    expect(after.findings.filter((f) => f.type === 'PAID_CANCELLED_EVENT')).toMatchObject([
      { details: { count: 1, orders: o!.orderNumber } },
    ]);
    // A cancellation run working on the event hides it (the run handles those orders itself).
    await handle.db
      .insert(eventCancellationRuns)
      .values({ eventId: a.event.id, status: 'RUNNING' });
    const during = await collectFindings(ctx, {}, alertSettings, new Date());
    expect(during.findings.filter((f) => f.type === 'PAID_CANCELLED_EVENT')).toEqual([]);
  });
});
