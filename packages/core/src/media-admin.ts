import { mediaAssets, adminUsers, withTransaction, type Executor, type Transaction } from '@tix/db';
import type { MediaAssetKind } from '@tix/shared';
import { and, asc, desc, eq, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import { DomainError, requireCapability, type CoreContext } from './context';
import { safeFileName, type MediaAssetRow } from './media';

/**
 * Media library administration: where is an asset used, listing / filtering, rename and guarded
 * deletion. "In use" is defined in exactly one place (`usedIdsSql`) and shared by the list
 * filter, the summary, the bulk preview and the delete guard:
 *  - every foreign key column that points at `media_assets` (discovered from the catalogue, so
 *    tables added later are honoured automatically), plus
 *  - UUIDs embedded in JSON / rich text: ticket layouts (image elements), system settings
 *    (branding logo / favicon) and e-mail template bodies.
 * Tickets and PDFs are rendered on demand from the live templates and the event cover, so those
 * references already cover re-rendering of historic tickets.
 */

/** Kinds that are never listed or deleted here (generated documents are keyed by object key). */
const PROTECTED_KINDS: readonly MediaAssetKind[] = ['DOCUMENT'];

export type MediaUsageType =
  | 'EVENT_COVER'
  | 'SERIES_IMAGE'
  | 'VENUE_IMAGE'
  | 'SEAT_MAP_BACKGROUND'
  | 'SEAT_MAP_IMAGE'
  | 'TICKET_TEMPLATE_BACKGROUND'
  | 'TICKET_TEMPLATE_IMAGE'
  | 'WALLET_DESIGN'
  | 'EMAIL_TEMPLATE'
  | 'SETTING'
  | 'OTHER';

export interface MediaUsage {
  type: MediaUsageType;
  /** Name of the referencing record (event title, template name, …). */
  label: string;
  /** Extra info: wallet image slot, settings key, `table.column` for unknown references. */
  detail: string | null;
  /** Admin path (without locale) or null when there is no page for it. */
  href: string | null;
}

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

async function referencingColumns(db: Executor): Promise<{ table: string; column: string }[]> {
  const result = await db.execute<{ table: string; column: string }>(sql`
    SELECT cl.relname AS "table", att.attname AS "column"
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE con.contype = 'f'
      AND con.confrelid = 'media_assets'::regclass
      AND ns.nspname = current_schema()
  `);
  return result.rows;
}

/** Sub-select yielding the text id of every referenced asset (one column, never NULL). */
async function usedIdsSql(db: Executor): Promise<SQL> {
  const parts = (await referencingColumns(db)).map(
    ({ table, column }) =>
      sql`SELECT ${sql.identifier(column)}::text AS id FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} IS NOT NULL`,
  );
  parts.push(
    sql`SELECT m[1] FROM ticket_templates t, regexp_matches(t.layout::text, ${UUID_RE}, 'g') AS m`,
    sql`SELECT m[1] FROM system_settings s, regexp_matches(s.value::text, ${UUID_RE}, 'g') AS m WHERE s.value IS NOT NULL`,
    sql`SELECT m[1] FROM email_templates e, regexp_matches(e.body_html, ${UUID_RE}, 'g') AS m`,
  );
  return sql.join(parts, sql` UNION `);
}

export async function isMediaAssetInUse(ctx: CoreContext, id: string): Promise<boolean> {
  return isInUse(ctx.db, id);
}

async function isInUse(db: Executor, id: string): Promise<boolean> {
  const used = await usedIdsSql(db);
  const res = await db.execute(sql`SELECT 1 WHERE ${id}::text IN (${used})`);
  return res.rows.length > 0;
}

// ─── Usages (concrete places) ──────────────────────────────────────────────

const HANDLED_COLUMNS = new Set([
  'events.hero_image_asset_id',
  'event_series.image_asset_id',
  'venues.image_asset_id',
  'seat_maps.background_asset_id',
  'seat_map_elements.asset_id',
  'ticket_templates.background_asset_id',
  'wallet_pass_designs.logo_asset_id',
  'wallet_pass_designs.icon_asset_id',
  'wallet_pass_designs.strip_asset_id',
  'wallet_pass_designs.hero_asset_id',
]);

function settingsHref(key: string): string {
  if (key === 'branding') return '/admin/settings/appearance';
  if (key.startsWith('wallet.')) return '/admin/settings/wallet';
  return '/admin/settings';
}

async function rows<T>(db: Executor, query: SQL): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

/**
 * Usages of many assets at once: one query per reference source (no per-asset queries).
 * Every requested id is present in the result (empty array = unused).
 */
export async function mediaAssetUsagesBatch(
  ctx: CoreContext,
  ids: readonly string[],
): Promise<Map<string, MediaUsage[]>> {
  return usagesBatch(ctx.db, ids);
}

export async function mediaAssetUsages(ctx: CoreContext, id: string): Promise<MediaUsage[]> {
  return (await usagesBatch(ctx.db, [id])).get(id) ?? [];
}

async function usagesBatch(
  db: Executor,
  ids: readonly string[],
): Promise<Map<string, MediaUsage[]>> {
  const out = new Map<string, MediaUsage[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;
  const add = (id: string | null, usage: MediaUsage) => {
    if (id) out.get(id)?.push(usage);
  };
  const list = sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
  const mentioned = (text: string) => ids.filter((id) => text.includes(id));

  const [
    eventRows,
    seriesRows,
    venueRows,
    mapRows,
    elementRows,
    templateRows,
    walletRows,
    emailRows,
    settingRows,
    columns,
  ] = await Promise.all([
    rows<{ id: string; title: string; asset: string }>(
      db,
      sql`SELECT id, title, hero_image_asset_id AS asset FROM events WHERE hero_image_asset_id = ANY(${list})`,
    ),
    rows<{ name: string; asset: string }>(
      db,
      sql`SELECT name, image_asset_id AS asset FROM event_series WHERE image_asset_id = ANY(${list})`,
    ),
    rows<{ id: string; name: string; asset: string }>(
      db,
      sql`SELECT id, name, image_asset_id AS asset FROM venues WHERE image_asset_id = ANY(${list})`,
    ),
    rows<{ id: string; name: string; asset: string }>(
      db,
      sql`SELECT id, name, background_asset_id AS asset FROM seat_maps WHERE background_asset_id = ANY(${list})`,
    ),
    rows<{ id: string; name: string; asset: string }>(
      db,
      sql`SELECT DISTINCT m.id, m.name, e.asset_id AS asset
          FROM seat_map_elements e JOIN seat_maps m ON m.id = e.seat_map_id
          WHERE e.asset_id = ANY(${list})`,
    ),
    rows<{ id: string; name: string; bg: string | null; layout: string }>(
      db,
      sql`SELECT id, name, background_asset_id AS bg, layout::text AS layout FROM ticket_templates`,
    ),
    rows<{
      event_id: string | null;
      title: string | null;
      logo: string | null;
      icon: string | null;
      strip: string | null;
      hero: string | null;
    }>(
      db,
      sql`SELECT w.event_id, ev.title, w.logo_asset_id AS logo, w.icon_asset_id AS icon,
                 w.strip_asset_id AS strip, w.hero_asset_id AS hero
          FROM wallet_pass_designs w LEFT JOIN events ev ON ev.id = w.event_id
          WHERE w.logo_asset_id = ANY(${list}) OR w.icon_asset_id = ANY(${list})
             OR w.strip_asset_id = ANY(${list}) OR w.hero_asset_id = ANY(${list})`,
    ),
    rows<{ key: string; locale: string; event_id: string | null; body: string }>(
      db,
      sql`SELECT key::text AS key, locale, event_id, body_html AS body FROM email_templates`,
    ),
    rows<{ key: string; value: string }>(
      db,
      sql`SELECT key, value::text AS value FROM system_settings WHERE value IS NOT NULL`,
    ),
    referencingColumns(db),
  ]);

  for (const r of eventRows)
    add(r.asset, {
      type: 'EVENT_COVER',
      label: r.title,
      detail: null,
      href: `/admin/events/${r.id}`,
    });
  for (const r of seriesRows)
    add(r.asset, { type: 'SERIES_IMAGE', label: r.name, detail: null, href: null });
  for (const r of venueRows)
    add(r.asset, {
      type: 'VENUE_IMAGE',
      label: r.name,
      detail: null,
      href: `/admin/venues/${r.id}`,
    });
  for (const r of mapRows)
    add(r.asset, {
      type: 'SEAT_MAP_BACKGROUND',
      label: r.name,
      detail: null,
      href: `/admin/seat-maps/${r.id}`,
    });
  for (const r of elementRows)
    add(r.asset, {
      type: 'SEAT_MAP_IMAGE',
      label: r.name,
      detail: null,
      href: `/admin/seat-maps/${r.id}`,
    });
  for (const r of templateRows) {
    const href = `/admin/ticket-templates/${r.id}`;
    if (r.bg) add(r.bg, { type: 'TICKET_TEMPLATE_BACKGROUND', label: r.name, detail: null, href });
    for (const id of mentioned(r.layout))
      add(id, { type: 'TICKET_TEMPLATE_IMAGE', label: r.name, detail: null, href });
  }
  for (const r of walletRows) {
    const label = r.title ?? '';
    const href = r.event_id ? `/admin/events/${r.event_id}/wallet` : '/admin/settings/wallet';
    for (const [slot, id] of [
      ['logo', r.logo],
      ['icon', r.icon],
      ['strip', r.strip],
      ['hero', r.hero],
    ] as const) {
      if (id) add(id, { type: 'WALLET_DESIGN', label, detail: slot, href });
    }
  }
  for (const r of emailRows) {
    for (const id of mentioned(r.body))
      add(id, {
        type: 'EMAIL_TEMPLATE',
        label: r.key,
        detail: r.locale,
        href: `/admin/email-templates/${r.key}`,
      });
  }
  for (const r of settingRows) {
    for (const id of mentioned(r.value))
      add(id, { type: 'SETTING', label: r.key, detail: r.key, href: settingsHref(r.key) });
  }
  // Unknown (future) foreign key columns: still counted, shown as table.column.
  for (const { table, column } of columns) {
    if (HANDLED_COLUMNS.has(`${table}.${column}`)) continue;
    const hits = await rows<{ asset: string }>(
      db,
      sql`SELECT DISTINCT ${sql.identifier(column)}::text AS asset FROM ${sql.identifier(table)}
          WHERE ${sql.identifier(column)} = ANY(${list})`,
    );
    for (const h of hits)
      add(h.asset, { type: 'OTHER', label: table, detail: `${table}.${column}`, href: null });
  }
  return out;
}

// ─── Listing ───────────────────────────────────────────────────────────────

export type MediaListItem = MediaAssetRow & { uploadedByName: string | null };

export interface MediaListQuery {
  kind?: MediaAssetKind;
  usage?: 'used' | 'unused';
  search?: string;
  sort?: 'date' | 'size';
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface MediaSummary {
  count: number;
  bytes: number;
  unusedCount: number;
  unusedBytes: number;
}

async function filters(db: Executor, q: Pick<MediaListQuery, 'kind' | 'usage' | 'search'>) {
  const conds: SQL[] = [
    sql`${mediaAssets.kind} NOT IN (${sql.join(
      PROTECTED_KINDS.map((k) => sql`${k}`),
      sql`, `,
    )})`,
  ];
  if (q.kind) conds.push(eq(mediaAssets.kind, q.kind));
  const term = q.search?.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
  if (term) conds.push(ilike(mediaAssets.fileName, `%${term}%`));
  if (q.usage) {
    const used = await usedIdsSql(db);
    conds.push(
      q.usage === 'used'
        ? sql`${mediaAssets.id}::text IN (${used})`
        : sql`${mediaAssets.id}::text NOT IN (${used})`,
    );
  }
  return and(...conds);
}

export async function listMediaAssets(
  ctx: CoreContext,
  query: MediaListQuery = {},
): Promise<{ items: MediaListItem[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(query.pageSize ?? 24, 1), 200);
  const where = await filters(ctx.db, query);
  const [{ total } = { total: 0 }] = await ctx.db
    .select({ total: sql<number>`count(*)::int` })
    .from(mediaAssets)
    .where(where);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(query.page ?? 1, 1), lastPage);
  const column = query.sort === 'size' ? mediaAssets.sizeBytes : mediaAssets.createdAt;
  const order = query.dir === 'asc' ? asc(column) : desc(column);
  const items = await ctx.db
    .select({ asset: mediaAssets, uploadedByName: adminUsers.displayName })
    .from(mediaAssets)
    .leftJoin(adminUsers, eq(adminUsers.id, mediaAssets.uploadedByUserId))
    .where(where)
    .orderBy(order, desc(mediaAssets.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return {
    items: items.map((r) => ({ ...r.asset, uploadedByName: r.uploadedByName })),
    total,
    page,
    pageSize,
  };
}

export async function mediaSummary(ctx: CoreContext): Promise<MediaSummary> {
  const used = await usedIdsSql(ctx.db);
  const res = await ctx.db.execute<{
    count: number;
    bytes: string | null;
    unused_count: number;
    unused_bytes: string | null;
  }>(sql`
    SELECT count(*)::int AS count,
           coalesce(sum(size_bytes), 0)::text AS bytes,
           (count(*) FILTER (WHERE id::text NOT IN (${used})))::int AS unused_count,
           coalesce(sum(size_bytes) FILTER (WHERE id::text NOT IN (${used})), 0)::text AS unused_bytes
    FROM media_assets WHERE kind <> 'DOCUMENT'
  `);
  const r = res.rows[0];
  return {
    count: r?.count ?? 0,
    bytes: Number(r?.bytes ?? 0),
    unusedCount: r?.unused_count ?? 0,
    unusedBytes: Number(r?.unused_bytes ?? 0),
  };
}

/** Unused assets (optionally of one kind) for the bulk-delete preview, newest first. */
export async function listUnusedMediaAssets(
  ctx: CoreContext,
  opts: { kind?: MediaAssetKind; limit?: number } = {},
): Promise<{ items: MediaAssetRow[]; total: number }> {
  const where = await filters(ctx.db, { kind: opts.kind, usage: 'unused' });
  const [{ total } = { total: 0 }] = await ctx.db
    .select({ total: sql<number>`count(*)::int` })
    .from(mediaAssets)
    .where(where);
  const items = await ctx.db
    .select()
    .from(mediaAssets)
    .where(where)
    .orderBy(desc(mediaAssets.createdAt))
    .limit(Math.min(opts.limit ?? 500, 500));
  return { items, total };
}

// ─── Rename / delete ───────────────────────────────────────────────────────

/** Changes the display name (file name) only; the stored object is untouched. */
export async function renameMediaAsset(
  ctx: CoreContext,
  id: string,
  name: string,
  audit?: (tx: Transaction, asset: MediaAssetRow) => Promise<void>,
): Promise<MediaAssetRow> {
  const trimmed = name.trim();
  if (!trimmed) throw new DomainError('MEDIA_NAME_REQUIRED', 'A name is required', 422);
  return withTransaction(ctx.db, async (tx) => {
    const [current] = await tx.select().from(mediaAssets).where(eq(mediaAssets.id, id));
    if (!current || PROTECTED_KINDS.includes(current.kind)) {
      throw new DomainError('MEDIA_NOT_FOUND', 'Media asset not found', 404);
    }
    const ext = current.objectKey.split('.').pop() ?? 'png';
    const [row] = await tx
      .update(mediaAssets)
      .set({ fileName: safeFileName(trimmed, ext) })
      .where(eq(mediaAssets.id, id))
      .returning();
    await audit?.(tx, row!);
    return row!;
  });
}

export type MediaDeleteResult =
  { deleted: true; asset: MediaAssetRow } | { deleted: false; usages: MediaUsage[] };

/**
 * Deletes an unused asset. The row is locked `FOR UPDATE` first: a concurrent transaction that
 * assigns the asset through a foreign key takes `FOR KEY SHARE` on that row, so it either
 * commits before the check (the reference is then seen and the delete refused) or waits and
 * fails its insert once the row is gone. References embedded in JSON (ticket layouts, branding,
 * e-mail bodies) take no row lock; for those only the in-transaction re-check protects. The
 * object is removed from storage after the row is gone; a storage failure is logged and left
 * to `sweepOrphanMediaObjects`.
 */
export async function tryDeleteMediaAsset(
  ctx: CoreContext,
  id: string,
  audit?: (tx: Transaction, asset: MediaAssetRow) => Promise<void>,
): Promise<MediaDeleteResult> {
  const storage = requireCapability(ctx, 'storage');
  const result = await withTransaction(ctx.db, async (tx): Promise<MediaDeleteResult> => {
    const locked = await tx.execute(sql`SELECT id FROM media_assets WHERE id = ${id} FOR UPDATE`);
    if (locked.rows.length === 0) {
      throw new DomainError('MEDIA_NOT_FOUND', 'Media asset not found', 404);
    }
    const [asset] = await tx.select().from(mediaAssets).where(eq(mediaAssets.id, id));
    if (!asset) throw new DomainError('MEDIA_NOT_FOUND', 'Media asset not found', 404);
    if (PROTECTED_KINDS.includes(asset.kind)) {
      throw new DomainError('MEDIA_PROTECTED', 'This media asset cannot be deleted', 409);
    }
    if (await isInUse(tx, id)) {
      const usages = (await usagesBatch(tx, [id])).get(id) ?? [];
      return { deleted: false, usages };
    }
    await tx.delete(mediaAssets).where(eq(mediaAssets.id, id));
    await audit?.(tx, asset);
    return { deleted: true, asset };
  });
  if (result.deleted) {
    const { asset } = result;
    try {
      // Object keys are unique per row, but stay defensive: never remove an object another row owns.
      const shared = await ctx.db
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(
          and(eq(mediaAssets.bucket, asset.bucket), eq(mediaAssets.objectKey, asset.objectKey)),
        )
        .limit(1);
      if (shared.length === 0) {
        await storage.delete(asset.bucket as 'assets' | 'documents', asset.objectKey);
      }
    } catch (err) {
      console.error(
        `Media object ${asset.bucket}/${asset.objectKey} could not be removed (left for the orphan sweep)`,
        err,
      );
    }
  }
  return result;
}

/** Throwing variant: refuses with `MEDIA_IN_USE` (usages in `details`) while referenced. */
export async function deleteMediaAsset(ctx: CoreContext, id: string): Promise<void> {
  const res = await tryDeleteMediaAsset(ctx, id);
  if (!res.deleted) {
    throw new DomainError('MEDIA_IN_USE', 'The media asset is still in use', 409, {
      usages: res.usages,
    });
  }
}

export interface BulkDeleteResult {
  deleted: string[];
  blocked: { id: string; usages: MediaUsage[] }[];
  missing: string[];
}

/** Deletes exactly the given (previewed) ids, each through the locked single path. */
export async function deleteMediaAssets(
  ctx: CoreContext,
  ids: readonly string[],
  audit?: (tx: Transaction, asset: MediaAssetRow) => Promise<void>,
): Promise<BulkDeleteResult> {
  const out: BulkDeleteResult = { deleted: [], blocked: [], missing: [] };
  for (const id of new Set(ids)) {
    try {
      const res = await tryDeleteMediaAsset(ctx, id, audit);
      if (res.deleted) out.deleted.push(id);
      else out.blocked.push({ id, usages: res.usages });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'MEDIA_NOT_FOUND') out.missing.push(id);
      else throw err;
    }
  }
  return out;
}

// ─── Orphan sweep ──────────────────────────────────────────────────────────

/**
 * Removes objects below `media/` of the assets bucket that no catalogue row owns (leftovers of
 * failed storage deletes or interrupted uploads). Objects younger than `minAgeMs` are kept
 * because uploads store the object before inserting the row.
 */
export async function sweepOrphanMediaObjects(
  ctx: CoreContext,
  opts: { minAgeMs?: number; now?: Date } = {},
): Promise<{ scanned: number; deleted: number }> {
  const storage = requireCapability(ctx, 'storage');
  const cutoff = (opts.now ?? new Date()).getTime() - (opts.minAgeMs ?? 60 * 60 * 1000);
  const objects = await storage.list('assets', 'media/');
  if (objects.length === 0) return { scanned: 0, deleted: 0 };
  const known = new Set<string>();
  const keys = objects.map((o) => o.key);
  for (let i = 0; i < keys.length; i += 1000) {
    const found = await ctx.db
      .select({ key: mediaAssets.objectKey })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.bucket, 'assets'),
          inArray(mediaAssets.objectKey, keys.slice(i, i + 1000)),
        ),
      );
    for (const r of found) known.add(r.key);
  }
  let deleted = 0;
  for (const o of objects) {
    if (known.has(o.key)) continue;
    if (!o.lastModified || o.lastModified.getTime() > cutoff) continue;
    await storage.delete('assets', o.key);
    deleted += 1;
  }
  return { scanned: objects.length, deleted };
}
