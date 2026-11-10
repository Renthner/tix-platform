import { Readable } from 'node:stream';
import {
  BACKUP_MAGIC,
  DomainError,
  archiveKey,
  getSetting,
  incomingDirectory,
  newUploadId,
  requestImport,
} from '@tix/core';
import { audit } from '@/server/admin/audit';
import { adminForApi } from '@/server/auth';
import { getBackupBuckets } from '@/server/backups';
import { getCore } from '@/server/core';
import { apiError, assertSameOrigin, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Passes the body through but rejects it before anything is stored when it is not a backup file. */
async function* requireBackupHeader(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  let head = Buffer.alloc(0);
  let checked = false;
  let total = 0;
  for await (const chunk of source) {
    // Counted while streaming (a Content-Length header can lie or be missing).
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new DomainError('UPLOAD_TOO_LARGE', 'The backup file is too large', 413);
    }
    if (!checked) {
      head = Buffer.concat([head, chunk]);
      if (head.length < BACKUP_MAGIC.length) continue;
      if (!head.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
        throw new DomainError('NOT_A_BACKUP', 'This file is not a backup archive', 422);
      }
      checked = true;
      yield head;
    } else {
      yield chunk;
    }
  }
  if (!checked) throw new DomainError('NOT_A_BACKUP', 'This file is not a backup archive', 422);
}

/**
 * POST – the raw file is the request body (streamed straight into the backups bucket, no
 * multipart parsing, no size buffering). The worker then validates it completely (decrypts every
 * chunk) before it appears in the list; invalid files are deleted again.
 */
export async function POST(request: Request) {
  return handle(
    async () => {
      assertSameOrigin(request);
      const session = await adminForApi(['SUPER_ADMIN']);
      if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
      if (!request.body) return apiError('EMPTY_BODY', 'No file received', 400);
      const maxBytes = (await getSetting(getCore(), 'backup')).maxUploadMb * 1024 * 1024;
      const declared = Number(request.headers.get('content-length') ?? 0);
      if (declared > maxBytes) {
        return apiError('UPLOAD_TOO_LARGE', 'The backup file is too large', 413);
      }
      const uploadId = newUploadId();
      const key = archiveKey(incomingDirectory(uploadId));
      const buckets = getBackupBuckets();
      await buckets.backups.putStream(
        key,
        requireBackupHeader(Readable.fromWeb(request.body as never), maxBytes),
      );
      const core = getCore();
      try {
        await requestImport(core, uploadId, session.userId);
      } catch (err) {
        await buckets.backups.delete(key).catch(() => undefined);
        throw err;
      }
      await audit(core.db, session, 'backup.upload', 'backup', uploadId);
      return Response.json({ uploadId }, { status: 202, headers: { 'cache-control': 'no-store' } });
    },
    { allowIncompleteRestore: true },
  );
}
