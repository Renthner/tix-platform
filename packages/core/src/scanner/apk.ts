import { createHash, randomUUID } from 'node:crypto';
import { scannerApkReleases, withTransaction } from '@tix/db';
import { APP_VERSION, type AppLatestResponse } from '@tix/shared';
import { signToken, verifyToken } from '@tix/shared/server';
import { desc, eq } from 'drizzle-orm';
import { DomainError, requireCapability, type CoreContext } from '../context';
import { getSetting } from '../settings';
import { resolveScannerServerUrl } from './devices';

/**
 * Signed APKs of the scanner app, uploaded by a super admin and stored privately in the
 * documents bucket (`scanner-apk/<id>.apk`). Downloads go through the app (time-limited signed
 * links for staff phones, the same links are returned to paired devices as update info).
 */

export const APK_MAX_BYTES = 150 * 1024 * 1024;
export const APK_MIN_BYTES = 1024;
export const APK_CONTENT_TYPE = 'application/vnd.android.package-archive';
const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/;
const LINK_TYPE = 'scanner-apk';
/** Staff download links are valid for 24 hours, update links of paired devices for one hour. */
export const APK_STAFF_LINK_TTL_SECONDS = 24 * 3_600;
export const APK_DEVICE_LINK_TTL_SECONDS = 3_600;

export type ApkRelease = typeof scannerApkReleases.$inferSelect;

/** APKs are ZIP archives: local file header magic `PK\x03\x04`. */
export function looksLikeApk(bytes: Uint8Array): boolean {
  return (
    bytes.length >= APK_MIN_BYTES &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

export async function listApkReleases(ctx: CoreContext): Promise<ApkRelease[]> {
  return ctx.db.select().from(scannerApkReleases).orderBy(desc(scannerApkReleases.versionCode));
}

export async function getCurrentApkRelease(ctx: CoreContext): Promise<ApkRelease | null> {
  const [row] = await ctx.db
    .select()
    .from(scannerApkReleases)
    .where(eq(scannerApkReleases.isCurrent, true));
  return row ?? null;
}

export async function registerApkRelease(
  ctx: CoreContext,
  params: {
    bytes: Uint8Array;
    versionName: string;
    versionCode: number;
    notes?: string | null;
    uploadedByUserId: string | null;
    makeCurrent: boolean;
  },
): Promise<ApkRelease> {
  const storage = requireCapability(ctx, 'storage');
  const versionName = params.versionName.trim();
  if (!VERSION_NAME.test(versionName)) {
    throw new DomainError('INVALID_VERSION_NAME', 'Invalid version name', 422);
  }
  if (
    !Number.isInteger(params.versionCode) ||
    params.versionCode < 1 ||
    params.versionCode > 2_100_000_000
  ) {
    throw new DomainError(
      'INVALID_VERSION_CODE',
      'The version code must be a positive integer',
      422,
    );
  }
  if (params.bytes.length > APK_MAX_BYTES) {
    throw new DomainError('APK_TOO_LARGE', 'The APK is too large', 413);
  }
  if (!looksLikeApk(params.bytes)) {
    throw new DomainError('NOT_AN_APK', 'The file is not an APK (ZIP) archive', 422);
  }
  const [duplicate] = await ctx.db
    .select({ id: scannerApkReleases.id })
    .from(scannerApkReleases)
    .where(eq(scannerApkReleases.versionCode, params.versionCode));
  if (duplicate) {
    throw new DomainError('VERSION_CODE_EXISTS', 'A release with this version code exists', 409);
  }
  const id = randomUUID();
  const objectKey = `scanner-apk/${id}.apk`;
  await storage.put('documents', objectKey, params.bytes, APK_CONTENT_TYPE);
  try {
    return await withTransaction(ctx.db, async (tx) => {
      if (params.makeCurrent) {
        await tx
          .update(scannerApkReleases)
          .set({ isCurrent: false })
          .where(eq(scannerApkReleases.isCurrent, true));
      }
      const [row] = await tx
        .insert(scannerApkReleases)
        .values({
          id,
          versionName,
          versionCode: params.versionCode,
          objectKey,
          sha256: createHash('sha256').update(params.bytes).digest('hex'),
          sizeBytes: params.bytes.length,
          notes: params.notes?.trim().slice(0, 2_000) || null,
          uploadedByUserId: params.uploadedByUserId,
          isCurrent: params.makeCurrent,
        })
        .returning();
      if (!row) throw new Error('Release insert failed');
      return row;
    });
  } catch (err) {
    await storage.delete('documents', objectKey).catch(() => undefined);
    throw err;
  }
}

export async function setCurrentApkRelease(ctx: CoreContext, releaseId: string): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    const [row] = await tx
      .select({ id: scannerApkReleases.id })
      .from(scannerApkReleases)
      .where(eq(scannerApkReleases.id, releaseId))
      .for('update');
    if (!row) throw new DomainError('RELEASE_NOT_FOUND', 'Release not found', 404);
    await tx
      .update(scannerApkReleases)
      .set({ isCurrent: false })
      .where(eq(scannerApkReleases.isCurrent, true));
    await tx
      .update(scannerApkReleases)
      .set({ isCurrent: true })
      .where(eq(scannerApkReleases.id, releaseId));
  });
}

/** Deletes a release that is not the current one (file and row). */
export async function deleteApkRelease(ctx: CoreContext, releaseId: string): Promise<void> {
  const storage = requireCapability(ctx, 'storage');
  const [row] = await ctx.db
    .select()
    .from(scannerApkReleases)
    .where(eq(scannerApkReleases.id, releaseId));
  if (!row) throw new DomainError('RELEASE_NOT_FOUND', 'Release not found', 404);
  if (row.isCurrent) {
    throw new DomainError('RELEASE_IS_CURRENT', 'The current release cannot be deleted', 409);
  }
  await ctx.db.delete(scannerApkReleases).where(eq(scannerApkReleases.id, releaseId));
  await storage.delete('documents', row.objectKey).catch(() => undefined);
}

/** Signed time-limited token for `releaseId` (a release id, or `current` = whichever is current at download time). */
export function createApkDownloadToken(
  ctx: CoreContext,
  releaseId: string | 'current',
  ttlSeconds = APK_STAFF_LINK_TTL_SECONDS,
): string {
  return signToken(LINK_TYPE, { rid: releaseId }, ttlSeconds, ctx.sessionSecret);
}

/** Resolves a download token to the release and a stream of its file (never buffered in memory). */
export async function openApkForToken(
  ctx: CoreContext,
  token: string,
): Promise<{ release: ApkRelease; stream: ReadableStream<Uint8Array> }> {
  const claims = verifyToken<{ rid: string }>(token, LINK_TYPE, ctx.sessionSecret);
  if (!claims)
    throw new DomainError('INVALID_LINK', 'The download link is invalid or expired', 403);
  const release =
    claims.rid === 'current'
      ? await getCurrentApkRelease(ctx)
      : ((
          await ctx.db
            .select()
            .from(scannerApkReleases)
            .where(eq(scannerApkReleases.id, claims.rid))
        )[0] ?? null);
  if (!release) throw new DomainError('RELEASE_NOT_FOUND', 'Release not found', 404);
  const { stream } = await requireCapability(ctx, 'storage').getStream(
    'documents',
    release.objectKey,
  );
  return { release, stream };
}

/** Absolute download URL for a token (uses the scanner server address). */
export async function apkDownloadUrl(ctx: CoreContext, token: string): Promise<string> {
  const server = await resolveScannerServerUrl(ctx);
  if (!server.url) {
    // Never hand out a relative URL: the app has no base to resolve it against.
    throw new DomainError(
      'SERVER_URL_MISSING',
      'Set the scanner server address in the scanner settings first',
      503,
    );
  }
  return `${server.url}/api/scanner/v1/app/download?t=${encodeURIComponent(token)}`;
}

/**
 * GitHub page staff open to install the app: newest final release, or the list when the default channel is
 * `next`. Null when no repository is configured on the server (the app's built-in one is not known here).
 */
export async function githubStaffDownloadUrl(ctx: CoreContext): Promise<string | null> {
  const s = await getSetting(ctx, 'scanner');
  if (!s.githubRepository) return null;
  return `https://github.com/${s.githubRepository}/releases/tag/v${APP_VERSION}`;
}

/**
 * Update info for paired devices from the uploaded releases; null when none is published. Also served in source
 * GITHUB so apps without GitHub support can step up once (see docs/SCANNER.md "App updates").
 */
export async function appLatestInfo(ctx: CoreContext): Promise<AppLatestResponse | null> {
  const release = await getCurrentApkRelease(ctx);
  if (!release) return null;
  const token = createApkDownloadToken(ctx, release.id, APK_DEVICE_LINK_TTL_SECONDS);
  return {
    versionName: release.versionName,
    versionCode: release.versionCode,
    sha256: release.sha256,
    sizeBytes: release.sizeBytes,
    notes: release.notes,
    downloadUrl: await apkDownloadUrl(ctx, token),
    downloadUrlTtlSeconds: APK_DEVICE_LINK_TTL_SECONDS,
  };
}
