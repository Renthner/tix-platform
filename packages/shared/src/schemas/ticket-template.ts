import { z } from 'zod';
import { hexColorSchema } from './common';

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
  x: mm,
  y: mm,
  width: mm,
  height: mm,
  rotation: z.number().min(-360).max(360).default(0),
  fontFamily: z.string().min(1).max(100).default('Helvetica'),
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
      z.discriminatedUnion('kind', [textElementSchema, imageElementSchema, shapeElementSchema]),
    )
    .max(200),
});
export type TicketLayout = z.infer<typeof ticketLayoutSchema>;
