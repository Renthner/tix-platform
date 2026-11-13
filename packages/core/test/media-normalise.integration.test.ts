/**
 * One-off clean-up of legacy masters against real PostgreSQL (throw-away database) with an
 * in-memory storage fake: EXIF orientation + GPS, WebP conversion, untouched clean PNG, SVG,
 * variant reset, idempotence and removal of the old object.
 */
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDb, loadRootEnv, mediaAssets, mediaAssetVariants, type DbHandle } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCoreContext,
  getMediaAsset,
  listMediaVariants,
  normaliseLegacyMasters,
  type CoreContext,
  type ObjectStorage,
} from '../src';
import { solidPng } from './image-fixtures';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

const objects = new Map<string, Uint8Array>();
const fakeStorage = {
  put: async (bucket: string, key: string, body: Uint8Array) => {
    objects.set(`${bucket}/${key}`, body);
  },
  get: async (bucket: string, key: string) => {
    const o = objects.get(`${bucket}/${key}`);
    if (!o) throw new Error('missing');
    return { body: o, contentType: undefined };
  },
  delete: async (bucket: string, key: string) => {
    objects.delete(`${bucket}/${key}`);
  },
  list: async () => [],
} as unknown as ObjectStorage;

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe.skipIf(!adminUrl || !redisUrl)('legacy master normalisation (integration)', () => {
  const dbName = `tix_medianorm_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let counter = 0;

  /** Inserts a legacy row (no `master_normalised_at`, no master hash) plus its object. */
  const legacy = async (
    kind: 'EVENT_IMAGE' | 'TICKET_BACKGROUND' | 'WALLET_IMAGE',
    bytes: Uint8Array,
    ext: string,
    mimeType: string,
    dims: { width: number; height: number },
    fileName = `legacy${(counter += 1)}.${ext}`,
  ) => {
    const objectKey = `media/${kind.toLowerCase()}/2025/${sha(bytes)}-${counter}.${ext}`;
    objects.set(`assets/${objectKey}`, bytes);
    const [row] = await handle.db
      .insert(mediaAssets)
      .values({
        kind,
        bucket: 'assets',
        objectKey,
        fileName,
        mimeType,
        sizeBytes: bytes.byteLength,
        sha256: sha(bytes),
        ...dims,
      })
      .returning();
    return row!;
  };

  const withVariants = async (assetId: string, objectKey: string) => {
    const key = `${objectKey.replace(/\.[^.]+$/, '')}.w320.webp`;
    objects.set(`assets/${key}`, new Uint8Array([1]));
    await handle.db
      .insert(mediaAssetVariants)
      .values({ assetId, format: 'webp', width: 320, height: 200, sizeBytes: 1, storageKey: key });
    await handle.db
      .update(mediaAssets)
      .set({ variantsProcessedAt: new Date() })
      .where(eq(mediaAssets.id, assetId));
    return key;
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

  it('rotates a JPEG with EXIF orientation 6 + GPS, strips metadata, resets variants', async () => {
    const src = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 200, g: 20, b: 20 } },
    })
      .jpeg()
      .withExif({
        IFD0: { Copyright: 'someone' },
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '50/1 0/1 0/1',
          GPSLongitudeRef: 'E',
          GPSLongitude: '8/1 0/1 0/1',
        },
      })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const bytes = new Uint8Array(src);
    expect((await sharp(bytes).metadata()).exif).toBeDefined();
    const row = await legacy('TICKET_BACKGROUND', bytes, 'jpg', 'image/jpeg', {
      width: 200,
      height: 100,
    });
    const vKey = await withVariants(row.id, row.objectKey);

    const res = await normaliseLegacyMasters(ctx);
    expect(res.rewritten).toBeGreaterThanOrEqual(1);

    const after = (await getMediaAsset(ctx, row.id))!;
    expect(after.masterNormalisedAt).not.toBeNull();
    expect(after.objectKey).not.toBe(row.objectKey);
    expect(after.mimeType).toBe('image/jpeg');
    expect([after.width, after.height]).toEqual([100, 200]);
    expect(after.sha256).toBe(row.sha256);
    const stored = objects.get(`assets/${after.objectKey}`)!;
    expect(after.masterSha256).toBe(sha(stored));
    expect(after.sizeBytes).toBe(stored.byteLength);
    const meta = await sharp(stored).metadata();
    expect([meta.width, meta.height]).toEqual([100, 200]);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation ?? 1).toBe(1);
    expect(objects.has(`assets/${row.objectKey}`)).toBe(false);
    expect(await listMediaVariants(handle.db, row.id)).toHaveLength(0);
    expect(objects.has(`assets/${vKey}`)).toBe(false);
    expect(after.variantsProcessedAt).toBeNull();
    expect(after.variantsAttempts).toBe(0);
  });

  it('converts a legacy WebP master to JPEG and updates mime type and file name', async () => {
    const webp = new Uint8Array(
      await sharp({
        create: { width: 120, height: 60, channels: 3, background: { r: 10, g: 90, b: 200 } },
      })
        .webp()
        .toBuffer(),
    );
    const row = await legacy(
      'EVENT_IMAGE',
      webp,
      'webp',
      'image/webp',
      { width: 120, height: 60 },
      'cover.webp',
    );
    const vKey = await withVariants(row.id, row.objectKey);
    await normaliseLegacyMasters(ctx);
    const after = (await getMediaAsset(ctx, row.id))!;
    expect(after.mimeType).toBe('image/jpeg');
    expect(after.fileName).toBe('cover.jpg');
    expect(after.objectKey.endsWith('.jpg')).toBe(true);
    expect([after.width, after.height]).toEqual([120, 60]);
    expect((await sharp(objects.get(`assets/${after.objectKey}`)!).metadata()).format).toBe('jpeg');
    expect(objects.has(`assets/${row.objectKey}`)).toBe(false);
    // Same pixels: variants stay.
    expect(await listMediaVariants(handle.db, row.id)).toHaveLength(1);
    expect(objects.has(`assets/${vKey}`)).toBe(true);
    expect(after.variantsProcessedAt).not.toBeNull();
  });

  it('keeps a clean PNG byte for byte and only sets the timestamp and master hash', async () => {
    const png = await solidPng(50, 40, 77);
    const row = await legacy('WALLET_IMAGE', png, 'png', 'image/png', { width: 50, height: 40 });
    await normaliseLegacyMasters(ctx);
    const after = (await getMediaAsset(ctx, row.id))!;
    expect(after.objectKey).toBe(row.objectKey);
    expect(after.mimeType).toBe('image/png');
    expect(after.masterNormalisedAt).not.toBeNull();
    expect(after.masterSha256).toBe(sha(png));
    expect(objects.get(`assets/${row.objectKey}`)).toBe(png);
  });

  it('keeps a PNG a PNG when metadata has to be stripped (wallet images are PNG-only)', async () => {
    const png = new Uint8Array(
      await sharp({
        create: { width: 30, height: 30, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .png()
        .withExif({ IFD0: { Copyright: 'x' } })
        .toBuffer(),
    );
    const row = await legacy('WALLET_IMAGE', png, 'png', 'image/png', { width: 30, height: 30 });
    await normaliseLegacyMasters(ctx);
    const after = (await getMediaAsset(ctx, row.id))!;
    expect(after.mimeType).toBe('image/png');
    expect(after.objectKey.endsWith('.png')).toBe(true);
    const meta = await sharp(objects.get(`assets/${after.objectKey}`)!).metadata();
    expect(meta.format).toBe('png');
    expect(meta.exif).toBeUndefined();
  });

  it('skips SVG and undecodable files (timestamp set, no loop) and is idempotent', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const svgRow = await legacy('EVENT_IMAGE', svg, 'svg', 'image/svg+xml', {
      width: 1,
      height: 1,
    });
    const junk = new Uint8Array(await solidPng(20, 20, 5)).slice(0, 60);
    const junkRow = await legacy('EVENT_IMAGE', junk, 'png', 'image/png', {
      width: 20,
      height: 20,
    });
    await normaliseLegacyMasters(ctx);
    for (const r of [svgRow, junkRow]) {
      const after = (await getMediaAsset(ctx, r.id))!;
      expect(after.masterNormalisedAt).not.toBeNull();
      expect(after.objectKey).toBe(r.objectKey);
    }
    const before = [...objects.keys()].sort();
    const second = await normaliseLegacyMasters(ctx);
    expect(second).toEqual({ processed: 0, rewritten: 0, failed: 0, more: false });
    expect([...objects.keys()].sort()).toEqual(before);
  });
});
