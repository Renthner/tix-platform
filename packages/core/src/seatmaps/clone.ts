import { randomUUID } from 'node:crypto';
import {
  priceCategories,
  seatMapCategories,
  seatMapElements,
  seatMapEntrances,
  seatMapRows,
  seatMapSections,
  seatMaps,
  seats,
  type Executor,
} from '@tix/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { sequential } from '../sequential';

/**
 * Deep-copies a seat map (master template → event copy, or event → event when an event is
 * cloned). All ids are regenerated and internal references re-mapped. Soft-removed
 * entities are not copied. `categoryMap` translates price category ids (event clones);
 * without it price categories are cleared. Template → event keeps the plan-category references
 * on the copy; `applyTemplateCategoriesToEvent` turns them into the event's price categories
 * once the event row exists. Template → template copies the plan categories.
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

  // Plan categories travel with template → template copies only.
  const planCategoryIds = new Map<string, string>();
  const planCategories =
    source.kind === 'TEMPLATE' && target.kind === 'TEMPLATE'
      ? await tx.select().from(seatMapCategories).where(eq(seatMapCategories.seatMapId, sourceId))
      : [];
  for (const c of planCategories) planCategoryIds.set(c.id, randomUUID());
  const templateCategory = (id: string | null) => {
    if (!id) return null;
    if (target.kind === 'TEMPLATE') return planCategoryIds.get(id) ?? null;
    return source.kind === 'TEMPLATE' ? id : null;
  };

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
    seatMapCategories,
    planCategories.map((c) => ({
      ...c,
      id: planCategoryIds.get(c.id)!,
      seatMapId: newMapId,
      createdAt: undefined,
      updatedAt: undefined,
    })),
  );
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
      templateCategoryId: templateCategory(s.templateCategoryId),
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
      templateCategoryId: templateCategory(s.templateCategoryId),
      createdAt: undefined,
      updatedAt: undefined,
    })),
  );
  return newMapId;
}

/**
 * Event created from a master plan: the plan's categories become price categories of the event
 * (same name → reused, e.g. after a re-clone; no prices – a category is not offered in the shop
 * before the pricing matrix gives it a price) and the section / seat assignments of the event's
 * seat map copy are translated. Returns the number of categories created.
 */
export async function applyTemplateCategoriesToEvent(
  tx: Executor,
  params: { eventId: string; seatMapId: string },
): Promise<number> {
  const [copy] = await tx
    .select({ clonedFromId: seatMaps.clonedFromId })
    .from(seatMaps)
    .where(eq(seatMaps.id, params.seatMapId));
  if (!copy?.clonedFromId) return 0;
  const planCategories = await tx
    .select()
    .from(seatMapCategories)
    .where(eq(seatMapCategories.seatMapId, copy.clonedFromId))
    .orderBy(asc(seatMapCategories.sortOrder), asc(seatMapCategories.name));
  if (planCategories.length === 0) return 0;

  const existing = await tx
    .select({
      id: priceCategories.id,
      name: priceCategories.name,
      sortOrder: priceCategories.sortOrder,
    })
    .from(priceCategories)
    .where(eq(priceCategories.eventId, params.eventId));
  const byName = new Map(existing.map((c) => [c.name, c.id]));
  let nextSort = existing.reduce((max, c) => Math.max(max, c.sortOrder + 1), 0);
  let created = 0;
  for (const category of planCategories) {
    if (byName.has(category.name)) continue;
    const [row] = await tx
      .insert(priceCategories)
      .values({
        eventId: params.eventId,
        name: category.name,
        color: category.color,
        translations: category.translations,
        basePrice: 0,
        sortOrder: nextSort,
      })
      .returning({ id: priceCategories.id });
    nextSort += 1;
    created += 1;
    byName.set(category.name, row!.id);
  }

  for (const category of planCategories) {
    const priceCategoryId = byName.get(category.name)!;
    for (const table of ['seat_map_sections', 'seats'] as const) {
      await tx.execute(sql`
        UPDATE ${sql.identifier(table)}
        SET price_category_id = ${priceCategoryId}, template_category_id = NULL
        WHERE seat_map_id = ${params.seatMapId} AND template_category_id = ${category.id}`);
    }
  }
  return created;
}
