import { z } from 'zod';
import { hexColorSchema } from './common';
import { localized, translationsSchema } from '../translations';

/**
 * Layout of a PDF ticket template (ticket_templates.layout). All positions/sizes are
 * millimetres relative to the top-left page corner; font sizes are points.
 */

export const TICKET_FIELD_KEYS = [
  'EVENT_TITLE',
  'EVENT_SUBTITLE',
  'EVENT_DATE',
  'EVENT_TIME',
  'DOORS_TIME',
  'VENUE_NAME',
  'VENUE_ADDRESS',
  'SECTION',
  'ROW',
  'SEAT',
  'SEAT_FULL',
  'ENTRANCE',
  'PRICE_CATEGORY',
  'TICKET_TYPE',
  'PRICE',
  'BUYER_NAME',
  'ATTENDEE_NAME',
  'ORDER_NUMBER',
  'TICKET_CODE',
  'ORGANIZER_NAME',
  'STATIC_TEXT',
] as const;
export type TicketFieldKey = (typeof TICKET_FIELD_KEYS)[number];

const mm = z.number().min(0).max(2_000);
const id = z.string().min(1).max(64);

const textElementSchema = z.object({
  kind: z.literal('text'),
  id,
  field: z.enum(TICKET_FIELD_KEYS),
  /** Only for STATIC_TEXT; may contain {{placeholders}}. */
  text: z.string().max(2_000).optional(),
  /** Translations of `text` per locale: `{ en: { text: '…' } }` (STATIC_TEXT only). */
  translations: translationsSchema.optional(),
  x: mm,
  y: mm,
  width: mm,
  height: mm,
  rotation: z.number().min(-360).max(360).default(0),
  fontFamily: z.string().min(1).max(100).default('Noto Sans'),
  fontSize: z.number().positive().max(200).default(10),
  fontWeight: z.enum(['normal', 'bold']).default('normal'),
  color: hexColorSchema.default('#000000'),
  align: z.enum(['left', 'center', 'right']).default('left'),
  uppercase: z.boolean().default(false),
  /** Intl date/time style for date/time fields. */
  dateStyle: z.enum(['short', 'medium', 'long', 'full']).optional(),
  timeStyle: z.enum(['short', 'medium']).optional(),
});

const imageElementSchema = z.object({
  kind: z.literal('image'),
  id,
  assetId: z.uuid(),
  x: mm,
  y: mm,
  width: mm,
  height: mm,
  rotation: z.number().min(-360).max(360).default(0),
  opacity: z.number().min(0).max(1).default(1),
});

/** The event's cover image (events.hero_image_asset_id), placed as a band / badge. */
const coverElementSchema = z.object({
  kind: z.literal('cover'),
  id,
  x: mm,
  y: mm,
  width: mm,
  height: mm,
  /** `cover` crops to fill the box, `contain` letterboxes. */
  fit: z.enum(['cover', 'contain']).default('cover'),
  opacity: z.number().min(0).max(1).default(1),
});

const shapeElementSchema = z.object({
  kind: z.literal('shape'),
  id,
  shape: z.enum(['rect', 'line']),
  x: mm,
  y: mm,
  width: mm,
  height: mm,
  fill: hexColorSchema.optional(),
  stroke: hexColorSchema.optional(),
  strokeWidth: z.number().min(0).max(20).default(0.3),
});

export const ticketQrSchema = z.object({
  x: mm,
  y: mm,
  size: z.number().min(10).max(300),
  errorCorrection: z.enum(['L', 'M', 'Q', 'H']).default('M'),
  foreground: hexColorSchema.default('#000000'),
  background: hexColorSchema.default('#FFFFFF'),
  /** Quiet zone in modules. */
  margin: z.number().int().min(0).max(10).default(2),
});

export const ticketLayoutSchema = z.object({
  version: z.literal(1),
  qr: ticketQrSchema,
  elements: z
    .array(
      z.discriminatedUnion('kind', [
        textElementSchema,
        imageElementSchema,
        coverElementSchema,
        shapeElementSchema,
      ]),
    )
    .max(200),
});
export type TicketLayout = z.infer<typeof ticketLayoutSchema>;

export type TicketLayoutElement = TicketLayout['elements'][number];
/** Layout with static texts resolved for `locale` (translation if not blank, else the base text). */
export function localizeTicketLayout(
  layout: TicketLayout,
  locale: string | null | undefined,
  defaultLocale: string,
): TicketLayout {
  if (!layout.elements.some((el) => el.kind === 'text' && el.translations)) return layout;
  return {
    ...layout,
    elements: layout.elements.map((el) =>
      el.kind === 'text' && el.field === 'STATIC_TEXT' && el.translations
        ? {
            ...el,
            text: localized(el, 'text', locale, defaultLocale, el.text ?? ''),
            translations: undefined,
          }
        : el,
    ),
  };
}

export type TicketTextElement = Extract<TicketLayoutElement, { kind: 'text' }>;

/**
 * Fonts available to ticket text: the bundled Noto Sans (Latin, Latin Extended, Greek,
 * Cyrillic). Layouts saved earlier may still name Helvetica, Times or Courier; any family
 * name is accepted and prints in Noto Sans.
 */
export const TICKET_FONT_FAMILIES = ['Noto Sans'] as const;

/** Input shape of a template save (page size + layout + background). */
export const ticketTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullish(),
  pageWidthMm: z.number().min(20).max(2000),
  pageHeightMm: z.number().min(20).max(2000),
  backgroundAssetId: z.uuid().nullish(),
  layout: ticketLayoutSchema,
});
export type TicketTemplateInput = z.infer<typeof ticketTemplateInputSchema>;

/** Placeholder name (`{{name}}`) holding the value of each field; STATIC_TEXT has none. */
export const TICKET_FIELD_VARIABLES = {
  EVENT_TITLE: 'eventTitle',
  EVENT_SUBTITLE: 'eventSubtitle',
  EVENT_DATE: 'eventDate',
  EVENT_TIME: 'eventTime',
  DOORS_TIME: 'doorsTime',
  VENUE_NAME: 'venueName',
  VENUE_ADDRESS: 'venueAddress',
  SECTION: 'section',
  ROW: 'row',
  SEAT: 'seat',
  SEAT_FULL: 'seatFull',
  ENTRANCE: 'entrance',
  PRICE_CATEGORY: 'priceCategory',
  TICKET_TYPE: 'ticketType',
  PRICE: 'price',
  BUYER_NAME: 'buyerName',
  ATTENDEE_NAME: 'attendeeName',
  ORDER_NUMBER: 'orderNumber',
  TICKET_CODE: 'ticketCode',
  ORGANIZER_NAME: 'organizerName',
} as const satisfies Record<Exclude<TicketFieldKey, 'STATIC_TEXT'>, string>;

/** Label placeholders (`{{label.date}}` …) localized by the renderer. */
export const TICKET_LABEL_KEYS = [
  'date',
  'time',
  'doors',
  'venue',
  'seat',
  'block',
  'row',
  'entrance',
  'order',
  'ticket',
  'category',
  'price',
  'name',
] as const;
