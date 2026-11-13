import { createHash, randomBytes } from 'node:crypto';
import { mediaAssetVariants, mediaAssets, withTransaction } from '@tix/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { SHOP_TAGS, invalidateShopCache } from './cache/shop-cache';
import { DomainError, requireCapability, type CoreContext } from './context';
import { coreLog } from './log';
import { detectImage, type MediaAssetRow } from './media';
import { normaliseUpload } from './media-variants';

/**
 * One-off clean-up of masters stored before uploads were normalised: the same treatment as
 * `normaliseUpload` gives new uploads (EXIF orientation applied, EXIF / GPS / XMP / IPTC stripped,
 * WebP converted to JPEG / PNG). `media_assets.master_normalised_at` marks finished assets, so
 * the job is idempotent and a no-op once everything is done. PDFs, wallet passes and e-mails read
 * the masters, hence every kind is handled (public and private).
 */

export interface NormaliseMastersResult {
  /** Assets looked at (every one gets `master_normalised_at`, except read errors). */
  processed: number;
  /** Assets whose master was re-encoded into a new object. */
  rewritten: number;
  /** Assets that could not be read from storage (retried by the next run). */
  failed: number;
  /** True when the time budget ended the run before every pending asset was handled. */
  more: boolean;
}

const LOCK_TTL_MS = 10 * 60 * 1000;

export type NormaliseAssetStatus = 'unchanged' | 'rewritten' | 'skipped';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `media/x/2025/abc-1234.webp` -> `media/x/2025/abc-1234-n9f3a.jpg` (never reuses the old key). */
function newMasterKey(objectKey: string, ext: string): string {
  const dot = objectKey.lastIndexOf('.');
  const base = dot > objectKey.lastIndexOf('/') ? objectKey.slice(0, dot) : objectKey;
  return `${base}-n${randomBytes(3).toString('hex')}.${ext}`;
}

/** Keeps the name base, swaps a trailing image extension for the new one. */
function renamedFile(fileName: string, ext: string): string {
  return fileName.replace(/\.(png|jpe?g|webp)$/i, '') + `.${ext}`;
}

async function markNormalised(
  ctx: CoreContext,
  asset: Pick<MediaAssetRow, 'id' | 'masterSha256'>,
  masterSha256: string | null,
): Promise<void> {
  await ctx.db
    .update(mediaAssets)
    .set({
      masterNormalisedAt: new Date(),
      masterSha256: asset.masterSha256 ?? masterSha256,
    })
    .where(and(eq(mediaAssets.id, asset.id), isNull(mediaAssets.masterNormalisedAt)));
}

/**
 * Normalises the master of one asset. Reading errors are rethrown (the asset stays pending);
 * unknown formats, animations and undecodable files are marked finished without changes.
 */
export async function normaliseAssetMaster(
  ctx: CoreContext,
  asset: MediaAssetRow,
): Promise<NormaliseAssetStatus> {
  const storage = requireCapability(ctx, 'storage');
  const bucket = asset.bucket as 'assets' | 'documents';
  const object = await storage.get(bucket, asset.objectKey);
  const bytes = object.body;

  const info = detectImage(bytes);
  if (!info) {
    if (asset.mimeType.startsWith('image/') && asset.mimeType !== 'image/svg+xml') {
      coreLog.warn({ assetId: asset.id }, '[media] master is not a supported image, left as is');
    }
    await markNormalised(ctx, asset, null);
    return 'skipped';
  }

  let master;
  try {
    master = await normaliseUpload(bytes, info);
  } catch (err) {
    if (!(err instanceof DomainError && err.code === 'MEDIA_UNDECODABLE')) throw err;
    coreLog.warn({ assetId: asset.id }, '[media] master could not be decoded, left as is');
    await markNormalised(ctx, asset, null);
    return 'skipped';
  }

  if (master.animated || master.bytes === bytes) {
    await markNormalised(ctx, asset, sha256Hex(bytes));
    return master.animated ? 'skipped' : 'unchanged';
  }

  const newKey = newMasterKey(asset.objectKey, master.ext);
  await storage.put(bucket, newKey, master.bytes, master.mime);
  const dimensionsChanged = master.width !== asset.width || master.height !== asset.height;
  const resetVariants = dimensionsChanged || master.rotated === true;

  let staleVariantKeys: string[] = [];
  let swapped: boolean;
  try {
    swapped = await withTransaction(ctx.db, async (tx) => {
      // Only if nobody changed the row meanwhile (a concurrent run on another worker).
      const [row] = await tx
        .update(mediaAssets)
        .set({
          objectKey: newKey,
          mimeType: master.mime,
          fileName:
            master.mime === asset.mimeType
              ? asset.fileName
              : renamedFile(asset.fileName, master.ext),
          sizeBytes: master.bytes.byteLength,
          width: master.width,
          height: master.height,
          masterSha256: sha256Hex(master.bytes),
          masterNormalisedAt: new Date(),
          ...(resetVariants ? { variantsProcessedAt: null, variantsAttempts: 0 } : {}),
        })
        .where(
          and(
            eq(mediaAssets.id, asset.id),
            eq(mediaAssets.objectKey, asset.objectKey),
            isNull(mediaAssets.masterNormalisedAt),
          ),
        )
        .returning({ id: mediaAssets.id });
      if (!row) return false;
      if (resetVariants) {
        const variants = await tx
          .delete(mediaAssetVariants)
          .where(eq(mediaAssetVariants.assetId, asset.id))
          .returning({ storageKey: mediaAssetVariants.storageKey });
        staleVariantKeys = variants.map((v) => v.storageKey);
      }
      return true;
    });
  } catch (err) {
    await storage.delete(bucket, newKey).catch(() => undefined);
    throw err;
  }
  if (!swapped) {
    await storage.delete(bucket, newKey).catch(() => undefined);
    return 'skipped';
  }
  // Dimensions / content hash of the asset changed (cached catalogue row, <img> sizes).
  await invalidateShopCache(ctx, [SHOP_TAGS.media]);

  // After the commit: the old master and the stale variants (the orphan sweep is the fallback).
  for (const key of staleVariantKeys) {
    await storage
      .delete('assets', key)
      .catch((err: unknown) =>
        coreLog.warn({ err, key }, '[media] stale variant not removed (left for the orphan sweep)'),
      );
  }
  await storage
    .delete(bucket, asset.objectKey)
    .catch((err: unknown) =>
      coreLog.warn(
        { err, key: asset.objectKey },
        '[media] old master not removed (left for the orphan sweep)',
      ),
    );
  return 'rewritten';
}

/**
 * Normalises all legacy masters (`master_normalised_at IS NULL`), sequentially and bounded by
 * `budgetMs`. A Redis mutex serialises runs across workers. Safe to call repeatedly.
 */
export async function normaliseLegacyMasters(
  ctx: CoreContext,
  opts: { budgetMs?: number; batchSize?: number; now?: () => number } = {},
): Promise<NormaliseMastersResult> {
  const result: NormaliseMastersResult = { processed: 0, rewritten: 0, failed: 0, more: false };
  const lockKey = ctx.keys.mutex('media-normalise-backfill');
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const locked = await ctx.redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX');
  if (locked !== 'OK') return result;
  const clock = opts.now ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? 8 * 60 * 1000);
  const batchSize = opts.batchSize ?? 10;
  requireCapability(ctx, 'storage');
  const skipped = new Set<string>();
  try {
    for (;;) {
      const batch = (
        await ctx.db
          .select()
          .from(mediaAssets)
          .where(isNull(mediaAssets.masterNormalisedAt))
          .orderBy(asc(mediaAssets.createdAt))
          .limit(batchSize + skipped.size)
      ).filter((a) => !skipped.has(a.id));
      if (batch.length === 0) return result;
      for (const asset of batch) {
        if (clock() >= deadline) {
          result.more = true;
          return result;
        }
        try {
          if ((await normaliseAssetMaster(ctx, asset)) === 'rewritten') result.rewritten += 1;
        } catch (err) {
          skipped.add(asset.id);
          result.failed += 1;
          coreLog.warn({ err, assetId: asset.id }, '[media] master normalisation failed for asset');
        }
        result.processed += 1;
        await ctx.redis.pexpire(lockKey, LOCK_TTL_MS);
      }
    }
  } finally {
    if ((await ctx.redis.get(lockKey)) === token) await ctx.redis.del(lockKey);
  }
}
