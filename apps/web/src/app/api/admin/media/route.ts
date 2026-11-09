import { uploadMediaAsset } from '@tix/core';
import { MEDIA_ASSET_KINDS, MEDIA_MAX_BYTES, type MediaAssetKind } from '@tix/shared';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/server/admin/audit';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Kinds the generic picker may upload (documents are never uploaded through it). */
const UPLOADABLE_KINDS = MEDIA_ASSET_KINDS.filter((k) => k !== 'DOCUMENT');

export interface MediaUploadResponse {
  asset: {
    id: string;
    kind: MediaAssetKind;
    url: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
    altText: string | null;
  };
}

/**
 * POST multipart/form-data `kind` + `file` (+ optional `altText`) – stores an image and returns
 * the catalogue row. A route handler instead of a server action: images exceed the
 * server-action body limit.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await adminForApi(['EVENT_MANAGER']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    // Defence in depth on top of the SameSite=strict admin cookie.
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).host !== request.headers.get('host')) {
      return apiError('FORBIDDEN', 'Cross-site request', 403);
    }
    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (declaredLength > MEDIA_MAX_BYTES + 1024 * 1024) {
      return apiError('MEDIA_TOO_LARGE', 'The image is too large (max 10 MB)', 413);
    }
    const form = await request.formData().catch(() => null);
    if (!form) return apiError('INVALID_BODY', 'Multipart body expected', 400);
    const kind = z
      .enum(UPLOADABLE_KINDS as [MediaAssetKind, ...MediaAssetKind[]])
      .safeParse(form.get('kind'));
    if (!kind.success) return apiError('KIND_INVALID', 'Unknown media kind', 422);
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return apiError('FILE_REQUIRED', 'No file uploaded', 422);
    }
    if (file.size > MEDIA_MAX_BYTES) {
      return apiError('MEDIA_TOO_LARGE', 'The image is too large (max 10 MB)', 413);
    }
    const altText = form.get('altText');
    const core = getCore();
    const asset = await uploadMediaAsset(core, {
      kind: kind.data,
      bytes: new Uint8Array(await file.arrayBuffer()),
      fileName: file.name,
      declaredMime: file.type,
      altText: typeof altText === 'string' ? altText : null,
      userId: session.userId,
    });
    await audit(core.db, session, 'media.upload', 'media_asset', asset.id, {
      kind: asset.kind,
      file: asset.fileName,
      bytes: asset.sizeBytes,
    });
    const body: MediaUploadResponse = {
      asset: {
        id: asset.id,
        kind: asset.kind,
        url: `/api/media/${asset.id}`,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        width: asset.width,
        height: asset.height,
        altText: asset.altText,
      },
    };
    return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
  });
}
