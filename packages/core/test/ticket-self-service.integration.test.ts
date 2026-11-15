/**
 * Customer self-service for tickets (name change, transfer) against real PostgreSQL.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  adminUsers,
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
  withTransaction,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { decideScan, verifyTicketPayload } from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { and, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changeAttendeeName,
  createCoreContext,
  ensureOrderTickets,
  eventPublicKeys,
  getHolderTicketView,
  invalidateSettings,
  holderTicketToken,
  listOrderTickets,
  listTicketChanges,
  orderAccessToken,
  resolveSelfServicePolicy,
  transferTicket,
  verifyHolderTicketToken,
  TRANSFER_CAPS,
  cancelPaidOrder,
  queueHolderCancelledMails,
  reissueTicket,
  transferTicketAsHolder,
  voidTicketsForItems,
  type CoreContext,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)('ticket self-service (integration)', () => {
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
  const keyResolver = async (id: string) => {
    const keys = await eventPublicKeys(ctx, id, { excludeRevoked: true });
    return (eventOfTicket: string, keyId: string) => {
      if (eventOfTicket !== id) return null;
      return keys.find((k) => k.keyId === keyId)?.publicKey ?? null;
    };
  };

  const policyOn = {
    enabled: true,
    allowNameChange: true,
    allowTransfer: true,
    deadlineHoursBeforeStart: 24,
    maxChangesPerTicket: null,
  };
  const enable = async (value: object) => {
    invalidateSettings('ticketSelfService');
    await handle.db.execute(
      sql`INSERT INTO system_settings (key, value) VALUES ('ticketSelfService', ${JSON.stringify(value)}::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    invalidateSettings('ticketSelfService');
  };
  const customer = { type: 'CUSTOMER' } as const;
  const adminActorOf = async () => {
    const [row] = await handle.db
      .insert(adminUsers)
      .values({
        email: `adm${uuid().slice(0, 6)}@example.org`,
        displayName: 'Admin',
        roles: ['SUPER_ADMIN'],
      })
      .returning({ id: adminUsers.id });
    return { type: 'ADMIN' as const, userId: row!.id };
  };
  const mailKeys = async (to: string) =>
    (await handle.db.select().from(emailMessages).where(eq(emailMessages.toEmail, to)))
      .map((m) => m.templateKey)
      .sort();

  it('name change keeps ticket + QR, bumps the sync version and drops stored PDF keys', async () => {
    await enable(policyOn);
    const { order } = await insertOrder({ items: [{ attendeeName: 'Old Name' }] });
    const [t] = await ensureOrderTickets(ctx, order.id);
    await handle.db
      .update(tickets)
      .set({ pdfObjectKey: 'tickets/x.pdf' })
      .where(eq(tickets.id, t!.id));
    const [before] = await handle.db.select().from(tickets).where(eq(tickets.id, t!.id));
    const r = await changeAttendeeName(ctx, {
      orderId: order.id,
      ticketId: t!.id,
      name: '  New   Name ',
      actor: customer,
    });
    expect(r.attendeeName).toBe('New Name');
    const [after] = await handle.db.select().from(tickets).where(eq(tickets.id, t!.id));
    expect(after!.attendeeName).toBe('New Name');
    expect(after!.qrPayload).toBe(before!.qrPayload);
    expect(after!.status).toBe('VALID');
    expect(after!.syncVersion).toBeGreaterThan(before!.syncVersion);
    expect(after!.pdfObjectKey).toBeNull();
    const changes = await listTicketChanges(ctx, order.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'NAME_CHANGE',
      actor: 'CUSTOMER',
      newName: 'New Name',
    });
  });

  it('transfer voids the old ticket (scanner RED) and issues a verifiable QR bound to the recipient', async () => {
    await enable(policyOn);
    const { order } = await insertOrder({ items: [{}] });
    const [t] = await ensureOrderTickets(ctx, order.id);
    const res = await transferTicket(ctx, {
      orderId: order.id,
      ticketId: t!.id,
      recipientName: 'Rita Recipient',
      recipientEmail: ' Rita@Example.org ',
      message: 'Have fun',
      actor: customer,
    });
    const [oldT] = await handle.db.select().from(tickets).where(eq(tickets.id, t!.id));
    const [newT] = await handle.db.select().from(tickets).where(eq(tickets.id, res.newTicketId));
    expect(oldT!.status).toBe('REPLACED');
    expect(oldT!.replacedByTicketId).toBe(newT!.id);
    expect(newT!.status).toBe('VALID');
    expect(newT!.holderEmail).toBe('rita@example.org');
    expect(newT!.attendeeName).toBe('Rita Recipient');
    expect(newT!.qrPayload).not.toBe(oldT!.qrPayload);
    expect(newT!.ticketCode).not.toBe(oldT!.ticketCode);
    const resolve = await keyResolver(eventId);
    const verified = await verifyTicketPayload(newT!.qrPayload, eventId, resolve);
    expect(verified.ok).toBe(true);
    const decision = decideScan({
      action: 'CHECK_IN',
      ticket: {
        status: oldT!.status,
        checkInState: oldT!.checkInState,
        requiresProof: false,
        seatFeature: null,
        additionalPaymentOpen: false,
        entranceId: null,
      },
      deviceEntranceId: null,
      checkOutAllowed: true,
    });
    expect(decision.result).toBe('REJECTED_TICKET_VOID');
    // The buyer's list no longer contains the transferred ticket; the holder link works.
    expect(await listOrderTickets(ctx, order.id)).toHaveLength(0);
    const mails = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.toEmail, 'rita@example.org'));
    expect(mails.map((m) => m.templateKey)).toEqual(['TICKET_TRANSFER_RECEIVED']);
    expect(mails[0]!.orderId).toBeNull();
    const token = holderTicketToken(ctx, newT!.id);
    expect(verifyHolderTicketToken(ctx, token)).toBe(newT!.id);
    expect(verifyHolderTicketToken(ctx, orderAccessToken(ctx, order.id))).toBeNull();
    expect((await getHolderTicketView(ctx, token, newT!.id))?.state).toBe('VALID');
    // The buyer cannot touch a handed-over ticket any more (no re-transfer, no rename) ...
    await expect(
      transferTicket(ctx, {
        orderId: order.id,
        ticketId: newT!.id,
        recipientName: 'Second',
        recipientEmail: 'second@example.org',
        actor: customer,
      }),
    ).rejects.toMatchObject({ details: { reason: 'HOLDER_TICKET' } });
    await expect(
      changeAttendeeName(ctx, {
        orderId: order.id,
        ticketId: newT!.id,
        name: 'Renamed',
        actor: customer,
      }),
    ).rejects.toMatchObject({ details: { reason: 'HOLDER_TICKET' } });
    // ... only the current holder may pass it on (and cannot rename it).
    await expect(
      changeAttendeeName(ctx, {
        orderId: order.id,
        ticketId: newT!.id,
        name: 'Renamed',
        actor: { type: 'HOLDER' },
      }),
    ).rejects.toMatchObject({ details: { reason: 'HOLDER_TICKET' } });
    const view = await getHolderTicketView(ctx, token, newT!.id);
    expect(view?.transfer.block).toBeNull();
    await expect(
      transferTicketAsHolder(ctx, {
        token: holderTicketToken(ctx, oldT!.id), // a token of another ticket never works
        ticketId: newT!.id,
        recipientName: 'Second',
        recipientEmail: 'second@example.org',
      }),
    ).rejects.toMatchObject({ code: 'TICKET_NOT_FOUND' });
    const again = await transferTicketAsHolder(ctx, {
      token,
      ticketId: newT!.id,
      recipientName: 'Second',
      recipientEmail: 'second@example.org',
    });
    expect((await getHolderTicketView(ctx, token, newT!.id))?.state).toBe('TRANSFERRED');
    expect(again.newTicketId).not.toBe(newT!.id);
    // The new holder gets the ticket; the first holder passed it on themselves (no mail for them).
    expect(await mailKeys('second@example.org')).toEqual(['TICKET_TRANSFER_RECEIVED']);
    expect(await mailKeys('rita@example.org')).toEqual(['TICKET_TRANSFER_RECEIVED']);
  });

  it('admins can reassign a handed-over ticket and hand it back to the buyer', async () => {
    await enable({ ...policyOn, enabled: false });
    const { order } = await insertOrder({ items: [{}] });
    const [t] = await ensureOrderTickets(ctx, order.id);
    const adminActor = await adminActorOf();
    const handedOver = await transferTicket(ctx, {
      orderId: order.id,
      ticketId: t!.id,
      recipientName: 'Holder One',
      recipientEmail: 'holder1@example.org',
      actor: adminActor,
    });
    expect(handedOver.returnedToBuyer).toBe(false);
    // The buyer's address as recipient = hand back.
    const back = await transferTicket(ctx, {
      orderId: order.id,
      ticketId: handedOver.newTicketId,
      recipientName: 'ignored',
      recipientEmail: order.email!.toUpperCase(),
      actor: adminActor,
    });
    expect(back.returnedToBuyer).toBe(true);
    const [returned] = await handle.db
      .select()
      .from(tickets)
      .where(eq(tickets.id, back.newTicketId));
    expect(returned).toMatchObject({
      status: 'VALID',
      holderEmail: null,
      attendeeName: 'Ann Example',
    });
    expect(await listOrderTickets(ctx, order.id)).toHaveLength(1);
    // The previous holder is told the ticket is gone, the buyer gets the tickets again.
    expect(await mailKeys('holder1@example.org')).toEqual([
      'TICKET_HOLDER_CANCELLED',
      'TICKET_TRANSFER_RECEIVED',
    ]);
    const toBuyer = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.orderId, order.id));
    expect(toBuyer.map((m) => m.templateKey)).toContain('TICKETS_RESENT');
    // A ticket the buyer already holds cannot be "handed back".
    await expect(
      transferTicket(ctx, {
        orderId: order.id,
        ticketId: back.newTicketId,
        recipientName: 'x',
        recipientEmail: order.email!,
        actor: adminActor,
      }),
    ).rejects.toMatchObject({ code: 'SAME_HOLDER' });
  });

  it('treats the e-mail of the owning customer account as the buyer, too', async () => {
    await enable(policyOn);
    const { order } = await insertOrder({ items: [{}] });
    const [t] = await ensureOrderTickets(ctx, order.id);
    // The order was placed with another address than the account has now.
    await handle.db
      .update(orders)
      .set({ email: 'old-address@example.org' })
      .where(eq(orders.id, order.id));
    const [account] = await handle.db
      .select()
      .from(customers)
      .where(eq(customers.id, order.customerId!));
    for (const recipientEmail of [account!.email, 'old-address@example.org']) {
      await expect(
        transferTicket(ctx, {
          orderId: order.id,
          ticketId: t!.id,
          recipientName: 'Me',
          recipientEmail,
          actor: customer,
        }),
      ).rejects.toMatchObject({ code: 'SELF_TRANSFER' });
    }
  });

  it('applies hard transfer caps independent of the settings (customers only)', async () => {
    // "unlimited" in the settings still has a ceiling per seat ...
    await enable({ ...policyOn, maxChangesPerTicket: null });
    const adminActor = await adminActorOf();
    const { order } = await insertOrder({ items: [{}] });
    const [first] = await ensureOrderTickets(ctx, order.id);
    let ticketId = first!.id;
    let token: string | null = null;
    const address = (prefix: string, n: number) =>
      `${prefix}-${n}-${uuid().slice(0, 4)}@example.org`;
    for (let n = 0; n < TRANSFER_CAPS.perTicket; n += 1) {
      const res: { newTicketId: string } = token
        ? await transferTicketAsHolder(ctx, {
            token,
            ticketId,
            recipientName: `H ${n}`,
            recipientEmail: address('cap-seat', n),
          })
        : await transferTicket(ctx, {
            orderId: order.id,
            ticketId,
            recipientName: `H ${n}`,
            recipientEmail: address('cap-seat', n),
            actor: customer,
          });
      ticketId = res.newTicketId;
      token = holderTicketToken(ctx, ticketId);
    }
    await expect(
      transferTicketAsHolder(ctx, {
        token: token!,
        ticketId,
        recipientName: 'One too many',
        recipientEmail: 'one-too-many@example.org',
      }),
    ).rejects.toMatchObject({ details: { reason: 'LIMIT_REACHED' } });
    expect((await getHolderTicketView(ctx, token, ticketId))?.transfer.block).toBe('LIMIT_REACHED');
    // ... but an admin is not capped.
    await transferTicket(ctx, {
      orderId: order.id,
      ticketId,
      recipientName: 'Admin pick',
      recipientEmail: 'admin-pick@example.org',
      actor: adminActor,
    });

    // Per recipient address: 5 per day across orders.
    const target = address('spam-target', 0);
    for (let n = 0; n < TRANSFER_CAPS.perRecipientPerDay; n += 1) {
      const o = await insertOrder({ items: [{}] });
      const [tk] = await ensureOrderTickets(ctx, o.order.id);
      await transferTicket(ctx, {
        orderId: o.order.id,
        ticketId: tk!.id,
        recipientName: 'Target',
        recipientEmail: target,
        actor: customer,
      });
    }
    const o6 = await insertOrder({ items: [{}] });
    const [tk6] = await ensureOrderTickets(ctx, o6.order.id);
    await expect(
      transferTicket(ctx, {
        orderId: o6.order.id,
        ticketId: tk6!.id,
        recipientName: 'Target',
        recipientEmail: target,
        actor: customer,
      }),
    ).rejects.toMatchObject({ code: 'TRANSFER_LIMIT_REACHED', details: { reason: 'RECIPIENT' } });

    // Per order: 20 per day.
    const big = await insertOrder({
      items: Array.from({ length: TRANSFER_CAPS.perOrderPerDay + 1 }, () => ({})),
    });
    const bigTickets = await ensureOrderTickets(ctx, big.order.id);
    for (let n = 0; n < TRANSFER_CAPS.perOrderPerDay; n += 1) {
      await transferTicket(ctx, {
        orderId: big.order.id,
        ticketId: bigTickets[n]!.id,
        recipientName: 'Bulk',
        recipientEmail: address('bulk', n),
        actor: customer,
      });
    }
    await expect(
      transferTicket(ctx, {
        orderId: big.order.id,
        ticketId: bigTickets[TRANSFER_CAPS.perOrderPerDay]!.id,
        recipientName: 'Bulk',
        recipientEmail: 'bulk-last@example.org',
        actor: customer,
      }),
    ).rejects.toMatchObject({ code: 'TRANSFER_LIMIT_REACHED', details: { reason: 'ORDER' } });
  });

  it('of two parallel changes of the same ticket exactly one wins', async () => {
    await enable(policyOn);
    const { order } = await insertOrder({ items: [{}] });
    const [t] = await ensureOrderTickets(ctx, order.id);
    const results = await Promise.allSettled(
      ['A', 'B'].map((name) =>
        transferTicket(ctx, {
          orderId: order.id,
          ticketId: t!.id,
          recipientName: name,
          recipientEmail: `p${name.toLowerCase()}-${uuid().slice(0, 4)}@example.org`,
          actor: customer,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'TICKET_NOT_VALID' });
    const rows = await handle.db.select().from(tickets).where(eq(tickets.orderId, order.id));
    expect(rows.filter((x) => x.status === 'VALID')).toHaveLength(1);

    // Name changes racing a transfer: never two valid tickets, never a lost ticket.
    const other = await insertOrder({ items: [{}] });
    const [u] = await ensureOrderTickets(ctx, other.order.id);
    const mixed = await Promise.allSettled([
      changeAttendeeName(ctx, {
        orderId: other.order.id,
        ticketId: u!.id,
        name: 'Name 1',
        actor: customer,
      }),
      changeAttendeeName(ctx, {
        orderId: other.order.id,
        ticketId: u!.id,
        name: 'Name 2',
        actor: customer,
      }),
      transferTicket(ctx, {
        orderId: other.order.id,
        ticketId: u!.id,
        recipientName: 'C',
        recipientEmail: `pc-${uuid().slice(0, 4)}@example.org`,
        actor: customer,
      }),
    ]);
    const after = await handle.db.select().from(tickets).where(eq(tickets.orderId, other.order.id));
    expect(after.filter((x) => x.status === 'VALID')).toHaveLength(1);
    expect(mixed.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  });

  it('tells holders about re-issues and cancellations and keeps them through a reversal', async () => {
    await enable(policyOn);
    const adminActor = await adminActorOf();
    const { order, items } = await insertOrder({ items: [{}, {}] });
    const [a, b] = await ensureOrderTickets(ctx, order.id);
    const first = await transferTicket(ctx, {
      orderId: order.id,
      ticketId: a!.id,
      recipientName: 'Hanna Holder',
      recipientEmail: 'hanna@example.org',
      actor: customer,
    });
    expect(await mailKeys('hanna@example.org')).toEqual(['TICKET_TRANSFER_RECEIVED']);

    // Re-issue (key rotation, seat or tariff change): same holder, new QR, "updated" mail.
    const reissued = await reissueTicket(ctx, first.newTicketId);
    expect(reissued.holderEmail).toBe('hanna@example.org');
    expect(await mailKeys('hanna@example.org')).toEqual([
      'TICKET_HOLDER_UPDATED',
      'TICKET_TRANSFER_RECEIVED',
    ]);

    // Reversal: the ticket is voided (holder told); after the new payment the item is confirmed
    // again and the re-issued ticket keeps holder and name.
    const itemA = items.find((i) => i.id === reissued.orderItemId)!;
    await withTransaction(handle.db, async (tx) => {
      await tx.update(orderItems).set({ status: 'PENDING' }).where(eq(orderItems.id, itemA.id));
      const voided = await voidTicketsForItems(tx, [itemA.id], 'CANCELLED');
      expect(voided.count).toBe(1);
      expect(voided.holders.map((h) => h.holderEmail)).toEqual(['hanna@example.org']);
      await queueHolderCancelledMails(ctx, tx, voided.holders);
    });
    expect(await mailKeys('hanna@example.org')).toContain('TICKET_HOLDER_CANCELLED');
    await handle.db
      .update(orderItems)
      .set({ status: 'CONFIRMED' })
      .where(eq(orderItems.id, itemA.id));
    await ensureOrderTickets(ctx, order.id);
    const [again] = await handle.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.orderItemId, itemA.id), eq(tickets.status, 'VALID')));
    expect(again).toMatchObject({ holderEmail: 'hanna@example.org', attendeeName: 'Hanna Holder' });
    expect(
      (await mailKeys('hanna@example.org')).filter((k) => k === 'TICKET_HOLDER_UPDATED'),
    ).toHaveLength(2);

    // Cancelling the paid order voids handed-over tickets and mails their holders.
    await transferTicket(ctx, {
      orderId: order.id,
      ticketId: b!.id,
      recipientName: 'Carl',
      recipientEmail: 'carl@example.org',
      actor: adminActor,
    });
    await cancelPaidOrder(ctx, {
      orderId: order.id,
      userId: adminActor.userId,
      reason: 'test',
      notify: false,
      refundFees: true,
    });
    expect(await mailKeys('carl@example.org')).toContain('TICKET_HOLDER_CANCELLED');
    expect(
      await mailKeys('hanna@example.org').then((k) =>
        k.filter((x) => x === 'TICKET_HOLDER_CANCELLED'),
      ),
    ).toHaveLength(2);
  });

  it('enforces deadline, switches, limit, check-in and ownership; admins bypass the policy', async () => {
    const { order } = await insertOrder({ items: [{}, {}] });
    const [a, b] = await ensureOrderTickets(ctx, order.id);
    const reason = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return 'ok';
      } catch (e) {
        const err = e as { details?: { reason?: string }; code: string };
        return err.details?.reason ?? err.code;
      }
    };
    const rename = (
      ticketId: string,
      name = 'X Y',
      orderId = order.id,
      actor: typeof customer | { type: 'ADMIN'; userId: string } = customer,
    ) => changeAttendeeName(ctx, { orderId, ticketId, name, actor });

    await enable({ ...policyOn, enabled: false });
    expect(await reason(() => rename(a!.id))).toBe('DISABLED');

    await enable({ ...policyOn, deadlineHoursBeforeStart: 24 * 60 });
    expect(await reason(() => rename(a!.id))).toBe('DEADLINE_PASSED');
    const [adminRow] = await handle.db
      .insert(adminUsers)
      .values({
        email: `a${uuid().slice(0, 6)}@example.org`,
        displayName: 'Admin',
        roles: ['SUPER_ADMIN'],
      })
      .returning({ id: adminUsers.id });
    expect(
      await reason(() =>
        rename(a!.id, 'Admin Set', order.id, { type: 'ADMIN', userId: adminRow!.id }),
      ),
    ).toBe('ok');

    await enable({ ...policyOn, allowTransfer: false });
    expect(
      await reason(() =>
        transferTicket(ctx, {
          orderId: order.id,
          ticketId: b!.id,
          recipientName: 'R',
          recipientEmail: 'r@example.org',
          actor: customer,
        }),
      ),
    ).toBe('TRANSFER_DISABLED');

    await enable({ ...policyOn, maxChangesPerTicket: 1 });
    expect(await reason(() => rename(b!.id, 'Other One'))).toBe('ok');
    expect(await reason(() => rename(b!.id, 'Third One'))).toBe('LIMIT_REACHED');

    await enable(policyOn);
    const other = await insertOrder({ items: [{}] });
    const [foreign] = await ensureOrderTickets(ctx, other.order.id);
    // Another order's ticket is never reachable through this order.
    expect(await reason(() => rename(foreign!.id))).toBe('TICKET_NOT_FOUND');
    await handle.db
      .update(tickets)
      .set({ checkInState: 'CHECKED_IN', firstCheckedInAt: new Date() })
      .where(eq(tickets.id, foreign!.id));
    expect(await reason(() => rename(foreign!.id, 'X Y', other.order.id))).toBe(
      'TICKET_CHECKED_IN',
    );
    expect(
      await reason(() =>
        transferTicket(ctx, {
          orderId: order.id,
          ticketId: a!.id,
          recipientName: 'Me',
          recipientEmail: order.email!.toUpperCase(),
          actor: customer,
        }),
      ),
    ).toBe('SELF_TRANSFER');
  });

  it('resolves event overrides on top of the global policy', () => {
    const none = {
      selfServiceEnabled: null,
      selfServiceAllowNameChange: null,
      selfServiceAllowTransfer: null,
      selfServiceDeadlineHours: null,
      selfServiceMaxChanges: null,
    };
    expect(resolveSelfServicePolicy(policyOn, none)).toEqual(policyOn);
    expect(resolveSelfServicePolicy(policyOn, { ...none, selfServiceEnabled: false }).enabled).toBe(
      false,
    );
    expect(
      resolveSelfServicePolicy(
        { ...policyOn, enabled: false },
        { ...none, selfServiceEnabled: true, selfServiceDeadlineHours: 2 },
      ),
    ).toMatchObject({ enabled: true, deadlineHoursBeforeStart: 2 });
    // The event can switch the global limit off ("0 = unlimited") or set its own one.
    const limited = { ...policyOn, maxChangesPerTicket: 3 };
    expect(resolveSelfServicePolicy(limited, none).maxChangesPerTicket).toBe(3);
    expect(
      resolveSelfServicePolicy(limited, { ...none, selfServiceMaxChanges: 0 }).maxChangesPerTicket,
    ).toBeNull();
    expect(
      resolveSelfServicePolicy(limited, { ...none, selfServiceMaxChanges: 7 }).maxChangesPerTicket,
    ).toBe(7);
  });
});
