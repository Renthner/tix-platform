/**
 * "Duplicate event" against real PostgreSQL (throw-away database): configuration copy with new
 * ids, date shifting, independent seat map, slug handling, no orders / access codes / old key.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  accessCodes,
  createDb,
  emailTemplates,
  eventSigningKeys,
  events,
  fees,
  loadRootEnv,
  orderItems,
  priceCategories,
  priceCategoryTicketTypes,
  queueConfigs,
  seatMapRows,
  seatMapSections,
  seatMaps,
  seats,
  taxRates,
  ticketTemplates,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { and, eq, isNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoreContext, duplicateEvent, ensureEventSigningKey, type CoreContext } from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();
const DAY = 86_400_000;
const NO_USER = null as never;

describe.skipIf(!adminUrl || !redisUrl)('duplicateEvent (integration)', () => {
  const dbName = `tix_dup_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let sourceId: string;
  let sourceMapId: string;
  let sourceStarts: Date;
  let sourceCategoryId: string;
  let sourceTemplateId: string;

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
      secrets: createSecretBox(parseKeyRing(generateKeyRingEntry('t1'))),
    });
    const db = handle.db;

    const [venue] = await db
      .insert(venues)
      .values({ name: 'Hall', slug: `hall-${uuid().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning();
    const [rate] = await db
      .insert(taxRates)
      .values({ name: `vat-${uuid().slice(0, 6)}`, rateBasisPoints: 1900 })
      .returning();
    const [map] = await db
      .insert(seatMaps)
      .values({
        venueId: venue!.id,
        kind: 'EVENT',
        name: 'Gala',
        canvasWidth: 500,
        canvasHeight: 300,
      })
      .returning();
    sourceMapId = map!.id;
    const [section] = await db
      .insert(seatMapSections)
      .values({
        seatMapId: sourceMapId,
        type: 'SEATED',
        name: 'Stalls',
        ticketLabel: 'Stalls',
        geometry: { type: 'rect', x: 0, y: 0, width: 200, height: 100, rotation: 0 },
      })
      .returning();
    const [row] = await db
      .insert(seatMapRows)
      .values({
        seatMapId: sourceMapId,
        sectionId: section!.id,
        label: 'A',
        sortOrder: 1,
        geometry: {
          curve: { type: 'straight', start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
          seatSpacing: 20,
          numbering: 'ASCENDING',
          labelPlacement: 'BOTH',
        },
      })
      .returning();

    sourceStarts = new Date(Date.now() + 30 * DAY);
    const [ev] = await db
      .insert(events)
      .values({
        venueId: venue!.id,
        seatMapId: sourceMapId,
        slug: 'gala',
        title: 'Gala',
        subtitle: 'Sub',
        status: 'PUBLISHED',
        startsAt: sourceStarts,
        doorsOpenAt: new Date(sourceStarts.getTime() - 3_600_000),
        endsAt: new Date(sourceStarts.getTime() + 3 * 3_600_000),
        presaleStartsAt: new Date(sourceStarts.getTime() - 20 * DAY),
        publicSaleStartsAt: new Date(sourceStarts.getTime() - 10 * DAY),
        saleEndsAt: new Date(sourceStarts.getTime() - 3_600_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: rate!.id,
        shopSortOrder: 3,
        maxTicketsPerOrder: 5,
        orphanSeatRuleEnabled: true,
        paypalEnabled: false,
        bankTransferCancelAfterDays: 9,
        pageLayout: [[{ ref: 'SHOP', span: 1 }]],
        infoBoxes: [{ id: 'x', title: 'Hi' }] as never,
        googleWalletClassId: 'old.class',
      })
      .returning();
    sourceId = ev!.id;

    const [cat] = await db
      .insert(priceCategories)
      .values({ eventId: sourceId, name: 'Cat 1', color: '#336699', basePrice: 4000 })
      .returning();
    sourceCategoryId = cat!.id;
    const [normal] = await db
      .insert(ticketTypes)
      .values({ eventId: sourceId, name: 'Normal', isDefault: true })
      .returning();
    const [reduced] = await db
      .insert(ticketTypes)
      .values({
        eventId: sourceId,
        name: 'Reduced',
        discountKind: 'FIXED_AMOUNT',
        discountValue: 500,
        requiresProofAtEntry: true,
        scannerWarning: 'Check proof',
      })
      .returning();
    await db.insert(priceCategoryTicketTypes).values([
      { priceCategoryId: cat!.id, ticketTypeId: normal!.id },
      {
        priceCategoryId: cat!.id,
        ticketTypeId: reduced!.id,
        discountKind: 'FIXED_AMOUNT',
        discountValue: 700,
      },
    ]);
    await db.insert(fees).values({
      eventId: sourceId,
      name: 'Presale fee',
      scope: 'PER_TICKET',
      calculation: 'FIXED',
      value: 150,
    });
    const [tpl] = await db
      .insert(ticketTemplates)
      .values({
        eventId: sourceId,
        name: 'Event layout',
        pageWidthMm: 150,
        pageHeightMm: 80,
        layout: { elements: [] } as never,
      })
      .returning();
    sourceTemplateId = tpl!.id;
    await db.update(events).set({ ticketTemplateId: tpl!.id }).where(eq(events.id, sourceId));
    await db.insert(queueConfigs).values({
      eventId: sourceId,
      mode: 'AUTO_THRESHOLD',
      activeSessionThreshold: 77,
      admissionBatchSize: 10,
      admissionIntervalSeconds: 5,
      passTokenTtlSeconds: 600,
    });
    await db.insert(emailTemplates).values({
      key: 'ORDER_CONFIRMATION_BANK_TRANSFER',
      eventId: sourceId,
      locale: 'en',
      subject: 'Override',
      bodyHtml: '<p>x</p>',
    });
    await db.insert(accessCodes).values({ eventId: sourceId, code: 'VIPCODE', type: 'MULTI_USE' });

    // seats in row A: 2 blocked, 4 soft-removed, 1 with a category
    const mk = (n: number) => ({
      seatMapId: sourceMapId,
      sectionId: section!.id,
      rowId: row!.id,
      label: String(n),
      position: n,
      x: n * 20,
      y: 0,
    });
    await db
      .insert(seats)
      .values([
        { ...mk(1), priceCategoryId: sourceCategoryId },
        { ...mk(2), blockReason: 'PRESS', blockedAt: new Date(), blockNote: 'camera' },
        mk(3),
        { ...mk(4), removedAt: new Date() },
      ]);
    await ensureEventSigningKey(ctx, sourceId);
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

  it('copies the configuration with new ids, shifted dates, DRAFT and a fresh key', async () => {
    const db = handle.db;
    const [before] = await db.select().from(events).where(eq(events.id, sourceId));
    const newStart = new Date(sourceStarts.getTime() + 100 * DAY);
    const { eventId, slug } = await duplicateEvent(ctx, {
      sourceEventId: sourceId,
      userId: NO_USER,
      title: 'Gala 2',
      startsAt: newStart,
    });
    expect(slug).toBe('gala-2');
    const [copy] = await db.select().from(events).where(eq(events.id, eventId));
    expect(copy!.id).not.toBe(sourceId);
    expect(copy).toMatchObject({
      title: 'Gala 2',
      subtitle: 'Sub',
      status: 'DRAFT',
      shopSortOrder: null,
      googleWalletClassId: null,
      publishedAt: null,
      maxTicketsPerOrder: 5,
      orphanSeatRuleEnabled: true,
      paypalEnabled: false,
      bankTransferCancelAfterDays: 9,
      clonedFromId: sourceId,
      venueId: before!.venueId,
      taxRateId: before!.taxRateId,
    });
    expect(copy!.pageLayout).toEqual(before!.pageLayout);
    expect(copy!.infoBoxes).toEqual(before!.infoBoxes);
    const hm = (d: Date) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Berlin',
        hour: '2-digit',
        minute: '2-digit',
      }).format(d);
    expect(copy!.startsAt.getTime()).toBe(newStart.getTime());
    for (const key of [
      'doorsOpenAt',
      'endsAt',
      'presaleStartsAt',
      'publicSaleStartsAt',
      'saleEndsAt',
    ] as const) {
      // same local time of day, moved by ~100 days (DST may change the absolute offset by 1 h)
      expect(hm(copy![key]!)).toBe(hm(before![key]!));
      expect(
        Math.abs(copy![key]!.getTime() - before![key]!.getTime() - 100 * DAY),
      ).toBeLessThanOrEqual(3_600_000);
    }

    // categories, tariffs, matrix
    const cats = await db
      .select()
      .from(priceCategories)
      .where(eq(priceCategories.eventId, eventId));
    expect(cats).toHaveLength(1);
    expect(cats[0]).toMatchObject({ name: 'Cat 1', basePrice: 4000 });
    expect(cats[0]!.id).not.toBe(sourceCategoryId);
    const types = await db.select().from(ticketTypes).where(eq(ticketTypes.eventId, eventId));
    expect(types.map((t) => t.name).sort()).toEqual(['Normal', 'Reduced']);
    expect(types.find((t) => t.name === 'Normal')!.isDefault).toBe(true);
    const matrix = await db
      .select()
      .from(priceCategoryTicketTypes)
      .where(eq(priceCategoryTicketTypes.priceCategoryId, cats[0]!.id));
    expect(matrix).toHaveLength(2);
    const reducedId = types.find((t) => t.name === 'Reduced')!.id;
    expect(matrix.find((m) => m.ticketTypeId === reducedId)).toMatchObject({ discountValue: 700 });

    // fees, queue, mail override
    const copiedFees = await db.select().from(fees).where(eq(fees.eventId, eventId));
    expect(copiedFees).toMatchObject([{ name: 'Presale fee', value: 150 }]);
    const [queue] = await db.select().from(queueConfigs).where(eq(queueConfigs.eventId, eventId));
    expect(queue).toMatchObject({ mode: 'AUTO_THRESHOLD', activeSessionThreshold: 77 });
    const mails = await db.select().from(emailTemplates).where(eq(emailTemplates.eventId, eventId));
    expect(mails).toMatchObject([{ subject: 'Override' }]);

    // event ticket template re-pointed to its own copy
    const tpls = await db
      .select()
      .from(ticketTemplates)
      .where(eq(ticketTemplates.eventId, eventId));
    expect(tpls).toHaveLength(1);
    expect(tpls[0]!.id).not.toBe(sourceTemplateId);
    expect(copy!.ticketTemplateId).toBe(tpls[0]!.id);

    // not copied: orders, access codes; fresh key
    expect(await db.select().from(orderItems).where(eq(orderItems.eventId, eventId))).toHaveLength(
      0,
    );
    expect(
      await db.select().from(accessCodes).where(eq(accessCodes.eventId, eventId)),
    ).toHaveLength(0);
    const keys = await db
      .select()
      .from(eventSigningKeys)
      .where(eq(eventSigningKeys.eventId, eventId));
    const oldKeys = await db
      .select()
      .from(eventSigningKeys)
      .where(eq(eventSigningKeys.eventId, sourceId));
    expect(keys).toHaveLength(1);
    expect(keys[0]!.publicKey).not.toBe(oldKeys[0]!.publicKey);

    // source untouched
    const [after] = await db.select().from(events).where(eq(events.id, sourceId));
    expect(after).toEqual(before);
  });

  it('copies the seat map independently (blocks kept, soft-removed skipped, categories mapped)', async () => {
    const db = handle.db;
    const { eventId } = await duplicateEvent(ctx, {
      sourceEventId: sourceId,
      userId: NO_USER,
      title: 'Gala map',
      startsAt: sourceStarts,
    });
    const [copy] = await db.select().from(events).where(eq(events.id, eventId));
    expect(copy!.seatMapId).toBeTruthy();
    expect(copy!.seatMapId).not.toBe(sourceMapId);
    const copySeats = await db
      .select()
      .from(seats)
      .where(and(eq(seats.seatMapId, copy!.seatMapId!), isNull(seats.removedAt)));
    expect(copySeats.map((s) => s.label).sort()).toEqual(['1', '2', '3']);
    const blocked = copySeats.find((s) => s.label === '2')!;
    expect(blocked).toMatchObject({ blockReason: 'PRESS', blockNote: 'camera' });
    expect(blocked.blockedAt).toBeInstanceOf(Date);
    const [newCat] = await db
      .select()
      .from(priceCategories)
      .where(eq(priceCategories.eventId, eventId));
    expect(copySeats.find((s) => s.label === '1')!.priceCategoryId).toBe(newCat!.id);

    // editing the copy does not touch the source
    await db
      .update(seats)
      .set({ label: '99', blockReason: null, blockedAt: null })
      .where(eq(seats.id, blocked.id));
    const sourceSeats = await db
      .select()
      .from(seats)
      .where(and(eq(seats.seatMapId, sourceMapId), isNull(seats.removedAt)));
    expect(sourceSeats.map((s) => s.label).sort()).toEqual(['1', '2', '3']);
    expect(sourceSeats.find((s) => s.label === '2')!.blockReason).toBe('PRESS');
  });

  it('handles slugs: derived suffix on collision, explicit taken -> SLUG_TAKEN', async () => {
    const a = await duplicateEvent(ctx, {
      sourceEventId: sourceId,
      userId: NO_USER,
      title: 'Gala',
      startsAt: sourceStarts,
    });
    const b = await duplicateEvent(ctx, {
      sourceEventId: sourceId,
      userId: NO_USER,
      title: 'Gala',
      startsAt: sourceStarts,
    });
    expect(a.slug).toMatch(/^gala-\d+$/);
    expect(b.slug).toMatch(/^gala-\d+$/);
    expect(b.slug).not.toBe(a.slug);
    await expect(
      duplicateEvent(ctx, {
        sourceEventId: sourceId,
        userId: NO_USER,
        title: 'Other',
        slug: 'gala',
        startsAt: sourceStarts,
      }),
    ).rejects.toMatchObject({ code: 'SLUG_TAKEN' });
    await expect(
      duplicateEvent(ctx, {
        sourceEventId: uuid(),
        userId: NO_USER,
        title: 'x',
        startsAt: sourceStarts,
      }),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND' });
  });

  it('keeps the local wall-clock time of derived dates across DST', async () => {
    const db = handle.db;
    const [src] = await db.select().from(events).where(eq(events.id, sourceId));
    const start = new Date('2026-10-20T17:30:00Z'); // 19:30 CEST
    await db
      .update(events)
      .set({
        startsAt: start,
        doorsOpenAt: new Date('2026-10-20T16:30:00Z'), // 18:30 CEST
        endsAt: null,
        presaleStartsAt: null,
        publicSaleStartsAt: null,
        saleEndsAt: null,
      })
      .where(eq(events.id, sourceId));
    try {
      const { eventId } = await duplicateEvent(ctx, {
        sourceEventId: sourceId,
        userId: NO_USER,
        title: 'DST copy',
        startsAt: new Date('2026-11-10T18:30:00Z'), // 19:30 CET
      });
      const [copy] = await db.select().from(events).where(eq(events.id, eventId));
      expect(copy!.doorsOpenAt!.toISOString()).toBe('2026-11-10T17:30:00.000Z'); // 18:30 CET
    } finally {
      await db
        .update(events)
        .set({
          startsAt: src!.startsAt,
          doorsOpenAt: src!.doorsOpenAt,
          endsAt: src!.endsAt,
          presaleStartsAt: src!.presaleStartsAt,
          publicSaleStartsAt: src!.publicSaleStartsAt,
          saleEndsAt: src!.saleEndsAt,
        })
        .where(eq(events.id, sourceId));
    }
  });
});
