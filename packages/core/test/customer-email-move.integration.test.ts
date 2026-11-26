/**
 * Admin change of a customer's e-mail address with "also move the orders" (`updateCustomerAsAdmin`
 * + `moveOrders`), against real PostgreSQL + Redis (throw-away database). The job queue is a mock:
 * nothing is sent, the outbox rows (email_messages) are asserted and rendered instead.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminUsers,
  bankAccounts,
  createDb,
  customers,
  defaultEmailTemplates,
  emailMessages,
  emailTemplates,
  events,
  loadRootEnv,
  orderAdjustments,
  orderHistory,
  orders,
  payments,
  priceCategories,
  priceCategoryTicketTypes,
  seatMaps,
  taxRates,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { checkoutInputSchema, type SeatMapDocumentInput } from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addSeats,
  afterSeatMapSaved,
  createCoreContext,
  CUSTOMER_EMAIL_OBSOLETE_ERROR,
  isOrderRecipientOutdated,
  EMAIL_VARIABLES_CONTEXT,
  enterShop,
  getCheckoutOptions,
  getEventById,
  orderAccessToken,
  ORDER_EMAIL_OBSOLETE_ERROR,
  parseStoredEmailRequest,
  placeOrder,
  renderEmail,
  retryEmailMessage,
  saveSeatMapDocument,
  updateCustomerAsAdmin,
  verifyOrderAccessToken,
  type CoreContext,
  type EventRow,
  type JobQueues,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)(
  'customer e-mail change moving orders (integration)',
  () => {
    const dbName = `tix_custmove_${Date.now()}_${uuid().slice(0, 6)}`;
    const secrets = createSecretBox(parseKeyRing(generateKeyRingEntry()));
    let admin: pg.Client;
    let handle: DbHandle;
    let redis: Redis;
    let ctx: CoreContext;
    let userId: string;
    let event: EventRow;
    let seatIds: string[];
    let nextSeat = 0;
    const jobs = { add: vi.fn(async () => 'job'), close: async () => {} };

    /** Unpaid bank-transfer order (its confirmation mail stays QUEUED: the job queue is mocked). */
    async function bankOrder(email: string): Promise<string> {
      const session = `k${uuid().slice(0, 8)}`;
      await enterShop(ctx, event, session);
      await addSeats(ctx, session, event, [seatIds[nextSeat++]!]);
      const { quotes } = await getCheckoutOptions(ctx, session);
      const placed = await placeOrder(ctx, {
        sessionId: session,
        input: checkoutInputSchema.parse({
          method: 'BANK_TRANSFER',
          email,
          firstName: 'Erika',
          lastName: 'Example',
          phone: '+49 30 123456',
          address: { street: 'Hauptstrasse 1', postalCode: '10115', city: 'Berlin', country: 'DE' },
          acceptTerms: true,
          expectedTotalGross: quotes.BANK_TRANSFER.totalGross,
          locale: 'en',
        }),
      });
      return placed.orderId;
    }

    async function customerOf(email: string) {
      const [row] = await handle.db
        .select()
        .from(customers)
        .where(sql`lower(${customers.email}) = ${email.toLowerCase()}`);
      return row!;
    }

    /** The stored profile with a different e-mail (what the admin form submits). */
    async function profile(customerId: string, email: string) {
      const [c] = await handle.db.select().from(customers).where(eq(customers.id, customerId));
      return {
        firstName: c!.firstName,
        lastName: c!.lastName,
        email,
        company: c!.company,
        phone: c!.phone,
        address: c!.address,
        locale: (c!.locale as 'en' | 'de' | null) ?? null,
      };
    }

    const orderRows = async (ids: string[]) =>
      new Map(
        (await handle.db.select().from(orders).where(inArray(orders.id, ids))).map((o) => [
          o.id,
          o,
        ]),
      );
    const mailsOf = (key: 'CUSTOMER_EMAIL_CHANGED_ORDERS' | 'CUSTOMER_EMAIL_CHANGED_OLD') =>
      handle.db.select().from(emailMessages).where(eq(emailMessages.templateKey, key));
    const variablesOf = (row: { attachments: unknown }) => {
      const stored = parseStoredEmailRequest(row.attachments);
      return stored.variables
        ? secrets.decryptJson<Record<string, string | number | null>>(
            stored.variables,
            EMAIL_VARIABLES_CONTEXT,
          )
        : {};
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
        secrets,
        jobs: jobs as unknown as JobQueues,
      });
      await handle.db
        .insert(emailTemplates)
        .values(
          defaultEmailTemplates().filter(
            (t) =>
              t.key === 'CUSTOMER_EMAIL_CHANGED_ORDERS' || t.key === 'CUSTOMER_EMAIL_CHANGED_OLD',
          ),
        );
      const [user] = await handle.db
        .insert(adminUsers)
        .values({ email: 'finance@example.invalid', displayName: 'Finance', roles: ['FINANCE'] })
        .returning({ id: adminUsers.id });
      userId = user!.id;
      const [venue] = await handle.db
        .insert(venues)
        .values({ name: 'Hall', slug: `hall-${uuid().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
        .returning();
      const [tax] = await handle.db
        .insert(taxRates)
        .values({ name: `vat-${uuid().slice(0, 6)}`, rateBasisPoints: 1900 })
        .returning();
      await handle.db.insert(bankAccounts).values({
        name: 'Main',
        accountHolder: 'Example Theatre e.V.',
        iban: 'DE89370400440532013000',
        currency: 'EUR',
        isDefaultForBankTransfer: true,
      });
      const [map] = await handle.db
        .insert(seatMaps)
        .values({
          venueId: venue!.id,
          kind: 'EVENT',
          name: 'Show',
          canvasWidth: 1200,
          canvasHeight: 600,
        })
        .returning();
      const [ev] = await handle.db
        .insert(events)
        .values({
          venueId: venue!.id,
          seatMapId: map!.id,
          slug: `show-${uuid().slice(0, 8)}`,
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
        name: 'Show',
        canvasWidth: 1200,
        canvasHeight: 600,
        sections: [
          {
            id: sectionId,
            type: 'SEATED',
            name: 'Stalls',
            ticketLabel: 'Stalls',
            geometry: { type: 'rect', x: 0, y: 0, width: 1100, height: 100 },
          },
        ],
        rows: [
          {
            id: rowId,
            sectionId,
            label: 'A',
            sortOrder: 1,
            geometry: {
              curve: { type: 'straight', start: { x: 20, y: 20 }, end: { x: 1000, y: 20 } },
              seatSpacing: 30,
            },
          },
        ],
        seats: Array.from({ length: 30 }, (_, i) => ({
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
      event = await getEventById(ctx, ev!.id);
      seatIds = doc.seats!.map((s) => s.id!);
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

    it('moves only the current orders and sends one summary + one notice instead of per-order mails', async () => {
      const oldEmail = 'move-old@example.invalid';
      const [moveA, moveB, cancelled, test, anonymised] = [
        await bankOrder(oldEmail),
        await bankOrder(oldEmail),
        await bankOrder(oldEmail),
        await bankOrder(oldEmail),
        await bankOrder(oldEmail),
      ] as [string, string, string, string, string];
      await handle.db
        .update(orders)
        .set({ status: 'CANCELLED', cancelledAt: new Date() })
        .where(eq(orders.id, cancelled));
      await handle.db.update(orders).set({ isTest: true }).where(eq(orders.id, test));
      await handle.db
        .update(orders)
        .set({ anonymizedAt: new Date() })
        .where(eq(orders.id, anonymised));
      const customer = await customerOf(oldEmail);
      // An order of this customer left on an older address by an earlier per-order change.
      const older = await bankOrder(oldEmail);
      await handle.db
        .update(orders)
        .set({ email: 'older@example.invalid' })
        .where(eq(orders.id, older));
      const all = [moveA, moveB, cancelled, test, anonymised, older];
      const before = await orderRows(all);
      const oldToken = orderAccessToken(ctx, moveA, before.get(moveA)!.tokenVersion);
      expect(await verifyOrderAccessToken(ctx, oldToken)).toBe(moveA);

      const result = await updateCustomerAsAdmin(
        ctx,
        { userId },
        customer.id,
        await profile(customer.id, 'Move-New@example.invalid'),
        { moveOrders: true },
      );
      expect(result).toEqual({ movedOrders: 2 });

      const newEmail = 'move-new@example.invalid';
      expect((await customerOf(newEmail)).id).toBe(customer.id);
      const after = await orderRows(all);
      for (const id of [moveA, moveB]) {
        expect(after.get(id)!.email).toBe(newEmail);
        expect(after.get(id)!.customerId).toBe(customer.id);
        expect(after.get(id)!.tokenVersion).toBe(before.get(id)!.tokenVersion + 1);
      }
      for (const id of [cancelled, test, anonymised, older]) {
        expect(after.get(id)!.email).toBe(before.get(id)!.email);
        expect(after.get(id)!.tokenVersion).toBe(before.get(id)!.tokenVersion);
      }
      // Earlier links die, fresh ones work.
      expect(await verifyOrderAccessToken(ctx, oldToken)).toBeNull();
      expect(
        await verifyOrderAccessToken(
          ctx,
          orderAccessToken(ctx, moveA, after.get(moveA)!.tokenVersion),
        ),
      ).toBe(moveA);

      // History records the move per order.
      const history = await handle.db
        .select()
        .from(orderHistory)
        .where(and(inArray(orderHistory.orderId, all), eq(orderHistory.type, 'email_changed')));
      expect(history.map((h) => h.orderId).sort()).toEqual([moveA, moveB].sort());
      expect(history[0]!.data).toMatchObject({ from: oldEmail, to: newEmail, viaCustomer: true });

      // No per-order change mails at all.
      const perOrder = await handle.db
        .select({ id: emailMessages.id })
        .from(emailMessages)
        .where(
          inArray(emailMessages.templateKey, ['ORDER_EMAIL_CHANGED', 'ORDER_EMAIL_CHANGED_OLD']),
        );
      expect(perOrder).toHaveLength(0);

      // The queued bank-transfer confirmations to the old address are retired and re-created.
      const confirmations = await handle.db
        .select()
        .from(emailMessages)
        .where(
          and(
            inArray(emailMessages.orderId, [moveA, moveB]),
            eq(emailMessages.templateKey, 'ORDER_CONFIRMATION_BANK_TRANSFER'),
          ),
        );
      expect(
        confirmations
          .filter((m) => m.toEmail === oldEmail)
          .every((m) => m.status === 'FAILED' && m.lastError === ORDER_EMAIL_OBSOLETE_ERROR),
      ).toBe(true);
      expect(confirmations.filter((m) => m.status === 'QUEUED').map((m) => m.toEmail)).toEqual([
        newEmail,
        newEmail,
      ]);

      // Exactly one summary to the new address and one notice to the old one.
      const summaries = await mailsOf('CUSTOMER_EMAIL_CHANGED_ORDERS');
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.toEmail).toBe(newEmail);
      expect(summaries[0]!.orderId).toBeNull();
      const notices = await mailsOf('CUSTOMER_EMAIL_CHANGED_OLD');
      expect(notices).toHaveLength(1);
      expect(notices[0]!.toEmail).toBe(oldEmail);
      expect(notices[0]!.orderId).toBeNull();
      expect(JSON.stringify(variablesOf(notices[0]!))).not.toContain('move-new');

      // The summary lists exactly the moved orders with their CURRENT links.
      const summaryStored = parseStoredEmailRequest(summaries[0]!.attachments);
      const summary = await renderEmail(ctx, {
        key: 'CUSTOMER_EMAIL_CHANGED_ORDERS',
        to: summaries[0]!.toEmail,
        customerId: summaryStored.customerId,
        locale: summaryStored.locale,
        variables: variablesOf(summaries[0]!),
      });
      expect(summary.missing).toEqual([]);
      for (const id of [moveA, moveB]) {
        const o = after.get(id)!;
        expect(summary.html).toContain(o.orderNumber);
        expect(summary.text).toContain(orderAccessToken(ctx, id, o.tokenVersion));
      }
      expect(summary.text).not.toContain(oldToken);
      for (const id of [cancelled, test, anonymised, older]) {
        expect(summary.html).not.toContain(after.get(id)!.orderNumber);
      }
      expect(summary.text).toContain(oldEmail);

      // The notice to the old address: order numbers, but no links and never the new address –
      // although it carries the customer id (for a GDPR erasure).
      const noticeStored = parseStoredEmailRequest(notices[0]!.attachments);
      expect(noticeStored.customerId).toBe(customer.id);
      const notice = await renderEmail(ctx, {
        key: 'CUSTOMER_EMAIL_CHANGED_OLD',
        to: notices[0]!.toEmail,
        customerId: noticeStored.customerId,
        locale: noticeStored.locale,
        variables: variablesOf(notices[0]!),
      });
      expect(notice.missing).toEqual([]);
      expect(notice.text).toContain(after.get(moveA)!.orderNumber);
      expect(notice.text).toContain(after.get(moveB)!.orderNumber);
      for (const part of [notice.subject, notice.html, notice.text]) {
        expect(part.toLowerCase()).not.toContain('move-new');
        expect(part).not.toContain('/orders/');
      }
      // A template edited to use {{email}} still cannot reveal the new address.
      await handle.db
        .update(emailTemplates)
        .set({ bodyText: 'Mail: {{email}} {{fullName}}' })
        .where(eq(emailTemplates.key, 'CUSTOMER_EMAIL_CHANGED_OLD'));
      try {
        const edited = await renderEmail(ctx, {
          key: 'CUSTOMER_EMAIL_CHANGED_OLD',
          to: notices[0]!.toEmail,
          customerId: noticeStored.customerId,
          locale: noticeStored.locale,
          variables: variablesOf(notices[0]!),
        });
        expect(edited.text.toLowerCase()).not.toContain('move-new');
      } finally {
        const original = defaultEmailTemplates().filter(
          (t) => t.key === 'CUSTOMER_EMAIL_CHANGED_OLD',
        );
        for (const t of original) {
          await handle.db
            .update(emailTemplates)
            .set({ bodyText: t.bodyText })
            .where(and(eq(emailTemplates.key, t.key), eq(emailTemplates.locale, t.locale)));
        }
      }

      // An order changed again later drops out of the summary (its new link must not leak here).
      await handle.db
        .update(orders)
        .set({ email: 'someone-else@example.invalid' })
        .where(eq(orders.id, moveB));
      const again = await renderEmail(ctx, {
        key: 'CUSTOMER_EMAIL_CHANGED_ORDERS',
        to: summaries[0]!.toEmail,
        customerId: summaryStored.customerId,
        locale: summaryStored.locale,
        variables: variablesOf(summaries[0]!),
      });
      expect(again.html).toContain(after.get(moveA)!.orderNumber);
      expect(again.html).not.toContain(after.get(moveB)!.orderNumber);
    });

    it('keeps the old behaviour without the option', async () => {
      const orderId = await bankOrder('keep-old@example.invalid');
      const customer = await customerOf('keep-old@example.invalid');
      const before = (await orderRows([orderId])).get(orderId)!;
      const summariesBefore = (await mailsOf('CUSTOMER_EMAIL_CHANGED_ORDERS')).length;
      const noticesBefore = (await mailsOf('CUSTOMER_EMAIL_CHANGED_OLD')).length;

      const result = await updateCustomerAsAdmin(
        ctx,
        { userId },
        customer.id,
        await profile(customer.id, 'keep-new@example.invalid'),
      );
      expect(result).toEqual({ movedOrders: 0 });
      expect((await customerOf('keep-new@example.invalid')).id).toBe(customer.id);
      const after = (await orderRows([orderId])).get(orderId)!;
      expect(after.email).toBe('keep-old@example.invalid');
      expect(after.tokenVersion).toBe(before.tokenVersion);
      expect((await mailsOf('CUSTOMER_EMAIL_CHANGED_ORDERS')).length).toBe(summariesBefore);
      expect((await mailsOf('CUSTOMER_EMAIL_CHANGED_OLD')).length).toBe(noticesBefore);
    });

    it('does not move orders of events that are over (and then sends no mails)', async () => {
      const orderId = await bankOrder('past-old@example.invalid');
      const customer = await customerOf('past-old@example.invalid');
      const summariesBefore = (await mailsOf('CUSTOMER_EMAIL_CHANGED_ORDERS')).length;
      const startsAt = event.startsAt;
      await handle.db
        .update(events)
        .set({ startsAt: new Date(Date.now() - 86_400_000) })
        .where(eq(events.id, event.id));
      try {
        const result = await updateCustomerAsAdmin(
          ctx,
          { userId },
          customer.id,
          await profile(customer.id, 'past-new@example.invalid'),
          { moveOrders: true },
        );
        expect(result).toEqual({ movedOrders: 0 });
      } finally {
        await handle.db.update(events).set({ startsAt }).where(eq(events.id, event.id));
      }
      expect((await orderRows([orderId])).get(orderId)!.email).toBe('past-old@example.invalid');
      expect((await mailsOf('CUSTOMER_EMAIL_CHANGED_ORDERS')).length).toBe(summariesBefore);
    });

    it('rolls everything back when a step fails', async () => {
      const orderId = await bankOrder('rollback-old@example.invalid');
      const customer = await customerOf('rollback-old@example.invalid');
      const before = (await orderRows([orderId])).get(orderId)!;
      await handle.db.execute(sql`
      CREATE FUNCTION test_fail_notice() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.template_key = 'CUSTOMER_EMAIL_CHANGED_OLD' THEN
          RAISE EXCEPTION 'test failure';
        END IF;
        RETURN NEW;
      END $$`);
      await handle.db.execute(
        sql`CREATE TRIGGER test_fail_notice BEFORE INSERT ON email_messages
          FOR EACH ROW EXECUTE FUNCTION test_fail_notice()`,
      );
      try {
        await expect(
          updateCustomerAsAdmin(
            ctx,
            { userId },
            customer.id,
            await profile(customer.id, 'rollback-new@example.invalid'),
            { moveOrders: true },
          ),
        ).rejects.toThrow();
      } finally {
        await handle.db.execute(sql`DROP TRIGGER test_fail_notice ON email_messages`);
        await handle.db.execute(sql`DROP FUNCTION test_fail_notice()`);
      }
      expect((await customerOf('rollback-old@example.invalid')).id).toBe(customer.id);
      const after = (await orderRows([orderId])).get(orderId)!;
      expect(after.email).toBe('rollback-old@example.invalid');
      expect(after.tokenVersion).toBe(before.tokenVersion);
      const confirmations = await handle.db
        .select()
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.orderId, orderId),
            eq(emailMessages.templateKey, 'ORDER_CONFIRMATION_BANK_TRANSFER'),
          ),
        );
      expect(confirmations.map((m) => [m.toEmail, m.status])).toEqual([
        ['rollback-old@example.invalid', 'QUEUED'],
      ]);
      const history = await handle.db
        .select()
        .from(orderHistory)
        .where(and(eq(orderHistory.orderId, orderId), eq(orderHistory.type, 'email_changed')));
      expect(history).toHaveLength(0);
    });

    it('never shows a later address in a queued summary (A → B → C before delivery)', async () => {
      const a = 'chain-a@example.invalid';
      const b = 'chain-b@example.invalid';
      const c = 'chain-c@example.invalid';
      const orderId = await bankOrder(a);
      const customer = await customerOf(a);
      await updateCustomerAsAdmin(ctx, { userId }, customer.id, await profile(customer.id, b), {
        moveOrders: true,
      });
      const [summaryB] = (await mailsOf('CUSTOMER_EMAIL_CHANGED_ORDERS')).filter(
        (m) => m.toEmail === b,
      );
      expect(summaryB!.status).toBe('QUEUED');

      // Typo corrected before B's summary went out.
      const result = await updateCustomerAsAdmin(
        ctx,
        { userId },
        customer.id,
        await profile(customer.id, c),
        { moveOrders: true },
      );
      expect(result).toEqual({ movedOrders: 1 });
      const [order] = await handle.db.select().from(orders).where(eq(orders.id, orderId));
      expect(order!.email).toBe(c);

      // B's summary is retired and can neither be delivered nor retried …
      const [retired] = await handle.db
        .select()
        .from(emailMessages)
        .where(eq(emailMessages.id, summaryB!.id));
      expect(retired!.status).toBe('FAILED');
      expect(retired!.lastError).toBe(CUSTOMER_EMAIL_OBSOLETE_ERROR);
      expect(await isOrderRecipientOutdated(handle.db, retired!)).toBe(true);
      await expect(retryEmailMessage(ctx, summaryB!.id)).rejects.toMatchObject({
        code: 'EMAIL_RECIPIENT_OUTDATED',
      });
      // … and even rendered it shows the address of its own change, never C (stored variables
      // win over the customer row).
      const stored = parseStoredEmailRequest(retired!.attachments);
      const rendered = await renderEmail(ctx, {
        key: 'CUSTOMER_EMAIL_CHANGED_ORDERS',
        to: retired!.toEmail,
        customerId: stored.customerId,
        locale: stored.locale,
        variables: variablesOf(retired!),
      });
      expect(rendered.text).toContain(b);
      expect(rendered.text).not.toContain(c);
      // The order now belongs to C: it is no longer listed in B's mail.
      expect(rendered.text).not.toContain(order!.orderNumber);

      // C's summary is current.
      const [summaryC] = (await mailsOf('CUSTOMER_EMAIL_CHANGED_ORDERS')).filter(
        (m) => m.toEmail === c,
      );
      expect(summaryC!.status).toBe('QUEUED');
      expect(await isOrderRecipientOutdated(handle.db, summaryC!)).toBe(false);
      expect(variablesOf(summaryC!)).toMatchObject({ email: c, previousEmail: b });
    });

    it('does not move an order whose additional payment is being paid via PayPal', async () => {
      const email = 'paypal-adj-old@example.invalid';
      const busy = await bankOrder(email);
      const idle = await bankOrder(email);
      const customer = await customerOf(email);
      for (const id of [busy, idle]) {
        await handle.db
          .update(orders)
          .set({ status: 'PAID', paidAt: new Date(), amountPaid: sql`${orders.totalGross}` })
          .where(eq(orders.id, id));
      }
      const [adjustment] = await handle.db
        .insert(orderAdjustments)
        .values({
          orderId: busy,
          status: 'CONFIRMED',
          amount: 500,
          currency: 'EUR',
          paymentReference: 'TIX-2026-987654-3',
          items: [],
        })
        .returning();
      await handle.db.insert(payments).values({
        orderId: busy,
        adjustmentId: adjustment!.id,
        method: 'PAYPAL',
        status: 'APPROVED',
        amount: 500,
        currency: 'EUR',
        providerOrderId: `PP-${uuid().slice(0, 8)}`,
      });

      const result = await updateCustomerAsAdmin(
        ctx,
        { userId },
        customer.id,
        await profile(customer.id, 'paypal-adj-new@example.invalid'),
        { moveOrders: true },
      );
      expect(result).toEqual({ movedOrders: 1 });
      const rows = await orderRows([busy, idle]);
      expect(rows.get(busy)!.email).toBe(email);
      expect(rows.get(busy)!.tokenVersion).toBe(0);
      expect(rows.get(idle)!.email).toBe('paypal-adj-new@example.invalid');
    });
  },
);
