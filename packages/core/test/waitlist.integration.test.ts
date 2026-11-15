/**
 * Waiting list against real PostgreSQL + Redis (throw-away database, own Redis prefix): double
 * opt-in, notification once per availability wave after an order is cancelled, privacy erasure
 * and retention. The job queue is a mock.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  bankAccounts,
  createDb,
  emailMessages,
  events,
  loadRootEnv,
  priceCategories,
  priceCategoryTicketTypes,
  seatMaps,
  taxRates,
  ticketTypes,
  venues,
  waitlistEntries,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { checkoutInputSchema, type SeatMapDocumentInput } from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing, signToken } from '@tix/shared/server';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addSeats,
  afterSeatMapSaved,
  cancelOrder,
  confirmWaitlistEntry,
  createCoreContext,
  enterShop,
  evaluateWaitlistEvent,
  getEventById,
  getWaitlistOffer,
  joinWaitlist,
  placeOrder,
  purgeWaitlist,
  saveSeatMapDocument,
  unsubscribeWaitlistEntry,
  waitlistUnsubscribeToken,
  eraseWaitlistForEmails,
  type CoreContext,
  type EventRow,
  type JobQueues,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)('waiting list (integration)', () => {
  const dbName = `tix_waitlist_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let event: EventRow;
  let categoryId: string;
  let seatIds: string[] = [];
  const jobs = { add: vi.fn(async () => 'job'), close: async () => {} };

  const waitlistMails = async (key: string) =>
    (await handle.db.select().from(emailMessages)).filter((m) => m.templateKey === key);
  const confirmTokenFor = (id: string) =>
    signToken('waitlist-confirm', { eid: id }, 3600, ctx.sessionSecret);

  async function sellEverything() {
    const session = `k${uuid().slice(0, 8)}`;
    await enterShop(ctx, event, session);
    await addSeats(ctx, session, event, seatIds);
    const { getCheckoutOptions } = await import('../src');
    const { quotes } = await getCheckoutOptions(ctx, session);
    const placed = await placeOrder(ctx, {
      sessionId: session,
      input: checkoutInputSchema.parse({
        method: 'BANK_TRANSFER',
        email: 'buyer@example.invalid',
        firstName: 'Erika',
        lastName: 'Example',
        phone: '+49 6134 123456',
        address: { street: 'Hauptstrasse 1', postalCode: '65462', city: 'Ginsheim', country: 'DE' },
        acceptTerms: true,
        expectedTotalGross: quotes.BANK_TRANSFER.totalGross,
        locale: 'en',
      }),
    });
    return placed.orderId;
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
      appUrl: 'https://shop.example.org',
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
    categoryId = category!.id;
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
            curve: { type: 'straight', start: { x: 20, y: 20 }, end: { x: 100, y: 20 } },
            seatSpacing: 30,
          },
        },
      ],
      seats: Array.from({ length: 3 }, (_, i) => ({
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

  it('offers nothing while tickets are available, then opt-in, then notifies once after a cancellation', async () => {
    const names = new Map([[categoryId, 'Cat 1']]);
    expect(await getWaitlistOffer(ctx, event, names)).toBeNull();
    const orderId = await sellEverything();
    const offer = await getWaitlistOffer(ctx, event, names);
    expect(offer?.soldOut).toBe(true);

    // Opt-in: not confirmed → not notified; a second request does not duplicate the entry.
    expect(
      await joinWaitlist(ctx, event, { email: 'Fan@Example.invalid', quantity: 2, locale: 'de' }),
    ).toEqual({ status: 'CONFIRMATION_SENT' });
    await joinWaitlist(ctx, event, { email: 'fan@example.invalid', quantity: 2 });
    const entries = await handle.db.select().from(waitlistEntries);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.confirmedAt).toBeNull();
    expect(await waitlistMails('WAITLIST_CONFIRM')).toHaveLength(2);
    await expect(confirmWaitlistEntry(ctx, 'garbage')).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
    expect(await evaluateWaitlistEvent(ctx, event)).toMatchObject({ notified: 0 });

    await confirmWaitlistEntry(ctx, confirmTokenFor(entries[0]!.id));
    // Still sold out: nothing to notify.
    expect(await evaluateWaitlistEvent(ctx, event)).toMatchObject({ notified: 0 });

    // Order cancelled → seats free again → exactly one notification, however often we look.
    expect(
      await cancelOrder(ctx, { orderId, status: 'CANCELLED', actor: { type: 'SYSTEM' } }),
    ).toBe(true);
    expect(await evaluateWaitlistEvent(ctx, event)).toMatchObject({ notified: 1 });
    expect(await evaluateWaitlistEvent(ctx, event)).toMatchObject({ notified: 0 });
    const sent = await waitlistMails('WAITLIST_AVAILABLE');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.toEmail).toBe('fan@example.invalid');

    // Sold out again → re-armed; the next wave notifies again (pause set to 0 hours by force).
    await sellEverything();
    expect(await evaluateWaitlistEvent(ctx, event)).toMatchObject({ rearmed: 1, notified: 0 });
    expect(await joinWaitlist(ctx, event, { email: 'fan@example.invalid', quantity: 1 })).toEqual({
      status: 'ALREADY_ON_LIST',
    });
  });

  it('unsubscribe removes the entry; erasure and retention delete entries', async () => {
    await handle.db.delete(waitlistEntries);
    await handle.db.insert(waitlistEntries).values([
      {
        eventId: event.id,
        email: 'a@example.invalid',
        locale: 'en',
        quantity: 1,
        confirmedAt: new Date(),
      },
      {
        eventId: event.id,
        email: 'b@example.invalid',
        locale: 'en',
        quantity: 1,
        confirmedAt: new Date(),
      },
    ]);
    const [a] = await handle.db
      .select()
      .from(waitlistEntries)
      .where(eq(waitlistEntries.email, 'a@example.invalid'));
    await unsubscribeWaitlistEntry(ctx, waitlistUnsubscribeToken(ctx, a!.id));
    await unsubscribeWaitlistEntry(ctx, waitlistUnsubscribeToken(ctx, a!.id));
    expect(await handle.db.select().from(waitlistEntries)).toHaveLength(1);
    await expect(unsubscribeWaitlistEntry(ctx, 'bad.token')).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });

    expect(await eraseWaitlistForEmails(handle.db, ['b@example.invalid'])).toBe(1);
    expect(await handle.db.select().from(waitlistEntries)).toHaveLength(0);

    await handle.db
      .insert(waitlistEntries)
      .values({ eventId: event.id, email: 'c@example.invalid', locale: 'en', quantity: 1 });
    expect(await purgeWaitlist(ctx)).toBe(0);
    await handle.db
      .update(events)
      .set({ startsAt: new Date(Date.now() - 1000), endsAt: null })
      .where(eq(events.id, event.id));
    expect(await purgeWaitlist(ctx)).toBe(1);
  });
});
