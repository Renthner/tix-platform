/**
 * Ticket PDFs against real PostgreSQL (throw-away database) with in-memory object storage:
 * template resolution, one PDF per order (stored once per render), single-ticket download
 * authorisation, hidden block label and the fulfilment attachment.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  customers,
  emailMessages,
  events,
  loadRootEnv,
  orderItems,
  orders,
  priceCategories,
  seatMapSections,
  seatMaps,
  taxRates,
  ticketTemplates,
  tickets,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { seedReferenceData } from '@tix/db/seed';
import { DEFAULT_TICKET_PAGE_MM, defaultTicketLayout } from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { PDFDocument } from 'pdf-lib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assignCategoryTicketTemplate,
  assignEventTicketTemplate,
  builtinTicketTemplate,
  createCoreContext,
  createTicketTemplate,
  deleteTicketTemplate,
  enqueueEmail,
  ensureOrderTickets,
  processPaidOrder,
  renderOrderTicketsPdf,
  renderSingleTicketPdf,
  renderTicketPreviewPdf,
  resolveTicketTemplate,
  saveSetting,
  setDefaultTicketTemplate,
  type CoreContext,
} from '../src';
import { extractPdfText } from './pdf-extract';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const uuid = () => randomUUID();

async function drawnText(bytes: Uint8Array): Promise<string> {
  return (await extractPdfText(bytes)).join('\n');
}

describe.skipIf(!adminUrl || !redisUrl)('ticket PDFs (integration)', () => {
  const dbName = `tix_tpdf_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  const store = new Map<string, Uint8Array>();
  const jobs: { jobName: string }[] = [];
  let eventId: string;
  let otherEventId: string;
  let shownSectionId: string;
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
    handle = createDb({ connectionString: url.toString(), poolMax: 10 });
    await seedReferenceData(handle.db, () => {});
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${uuid().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      secrets: createSecretBox(parseKeyRing(generateKeyRingEntry('t1'))),
      storage: {
        put: async (_bucket: string, key: string, body: Uint8Array | string) => {
          store.set(key, typeof body === 'string' ? Buffer.from(body) : body);
        },
        get: async (_bucket: string, key: string) => {
          const body = store.get(key);
          if (!body) throw new Error('missing object');
          return { body, contentType: 'application/pdf' };
        },
        delete: async (_bucket: string, key: string) => void store.delete(key),
      } as unknown as NonNullable<CoreContext['storage']>,
      jobs: {
        add: async (_q: string, jobName: string) => {
          jobs.push({ jobName });
          return '';
        },
      } as unknown as NonNullable<CoreContext['jobs']>,
    });
    await saveSetting(ctx, 'invoicing', { issueInvoices: false } as never, null);

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
    const [shown] = await handle.db
      .insert(seatMapSections)
      .values({ ...sectionValues, name: 'Floor', ticketLabel: 'Floor' })
      .returning();
    const [hidden] = await handle.db
      .insert(seatMapSections)
      .values({ ...sectionValues, name: 'Secret', ticketLabel: 'Secret', showLabelOnTicket: false })
      .returning();
    shownSectionId = shown!.id;
    hiddenSectionId = hidden!.id;
    const [rate] = await handle.db
      .insert(taxRates)
      .values({ name: `vat-${uuid().slice(0, 6)}`, rateBasisPoints: 1900 })
      .returning();
    const makeEvent = async (title: string, seatMapId?: string) => {
      const [ev] = await handle.db
        .insert(events)
        .values({
          venueId: venue!.id,
          seatMapId,
          slug: `ev-${uuid().slice(0, 8)}`,
          title,
          startsAt: new Date(Date.now() + 30 * 86_400_000),
          timeZone: 'Europe/Berlin',
          currency: 'EUR',
          taxRateId: rate!.id,
        })
        .returning();
      return ev!.id;
    };
    eventId = await makeEvent('Show', map!.id);
    otherEventId = await makeEvent('Other show');
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

  async function insertPaidOrder(sections: string[]) {
    seq += 1;
    const email = `buyer${seq}-${uuid().slice(0, 6)}@example.org`;
    const [customer] = await handle.db
      .insert(customers)
      .values({ email, firstName: 'Ann', lastName: 'Example' })
      .returning();
    const total = sections.length * 2000;
    const [order] = await handle.db
      .insert(orders)
      .values({
        orderNumber: `T-2026-${1000 + seq}`,
        customerId: customer!.id,
        status: 'PAID',
        channel: 'ONLINE',
        paymentMethod: 'PAYPAL',
        email,
        firstName: 'Ann',
        lastName: 'Example',
        billingAddress: { street: 'Weg 1', postalCode: '12345', city: 'Stadt', country: 'DE' },
        locale: 'de',
        currency: 'EUR',
        subtotalGross: total,
        feeTotal: 0,
        totalGross: total,
        totalNet: total - 320 * sections.length,
        totalTax: 320 * sections.length,
        amountPaid: total,
        paidAt: new Date(),
      })
      .returning();
    await handle.db.insert(orderItems).values(
      sections.map((sectionId, n) => ({
        orderId: order!.id,
        eventId,
        kind: 'GENERAL_ADMISSION' as const,
        sectionId,
        priceCategoryId: categoryId,
        ticketTypeId,
        status: 'CONFIRMED' as const,
        sectionLabel: sectionId === hiddenSectionId ? `Secret ${n}` : `Floor ${n}`,
        categoryName: 'Cat 1',
        ticketTypeName: 'Normal',
        unitPriceGross: 2000,
        priceGross: 2000,
        taxRateBasisPoints: 1900,
        priceNet: 1680,
        taxAmount: 320,
      })),
    );
    return order!;
  }

  const layoutInput = (name: string) => ({
    name,
    pageWidthMm: 150,
    pageHeightMm: 80,
    layout: defaultTicketLayout(),
  });

  it('seeds a built-in default design (insert-only, idempotent)', async () => {
    await seedReferenceData(handle.db, () => {});
    const rows = await handle.db.select().from(ticketTemplates);
    expect(rows.filter((r) => r.isDefault)).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pageWidthMm).toBe(builtinTicketTemplate().pageWidthMm);
  });

  it('creates templates through the admin service and starts from the global default', async () => {
    const [seeded] = await handle.db.select().from(ticketTemplates);
    const resolved = await resolveTicketTemplate(handle.db, {
      eventId,
      priceCategoryId: categoryId,
    });
    expect(resolved.templateId).toBe(seeded!.id);
    const created = await createTicketTemplate(ctx, {
      input: layoutInput('Event design'),
      eventId,
      userId: null,
    });
    expect(created).toMatchObject({ eventId, pageWidthMm: 150, version: 1 });
    await deleteTicketTemplate(ctx, created.id);
  });

  it('uses the most specific assignment and ignores foreign-event templates', async () => {
    const eventTpl = (
      await handle.db
        .insert(ticketTemplates)
        .values({ ...layoutInput('Event design'), eventId, pageWidthMm: 150, pageHeightMm: 80 })
        .returning()
    )[0]!;
    const categoryTpl = (
      await handle.db
        .insert(ticketTemplates)
        .values({ ...layoutInput('VIP'), eventId, pageWidthMm: 120, pageHeightMm: 70 })
        .returning()
    )[0]!;
    const foreign = (
      await handle.db
        .insert(ticketTemplates)
        .values({ ...layoutInput('Foreign'), eventId: otherEventId })
        .returning()
    )[0]!;

    await assignEventTicketTemplate(ctx, eventId, eventTpl.id);
    expect(
      (await resolveTicketTemplate(handle.db, { eventId, priceCategoryId: categoryId })).templateId,
    ).toBe(eventTpl.id);

    await assignCategoryTicketTemplate(ctx, { eventId, categoryId, templateId: categoryTpl.id });
    const byCategory = await resolveTicketTemplate(handle.db, {
      eventId,
      priceCategoryId: categoryId,
    });
    expect(byCategory.templateId).toBe(categoryTpl.id);
    expect(byCategory.pageWidthMm).toBe(120);

    await expect(assignEventTicketTemplate(ctx, eventId, foreign.id)).rejects.toMatchObject({
      code: 'TEMPLATE_OTHER_EVENT',
    });

    // deleting the category template falls back to the event template (FK set null)
    await deleteTicketTemplate(ctx, categoryTpl.id);
    expect(
      (await resolveTicketTemplate(handle.db, { eventId, priceCategoryId: categoryId })).templateId,
    ).toBe(eventTpl.id);

    // invalid stored layouts are skipped
    await handle.db
      .update(ticketTemplates)
      .set({ layout: { version: 2 } as never })
      .where(eq(ticketTemplates.id, eventTpl.id));
    const [seeded] = await handle.db
      .select()
      .from(ticketTemplates)
      .where(eq(ticketTemplates.isDefault, true));
    expect((await resolveTicketTemplate(handle.db, { eventId })).templateId).toBe(seeded!.id);

    // the default cannot be deleted and moves with setDefault
    await expect(deleteTicketTemplate(ctx, seeded!.id)).rejects.toMatchObject({
      code: 'TEMPLATE_IS_DEFAULT',
    });
    await expect(setDefaultTicketTemplate(ctx, foreign.id)).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_GLOBAL',
    });

    await assignEventTicketTemplate(ctx, eventId, null);
  });

  it('falls back to the built-in design when no template exists', async () => {
    const [seeded] = await handle.db
      .select()
      .from(ticketTemplates)
      .where(eq(ticketTemplates.isDefault, true));
    await handle.db
      .update(ticketTemplates)
      .set({ isDefault: false })
      .where(eq(ticketTemplates.id, seeded!.id));
    const resolved = await resolveTicketTemplate(handle.db, { eventId });
    expect(resolved.templateId).toBeNull();
    expect(resolved.pageWidthMm).toBe(DEFAULT_TICKET_PAGE_MM.width);
    await handle.db
      .update(ticketTemplates)
      .set({ isDefault: true })
      .where(eq(ticketTemplates.id, seeded!.id));
  });

  it('renders one PDF per order with a page per ticket, stored once, hiding hidden block labels', async () => {
    const order = await insertPaidOrder([shownSectionId, hiddenSectionId, shownSectionId]);
    await ensureOrderTickets(ctx, order.id);

    const pdf = await renderOrderTicketsPdf(ctx, order.id);
    expect(pdf.ticketCount).toBe(3);
    expect(pdf.fileName).toBe(`Tickets-${order.orderNumber}.pdf`);
    expect(pdf.objectKey).toBe(`tickets/${new Date().getUTCFullYear()}/${order.orderNumber}.pdf`);
    const parsed = await PDFDocument.load(pdf.bytes);
    expect(parsed.getPageCount()).toBe(3);
    expect(store.get(pdf.objectKey!)).toBeDefined();
    const rows = await handle.db.select().from(tickets).where(eq(tickets.orderId, order.id));
    expect(rows.every((t) => t.pdfObjectKey === pdf.objectKey)).toBe(true);

    const text = await drawnText(pdf.bytes);
    expect(text).toContain('Floor 0');
    expect(text).not.toContain('Secret');
    expect(text).toContain('Stehplatz');

    // rendering again overwrites the same object (always current), no second file
    const keysBefore = store.size;
    await renderOrderTicketsPdf(ctx, order.id);
    expect(store.size).toBe(keysBefore);

    // not stored on request
    const keysNow = store.size;
    await renderOrderTicketsPdf(ctx, order.id, { store: false });
    expect(store.size).toBe(keysNow);
  });

  it('renders a single ticket only for its own order', async () => {
    const a = await insertPaidOrder([shownSectionId]);
    const b = await insertPaidOrder([shownSectionId]);
    const [ticketA] = await ensureOrderTickets(ctx, a.id);
    await ensureOrderTickets(ctx, b.id);
    const single = await renderSingleTicketPdf(ctx, ticketA!.id, a.id);
    expect((await PDFDocument.load(single.bytes)).getPageCount()).toBe(1);
    expect(single.fileName).toMatch(/^Ticket-[0-9A-Z-]+\.pdf$/);
    await expect(renderSingleTicketPdf(ctx, ticketA!.id, b.id)).rejects.toMatchObject({
      code: 'TICKET_NOT_FOUND',
      status: 404,
    });
    await handle.db
      .update(tickets)
      .set({ status: 'CANCELLED', voidedAt: new Date() })
      .where(eq(tickets.id, ticketA!.id));
    await expect(renderSingleTicketPdf(ctx, ticketA!.id, a.id)).rejects.toMatchObject({
      code: 'TICKET_NOT_FOUND',
    });
    await expect(renderOrderTicketsPdf(ctx, a.id)).rejects.toMatchObject({ code: 'NO_TICKETS' });
  });

  it('attaches the ticket PDF to the payment mail exactly once', async () => {
    const order = await insertPaidOrder([shownSectionId, shownSectionId]);
    const first = await processPaidOrder(ctx, order.id);
    expect(first.ticketCount).toBe(2);
    expect(first.messageId).toBeTruthy();
    const second = await processPaidOrder(ctx, order.id);
    expect(second.messageId).toBeNull();
    const messages = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.orderId, order.id));
    expect(messages).toHaveLength(1);
    const attachments = (messages[0]!.attachments as { attachments: { type: string }[] })
      .attachments;
    expect(attachments.filter((a) => a.type === 'tickets')).toHaveLength(1);
  });

  it('sends ticket mails without a PDF attachment while the order has no valid tickets', async () => {
    const order = await insertPaidOrder([shownSectionId]);
    const { messageId } = await enqueueEmail(ctx, { key: 'TICKETS_RESENT', orderId: order.id });
    const [row] = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, messageId));
    expect((row!.attachments as { attachments: unknown[] }).attachments).toEqual([]);
    await ensureOrderTickets(ctx, order.id);
    const again = await enqueueEmail(ctx, { key: 'TICKETS_RESENT', orderId: order.id });
    const [withTickets] = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, again.messageId));
    expect((withTickets!.attachments as { attachments: unknown[] }).attachments).toEqual([
      { type: 'tickets', orderId: order.id },
    ]);
  });

  it('renders a preview of an unsaved design', async () => {
    const bytes = await renderTicketPreviewPdf(
      ctx,
      { pageWidthMm: 100, pageHeightMm: 60, layout: defaultTicketLayout() },
      { eventId, locale: 'en' },
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(await drawnText(bytes)).toContain('Show');
  });
});
