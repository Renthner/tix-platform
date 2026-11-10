/**
 * Reversal of bank-transaction allocations against real PostgreSQL + Redis (throw-away
 * database, own Redis prefix). The job queue is a mock: no PDF is rendered or written and no
 * object storage is touched.
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
  invoiceLines,
  invoices,
  loadRootEnv,
  orderHistory,
  orderItems,
  orders,
  payments,
  priceCategories,
  priceCategoryTicketTypes,
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
import { and, asc, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addSeats,
  afterSeatMapSaved,
  assignBankTransaction,
  backfillMissingTickets,
  cancelPaidOrder,
  createCoreContext,
  enterShop,
  findActiveInvoice,
  issueInvoice,
  getCheckoutOptions,
  getEventById,
  matchBankTransaction,
  placeOrder,
  processPaidOrder,
  recordPayment,
  rematchBankTransaction,
  reverseBankAllocation,
  saveSeatMapDocument,
  type CoreContext,
  type DomainError,
  type EventRow,
  type JobQueues,
  refundOverpayment,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)('bank allocation reversal (integration)', () => {
  const dbName = `tix_reversal_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let event: EventRow;
  let seatIds: string[] = [];
  let userId: string;
  let accountId: string;
  let seatCursor = 0;
  let txSeq = 0;
  const jobs = { add: vi.fn(async (..._args: unknown[]) => 'job'), close: async () => {} };

  const takenCode = async (seatId: string) =>
    (await ctx.seats.takenSeats(event.id))[seatId] ?? null;

  const buyer = (total: number): CheckoutInput =>
    checkoutInputSchema.parse({
      method: 'BANK_TRANSFER',
      email: 'buyer@example.invalid',
      firstName: 'Erika',
      lastName: 'Example',
      phone: '+49 6134 123456',
      address: { street: 'Hauptstrasse 1', postalCode: '65462', city: 'Ginsheim', country: 'DE' },
      acceptTerms: true,
      expectedTotalGross: total,
      locale: 'en',
    });

  /** Places a bank-transfer order for the next `count` unused seats (awaiting payment). */
  async function placeBankOrder(count = 2) {
    const seats = seatIds.slice(seatCursor, seatCursor + count);
    seatCursor += count;
    const session = `k${uuid().slice(0, 8)}`;
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, seats);
    const { quotes } = await getCheckoutOptions(ctx, session);
    const total = quotes.BANK_TRANSFER.totalGross;
    const placed = await placeOrder(ctx, { sessionId: session, input: buyer(total) });
    return { orderId: placed.orderId, total, seats };
  }

  /** A credit on the bank account (not yet matched). */
  async function insertCredit(amount: number, remittance: string) {
    txSeq += 1;
    const [row] = await handle.db
      .insert(bankTransactions)
      .values({
        bankAccountId: accountId,
        fingerprint: `fp-${txSeq}-${uuid()}`,
        bookingDate: new Date().toISOString().slice(0, 10),
        amount,
        currency: 'EUR',
        counterpartyName: 'Erika Example',
        counterpartyIban: 'DE02120300000000202051',
        remittanceInformation: remittance,
      })
      .returning({ id: bankTransactions.id });
    return row!.id;
  }

  /** Order paid by an auto-matched bank transfer + invoice/tickets (as the order-paid job does). */
  async function autoPaidOrder(count = 2) {
    const placed = await placeBankOrder(count);
    const order = await loadOrder(placed.orderId);
    const txId = await insertCredit(placed.total, `Ticket ${order.paymentReference}`);
    const result = await matchBankTransaction(ctx, txId);
    expect(result?.status).toBe('AUTO_MATCHED');
    await processPaidOrder(ctx, placed.orderId);
    return { ...placed, txId };
  }

  const loadOrder = async (orderId: string) =>
    (await handle.db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
  const loadItems = (orderId: string) =>
    handle.db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const loadTickets = (orderId: string) =>
    handle.db
      .select()
      .from(tickets)
      .where(eq(tickets.orderId, orderId))
      .orderBy(asc(tickets.issuedAt));
  const loadAllocations = (txId: string) =>
    handle.db
      .select()
      .from(bankTransactionAllocations)
      .where(eq(bankTransactionAllocations.bankTransactionId, txId));
  const loadTx = async (txId: string) =>
    (await handle.db.select().from(bankTransactions).where(eq(bankTransactions.id, txId)))[0]!;
  const loadInvoices = (orderId: string) =>
    handle.db
      .select()
      .from(invoices)
      .where(eq(invoices.orderId, orderId))
      .orderBy(asc(invoices.issuedAt), asc(invoices.invoiceNumber));
  const activeAllocation = async (txId: string) =>
    (await loadAllocations(txId)).find((a) => !a.reversedAt)!;
  const reverse = (allocationId: string, reason = 'Wrong order') =>
    reverseBankAllocation(ctx, { allocationId, userId, reason });
  const expectCode = async (promise: Promise<unknown>, code: string) => {
    const err = (await promise.then(
      () => null,
      (e: unknown) => e,
    )) as DomainError | null;
    expect(err?.code).toBe(code);
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
      seats: Array.from({ length: 40 }, (_, i) => ({
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
    await handle.db
      .insert(fees)
      .values([{ name: 'Service fee', scope: 'PER_TICKET', calculation: 'FIXED', value: 150 }]);
    const [account] = await handle.db
      .insert(bankAccounts)
      .values({
        name: 'Main',
        accountHolder: 'Example Theatre e.V.',
        iban: 'DE89370400440532013000',
        currency: 'EUR',
        isDefaultForBankTransfer: true,
      })
      .returning({ id: bankAccounts.id });
    accountId = account!.id;
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

  it('reverses a wrongly auto-matched payment: order awaits payment, tickets void, credit note, seats reserved, transaction in review', async () => {
    const a = await autoPaidOrder();
    const before = await loadOrder(a.orderId);
    expect(before.status).toBe('PAID');
    expect(await takenCode(a.seats[0]!)).toBe('S');
    const [invoice] = await loadInvoices(a.orderId);
    expect(invoice?.type).toBe('INVOICE');
    expect(await loadTickets(a.orderId)).toHaveLength(2);

    const allocation = await activeAllocation(a.txId);
    const result = await reverse(allocation.id, 'Paid for the other order');
    expect(result).toMatchObject({
      orderStatus: 'AWAITING_PAYMENT',
      reopened: true,
      ticketsVoided: 2,
    });
    expect(result.creditNote).not.toBeNull();

    const order = await loadOrder(a.orderId);
    expect(order).toMatchObject({ status: 'AWAITING_PAYMENT', amountPaid: 0, paidAt: null });
    expect(order.paymentReference).toBe(before.paymentReference);
    expect(order.paymentDueAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await loadItems(a.orderId)).every((i) => i.status === 'PENDING')).toBe(true);
    expect(
      (await loadTickets(a.orderId)).every((t) => t.status === 'CANCELLED' && t.voidedAt),
    ).toBe(true);
    // Seats stay held (reserved), not released.
    expect(await takenCode(a.seats[0]!)).toBe('R');
    expect(await takenCode(a.seats[1]!)).toBe('R');

    // Credit note negates the invoice completely (GoBD: both documents stay).
    const docs = await loadInvoices(a.orderId);
    expect(docs.map((d) => d.type)).toEqual(['INVOICE', 'CREDIT_NOTE']);
    const note = docs[1]!;
    expect(note.correctsInvoiceId).toBe(invoice!.id);
    expect(note.totalGross).toBe(-invoice!.totalGross);
    expect(note.totalNet).toBe(-invoice!.totalNet);
    expect(note.totalTax).toBe(-invoice!.totalTax);
    const lines = await handle.db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoice!.id));
    const noteLines = await handle.db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, note.id));
    expect(noteLines.reduce((s, l) => s + l.totalGross, 0)).toBe(
      -lines.reduce((s, l) => s + l.totalGross, 0),
    );
    expect(await findActiveInvoice(handle.db, a.orderId)).toBeNull();

    // Allocation kept for the audit trail, payment cancelled, transaction back in the queue.
    const reversed = (await loadAllocations(a.txId))[0]!;
    expect(reversed).toMatchObject({
      reversedByUserId: userId,
      reversalReason: 'Paid for the other order',
    });
    expect(reversed.reversedAt).not.toBeNull();
    const [payment] = await handle.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, a.orderId));
    expect(payment!.status).toBe('CANCELLED');
    const bankTx = await loadTx(a.txId);
    expect(bankTx.matchStatus).toBe('NEEDS_REVIEW');
    expect(bankTx.reviewReason).not.toBeNull();
    expect(bankTx.matchCandidates?.some((c) => c.orderId === a.orderId) ?? false).toBe(false);
    const [history] = await handle.db
      .select()
      .from(orderHistory)
      .where(
        and(eq(orderHistory.orderId, a.orderId), eq(orderHistory.type, 'bank_allocation_reversed')),
      );
    expect(history).toMatchObject({ fromStatus: 'PAID', toStatus: 'AWAITING_PAYMENT' });

    // A second reversal is rejected; a rematch never puts the money back automatically.
    await expectCode(reverse(allocation.id), 'ALLOCATION_ALREADY_REVERSED');
    const rematched = await rematchBankTransaction(ctx, a.txId);
    expect(rematched.status).toBe('NEEDS_REVIEW');
    expect((await loadOrder(a.orderId)).status).toBe('AWAITING_PAYMENT');
  });

  it('assigns the freed transfer to the right order, then pays the first order again: new invoice, new tickets, new job', async () => {
    const a = await autoPaidOrder();
    const [oldInvoice] = await loadInvoices(a.orderId);
    const oldTickets = await loadTickets(a.orderId);
    await reverse((await activeAllocation(a.txId)).id);

    const b = await placeBankOrder();
    expect(b.total).toBe(a.total);
    const assigned = await assignBankTransaction(ctx, {
      transactionId: a.txId,
      orderId: b.orderId,
      userId,
    });
    expect(assigned.payment).toBe('PAID');
    expect((await loadOrder(b.orderId)).status).toBe('PAID');
    expect((await loadTx(a.txId)).matchStatus).toBe('MANUALLY_MATCHED');
    expect(await takenCode(b.seats[0]!)).toBe('S');

    // The first order is paid again (another transfer).
    jobs.add.mockClear();
    const second = await insertCredit(a.total, 'Ticket again');
    const paid = await recordPayment(ctx, {
      orderId: a.orderId,
      amount: a.total,
      currency: 'EUR',
      method: 'BANK_TRANSFER',
      bankTransactionId: second,
      actor: { type: 'SYSTEM' },
    });
    expect(paid.status).toBe('PAID');
    expect(await takenCode(a.seats[0]!)).toBe('S');
    const jobIds = jobs.add.mock.calls.map((call) => (call[3] as { jobId: string }).jobId);
    expect(jobIds).toEqual([`order-paid-${a.orderId}-c1`]);

    const result = await processPaidOrder(ctx, a.orderId);
    expect(result.invoiceId).not.toBe(oldInvoice!.id);
    expect(result.messageId).not.toBeNull(); // the customer gets the new tickets
    const active = await findActiveInvoice(handle.db, a.orderId);
    expect(active?.id).toBe(result.invoiceId);
    expect((await loadInvoices(a.orderId)).map((d) => d.type)).toEqual([
      'INVOICE',
      'CREDIT_NOTE',
      'INVOICE',
    ]);
    const all = await loadTickets(a.orderId);
    const valid = all.filter((t) => t.status === 'VALID');
    expect(valid).toHaveLength(2);
    expect(all.filter((t) => t.status === 'CANCELLED')).toHaveLength(2);
    expect(
      valid.some((t) => oldTickets.some((o) => o.id === t.id || o.qrPayload === t.qrPayload)),
    ).toBe(false);
    // Repeating the job changes nothing (idempotent per paid cycle).
    expect((await processPaidOrder(ctx, a.orderId)).messageId).toBeNull();
    expect((await backfillMissingTickets(ctx)).failed).toBe(0);

    // A later cancellation credits the NEW invoice (the old fee credits are not counted again).
    const cancelled = await cancelPaidOrder(ctx, {
      orderId: a.orderId,
      refundFees: true,
      notify: false,
      userId,
    });
    expect(cancelled.orderStatus).toBe('REFUNDED');
    expect(cancelled.creditNote).not.toBeNull();
    const [, , fresh, finalNote] = await loadInvoices(a.orderId);
    expect(finalNote!.correctsInvoiceId).toBe(fresh!.id);
    expect(finalNote!.totalGross).toBe(-fresh!.totalGross);
  });

  it('lowers amountPaid for a partial payment of an awaiting order without touching items or invoices', async () => {
    const o = await placeBankOrder();
    const txId = await insertCredit(1000, 'partial');
    const assigned = await assignBankTransaction(ctx, {
      transactionId: txId,
      orderId: o.orderId,
      userId,
    });
    expect(assigned.payment).toBe('PARTIAL');
    expect((await loadOrder(o.orderId)).amountPaid).toBe(1000);

    const result = await reverse((await activeAllocation(txId)).id);
    expect(result).toMatchObject({
      orderStatus: 'AWAITING_PAYMENT',
      reopened: false,
      ticketsVoided: 0,
      creditNote: null,
    });
    const order = await loadOrder(o.orderId);
    expect(order).toMatchObject({ status: 'AWAITING_PAYMENT', amountPaid: 0 });
    expect((await loadItems(o.orderId)).every((i) => i.status === 'PENDING')).toBe(true);
    expect(await takenCode(o.seats[0]!)).toBe('R');
    expect((await loadTx(txId)).matchStatus).toBe('NEEDS_REVIEW');
  });

  it('keeps a PAID order paid when only an overpayment is reversed', async () => {
    const a = await autoPaidOrder();
    const extraTx = await insertCredit(500, 'extra');
    await assignBankTransaction(ctx, { transactionId: extraTx, orderId: a.orderId, userId });
    expect((await loadOrder(a.orderId)).amountPaid).toBe(a.total + 500);

    const result = await reverse((await activeAllocation(extraTx)).id);
    expect(result).toMatchObject({ orderStatus: 'PAID', reopened: false, amountPaid: a.total });
    expect((await loadTickets(a.orderId)).filter((t) => t.status === 'VALID')).toHaveLength(2);
    expect(await takenCode(a.seats[0]!)).toBe('S');
  });

  it('is blocked while an overpayment of the order was refunded (amounts would become inconsistent)', async () => {
    const a = await autoPaidOrder();
    const extraTx = await insertCredit(500, 'extra');
    await assignBankTransaction(ctx, { transactionId: extraTx, orderId: a.orderId, userId });
    const refund = await refundOverpayment(ctx, {
      orderId: a.orderId,
      userId,
      expectedAmount: 500,
    });
    expect(refund.amount).toBe(500);
    // The original payment is untouched by that refund, but reversing it must still be refused.
    await expectCode(reverse((await activeAllocation(a.txId)).id), 'REVERSAL_BLOCKED_REFUNDS');
    expect((await loadOrder(a.orderId)).status).toBe('PAID');
  });

  it('moves a passed due date forward so dunning does not cancel the order at once', async () => {
    const a = await autoPaidOrder();
    await handle.db
      .update(orders)
      .set({ paymentDueAt: new Date(Date.now() - 3 * 86_400_000) })
      .where(eq(orders.id, a.orderId));
    await reverse((await activeAllocation(a.txId)).id);
    const order = await loadOrder(a.orderId);
    expect(order.paymentDueAt!.getTime()).toBeGreaterThan(Date.now());
    if (order.autoCancelAt) {
      expect(order.autoCancelAt.getTime()).toBeGreaterThan(Date.now());
      expect(order.autoCancelAt.getTime()).toBeGreaterThanOrEqual(order.paymentDueAt!.getTime());
    }
    if (order.nextReminderAt) expect(order.nextReminderAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('is blocked by refunds, checked-in tickets and finished orders', async () => {
    // Refund on the payment (partial cancellation → PARTIALLY_REFUNDED).
    const r = await autoPaidOrder();
    const [first] = await loadItems(r.orderId);
    await cancelPaidOrder(ctx, {
      orderId: r.orderId,
      orderItemIds: [first!.id],
      refundFees: false,
      notify: false,
      userId,
    });
    await expectCode(reverse((await activeAllocation(r.txId)).id), 'REVERSAL_BLOCKED_REFUNDS');
    expect((await loadOrder(r.orderId)).status).toBe('PARTIALLY_REFUNDED');

    // Checked-in ticket.
    const c = await autoPaidOrder();
    const [ticket] = await loadTickets(c.orderId);
    await handle.db
      .update(tickets)
      .set({ checkInState: 'CHECKED_IN', firstCheckedInAt: new Date(), checkInCount: 1 })
      .where(eq(tickets.id, ticket!.id));
    await expectCode(reverse((await activeAllocation(c.txId)).id), 'REVERSAL_BLOCKED_CHECKED_IN');
    expect((await loadOrder(c.orderId)).status).toBe('PAID');
    expect((await loadAllocations(c.txId))[0]!.reversedAt).toBeNull();
    expect((await loadTx(c.txId)).matchStatus).toBe('AUTO_MATCHED');

    // Finished (cancelled) order.
    const x = await placeBankOrder();
    const xTx = await insertCredit(1000, 'partial');
    await assignBankTransaction(ctx, { transactionId: xTx, orderId: x.orderId, userId });
    await handle.db
      .update(orders)
      .set({ status: 'CANCELLED', cancelledAt: new Date() })
      .where(eq(orders.id, x.orderId));
    await expectCode(reverse((await activeAllocation(xTx)).id), 'REVERSAL_BLOCKED_STATE');

    // Missing reason / unknown allocation.
    await expectCode(reverse((await activeAllocation(c.txId)).id, '  '), 'REASON_REQUIRED');
    await expectCode(reverse(uuid()), 'ALLOCATION_NOT_FOUND');
  });

  it('keeps one invoice per order across partial and full refunds (credit notes do not supersede)', async () => {
    const a = await autoPaidOrder();
    const [first, second] = await loadItems(a.orderId);
    await cancelPaidOrder(ctx, {
      orderId: a.orderId,
      orderItemIds: [first!.id],
      refundFees: false,
      notify: false,
      userId,
    });
    const again = await issueInvoice(ctx, a.orderId);
    await cancelPaidOrder(ctx, {
      orderId: a.orderId,
      orderItemIds: [second!.id],
      refundFees: true,
      notify: false,
      userId,
    });
    const docs = await loadInvoices(a.orderId);
    expect(docs.filter((d) => d.type === 'INVOICE')).toHaveLength(1);
    expect(again?.invoiceId).toBe(docs[0]!.id);
    expect((await issueInvoice(ctx, a.orderId))?.invoiceId).toBe(docs[0]!.id);
    expect((await loadInvoices(a.orderId)).filter((d) => d.type === 'INVOICE')).toHaveLength(1);
  });

  it('ignores a stale order-paid job and fails the unsent confirmation of the undone payment', async () => {
    const a = await autoPaidOrder();
    const mails = () =>
      handle.db
        .select()
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.orderId, a.orderId),
            eq(emailMessages.templateKey, 'PAYMENT_RECEIVED_TICKETS'),
          ),
        );
    const [first] = await mails();
    expect(first?.status).toBe('QUEUED');
    await reverse((await activeAllocation(a.txId)).id);
    expect((await loadOrder(a.orderId)).paidCycle).toBe(1);
    const [failed] = await mails();
    expect(failed).toMatchObject({
      status: 'FAILED',
      lastError: 'superseded by allocation reversal',
    });

    // The stale job (cycle 0) of the undone payment does nothing.
    const stale = await processPaidOrder(ctx, a.orderId, 0);
    expect(stale.skipped).toBe('NOT_PAID');
    expect(await mails()).toHaveLength(1);

    // The next payment gets its own confirmation, stamped with the new cycle.
    const second = await insertCredit(a.total, 'again');
    await recordPayment(ctx, {
      orderId: a.orderId,
      amount: a.total,
      currency: 'EUR',
      method: 'BANK_TRANSFER',
      bankTransactionId: second,
      actor: { type: 'SYSTEM' },
    });
    expect((await processPaidOrder(ctx, a.orderId, 0)).skipped).toBe('NOT_PAID');
    const fresh = await processPaidOrder(ctx, a.orderId, 1);
    expect(fresh.messageId).not.toBeNull();
    expect((await mails()).map((m) => m.paidCycle).sort()).toEqual([0, 1]);
  });

  it('keeps an order settled with a written-off shortfall PAID when only an overpayment is reversed', async () => {
    const placed = await placeBankOrder();
    const main = await insertCredit(placed.total - 10, 'short');
    const paid = await recordPayment(ctx, {
      orderId: placed.orderId,
      amount: placed.total - 10,
      currency: 'EUR',
      method: 'BANK_TRANSFER',
      bankTransactionId: main,
      settleShortfallUpTo: 50,
      actor: { type: 'SYSTEM' },
    });
    expect(paid.status).toBe('PAID');
    // The auto path records the allocation; do it here the way matching does.
    const [payment] = await handle.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, placed.orderId));
    await handle.db.insert(bankTransactionAllocations).values({
      bankTransactionId: main,
      orderId: placed.orderId,
      paymentId: payment!.id,
      amount: placed.total - 10,
      method: 'AUTO',
    });
    const extra = await insertCredit(500, 'extra');
    await assignBankTransaction(ctx, { transactionId: extra, orderId: placed.orderId, userId });
    const result = await reverse((await activeAllocation(extra)).id);
    expect(result).toMatchObject({ orderStatus: 'PAID', reopened: false });
    // Reversing the payment that settled it reopens the order.
    const reopened = await reverse((await activeAllocation(main)).id);
    expect(reopened).toMatchObject({ orderStatus: 'AWAITING_PAYMENT', reopened: true });
  });

  it('recomputes deadlines when a partial payment is reversed so dunning cannot cancel at once', async () => {
    const o = await placeBankOrder();
    const txId = await insertCredit(1000, 'partial');
    await assignBankTransaction(ctx, { transactionId: txId, orderId: o.orderId, userId });
    const past = new Date(Date.now() - 3 * 86_400_000);
    await handle.db
      .update(orders)
      .set({ paymentDueAt: past, autoCancelAt: past, nextReminderAt: past })
      .where(eq(orders.id, o.orderId));
    await reverse((await activeAllocation(txId)).id);
    const order = await loadOrder(o.orderId);
    expect(order.paymentDueAt!.getTime()).toBeGreaterThan(Date.now());
    if (order.autoCancelAt) expect(order.autoCancelAt.getTime()).toBeGreaterThan(Date.now());
    if (order.nextReminderAt) expect(order.nextReminderAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses to reopen non-bank orders and orders of an event that has started', async () => {
    const p = await autoPaidOrder();
    await handle.db.update(orders).set({ paymentMethod: 'PAYPAL' }).where(eq(orders.id, p.orderId));
    await expectCode(reverse((await activeAllocation(p.txId)).id), 'REVERSAL_BLOCKED_PAYPAL_ORDER');
    expect((await loadOrder(p.orderId)).status).toBe('PAID');

    const e = await autoPaidOrder();
    const startsAt = event.startsAt;
    await handle.db
      .update(events)
      .set({ startsAt: new Date(Date.now() - 3_600_000) })
      .where(eq(events.id, event.id));
    try {
      await expectCode(
        reverse((await activeAllocation(e.txId)).id),
        'REVERSAL_BLOCKED_EVENT_STARTED',
      );
    } finally {
      await handle.db.update(events).set({ startsAt }).where(eq(events.id, event.id));
    }
    expect((await loadOrder(e.orderId)).status).toBe('PAID');
  });
});
