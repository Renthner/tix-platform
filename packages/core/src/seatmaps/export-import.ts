import { createHash, randomUUID } from 'node:crypto';
import {
  mediaAssets,
  priceCategories,
  seatMaps,
  svgSymbols,
  venues,
  withTransaction,
  type Transaction,
} from '@tix/db';
import {
  SEAT_MAP_FILE_FORMAT,
  SEAT_MAP_FILE_MAX_BYTES,
  SEAT_MAP_FILE_MIN_VERSION,
  SEAT_MAP_FILE_VERSION,
  planToDocument,
  seatMapDocumentSchema,
  seatMapFileSchema,
  type PlanImage,
  type SeatMapFile,
} from '@tix/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { DomainError, requireCapability, type CoreContext } from '../context';
import { getMediaAsset, loadMediaBytes, uploadMediaAsset } from '../media';
import { deleteMediaAsset } from '../media-admin';
import { sanitizeSvg } from '../symbols';
import { SaveAbort, applySeatMapDocument, getSeatMapMeta, loadSeatMapDocument } from './document';

/**
 * Seat plan export / import (`*.tixplan.json`, see `seatMapFileSchema`).
 *
 * Export is deterministic (entities are ordered by their editor order and keyed "s1", "r2" …),
 * so exporting an imported plan yields the same file apart from `exportedAt`, plan version
 * and name. Import always creates a NEW venue master plan; the plan is written through the
 * editor's own save routine so it is indistinguishable from an editor-created plan.
 */

type Doc = NonNullable<Awaited<ReturnType<typeof loadSeatMapDocument>>>;

const sorted = <T>(items: T[], ...keys: ((item: T) => string | number)[]): T[] =>
  [...items].sort((a, b) => {
    for (const k of keys) {
      const x = k(a);
      const y = k(b);
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  });

async function exportImage(ctx: CoreContext, assetId: string): Promise<PlanImage> {
  const asset = await getMediaAsset(ctx, assetId);
  if (!asset) throw new DomainError('MEDIA_NOT_FOUND', 'An image of the plan is missing', 409);
  const bytes = await loadMediaBytes(ctx, assetId);
  return {
    fileName: asset.fileName,
    contentType: asset.mimeType as PlanImage['contentType'],
    width: asset.width,
    height: asset.height,
    dataBase64: Buffer.from(bytes.bytes).toString('base64'),
  };
}

/** Builds the export file of a venue master plan or an event plan (no orders, no customer data). */
export async function exportSeatMap(
  ctx: CoreContext,
  seatMapId: string,
  options: { appVersion?: string } = {},
): Promise<SeatMapFile> {
  requireCapability(ctx, 'storage');
  const meta = await getSeatMapMeta(ctx.db, seatMapId);
  const doc: Doc | null = await loadSeatMapDocument(ctx.db, seatMapId);
  if (!doc || !meta) throw new DomainError('NOT_FOUND', 'Seat map not found', 404);

  const counters: Record<string, number> = {};
  const next = (prefix: string) => `${prefix}${(counters[prefix] = (counters[prefix] ?? 0) + 1)}`;

  const entrances = sorted(
    doc.entrances,
    (e) => e.sortOrder,
    (e) => e.code,
  );
  const sections = sorted(
    doc.sections,
    (s) => s.sortOrder,
    (s) => s.name,
  );
  const sectionIdx = new Map(sections.map((s, i) => [s.id, i]));
  const rows = sorted(
    doc.rows,
    (r) => sectionIdx.get(r.sectionId) ?? 0,
    (r) => r.sortOrder,
    (r) => r.label,
  );
  const elements = sorted(
    doc.elements,
    (e) => e.zIndex,
    (e) => e.type,
    (e) => e.label ?? '',
    (e) => JSON.stringify(e.geometry),
  );
  const keyOf = new Map<string, string>();
  const keyed = (prefix: string, list: { id: string }[]) =>
    list.forEach((item) => keyOf.set(item.id, next(prefix)));
  keyed('e', entrances);
  keyed('s', sections);
  keyed('r', rows);
  keyed('el', elements);
  const rowIdx = new Map(rows.map((r, i) => [r.id, i]));
  const elementIdx = new Map(elements.map((e, i) => [e.id, i]));
  const seatList = sorted(
    doc.seats,
    (s) => sectionIdx.get(s.sectionId) ?? 0,
    (s) => (s.rowId ? (rowIdx.get(s.rowId) ?? 0) : 1e9),
    (s) => (s.tableElementId ? (elementIdx.get(s.tableElementId) ?? 0) : 1e9),
    (s) => s.position ?? 0,
    (s) => s.label,
    (s) => s.x,
    (s) => s.y,
  );
  keyed('p', seatList);

  // Symbols
  const symbolIds = new Set<string>();
  for (const s of doc.seats) if (s.symbolId) symbolIds.add(s.symbolId);
  for (const e of doc.elements) if (e.style.symbolId) symbolIds.add(e.style.symbolId);
  if (doc.settings.defaultSeatSymbolId) symbolIds.add(doc.settings.defaultSeatSymbolId);
  const symbolRows = symbolIds.size
    ? sorted(
        await ctx.db
          .select()
          .from(svgSymbols)
          .where(inArray(svgSymbols.id, [...symbolIds])),
        (s) => s.kind,
        (s) => s.name,
        (s) => s.markup,
      )
    : [];
  const symbolKey = new Map(symbolRows.map((s) => [s.id, next('sym')]));
  const sym = (id: string | null | undefined) => (id ? (symbolKey.get(id) ?? null) : null);

  // Categories (name / colour only)
  const categoryIds = new Set<string>();
  for (const s of doc.seats) if (s.priceCategoryId) categoryIds.add(s.priceCategoryId);
  for (const s of doc.sections) if (s.priceCategoryId) categoryIds.add(s.priceCategoryId);
  const categoryRows =
    meta.kind === 'TEMPLATE'
      ? sorted(
          doc.categories,
          (c) => c.sortOrder,
          (c) => c.name,
        )
      : categoryIds.size
        ? sorted(
            await ctx.db
              .select({
                id: priceCategories.id,
                name: priceCategories.name,
                color: priceCategories.color,
                translations: priceCategories.translations,
                sortOrder: priceCategories.sortOrder,
              })
              .from(priceCategories)
              .where(inArray(priceCategories.id, [...categoryIds])),
            (c) => c.sortOrder,
            (c) => c.name,
          )
        : [];
  const categoryKey = new Map(categoryRows.map((c) => [c.id, next('cat')]));
  const cat = (id: string | null) => (id ? (categoryKey.get(id) ?? null) : null);

  // Images
  const images: (PlanImage & { key: string })[] = [];
  const imageKey = new Map<string, string>();
  for (const e of elements) {
    if (!e.assetId || imageKey.has(e.assetId)) continue;
    const key = next('img');
    imageKey.set(e.assetId, key);
    images.push({ key, ...(await exportImage(ctx, e.assetId)) });
  }
  const background = doc.backgroundAssetId ? await exportImage(ctx, doc.backgroundAssetId) : null;

  const k = (id: string | null) => (id ? (keyOf.get(id) ?? null) : null);
  const file = {
    format: SEAT_MAP_FILE_FORMAT,
    version: SEAT_MAP_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    source: { appVersion: options.appVersion ?? 'unknown' },
    plan: {
      name: doc.name,
      canvasWidth: doc.canvasWidth,
      canvasHeight: doc.canvasHeight,
      settings: {
        ...doc.settings,
        defaultSeatSymbolId: sym(doc.settings.defaultSeatSymbolId),
      },
      entrances: entrances.map((e) => ({ ...e, id: keyOf.get(e.id)! })),
      sections: sections.map(({ priceCategoryId, ...s }) => ({
        ...s,
        id: keyOf.get(s.id)!,
        entranceId: k(s.entranceId),
        categoryKey: cat(priceCategoryId),
      })),
      rows: rows.map((r) => ({
        ...r,
        id: keyOf.get(r.id)!,
        sectionId: keyOf.get(r.sectionId)!,
      })),
      elements: elements.map(({ assetId, ...e }) => {
        const { symbolId, ...style } = e.style;
        const symbol = sym(symbolId);
        return {
          ...e,
          id: keyOf.get(e.id)!,
          sectionId: k(e.sectionId),
          imageKey: assetId ? (imageKey.get(assetId) ?? null) : null,
          style: symbol ? { ...style, symbolId: symbol } : style,
        };
      }),
      seats: seatList.map(({ priceCategoryId, ...s }) => ({
        ...s,
        id: keyOf.get(s.id)!,
        sectionId: keyOf.get(s.sectionId)!,
        rowId: k(s.rowId),
        tableElementId: k(s.tableElementId),
        companionOfSeatId: k(s.companionOfSeatId),
        symbolId: sym(s.symbolId),
        categoryKey: cat(priceCategoryId),
      })),
    },
    categories: categoryRows.map((c) => ({
      key: categoryKey.get(c.id)!,
      name: c.name,
      color: c.color,
      translations: c.translations,
    })),
    symbols: symbolRows.map((s) => ({
      key: symbolKey.get(s.id)!,
      name: s.name,
      kind: s.kind,
      viewBox: s.viewBox,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${s.viewBox}">${s.markup}</svg>`,
      colorize: s.colorize,
      builtinKey: s.builtinKey,
    })),
    images,
    background,
  };
  return seatMapFileSchema.parse(file);
}

/** Parses and validates the text of an uploaded plan file. */
export function parseSeatMapFile(text: string | Uint8Array): SeatMapFile {
  const size = typeof text === 'string' ? Buffer.byteLength(text) : text.byteLength;
  if (size > SEAT_MAP_FILE_MAX_BYTES) {
    throw new DomainError('SEATMAP_FILE_TOO_LARGE', 'The plan file is too large', 413);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(typeof text === 'string' ? text : Buffer.from(text).toString('utf8'));
  } catch {
    throw new DomainError('SEATMAP_FILE_INVALID', 'The file is not a seat plan file', 422);
  }
  const head = raw as { format?: unknown; version?: unknown } | null;
  if (!head || typeof head !== 'object' || head.format !== SEAT_MAP_FILE_FORMAT) {
    throw new DomainError('SEATMAP_FILE_INVALID', 'The file is not a seat plan file', 422);
  }
  if (
    typeof head.version !== 'number' ||
    head.version < SEAT_MAP_FILE_MIN_VERSION ||
    head.version > SEAT_MAP_FILE_VERSION
  ) {
    throw new DomainError(
      'SEATMAP_VERSION_UNSUPPORTED',
      'This plan file version is not supported',
      422,
    );
  }
  const parsed = seatMapFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError('SEATMAP_FILE_INVALID', 'The seat plan file is invalid', 422, {
      issues: parsed.error.issues
        .slice(0, 20)
        .map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

export interface ImportSeatMapResult {
  seatMapId: string;
  seats: number;
  symbolsCreated: number;
  symbolsReused: number;
  /** Plan categories created on the new master plan. */
  categories: number;
}

interface PreparedSymbol {
  key: string;
  name: string;
  kind: 'SEAT' | 'ELEMENT';
  viewBox: string;
  markup: string;
  colorize: boolean;
  builtinKey: string | null;
}

/** Imports a plan file as a new master plan of the venue; never touches existing plans. */
export async function importSeatMap(
  ctx: CoreContext,
  input: { venueId: string; file: unknown; name?: string; userId: string | null },
): Promise<ImportSeatMapResult> {
  requireCapability(ctx, 'storage');
  const file = seatMapFileSchema.parse(input.file);

  // Symbols are re-sanitised; nothing from the file is trusted.
  const prepared: PreparedSymbol[] = file.symbols.map((s) => {
    const clean = sanitizeSvg(s.svg, s.colorize);
    return {
      key: s.key,
      name: s.name,
      kind: s.kind,
      viewBox: clean.viewBox,
      markup: clean.markup,
      colorize: s.colorize,
      builtinKey: s.builtinKey,
    };
  });

  // Structural validation with throw-away ids before anything is stored.
  const dry = seatMapDocumentSchema.safeParse(
    planToDocument(file, {
      uuid: randomUUID,
      symbolIds: new Map(file.symbols.map((s) => [s.key, randomUUID()])),
      imageIds: new Map(file.images.map((i) => [i.key, randomUUID()])),
      backgroundAssetId: null,
    }),
  );
  if (!dry.success) {
    throw new DomainError('SEATMAP_FILE_INVALID', 'The seat plan file is invalid', 422, {
      issues: dry.error.issues
        .slice(0, 20)
        .map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  // Images go through the normal upload pipeline (type, size, dimensions). Assets that this
  // import created are removed again when the database transaction fails.
  const created: string[] = [];
  const upload = async (image: PlanImage): Promise<string> => {
    const bytes = new Uint8Array(Buffer.from(image.dataBase64, 'base64'));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const [existing] = await ctx.db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.kind, 'VENUE_BACKGROUND'), eq(mediaAssets.sha256, sha256)))
      .limit(1);
    const row = await uploadMediaAsset(ctx, {
      kind: 'VENUE_BACKGROUND',
      bytes,
      fileName: image.fileName,
      declaredMime: image.contentType,
      userId: input.userId,
    });
    if (!existing) created.push(row.id);
    return row.id;
  };

  try {
    const imageIds = new Map<string, string>();
    for (const image of file.images) imageIds.set(image.key, await upload(image));
    const backgroundAssetId = file.background ? await upload(file.background) : null;

    return await withTransaction(ctx.db, async (tx) => {
      const [venue] = await tx
        .select({ id: venues.id })
        .from(venues)
        .where(eq(venues.id, input.venueId));
      if (!venue) throw new DomainError('NOT_FOUND', 'Venue not found', 404);

      const symbols = await resolveSymbols(tx, prepared, input.userId);
      const doc = planToDocument(file, {
        uuid: randomUUID,
        symbolIds: symbols.ids,
        imageIds,
        backgroundAssetId,
      });
      const name = (input.name ?? file.plan.name).trim().slice(0, 120) || file.plan.name;
      const [map] = await tx
        .insert(seatMaps)
        .values({
          venueId: input.venueId,
          kind: 'TEMPLATE',
          name,
          canvasWidth: file.plan.canvasWidth,
          canvasHeight: file.plan.canvasHeight,
        })
        .returning({ id: seatMaps.id });
      try {
        await applySeatMapDocument(
          tx,
          map!.id,
          seatMapDocumentSchema.parse({ ...doc, name }),
          input.userId,
        );
      } catch (err) {
        if (err instanceof SaveAbort) {
          throw new DomainError('SEATMAP_FILE_INVALID', err.result.error.message, 422, {
            issues: err.result.error.issues,
          });
        }
        throw err;
      }
      return {
        seatMapId: map!.id,
        seats: file.plan.seats.length,
        symbolsCreated: symbols.created,
        symbolsReused: symbols.reused,
        categories: file.categories.length,
      };
    });
  } catch (err) {
    for (const id of created) await deleteMediaAsset(ctx, id).catch(() => {});
    throw err;
  }
}

/**
 * Maps file symbols to library symbols: the target's own copy of a built-in, an existing
 * symbol with identical sanitised content, or a new symbol (name made unique with a suffix).
 */
async function resolveSymbols(
  tx: Transaction,
  prepared: PreparedSymbol[],
  userId: string | null,
): Promise<{ ids: Map<string, string>; created: number; reused: number }> {
  const ids = new Map<string, string>();
  let created = 0;
  let reused = 0;
  if (prepared.length === 0) return { ids, created, reused };
  const names = new Set(
    (await tx.select({ name: svgSymbols.name }).from(svgSymbols)).map((r) => r.name.toLowerCase()),
  );
  for (const s of prepared) {
    if (s.builtinKey) {
      const [builtin] = await tx
        .select({ id: svgSymbols.id, kind: svgSymbols.kind })
        .from(svgSymbols)
        .where(eq(svgSymbols.builtinKey, s.builtinKey));
      if (builtin && builtin.kind === s.kind) {
        ids.set(s.key, builtin.id);
        reused += 1;
        continue;
      }
    }
    const [same] = await tx
      .select({ id: svgSymbols.id })
      .from(svgSymbols)
      .where(
        and(
          eq(svgSymbols.kind, s.kind),
          eq(svgSymbols.viewBox, s.viewBox),
          eq(svgSymbols.markup, s.markup),
          eq(svgSymbols.colorize, s.colorize),
        ),
      )
      .limit(1);
    if (same) {
      ids.set(s.key, same.id);
      reused += 1;
      continue;
    }
    let name = s.name.slice(0, 120);
    for (let n = 2; names.has(name.toLowerCase()); n += 1) {
      name = `${s.name.slice(0, 110)} (${n})`;
    }
    names.add(name.toLowerCase());
    const [row] = await tx
      .insert(svgSymbols)
      .values({
        name,
        kind: s.kind,
        viewBox: s.viewBox,
        markup: s.markup,
        colorize: s.colorize,
        createdByUserId: userId,
      })
      .returning({ id: svgSymbols.id });
    ids.set(s.key, row!.id);
    created += 1;
  }
  return { ids, created, reused };
}
