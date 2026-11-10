import { z } from 'zod';
import { translationsSchema } from '../translations';
import { SEAT_ORIENTATION_MODES, SPECIAL_SEAT_LABEL_MODES } from '../enums';
import { hexColorSchema } from './common';

/**
 * JSONB payloads of the seating plan tables. All coordinates are in the seat map's
 * own canvas coordinate space (seat_maps.canvas_width × canvas_height), origin top-left.
 */

const coordinate = z.number().min(-1_000_000).max(1_000_000);
const length = z.number().positive().max(1_000_000);
const rotation = z.number().min(-360).max(360).default(0);

export const pointSchema = z.object({ x: coordinate, y: coordinate });
export type Point = z.infer<typeof pointSchema>;

const polygonPoints = z.array(pointSchema).min(3).max(2_000);

// ─── Sections (blocks / standing areas) ─────────────────────────────────────
export const sectionGeometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('polygon'), points: polygonPoints }),
  z.object({
    type: z.literal('rect'),
    x: coordinate,
    y: coordinate,
    width: length,
    height: length,
    rotation,
  }),
  z.object({
    type: z.literal('ellipse'),
    cx: coordinate,
    cy: coordinate,
    rx: length,
    ry: length,
    rotation,
  }),
  /** Free-form SVG path data for complex shapes drawn with the pen tool. */
  z.object({ type: z.literal('path'), d: z.string().min(1).max(50_000) }),
]);
export type SectionGeometry = z.infer<typeof sectionGeometrySchema>;

export const sectionLabelSchema = z.object({
  position: pointSchema,
  fontSize: z.number().positive().max(500).default(16),
  rotation,
});
export type SectionLabel = z.infer<typeof sectionLabelSchema>;

// ─── Rows ───────────────────────────────────────────────────────────────────
export const seatOrientationSchema = z.object({
  mode: z.enum(SEAT_ORIENTATION_MODES),
  angle: z.number().min(-360).max(360),
});
export type SeatOrientation = z.infer<typeof seatOrientationSchema>;

/**
 * Generator parameters of a row. Seat positions are persisted explicitly on `seats`
 * (x/y); these parameters let the editor re-flow a row (spacing, curvature, numbering).
 */
export const rowGeometrySchema = z.object({
  curve: z.discriminatedUnion('type', [
    z.object({ type: z.literal('straight'), start: pointSchema, end: pointSchema }),
    /** Quadratic Bézier: curved theatre rows. */
    z.object({
      type: z.literal('arc'),
      start: pointSchema,
      end: pointSchema,
      control: pointSchema,
    }),
  ]),
  seatSpacing: length,
  numbering: z.enum(['ASCENDING', 'DESCENDING', 'ODD_EVEN_FROM_CENTER']).default('ASCENDING'),
  labelPlacement: z.enum(['START', 'END', 'BOTH', 'NONE']).default('BOTH'),
  /**
   * Absolute positions of the row labels. When omitted the labels sit just before the first
   * and after the last seat. Explicit positions let admins align labels of staggered rows
   * (seats offset "über Kreuz") in one vertical line.
   */
  labelStart: pointSchema.optional(),
  labelEnd: pointSchema.optional(),
  /**
   * Direction the seats of this row face. Omitted = perpendicular to the row (follows the
   * curve). ROW + angle = follow the row turned by `angle` degrees (180 = turned around);
   * FIXED + angle = same absolute direction for every seat (0 = up, 90 = right, -90 = left).
   */
  seatOrientation: seatOrientationSchema.optional(),
});
export type RowGeometry = z.infer<typeof rowGeometrySchema>;

// ─── Free-form elements (stage, tables, text, shapes …) ─────────────────────
export const elementGeometrySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('rect'),
    x: coordinate,
    y: coordinate,
    width: length,
    height: length,
    rotation,
    cornerRadius: z.number().min(0).max(10_000).default(0),
  }),
  z.object({
    type: z.literal('ellipse'),
    cx: coordinate,
    cy: coordinate,
    rx: length,
    ry: length,
    rotation,
  }),
  z.object({ type: z.literal('polygon'), points: polygonPoints }),
  z.object({ type: z.literal('polyline'), points: z.array(pointSchema).min(2).max(2_000) }),
  z.object({ type: z.literal('path'), d: z.string().min(1).max(50_000) }),
  z.object({ type: z.literal('point'), x: coordinate, y: coordinate, rotation }),
]);
export type ElementGeometry = z.infer<typeof elementGeometrySchema>;

export const elementStyleSchema = z
  .object({
    fill: hexColorSchema.optional(),
    stroke: hexColorSchema.optional(),
    strokeWidth: z.number().min(0).max(1_000).optional(),
    opacity: z.number().min(0).max(1).optional(),
    textColor: hexColorSchema.optional(),
    fontSize: z.number().positive().max(500).optional(),
    fontWeight: z.enum(['normal', 'bold']).optional(),
    /** Short text / emoji shown in FACILITY markers (fallback when no symbol is set). */
    icon: z.string().max(64).optional(),
    /** SVG symbol from the symbol library (svg_symbols.id) drawn inside / on the element. */
    symbolId: z.uuid().optional(),
    /** Colour of colourisable symbols (defaults to the text colour). */
    symbolColor: hexColorSchema.optional(),
    /** Symbol size in canvas units (defaults to a size derived from the element). */
    symbolSize: z.number().positive().max(10_000).optional(),
  })
  .strict();
export type ElementStyle = z.infer<typeof elementStyleSchema>;

// ─── Seat map canvas ────────────────────────────────────────────────────────
/**
 * Label of wheelchair spaces / companion seats on the plan (editor + shop): the type icon
 * (♿ / +), the seat number, a short custom text (e.g. "R", "B") or nothing.
 */
export const specialSeatLabelSchema = z
  .object({
    mode: z.enum(SPECIAL_SEAT_LABEL_MODES).default('ICON'),
    text: z.string().trim().max(3).optional(),
  })
  .strict();
export type SpecialSeatLabel = z.infer<typeof specialSeatLabelSchema>;
export type SpecialSeatLabelInput = z.input<typeof specialSeatLabelSchema>;

export const seatMapSettingsSchema = z
  .object({
    gridSize: z.number().positive().max(1_000).default(10),
    snapToGrid: z.boolean().default(true),
    seatRadius: z.number().positive().max(500).default(8),
    showSeatNumbers: z.boolean().default(true),
    backgroundOpacity: z.number().min(0).max(1).default(0.35),
    /** Seat shape for seats without their own symbol (null/absent = plain circle). */
    defaultSeatSymbolId: z.uuid().nullable().optional(),
    defaultView: z
      .object({ x: coordinate, y: coordinate, zoom: z.number().positive().max(100) })
      .optional(),
    /** How wheelchair spaces and companion seats are labelled on the plan. */
    wheelchairLabel: specialSeatLabelSchema.optional(),
    companionLabel: specialSeatLabelSchema.optional(),
    /** Translations of the short wheelchair / companion label texts. */
    translations: translationsSchema.optional(),
  })
  .strict();
export type SeatMapSettings = z.infer<typeof seatMapSettingsSchema>;
/** Persisted form: may omit fields, defaults are applied when parsing on read. */
export type SeatMapSettingsInput = z.input<typeof seatMapSettingsSchema>;

export const seatAttributesSchema = z
  .object({
    note: z.string().max(500).optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
  })
  .strict();
export type SeatAttributes = z.infer<typeof seatAttributesSchema>;
