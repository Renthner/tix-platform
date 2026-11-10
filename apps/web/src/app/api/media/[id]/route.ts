import { getMediaAsset, loadMediaBytes } from '@tix/core';
import { isPublicMediaKind } from '@tix/shared';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * GET – media delivery.
 * Public kinds (event / venue images, logos, e-mail images; see `PUBLIC_MEDIA_KINDS`) are served
 * to everyone with immutable caching: an asset id always maps to the same bytes (sha256 ETag).
 * Private kinds (ticket backgrounds, wallet images, documents, other) require an admin session
 * and are never cached by shared caches. `?download=1` forces a download instead of inline display.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = uuidParam.safeParse((await params).id);
    if (!id.success) return apiError('NOT_FOUND', 'Not found', 404);
    const core = getCore();
    const asset = await getMediaAsset(core, id.data);
    if (!asset) return apiError('NOT_FOUND', 'Not found', 404);

    const isPublic = isPublicMediaKind(asset.kind);
    if (!isPublic && !(await adminForApi())) return apiError('NOT_FOUND', 'Not found', 404);

    const etag = `"${asset.sha256}"`;
    const headers: Record<string, string> = {
      etag,
      'cache-control': isPublic
        ? 'public, max-age=31536000, immutable'
        : 'private, max-age=300, must-revalidate',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
    };
    if (
      request.headers
        .get('if-none-match')
        ?.split(',')
        .some((v) => v.trim() === etag)
    ) {
      return new Response(null, { status: 304, headers });
    }
    const media = await loadMediaBytes(core, asset.id);
    return new Response(Buffer.from(media.bytes), {
      headers: {
        ...headers,
        'content-type': media.mimeType,
        'content-length': String(media.bytes.byteLength),
        'content-disposition': `${new URL(request.url).searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="${asset.fileName.replace(/[^\w.-]/g, '_')}"`,
      },
    });
  });
}
