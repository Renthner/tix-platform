import { mediaAssetVariants, mediaAssets, type Executor } from '@tix/db';
import {
  MEDIA_MAX_PIXELS,
  MEDIA_VARIANT_FORMATS,
  MEDIA_VARIANT_MIME,
  PUBLIC_MEDIA_KINDS,
  mediaVariantWidths,
  type MediaVariantFormat,
} from '@tix/shared';
import { QUEUE_NAMES } from '@tix/redis';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { SHOP_TAGS, invalidateShopCache } from './cache/shop-cache';
import { DomainError, requireCapability, type CoreContext } from './context';
import { coreLog } from './log';
import type { ImageInfo, MediaAssetRow } from './media';

/**
 * Responsive image variants. Public raster images get AVIF + WebP copies at several widths next
 * to the stored original (see `MEDIA_VARIANT_WIDTHS`); the original / master stays a PNG / JPEG
 * (or WebP) that ticket PDFs, wallet passes and e-mails keep using unchanged. Variants are
 * derived data: `generateMediaVariants` is idempotent and the worker backfills assets that have
 * none (existing assets, or an upload whose conversion failed).
 */

type Sharp = (typeof import('sharp'))['default'];

let conservativeSharp = false;
let conservativeApplied = false;

/**
 * Makes sharp frugal for the web process (call once at startup): one libvips thread and no
 * operation cache, so an upload's normalisation cannot compete with page rendering. The worker
 * never calls this and keeps sharp's defaults for variant generation.
 */
export function useConservativeSharp(): void {
  conservativeSharp = true;
}

/** sharp is native and loaded lazily: a missing binary must not break unrelated code paths. */
async function loadSharp(): Promise<Sharp> {
  const { default: sharp } = await import('sharp');
  if (conservativeSharp && !conservativeApplied) {
    conservativeApplied = true;
    sharp.concurrency(1);
    sharp.cache(false);
  }
  return sharp;
}

const AVIF_QUALITY = 55;
const AVIF_EFFORT = 3;
const WEBP_QUALITY = 75;
const MASTER_JPEG_QUALITY = 88;

const sharpInput = { limitInputPixels: MEDIA_MAX_PIXELS, failOn: 'error' } as const;

export interface NormalisedImage {
  /** Bytes to store as the canonical file (the upload itself when nothing had to change). */
  bytes: Uint8Array;
  mime: ImageInfo['mime'];
  ext: ImageInfo['ext'];
  width: number;
  height: number;
  /** True for animations: stored untouched, no variants. */
  animated: boolean;
  /** True when an EXIF orientation had to be applied (pixels were rotated / flipped). */
  rotated?: boolean;
}

function undecodable(cause: unknown): DomainError {
  coreLog.debug({ err: cause }, '[media] image could not be decoded');
  return new DomainError('MEDIA_UNDECODABLE', 'The image could not be read', 422);
}

/**
 * Validates that the upload really decodes and prepares the canonical file: EXIF orientation is
 * applied and all metadata (GPS position, camera data, XMP) is stripped. PNG / JPEG without
 * orientation or metadata are kept byte for byte (no generation loss). The canonical file must be
 * usable in PDFs, wallet passes and e-mails, so WebP is always converted: opaque WebP to JPEG
 * (q88), transparent WebP to PNG. Re-encoded PNG stays PNG.
 */
export async function normaliseUpload(
  bytes: Uint8Array,
  info: ImageInfo,
): Promise<NormalisedImage> {
  const sharp = await loadSharp();
  const original: NormalisedImage = {
    bytes,
    mime: info.mime,
    ext: info.ext,
    width: info.width,
    height: info.height,
    animated: false,
  };
  let meta: import('sharp').Metadata;
  try {
    meta = await sharp(bytes, sharpInput).metadata();
  } catch (err) {
    throw undecodable(err);
  }
  const animated = (meta.pages ?? 1) > 1;
  const rotated = (meta.orientation ?? 1) > 1;
  const keepAsIs =
    animated || (info.mime !== 'image/webp' && !rotated && !meta.exif && !meta.xmp && !meta.iptc);

  if (keepAsIs) {
    try {
      // Full decode of a tiny rendition: catches truncated / corrupt data before anything is stored.
      await sharp(bytes, sharpInput)
        .resize({ width: 64, height: 64, fit: 'inside', withoutEnlargement: true })
        .raw()
        .toBuffer();
    } catch (err) {
      throw undecodable(err);
    }
    return animated ? { ...original, animated: true } : original;
  }

  try {
    // The re-encode is itself the full decode (`failOn: 'error'`): one pipeline, no extra pass.
    const pipeline = sharp(bytes, sharpInput).rotate();
    const keepPng = info.mime === 'image/png' || meta.hasAlpha === true;
    const { data, info: out } = keepPng
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
      : await pipeline
          .jpeg({ quality: MASTER_JPEG_QUALITY, chromaSubsampling: '4:4:4' })
          .toBuffer({ resolveWithObject: true });
    return {
      bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      mime: keepPng ? 'image/png' : 'image/jpeg',
      ext: keepPng ? 'png' : 'jpg',
      width: out.width,
      height: out.height,
      animated: false,
      rotated,
    };
  } catch (err) {
    throw undecodable(err);
  }
}

/** Object key of a variant: next to the original, `<original without extension>.w<width>.<format>`. */
export function variantStorageKey(
  objectKey: string,
  format: MediaVariantFormat,
  width: number,
): string {
  const dot = objectKey.lastIndexOf('.');
  const base = dot > objectKey.lastIndexOf('/') ? objectKey.slice(0, dot) : objectKey;
  return `${base}.w${width}.${format}`;
}

export interface GenerateVariantsResult {
  created: number;
  existing: number;
  /** Variants that could not be encoded (retried until `MEDIA_VARIANTS_MAX_ATTEMPTS`). */
  failed: number;
  /** The asset is finished (complete, or given up on after repeated failures). */
  processed: boolean;
}

/**
 * Generates the missing AVIF / WebP variants of an asset from its stored bytes and records them.
 * Idempotent: existing (format, width) pairs are skipped, keys are deterministic. Throws
 * `MEDIA_UNDECODABLE` when the source cannot be decoded at all; individual encode failures are
 * logged and counted in `failed`.
 */
export async function generateMediaVariants(
  ctx: CoreContext,
  asset: Pick<MediaAssetRow, 'id' | 'bucket' | 'objectKey'>,
  source: Uint8Array,
): Promise<GenerateVariantsResult> {
  const storage = requireCapability(ctx, 'storage');
  const sharp = await loadSharp();
  let meta: import('sharp').Metadata;
  try {
    meta = await sharp(source, sharpInput).metadata();
  } catch (err) {
    throw undecodable(err);
  }
  if ((meta.pages ?? 1) > 1 || !meta.width || !meta.height) {
    // Nothing to convert (animation): final, do not look at it again.
    await markVariantsProcessed(ctx, asset.id);
    return { created: 0, existing: 0, failed: 0, processed: true };
  }
  const swapped = (meta.orientation ?? 1) >= 5;
  const sourceWidth = swapped ? meta.height : meta.width;
  const widths = mediaVariantWidths(sourceWidth);

  const present = await ctx.db
    .select({ format: mediaAssetVariants.format, width: mediaAssetVariants.width })
    .from(mediaAssetVariants)
    .where(eq(mediaAssetVariants.assetId, asset.id));
  const have = new Set(present.map((v) => `${v.format}:${v.width}`));

  const result = { created: 0, existing: 0, failed: 0 };
  for (const width of widths) {
    for (const format of MEDIA_VARIANT_FORMATS) {
      if (have.has(`${format}:${width}`)) {
        result.existing += 1;
        continue;
      }
      try {
        const pipeline = sharp(source, sharpInput)
          .rotate()
          .resize({ width, withoutEnlargement: true });
        const { data, info } = await (
          format === 'avif'
            ? pipeline.avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT })
            : pipeline.webp({ quality: WEBP_QUALITY })
        ).toBuffer({ resolveWithObject: true });
        const storageKey = variantStorageKey(asset.objectKey, format, width);
        await storage.put(
          'assets',
          storageKey,
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          MEDIA_VARIANT_MIME[format],
        );
        await ctx.db
          .insert(mediaAssetVariants)
          .values({
            assetId: asset.id,
            format,
            width: info.width,
            height: info.height,
            sizeBytes: data.byteLength,
            storageKey,
          })
          .onConflictDoNothing();
        result.created += 1;
      } catch (err) {
        result.failed += 1;
        coreLog.warn({ err, assetId: asset.id, format, width }, '[media] variant failed');
      }
    }
  }
  const processed = await recordVariantAttempt(ctx, asset.id, result.failed === 0);
  return { ...result, processed };
}

/** Attempts after which an asset with permanently failing variants is given up on. */
export const MEDIA_VARIANTS_MAX_ATTEMPTS = 3;

async function markVariantsProcessed(ctx: CoreContext, assetId: string): Promise<void> {
  await ctx.db
    .update(mediaAssets)
    .set({ variantsProcessedAt: sql`coalesce(${mediaAssets.variantsProcessedAt}, now())` })
    .where(eq(mediaAssets.id, assetId));
  // The cached catalogue row decides the cache headers of the delivery route.
  await invalidateShopCache(ctx, [SHOP_TAGS.media]);
}

/**
 * Counts one processing attempt. A complete run finishes the asset; after
 * `MEDIA_VARIANTS_MAX_ATTEMPTS` attempts with failures it is finished anyway (what exists is
 * served, the rest falls back to the original) so a permanent partial failure is not retried
 * forever. Returns whether the asset is finished.
 */
async function recordVariantAttempt(
  ctx: CoreContext,
  assetId: string,
  complete: boolean,
): Promise<boolean> {
  const [row] = await ctx.db
    .update(mediaAssets)
    .set({
      variantsAttempts: sql`${mediaAssets.variantsAttempts} + 1`,
      variantsProcessedAt: complete
        ? sql`coalesce(${mediaAssets.variantsProcessedAt}, now())`
        : sql`CASE WHEN ${mediaAssets.variantsAttempts} + 1 >= ${MEDIA_VARIANTS_MAX_ATTEMPTS} THEN coalesce(${mediaAssets.variantsProcessedAt}, now()) ELSE ${mediaAssets.variantsProcessedAt} END`,
    })
    .where(eq(mediaAssets.id, assetId))
    .returning({
      attempts: mediaAssets.variantsAttempts,
      processedAt: mediaAssets.variantsProcessedAt,
    });
  if (!row) return false;
  if (row.processedAt) await invalidateShopCache(ctx, [SHOP_TAGS.media]);
  if (!complete && row.processedAt && row.attempts === MEDIA_VARIANTS_MAX_ATTEMPTS) {
    coreLog.warn(
      { assetId, attempts: row.attempts },
      '[media] giving up on missing variants after repeated failures (original is served)',
    );
  }
  return row.processedAt !== null;
}

/** BullMQ job (queue `media`) that generates the variants of one asset. */
export const MEDIA_VARIANTS_JOB = 'media-generate-variants';

export interface MediaVariantsJobData {
  assetId: string;
}

export type ProcessAssetVariantsResult =
  { status: 'missing' } | { status: 'done' | 'pending'; created: number; failed: number };

/**
 * Generates the variants of one stored asset (worker job and backfill). `done` = finished,
 * `pending` = some variants failed and attempts are left, `missing` = no such asset (e.g. an
 * import that was rolled back). Errors reading the stored file count as an attempt and are
 * rethrown; an undecodable file is final.
 */
export async function processAssetVariants(
  ctx: CoreContext,
  assetId: string,
): Promise<ProcessAssetVariantsResult> {
  const [asset] = await ctx.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
  if (!asset) return { status: 'missing' };
  if (asset.variantsProcessedAt) return { status: 'done', created: 0, failed: 0 };
  const storage = requireCapability(ctx, 'storage');
  try {
    const object = await storage.get(asset.bucket as 'assets' | 'documents', asset.objectKey);
    const res = await generateMediaVariants(ctx, asset, object.body);
    return {
      status: res.processed ? 'done' : 'pending',
      created: res.created,
      failed: res.failed,
    };
  } catch (err) {
    if (err instanceof DomainError && err.code === 'MEDIA_UNDECODABLE') {
      // Permanent: never retry.
      await markVariantsProcessed(ctx, asset.id);
      return { status: 'done', created: 0, failed: 0 };
    }
    await recordVariantAttempt(ctx, asset.id, false);
    throw err;
  }
}

/**
 * Queues the variant generation of a freshly stored asset (the web request never converts).
 * The job id dedupes repeated enqueues. A failed enqueue is logged and left to the periodic
 * backfill, so an upload never fails because of it.
 */
export async function enqueueMediaVariants(
  ctx: Pick<CoreContext, 'jobs'>,
  assetId: string,
): Promise<boolean> {
  if (!ctx.jobs) return false;
  try {
    await ctx.jobs.add<MediaVariantsJobData>(
      QUEUE_NAMES.media,
      MEDIA_VARIANTS_JOB,
      { assetId },
      { jobId: `media-variants-${assetId}` },
    );
    return true;
  } catch (err) {
    coreLog.warn({ err, assetId }, '[media] variants job could not be queued (backfill will do)');
    return false;
  }
}

export interface MediaVariantRow {
  format: MediaVariantFormat;
  width: number;
  height: number;
  sizeBytes: number;
  storageKey: string;
  /** Widest generated width of this format for the asset. */
  largestWidth: number;
}

/**
 * The variant to serve for `?w=&f=`: the smallest one that is at least `width` wide, otherwise
 * the widest available (a source narrower than the request). Null when the asset has no variant
 * in that format – the caller then falls back to the original.
 */
export async function findMediaVariant(
  db: Executor,
  assetId: string,
  format: MediaVariantFormat,
  width: number,
): Promise<MediaVariantRow | null> {
  const rows = await db
    .select({
      format: mediaAssetVariants.format,
      width: mediaAssetVariants.width,
      height: mediaAssetVariants.height,
      sizeBytes: mediaAssetVariants.sizeBytes,
      storageKey: mediaAssetVariants.storageKey,
    })
    .from(mediaAssetVariants)
    .where(and(eq(mediaAssetVariants.assetId, assetId), eq(mediaAssetVariants.format, format)))
    .orderBy(asc(mediaAssetVariants.width));
  const pick = rows.find((r) => r.width >= width) ?? rows[rows.length - 1];
  return pick ? { ...pick, format, largestWidth: rows[rows.length - 1]!.width } : null;
}

/** Variants of an asset (storage keys are needed to delete them together with the asset). */
export async function listMediaVariants(db: Executor, assetId: string) {
  return db
    .select()
    .from(mediaAssetVariants)
    .where(eq(mediaAssetVariants.assetId, assetId))
    .orderBy(asc(mediaAssetVariants.format), asc(mediaAssetVariants.width));
}

export async function loadMediaVariantBytes(
  ctx: CoreContext,
  variant: Pick<MediaVariantRow, 'storageKey'>,
): Promise<Uint8Array> {
  const storage = requireCapability(ctx, 'storage');
  return (await storage.get('assets', variant.storageKey)).body;
}

export interface MediaVariantBackfillResult {
  processed: number;
  created: number;
  failed: number;
  /** True when the time budget ended the run before every pending asset was handled. */
  more: boolean;
}

const BACKFILL_LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * Generates variants for public image assets that have none yet (existing assets from before
 * variants existed, uploads whose conversion failed). Sequential, bounded by `budgetMs`, safe to
 * run on several workers (a Redis mutex serialises runs) and to call repeatedly. Assets that
 * cannot be decoded are marked processed so they are not retried forever.
 */
export async function backfillMediaVariants(
  ctx: CoreContext,
  opts: { budgetMs?: number; batchSize?: number; now?: () => number } = {},
): Promise<MediaVariantBackfillResult> {
  const result: MediaVariantBackfillResult = { processed: 0, created: 0, failed: 0, more: false };
  const lockKey = ctx.keys.mutex('media-variants-backfill');
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const locked = await ctx.redis.set(lockKey, token, 'PX', BACKFILL_LOCK_TTL_MS, 'NX');
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
          .where(
            and(
              isNull(mediaAssets.variantsProcessedAt),
              inArray(mediaAssets.kind, [...PUBLIC_MEDIA_KINDS]),
            ),
          )
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
          const res = await processAssetVariants(ctx, asset.id);
          if (res.status === 'pending') {
            skipped.add(asset.id);
            result.created += res.created;
            result.failed += res.failed;
          } else if (res.status === 'done') {
            result.created += res.created;
          }
        } catch (err) {
          skipped.add(asset.id);
          result.failed += 1;
          coreLog.warn({ err, assetId: asset.id }, '[media] variant backfill failed for asset');
        }
        result.processed += 1;
        await ctx.redis.pexpire(lockKey, BACKFILL_LOCK_TTL_MS);
      }
    }
  } finally {
    if ((await ctx.redis.get(lockKey)) === token) await ctx.redis.del(lockKey);
  }
}
