/**
 * Media library administration against real PostgreSQL (throw-away database) with an in-memory
 * storage fake: usages per reference type, guarded deletion (incl. the race with a concurrent
 * assignment), bulk delete, list filters / pagination, rename and the orphan sweep.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  emailTemplates,
  eventSeries,
  events,
  loadRootEnv,
  seatMaps,
  taxRates,
  ticketTemplates,
  venues,
  walletPassDesigns,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainError,
  createCoreContext,
  deleteMediaAsset,
  deleteMediaAssets,
  getMediaAsset,
  listMediaAssets,
  listUnusedMediaAssets,
  mediaAssetUsages,
  mediaAssetUsagesBatch,
  mediaSummary,
  renameMediaAsset,
  saveSetting,
  sweepOrphanMediaObjects,
  tryDeleteMediaAsset,
  uploadMediaAsset,
  type CoreContext,
  type ObjectStorage,
} from '../src';
import { solidPng } from './image-fixtures';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

const objects = new Map<string, { body: Uint8Array; at: Date }>();
const fakeStorage = {
  put: async (bucket: string, key: string, body: Uint8Array) => {
    objects.set(`${bucket}/${key}`, { body, at: new Date() });
  },
  get: async (bucket: string, key: string) => {
    const o = objects.get(`${bucket}/${key}`);
    if (!o) throw new Error('missing');
    return { body: o.body, contentType: undefined };
  },
  delete: async (bucket: string, key: string) => {
    objects.delete(`${bucket}/${key}`);
  },
  list: async (bucket: string, prefix: string) =>
    [...objects.entries()]
      .filter(([k]) => k.startsWith(`${bucket}/${prefix}`))
      .map(([k, v]) => ({ key: k.slice(bucket.length + 1), lastModified: v.at })),
} as unknown as ObjectStorage;

describe.skipIf(!adminUrl || !redisUrl)('media administration (integration)', () => {
  const dbName = `tix_mediaadm_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let dbUrl: string;
  let counter = 0;
  let venueId: string;
  let taxRateId: string;

  const upload = async (kind: Parameters<typeof uploadMediaAsset>[1]['kind'], name = 'x.png') =>
    uploadMediaAsset(ctx, {
      kind,
      bytes: await solidPng(300, 200, (counter += 1)),
      fileName: name,
      userId: null,
    });

  const makeEvent = async (extra: Partial<typeof events.$inferInsert> = {}) => {
    const [event] = await handle.db
      .insert(events)
      .values({
        venueId,
        taxRateId,
        title: `Show ${counter}`,
        slug: `show-${randomUUID().slice(0, 8)}`,
        startsAt: new Date(Date.now() + 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        ...extra,
      } as typeof events.$inferInsert)
      .returning();
    return event!;
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    dbUrl = url.toString();
    await runMigrations({
      connectionString: dbUrl,
      migrationsFolder: resolve(import.meta.dirname, '../../db/migrations'),
      log: () => {},
    });
    handle = createDb({ connectionString: dbUrl, poolMax: 5 });
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      storage: fakeStorage,
    });
    const [venue] = await handle.db
      .insert(venues)
      .values({
        name: 'Hall',
        slug: `v-${randomUUID().slice(0, 6)}`,
        timeZone: 'Europe/Berlin',
      } as typeof venues.$inferInsert)
      .returning({ id: venues.id });
    venueId = venue!.id;
    // No reference-data seed: it also writes columns of unrelated in-flight schema changes.
    const [rate] = await handle.db
      .insert(taxRates)
      .values({ name: 'Test', rateBasisPoints: 0 } as typeof taxRates.$inferInsert)
      .returning({ id: taxRates.id });
    taxRateId = rate!.id;
    await handle.db.insert(emailTemplates).values({
      key: 'PAYMENT_REMINDER',
      locale: 'en',
      subject: 's',
      bodyHtml: '<p>x</p>',
    } as typeof emailTemplates.$inferInsert);
  });

  afterAll(async () => {
    redis?.disconnect();
    await handle?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  it('reports the concrete usages for every reference type (batched)', async () => {
    const cover = await upload('EVENT_IMAGE');
    const series = await upload('EVENT_IMAGE');
    const venueImg = await upload('EVENT_IMAGE');
    const mapBg = await upload('VENUE_BACKGROUND');
    const tplBg = await upload('TICKET_BACKGROUND');
    const tplImg = await upload('TICKET_BACKGROUND');
    const wallet = await upload('WALLET_IMAGE');
    const mail = await upload('EMAIL_IMAGE');
    const logo = await upload('LOGO');
    const lonely = await upload('OTHER');

    const event = await makeEvent({ heroImageAssetId: cover.id });
    await handle.db.insert(eventSeries).values({
      name: 'Series',
      slug: `s-${randomUUID().slice(0, 6)}`,
      imageAssetId: series.id,
    } as typeof eventSeries.$inferInsert);
    await handle.db.update(venues).set({ imageAssetId: venueImg.id }).where(eq(venues.id, venueId));
    const [map] = await handle.db
      .insert(seatMaps)
      .values({
        venueId,
        kind: 'TEMPLATE',
        name: 'Plan',
        canvasWidth: 100,
        canvasHeight: 100,
        backgroundAssetId: mapBg.id,
      } as typeof seatMaps.$inferInsert)
      .returning();
    const [tpl] = await handle.db
      .insert(ticketTemplates)
      .values({
        name: 'Tpl',
        pageWidthMm: 150,
        pageHeightMm: 60,
        backgroundAssetId: tplBg.id,
        layout: {
          elements: [
            { kind: 'image', id: 'i', assetId: tplImg.id, x: 0, y: 0, width: 5, height: 5 },
          ],
        },
      } as unknown as typeof ticketTemplates.$inferInsert)
      .returning();
    await handle.db.insert(walletPassDesigns).values({
      eventId: event.id,
      backgroundColor: '#000000',
      foregroundColor: '#ffffff',
      labelColor: '#ffffff',
      stripAssetId: wallet.id,
    } as typeof walletPassDesigns.$inferInsert);
    await handle.db
      .update(emailTemplates)
      .set({ bodyHtml: `<p><img src="/api/media/${mail.id}"></p>` })
      .where(
        eq(emailTemplates.id, (await handle.db.select().from(emailTemplates).limit(1))[0]!.id),
      );
    await saveSetting(ctx, 'branding', { logoAssetId: logo.id }, null);

    const usages = await mediaAssetUsagesBatch(ctx, [
      cover.id,
      series.id,
      venueImg.id,
      mapBg.id,
      tplBg.id,
      tplImg.id,
      wallet.id,
      mail.id,
      logo.id,
      lonely.id,
    ]);
    expect(usages.get(cover.id)).toEqual([
      { type: 'EVENT_COVER', label: event.title, detail: null, href: `/admin/events/${event.id}` },
    ]);
    expect(usages.get(series.id)?.[0]?.type).toBe('SERIES_IMAGE');
    expect(usages.get(venueImg.id)?.[0]).toMatchObject({
      type: 'VENUE_IMAGE',
      href: `/admin/venues/${venueId}`,
    });
    expect(usages.get(mapBg.id)?.[0]).toMatchObject({
      type: 'SEAT_MAP_BACKGROUND',
      href: `/admin/seat-maps/${map!.id}`,
    });
    expect(usages.get(tplBg.id)?.[0]).toMatchObject({
      type: 'TICKET_TEMPLATE_BACKGROUND',
      href: `/admin/ticket-templates/${tpl!.id}`,
    });
    expect(usages.get(tplImg.id)?.[0]).toMatchObject({
      type: 'TICKET_TEMPLATE_IMAGE',
      label: 'Tpl',
    });
    expect(usages.get(wallet.id)?.[0]).toMatchObject({
      type: 'WALLET_DESIGN',
      detail: 'strip',
      href: `/admin/events/${event.id}/wallet`,
    });
    expect(usages.get(mail.id)?.[0]?.type).toBe('EMAIL_TEMPLATE');
    expect(usages.get(logo.id)?.[0]).toMatchObject({
      type: 'SETTING',
      detail: 'branding',
      href: '/admin/settings/appearance',
    });
    expect(usages.get(lonely.id)).toEqual([]);
    expect(await mediaAssetUsages(ctx, cover.id)).toHaveLength(1);

    // The SQL predicate (filter / summary) agrees with the detailed usages.
    const unused = await listMediaAssets(ctx, { usage: 'unused', pageSize: 200 });
    expect(unused.items.map((i) => i.id)).toContain(lonely.id);
    for (const used of [cover, series, venueImg, mapBg, tplBg, tplImg, wallet, mail, logo]) {
      expect(unused.items.map((i) => i.id)).not.toContain(used.id);
    }
  });

  it('blocks deletion of used assets, returns the usages and deletes unused ones', async () => {
    const used = await upload('EVENT_IMAGE');
    const event = await makeEvent({ heroImageAssetId: used.id });
    const err = await deleteMediaAsset(ctx, used.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('MEDIA_IN_USE');
    const blocked = await tryDeleteMediaAsset(ctx, used.id);
    expect(blocked.deleted).toBe(false);
    expect(!blocked.deleted && blocked.usages[0]?.type).toBe('EVENT_COVER');
    expect(await getMediaAsset(ctx, used.id)).not.toBeNull();

    await handle.db.update(events).set({ heroImageAssetId: null }).where(eq(events.id, event.id));
    let audited = 0;
    const res = await tryDeleteMediaAsset(ctx, used.id, async () => {
      audited += 1;
    });
    expect(res.deleted).toBe(true);
    expect(audited).toBe(1);
    expect(await getMediaAsset(ctx, used.id)).toBeNull();
    expect(objects.has(`assets/${used.objectKey}`)).toBe(false);
    await expect(tryDeleteMediaAsset(ctx, used.id)).rejects.toMatchObject({
      code: 'MEDIA_NOT_FOUND',
    });
  });

  it('does not let a delete overwrite a concurrent assignment (row lock race)', async () => {
    const asset = await upload('EVENT_IMAGE');
    const event = await makeEvent();
    const other = new pg.Client({ connectionString: dbUrl });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query('UPDATE events SET hero_image_asset_id = $1 WHERE id = $2', [
        asset.id,
        event.id,
      ]);
      let settled = false;
      const deletion = tryDeleteMediaAsset(ctx, asset.id).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // blocked on the key-share lock of the pending assignment
      await other.query('COMMIT');
      const result = await deletion;
      expect(result.deleted).toBe(false);
    } finally {
      await other.end();
    }
    const [row] = await handle.db.select().from(events).where(eq(events.id, event.id));
    expect(row?.heroImageAssetId).toBe(asset.id);
    expect(await getMediaAsset(ctx, asset.id)).not.toBeNull();
  });

  it('bulk delete removes only the previewed unused assets and reports the rest', async () => {
    const a = await upload('OTHER');
    const b = await upload('OTHER');
    const usedOne = await upload('OTHER');
    await makeEvent({ heroImageAssetId: usedOne.id });
    const preview = await listUnusedMediaAssets(ctx, { kind: 'OTHER' });
    const previewIds = preview.items.map((i) => i.id);
    expect(previewIds).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(previewIds).not.toContain(usedOne.id);

    // `b` gets assigned after the preview was shown: it must survive the confirmed delete.
    await makeEvent({ heroImageAssetId: b.id });
    const result = await deleteMediaAssets(ctx, [...previewIds, usedOne.id, randomUUID()]);
    expect(result.deleted).toContain(a.id);
    expect(result.deleted).not.toContain(b.id);
    expect(result.blocked.map((x) => x.id)).toEqual(expect.arrayContaining([b.id, usedOne.id]));
    expect(result.missing).toHaveLength(1);
    expect(await getMediaAsset(ctx, a.id)).toBeNull();
    expect(await getMediaAsset(ctx, b.id)).not.toBeNull();
    expect(await getMediaAsset(ctx, usedOne.id)).not.toBeNull();
  });

  it('lists with kind / usage / search filters, sorting, pagination and a summary', async () => {
    const tag = randomUUID().slice(0, 6);
    const small = await upload('EMAIL_IMAGE', `alpha-${tag}.png`);
    const big = await uploadMediaAsset(ctx, {
      kind: 'EMAIL_IMAGE',
      bytes: new Uint8Array([
        ...(await solidPng(300, 200, 9000 + counter)),
        ...new Uint8Array(500),
      ]),
      fileName: `beta-${tag}.png`,
      userId: null,
    });
    await makeEvent({ heroImageAssetId: big.id });

    const bySearch = await listMediaAssets(ctx, { search: `ALPHA-${tag}` });
    expect(bySearch.items.map((i) => i.id)).toEqual([small.id]);
    expect(bySearch.total).toBe(1);
    expect((await listMediaAssets(ctx, { search: '%' })).total).toBe(0); // wildcard is escaped

    const used = await listMediaAssets(ctx, { kind: 'EMAIL_IMAGE', usage: 'used' });
    expect(used.items.map((i) => i.id)).toContain(big.id);
    expect(used.items.map((i) => i.id)).not.toContain(small.id);

    const bySize = await listMediaAssets(ctx, {
      kind: 'EMAIL_IMAGE',
      sort: 'size',
      dir: 'desc',
      search: `-${tag}`,
    });
    expect(bySize.items.map((i) => i.id)).toEqual([big.id, small.id]);

    const page1 = await listMediaAssets(ctx, { kind: 'EMAIL_IMAGE', pageSize: 1, page: 1 });
    const page2 = await listMediaAssets(ctx, { kind: 'EMAIL_IMAGE', pageSize: 1, page: 2 });
    expect(page1.items).toHaveLength(1);
    expect(page2.items).toHaveLength(1);
    expect(page1.items[0]!.id).not.toBe(page2.items[0]!.id);
    expect(page1.total).toBe(page2.total);
    expect((await listMediaAssets(ctx, { pageSize: 1, page: 9999 })).page).toBeLessThanOrEqual(
      page1.total + 100,
    );

    const summary = await mediaSummary(ctx);
    const all = await listMediaAssets(ctx, { pageSize: 200 });
    const unusedAll = await listMediaAssets(ctx, { usage: 'unused', pageSize: 200 });
    expect(summary.count).toBe(all.total);
    expect(summary.unusedCount).toBe(unusedAll.total);
    expect(summary.unusedBytes).toBe(unusedAll.items.reduce((s, i) => s + i.sizeBytes, 0));
  });

  it('renames only the display name and refuses empty names', async () => {
    const asset = await upload('OTHER', 'old.png');
    const renamed = await renameMediaAsset(ctx, asset.id, '  New / Name.png ');
    expect(renamed.fileName).toBe('New _ Name.png');
    expect(renamed.objectKey).toBe(asset.objectKey);
    await expect(renameMediaAsset(ctx, asset.id, '   ')).rejects.toMatchObject({
      code: 'MEDIA_NAME_REQUIRED',
    });
  });

  it('keeps DOCUMENT rows out of the library and refuses to delete them', async () => {
    const { mediaAssets } = await import('@tix/db');
    const [doc] = await handle.db
      .insert(mediaAssets)
      .values({
        kind: 'DOCUMENT',
        bucket: 'assets',
        objectKey: `media/doc/${randomUUID()}.png`,
        fileName: 'doc.png',
        mimeType: 'image/png',
        sizeBytes: 5,
        sha256: randomUUID(),
      })
      .returning();
    expect((await listMediaAssets(ctx, { pageSize: 200 })).items.map((i) => i.id)).not.toContain(
      doc!.id,
    );
    await expect(tryDeleteMediaAsset(ctx, doc!.id)).rejects.toMatchObject({
      code: 'MEDIA_PROTECTED',
    });
    await expect(renameMediaAsset(ctx, doc!.id, 'x')).rejects.toMatchObject({
      code: 'MEDIA_NOT_FOUND',
    });
  });

  it('sweeps orphaned objects but keeps owned and fresh ones', async () => {
    const owned = await upload('OTHER');
    const old = new Date(Date.now() - 3 * 3_600_000);
    objects.set('assets/media/other/2020/orphan-old.png', { body: new Uint8Array(1), at: old });
    objects.set('assets/media/other/2020/orphan-new.png', {
      body: new Uint8Array(1),
      at: new Date(),
    });
    const res = await sweepOrphanMediaObjects(ctx);
    expect(res.deleted).toBe(1);
    expect(objects.has('assets/media/other/2020/orphan-old.png')).toBe(false);
    expect(objects.has('assets/media/other/2020/orphan-new.png')).toBe(true);
    expect(objects.has(`assets/${owned.objectKey}`)).toBe(true);
  });
});
