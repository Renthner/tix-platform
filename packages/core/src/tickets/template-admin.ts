import { events, priceCategories, ticketTemplates, withTransaction, type Executor } from '@tix/db';
import {
  isMediaKindAllowed,
  ticketTemplateInputSchema,
  type TicketTemplateInput,
} from '@tix/shared';
import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import { eventTags, invalidateShopCache } from '../cache/shop-cache';
import { getMediaAsset } from '../media';

/** Admin service of the ticket designer (library, event templates, assignments). */

export type TicketTemplateRow = typeof ticketTemplates.$inferSelect;

export interface TicketTemplateListEntry {
  id: string;
  name: string;
  description: string | null;
  eventId: string | null;
  isDefault: boolean;
  pageWidthMm: number;
  pageHeightMm: number;
  version: number;
  updatedAt: Date;
  /** Events + categories using the template. */
  usageCount: number;
}

async function usageCounts(db: Executor): Promise<Map<string, number>> {
  const [eventUse, categoryUse] = await Promise.all([
    db
      .select({ id: events.ticketTemplateId, n: count() })
      .from(events)
      .where(sql`${events.ticketTemplateId} IS NOT NULL`)
      .groupBy(events.ticketTemplateId),
    db
      .select({ id: priceCategories.ticketTemplateId, n: count() })
      .from(priceCategories)
      .where(sql`${priceCategories.ticketTemplateId} IS NOT NULL`)
      .groupBy(priceCategories.ticketTemplateId),
  ]);
  const map = new Map<string, number>();
  for (const row of [...eventUse, ...categoryUse]) {
    if (row.id) map.set(row.id, (map.get(row.id) ?? 0) + row.n);
  }
  return map;
}

/** Library templates (`eventId` omitted/null) or the event's own templates. */
export async function listTicketTemplates(
  db: Executor,
  scope: { eventId?: string | null } = {},
): Promise<TicketTemplateListEntry[]> {
  const rows = await db
    .select({
      id: ticketTemplates.id,
      name: ticketTemplates.name,
      description: ticketTemplates.description,
      eventId: ticketTemplates.eventId,
      isDefault: ticketTemplates.isDefault,
      pageWidthMm: ticketTemplates.pageWidthMm,
      pageHeightMm: ticketTemplates.pageHeightMm,
      version: ticketTemplates.version,
      updatedAt: ticketTemplates.updatedAt,
    })
    .from(ticketTemplates)
    .where(
      scope.eventId ? eq(ticketTemplates.eventId, scope.eventId) : isNull(ticketTemplates.eventId),
    )
    .orderBy(asc(ticketTemplates.name));
  const usage = await usageCounts(db);
  return rows.map((r) => ({ ...r, usageCount: usage.get(r.id) ?? 0 }));
}

export async function getTicketTemplate(
  db: Executor,
  id: string,
): Promise<TicketTemplateRow | null> {
  const [row] = await db.select().from(ticketTemplates).where(eq(ticketTemplates.id, id));
  return row ?? null;
}

async function assertBackground(ctx: CoreContext, assetId: string | null | undefined) {
  if (!assetId) return;
  const asset = await getMediaAsset(ctx, assetId);
  if (!asset) throw new DomainError('MEDIA_NOT_FOUND', 'Background image not found', 404);
  // Ticket backgrounds are private: any library image is fine, generated documents are not.
  if (!isMediaKindAllowed(asset.kind, 'private')) {
    throw new DomainError('MEDIA_NOT_FOUND', 'Background image not found', 404);
  }
}

export async function createTicketTemplate(
  ctx: CoreContext,
  params: { input: TicketTemplateInput; eventId?: string | null; userId: string | null },
): Promise<TicketTemplateRow> {
  const input = ticketTemplateInputSchema.parse(params.input);
  await assertBackground(ctx, input.backgroundAssetId);
  const [row] = await ctx.db
    .insert(ticketTemplates)
    .values({
      eventId: params.eventId ?? null,
      name: input.name,
      description: input.description ?? null,
      pageWidthMm: input.pageWidthMm,
      pageHeightMm: input.pageHeightMm,
      backgroundAssetId: input.backgroundAssetId ?? null,
      layout: input.layout,
      createdByUserId: params.userId,
    })
    .returning();
  return row!;
}

export async function updateTicketTemplate(
  ctx: CoreContext,
  params: { id: string; input: TicketTemplateInput },
): Promise<TicketTemplateRow> {
  const input = ticketTemplateInputSchema.parse(params.input);
  await assertBackground(ctx, input.backgroundAssetId);
  const [row] = await ctx.db
    .update(ticketTemplates)
    .set({
      name: input.name,
      description: input.description ?? null,
      pageWidthMm: input.pageWidthMm,
      pageHeightMm: input.pageHeightMm,
      backgroundAssetId: input.backgroundAssetId ?? null,
      layout: input.layout,
      version: sql`${ticketTemplates.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(ticketTemplates.id, params.id))
    .returning();
  if (!row) throw new DomainError('TEMPLATE_NOT_FOUND', 'Ticket template not found', 404);
  return row;
}

/** Copies a template (to the library, or into an event). */
export async function duplicateTicketTemplate(
  ctx: CoreContext,
  params: { id: string; eventId?: string | null; name?: string; userId: string | null },
): Promise<TicketTemplateRow> {
  const source = await getTicketTemplate(ctx.db, params.id);
  if (!source) throw new DomainError('TEMPLATE_NOT_FOUND', 'Ticket template not found', 404);
  const [row] = await ctx.db
    .insert(ticketTemplates)
    .values({
      eventId: params.eventId ?? null,
      name: (params.name ?? `${source.name} (copy)`).slice(0, 120),
      description: source.description,
      pageWidthMm: source.pageWidthMm,
      pageHeightMm: source.pageHeightMm,
      backgroundAssetId: source.backgroundAssetId,
      layout: source.layout,
      createdByUserId: params.userId,
    })
    .returning();
  return row!;
}

/** Makes a library template the global fallback (exactly one). */
export async function setDefaultTicketTemplate(ctx: CoreContext, id: string): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    const [row] = await tx
      .select({ eventId: ticketTemplates.eventId })
      .from(ticketTemplates)
      .where(eq(ticketTemplates.id, id))
      .for('update');
    if (!row) throw new DomainError('TEMPLATE_NOT_FOUND', 'Ticket template not found', 404);
    if (row.eventId) {
      throw new DomainError(
        'TEMPLATE_NOT_GLOBAL',
        'Only library templates can be the default',
        409,
      );
    }
    await tx
      .update(ticketTemplates)
      .set({ isDefault: false })
      .where(and(eq(ticketTemplates.isDefault, true), ne(ticketTemplates.id, id)));
    await tx.update(ticketTemplates).set({ isDefault: true }).where(eq(ticketTemplates.id, id));
  });
}

/** Deletes a template; events / categories using it fall back to the next level. */
export async function deleteTicketTemplate(ctx: CoreContext, id: string): Promise<void> {
  const row = await getTicketTemplate(ctx.db, id);
  if (!row) throw new DomainError('TEMPLATE_NOT_FOUND', 'Ticket template not found', 404);
  if (row.isDefault) {
    throw new DomainError(
      'TEMPLATE_IS_DEFAULT',
      'Make another template the default before deleting this one',
      409,
    );
  }
  await ctx.db.delete(ticketTemplates).where(eq(ticketTemplates.id, id));
}

async function assertAssignable(db: Executor, templateId: string, eventId: string) {
  const row = await getTicketTemplate(db, templateId);
  if (!row) throw new DomainError('TEMPLATE_NOT_FOUND', 'Ticket template not found', 404);
  if (row.eventId && row.eventId !== eventId) {
    throw new DomainError('TEMPLATE_OTHER_EVENT', 'Template belongs to another event', 409);
  }
}

export async function assignEventTicketTemplate(
  ctx: CoreContext,
  eventId: string,
  templateId: string | null,
): Promise<void> {
  if (templateId) await assertAssignable(ctx.db, templateId, eventId);
  const updated = await ctx.db
    .update(events)
    .set({ ticketTemplateId: templateId })
    .where(eq(events.id, eventId))
    .returning({ id: events.id });
  if (updated.length === 0) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  await invalidateShopCache(ctx, eventTags(eventId));
}

export async function assignCategoryTicketTemplate(
  ctx: CoreContext,
  params: { eventId: string; categoryId: string; templateId: string | null },
): Promise<void> {
  if (params.templateId) await assertAssignable(ctx.db, params.templateId, params.eventId);
  const updated = await ctx.db
    .update(priceCategories)
    .set({ ticketTemplateId: params.templateId })
    .where(
      and(eq(priceCategories.id, params.categoryId), eq(priceCategories.eventId, params.eventId)),
    )
    .returning({ id: priceCategories.id });
  if (updated.length === 0) throw new DomainError('CATEGORY_NOT_FOUND', 'Category not found', 404);
  await invalidateShopCache(ctx, eventTags(params.eventId));
}
