import {
  events,
  orderItems,
  priceCategories,
  seatMapSections,
  ticketTemplates,
  tickets,
  venues,
  type Executor,
} from '@tix/db';
import {
  DEFAULT_TICKET_PAGE_MM,
  defaultTicketLayout,
  formatTicketCode,
  ticketLayoutSchema,
  type TicketLayout,
} from '@tix/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { DomainError, requireCapability, type CoreContext } from '../context';
import { loadOrderDocumentData } from '../documents/order-data';
import { yearIn } from '../format';
import { documentLocale, mailTranslator } from '../i18n/mail-messages';
import { loadMediaBytes } from '../media';
import { getSetting } from '../settings';
import { placeOrderBy } from './order';
import {
  TicketPdfResources,
  renderTicketPage,
  type RenderTicketPageOptions,
  type TicketImageSource,
  type TicketPageTemplate,
  type TicketRenderData,
} from './pdf';

/**
 * Database side of ticket PDFs: template resolution (category override, event template,
 * global default, built-in default), data assembly and the stored order PDF.
 *
 * Storage decision: **one PDF per order** at `tickets/<yyyy>/<orderNumber>.pdf` in the
 * `documents` bucket (overwritten whenever it is rendered again, so it always matches the
 * current tickets) – there is no per-ticket file. `tickets.pdf_object_key` of every ticket in
 * the PDF points at that object. Single-ticket downloads are rendered on demand.
 */

export interface ResolvedTicketTemplate extends TicketPageTemplate {
  /** null = the built-in design (no DB row). */
  templateId: string | null;
  backgroundAssetId: string | null;
}

export function builtinTicketTemplate(): ResolvedTicketTemplate {
  return {
    templateId: null,
    pageWidthMm: DEFAULT_TICKET_PAGE_MM.width,
    pageHeightMm: DEFAULT_TICKET_PAGE_MM.height,
    backgroundAssetId: null,
    layout: defaultTicketLayout(),
  };
}

type TemplateRow = typeof ticketTemplates.$inferSelect;

function usable(row: TemplateRow | undefined): ResolvedTicketTemplate | null {
  if (!row) return null;
  const layout = ticketLayoutSchema.safeParse(row.layout);
  if (!layout.success) {
    console.warn(`[tickets] template ${row.id} has an invalid layout, skipping it`);
    return null;
  }
  return {
    templateId: row.id,
    pageWidthMm: row.pageWidthMm,
    pageHeightMm: row.pageHeightMm,
    backgroundAssetId: row.backgroundAssetId,
    layout: layout.data,
  };
}

/**
 * Template for a ticket: price category override -> event template -> global default ->
 * built-in. A template that does not validate is skipped (the next level is used).
 */
export async function resolveTicketTemplate(
  db: Executor,
  params: { eventId: string; priceCategoryId?: string | null },
): Promise<ResolvedTicketTemplate> {
  const byId = async (id: string | null | undefined) => {
    if (!id) return null;
    const [row] = await db.select().from(ticketTemplates).where(eq(ticketTemplates.id, id));
    return usable(row);
  };
  if (params.priceCategoryId) {
    const [category] = await db
      .select({ templateId: priceCategories.ticketTemplateId })
      .from(priceCategories)
      .where(eq(priceCategories.id, params.priceCategoryId));
    const found = await byId(category?.templateId);
    if (found) return found;
  }
  const [event] = await db
    .select({ templateId: events.ticketTemplateId })
    .from(events)
    .where(eq(events.id, params.eventId));
  const forEvent = await byId(event?.templateId);
  if (forEvent) return forEvent;
  const [fallback] = await db
    .select()
    .from(ticketTemplates)
    .where(eq(ticketTemplates.isDefault, true));
  return usable(fallback) ?? builtinTicketTemplate();
}

function pageOptions(
  ctx: CoreContext,
  template: ResolvedTicketTemplate,
  coverAssetId: string | null,
  extra: Partial<RenderTicketPageOptions> = {},
): RenderTicketPageOptions {
  const load = async (id: string): Promise<TicketImageSource | null> => {
    const media = await loadMediaBytes(ctx, id);
    return { bytes: media.bytes, mimeType: media.mimeType };
  };
  return {
    background: template.backgroundAssetId ? () => load(template.backgroundAssetId!) : undefined,
    backgroundKey: `asset:${template.backgroundAssetId}`,
    cover: coverAssetId ? () => load(coverAssetId) : undefined,
    coverKey: `asset:${coverAssetId}`,
    asset: load,
    ...extra,
  };
}

interface PlannedTicket {
  ticketId: string;
  ticketCode: string;
  template: ResolvedTicketTemplate;
  coverAssetId: string | null;
  data: TicketRenderData;
}

interface OrderPlan {
  orderNumber: string;
  orderYear: string;
  locale: string;
  tickets: PlannedTicket[];
}

/** Everything needed to render the VALID tickets of an order (chronological, seat order). */
async function planOrderTickets(
  ctx: CoreContext,
  orderId: string,
  onlyTicketId?: string,
): Promise<OrderPlan> {
  const docData = await loadOrderDocumentData(ctx.db, orderId);
  if (!docData) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
  const { order, items } = docData;
  const ticketRows = await ctx.db
    .select({ ticket: tickets })
    .from(tickets)
    .innerJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
    .innerJoin(events, eq(events.id, tickets.eventId))
    .where(
      and(
        eq(tickets.orderId, orderId),
        eq(tickets.status, 'VALID'),
        ...(onlyTicketId ? [eq(tickets.id, onlyTicketId)] : []),
      ),
    )
    .orderBy(...placeOrderBy());
  const byItem = new Map(ticketRows.map((r) => [r.ticket.orderItemId, r.ticket]));
  // PDF pages follow the canonical ticket order (same as order page, wallet buttons, ticket list).
  const rank = new Map(ticketRows.map((r, i) => [r.ticket.orderItemId, i]));
  items.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));

  const sectionIds = [...new Set(items.map((i) => i.sectionId))];
  const sections = sectionIds.length
    ? await ctx.db
        .select({ id: seatMapSections.id, show: seatMapSections.showLabelOnTicket })
        .from(seatMapSections)
        .where(inArray(seatMapSections.id, sectionIds))
    : [];
  const showLabel = new Map(sections.map((s) => [s.id, s.show]));
  const eventIds = [...new Set(items.map((i) => i.eventId))];
  const heroes = eventIds.length
    ? await ctx.db
        .select({ id: events.id, hero: events.heroImageAssetId })
        .from(events)
        .where(inArray(events.id, eventIds))
    : [];
  const hero = new Map(heroes.map((h) => [h.id, h.hero]));
  const [general, organizer] = await Promise.all([
    getSetting(ctx, 'general'),
    getSetting(ctx, 'organizer'),
  ]);
  const organizerName = organizer.legalName?.trim() || general.shopName;
  const locale = documentLocale(order.locale);
  const buyerName = `${order.firstName} ${order.lastName}`.trim();

  const templates = new Map<string, ResolvedTicketTemplate>();
  const planned: PlannedTicket[] = [];
  for (const item of items) {
    const ticket = byItem.get(item.id);
    const event = docData.eventById.get(item.eventId);
    if (!ticket || !event) continue;
    const key = `${item.eventId}:${item.priceCategoryId}`;
    let template = templates.get(key);
    if (!template) {
      template = await resolveTicketTemplate(ctx.db, {
        eventId: item.eventId,
        priceCategoryId: item.priceCategoryId,
      });
      templates.set(key, template);
    }
    planned.push({
      ticketId: ticket.id,
      ticketCode: ticket.ticketCode,
      template,
      coverAssetId: hero.get(item.eventId) ?? null,
      data: {
        locale,
        timeZone: event.timeZone,
        eventTitle: event.title,
        eventSubtitle: event.subtitle,
        startsAt: event.startsAt,
        doorsOpenAt: event.doorsOpenAt,
        venueName: event.venueName,
        venueAddress: event.venueAddress,
        kind: item.kind,
        // show_label_on_ticket off: the block label is not printed (nor part of the QR seat info).
        sectionLabel: showLabel.get(item.sectionId) === false ? '' : item.sectionLabel,
        rowLabel: item.rowLabel,
        seatLabel: item.seatLabel,
        entranceLabel: item.entranceLabel,
        priceCategory: item.categoryName,
        ticketType: item.ticketTypeName,
        priceGross: item.priceGross,
        currency: order.currency,
        buyerName,
        attendeeName: ticket.attendeeName ?? item.attendeeName,
        orderNumber: order.orderNumber,
        ticketCode: formatTicketCode(ticket.ticketCode),
        organizerName,
        qrPayload: ticket.qrPayload,
      },
    });
  }
  return {
    orderNumber: order.orderNumber,
    orderYear: yearIn(order.createdAt, 'UTC'),
    locale,
    tickets: planned,
  };
}

async function renderPlanned(ctx: CoreContext, planned: PlannedTicket[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setCreator('tix-platform');
  doc.setProducer('tix-platform');
  const res = new TicketPdfResources(doc);
  for (const entry of planned) {
    await renderTicketPage(
      res,
      entry.template,
      entry.data,
      pageOptions(ctx, entry.template, entry.coverAssetId),
    );
  }
  return doc.save();
}

const safeName = (name: string) => name.replace(/[^\w.-]+/g, '_');

export interface TicketsPdf {
  bytes: Uint8Array;
  fileName: string;
  ticketCount: number;
  /** Set when the PDF was stored in the documents bucket. */
  objectKey: string | null;
}

export function orderTicketsObjectKey(orderYear: string, orderNumber: string): string {
  return `tickets/${orderYear}/${safeName(orderNumber)}.pdf`;
}

/**
 * One PDF with a page per VALID ticket of the order. With `store` (default) the file is
 * written to `tickets/<yyyy>/<orderNumber>.pdf` and the tickets' `pdf_object_key` is set.
 */
export async function renderOrderTicketsPdf(
  ctx: CoreContext,
  orderId: string,
  options: { store?: boolean } = {},
): Promise<TicketsPdf> {
  const plan = await planOrderTickets(ctx, orderId);
  if (plan.tickets.length === 0) {
    throw new DomainError('NO_TICKETS', 'The order has no valid tickets', 404);
  }
  const bytes = await renderPlanned(ctx, plan.tickets);
  const t = mailTranslator(plan.locale);
  const fileName = safeName(t('ticket.fileName', { number: plan.orderNumber }));
  let objectKey: string | null = null;
  if (options.store ?? true) {
    objectKey = orderTicketsObjectKey(plan.orderYear, plan.orderNumber);
    await requireCapability(ctx, 'storage').put('documents', objectKey, bytes, 'application/pdf');
    await ctx.db
      .update(tickets)
      .set({ pdfObjectKey: objectKey })
      .where(
        inArray(
          tickets.id,
          plan.tickets.map((p) => p.ticketId),
        ),
      );
  }
  return { bytes, fileName, ticketCount: plan.tickets.length, objectKey };
}

/** A single VALID ticket as its own one-page PDF (rendered on demand, not stored). */
export async function renderSingleTicketPdf(
  ctx: CoreContext,
  ticketId: string,
  /** When set, the ticket must belong to this order (download authorisation). */
  expectedOrderId?: string,
): Promise<TicketsPdf & { orderId: string }> {
  const [row] = await ctx.db
    .select({ orderId: tickets.orderId, status: tickets.status, code: tickets.ticketCode })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  if (!row || row.status !== 'VALID' || (expectedOrderId && row.orderId !== expectedOrderId)) {
    throw new DomainError('TICKET_NOT_FOUND', 'Ticket not found', 404);
  }
  const plan = await planOrderTickets(ctx, row.orderId, ticketId);
  if (plan.tickets.length === 0) throw new DomainError('TICKET_NOT_FOUND', 'Ticket not found', 404);
  const bytes = await renderPlanned(ctx, plan.tickets);
  const t = mailTranslator(plan.locale);
  return {
    bytes,
    fileName: safeName(t('ticket.singleFileName', { code: formatTicketCode(row.code) })),
    ticketCount: 1,
    objectKey: null,
    orderId: row.orderId,
  };
}

export interface TicketPreviewDraft {
  pageWidthMm: number;
  pageHeightMm: number;
  backgroundAssetId?: string | null;
  layout: TicketLayout;
}

/**
 * Preview of an (unsaved) design: sample data, or the event's real title / date / venue /
 * cover when `eventId` is given. The QR code carries a placeholder, never a valid signature.
 */
export async function renderTicketPreviewPdf(
  ctx: CoreContext,
  draft: TicketPreviewDraft,
  options: { eventId?: string | null; locale?: string | null } = {},
): Promise<Uint8Array> {
  const locale = documentLocale(options.locale);
  const [general, organizer] = await Promise.all([
    getSetting(ctx, 'general'),
    getSetting(ctx, 'organizer'),
  ]);
  let data: TicketRenderData = {
    locale,
    timeZone: general.defaultTimeZone,
    eventTitle: locale === 'de' ? 'Beispiel-Veranstaltung' : 'Sample event',
    eventSubtitle: locale === 'de' ? 'Untertitel der Veranstaltung' : 'Event subtitle',
    startsAt: new Date(Date.UTC(new Date().getUTCFullYear() + 1, 5, 14, 17, 30)),
    doorsOpenAt: new Date(Date.UTC(new Date().getUTCFullYear() + 1, 5, 14, 16, 30)),
    venueName: locale === 'de' ? 'Stadthalle' : 'City hall',
    venueAddress: 'Main Street 1, 12345 Sample City',
    kind: 'SEAT',
    sectionLabel: 'A',
    rowLabel: '7',
    seatLabel: '12',
    entranceLabel: 'North',
    priceCategory: locale === 'de' ? 'Kategorie 1' : 'Category 1',
    ticketType: locale === 'de' ? 'Normalpreis' : 'Standard',
    priceGross: 3500,
    currency: general.defaultCurrency,
    buyerName: locale === 'de' ? 'Erika Mustermann' : 'Jane Doe',
    attendeeName: locale === 'de' ? 'Erika Mustermann' : 'Jane Doe',
    orderNumber: 'ORD-2026-000123',
    ticketCode: 'ABCDE-FGHJK',
    organizerName: organizer.legalName?.trim() || general.shopName,
    qrPayload: `tix://v1/sample.${'A'.repeat(22)}.${'B'.repeat(22)}.${'C'.repeat(14)}.${'D'.repeat(86)}`,
  };
  let coverAssetId: string | null = null;
  if (options.eventId) {
    const [event] = await ctx.db
      .select({
        title: events.title,
        subtitle: events.subtitle,
        startsAt: events.startsAt,
        doorsOpenAt: events.doorsOpenAt,
        timeZone: events.timeZone,
        hero: events.heroImageAssetId,
        venue: venues.name,
        street: venues.street,
        postalCode: venues.postalCode,
        city: venues.city,
        currency: events.currency,
      })
      .from(events)
      .innerJoin(venues, eq(venues.id, events.venueId))
      .where(eq(events.id, options.eventId));
    if (event) {
      coverAssetId = event.hero;
      data = {
        ...data,
        eventTitle: event.title,
        eventSubtitle: event.subtitle,
        startsAt: event.startsAt,
        doorsOpenAt: event.doorsOpenAt,
        timeZone: event.timeZone,
        currency: event.currency,
        venueName: event.venue,
        venueAddress:
          [event.street, [event.postalCode, event.city].filter(Boolean).join(' ')]
            .filter(Boolean)
            .join(', ') || null,
      };
    }
  }
  const template: ResolvedTicketTemplate = {
    templateId: null,
    pageWidthMm: draft.pageWidthMm,
    pageHeightMm: draft.pageHeightMm,
    backgroundAssetId: draft.backgroundAssetId ?? null,
    layout: draft.layout,
  };
  const doc = await PDFDocument.create();
  const res = new TicketPdfResources(doc);
  await renderTicketPage(
    res,
    template,
    data,
    pageOptions(ctx, template, coverAssetId, { coverPlaceholder: true }),
  );
  return doc.save();
}
