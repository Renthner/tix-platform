import { z } from 'zod';
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
    /** Icon identifier for FACILITY/EXIT markers (e.g. "wc", "bar", "cloakroom"). */
    icon: z.string().max(64).optional(),
  })
  .strict();
export type ElementStyle = z.infer<typeof elementStyleSchema>;

// ─── Seat map canvas ────────────────────────────────────────────────────────
export const seatMapSettingsSchema = z
  .object({
    gridSize: z.number().positive().max(1_000).default(10),
    snapToGrid: z.boolean().default(true),
    seatRadius: z.number().positive().max(500).default(8),
    showSeatNumbers: z.boolean().default(true),
    backgroundOpacity: z.number().min(0).max(1).default(0.35),
    defaultView: z
      .object({ x: coordinate, y: coordinate, zoom: z.number().positive().max(100) })
      .optional(),
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
