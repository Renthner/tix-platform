/**
 * GDPR export / anonymisation / retention against real PostgreSQL + Redis (throw-away database,
 * own Redis prefix). No object storage and a mocked job queue: nothing is rendered or written
 * to a shared bucket.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminUsers,
  bankAccounts,
  auditLogs,
  createDb,
  customers,
  emailMessages,
  events,
  invoices,
  loadRootEnv,
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
  webhookEvents,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { checkoutInputSchema, type CheckoutInput, type SeatMapDocumentInput } from '@tix/shared';
import { createSecretBox, hashPassword, parseKeyRing } from '@tix/shared/server';
import { eq, inArray, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DomainError,
  addSeats,
  adminCancelOrder,
  afterSeatMapSaved,
  anonymizeCustomer,
  anonymizedEmail,
  createCoreContext,
  ensureOrderTickets,
  enterShop,
  exportCustomerData,
  exportCustomerDataAudited,
  getCheckoutOptions,
  getEventById,
  getCustomerAdminView,
  issueInvoice,
  listCustomers,
  placeOrder,
  recordPayment,
  registerCustomer,
  removeCustomerLogin,
  retryEmailMessage,
  runPrivacyRetention,
  saveSeatMapDocument,
  saveSetting,
  unlockCustomerAccount,
  updateCustomerAsAdmin,
  type CoreContext,
  type EventRow,
  type JobQueues,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();
const ADMIN_PASSWORD = 'admin password 12345';

async function expectCode(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected ${code}`).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  return err as DomainError;
}

describe.skipIf(!adminUrl || !redisUrl)('customer GDPR (integration)', () => {
  const dbName = `tix_privacy_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let event: EventRow;
  let seatIds: string[] = [];
  let userId: string;
  let nextSeat = 0;
  const actor = () => ({ userId, ipAddress: null });
  const jobs = { add: vi.fn(async () => 'job'), close: async () => {} };

  const buyer = (email: string, name: string, total: number): CheckoutInput =>
    checkoutInputSchema.parse({
      method: 'BANK_TRANSFER',
      email,
      firstName: name,
      lastName: 'Example',
      phone: '+49 6134 123456',
      address: { street: 'Hauptstrasse 1', postalCode: '65462', city: 'Ginsheim', country: 'DE' },
      acceptTerms: true,
      expectedTotalGross: total,
      locale: 'en',
    });

  /** Places a bank-transfer order for one seat; optionally pays it (→ invoice + tickets). */
  async function order(email: string, name: string, pay: boolean) {
    const session = `k${uuid().slice(0, 8)}`;
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, [seatIds[nextSeat++]!]);
    const { quotes } = await getCheckoutOptions(ctx, session);
    const total = quotes.BANK_TRANSFER.totalGross;
    const placed = await placeOrder(ctx, {
      sessionId: session,
      input: buyer(email, name, total),
    });
    if (pay) {
      await recordPayment(ctx, {
        orderId: placed.orderId,
        amount: total,
        currency: 'EUR',
        method: 'BANK_TRANSFER',
        providerCaptureId: null,
        bankTransactionId: null,
        actor: { type: 'SYSTEM' },
      });
      await ensureOrderTickets(ctx, placed.orderId);
      expect(await issueInvoice(ctx, placed.orderId)).not.toBeNull();
    }
    return placed.orderId;
  }

  const customerOf = async (email: string) => {
    const [row] = await handle.db
      .select()
      .from(customers)
      .where(sql`lower(${customers.email}) = ${email}`);
    return row!;
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
      secrets: createSecretBox(parseKeyRing(`t1:${randomBytes(32).toString('base64')}`)),
      jobs: jobs as unknown as JobQueues,
    });

    const [user] = await handle.db
      .insert(adminUsers)
      .values({
        email: 'finance@example.invalid',
        displayName: 'Finance',
        roles: ['FINANCE'],
        passwordHash: await hashPassword(ADMIN_PASSWORD),
      })
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

  const emailA = 'anna.privacy@example.invalid';
  const emailB = 'bernd.privacy@example.invalid';
  let customerA: string;
  let customerB: string;
  let orderA: string;
  let orderB: string;
  let invoicesBefore: unknown;

  it('exports everything stored about a customer – without secrets', async () => {
    await registerCustomer(ctx, {
      firstName: 'Anna',
      lastName: 'Privacy',
      email: emailA,
      password: 'correct horse battery',
      locale: 'en',
    });
    orderA = await order(emailA, 'Anna', true);
    orderB = await order(emailB, 'Bernd', false);
    customerA = (await customerOf(emailA)).id;
    customerB = (await customerOf(emailB)).id;
    await handle.db
      .update(tickets)
      .set({ attendeeName: 'Anna Attendee' })
      .where(eq(tickets.orderId, orderA));
    const exported = await exportCustomerData(ctx, customerA);
    expect(exported.customer).toMatchObject({ email: emailA, firstName: 'Anna' });
    expect(exported.customer.account.exists).toBe(true);
    expect(exported.orders).toHaveLength(1);
    const o = exported.orders[0]!;
    expect(o.buyer).toMatchObject({ email: emailA, phone: '+49 6134 123456' });
    expect(o.items).toHaveLength(1);
    expect(o.tickets[0]).toMatchObject({ attendeeName: 'Anna Attendee', status: 'VALID' });
    expect(o.payments).toHaveLength(1);
    expect(o.invoices.length).toBeGreaterThan(0);
    // The registration e-mail is listed, its verification link is not.
    expect(exported.emails.some((m) => m.template === 'CUSTOMER_EMAIL_VERIFICATION')).toBe(true);
    const json = JSON.stringify(exported);
    expect(json).not.toContain('tix://');
    expect(json).not.toContain('token=');
    expect(json).not.toContain('$argon2');
    expect(json).not.toMatch(/passwordHash|qrPayload|tokenHash/);
    for (const mail of exported.emails) {
      expect(Object.keys(mail.variables ?? {})).not.toContain('verificationUrl');
    }

    const audited = await exportCustomerDataAudited(ctx, actor(), customerA);
    expect(audited.orders).toHaveLength(1);
    const [entry] = await handle.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'customer.gdpr_export'));
    expect(entry).toMatchObject({ entityType: 'customer', entityId: customerA });
    expect(JSON.stringify(entry!.changes)).not.toContain(emailA);
  });

  it('lists customers with order statistics and search', async () => {
    const all = await listCustomers(ctx, { q: 'privacy' });
    expect(all.total).toBe(2);
    const a = all.rows.find((r) => r.id === customerA)!;
    expect(a).toMatchObject({ orderCount: 1, hasAccount: true, emailVerified: false });
    expect(a.revenue).toBeGreaterThan(0);
    expect((await listCustomers(ctx, { q: 'bernd' })).rows.map((r) => r.id)).toEqual([customerB]);
    expect((await listCustomers(ctx, { q: '100%' })).total).toBe(0);
  });

  it('edits profiles, checks e-mail uniqueness and handles the account', async () => {
    await expectCode(
      updateCustomerAsAdmin(ctx, actor(), customerB, {
        firstName: 'Bernd',
        lastName: 'Example',
        email: emailA,
        address: null,
        locale: 'de',
      }),
      'EMAIL_TAKEN',
    );
    await updateCustomerAsAdmin(ctx, actor(), customerB, {
      firstName: 'Bernd',
      lastName: 'Changed',
      email: emailB,
      phone: ' 0123 ',
      company: null,
      address: { street: 'Weg 2', postalCode: '12345', city: 'Ort', country: 'DE' },
      locale: 'de',
    });
    const b = await getCustomerAdminView(ctx, customerB);
    expect(b!.customer).toMatchObject({ lastName: 'Changed', phone: '0123', locale: 'de' });
    const [audit] = await handle.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'customer.update'));
    expect(JSON.stringify(audit!.changes)).not.toContain('Changed');

    await handle.db
      .update(customers)
      .set({ failedLoginCount: 3, lockedUntil: new Date(Date.now() + 3_600_000) })
      .where(eq(customers.id, customerA));
    await unlockCustomerAccount(ctx, actor(), customerA);
    expect((await customerOf(emailA)).lockedUntil).toBeNull();
    await removeCustomerLogin(ctx, actor(), customerA);
    expect(await customerOf(emailA)).toMatchObject({
      passwordHash: null,
      accountCreatedAt: null,
      emailVerifiedAt: null,
    });
  });

  it('blocks anonymisation for open orders, future tickets and open refunds', async () => {
    await expectCode(
      anonymizeCustomer(ctx, actor(), customerA, { password: 'wrong' }),
      'WRONG_PASSWORD',
    );
    const futureErr = await expectCode(
      anonymizeCustomer(ctx, actor(), customerA, { password: ADMIN_PASSWORD }),
      'ANONYMIZATION_BLOCKED',
    );
    const blockersA = (futureErr.details as { blockers: { futureTickets: unknown[] } }).blockers;
    expect(blockersA.futureTickets).toHaveLength(1);
    const openErr = await expectCode(
      anonymizeCustomer(ctx, actor(), customerB, { password: ADMIN_PASSWORD }),
      'ANONYMIZATION_BLOCKED',
    );
    expect(
      (openErr.details as { blockers: { openOrders: unknown[] } }).blockers.openOrders,
    ).toHaveLength(1);
    // Nothing changed.
    expect((await customerOf(emailA)).anonymizedAt).toBeNull();
    expect((await customerOf(emailB)).anonymizedAt).toBeNull();

    // The event is over; an open manual refund still blocks.
    await handle.db
      .update(events)
      .set({ startsAt: new Date(Date.now() - 3 * 86_400_000), endsAt: null })
      .where(eq(events.id, event.id));
    const [refund] = await handle.db
      .insert(refunds)
      .values({
        orderId: orderA,
        method: 'BANK_TRANSFER',
        kind: 'MANUAL',
        status: 'PENDING',
        amount: 500,
        currency: 'EUR',
        payerIban: 'DE89370400440532013000',
        payerName: 'Anna Payer',
      })
      .returning();
    const refundErr = await expectCode(
      anonymizeCustomer(ctx, actor(), customerA, { password: ADMIN_PASSWORD }),
      'ANONYMIZATION_BLOCKED',
    );
    expect(
      (refundErr.details as { blockers: { openRefunds: unknown[] } }).blockers.openRefunds,
    ).toHaveLength(1);
    await handle.db.update(refunds).set({ status: 'SUCCEEDED' }).where(eq(refunds.id, refund!.id));
  });

  it('anonymises a customer, keeps invoices untouched and is idempotent', async () => {
    const [mailRow] = (
      await handle.db.execute(
        sql`SELECT count(*)::int AS "mailCount" FROM email_messages WHERE lower(to_email) = ${emailA}`,
      )
    ).rows as { mailCount: number }[];
    const mailCount = mailRow!.mailCount;
    expect(mailCount).toBeGreaterThan(0);
    await handle.db
      .update(payments)
      .set({ providerResponse: { id: 'X', payer: { email_address: emailA }, status: 'COMPLETED' } })
      .where(eq(payments.orderId, orderA));
    const hookPayload = (id: string, payerName: string) => ({
      id,
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAP-ANNA',
        status: 'COMPLETED',
        amount: { value: '33.00', currency_code: 'EUR' },
        payer: { name: { given_name: payerName }, email_address: emailA },
      },
    });
    await handle.db
      .update(payments)
      .set({ providerCaptureId: 'CAP-ANNA' })
      .where(eq(payments.orderId, orderA));
    await handle.db.insert(webhookEvents).values([
      {
        provider: 'paypal',
        externalId: 'WH-ANNA',
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
        payload: hookPayload('WH-ANNA', 'Anna'),
        signatureValid: true,
      },
      {
        provider: 'paypal',
        externalId: 'WH-OTHER',
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
        payload: {
          ...hookPayload('WH-OTHER', 'Other'),
          resource: { id: 'CAP-OTHER', payer: { email_address: 'o@example.invalid' } },
        },
        signatureValid: true,
      },
    ]);
    await handle.db.insert(orderHistory).values({
      orderId: orderA,
      type: 'note',
      actorType: 'ADMIN',
      data: { reason: 'Anna called us', amount: 3300, nested: { email: emailA, keep: 'x' } },
    });
    invoicesBefore = await handle.db.select().from(invoices).where(eq(invoices.orderId, orderA));
    expect((invoicesBefore as unknown[]).length).toBeGreaterThan(0);

    // Stored ticket files (per-ticket PDF / pass and the order-level PDF) must be deleted.
    const [orderRow] = await handle.db.select().from(orders).where(eq(orders.id, orderA));
    const orderPdfKey = `tickets/${orderRow!.createdAt.getUTCFullYear()}/${orderRow!.orderNumber}.pdf`;
    await handle.db
      .update(tickets)
      .set({ pdfObjectKey: orderPdfKey, pkpassObjectKey: 'passes/anna.pkpass' })
      .where(eq(tickets.orderId, orderA));
    const deletedKeys: string[] = [];
    ctx.storage = {
      delete: async (_bucket: string, key: string) => {
        deletedKeys.push(key);
      },
    } as never;

    const result = await anonymizeCustomer(ctx, actor(), customerA, { password: ADMIN_PASSWORD });
    expect(deletedKeys.sort()).toEqual([orderPdfKey, 'passes/anna.pkpass'].sort());
    ctx.storage = undefined;
    expect(result).toMatchObject({
      alreadyAnonymized: false,
      orders: 1,
      ordersRetained: 1,
      refunds: 1,
    });
    expect(result.emails).toBeGreaterThanOrEqual(mailCount);

    const c = await customerOf(anonymizedEmail(customerA));
    expect(c).toMatchObject({
      id: customerA,
      firstName: '',
      lastName: '',
      company: null,
      phone: null,
      address: null,
      marketingConsentAt: null,
      passwordHash: null,
    });
    expect(c.anonymizedAt).toBeInstanceOf(Date);

    const [o] = await handle.db.select().from(orders).where(eq(orders.id, orderA));
    // Invoice-bound order: contact data gone, billing data retained until the retention ends.
    expect(o).toMatchObject({
      email: anonymizedEmail(customerA),
      phone: null,
      ipAddress: null,
      firstName: 'Anna',
      lastName: 'Example',
    });
    expect(o!.billingAddress).not.toBeNull();
    expect(o!.anonymizedAt).toBeInstanceOf(Date);
    const year = new Date().getUTCFullYear();
    expect(o!.personalDataRetainedUntil!.toISOString()).toBe(`${year + 11}-01-01T00:00:00.000Z`);

    const t = await handle.db.select().from(tickets).where(eq(tickets.orderId, orderA));
    expect(t.every((x) => x.attendeeName === null)).toBe(true);
    const [r] = await handle.db.select().from(refunds).where(eq(refunds.orderId, orderA));
    expect(r).toMatchObject({ payerIban: null, payerName: null });
    const [p] = await handle.db.select().from(payments).where(eq(payments.orderId, orderA));
    expect(p!.providerResponse).toEqual({ id: 'X', status: 'COMPLETED' });

    const mails = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.toEmail, anonymizedEmail(customerA)));
    expect(mails).toHaveLength(result.emails);
    for (const m of mails) {
      expect(JSON.stringify(m)).not.toContain(emailA);
      expect(m.attachments).toMatchObject({ purgedAt: expect.any(String) });
      expect((m.attachments as { variables?: unknown }).variables ?? null).toBeNull();
    }
    expect(
      (
        await handle.db
          .select()
          .from(emailMessages)
          .where(sql`lower(to_email) = ${emailA}`)
      ).length,
    ).toBe(0);
    await expectCode(retryEmailMessage(ctx, mails[0]!.id), 'EMAIL_NOT_RETRYABLE');

    expect(result).toMatchObject({ webhooks: 1, history: 1 });
    const [hook] = await handle.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.externalId, 'WH-ANNA'));
    expect(hook!.eventType).toBe('PAYMENT.CAPTURE.COMPLETED');
    expect(JSON.stringify(hook!.payload)).not.toMatch(/Anna|anna\.privacy/);
    expect(hook!.payload).toMatchObject({
      id: 'WH-ANNA',
      resource: { id: 'CAP-ANNA', status: 'COMPLETED', amount: { value: '33.00' } },
    });
    const [other] = await handle.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.externalId, 'WH-OTHER'));
    expect(JSON.stringify(other!.payload)).toContain('o@example.invalid');
    const [hist] = await handle.db.select().from(orderHistory).where(eq(orderHistory.type, 'note'));
    expect(hist!.data).toEqual({ reason: null, amount: 3300, nested: { email: null, keep: 'x' } });

    // GoBD: invoices are untouched.
    expect(await handle.db.select().from(invoices).where(eq(invoices.orderId, orderA))).toEqual(
      invoicesBefore,
    );

    // Idempotent, and the audit entry holds no personal data.
    const again = await anonymizeCustomer(ctx, actor(), customerA, { password: ADMIN_PASSWORD });
    expect(again.alreadyAnonymized).toBe(true);
    const entries = await handle.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'customer.anonymize'));
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]!.changes)).not.toContain('Anna');
    await expectCode(
      updateCustomerAsAdmin(ctx, actor(), customerA, {
        firstName: 'x',
        lastName: 'y',
        email: 'x@example.invalid',
        address: null,
        locale: null,
      }),
      'CUSTOMER_ANONYMIZED',
    );
  });

  it('erases buyer data completely on orders without invoices', async () => {
    await adminCancelOrder(ctx, { orderId: orderB, notifyCustomer: false, userId });
    await handle.db
      .update(orders)
      .set({ customerNote: 'call me', internalNote: 'VIP?' })
      .where(eq(orders.id, orderB));
    const result = await anonymizeCustomer(ctx, actor(), customerB, { password: ADMIN_PASSWORD });
    expect(result).toMatchObject({ orders: 1, ordersRetained: 0 });
    const [o] = await handle.db.select().from(orders).where(eq(orders.id, orderB));
    expect(o).toMatchObject({
      email: anonymizedEmail(customerB),
      firstName: '',
      lastName: '',
      company: null,
      phone: null,
      billingAddress: null,
      customerNote: null,
      internalNote: null,
      personalDataRetainedUntil: null,
    });
    // Order numbers and amounts stay for the accounting records.
    expect(o!.orderNumber).toBeTruthy();
    expect(o!.totalGross).toBeGreaterThan(0);
    const items = await handle.db.select().from(orderItems).where(eq(orderItems.orderId, orderB));
    expect(items.length).toBeGreaterThan(0);
  });

  it('runs the retention job: e-mail purge and expired billing data', async () => {
    await saveSetting(ctx, 'privacy', { emailRetentionDays: 30, invoiceRetentionYears: 10 }, null);
    const stored = (variables: string | null) => ({
      v: 1,
      attachments: [],
      locale: 'en',
      eventId: null,
      customerId: null,
      variables,
    });
    const old = new Date(Date.now() - 60 * 86_400_000);
    const rows = await handle.db
      .insert(emailMessages)
      .values([
        {
          templateKey: 'ORDER_CONFIRMATION_BANK_TRANSFER',
          toEmail: 'x1@example.invalid',
          subject: 'Hello Xaver',
          status: 'SENT',
          attachments: stored('envelope'),
          createdAt: old,
        },
        {
          templateKey: 'ORDER_CONFIRMATION_BANK_TRANSFER',
          toEmail: 'x2@example.invalid',
          subject: 'Hello Yara',
          status: 'QUEUED',
          attachments: stored('envelope'),
          createdAt: old,
        },
        {
          templateKey: 'ORDER_CONFIRMATION_BANK_TRANSFER',
          toEmail: 'x3@example.invalid',
          subject: 'Fresh',
          status: 'SENT',
          attachments: stored('envelope'),
        },
      ])
      .returning({ id: emailMessages.id });
    const first = await runPrivacyRetention(ctx);
    expect(first.emailsPurged).toBe(1);
    const [purged, queued, fresh] = await Promise.all(
      rows.map(async (r) => {
        const [row] = await handle.db
          .select()
          .from(emailMessages)
          .where(eq(emailMessages.id, r.id));
        return row!;
      }),
    );
    expect((purged!.attachments as { variables: unknown }).variables ?? null).toBeNull();
    expect(purged!.subject).toBe('[ORDER_CONFIRMATION_BANK_TRANSFER]');
    expect((queued!.attachments as { variables: unknown }).variables).toBe('envelope');
    expect((fresh!.attachments as { variables: unknown }).variables).toBe('envelope');
    expect((await runPrivacyRetention(ctx)).emailsPurged).toBe(0);

    // Webhooks older than webhookRetentionDays lose their personal fields (the unrelated one).
    await saveSetting(
      ctx,
      'privacy',
      { emailRetentionDays: 30, invoiceRetentionYears: 10, webhookRetentionDays: 90 },
      null,
    );
    await handle.db
      .update(webhookEvents)
      .set({ receivedAt: new Date(Date.now() - 100 * 86_400_000) })
      .where(eq(webhookEvents.externalId, 'WH-OTHER'));
    expect((await runPrivacyRetention(ctx)).webhooksScrubbed).toBe(1);
    const [scrubbed] = await handle.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.externalId, 'WH-OTHER'));
    expect(JSON.stringify(scrubbed!.payload)).not.toContain('o@example.invalid');
    expect(scrubbed!.payload).toMatchObject({ id: 'WH-OTHER', resource: { id: 'CAP-OTHER' } });
    expect((await runPrivacyRetention(ctx)).webhooksScrubbed).toBe(0);

    // Retention of the anonymised customer's invoice-bound order: not yet over …
    expect((await runPrivacyRetention(ctx)).ordersErased).toBe(0);
    // … and over once the invoices are old enough (invoices are immutable: lift the trigger
    // in this throw-away database only).
    await handle.db.execute(sql`ALTER TABLE invoices DISABLE TRIGGER USER`);
    await handle.db
      .update(invoices)
      .set({ issuedAt: new Date(Date.now() - 12 * 365 * 86_400_000) })
      .where(inArray(invoices.orderId, [orderA]));
    await handle.db.execute(sql`ALTER TABLE invoices ENABLE TRIGGER USER`);
    await handle.db
      .update(orders)
      .set({ personalDataRetainedUntil: new Date(Date.now() - 86_400_000) })
      .where(eq(orders.id, orderA));
    expect((await runPrivacyRetention(ctx)).ordersErased).toBe(1);
    const [o] = await handle.db.select().from(orders).where(eq(orders.id, orderA));
    expect(o).toMatchObject({
      firstName: '',
      lastName: '',
      billingAddress: null,
      personalDataRetainedUntil: null,
    });
    const after = (await handle.db.select().from(invoices).where(eq(invoices.orderId, orderA))) as {
      buyer: unknown;
    }[];
    expect(JSON.stringify(after[0]!.buyer)).toBe(
      JSON.stringify((invoicesBefore as { buyer: unknown }[])[0]!.buyer),
    );
  });
});
