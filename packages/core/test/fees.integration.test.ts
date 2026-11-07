/**
 * Fees & tax rates administration against real PostgreSQL: global fees, per-event
 * override / waive / reset, event-only fees, ordering and the tax-rate-in-use guard.
 * Runs in a throw-away database (created and dropped by the test).
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDb, events, fees, loadRootEnv, taxRates, venues, type DbHandle } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import type { FeeInput } from '@tix/shared';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../src/context';
import {
  createEventFee,
  createGlobalFee,
  deleteEventFee,
  deleteGlobalFee,
  getEventFees,
  listGlobalFees,
  reorderGlobalFees,
  resetEventFee,
  setEventFeeOverride,
  updateEventFee,
  updateGlobalFee,
  waiveEventFee,
} from '../src/fees';
import {
  createTaxRate,
  deleteTaxRate,
  listTaxRatesWithUsage,
  updateTaxRate,
} from '../src/tax-rates';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;

async function domainCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
}

const fee = (overrides: Partial<FeeInput> = {}): FeeInput => ({
  name: 'Service fee',
  scope: 'PER_TICKET',
  calculation: 'FIXED',
  value: 150,
  taxRateId: null,
  paymentMethods: null,
  channels: null,
  isActive: true,
  ...overrides,
});

describe.skipIf(!adminUrl)('fees & tax rates (integration)', () => {
  const dbName = `tix_fees_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let eventId: string;
  let eventTaxRateId: string;
  let otherEventId: string;

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
    handle = createDb({ connectionString: url.toString(), poolMax: 5 });
    const { db } = handle;
    const [venue] = await db
      .insert(venues)
      .values({ name: 'Hall', slug: 'hall', timeZone: 'Europe/Berlin' })
      .returning();
    const [tax] = await db
      .insert(taxRates)
      .values({ name: 'Standard', rateBasisPoints: 1900 })
      .returning();
    eventTaxRateId = tax!.id;
    const base = {
      venueId: venue!.id,
      startsAt: new Date(Date.now() + 30 * 86_400_000),
      timeZone: 'Europe/Berlin',
      currency: 'EUR',
      taxRateId: tax!.id,
    };
    const [ev] = await db
      .insert(events)
      .values({ ...base, slug: 'gala', title: 'Gala' })
      .returning();
    const [other] = await db
      .insert(events)
      .values({ ...base, slug: 'matinee', title: 'Matinee' })
      .returning();
    eventId = ev!.id;
    otherEventId = other!.id;
  });

  afterAll(async () => {
    await handle?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('manages tax rates with a single default and refuses deleting rates in use', async () => {
    const { db } = handle;
    const reduced = await createTaxRate(db, {
      name: 'Reduced',
      rateBasisPoints: 700,
      invoiceNote: null,
      isDefault: true,
      isActive: true,
      sortOrder: 10,
    });
    const exempt = await createTaxRate(db, {
      name: 'Exempt',
      rateBasisPoints: 0,
      invoiceNote: 'Tax-exempt service.',
      isDefault: true,
      isActive: true,
      sortOrder: 20,
    });
    let rows = await listTaxRatesWithUsage(db);
    expect(rows.filter((r) => r.isDefault).map((r) => r.id)).toEqual([exempt.id]);
    expect(rows.find((r) => r.id === eventTaxRateId)?.eventCount).toBe(2);

    expect(
      await domainCode(
        createTaxRate(db, {
          name: 'Reduced',
          rateBasisPoints: 1900,
          invoiceNote: null,
          isDefault: false,
          isActive: true,
          sortOrder: 0,
        }),
      ),
    ).toBe('TAX_RATE_NAME_TAKEN');
    expect(
      await domainCode(
        updateTaxRate(db, exempt.id, {
          name: 'Exempt',
          rateBasisPoints: 0,
          invoiceNote: null,
          isDefault: true,
          isActive: false,
          sortOrder: 20,
        }),
      ),
    ).toBe('TAX_RATE_INVALID');

    // deactivating keeps the row (and archives it), reactivating clears the archive date
    const { after: inactive } = await updateTaxRate(db, reduced.id, {
      name: 'Reduced 7 %',
      rateBasisPoints: 700,
      invoiceNote: null,
      isDefault: false,
      isActive: false,
      sortOrder: 10,
    });
    expect(inactive.archivedAt).toBeInstanceOf(Date);
    expect(inactive.name).toBe('Reduced 7 %');

    // used by an event → refused; used by a fee → refused; unused → deleted
    expect(await domainCode(deleteTaxRate(db, eventTaxRateId))).toBe('TAX_RATE_IN_USE');
    const orderFee = await createGlobalFee(
      db,
      fee({ name: 'Shipping', scope: 'PER_ORDER', taxRateId: reduced.id }),
    );
    expect(await domainCode(deleteTaxRate(db, reduced.id))).toBe('TAX_RATE_IN_USE');
    rows = await listTaxRatesWithUsage(db);
    expect(rows.find((r) => r.id === reduced.id)?.feeCount).toBe(1);
    await deleteGlobalFee(db, orderFee.id);
    await deleteTaxRate(db, reduced.id);
    await deleteTaxRate(db, exempt.id);
    expect(await domainCode(deleteTaxRate(db, exempt.id))).toBe('TAX_RATE_NOT_FOUND');
  });

  it('creates, updates and orders global fees', async () => {
    const { db } = handle;
    const first = await createGlobalFee(db, fee({ name: 'Ticket fee' }));
    const second = await createGlobalFee(
      db,
      fee({ name: 'PayPal surcharge', scope: 'PER_EVENT', calculation: 'PERCENT', value: 250 }),
    );
    expect(second.sortOrder).toBeGreaterThan(first.sortOrder);

    // PER_ORDER needs an explicit tax rate; percentages are capped at 100 %
    expect(await domainCode(createGlobalFee(db, fee({ scope: 'PER_ORDER' })))).toBe('FEE_INVALID');
    expect(
      await domainCode(createGlobalFee(db, fee({ calculation: 'PERCENT', value: 10_001 }))),
    ).toBe('FEE_INVALID');
    expect(await domainCode(createGlobalFee(db, fee({ taxRateId: randomUUID() })))).toBe(
      'TAX_RATE_NOT_FOUND',
    );

    const { after } = await updateGlobalFee(
      db,
      second.id,
      fee({
        name: 'PayPal surcharge',
        scope: 'PER_EVENT',
        calculation: 'PERCENT',
        value: 300,
        paymentMethods: ['PAYPAL'],
      }),
    );
    expect(after).toMatchObject({ value: 300, paymentMethods: ['PAYPAL'], channels: null });

    await reorderGlobalFees(db, [second.id, first.id]);
    expect((await listGlobalFees(db)).map((f) => f.id)).toEqual([second.id, first.id]);
    expect(await domainCode(reorderGlobalFees(db, [second.id]))).toBe('FEE_ORDER_INVALID');

    await deleteGlobalFee(db, second.id);
    await deleteGlobalFee(db, first.id);
    expect(await listGlobalFees(db)).toEqual([]);
  });

  it('overrides, waives and resets a global fee per event', async () => {
    const { db } = handle;
    const global = await createGlobalFee(db, fee({ name: 'Ticket fee', value: 200 }));

    let view = await getEventFees(db, eventId);
    expect(view.eventTaxRateId).toBe(eventTaxRateId);
    expect(view.globals).toHaveLength(1);
    expect(view.globals[0]).toMatchObject({ state: 'INHERITED', charged: true, override: null });
    expect(view.globals[0]!.effective.value).toBe(200);

    // override: own value and calculation for this event only
    const { before, after } = await setEventFeeOverride(
      db,
      eventId,
      global.id,
      fee({ name: 'Reduced ticket fee', calculation: 'PERCENT', value: 500, isActive: false }),
    );
    expect(before).toBeNull();
    expect(after).toMatchObject({
      eventId,
      overridesFeeId: global.id,
      calculation: 'PERCENT',
      value: 500,
      isActive: true,
      sortOrder: global.sortOrder,
    });
    view = await getEventFees(db, eventId);
    expect(view.globals[0]).toMatchObject({ state: 'OVERRIDDEN', charged: true });
    expect(view.globals[0]!.effective.id).toBe(after.id);
    expect(view.own).toEqual([]);
    // the other event still inherits the global fee
    expect((await getEventFees(db, otherEventId)).globals[0]!.state).toBe('INHERITED');

    // overriding again updates the same row
    const again = await setEventFeeOverride(db, eventId, global.id, fee({ value: 100 }));
    expect(again.before?.id).toBe(after.id);
    expect(again.after.id).toBe(after.id);

    // waive keeps the override values but deactivates them
    const waived = await waiveEventFee(db, eventId, global.id);
    expect(waived).toMatchObject({ id: after.id, isActive: false, value: 100 });
    view = await getEventFees(db, eventId);
    expect(view.globals[0]).toMatchObject({ state: 'WAIVED', charged: false });

    // waive without an existing override copies the global fee
    const waivedOther = await waiveEventFee(db, otherEventId, global.id);
    expect(waivedOther).toMatchObject({ value: 200, name: 'Ticket fee', isActive: false });

    expect((await listGlobalFees(db))[0]).toMatchObject({ overrideCount: 0, waivedCount: 2 });

    // a global fee with adjustments cannot become an order fee
    const taxRateId = eventTaxRateId;
    expect(
      await domainCode(
        updateGlobalFee(db, global.id, fee({ name: 'Ticket fee', scope: 'PER_ORDER', taxRateId })),
      ),
    ).toBe('FEE_HAS_OVERRIDES');

    // reset → inherited again
    expect((await resetEventFee(db, eventId, global.id))?.id).toBe(after.id);
    expect(await resetEventFee(db, eventId, global.id)).toBeNull();
    view = await getEventFees(db, eventId);
    expect(view.globals[0]).toMatchObject({ state: 'INHERITED', override: null });

    // deleting the global fee removes the remaining override (cascade)
    const { removedOverrides } = await deleteGlobalFee(db, global.id);
    expect(removedOverrides).toBe(1);
    const left = await db.select().from(fees).where(eq(fees.overridesFeeId, global.id));
    expect(left).toEqual([]);
  });

  it('keeps PER_ORDER fees global and manages event-only fees', async () => {
    const { db } = handle;
    const orderFee = await createGlobalFee(
      db,
      fee({ name: 'Handling', scope: 'PER_ORDER', taxRateId: eventTaxRateId }),
    );
    let view = await getEventFees(db, eventId);
    expect(view.globals).toEqual([]);
    expect(view.orderFees.map((f) => f.id)).toEqual([orderFee.id]);
    expect(await domainCode(setEventFeeOverride(db, eventId, orderFee.id, fee()))).toBe(
      'FEE_NOT_OVERRIDABLE',
    );
    expect(await domainCode(waiveEventFee(db, eventId, orderFee.id))).toBe('FEE_NOT_OVERRIDABLE');

    expect(
      await domainCode(
        createEventFee(db, eventId, fee({ scope: 'PER_ORDER', taxRateId: eventTaxRateId })),
      ),
    ).toBe('FEE_SCOPE_NOT_ALLOWED');
    expect(await domainCode(createEventFee(db, randomUUID(), fee()))).toBe('EVENT_NOT_FOUND');

    const own = await createEventFee(
      db,
      eventId,
      fee({ name: 'Cloakroom', scope: 'PER_EVENT', channels: ['BOX_OFFICE'] }),
    );
    expect(own.sortOrder).toBeGreaterThan(orderFee.sortOrder);
    view = await getEventFees(db, eventId);
    expect(view.own.map((f) => f.id)).toEqual([own.id]);
    expect((await getEventFees(db, otherEventId)).own).toEqual([]);

    const { after } = await updateEventFee(
      db,
      eventId,
      own.id,
      fee({ name: 'Cloakroom', scope: 'PER_TICKET', value: 50, sortOrder: 5 }),
    );
    expect(after).toMatchObject({ scope: 'PER_TICKET', value: 50, sortOrder: 5, channels: null });
    // event-only fees are scoped to their event; global fees are not event fees
    expect(await domainCode(updateEventFee(db, otherEventId, own.id, fee()))).toBe('FEE_NOT_FOUND');
    expect(await domainCode(deleteEventFee(db, eventId, orderFee.id))).toBe('FEE_NOT_FOUND');

    await deleteEventFee(db, eventId, own.id);
    await deleteGlobalFee(db, orderFee.id);
    expect(await db.select().from(fees)).toEqual([]);
  });
});
