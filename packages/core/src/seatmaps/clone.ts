import { randomUUID } from 'node:crypto';
import {
  seatMapElements,
  seatMapEntrances,
  seatMapRows,
  seatMapSections,
  seatMaps,
  seats,
  type Executor,
} from '@tix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { sequential } from '../sequential';

/**
 * Deep-copies a seat map (master template → event copy, or event → event when an event is
 * cloned). All ids are regenerated and internal references re-mapped. Soft-removed
 * entities are not copied. `categoryMap` translates price category ids (event clones);
 * without it categories are cleared (template → event: categories are assigned later).
 */
export async function cloneSeatMap(
  tx: Executor,
  sourceId: string,
  target: { kind: 'TEMPLATE' | 'EVENT'; name: string; categoryMap?: Map<string, string> },
): Promise<string> {
  const [source] = await tx.select().from(seatMaps).where(eq(seatMaps.id, sourceId));
  if (!source) throw new Error(`Seat map ${sourceId} not found`);

  const [entrances, sections, rows, elements, seatRows] = await sequential([
    tx.select().from(seatMapEntrances).where(eq(seatMapEntrances.seatMapId, sourceId)),
    tx
      .select()
      .from(seatMapSections)
      .where(and(eq(seatMapSections.seatMapId, sourceId), isNull(seatMapSections.removedAt))),
    tx
      .select()
      .from(seatMapRows)
      .where(and(eq(seatMapRows.seatMapId, sourceId), isNull(seatMapRows.removedAt))),
    tx.select().from(seatMapElements).where(eq(seatMapElements.seatMapId, sourceId)),
    tx
      .select()
      .from(seats)
      .where(and(eq(seats.seatMapId, sourceId), isNull(seats.removedAt))),
  ]);

  const newMapId = randomUUID();
  const ids = new Map<string, string>();
  const remap = (id: string | null): string | null => (id ? (ids.get(id) ?? null) : null);
  for (const list of [entrances, sections, rows, elements, seatRows]) {
    for (const item of list) ids.set(item.id, randomUUID());
  }
  const category = (id: string | null) =>
    id && target.categoryMap ? (target.categoryMap.get(id) ?? null) : null;

  await tx.insert(seatMaps).values({
    id: newMapId,
    venueId: source.venueId,
    kind: target.kind,
    name: target.name,
    description: source.description,
    clonedFromId: source.id,
    canvasWidth: source.canvasWidth,
    canvasHeight: source.canvasHeight,
    backgroundAssetId: source.backgroundAssetId,
    settings: source.settings,
  });

  const insertAll = async <T>(table: Parameters<Executor['insert']>[0], values: T[]) => {
    for (let i = 0; i < values.length; i += 500) {
      await tx.insert(table).values(values.slice(i, i + 500) as never);
    }
  };

  await insertAll(
    seatMapEntrances,
    entrances.map((e) => ({
      ...e,
      id: ids.get(e.id)!,
      seatMapId: newMapId,
      createdAt: undefined,
      updatedAt: undefined,
    })),
  );
  await insertAll(
    seatMapSections,
    sections.map((s) => ({
      ...s,
      id: ids.get(s.id)!,
      seatMapId: newMapId,
      entranceId: remap(s.entranceId),
      priceCategoryId: category(s.priceCategoryId),
      allocatedCount: 0,
      createdAt: undefined,
      updatedAt: undefined,
    })),
  );
  await insertAll(
    seatMapRows,
    rows.map((r) => ({
      ...r,
      id: ids.get(r.id)!,
      seatMapId: newMapId,
      sectionId: ids.get(r.sectionId)!,
      createdAt: undefined,
      updatedAt: undefined,
    })),
  );
  await insertAll(
    seatMapElements,
    elements.map((e) => ({
      ...e,
      id: ids.get(e.id)!,
      seatMapId: newMapId,
      sectionId: remap(e.sectionId),
      createdAt: undefined,
      updatedAt: undefined,
    })),
  );
  await insertAll(
    seats,
    seatRows.map((s) => ({
      ...s,
      id: ids.get(s.id)!,
      seatMapId: newMapId,
      sectionId: ids.get(s.sectionId)!,
      rowId: remap(s.rowId),
      tableElementId: remap(s.tableElementId),
      companionOfSeatId: remap(s.companionOfSeatId),
      priceCategoryId: category(s.priceCategoryId),
      createdAt: undefined,
      updatedAt: undefined,
    })),
  );
  return newMapId;
}
