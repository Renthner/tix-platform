import { z } from 'zod';
import { SEAT_BLOCK_REASONS, SEAT_MAP_ELEMENT_TYPES, SECTION_TYPES } from '../enums';
import { hexColorSchema } from '../schemas/common';
import { translationsSchema } from '../translations';
import {
  elementGeometrySchema,
  elementStyleSchema,
  rowGeometrySchema,
  seatAttributesSchema,
  seatMapSettingsSchema,
  sectionGeometrySchema,
  sectionLabelSchema,
} from '../schemas/seat-map';

/**
 * The complete editable state of one seat map, exchanged between the visual editor and
 * `PUT /api/admin/seat-maps/:id`. The editor generates UUIDs for new entities
 * (`crypto.randomUUID()`); the server diffs the document against the database.
 *
 * `version` is the version the editor started from (optimistic concurrency): the save is
 * rejected with 409 if someone else saved in between.
 */

const uuid = z.uuid();
const coordinate = z.number().min(-1_000_000).max(1_000_000);
const name = z.string().trim().min(1).max(120);

/** Plan category of a master plan (name + colour; prices exist only on events). */
export const docCategorySchema = z.object({
  id: uuid,
  name,
  color: hexColorSchema,
  sortOrder: z.number().int().default(0),
  translations: translationsSchema.default({}),
});

export const docEntranceSchema = z.object({
  id: uuid,
  name,
  code: z.string().trim().min(1).max(16),
  x: coordinate,
  y: coordinate,
  sortOrder: z.number().int().default(0),
  translations: translationsSchema.default({}),
});

export const docSectionSchema = z.object({
  id: uuid,
  type: z.enum(SECTION_TYPES),
  name,
  ticketLabel: z.string().trim().min(1).max(120),
  geometry: sectionGeometrySchema,
  label: sectionLabelSchema.nullable().default(null),
  color: hexColorSchema.nullable().default(null),
  sortOrder: z.number().int().default(0),
  entranceId: uuid.nullable().default(null),
  priceCategoryId: uuid.nullable().default(null),
  /** Required for STANDING sections. */
  capacity: z.number().int().min(0).max(1_000_000).nullable().default(null),
  bestAvailablePriority: z.number().int().min(0).max(1_000_000).default(100),
  isBestAvailableEnabled: z.boolean().default(true),
  isActive: z.boolean().default(true),
  /** Show the block name on the public seating chart. */
  showNameOnMap: z.boolean().default(true),
  /** Print the block's ticket label on tickets (phase 4) and in the cart. */
  showLabelOnTicket: z.boolean().default(true),
  translations: translationsSchema.default({}),
});

export const docRowSchema = z.object({
  id: uuid,
  sectionId: uuid,
  label: z.string().trim().min(1).max(32),
  sortOrder: z.number().int().default(0),
  geometry: rowGeometrySchema,
});

export const docElementSchema = z.object({
  id: uuid,
  type: z.enum(SEAT_MAP_ELEMENT_TYPES),
  sectionId: uuid.nullable().default(null),
  label: z.string().max(200).nullable().default(null),
  geometry: elementGeometrySchema,
  style: elementStyleSchema.default({}),
  assetId: uuid.nullable().default(null),
  zIndex: z.number().int().default(0),
  translations: translationsSchema.default({}),
});

export const docSeatSchema = z.object({
  id: uuid,
  sectionId: uuid,
  rowId: uuid.nullable().default(null),
  tableElementId: uuid.nullable().default(null),
  label: z.string().trim().min(1).max(16),
  position: z.number().int().min(-100_000).max(100_000).nullable().default(null),
  x: coordinate,
  y: coordinate,
  rotation: z.number().min(-360).max(360).default(0),
  priceCategoryId: uuid.nullable().default(null),
  bestAvailableRank: z.number().int().min(0).max(1_000_000_000).nullable().default(null),
  isWheelchairSpace: z.boolean().default(false),
  isCompanionSeat: z.boolean().default(false),
  /** Wheelchair space this companion seat belongs to (null = adjacent wheelchair space). */
  companionOfSeatId: uuid.nullable().default(null),
  hasRestrictedView: z.boolean().default(false),
  blockReason: z.enum(SEAT_BLOCK_REASONS).nullable().default(null),
  blockNote: z.string().max(500).nullable().default(null),
  attributes: seatAttributesSchema.default({}),
  /** Custom seat shape (svg_symbols.id); null = map default (or circle). */
  symbolId: uuid.nullable().default(null),
});

export const seatMapDocumentSchema = z
  .object({
    version: z.number().int().positive(),
    name,
    canvasWidth: z.number().int().min(100).max(100_000),
    canvasHeight: z.number().int().min(100).max(100_000),
    backgroundAssetId: uuid.nullable().default(null),
    settings: seatMapSettingsSchema.prefault({}),
    /** Master plans only: categories that `priceCategoryId` of sections / seats refers to. */
    categories: z.array(docCategorySchema).max(200).default([]),
    entrances: z.array(docEntranceSchema).max(200).default([]),
    sections: z.array(docSectionSchema).max(2_000).default([]),
    rows: z.array(docRowSchema).max(10_000).default([]),
    elements: z.array(docElementSchema).max(5_000).default([]),
    seats: z.array(docSeatSchema).max(100_000).default([]),
  })
  .superRefine((doc, ctx) => {
    const ids = new Set<string>();
    const dup = (id: string, path: (string | number)[]) => {
      if (ids.has(id)) ctx.addIssue({ code: 'custom', path, message: `Duplicate id ${id}` });
      ids.add(id);
    };
    const categoryNames = new Set<string>();
    doc.categories.forEach((c, i) => {
      dup(c.id, ['categories', i, 'id']);
      const key = c.name.toLowerCase();
      if (categoryNames.has(key))
        ctx.addIssue({
          code: 'custom',
          path: ['categories', i, 'name'],
          message: 'Duplicate category name',
        });
      categoryNames.add(key);
    });
    doc.entrances.forEach((e, i) => dup(e.id, ['entrances', i, 'id']));
    doc.sections.forEach((s, i) => dup(s.id, ['sections', i, 'id']));
    doc.rows.forEach((r, i) => dup(r.id, ['rows', i, 'id']));
    doc.elements.forEach((e, i) => dup(e.id, ['elements', i, 'id']));
    doc.seats.forEach((s, i) => dup(s.id, ['seats', i, 'id']));

    const sections = new Map(doc.sections.map((s) => [s.id, s]));
    const entrances = new Set(doc.entrances.map((e) => e.id));
    const rows = new Map(doc.rows.map((r) => [r.id, r]));
    const tables = new Set(doc.elements.filter((e) => e.type === 'TABLE').map((e) => e.id));
    const sectionNames = new Set<string>();
    const rowLabels = new Set<string>();
    const rowPositions = new Set<string>();
    const rowSeatLabels = new Set<string>();

    doc.sections.forEach((s, i) => {
      if (s.entranceId && !entrances.has(s.entranceId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sections', i, 'entranceId'],
          message: 'Unknown entrance',
        });
      }
      if (s.type === 'STANDING' && s.capacity === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['sections', i, 'capacity'],
          message: 'Capacity required',
        });
      }
      const key = s.name.toLowerCase();
      if (sectionNames.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sections', i, 'name'],
          message: 'Duplicate section name',
        });
      }
      sectionNames.add(key);
    });
    doc.rows.forEach((r, i) => {
      const section = sections.get(r.sectionId);
      if (!section) {
        ctx.addIssue({
          code: 'custom',
          path: ['rows', i, 'sectionId'],
          message: 'Unknown section',
        });
      } else if (section.type !== 'SEATED') {
        ctx.addIssue({
          code: 'custom',
          path: ['rows', i, 'sectionId'],
          message: 'Rows require a SEATED section',
        });
      }
      const key = `${r.sectionId}|${r.label}`;
      if (rowLabels.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rows', i, 'label'],
          message: 'Duplicate row label in section',
        });
      }
      rowLabels.add(key);
    });
    doc.elements.forEach((e, i) => {
      if (e.sectionId && !sections.has(e.sectionId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['elements', i, 'sectionId'],
          message: 'Unknown section',
        });
      }
      if (e.type === 'IMAGE' && !e.assetId) {
        ctx.addIssue({
          code: 'custom',
          path: ['elements', i, 'assetId'],
          message: 'Image asset required',
        });
      }
    });
    const seatById = new Map(doc.seats.map((s) => [s.id, s]));
    doc.seats.forEach((s, i) => {
      if (s.companionOfSeatId) {
        const target = seatById.get(s.companionOfSeatId);
        if (!s.isCompanionSeat || !target || !target.isWheelchairSpace || target.id === s.id) {
          ctx.addIssue({
            code: 'custom',
            path: ['seats', i, 'companionOfSeatId'],
            message: 'Companion seat must refer to a wheelchair space of this plan',
          });
        }
      }
      const section = sections.get(s.sectionId);
      if (!section) {
        ctx.addIssue({
          code: 'custom',
          path: ['seats', i, 'sectionId'],
          message: 'Unknown section',
        });
      } else if (section.type !== 'SEATED') {
        ctx.addIssue({
          code: 'custom',
          path: ['seats', i, 'sectionId'],
          message: 'Seats require a SEATED section',
        });
      }
      if (s.rowId && s.tableElementId) {
        ctx.addIssue({
          code: 'custom',
          path: ['seats', i],
          message: 'Seat cannot belong to a row and a table',
        });
      }
      if (s.rowId) {
        const row = rows.get(s.rowId);
        if (!row) {
          ctx.addIssue({ code: 'custom', path: ['seats', i, 'rowId'], message: 'Unknown row' });
        } else if (row.sectionId !== s.sectionId) {
          ctx.addIssue({
            code: 'custom',
            path: ['seats', i, 'rowId'],
            message: 'Row belongs to another section',
          });
        }
      }
      if (s.tableElementId && !tables.has(s.tableElementId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['seats', i, 'tableElementId'],
          message: 'Unknown table',
        });
      }
      const parent = s.rowId ?? s.tableElementId;
      if (parent) {
        if (s.position === null) {
          ctx.addIssue({
            code: 'custom',
            path: ['seats', i, 'position'],
            message: 'Position required',
          });
        } else {
          const posKey = `${parent}|${s.position}`;
          if (rowPositions.has(posKey)) {
            ctx.addIssue({
              code: 'custom',
              path: ['seats', i, 'position'],
              message: 'Duplicate position',
            });
          }
          rowPositions.add(posKey);
        }
        if (s.rowId) {
          const labelKey = `${s.rowId}|${s.label}`;
          if (rowSeatLabels.has(labelKey)) {
            ctx.addIssue({
              code: 'custom',
              path: ['seats', i, 'label'],
              message: 'Duplicate seat number in row',
            });
          }
          rowSeatLabels.add(labelKey);
        }
      }
    });
  });

export type SeatMapDocument = z.infer<typeof seatMapDocumentSchema>;
export type SeatMapDocumentInput = z.input<typeof seatMapDocumentSchema>;
export type DocCategory = z.infer<typeof docCategorySchema>;
export type DocEntrance = z.infer<typeof docEntranceSchema>;
export type DocSection = z.infer<typeof docSectionSchema>;
export type DocRow = z.infer<typeof docRowSchema>;
export type DocElement = z.infer<typeof docElementSchema>;
export type DocSeat = z.infer<typeof docSeatSchema>;

/** Error body of a rejected save (HTTP 409 / 422). */
export interface SeatMapSaveError {
  code: 'VERSION_CONFLICT' | 'VALIDATION_FAILED' | 'SEATS_IN_USE' | 'NOT_FOUND';
  message: string;
  issues?: { path: (string | number)[]; message: string }[];
  /** Seat ids that cannot be removed because they hold active order items. */
  seatIds?: string[];
  currentVersion?: number;
}
