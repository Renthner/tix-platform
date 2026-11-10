/**
 * Media pipeline against real PostgreSQL and the S3 object storage of the dev stack:
 * upload, type spoofing, de-duplication, in-use protection and deletion. Throw-away database;
 * stored objects are deleted again.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  events,
  loadRootEnv,
  taxRates,
  ticketTemplates,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { seedReferenceData } from '@tix/db/seed';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainError,
  createCoreContext,
  deleteMediaAsset,
  getMediaAsset,
  isMediaAssetInUse,
  saveSetting,
  loadMediaBytes,
  objectStorageFromEnv,
  uploadMediaAsset,
  type CoreContext,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
// The root `.env` targets the running stack: storage tests only run on explicit opt-in.
const s3Endpoint = process.env.TEST_S3_OPT_IN === '1' ? process.env.S3_ENDPOINT : undefined;

function pngBytes(width: number, height: number, salt: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  b[33] = salt;
  return b;
}

describe.skipIf(!adminUrl || !redisUrl || !s3Endpoint)('media pipeline (integration)', () => {
  const dbName = `tix_media_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  const keys = new Set<string>();
  const salt = Math.floor(Math.random() * 200) + 1;

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
    await seedReferenceData(handle.db, () => {});
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      storage: objectStorageFromEnv(
        process.env as unknown as Parameters<typeof objectStorageFromEnv>[0],
      ),
    });
  });

  afterAll(async () => {
    for (const key of keys) await ctx.storage?.delete('assets', key).catch(() => {});
    redis?.disconnect();
    await handle?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  it('stores an image, reads it back and de-duplicates by hash and kind', async () => {
    const bytes = pngBytes(1600, 900, salt);
    const asset = await uploadMediaAsset(ctx, {
      kind: 'EVENT_IMAGE',
      bytes,
      fileName: '../evil/Cover Image.png',
      declaredMime: 'image/gif',
      altText: '  Stage  ',
      userId: null,
    });
    keys.add(asset.objectKey);
    expect(asset).toMatchObject({
      kind: 'EVENT_IMAGE',
      bucket: 'assets',
      mimeType: 'image/png',
      width: 1600,
      height: 900,
      sizeBytes: bytes.byteLength,
      altText: 'Stage',
      fileName: '.._evil_Cover Image.png',
    });
    expect(asset.objectKey).toMatch(/^media\/event_image\/\d{4}\/[0-9a-f]{64}-[0-9a-f]{8}\.png$/);

    const loaded = await loadMediaBytes(ctx, asset.id);
    expect(Buffer.from(loaded.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(loaded).toMatchObject({ mimeType: 'image/png', width: 1600, height: 900 });

    const again = await uploadMediaAsset(ctx, {
      kind: 'EVENT_IMAGE',
      bytes,
      fileName: 'other.png',
      userId: null,
    });
    expect(again.id).toBe(asset.id);
    const otherKind = await uploadMediaAsset(ctx, {
      kind: 'TICKET_BACKGROUND',
      bytes,
      fileName: 'bg.png',
      userId: null,
    });
    keys.add(otherKind.objectKey);
    expect(otherKind.id).not.toBe(asset.id);
  });

  it('rejects non-images, spoofed MIME types and oversized input', async () => {
    const reject = async (bytes: Uint8Array, code: string) => {
      const err = await uploadMediaAsset(ctx, {
        kind: 'EVENT_IMAGE',
        bytes,
        fileName: 'x.png',
        declaredMime: 'image/png',
        userId: null,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe(code);
    };
    await reject(
      new TextEncoder().encode('<svg onload="alert(1)"></svg>'),
      'MEDIA_UNSUPPORTED_TYPE',
    );
    await reject(new Uint8Array(0), 'MEDIA_EMPTY');
    await reject(new Uint8Array(10 * 1024 * 1024 + 1), 'MEDIA_TOO_LARGE');
    await reject(pngBytes(13_000, 10, salt), 'MEDIA_DIMENSIONS');
    await reject(pngBytes(0, 10, salt), 'MEDIA_DIMENSIONS');
  });

  it('refuses to delete a referenced asset and deletes unreferenced ones', async () => {
    const used = await uploadMediaAsset(ctx, {
      kind: 'EVENT_IMAGE',
      bytes: pngBytes(800, 450, salt + 1),
      fileName: 'used.png',
      userId: null,
    });
    keys.add(used.objectKey);
    const [venue] = await handle.db
      .insert(venues)
      .values({
        name: 'Venue',
        slug: `v-${randomUUID().slice(0, 6)}`,
        timeZone: 'Europe/Berlin',
      } as typeof venues.$inferInsert)
      .returning({ id: venues.id });
    const [rate] = await handle.db.select({ id: taxRates.id }).from(taxRates).limit(1);
    const [event] = await handle.db
      .insert(events)
      .values({
        venueId: venue!.id,
        taxRateId: rate!.id,
        title: 'Show',
        slug: `show-${randomUUID().slice(0, 6)}`,
        startsAt: new Date(Date.now() + 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        heroImageAssetId: used.id,
      } as typeof events.$inferInsert)
      .returning({ id: events.id });

    const err = await deleteMediaAsset(ctx, used.id).catch((e: unknown) => e);
    expect((err as DomainError).code).toBe('MEDIA_IN_USE');
    expect(await getMediaAsset(ctx, used.id)).not.toBeNull();

    await handle.db.update(events).set({ heroImageAssetId: null }).where(eq(events.id, event!.id));
    await deleteMediaAsset(ctx, used.id);
    expect(await getMediaAsset(ctx, used.id)).toBeNull();
    await expect(loadMediaBytes(ctx, used.id)).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
  });

  it('counts images inside ticket layouts and branding settings as in use', async () => {
    const upload = async (n: number) => {
      const a = await uploadMediaAsset(ctx, {
        kind: 'TICKET_BACKGROUND',
        bytes: pngBytes(300, 300, salt + n),
        fileName: 'x.png',
        userId: null,
      });
      keys.add(a.objectKey);
      return a;
    };
    const inLayout = await upload(10);
    const logo = await upload(11);
    expect(await isMediaAssetInUse(ctx, inLayout.id)).toBe(false);

    const [tpl] = await handle.db
      .insert(ticketTemplates)
      .values({
        name: 'T',
        pageWidthMm: 150,
        pageHeightMm: 60,
        layout: {
          elements: [
            { kind: 'image', id: 'i1', assetId: inLayout.id, x: 0, y: 0, width: 10, height: 10 },
          ],
        },
      } as unknown as typeof ticketTemplates.$inferInsert)
      .returning({ id: ticketTemplates.id });
    expect(await isMediaAssetInUse(ctx, inLayout.id)).toBe(true);
    expect(await deleteMediaAsset(ctx, inLayout.id).catch((e: unknown) => e)).toMatchObject({
      code: 'MEDIA_IN_USE',
    });
    await handle.db.delete(ticketTemplates).where(eq(ticketTemplates.id, tpl!.id));
    expect(await isMediaAssetInUse(ctx, inLayout.id)).toBe(false);

    await saveSetting(ctx, 'branding', { logoAssetId: logo.id }, null);
    expect(await isMediaAssetInUse(ctx, logo.id)).toBe(true);
  });
});
