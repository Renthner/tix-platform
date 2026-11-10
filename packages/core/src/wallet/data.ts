import {
  events,
  orderItems,
  orders,
  seatMapSections,
  tickets,
  venues,
  walletPassDesigns,
  type Executor,
} from '@tix/db';
import { localized, type Translations } from '@tix/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import { formatDateTime, formatTime } from '../format';
import type { MailTranslator } from '../i18n/mail-messages';
import { getSetting } from '../settings';
import { placeOrderBy } from '../tickets/order';

export type WalletDesignRow = typeof walletPassDesigns.$inferSelect;

/** Everything a wallet pass needs about one ticket (read once, pure afterwards). */
export interface WalletTicketData {
  ticketId: string;
  ticketCode: string;
  qrPayload: string;
  attendeeName: string | null;
  orderId: string;
  orderNumber: string;
  locale: string;
  eventId: string;
  /** Event / venue texts resolved for the order's locale (Apple pass, Google ticket objects). */
  eventTitle: string;
  eventSubtitle: string | null;
  /** Base (shop default language) texts + translations for the shared Google class (`translatedValues`). */
  classTexts?: {
    eventTitle: string;
    venueName: string;
    eventTranslations: Translations;
    venueTranslations: Translations;
  };
  startsAt: Date;
  endsAt: Date | null;
  doorsOpenAt: Date | null;
  timeZone: string;
  googleWalletClassId: string | null;
  heroImageAssetId: string | null;
  venueName: string;
  venueAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  kind: 'SEAT' | 'GENERAL_ADMISSION';
  /** Block label, only when the section's `show_label_on_ticket` is on. */
  block: string | null;
  row: string | null;
  seat: string | null;
  categoryName: string;
  ticketTypeName: string;
}

export interface ResolvedWalletDesign {
  backgroundColor: string;
  foregroundColor: string;
  labelColor: string;
  logoText: string | null;
  description: string | null;
  logoAssetId: string | null;
  iconAssetId: string | null;
  stripAssetId: string | null;
  heroAssetId: string | null;
  /** Design row ids that contributed (for cache hashing). */
  sources: string[];
}

export async function loadWalletTicketData(
  db: Executor,
  where: { ticketId: string } | { orderId: string },
): Promise<WalletTicketData[]> {
  const condition =
    'ticketId' in where
      ? eq(tickets.id, where.ticketId)
      : and(eq(tickets.orderId, where.orderId), eq(tickets.status, 'VALID'));
  const rows = await db
    .select({
      ticketId: tickets.id,
      ticketCode: tickets.ticketCode,
      qrPayload: tickets.qrPayload,
      attendeeName: tickets.attendeeName,
      status: tickets.status,
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      locale: orders.locale,
      eventId: events.id,
      eventTitle: events.title,
      eventSubtitle: events.subtitle,
      eventTranslations: events.translations,
      venueTranslations: venues.translations,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      doorsOpenAt: events.doorsOpenAt,
      timeZone: events.timeZone,
      googleWalletClassId: events.googleWalletClassId,
      heroImageAssetId: events.heroImageAssetId,
      venueName: venues.name,
      street: venues.street,
      postalCode: venues.postalCode,
      city: venues.city,
      latitude: venues.latitude,
      longitude: venues.longitude,
      kind: orderItems.kind,
      sectionLabel: orderItems.sectionLabel,
      rowLabel: orderItems.rowLabel,
      seatLabel: orderItems.seatLabel,
      categoryName: orderItems.categoryName,
      ticketTypeName: orderItems.ticketTypeName,
      showLabelOnTicket: seatMapSections.showLabelOnTicket,
    })
    .from(tickets)
    .innerJoin(orders, eq(orders.id, tickets.orderId))
    .innerJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
    .innerJoin(seatMapSections, eq(seatMapSections.id, orderItems.sectionId))
    .innerJoin(events, eq(events.id, tickets.eventId))
    .innerJoin(venues, eq(venues.id, events.venueId))
    .where(condition)
    .orderBy(...placeOrderBy());
  const { defaultLocale } = await getSetting({ db }, 'general');
  return rows
    .filter((r) => r.status === 'VALID')
    .map((r) => ({
      ticketId: r.ticketId,
      ticketCode: r.ticketCode,
      qrPayload: r.qrPayload,
      attendeeName: r.attendeeName,
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      locale: r.locale,
      eventId: r.eventId,
      eventTitle: localized(
        { translations: r.eventTranslations },
        'title',
        r.locale,
        defaultLocale,
        r.eventTitle,
      ),
      eventSubtitle:
        r.eventSubtitle === null
          ? null
          : localized(
              { translations: r.eventTranslations },
              'subtitle',
              r.locale,
              defaultLocale,
              r.eventSubtitle,
            ),
      classTexts: {
        eventTitle: r.eventTitle,
        venueName: r.venueName,
        eventTranslations: r.eventTranslations,
        venueTranslations: r.venueTranslations,
      },
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      doorsOpenAt: r.doorsOpenAt,
      timeZone: r.timeZone,
      googleWalletClassId: r.googleWalletClassId,
      heroImageAssetId: r.heroImageAssetId,
      venueName: localized(
        { translations: r.venueTranslations },
        'name',
        r.locale,
        defaultLocale,
        r.venueName,
      ),
      venueAddress:
        [r.street, [r.postalCode, r.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') ||
        null,
      latitude: r.latitude,
      longitude: r.longitude,
      kind: r.kind,
      block: r.showLabelOnTicket ? r.sectionLabel : null,
      row: r.rowLabel,
      seat: r.seatLabel,
      categoryName: r.categoryName,
      ticketTypeName: r.ticketTypeName,
    }));
}

/** Short place text, e.g. "Block A · Row 3 · Seat 12" / "Standing area" (honours the block flag). */
export function walletPlaceLabel(data: WalletTicketData, t: MailTranslator): string {
  if (data.kind === 'GENERAL_ADMISSION' || !data.seat) {
    return data.block ? t('items.standing', { section: data.block }) : t('wallet.standing');
  }
  const parts = [
    data.block ? `${t('wallet.block')} ${data.block}` : null,
    data.row ? `${t('wallet.row')} ${data.row}` : null,
    `${t('wallet.seat')} ${data.seat}`,
  ];
  return parts.filter(Boolean).join(' · ');
}

export const walletWhen = (data: WalletTicketData) =>
  formatDateTime(data.startsAt, data.locale, data.timeZone);
export const walletDoors = (data: WalletTicketData) =>
  data.doorsOpenAt ? formatTime(data.doorsOpenAt, data.locale, data.timeZone) : null;

/** Design of an event: event override, else the global design, else branding-derived defaults. */
export async function resolveWalletDesign(
  ctx: CoreContext,
  eventId: string | null,
): Promise<ResolvedWalletDesign> {
  const [eventRow] = eventId
    ? await ctx.db.select().from(walletPassDesigns).where(eq(walletPassDesigns.eventId, eventId))
    : [];
  const [globalRow] = await ctx.db
    .select()
    .from(walletPassDesigns)
    .where(isNull(walletPassDesigns.eventId));
  const branding = await getSetting(ctx, 'branding');
  const primary = eventRow ?? globalRow;
  return {
    backgroundColor: primary?.backgroundColor ?? branding.primaryColor,
    foregroundColor: primary?.foregroundColor ?? '#FFFFFF',
    labelColor: primary?.labelColor ?? '#E5E7EB',
    logoText: eventRow?.logoText ?? globalRow?.logoText ?? null,
    description: eventRow?.description ?? globalRow?.description ?? null,
    logoAssetId: eventRow?.logoAssetId ?? globalRow?.logoAssetId ?? null,
    iconAssetId: eventRow?.iconAssetId ?? globalRow?.iconAssetId ?? null,
    stripAssetId: eventRow?.stripAssetId ?? globalRow?.stripAssetId ?? null,
    heroAssetId: eventRow?.heroAssetId ?? globalRow?.heroAssetId ?? null,
    sources: [eventRow?.id, globalRow?.id].filter((v): v is string => Boolean(v)),
  };
}

export async function getWalletPassDesignRow(
  db: Executor,
  eventId: string | null,
): Promise<WalletDesignRow | null> {
  const [row] = await db
    .select()
    .from(walletPassDesigns)
    .where(eventId ? eq(walletPassDesigns.eventId, eventId) : isNull(walletPassDesigns.eventId));
  return row ?? null;
}

export interface WalletPassDesignInput {
  backgroundColor: string;
  foregroundColor: string;
  labelColor: string;
  logoText: string | null;
  description: string | null;
  logoAssetId: string | null;
  iconAssetId: string | null;
  stripAssetId: string | null;
  heroAssetId: string | null;
}

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** Upserts the global (eventId null) or per-event design. */
export async function saveWalletPassDesign(
  db: Executor,
  eventId: string | null,
  input: WalletPassDesignInput,
): Promise<void> {
  for (const color of [input.backgroundColor, input.foregroundColor, input.labelColor]) {
    if (!HEX.test(color)) throw new DomainError('INVALID_COLOR', 'Invalid colour', 422);
  }
  const existing = await getWalletPassDesignRow(db, eventId);
  if (existing) {
    await db
      .update(walletPassDesigns)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(walletPassDesigns.id, existing.id));
  } else {
    await db.insert(walletPassDesigns).values({ eventId, ...input });
  }
}

export async function deleteWalletPassDesign(db: Executor, eventId: string): Promise<void> {
  await db.delete(walletPassDesigns).where(eq(walletPassDesigns.eventId, eventId));
}
