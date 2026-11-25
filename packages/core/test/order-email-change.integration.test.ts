/**
 * Admin change of the buyer e-mail (`changeOrderEmail`) and the outbox around it, against real
 * PostgreSQL + Redis (throw-away database). The job queue is a mock: nothing is sent, the outbox
 * rows (email_messages) are asserted instead.
 *
 * Mails still waiting for the OLD address must never go out after the change: they would render
 * the order link with the NEW token version to the old recipient.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminUsers,
  bankAccounts,
  createDb,
  emailMessages,
  events,
  loadRootEnv,
  orders,
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
import { and, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addSeats,
  afterSeatMapSaved,
  changeOrderEmail,
  createCoreContext,
  createEmailMessage,
  deliverEmailMessage,
  EMAIL_VARIABLES_CONTEXT,
  enterShop,
  getCheckoutOptions,
  getEventById,
  isOrderRecipientOutdated,
  ORDER_EMAIL_OBSOLETE_ERROR,
  parseStoredEmailRequest,
  placeOrder,
  retryEmailMessage,
  saveSeatMapDocument,
  type CoreContext,
  type EventRow,
  type JobQueues,
} from '../src';
import { hasPaymentMailForCycle } from '../src/orders/paid-cycle';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)('order e-mail change (integration)', () => {
  const dbName = `tix_emailchange_${Date.now()}_${uuid().slice(0, 6)}`;
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

  const message = async (id: string) =>
    (await handle.db.select().from(emailMessages).where(eq(emailMessages.id, id)))[0]!;

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
        canvasWidth: 800,
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
      seats: Array.from({ length: 10 }, (_, i) => ({
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

  it('retires queued/failed mails to the old address; retry and delivery refuse them', async () => {
    const orderId = await bankOrder('old@example.invalid');
    const [confirmation] = await handle.db
      .select()
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.orderId, orderId),
          eq(emailMessages.templateKey, 'ORDER_CONFIRMATION_BANK_TRANSFER'),
        ),
      );
    expect(confirmation!.status).toBe('QUEUED');
    expect(confirmation!.toEmail).toBe('old@example.invalid');
    // A message that had failed before the change (would otherwise be retryable by an admin).
    const failedId = await createEmailMessage(ctx, handle.db, {
      key: 'ORDER_MESSAGE',
      orderId,
      variables: { messageSubject: 'Hi', messageBody: 'Text' },
    });
    await handle.db
      .update(emailMessages)
      .set({ status: 'FAILED', lastError: 'smtp down' })
      .where(eq(emailMessages.id, failedId));

    await changeOrderEmail(ctx, { orderId, newEmail: 'New@example.invalid', userId });

    for (const id of [confirmation!.id, failedId]) {
      const row = await message(id);
      expect(row.status).toBe('FAILED');
      expect(row.lastError).toBe(ORDER_EMAIL_OBSOLETE_ERROR);
    }
    await expect(retryEmailMessage(ctx, failedId)).rejects.toMatchObject({
      code: 'EMAIL_RECIPIENT_OUTDATED',
    });
    expect((await message(failedId)).status).toBe('FAILED');

    // The order still awaits the transfer: its confirmation is created again for the new address
    // (same template); the free-text message is not.
    const confirmations = await handle.db
      .select()
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.orderId, orderId),
          eq(emailMessages.templateKey, 'ORDER_CONFIRMATION_BANK_TRANSFER'),
          eq(emailMessages.status, 'QUEUED'),
        ),
      );
    expect(confirmations.map((m) => m.toEmail)).toEqual(['New@example.invalid']);
    const messages = await handle.db
      .select()
      .from(emailMessages)
      .where(
        and(eq(emailMessages.orderId, orderId), eq(emailMessages.templateKey, 'ORDER_MESSAGE')),
      );
    expect(messages).toHaveLength(1);

    // The two change mails are queued and not retired.
    const [toNew] = await handle.db
      .select()
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.orderId, orderId),
          eq(emailMessages.templateKey, 'ORDER_EMAIL_CHANGED'),
        ),
      );
    expect(toNew!.status).toBe('QUEUED');
    expect(toNew!.toEmail).toBe('New@example.invalid');
    const toOld = (
      await handle.db
        .select()
        .from(emailMessages)
        .where(eq(emailMessages.templateKey, 'ORDER_EMAIL_CHANGED_OLD'))
    ).find((m) => m.toEmail === 'old@example.invalid')!;
    expect(toOld.status).toBe('QUEUED');
    // GDPR: the notice to the old address does not carry the new address.
    const stored = parseStoredEmailRequest(toOld.attachments);
    const variables = secrets.decryptJson<Record<string, unknown>>(
      stored.variables!,
      EMAIL_VARIABLES_CONTEXT,
    );
    expect(variables).not.toHaveProperty('newEmail');
    expect(JSON.stringify(variables)).not.toContain('New@example.invalid');
    expect(await isOrderRecipientOutdated(handle.db, { ...toOld, orderId })).toBe(false);

    // A mail to the old address queued around the change (e.g. by a job that read the order
    // before it) is retired at delivery, before anything is rendered or sent.
    const lateId = await createEmailMessage(ctx, handle.db, {
      key: 'PAYMENT_REMINDER',
      orderId,
      to: 'old@example.invalid',
    });
    await expect(deliverEmailMessage(ctx, lateId)).resolves.toEqual({ status: 'OBSOLETE' });
    const late = await message(lateId);
    expect(late.status).toBe('FAILED');
    expect(late.lastError).toBe(ORDER_EMAIL_OBSOLETE_ERROR);
    // Mails to the current address (case-insensitive) are not affected.
    expect(
      await isOrderRecipientOutdated(handle.db, {
        orderId,
        templateKey: 'PAYMENT_REMINDER',
        toEmail: 'new@EXAMPLE.invalid',
      }),
    ).toBe(false);
  });

  it('re-creates the bounced payment confirmation of the current paid cycle for the new address', async () => {
    const orderId = await bankOrder('paid-old@example.invalid');
    await handle.db
      .update(orders)
      .set({ status: 'PAID', paidAt: new Date(), amountPaid: sql`${orders.totalGross}` })
      .where(eq(orders.id, orderId));
    // The confirmation of the transfer was delivered; the tickets mail bounced at the old address.
    await handle.db
      .update(emailMessages)
      .set({ status: 'SENT', sentAt: new Date() })
      .where(eq(emailMessages.orderId, orderId));
    const ticketsId = await createEmailMessage(ctx, handle.db, {
      key: 'PAYMENT_RECEIVED_TICKETS',
      orderId,
      attachments: [{ type: 'tickets', orderId }],
      variables: { extra: 'kept' },
    });
    await handle.db
      .update(emailMessages)
      .set({ status: 'FAILED', lastError: '550 mailbox unavailable', paidCycle: 0 })
      .where(eq(emailMessages.id, ticketsId));
    expect(await hasPaymentMailForCycle(handle.db, orderId, 0)).toBe(true);

    await changeOrderEmail(ctx, { orderId, newEmail: 'paid-new@example.invalid', userId });

    const old = await message(ticketsId);
    expect(old.status).toBe('FAILED');
    expect(old.lastError).toBe(ORDER_EMAIL_OBSOLETE_ERROR);
    const rows = await handle.db
      .select()
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.orderId, orderId),
          eq(emailMessages.templateKey, 'PAYMENT_RECEIVED_TICKETS'),
        ),
      );
    const fresh = rows.filter((r) => r.id !== ticketsId);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.status).toBe('QUEUED');
    expect(fresh[0]!.toEmail).toBe('paid-new@example.invalid');
    expect(fresh[0]!.paidCycle).toBe(0);
    const stored = parseStoredEmailRequest(fresh[0]!.attachments);
    expect(stored.attachments).toEqual([{ type: 'tickets', orderId }]);
    expect(
      secrets.decryptJson<Record<string, unknown>>(stored.variables!, EMAIL_VARIABLES_CONTEXT),
    ).toMatchObject({ extra: 'kept' });
    // The re-created mail satisfies the cycle (no second confirmation from a late order-paid job);
    // the retired one alone would not.
    expect(await hasPaymentMailForCycle(handle.db, orderId, 0)).toBe(true);
    await handle.db.delete(emailMessages).where(eq(emailMessages.id, fresh[0]!.id));
    expect(await hasPaymentMailForCycle(handle.db, orderId, 0)).toBe(false);
    // The already delivered bank-transfer confirmation is not sent again.
    const confirmations = await handle.db
      .select()
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.orderId, orderId),
          eq(emailMessages.templateKey, 'ORDER_CONFIRMATION_BANK_TRANSFER'),
        ),
      );
    expect(confirmations).toHaveLength(1);
  });

  it('refuses orders whose contact data were erased', async () => {
    const orderId = await bankOrder('erased@example.invalid');
    await handle.db.update(orders).set({ anonymizedAt: new Date() }).where(eq(orders.id, orderId));
    await expect(
      changeOrderEmail(ctx, { orderId, newEmail: 'someone@example.invalid', userId }),
    ).rejects.toMatchObject({ code: 'ORDER_ANONYMIZED' });
    const [order] = await handle.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.email).toBe('erased@example.invalid');
  });
});
