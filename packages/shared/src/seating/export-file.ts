import { z } from 'zod';
import { SYMBOL_KINDS } from '../enums';
import { MEDIA_ACCEPTED_MIME, MEDIA_MAX_BYTES } from '../media';
import { hexColorSchema } from '../schemas/common';
import { translationsSchema } from '../translations';
import { elementStyleSchema, seatMapSettingsSchema } from '../schemas/seat-map';
import {
  docElementSchema,
  docEntranceSchema,
  docRowSchema,
  docSeatSchema,
  docSectionSchema,
  seatMapDocumentSchema,
} from './document';

/**
 * Portable seat plan file (`*.tixplan.json`): one plan with all geometry, custom symbols and
 * images, but no database ids, orders or customer data. Entities refer to each other by short
 * local keys ("s1", "r3" …); the importer maps them to fresh UUIDs.
 *
 * Price categories are carried as name / colour references (`categoryKey` on sections and seats).
 * Master plans export their plan categories, event plans their price categories (without prices);
 * an import always creates plan categories on the new master plan.
 */

export const SEAT_MAP_FILE_FORMAT = 'tix-seatmap';
/** 2: content translations on sections / elements / entrances / plan settings. Version 1 files are still accepted. */
export const SEAT_MAP_FILE_VERSION = 2;
export const SEAT_MAP_FILE_MIN_VERSION = 1;
export const SEAT_MAP_FILE_EXTENSION = '.tixplan.json';
/** Hard cap of an uploaded plan file (JSON text with base64 images). */
export const SEAT_MAP_FILE_MAX_BYTES = 40 * 1024 * 1024;

const key = z.string().min(1).max(40);
const nullableKey = key.nullable().default(null);
const base64 = z.string().max(Math.ceil((MEDIA_MAX_BYTES * 4) / 3) + 8);

export const planImageSchema = z.object({
  fileName: z.string().max(200),
  contentType: z.enum(MEDIA_ACCEPTED_MIME),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  dataBase64: base64,
});
export type PlanImage = z.infer<typeof planImageSchema>;

export const planSymbolSchema = z.object({
  key,
  name: z.string().trim().min(1).max(120),
  kind: z.enum(SYMBOL_KINDS),
  viewBox: z.string().max(100),
  /** Complete SVG document; re-sanitised on import. */
  svg: z.string().max(60_000),
  colorize: z.boolean(),
  /** Key of a built-in symbol; the importer prefers the target's own copy of it. */
  builtinKey: z.string().max(80).nullable().default(null),
});
export type PlanSymbol = z.infer<typeof planSymbolSchema>;

export const planCategorySchema = z.object({
  key,
  name: z.string().trim().min(1).max(120),
  color: hexColorSchema,
  translations: translationsSchema.default({}),
});
export type PlanCategory = z.infer<typeof planCategorySchema>;

const planSection = docSectionSchema
  .omit({ priceCategoryId: true })
  .extend({ id: key, entranceId: nullableKey, categoryKey: nullableKey });
const planRow = docRowSchema.extend({ id: key, sectionId: key });
const planElement = docElementSchema.omit({ assetId: true }).extend({
  id: key,
  sectionId: nullableKey,
  imageKey: nullableKey,
  style: elementStyleSchema.extend({ symbolId: key.optional() }).default({}),
});
const planSeat = docSeatSchema.omit({ priceCategoryId: true }).extend({
  id: key,
  sectionId: key,
  rowId: nullableKey,
  tableElementId: nullableKey,
  companionOfSeatId: nullableKey,
  symbolId: nullableKey,
  categoryKey: nullableKey,
});
const planEntrance = docEntranceSchema.extend({ id: key });

export const seatMapFilePlanSchema = z.object({
  name: z.string().trim().min(1).max(120),
  canvasWidth: z.number().int().min(100).max(100_000),
  canvasHeight: z.number().int().min(100).max(100_000),
  settings: seatMapSettingsSchema
    .extend({ defaultSeatSymbolId: key.nullable().optional() })
    .prefault({}),
  entrances: z.array(planEntrance).max(200).default([]),
  sections: z.array(planSection).max(2_000).default([]),
  rows: z.array(planRow).max(10_000).default([]),
  elements: z.array(planElement).max(5_000).default([]),
  seats: z.array(planSeat).max(100_000).default([]),
});
export type SeatMapFilePlan = z.infer<typeof seatMapFilePlanSchema>;

export const seatMapFileSchema = z
  .object({
    format: z.literal(SEAT_MAP_FILE_FORMAT),
    version: z.union([z.literal(1), z.literal(SEAT_MAP_FILE_VERSION)]),
    exportedAt: z.string().max(40),
    source: z.object({ appVersion: z.string().max(40) }),
    plan: seatMapFilePlanSchema,
    categories: z.array(planCategorySchema).max(200).default([]),
    symbols: z.array(planSymbolSchema).max(500).default([]),
    /** Images of IMAGE elements, referenced by `imageKey`. */
    images: z.array(planImageSchema.extend({ key })).max(50).default([]),
    background: planImageSchema.nullable().default(null),
  })
  .superRefine((file, ctx) => {
    const symbols = new Set(file.symbols.map((s) => s.key));
    const images = new Set(file.images.map((i) => i.key));
    const categories = new Set(file.categories.map((c) => c.key));
    const fail = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const dupKeys = (name: string, keys: string[]) => {
      if (new Set(keys).size !== keys.length) fail([name], 'Duplicate key');
    };
    dupKeys(
      'symbols',
      file.symbols.map((s) => s.key),
    );
    dupKeys(
      'images',
      file.images.map((i) => i.key),
    );
    dupKeys(
      'categories',
      file.categories.map((c) => c.key),
    );
    const symbolRef = (id: string | null | undefined, path: (string | number)[]) => {
      if (id && !symbols.has(id)) fail(path, 'Unknown symbol key');
    };
    symbolRef(file.plan.settings.defaultSeatSymbolId, ['plan', 'settings', 'defaultSeatSymbolId']);
    file.plan.seats.forEach((s, i) => {
      symbolRef(s.symbolId, ['plan', 'seats', i, 'symbolId']);
      if (s.categoryKey && !categories.has(s.categoryKey))
        fail(['plan', 'seats', i, 'categoryKey'], 'Unknown category key');
    });
    file.plan.sections.forEach((s, i) => {
      if (s.categoryKey && !categories.has(s.categoryKey))
        fail(['plan', 'sections', i, 'categoryKey'], 'Unknown category key');
    });
    file.plan.elements.forEach((e, i) => {
      symbolRef(e.style.symbolId, ['plan', 'elements', i, 'style', 'symbolId']);
      if (e.type === 'IMAGE' && (!e.imageKey || !images.has(e.imageKey)))
        fail(['plan', 'elements', i, 'imageKey'], 'Image missing');
      if (e.imageKey && !images.has(e.imageKey))
        fail(['plan', 'elements', i, 'imageKey'], 'Unknown');
    });
  });
export type SeatMapFile = z.infer<typeof seatMapFileSchema>;

/**
 * The editor document the plan describes, with every local key mapped to the given id.
 * Used by the importer and to validate the structure of a file before anything is stored.
 */
export function planToDocument(
  file: SeatMapFile,
  map: {
    uuid: () => string;
    symbolIds: ReadonlyMap<string, string>;
    imageIds: ReadonlyMap<string, string>;
    backgroundAssetId: string | null;
  },
) {
  const { plan } = file;
  const ids = new Map<string, string>();
  const id = (k: string): string => {
    let v = ids.get(k);
    if (!v) {
      v = map.uuid();
      ids.set(k, v);
    }
    return v;
  };
  const opt = (k: string | null | undefined) => (k ? id(k) : null);
  const sym = (k: string | null | undefined) => (k ? (map.symbolIds.get(k) ?? null) : null);
  return {
    version: 1,
    name: plan.name,
    canvasWidth: plan.canvasWidth,
    canvasHeight: plan.canvasHeight,
    backgroundAssetId: map.backgroundAssetId,
    settings: {
      ...plan.settings,
      ...(plan.settings.defaultSeatSymbolId
        ? { defaultSeatSymbolId: sym(plan.settings.defaultSeatSymbolId) }
        : {}),
    },
    entrances: plan.entrances.map((e) => ({ ...e, id: id(`e:${e.id}`) })),
    categories: file.categories.map((c, i) => ({
      id: id(`c:${c.key}`),
      name: c.name,
      color: c.color,
      translations: c.translations,
      sortOrder: i,
    })),
    sections: plan.sections.map(({ categoryKey, ...s }) => ({
      ...s,
      id: id(`s:${s.id}`),
      entranceId: opt(s.entranceId && `e:${s.entranceId}`),
      priceCategoryId: opt(categoryKey && `c:${categoryKey}`),
    })),
    rows: plan.rows.map((r) => ({ ...r, id: id(`r:${r.id}`), sectionId: id(`s:${r.sectionId}`) })),
    elements: plan.elements.map(({ imageKey, ...e }) => {
      const { symbolId, ...style } = e.style;
      const mapped = sym(symbolId);
      return {
        ...e,
        id: id(`el:${e.id}`),
        sectionId: opt(e.sectionId && `s:${e.sectionId}`),
        assetId: imageKey ? (map.imageIds.get(imageKey) ?? null) : null,
        style: mapped ? { ...style, symbolId: mapped } : style,
      };
    }),
    seats: plan.seats.map(({ categoryKey, ...s }) => ({
      ...s,
      id: id(`p:${s.id}`),
      sectionId: id(`s:${s.sectionId}`),
      rowId: opt(s.rowId && `r:${s.rowId}`),
      tableElementId: opt(s.tableElementId && `el:${s.tableElementId}`),
      companionOfSeatId: opt(s.companionOfSeatId && `p:${s.companionOfSeatId}`),
      symbolId: sym(s.symbolId),
      priceCategoryId: opt(categoryKey && `c:${categoryKey}`),
    })),
  } satisfies z.input<typeof seatMapDocumentSchema>;
}

/** Counts shown in the import preview. */
export interface SeatMapFileSummary {
  name: string;
  exportedAt: string;
  sections: number;
  seatedSections: number;
  standingSections: number;
  rows: number;
  seats: number;
  elements: number;
  entrances: number;
  symbols: number;
  categories: { name: string; color: string }[];
  hasBackground: boolean;
  images: number;
}

export function summarizeSeatMapFile(file: SeatMapFile): SeatMapFileSummary {
  const { plan } = file;
  return {
    name: plan.name,
    exportedAt: file.exportedAt,
    sections: plan.sections.length,
    seatedSections: plan.sections.filter((s) => s.type === 'SEATED').length,
    standingSections: plan.sections.filter((s) => s.type === 'STANDING').length,
    rows: plan.rows.length,
    seats: plan.seats.length,
    elements: plan.elements.length,
    entrances: plan.entrances.length,
    symbols: file.symbols.length,
    categories: file.categories.map((c) => ({ name: c.name, color: c.color })),
    hasBackground: file.background !== null,
    images: file.images.length,
  };
}
