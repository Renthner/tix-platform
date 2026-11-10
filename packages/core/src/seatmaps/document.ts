import {
  events,
  orderItems,
  priceCategories,
  seatMapCategories,
  seatMapElements,
  seatMapEntrances,
  seatMapRows,
  seatMapSections,
  seatMaps,
  seats,
  svgSymbols,
  withTransaction,
  type Database,
  type Transaction,
} from '@tix/db';
import {
  INVENTORY_HOLDING_ITEM_STATUSES,
  seatMapDocumentSchema,
  type SeatMapDocument,
  type SeatMapSaveError,
  type SeatMapSettingsInput,
  cleanTranslations,
} from '@tix/shared';
import { and, asc, eq, getTableColumns, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { sequential } from '../sequential';

export interface SeatMapMeta {
  id: string;
  kind: 'TEMPLATE' | 'EVENT';
  venueId: string;
  eventId: string | null;
  version: number;
}

export async function getSeatMapMeta(db: Database, seatMapId: string): Promise<SeatMapMeta | null> {
  const [row] = await db
    .select({
      id: seatMaps.id,
      kind: seatMaps.kind,
      venueId: seatMaps.venueId,
      version: seatMaps.version,
      eventId: events.id,
    })
    .from(seatMaps)
    .leftJoin(events, eq(events.seatMapId, seatMaps.id))
    .where(eq(seatMaps.id, seatMapId));
  return row ?? null;
}

/** Loads the editable document (soft-removed entities are excluded). */
export async function loadSeatMapDocument(
  db: Database,
  seatMapId: string,
): Promise<SeatMapDocument | null> {
  const [map] = await db.select().from(seatMaps).where(eq(seatMaps.id, seatMapId));
  if (!map) return null;
  const isTemplate = map.kind === 'TEMPLATE';
  const [entrances, sections, rows, elements, seatRows, categoryRows] = await Promise.all([
    db.select().from(seatMapEntrances).where(eq(seatMapEntrances.seatMapId, seatMapId)),
    db
      .select()
      .from(seatMapSections)
      .where(and(eq(seatMapSections.seatMapId, seatMapId), isNull(seatMapSections.removedAt))),
    db
      .select()
      .from(seatMapRows)
      .where(and(eq(seatMapRows.seatMapId, seatMapId), isNull(seatMapRows.removedAt))),
    db.select().from(seatMapElements).where(eq(seatMapElements.seatMapId, seatMapId)),
    db
      .select()
      .from(seats)
      .where(and(eq(seats.seatMapId, seatMapId), isNull(seats.removedAt))),
    isTemplate
      ? db
          .select()
          .from(seatMapCategories)
          .where(eq(seatMapCategories.seatMapId, seatMapId))
          .orderBy(asc(seatMapCategories.sortOrder), asc(seatMapCategories.name))
      : Promise.resolve([]),
  ]);

  // On master plans `priceCategoryId` carries the plan category (seat_map_categories.id).
  return {
    version: map.version,
    name: map.name,
    canvasWidth: map.canvasWidth,
    canvasHeight: map.canvasHeight,
    backgroundAssetId: map.backgroundAssetId,
    settings: seatMapDocumentSchema.shape.settings.parse(map.settings),
    categories: categoryRows.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      sortOrder: c.sortOrder,
      translations: c.translations,
    })),
    entrances: entrances.map((e) => ({
      id: e.id,
      name: e.name,
      code: e.code,
      x: e.x,
      y: e.y,
      sortOrder: e.sortOrder,
      translations: e.translations,
    })),
    sections: sections.map((s) => ({
      id: s.id,
      type: s.type,
      name: s.name,
      ticketLabel: s.ticketLabel,
      geometry: s.geometry,
      label: s.label,
      color: s.color,
      sortOrder: s.sortOrder,
      entranceId: s.entranceId,
      priceCategoryId: isTemplate ? s.templateCategoryId : s.priceCategoryId,
      capacity: s.capacity,
      bestAvailablePriority: s.bestAvailablePriority,
      isBestAvailableEnabled: s.isBestAvailableEnabled,
      isActive: s.isActive,
      showNameOnMap: s.showNameOnMap,
      showLabelOnTicket: s.showLabelOnTicket,
      translations: s.translations,
    })),
    rows: rows.map((r) => ({
      id: r.id,
      sectionId: r.sectionId,
      label: r.label,
      sortOrder: r.sortOrder,
      geometry: r.geometry,
    })),
    elements: elements.map((e) => ({
      id: e.id,
      type: e.type,
      sectionId: e.sectionId,
      label: e.label,
      geometry: e.geometry,
      style: e.style,
      assetId: e.assetId,
      zIndex: e.zIndex,
      translations: e.translations,
    })),
    seats: seatRows.map((s) => ({
      id: s.id,
      sectionId: s.sectionId,
      rowId: s.rowId,
      tableElementId: s.tableElementId,
      label: s.label,
      position: s.position,
      x: s.x,
      y: s.y,
      rotation: s.rotation,
      priceCategoryId: isTemplate ? s.templateCategoryId : s.priceCategoryId,
      bestAvailableRank: s.bestAvailableRank,
      isWheelchairSpace: s.isWheelchairSpace,
      isCompanionSeat: s.isCompanionSeat,
      companionOfSeatId: s.companionOfSeatId,
      hasRestrictedView: s.hasRestrictedView,
      blockReason: s.blockReason,
      blockNote: s.blockNote,
      attributes: s.attributes,
      symbolId: s.symbolId,
    })),
  };
}

export type SaveSeatMapResult =
  | {
      ok: true;
      version: number;
      kind: 'TEMPLATE' | 'EVENT';
      eventId: string | null;
      /** Seats no longer part of the plan (deleted or soft-removed). */
      removedSeatIds: string[];
      /** Seats whose block state changed (to broadcast / release locks). */
      blockedSeatIds: string[];
    }
  | { ok: false; status: 404 | 409 | 422; error: SeatMapSaveError };

const CHUNK = 500;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `SET col = excluded.col` for every column except the primary key / seat_map_id / created_at. */
/** Plan settings from the editor; translations the editor did not send are kept. */
function withSettingsTranslations(
  incoming: SeatMapSettingsInput,
  current: SeatMapSettingsInput,
): SeatMapSettingsInput {
  const source = incoming.translations ?? current.translations;
  const { translations: _drop, ...rest } = incoming;
  return source ? { ...rest, translations: cleanTranslations(source, 'seatMap') } : rest;
}

function excludedSet(table: PgTable): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    if (['id', 'seatMapId', 'createdAt'].includes(key)) continue;
    set[key] = sql.raw(`excluded."${column.name}"`);
  }
  set.updatedAt = sql`now()`;
  return set;
}

export class SaveAbort extends Error {
  constructor(readonly result: Extract<SaveSeatMapResult, { ok: false }>) {
    super(result.error.message);
  }
}

/**
 * Persists an editor document atomically:
 *  1. row lock + optimistic version check,
 *  2. referential validation (price categories must belong to the map's event),
 *  3. removal of entities missing from the document – soft removal when order items
 *     reference them, rejection when a removed seat holds an ACTIVE order item,
 *  4. temporary renaming of changed labels (avoids transient unique-index conflicts when
 *     rows/seats are renumbered), then bulk upserts,
 *  5. version bump.
 */
export async function saveSeatMapDocument(
  db: Database,
  seatMapId: string,
  input: unknown,
  actorUserId: string | null,
): Promise<SaveSeatMapResult> {
  const parsed = seatMapDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      status: 422,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The seat map document is invalid',
        issues: parsed.error.issues.slice(0, 50).map((i) => ({
          path: i.path.filter((p): p is string | number => typeof p !== 'symbol'),
          message: i.message,
        })),
      },
    };
  }
  const doc = parsed.data;

  try {
    return await withTransaction(db, (tx) => applySeatMapDocument(tx, seatMapId, doc, actorUserId));
  } catch (err) {
    if (err instanceof SaveAbort) return err.result;
    throw err;
  }
}

export async function applySeatMapDocument(
  tx: Transaction,
  seatMapId: string,
  doc: SeatMapDocument,
  actorUserId: string | null,
): Promise<SaveSeatMapResult> {
  const locked = await tx.execute<{
    id: string;
    kind: 'TEMPLATE' | 'EVENT';
    version: number;
    settings: SeatMapSettingsInput;
  }>(sql`SELECT id, kind, version, settings FROM seat_maps WHERE id = ${seatMapId} FOR UPDATE`);
  const map = locked.rows[0];
  if (!map)
    throw new SaveAbort({
      ok: false,
      status: 404,
      error: { code: 'NOT_FOUND', message: 'Seat map not found' },
    });
  if (map.version !== doc.version) {
    throw new SaveAbort({
      ok: false,
      status: 409,
      error: {
        code: 'VERSION_CONFLICT',
        message: 'The seat map was changed by someone else. Reload to continue.',
        currentVersion: map.version,
      },
    });
  }

  const [event] = await tx
    .select({ id: events.id })
    .from(events)
    .where(eq(events.seatMapId, seatMapId));
  const eventId = event?.id ?? null;

  // ── Price categories must belong to the event (templates carry none) ──────
  // ── Referenced symbols must exist in the library ──────────────────────────
  const symbolIds = new Set<string>();
  for (const s of doc.seats) if (s.symbolId) symbolIds.add(s.symbolId);
  for (const e of doc.elements) if (e.style.symbolId) symbolIds.add(e.style.symbolId);
  if (doc.settings.defaultSeatSymbolId) symbolIds.add(doc.settings.defaultSeatSymbolId);
  if (symbolIds.size > 0) {
    const found = new Set(
      (
        await tx
          .select({ id: svgSymbols.id })
          .from(svgSymbols)
          .where(inArray(svgSymbols.id, [...symbolIds]))
      ).map((r) => r.id),
    );
    const missing = [...symbolIds].filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new SaveAbort({
        ok: false,
        status: 422,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some symbols no longer exist in the symbol library',
          issues: missing.map((id) => ({ path: ['symbolId'], message: `Unknown symbol ${id}` })),
        },
      });
    }
  }

  const categoryIds = new Set<string>();
  for (const s of doc.seats) if (s.priceCategoryId) categoryIds.add(s.priceCategoryId);
  for (const s of doc.sections) if (s.priceCategoryId) categoryIds.add(s.priceCategoryId);
  const isTemplate = map.kind === 'TEMPLATE';
  if (categoryIds.size > 0) {
    // Master plans reference their own plan categories, event plans the event's price categories.
    const allowed = isTemplate
      ? new Set(doc.categories.map((c) => c.id))
      : eventId
        ? new Set(
            (
              await tx
                .select({ id: priceCategories.id })
                .from(priceCategories)
                .where(eq(priceCategories.eventId, eventId))
            ).map((c) => c.id),
          )
        : new Set<string>();
    const unknown = [...categoryIds].filter((id) => !allowed.has(id));
    if (unknown.length > 0) {
      throw new SaveAbort({
        ok: false,
        status: 422,
        error: {
          code: 'VALIDATION_FAILED',
          message: isTemplate
            ? 'Unknown plan category'
            : 'Price categories must belong to this event',
          issues: unknown.map((id) => ({
            path: ['priceCategoryId'],
            message: `Unknown category ${id}`,
          })),
        },
      });
    }
  }

  // ── Current state ─────────────────────────────────────────────────────────
  const [curSeats, curSections, curRows, curElements, curEntrances, curCategories] =
    await sequential([
      tx
        .select({
          id: seats.id,
          rowId: seats.rowId,
          tableElementId: seats.tableElementId,
          label: seats.label,
          position: seats.position,
          blockReason: seats.blockReason,
        })
        .from(seats)
        .where(and(eq(seats.seatMapId, seatMapId), isNull(seats.removedAt))),
      tx
        .select({ id: seatMapSections.id, name: seatMapSections.name })
        .from(seatMapSections)
        .where(and(eq(seatMapSections.seatMapId, seatMapId), isNull(seatMapSections.removedAt))),
      tx
        .select({ id: seatMapRows.id, sectionId: seatMapRows.sectionId, label: seatMapRows.label })
        .from(seatMapRows)
        .where(and(eq(seatMapRows.seatMapId, seatMapId), isNull(seatMapRows.removedAt))),
      tx
        .select({ id: seatMapElements.id })
        .from(seatMapElements)
        .where(eq(seatMapElements.seatMapId, seatMapId)),
      tx
        .select({ id: seatMapEntrances.id })
        .from(seatMapEntrances)
        .where(eq(seatMapEntrances.seatMapId, seatMapId)),
      tx
        .select({ id: seatMapCategories.id })
        .from(seatMapCategories)
        .where(eq(seatMapCategories.seatMapId, seatMapId)),
    ]);

  const docSeatIds = new Set(doc.seats.map((s) => s.id));
  const docSectionIds = new Set(doc.sections.map((s) => s.id));
  const docRowIds = new Set(doc.rows.map((r) => r.id));
  const docElementIds = new Set(doc.elements.map((e) => e.id));
  const docEntranceIds = new Set(doc.entrances.map((e) => e.id));

  const goneSeats = curSeats.filter((s) => !docSeatIds.has(s.id)).map((s) => s.id);
  const goneSections = curSections.filter((s) => !docSectionIds.has(s.id)).map((s) => s.id);
  const goneRows = curRows.filter((r) => !docRowIds.has(r.id)).map((r) => r.id);
  const goneElements = curElements.filter((e) => !docElementIds.has(e.id)).map((e) => e.id);
  const goneEntrances = curEntrances.filter((e) => !docEntranceIds.has(e.id)).map((e) => e.id);

  // ── Seats referenced by orders: active → reject, history → soft remove ────
  const referencedSeats = new Set<string>();
  if (goneSeats.length > 0) {
    const active: string[] = [];
    for (const part of chunks(goneSeats)) {
      const refs = await tx
        .select({ seatId: orderItems.seatId, status: orderItems.status })
        .from(orderItems)
        .where(inArray(orderItems.seatId, part));
      for (const r of refs) {
        if (!r.seatId) continue;
        referencedSeats.add(r.seatId);
        if ((INVENTORY_HOLDING_ITEM_STATUSES as readonly string[]).includes(r.status))
          active.push(r.seatId);
      }
    }
    if (active.length > 0) {
      throw new SaveAbort({
        ok: false,
        status: 409,
        error: {
          code: 'SEATS_IN_USE',
          message:
            'Some removed seats are sold or reserved. Block them instead, or move the orders first.',
          seatIds: [...new Set(active)],
        },
      });
    }
  }

  // Sections / rows that still contain referenced seats (or GA order items) are soft-removed.
  const keepSections = new Set<string>();
  const keepRows = new Set<string>();
  if (goneSections.length > 0 || goneRows.length > 0) {
    const holders = await tx
      .select({ sectionId: seats.sectionId, rowId: seats.rowId })
      .from(seats)
      .innerJoin(orderItems, eq(orderItems.seatId, seats.id))
      .where(eq(seats.seatMapId, seatMapId));
    for (const h of holders) {
      keepSections.add(h.sectionId);
      if (h.rowId) keepRows.add(h.rowId);
    }
    if (goneSections.length > 0) {
      const ga = await tx
        .selectDistinct({ sectionId: orderItems.sectionId })
        .from(orderItems)
        .where(inArray(orderItems.sectionId, goneSections));
      for (const g of ga) keepSections.add(g.sectionId);
    }
  }

  const now = new Date();
  const softSeats = goneSeats.filter((id) => referencedSeats.has(id));
  const hardSeats = goneSeats.filter((id) => !referencedSeats.has(id));
  for (const part of chunks(softSeats)) {
    await tx.update(seats).set({ removedAt: now }).where(inArray(seats.id, part));
  }
  for (const part of chunks(hardSeats)) await tx.delete(seats).where(inArray(seats.id, part));

  const softRows = goneRows.filter((id) => keepRows.has(id));
  const hardRows = goneRows.filter((id) => !keepRows.has(id));
  if (softRows.length > 0)
    await tx.update(seatMapRows).set({ removedAt: now }).where(inArray(seatMapRows.id, softRows));
  if (hardRows.length > 0) await tx.delete(seatMapRows).where(inArray(seatMapRows.id, hardRows));

  const softSections = goneSections.filter((id) => keepSections.has(id));
  const hardSections = goneSections.filter((id) => !keepSections.has(id));
  if (softSections.length > 0) {
    await tx
      .update(seatMapSections)
      .set({ removedAt: now })
      .where(inArray(seatMapSections.id, softSections));
  }
  if (hardSections.length > 0)
    await tx.delete(seatMapSections).where(inArray(seatMapSections.id, hardSections));
  if (goneElements.length > 0)
    await tx.delete(seatMapElements).where(inArray(seatMapElements.id, goneElements));
  if (goneEntrances.length > 0)
    await tx.delete(seatMapEntrances).where(inArray(seatMapEntrances.id, goneEntrances));

  // ── Temporary renames for changed unique keys (renumbering-safe) ──────────
  const curSectionById = new Map(curSections.map((s) => [s.id, s]));
  const renamedSections = doc.sections
    .filter((s) => curSectionById.has(s.id) && curSectionById.get(s.id)!.name !== s.name)
    .map((s) => s.id);
  if (renamedSections.length > 0) {
    await tx
      .update(seatMapSections)
      .set({ name: sql`'~' || ${seatMapSections.id}::text` })
      .where(inArray(seatMapSections.id, renamedSections));
  }
  const curRowById = new Map(curRows.map((r) => [r.id, r]));
  const renamedRows = doc.rows
    .filter((r) => {
      const cur = curRowById.get(r.id);
      return cur && (cur.label !== r.label || cur.sectionId !== r.sectionId);
    })
    .map((r) => r.id);
  if (renamedRows.length > 0) {
    await tx
      .update(seatMapRows)
      .set({ label: sql`'~' || ${seatMapRows.id}::text` })
      .where(inArray(seatMapRows.id, renamedRows));
  }
  const curSeatById = new Map(curSeats.map((s) => [s.id, s]));
  const movedSeats = doc.seats.filter((s) => {
    const cur = curSeatById.get(s.id);
    return (
      cur &&
      (cur.label !== s.label ||
        cur.position !== s.position ||
        cur.rowId !== s.rowId ||
        cur.tableElementId !== s.tableElementId)
    );
  });
  let tmp = 0;
  for (const part of chunks(movedSeats)) {
    const values = sql.join(
      part.map((s) => {
        tmp += 1;
        return sql`(${s.id}::uuid, ${-tmp}::int)`;
      }),
      sql`, `,
    );
    await tx.execute(sql`
      UPDATE seats SET label = '~' || seats.id::text, position = v.tmp
      FROM (VALUES ${values}) AS v(id, tmp)
      WHERE seats.id = v.id`);
  }

  // ── Upserts (FK order: entrances → sections → rows → elements → seats) ────
  const guard = (table: PgTable & { seatMapId: unknown }) =>
    sql`${(table as unknown as typeof seats).seatMapId} = excluded.seat_map_id`;

  const upsert = async <T extends Record<string, unknown>>(
    table: PgTable,
    rows: T[],
    label: string,
    overrides: Record<string, SQL> = {},
  ): Promise<void> => {
    const set = { ...excludedSet(table), ...overrides };
    for (const part of chunks(rows)) {
      const written = await tx
        .insert(table)
        .values(part as never)
        .onConflictDoUpdate({
          target: (table as unknown as typeof seats).id,
          set,
          setWhere: guard(table as PgTable & { seatMapId: unknown }),
        })
        .returning({ id: (table as unknown as typeof seats).id });
      if (written.length !== part.length) {
        throw new SaveAbort({
          ok: false,
          status: 422,
          error: {
            code: 'VALIDATION_FAILED',
            message: `Some ${label} ids belong to another seat map`,
          },
        });
      }
    }
  };

  if (isTemplate) {
    await upsert(
      seatMapCategories,
      doc.categories.map((c) => ({
        ...c,
        translations: cleanTranslations(c.translations, 'priceCategory'),
        seatMapId,
      })),
      'category',
    );
  }
  await upsert(
    seatMapEntrances,
    doc.entrances.map((e) => ({
      ...e,
      translations: cleanTranslations(e.translations, 'entrance'),
      seatMapId,
    })),
    'entrance',
  );
  await upsert(
    seatMapSections,
    doc.sections.map((s) => ({
      ...s,
      translations: cleanTranslations(s.translations, 'section'),
      seatMapId,
      capacity: s.type === 'STANDING' ? s.capacity : null,
      priceCategoryId: isTemplate ? null : s.priceCategoryId,
      templateCategoryId: isTemplate ? s.priceCategoryId : null,
      removedAt: null,
    })),
    'section',
  );
  await upsert(
    seatMapRows,
    doc.rows.map((r) => ({ ...r, seatMapId, removedAt: null })),
    'row',
  );
  await upsert(
    seatMapElements,
    doc.elements.map((e) => ({
      ...e,
      translations: cleanTranslations(e.translations, 'element'),
      seatMapId,
    })),
    'element',
  );
  // An unchanged block keeps its original timestamp and author.
  const keepBlock = (column: string) =>
    sql.raw(
      `CASE WHEN excluded.block_reason IS NULL THEN NULL
            WHEN seats.block_reason IS NOT DISTINCT FROM excluded.block_reason THEN seats.${column}
            ELSE excluded.${column} END`,
    );
  await upsert(
    seats,
    doc.seats.map((s) => ({
      ...s,
      seatMapId,
      priceCategoryId: isTemplate ? null : s.priceCategoryId,
      templateCategoryId: isTemplate ? s.priceCategoryId : null,
      blockedAt: s.blockReason ? now : null,
      blockedByUserId: s.blockReason ? actorUserId : null,
      removedAt: null,
    })),
    'seat',
    { blockedAt: keepBlock('blocked_at'), blockedByUserId: keepBlock('blocked_by_user_id') },
  );

  if (isTemplate) {
    const keep = new Set(doc.categories.map((c) => c.id));
    const goneCategories = curCategories.filter((c) => !keep.has(c.id)).map((c) => c.id);
    if (goneCategories.length > 0)
      await tx.delete(seatMapCategories).where(inArray(seatMapCategories.id, goneCategories));
  }

  const newVersion = map.version + 1;
  await tx
    .update(seatMaps)
    .set({
      name: doc.name,
      canvasWidth: doc.canvasWidth,
      canvasHeight: doc.canvasHeight,
      backgroundAssetId: doc.backgroundAssetId,
      settings: withSettingsTranslations(doc.settings, map.settings),
      version: newVersion,
    })
    .where(eq(seatMaps.id, seatMapId));

  const blockedSeatIds = doc.seats
    .filter((s) => (curSeatById.get(s.id)?.blockReason ?? null) !== s.blockReason)
    .map((s) => s.id);

  return {
    ok: true,
    version: newVersion,
    kind: map.kind,
    eventId,
    removedSeatIds: goneSeats,
    blockedSeatIds,
  };
}
