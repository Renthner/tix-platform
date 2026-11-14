/**
 * Ticket issuance and Ed25519 signing keys against real PostgreSQL (throw-away database):
 * idempotent issuance under concurrency, key rotation / revocation, re-issue, voiding and the
 * backfill for PAID orders that predate ticket issuance.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  customers,
  emailMessages,
  eventSigningKeys,
  events,
  loadRootEnv,
  orderItems,
  orders,
  priceCategories,
  seatMapSections,
  seatMaps,
  taxRates,
  tickets,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { parseTicketPayload, verifyTicketPayload } from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backfillMissingTickets,
  createCoreContext,
  ensureEventSigningKey,
  ensureOrderTickets,
  eventPublicKeys,
  reissueTicket,
  reissueTicketsOfRevokedKeys,
  revokeEventSigningKey,
  rotateEventSigningKey,
  type CoreContext,
} from '../src';
import { cancelOrder, voidTicketsForItems } from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)('ticket issuance & signing keys (integration)', () => {
  const dbName = `tix_tickets_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let eventId: string;
  let sectionId: string;
  let hiddenSectionId: string;
  let categoryId: string;
  let ticketTypeId: string;
  let seq = 0;

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
    handle = createDb({ connectionString: url.toString(), poolMax: 20 });
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${uuid().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      secrets: createSecretBox(parseKeyRing(generateKeyRingEntry('t1'))),
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
        canvasWidth: 100,
        canvasHeight: 100,
      })
      .returning();
    const sectionValues = {
      seatMapId: map!.id,
      type: 'STANDING' as const,
      capacity: 500,
      geometry: { type: 'rect' as const, x: 0, y: 0, width: 50, height: 50, rotation: 0 },
    };
    const [section] = await handle.db
      .insert(seatMapSections)
      .values({ ...sectionValues, name: 'Floor', ticketLabel: 'Floor' })
      .returning();
    const [hidden] = await handle.db
      .insert(seatMapSections)
      .values({ ...sectionValues, name: 'Secret', ticketLabel: 'Secret', showLabelOnTicket: false })
      .returning();
    sectionId = section!.id;
    hiddenSectionId = hidden!.id;
    const [rate] = await handle.db
      .insert(taxRates)
      .values({ name: `vat-${uuid().slice(0, 6)}`, rateBasisPoints: 1900 })
      .returning();
    const [ev] = await handle.db
      .insert(events)
      .values({
        venueId: venue!.id,
        seatMapId: map!.id,
        slug: `ev-${uuid().slice(0, 8)}`,
        title: 'Show',
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: rate!.id,
      })
      .returning();
    eventId = ev!.id;
    const [category] = await handle.db
      .insert(priceCategories)
      .values({ eventId, name: 'Cat 1', color: '#336699', basePrice: 2000 })
      .returning();
    categoryId = category!.id;
    const [tt] = await handle.db
      .insert(ticketTypes)
      .values({ eventId, name: 'Normal', isDefault: true })
      .returning();
    ticketTypeId = tt!.id;
  });

  afterAll(async () => {
    await handle?.close();
    if (redis) await redis.quit();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  async function insertOrder(opts: {
    items: { sectionId?: string; attendeeName?: string }[];
    status?: 'PAID' | 'AWAITING_PAYMENT';
  }) {
    seq += 1;
    const status = opts.status ?? 'PAID';
    const email = `buyer${seq}-${uuid().slice(0, 6)}@example.org`;
    const [customer] = await handle.db
      .insert(customers)
      .values({ email, firstName: 'Ann', lastName: 'Example' })
      .returning();
    const total = opts.items.length * 2000;
    const [order] = await handle.db
      .insert(orders)
      .values({
        orderNumber: `T-${uuid().slice(0, 8)}`,
        customerId: customer!.id,
        status,
        channel: 'ONLINE',
        paymentMethod: 'PAYPAL',
        email,
        firstName: 'Ann',
        lastName: 'Example',
        billingAddress: { street: 'Weg 1', postalCode: '12345', city: 'Stadt', country: 'DE' },
        locale: 'en',
        currency: 'EUR',
        subtotalGross: total,
        feeTotal: 0,
        totalGross: total,
        totalNet: total - 320 * opts.items.length,
        totalTax: 320 * opts.items.length,
        amountPaid: status === 'PAID' ? total : 0,
        paidAt: status === 'PAID' ? new Date() : null,
        ...(status === 'AWAITING_PAYMENT'
          ? {
              paymentReference: `TIX-2026-${String(1000 + seq)}-1`,
              paymentDueAt: new Date(Date.now() + 86_400_000),
            }
          : {}),
      })
      .returning();
    const items = await handle.db
      .insert(orderItems)
      .values(
        opts.items.map((item, n) => ({
          orderId: order!.id,
          eventId,
          kind: 'GENERAL_ADMISSION' as const,
          sectionId: item.sectionId ?? sectionId,
          priceCategoryId: categoryId,
          ticketTypeId,
          status: status === 'PAID' ? ('CONFIRMED' as const) : ('PENDING' as const),
          sectionLabel: `Floor ${n + 1}.0`,
          categoryName: 'Cat 1',
          ticketTypeName: 'Normal',
          unitPriceGross: 2000,
          priceGross: 2000,
          taxRateBasisPoints: 1900,
          priceNet: 1680,
          taxAmount: 320,
          attendeeName: item.attendeeName ?? null,
        })),
      )
      .returning();
    return { order: order!, items };
  }

  /** Resolver bound to the scanner's event; keys are looked up by (eventId, keyId). */
  /** Minimal BullMQ producer stand-in that records `add` calls. */
  const fakeJobs = (
    sink: { jobName: string; data: unknown; jobId?: string }[],
  ): NonNullable<CoreContext['jobs']> =>
    ({
      add: async (_queue: string, jobName: string, data: unknown, opts?: { jobId?: string }) => {
        sink.push({ jobName, data, jobId: opts?.jobId });
        return opts?.jobId ?? '';
      },
    }) as unknown as NonNullable<CoreContext['jobs']>;

  const keyResolver = async (id: string) => {
    const keys = await eventPublicKeys(ctx, id, { excludeRevoked: true });
    return (eventOfTicket: string, keyId: string) => {
      if (eventOfTicket !== id) return null;
      return keys.find((k) => k.keyId === keyId)?.publicKey ?? null;
    };
  };

  it('issues one signed ticket per confirmed item, idempotently under concurrency', async () => {
    const { order, items } = await insertOrder({
      items: [{ attendeeName: 'Guest One' }, {}, { sectionId: hiddenSectionId }],
    });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => ensureOrderTickets(ctx, order.id)),
    );
    const all = await handle.db.select().from(tickets).where(eq(tickets.orderId, order.id));
    expect(all).toHaveLength(3);
    for (const r of results) expect(r.map((t) => t.id).sort()).toEqual(all.map((t) => t.id).sort());
    expect(new Set(all.map((t) => t.ticketCode)).size).toBe(3);
    expect(new Set(all.map((t) => t.orderItemId))).toEqual(new Set(items.map((i) => i.id)));
    for (const t of all) {
      expect(t.status).toBe('VALID');
      expect(t.ticketCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    }
    const byItem = new Map(all.map((t) => [t.orderItemId, t]));
    expect(byItem.get(items[0]!.id)!.attendeeName).toBe('Guest One');
    expect(byItem.get(items[1]!.id)!.attendeeName).toBe('Ann Example');

    const resolve = await keyResolver(eventId);
    const otherEvent = uuid();
    for (const t of all) {
      const verified = await verifyTicketPayload(t.qrPayload, eventId, resolve);
      expect(verified.ok).toBe(true);
      // A ticket of event A presented to a verifier of event B is rejected.
      expect(
        await verifyTicketPayload(t.qrPayload, otherEvent, await keyResolver(otherEvent)),
      ).toEqual({ ok: false, reason: 'WRONG_EVENT' });
      expect(parseTicketPayload(t.qrPayload)).toMatchObject({ eventId, ticketId: t.id });
    }
    // show_label_on_ticket = false hides the block name in the signed seat info.
    expect(parseTicketPayload(byItem.get(items[2]!.id)!.qrPayload)!.seatInfo).toBe('GA:');
    expect(parseTicketPayload(byItem.get(items[1]!.id)!.qrPayload)!.seatInfo).toBe('GA:Floor 2.0');
    // Re-running changes nothing.
    const again = await ensureOrderTickets(ctx, order.id);
    expect(again.map((t) => t.qrPayload).sort()).toEqual(all.map((t) => t.qrPayload).sort());
  });

  it('creates exactly one ACTIVE key under concurrency and survives rotation', async () => {
    const [ev2] = await handle.db
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .then(async (rows) => {
        const base = rows[0]!;
        const { id: _id, ...rest } = base;
        return handle.db
          .insert(events)
          .values({ ...rest, seatMapId: null, slug: `ev-${uuid().slice(0, 8)}` })
          .returning();
      });
    const keys = await Promise.all(
      Array.from({ length: 10 }, () => ensureEventSigningKey(ctx, ev2!.id)),
    );
    expect(new Set(keys.map((k) => k.id)).size).toBe(1);
    const rows = await handle.db
      .select()
      .from(eventSigningKeys)
      .where(eq(eventSigningKeys.eventId, ev2!.id));
    expect(rows).toHaveLength(1);
    // The private key is encrypted and bound to its row (AAD).
    expect(rows[0]!.privateKeyEncrypted.startsWith('v1.')).toBe(true);
    expect(rows[0]!.privateKeyEncrypted).not.toContain(rows[0]!.publicKey);
  });

  it('rotates keys: old tickets still verify, new ones use the new key', async () => {
    const first = await insertOrder({ items: [{}] });
    const [oldTicket] = await ensureOrderTickets(ctx, first.order.id);
    const rotated = await rotateEventSigningKey(ctx, eventId);
    expect(rotated.retiredKeyId).toBeTruthy();
    const second = await insertOrder({ items: [{}] });
    const [newTicket] = await ensureOrderTickets(ctx, second.order.id);
    const oldKeyId = parseTicketPayload(oldTicket!.qrPayload)!.keyId;
    const newKeyId = parseTicketPayload(newTicket!.qrPayload)!.keyId;
    expect(newKeyId).toBe(rotated.newKeyId);
    expect(oldKeyId).not.toBe(newKeyId);
    const statuses = (await eventPublicKeys(ctx, eventId)).map((k) => k.status);
    expect(statuses.filter((s) => s === 'ACTIVE')).toHaveLength(1);
    expect(statuses).toContain('RETIRED');
    const resolve = await keyResolver(eventId);
    expect((await verifyTicketPayload(oldTicket!.qrPayload, eventId, resolve)).ok).toBe(true);
    expect((await verifyTicketPayload(newTicket!.qrPayload, eventId, resolve)).ok).toBe(true);
  });

  it('revokes a key and re-issues the affected tickets', async () => {
    const queued: { jobName: string; data: unknown; jobId?: string }[] = [];
    const { order } = await insertOrder({ items: [{}, {}] });
    const issued = await ensureOrderTickets(ctx, order.id);
    const revokedKeyId = parseTicketPayload(issued[0]!.qrPayload)!.keyId;
    const { affectedTickets } = await revokeEventSigningKey(ctx, eventId, revokedKeyId);
    expect(affectedTickets).toBeGreaterThanOrEqual(2);
    const resolve = await keyResolver(eventId);
    expect(await verifyTicketPayload(issued[0]!.qrPayload, eventId, resolve)).toEqual({
      ok: false,
      reason: 'UNKNOWN_KEY',
    });
    const { reissued: count, orderIds } = await reissueTicketsOfRevokedKeys(
      { ...ctx, jobs: fakeJobs(queued) },
      eventId,
    );
    expect(count).toBeGreaterThanOrEqual(2);
    expect(orderIds).toContain(order.id);
    const resent = await handle.db
      .select()
      .from(emailMessages)
      .where(
        and(eq(emailMessages.orderId, order.id), eq(emailMessages.templateKey, 'TICKETS_RESENT')),
      );
    expect(resent).toHaveLength(1);
    const now = await ensureOrderTickets(ctx, order.id);
    expect(now).toHaveLength(2);
    for (const t of now) {
      expect((await verifyTicketPayload(t.qrPayload, eventId, resolve)).ok).toBe(true);
      expect(t.id).not.toBe(issued[0]!.id);
    }
    const [old] = await handle.db.select().from(tickets).where(eq(tickets.id, issued[0]!.id));
    expect(old!.status).toBe('REPLACED');
    expect(old!.replacedByTicketId).toBeTruthy();
    expect(old!.voidedAt).not.toBeNull();
  });

  it('re-issues a single ticket with a new name', async () => {
    const { order } = await insertOrder({ items: [{}] });
    const [ticket] = await ensureOrderTickets(ctx, order.id);
    const replacement = await reissueTicket(ctx, ticket!.id, { attendeeName: 'New Name' });
    expect(replacement.attendeeName).toBe('New Name');
    expect(replacement.ticketCode).not.toBe(ticket!.ticketCode);
    await expect(reissueTicket(ctx, ticket!.id)).rejects.toMatchObject({
      code: 'TICKET_NOT_VALID',
    });
    expect(await ensureOrderTickets(ctx, order.id)).toHaveLength(1);
  });

  it('carries the check-in state over to the re-issued ticket', async () => {
    const { order } = await insertOrder({ items: [{}] });
    const [ticket] = await ensureOrderTickets(ctx, order.id);
    const scannedAt = new Date(Date.now() - 60_000);
    await handle.db
      .update(tickets)
      .set({
        checkInState: 'CHECKED_IN',
        firstCheckedInAt: scannedAt,
        lastScanAt: scannedAt,
        checkInCount: 2,
      })
      .where(eq(tickets.id, ticket!.id));
    const replacement = await reissueTicket(ctx, ticket!.id);
    expect(replacement.checkInState).toBe('CHECKED_IN');
    expect(replacement.firstCheckedInAt?.getTime()).toBe(scannedAt.getTime());
    expect(replacement.lastScanAt?.getTime()).toBe(scannedAt.getTime());
    expect(replacement.checkInCount).toBe(2);
  });

  it('issues nothing for orders that are not PAID', async () => {
    const { order } = await insertOrder({ items: [{}], status: 'AWAITING_PAYMENT' });
    await handle.db
      .update(orderItems)
      .set({ status: 'CONFIRMED' })
      .where(eq(orderItems.orderId, order.id));
    expect(await ensureOrderTickets(ctx, order.id)).toEqual([]);
    expect(await handle.db.select().from(tickets).where(eq(tickets.orderId, order.id))).toEqual([]);
  });

  it('voids tickets of cancelled items and does not re-issue for them', async () => {
    const { order, items } = await insertOrder({ items: [{}, {}] });
    await ensureOrderTickets(ctx, order.id);
    await handle.db.transaction(async (tx) => {
      expect(await voidTicketsForItems(tx, [items[0]!.id], 'REFUNDED')).toBe(1);
      await tx
        .update(orderItems)
        .set({ status: 'REFUNDED', refundedAt: new Date() })
        .where(eq(orderItems.id, items[0]!.id));
    });
    const valid = await ensureOrderTickets(ctx, order.id);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.orderItemId).toBe(items[1]!.id);
    const [refunded] = await handle.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.orderItemId, items[0]!.id)));
    expect(refunded!.status).toBe('REFUNDED');
  });

  it('cancelOrder voids tickets that exist on an unpaid order', async () => {
    const { order } = await insertOrder({ items: [{}], status: 'AWAITING_PAYMENT' });
    // An unpaid order has PENDING items, hence no tickets; force one to prove the guard.
    await handle.db
      .update(orderItems)
      .set({ status: 'CONFIRMED' })
      .where(eq(orderItems.orderId, order.id));
    // Tickets are only issued for PAID orders: flip briefly to PAID, then back to unpaid.
    await handle.db
      .update(orders)
      .set({ status: 'PAID', paidAt: new Date() })
      .where(eq(orders.id, order.id));
    await ensureOrderTickets(ctx, order.id);
    await handle.db
      .update(orders)
      .set({ status: 'AWAITING_PAYMENT', paidAt: null })
      .where(eq(orders.id, order.id));
    expect(
      await cancelOrder(ctx, { orderId: order.id, status: 'CANCELLED', actor: { type: 'SYSTEM' } }),
    ).toBe(true);
    const rows = await handle.db.select().from(tickets).where(eq(tickets.orderId, order.id));
    expect(rows.map((t) => t.status)).toEqual(['CANCELLED']);
  });

  it('backfills PAID orders without tickets, skips unpaid ones, and is idempotent', async () => {
    const paid = await insertOrder({ items: [{}, {}] });
    const unpaid = await insertOrder({ items: [{}], status: 'AWAITING_PAYMENT' });
    const first = await backfillMissingTickets(ctx);
    expect(first.failed).toBe(0);
    expect(first.tickets).toBeGreaterThanOrEqual(2);
    const paidRows = await handle.db
      .select()
      .from(tickets)
      .where(eq(tickets.orderId, paid.order.id));
    expect(paidRows).toHaveLength(2);
    expect(
      await handle.db.select().from(tickets).where(eq(tickets.orderId, unpaid.order.id)),
    ).toHaveLength(0);
    const second = await backfillMissingTickets(ctx);
    expect(second).toEqual({ orders: 0, tickets: 0, failed: 0, requeued: 0, reissued: 0 });
  });

  it('re-enqueues recently paid orders without mail, issues old ones silently', async () => {
    const recent = await insertOrder({ items: [{}] });
    const old = await insertOrder({ items: [{}] });
    await handle.db
      .update(orders)
      .set({ paidAt: new Date(Date.now() - 3 * 86_400_000) })
      .where(eq(orders.id, old.order.id));
    const added: { jobName: string; data: unknown; jobId?: string }[] = [];
    const jobs = fakeJobs(added);
    const result = await backfillMissingTickets({ ...ctx, jobs });
    expect(result).toMatchObject({ failed: 0, requeued: 1, orders: 1, tickets: 1 });
    expect(added).toEqual([
      {
        jobName: 'order-paid',
        data: { orderId: recent.order.id, paidCycle: 0 },
        jobId: `order-paid-${recent.order.id}`,
      },
    ]);
    expect(
      await handle.db.select().from(tickets).where(eq(tickets.orderId, recent.order.id)),
    ).toHaveLength(0);
    expect(
      await handle.db.select().from(tickets).where(eq(tickets.orderId, old.order.id)),
    ).toHaveLength(1);
  });
});
