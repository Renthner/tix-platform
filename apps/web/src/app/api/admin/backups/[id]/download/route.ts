import { Readable } from 'node:stream';
import { archiveKey, findBackup } from '@tix/core';
import { audit } from '@/server/admin/audit';
import { adminForApi } from '@/server/auth';
import { getBackupBuckets } from '@/server/backups';
import { getCore } from '@/server/core';
import { apiError, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET – streams the encrypted archive (never buffered in memory). SUPER_ADMIN only. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(
    async () => {
      const session = await adminForApi(['SUPER_ADMIN']);
      if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
      const id = uuidParam.parse((await params).id);
      const buckets = getBackupBuckets();
      const entry = await findBackup(buckets.backups, id);
      if (!entry) return apiError('NOT_FOUND', 'Backup not found', 404);
      const object = await buckets.backups.getStream(archiveKey(entry.directory));
      await audit(getCore().db, session, 'backup.download', 'backup', id);
      const stamp = entry.manifest.createdAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      return new Response(Readable.toWeb(Readable.from(object.stream)) as ReadableStream, {
        headers: {
          'content-type': 'application/octet-stream',
          ...(object.size > 0 ? { 'content-length': String(object.size) } : {}),
          'content-disposition': `attachment; filename="tix-backup-${stamp}-${entry.manifest.kind}.tixbak"`,
          'cache-control': 'private, no-store',
        },
      });
    },
    { allowIncompleteRestore: true },
  );
}
