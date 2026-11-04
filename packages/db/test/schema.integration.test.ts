/**
 * Integration tests proving the database-level integrity guarantees of the schema against a
 * real PostgreSQL server. A throw-away database is created per run (TEST_DATABASE_URL must
 * point to a server/database where the user may CREATE DATABASE, e.g. `/postgres`).
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessCodes,
  createDb,
  customers,
  eventSigningKeys,
  events,
  fees,
  invoices,
  isCheckViolation,
  isForeignKeyViolation,
  isRestrictViolation,
  isUniqueViolation,
  nextSequenceValue,
  orderFees,
  orderItems,
  orders,
  priceCategories,
  seatMapRows,
  seatMapSections,
  seatMaps,
  seats,
  taxRates,
  ticketTypes,
  tickets,
  venues,
  type Database,
  type DbHandle,
  type Executor,
} from '../src';
import { loadRootEnv } from '../src/env';
import { runMigrations } from '../src/migrate';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;

const rand = () => randomUUID().slice(0, 8);
const rectGeometry = { type: 'rect', x: 0, y: 0, width: 100, height: 100, rotation: 0 } as const;

/** One venue + EVENT seat map + event with a seated row (2 seats) and a GA area (capacity 2). */
async function createFixture(db: Database) {
  const id = rand();
  const [tax] = await db
    .insert(taxRates)
    .values({ name: `USt ${id}`, rateBasisPoints: 700 })
    .returning();
  const [venue] = await db
    .insert(venues)
    .values({ name: 'Test Hall', slug: `hall-${id}`, timeZone: 'Europe/Berlin' })
    .returning();
  const [map] = await db
    .insert(seatMaps)
    .values({
      venueId: venue!.id,
      kind: 'EVENT',
      name: 'Map',
      canvasWidth: 1000,
      canvasHeight: 800,
    })
    .returning();
  const [event] = await db
    .insert(events)
    .values({
      venueId: venue!.id,
      seatMapId: map!.id,
      slug: `event-${id}`,
      title: 'Test Event',
      startsAt: new Date(Date.now() + 30 * 86_400_000),
      timeZone: 'Europe/Berlin',
      currency: 'EUR',
      taxRateId: tax!.id,
    })
    .returning();
  const [category] = await db
    .insert(priceCategories)
    .values({ eventId: event!.id, name: 'Kategorie 1', color: '#C0392B', basePrice: 3000 })
    .returning();
  const [ticketType] = await db
    .insert(ticketTypes)
    .values({ eventId: event!.id, name: 'Normal', isDefault: true })
    .returning();
  const [seated] = await db
    .insert(seatMapSections)
    .values({
      seatMapId: map!.id,
      type: 'SEATED',
      name: 'Parkett',
      ticketLabel: 'Parkett',
      geometry: rectGeometry,
    })
    .returning();
  const [standing] = await db
    .insert(seatMapSections)
    .values({
      seatMapId: map!.id,
      type: 'STANDING',
      name: 'Stehplatz',
      ticketLabel: 'Stehplatz',
      geometry: rectGeometry,
      capacity: 2,
      priceCategoryId: category!.id,
    })
    .returning();
  const [row] = await db
    .insert(seatMapRows)
    .values({
      seatMapId: map!.id,
      sectionId: seated!.id,
      label: '1',
      geometry: {
        curve: { type: 'straight', start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
        seatSpacing: 10,
        numbering: 'ASCENDING',
        labelPlacement: 'BOTH',
      },
    })
    .returning();
  const seatRows = await db
    .insert(seats)
    .values(
      [1, 2].map((n) => ({
        seatMapId: map!.id,
        sectionId: seated!.id,
        rowId: row!.id,
        label: String(n),
        position: n,
        x: n * 10,
        y: 0,
        priceCategoryId: category!.id,
      })),
    )
    .returning();
  const [customer] = await db
    .insert(customers)
    .values({ email: `buyer-${id}@example.org`, firstName: 'Erika', lastName: 'Mustermann' })
    .returning();
  return {
    tax: tax!,
    venue: venue!,
    map: map!,
    event: event!,
    category: category!,
    ticketType: ticketType!,
    seated: seated!,
    standing: standing!,
    row: row!,
    seats: seatRows,
    customer: customer!,
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;
interface ItemSpec {
  f: Fixture;
  seatId: string | null;
}

/** Creates one order (customer of the first item's fixture) with 30 € items of any events. */
async function placeOrder(tx: Executor, items: ItemSpec[]) {
  const buyer = items[0]!.f.customer;
  const n = items.length;
  const [order] = await tx
    .insert(orders)
    .values({
      orderNumber: `T-${randomUUID()}`,
      customerId: buyer.id,
      status: 'PENDING',
      channel: 'ONLINE',
      paymentMethod: 'PAYPAL',
      email: buyer.email,
      firstName: buyer.firstName,
      lastName: buyer.lastName,
      locale: 'de-DE',
      currency: 'EUR',
      subtotalGross: 3000 * n,
      totalGross: 3000 * n,
      totalNet: 2804 * n,
      totalTax: 196 * n,
    })
    .returning();
  const created = await tx
    .insert(orderItems)
    .values(
      items.map(({ f, seatId }) => ({
        orderId: order!.id,
        eventId: f.event.id,
        kind: seatId ? ('SEAT' as const) : ('GENERAL_ADMISSION' as const),
        seatId,
        sectionId: seatId ? f.seated.id : f.standing.id,
        priceCategoryId: f.category.id,
        ticketTypeId: f.ticketType.id,
        status: 'PENDING' as const,
        sectionLabel: 'Parkett',
        categoryName: f.category.name,
        ticketTypeName: f.ticketType.name,
        unitPriceGross: 3000,
        priceGross: 3000,
        taxRateBasisPoints: 700,
        priceNet: 2804,
        taxAmount: 196,
      })),
    )
    .returning();
  return { order: order!, items: created };
}

describe.skipIf(!adminUrl)('database schema integrity (PostgreSQL)', () => {
  const dbName = `tix_test_${Date.now()}_${rand()}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let db: Database;
  let f: Fixture;
  let g: Fixture;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    await runMigrations({
      connectionString: url.toString(),
      migrationsFolder: resolve(import.meta.dirname, '../migrations'),
      log: () => {},
    });
    handle = createDb({ connectionString: url.toString(), poolMax: 20, lockTimeoutMs: 20_000 });
    db = handle.db;
    f = await createFixture(db);
    g = await createFixture(db);
  });

  afterAll(async () => {
    await handle?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  // ── Inventory ────────────────────────────────────────────────────────────
  it('rejects concurrent double booking of the same seat (partial unique index)', async () => {
    const seatId = f.seats[0]!.id;
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => db.transaction((tx) => placeOrder(tx, [{ f, seatId }]))),
    );
    const ok = attempts.filter((a) => a.status === 'fulfilled');
    const failed = attempts.filter((a): a is PromiseRejectedResult => a.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(7);
    for (const r of failed) {
      expect(isUniqueViolation(r.reason, 'order_items_active_seat_uq')).toBe(true);
    }
  });

  it('releases the seat once the holding item is cancelled', async () => {
    const seatId = f.seats[1]!.id;
    const first = await db.transaction((tx) => placeOrder(tx, [{ f, seatId }]));
    await expect(db.transaction((tx) => placeOrder(tx, [{ f, seatId }]))).rejects.toSatisfy((e) =>
      isUniqueViolation(e),
    );
    await db
      .update(orderItems)
      .set({ status: 'CANCELLED', cancelledAt: new Date() })
      .where(eq(orderItems.id, first.items[0]!.id));
    await expect(db.transaction((tx) => placeOrder(tx, [{ f, seatId }]))).resolves.toBeDefined();
  });

  it('never oversells a STANDING section under concurrency (conditional UPDATE + CHECK)', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        db.execute(
          sql`UPDATE seat_map_sections SET allocated_count = allocated_count + 1
              WHERE id = ${f.standing.id} AND allocated_count + 1 <= capacity RETURNING allocated_count`,
        ),
      ),
    );
    expect(results.reduce((n, r) => n + (r.rowCount ?? 0), 0)).toBe(2);
    await expect(
      db.execute(sql`UPDATE seat_map_sections SET allocated_count = 3 WHERE id = ${f.standing.id}`),
    ).rejects.toSatisfy((e) => isCheckViolation(e, 'seat_map_sections_allocation_within_capacity'));
  });

  // ── Multi-event cart ─────────────────────────────────────────────────────
  it('accepts one order containing tickets of several events', async () => {
    const { order, items } = await db.transaction((tx) =>
      placeOrder(tx, [
        { f: g, seatId: g.seats[0]!.id },
        { f: g, seatId: null },
        { f, seatId: null },
      ]),
    );
    expect(new Set(items.map((i) => i.eventId))).toEqual(new Set([f.event.id, g.event.id]));
    expect(order.totalGross).toBe(9000);
  });

  it('ties PER_EVENT fee lines to an event and PER_ORDER fee lines to none', async () => {
    const { order } = await db.transaction((tx) => placeOrder(tx, [{ f, seatId: null }]));
    const line = {
      orderId: order.id,
      name: 'Gebühr',
      quantity: 1,
      unitAmountGross: 107,
      totalGross: 107,
      taxRateBasisPoints: 700,
      totalNet: 100,
      totalTax: 7,
    };
    await expect(
      db.insert(orderFees).values({ ...line, scope: 'PER_EVENT', eventId: f.event.id }),
    ).resolves.toBeDefined();
    await expect(
      db.insert(orderFees).values({ ...line, scope: 'PER_ORDER' }),
    ).resolves.toBeDefined();
    await expect(
      db.insert(orderFees).values({ ...line, scope: 'PER_ORDER', eventId: f.event.id }),
    ).rejects.toSatisfy((e) => isCheckViolation(e, 'order_fees_event_scope'));
  });

  // ── Fees: global defaults, adjustable per event ──────────────────────────
  it('models global fees with per-event overrides', async () => {
    const [globalFee] = await db
      .insert(fees)
      .values({ name: 'Systemgebühr', scope: 'PER_TICKET', calculation: 'FIXED', value: 100 })
      .returning();
    const waive = {
      eventId: f.event.id,
      overridesFeeId: globalFee!.id,
      name: 'Systemgebühr',
      scope: 'PER_TICKET' as const,
      calculation: 'FIXED' as const,
      value: 0,
      isActive: false,
    };
    await expect(db.insert(fees).values(waive)).resolves.toBeDefined();
    await expect(db.insert(fees).values(waive)).rejects.toSatisfy((e) =>
      isUniqueViolation(e, 'fees_single_override_per_event_uq'),
    );
    await expect(
      db.insert(fees).values({
        eventId: f.event.id,
        name: 'Bearbeitung',
        scope: 'PER_ORDER',
        calculation: 'FIXED',
        value: 200,
        taxRateId: f.tax.id,
      }),
    ).rejects.toSatisfy((e) => isCheckViolation(e, 'fees_per_order_global'));
  });

  // ── Editable event seat maps ─────────────────────────────────────────────
  it('soft-removes seats from an event map and frees label/position for a replacement', async () => {
    const [extra] = await db
      .insert(seats)
      .values({
        seatMapId: g.map.id,
        sectionId: g.seated.id,
        rowId: g.row.id,
        label: '3',
        position: 3,
        x: 30,
        y: 0,
      })
      .returning();
    await db.transaction((tx) => placeOrder(tx, [{ f: g, seatId: extra!.id }]));

    // A seat that appears in an order cannot be hard-deleted …
    await expect(db.delete(seats).where(eq(seats.id, extra!.id))).rejects.toSatisfy((e) =>
      isRestrictViolation(e, 'order_items_seat_id_seats_id_fk'),
    );
    // … but it can be removed from the plan, and the position re-used (e.g. camera spot moved).
    await db.update(seats).set({ removedAt: new Date() }).where(eq(seats.id, extra!.id));
    await expect(
      db.insert(seats).values({
        seatMapId: g.map.id,
        sectionId: g.seated.id,
        rowId: g.row.id,
        label: '3',
        position: 3,
        x: 30,
        y: 0,
      }),
    ).resolves.toBeDefined();
  });

  // ── Access & numbering ───────────────────────────────────────────────────
  it('caps access code redemptions at max_redemptions', async () => {
    const [code] = await db
      .insert(accessCodes)
      .values({
        eventId: f.event.id,
        code: `VIP-${rand().toUpperCase()}`,
        type: 'SINGLE_USE',
        maxRedemptions: 1,
      })
      .returning();
    await db.update(accessCodes).set({ redemptionCount: 1 }).where(eq(accessCodes.id, code!.id));
    await expect(
      db.update(accessCodes).set({ redemptionCount: 2 }).where(eq(accessCodes.id, code!.id)),
    ).rejects.toSatisfy((e) => isCheckViolation(e, 'access_codes_redemptions'));
  });

  it('allocates gapless sequence numbers; rolled-back numbers are reused', async () => {
    const scope = `invoice:test-${rand()}`;
    const values = await Promise.all(
      Array.from({ length: 12 }, () => db.transaction((tx) => nextSequenceValue(tx, scope))),
    );
    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));

    await expect(
      db.transaction(async (tx) => {
        await nextSequenceValue(tx, scope);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await db.transaction((tx) => nextSequenceValue(tx, scope))).toBe(13);
  });

  // ── Referential & arithmetic integrity ───────────────────────────────────
  it('rejects events pointing to a TEMPLATE seat map', async () => {
    const [template] = await db
      .insert(seatMaps)
      .values({
        venueId: f.venue.id,
        kind: 'TEMPLATE',
        name: 'Template',
        canvasWidth: 10,
        canvasHeight: 10,
      })
      .returning();
    await expect(
      db.insert(events).values({
        venueId: f.venue.id,
        seatMapId: template!.id,
        slug: `bad-${rand()}`,
        title: 'Bad',
        startsAt: new Date(),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: f.tax.id,
      }),
    ).rejects.toSatisfy((e) => isForeignKeyViolation(e, 'events_seat_map_fk'));
  });

  it('rejects arithmetically inconsistent order totals', async () => {
    await expect(
      db.insert(orders).values({
        orderNumber: `T-${randomUUID()}`,
        customerId: f.customer.id,
        status: 'PENDING',
        channel: 'ONLINE',
        paymentMethod: 'PAYPAL',
        email: f.customer.email,
        firstName: 'A',
        lastName: 'B',
        locale: 'de-DE',
        currency: 'EUR',
        subtotalGross: 3000,
        totalGross: 2999,
        totalNet: 2803,
        totalTax: 196,
      }),
    ).rejects.toSatisfy((e) => isCheckViolation(e, 'orders_total_consistent'));
  });

  it('keeps one customer per e-mail address (case-insensitive) for guest and account', async () => {
    await expect(
      db.insert(customers).values({
        email: f.customer.email.toUpperCase(),
        firstName: 'Max',
        lastName: 'Muster',
      }),
    ).rejects.toSatisfy((e) => isUniqueViolation(e, 'customers_email_uq'));
    await expect(
      db
        .update(customers)
        .set({ passwordHash: '$argon2id$placeholder' })
        .where(eq(customers.id, f.customer.id)),
    ).rejects.toSatisfy((e) => isCheckViolation(e, 'customers_account_created'));
  });

  // ── Compliance & sync triggers ───────────────────────────────────────────
  it('keeps invoices immutable (GoBD trigger), allowing the PDF key to be set once', async () => {
    const { order } = await db.transaction((tx) => placeOrder(tx, [{ f, seatId: null }]));
    const [invoice] = await db
      .insert(invoices)
      .values({
        orderId: order.id,
        type: 'INVOICE',
        invoiceNumber: `RE-${rand()}`,
        seller: { name: 'Veranstalter e.V.' },
        buyer: { name: 'Erika Mustermann' },
        currency: 'EUR',
        totalNet: 2804,
        totalTax: 196,
        totalGross: 3000,
        taxBreakdown: [{ rateBasisPoints: 700, net: 2804, tax: 196, gross: 3000 }],
      })
      .returning();
    const byId = eq(invoices.id, invoice!.id);

    await expect(
      db.update(invoices).set({ pdfObjectKey: 'invoices/a.pdf' }).where(byId),
    ).resolves.toBeDefined();
    await expect(
      db.update(invoices).set({ pdfObjectKey: 'invoices/b.pdf' }).where(byId),
    ).rejects.toThrow();
    await expect(
      db.update(invoices).set({ totalGross: 1, totalNet: 1, totalTax: 0 }).where(byId),
    ).rejects.toThrow();
    await expect(db.delete(invoices).where(byId)).rejects.toSatisfy((e) => isRestrictViolation(e));
  });

  it('bumps tickets.sync_version on every update (scanner delta sync)', async () => {
    const { order, items } = await db.transaction((tx) => placeOrder(tx, [{ f, seatId: null }]));
    const [key] = await db
      .insert(eventSigningKeys)
      .values({
        eventId: f.event.id,
        keyId: `k${rand()}`,
        publicKey: 'pub',
        privateKeyEncrypted: 'enc',
      })
      .returning();
    const [ticket] = await db
      .insert(tickets)
      .values({
        orderItemId: items[0]!.id,
        orderId: order.id,
        eventId: f.event.id,
        ticketCode: rand().toUpperCase(),
        signingKeyId: key!.id,
        qrPayload: 'tix://v1/test',
      })
      .returning();
    const [updated] = await db
      .update(tickets)
      .set({ checkInState: 'CHECKED_IN', firstCheckedInAt: new Date(), checkInCount: 1 })
      .where(eq(tickets.id, ticket!.id))
      .returning();
    expect(updated!.syncVersion).toBeGreaterThan(ticket!.syncVersion);
  });
});
