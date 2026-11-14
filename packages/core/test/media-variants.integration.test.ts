/**
 * Responsive media variants against real PostgreSQL (throw-away database) with an in-memory
 * storage fake: generation on upload (widths, formats, no upscaling), private kinds, alpha,
 * variant selection, deletion together with the asset, orphan sweep and the idempotent backfill.
 */
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDb, loadRootEnv, mediaAssets, mediaAssetVariants, type DbHandle } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backfillMediaVariants,
  createCoreContext,
  findMediaVariant,
  getMediaAsset,
  listMediaVariants,
  processAssetVariants,
  mediaSummary,
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
/** Object keys whose `put` fails (simulates a permanently failing variant). */
const failingKeys = new Set<string>();
const fakeStorage = {
  put: async (bucket: string, key: string, body: Uint8Array) => {
    if ([...failingKeys].some((f) => key.includes(f))) throw new Error('simulated storage failure');
    objects.set(`${bucket}/${key}`, { body, at: new Date(Date.now() - 3 * 3_600_000) });
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

describe.skipIf(!adminUrl || !redisUrl)('media variants (integration)', () => {
  const dbName = `tix_mediavar_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let counter = 0;

  const upload = async (kind: Parameters<typeof uploadMediaAsset>[1]['kind'], bytes: Uint8Array) =>
    uploadMediaAsset(ctx, { kind, bytes, fileName: `f${(counter += 1)}.png`, userId: null });

  /** Upload (variants are queued, not generated) and run the worker job for the asset. */
  const uploadProcessed = async (
    kind: Parameters<typeof uploadMediaAsset>[1]['kind'],
    bytes: Uint8Array,
  ) => {
    const asset = await upload(kind, bytes);
    await processAssetVariants(ctx, asset.id);
    return (await getMediaAsset(ctx, asset.id))!;
  };

  const processedAt = async (id: string) =>
    (await handle.db.select().from(mediaAssets).where(eq(mediaAssets.id, id)))[0]!
      .variantsProcessedAt;

  const forgetVariants = async (id: string) => {
    for (const v of await listMediaVariants(handle.db, id))
      objects.delete(`assets/${v.storageKey}`);
    await handle.db.delete(mediaAssetVariants).where(eq(mediaAssetVariants.assetId, id));
    await handle.db
      .update(mediaAssets)
      .set({ variantsProcessedAt: null })
      .where(eq(mediaAssets.id, id));
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    await runMigrations({
      connectionString: url.toString(),
      migrationsFolder: resolve(import.meta.dirname, '../../db/migrations'),
      log: () => {},
    });
    handle = createDb({ connectionString: url.toString(), poolMax: 5 });
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      storage: fakeStorage,
    });
  });

  afterAll(async () => {
    redis?.disconnect();
    await handle?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  it('generates AVIF + WebP variants up to the source width, never upscaled', async () => {
    const asset = await uploadProcessed('EVENT_IMAGE', await solidPng(1000, 500, 21));
    expect(asset.variantsProcessedAt).not.toBeNull();
    const variants = await listMediaVariants(handle.db, asset.id);
    expect(variants.map((v) => `${v.format}:${v.width}`)).toEqual([
      'avif:320',
      'avif:640',
      'avif:960',
      'avif:1000',
      'webp:320',
      'webp:640',
      'webp:960',
      'webp:1000',
    ]);
    for (const v of variants) {
      expect(v.height).toBe(Math.round(v.width / 2));
      const stored = objects.get(`assets/${v.storageKey}`);
      expect(stored).toBeDefined();
      const meta = await sharp(stored!.body).metadata();
      expect(meta.format === 'heif' ? 'avif' : meta.format).toBe(v.format);
      expect(meta.width).toBe(v.width);
      expect(v.storageKey.startsWith(asset.objectKey.replace(/\.png$/, ''))).toBe(true);
    }
    // The canonical file stays the PNG.
    expect(asset.mimeType).toBe('image/png');
  });

  it('gives a tiny source exactly one variant per format at its own width', async () => {
    const asset = await uploadProcessed('LOGO', await solidPng(200, 100, 22));
    const variants = await listMediaVariants(handle.db, asset.id);
    expect(variants.map((v) => `${v.format}:${v.width}`)).toEqual(['avif:200', 'webp:200']);
  });

  it('keeps alpha in the variants of a transparent PNG', async () => {
    const png = await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 4,
        background: { r: 9, g: 9, b: 9, alpha: 0.4 },
      },
    })
      .png()
      .toBuffer();
    const asset = await uploadProcessed('LOGO', new Uint8Array(png));
    const webp = (await listMediaVariants(handle.db, asset.id)).find((v) => v.format === 'webp')!;
    const meta = await sharp(objects.get(`assets/${webp.storageKey}`)!.body).metadata();
    expect(meta.hasAlpha).toBe(true);
  });

  it('does not create variants for private kinds', async () => {
    const asset = await upload('TICKET_BACKGROUND', await solidPng(800, 400, 23));
    expect(await listMediaVariants(handle.db, asset.id)).toEqual([]);
    expect(asset.variantsProcessedAt).toBeNull();
  });

  it('picks the smallest variant that is wide enough, else the widest', async () => {
    const asset = await uploadProcessed('EVENT_IMAGE', await solidPng(1000, 500, 24));
    const pick = async (w: number) =>
      (await findMediaVariant(handle.db, asset.id, 'avif', w))?.width;
    expect(await pick(320)).toBe(320);
    expect(await pick(640)).toBe(640);
    expect(await pick(1280)).toBe(1000);
    expect(await pick(2560)).toBe(1000);
    const missing = await upload('TICKET_BACKGROUND', await solidPng(800, 400, 25));
    expect(await findMediaVariant(handle.db, missing.id, 'avif', 640)).toBeNull();
  });

  it('deletes the variants (rows and objects) together with the asset', async () => {
    const asset = await uploadProcessed('EVENT_IMAGE', await solidPng(700, 300, 26));
    const keys = (await listMediaVariants(handle.db, asset.id)).map((v) => v.storageKey);
    expect(keys.length).toBeGreaterThan(0);
    const res = await tryDeleteMediaAsset(ctx, asset.id);
    expect(res.deleted).toBe(true);
    for (const key of keys) expect(objects.has(`assets/${key}`)).toBe(false);
    expect(
      await handle.db
        .select()
        .from(mediaAssetVariants)
        .where(eq(mediaAssetVariants.assetId, asset.id)),
    ).toEqual([]);
  });

  it('keeps variant objects in the orphan sweep but still sweeps strays', async () => {
    const asset = await uploadProcessed('EVENT_IMAGE', await solidPng(500, 500, 27));
    const swept = await sweepOrphanMediaObjects(ctx, { minAgeMs: 0 });
    expect(swept.deleted).toBe(0);
    for (const v of await listMediaVariants(handle.db, asset.id)) {
      expect(objects.has(`assets/${v.storageKey}`)).toBe(true);
    }
    objects.set('assets/media/event_image/2020/stray.w320.avif', {
      body: new Uint8Array(1),
      at: new Date(0),
    });
    expect((await sweepOrphanMediaObjects(ctx, { minAgeMs: 0 })).deleted).toBe(1);
  });

  it('counts variant bytes in the summary', async () => {
    const summary = await mediaSummary(ctx);
    const res = await handle.db.execute<{ total: string }>(
      sql`SELECT coalesce(sum(size_bytes), 0)::text AS total FROM media_asset_variants`,
    );
    expect(summary.variantBytes).toBe(Number(res.rows[0]!.total));
    expect(summary.variantBytes).toBeGreaterThan(0);
  });

  it('backfills assets without variants and is idempotent', async () => {
    const asset = await uploadProcessed('EVENT_IMAGE', await solidPng(900, 600, 28));
    const before = await listMediaVariants(handle.db, asset.id);
    expect(before.length).toBeGreaterThan(0);
    await forgetVariants(asset.id); // an asset from before variants existed

    const first = await backfillMediaVariants(ctx);
    expect(first.created).toBe(before.length);
    expect(first.failed).toBe(0);
    const after = await listMediaVariants(handle.db, asset.id);
    expect(after.map((v) => v.storageKey)).toEqual(before.map((v) => v.storageKey));
    expect(await processedAt(asset.id)).not.toBeNull();

    const second = await backfillMediaVariants(ctx);
    expect(second).toMatchObject({ processed: 0, created: 0, failed: 0 });

    // Re-processing a complete asset creates nothing new.
    await handle.db
      .update(mediaAssets)
      .set({ variantsProcessedAt: null })
      .where(eq(mediaAssets.id, asset.id));
    const third = await backfillMediaVariants(ctx);
    expect(third).toMatchObject({ processed: 1, created: 0 });
    expect(await listMediaVariants(handle.db, asset.id)).toHaveLength(after.length);
  });

  it('marks undecodable stored assets as processed instead of retrying forever', async () => {
    const asset = await uploadProcessed('EVENT_IMAGE', await solidPng(400, 400, 29));
    await forgetVariants(asset.id);
    objects.set(`assets/${asset.objectKey}`, {
      body: objects.get(`assets/${asset.objectKey}`)!.body.subarray(0, 50),
      at: new Date(),
    });
    const run = await backfillMediaVariants(ctx);
    expect(run).toMatchObject({ processed: 1, created: 0 });
    expect(await processedAt(asset.id)).not.toBeNull();
    expect(await backfillMediaVariants(ctx)).toMatchObject({ processed: 0 });
  });

  it('does not convert in the upload but queues one deduplicated job per asset', async () => {
    const added: { name: string; jobName: string; data: unknown; jobId?: string }[] = [];
    const jobs = {
      add: async (name: string, jobName: string, data: unknown, options?: { jobId?: string }) => {
        added.push({ name, jobName, data, jobId: options?.jobId });
        return options?.jobId ?? '';
      },
    } as unknown as NonNullable<CoreContext['jobs']>;
    const withJobs = { ...ctx, jobs } as CoreContext;
    const asset = await uploadMediaAsset(withJobs, {
      kind: 'EVENT_IMAGE',
      bytes: await solidPng(800, 400, 31),
      fileName: 'queued.png',
      userId: null,
    });
    expect(asset.variantsProcessedAt).toBeNull();
    expect(await listMediaVariants(handle.db, asset.id)).toEqual([]);
    expect(added).toEqual([
      {
        name: 'media',
        jobName: 'media-generate-variants',
        data: { assetId: asset.id },
        jobId: `media-variants-${asset.id}`,
      },
    ]);
    // Private kinds are not converted at all.
    await uploadMediaAsset(withJobs, {
      kind: 'TICKET_BACKGROUND',
      bytes: await solidPng(800, 400, 32),
      fileName: 'private.png',
      userId: null,
    });
    expect(added).toHaveLength(1);
  });

  it('still succeeds when the job cannot be queued; the backfill covers it', async () => {
    const jobs = {
      add: async () => {
        throw new Error('redis down');
      },
    } as unknown as NonNullable<CoreContext['jobs']>;
    const asset = await uploadMediaAsset({ ...ctx, jobs } as CoreContext, {
      kind: 'EVENT_IMAGE',
      bytes: await solidPng(600, 300, 33),
      fileName: 'nojob.png',
      userId: null,
    });
    expect(asset.variantsProcessedAt).toBeNull();
    const run = await backfillMediaVariants(ctx);
    expect(run.created).toBeGreaterThan(0);
    expect(await processedAt(asset.id)).not.toBeNull();
  });

  it('gives up on permanently failing variants after three attempts', async () => {
    const asset = await upload('EVENT_IMAGE', await solidPng(1000, 500, 34));
    failingKeys.add('.w640.avif');
    try {
      const attempts = async () =>
        (await handle.db.select().from(mediaAssets).where(eq(mediaAssets.id, asset.id)))[0]!
          .variantsAttempts;

      const first = await processAssetVariants(ctx, asset.id);
      expect(first).toMatchObject({ status: 'pending', created: 7, failed: 1 });
      expect(await processedAt(asset.id)).toBeNull();
      expect(await attempts()).toBe(1);

      expect(await processAssetVariants(ctx, asset.id)).toMatchObject({ status: 'pending' });
      expect(await processedAt(asset.id)).toBeNull();

      // Third attempt: finished although one variant is still missing.
      expect(await processAssetVariants(ctx, asset.id)).toMatchObject({
        status: 'done',
        failed: 1,
      });
      expect(await processedAt(asset.id)).not.toBeNull();
      expect(await attempts()).toBe(3);
      expect(await listMediaVariants(handle.db, asset.id)).toHaveLength(7);

      // The backfill no longer touches it and a finished asset is not processed again.
      expect(await backfillMediaVariants(ctx)).toMatchObject({ processed: 0 });
      expect(await processAssetVariants(ctx, asset.id)).toMatchObject({
        status: 'done',
        failed: 0,
      });
      expect(await attempts()).toBe(3);
    } finally {
      failingKeys.clear();
    }
  });

  it('reports a missing asset without failing the job', async () => {
    expect(await processAssetVariants(ctx, randomUUID())).toEqual({ status: 'missing' });
  });

  it('exposes the widest variant width of the format', async () => {
    const asset = await uploadProcessed('EVENT_IMAGE', await solidPng(1000, 500, 35));
    expect(await findMediaVariant(handle.db, asset.id, 'webp', 320)).toMatchObject({
      width: 320,
      largestWidth: 1000,
    });
  });

  it('stores the hash of the master next to the upload hash and dedupes on both', async () => {
    const png = await solidPng(300, 300, 36);
    const plain = await upload('EVENT_IMAGE', png);
    expect(plain.masterSha256).toBe(plain.sha256);

    const rotated = new Uint8Array(
      await sharp({
        create: { width: 200, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer(),
    );
    const asset = await upload('EVENT_IMAGE', rotated);
    const stored = objects.get(`assets/${asset.objectKey}`)!.body;
    expect(asset.sha256).toBe(createHash('sha256').update(rotated).digest('hex'));
    expect(asset.masterSha256).toBe(createHash('sha256').update(stored).digest('hex'));
    expect(asset.masterSha256).not.toBe(asset.sha256);
    // Uploading the exported master again finds the same asset (seat plan round trip).
    const again = await upload('EVENT_IMAGE', new Uint8Array(stored));
    expect(again.id).toBe(asset.id);
    // Other kinds do not share assets.
    const other = await upload('LOGO', new Uint8Array(stored));
    expect(other.id).not.toBe(asset.id);
  });
});
