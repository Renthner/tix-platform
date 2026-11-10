import { createHash } from 'node:crypto';
import { collect, readArchive, type ReadArchiveEntry } from './archive';
import { BackupCryptoError, decryptStream, type BackupKey } from './crypto';
import {
  ARCHIVE_DUMP,
  ARCHIVE_FILES_PREFIX,
  ARCHIVE_MANIFEST,
  backupManifestSchema,
  type BackupManifest,
} from './manifest';

/** Object keys from an archive end up in S3: no traversal, no absolute keys, bounded length. */
export function assertSafeObjectKey(key: string): void {
  const bytes = Buffer.byteLength(key, 'utf8');
  if (
    key.length === 0 ||
    bytes > 1024 ||
    key.startsWith('/') ||
    key.includes('\0') ||
    key.split('/').some((part) => part === '..' || part === '.')
  ) {
    throw new BackupCryptoError('BAD_ARCHIVE', 'The archive contains an invalid file name');
  }
}

export interface ArchiveInspection {
  /** Manifest stored inside the archive. */
  manifest: BackupManifest;
  /** SHA-256 and size of the (encrypted) archive file as read. */
  sha256: string;
  sizeBytes: number;
  dumpBytes: number;
  files: {
    assets: { objects: number; bytes: number };
    documents: { objects: number; bytes: number };
  };
}

/** Passes the bytes through while hashing them. */
async function* measured(
  source: AsyncIterable<Uint8Array>,
  sink: { hash: ReturnType<typeof createHash>; bytes: number },
): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    sink.hash.update(chunk);
    sink.bytes += chunk.byteLength;
    yield chunk;
  }
}

/**
 * Reads the whole archive once: every chunk is authenticated (GCM), the structure is parsed,
 * counts and the checksum are computed. Nothing is written anywhere.
 */
export async function inspectArchive(
  source: AsyncIterable<Uint8Array>,
  ring: readonly BackupKey[],
): Promise<ArchiveInspection> {
  const sink = { hash: createHash('sha256'), bytes: 0 };
  let manifest: BackupManifest | null = null;
  let dumpBytes = 0;
  let sawDump = false;
  const files = {
    assets: { objects: 0, bytes: 0 },
    documents: { objects: 0, bytes: 0 },
  };
  for await (const entry of readArchive(decryptStream(measured(source, sink), ring))) {
    const { name } = entry.header;
    if (name === ARCHIVE_MANIFEST) {
      if (manifest) throw new BackupCryptoError('BAD_ARCHIVE', 'Duplicate manifest');
      const parsed = backupManifestSchema.safeParse(
        JSON.parse((await collect(entry.data)).toString('utf8')),
      );
      if (!parsed.success) throw new BackupCryptoError('BAD_ARCHIVE', 'Invalid manifest');
      manifest = parsed.data;
    } else if (!manifest) {
      throw new BackupCryptoError('BAD_ARCHIVE', 'The manifest must be the first entry');
    } else if (name === ARCHIVE_DUMP) {
      sawDump = true;
      for await (const chunk of entry.data) dumpBytes += chunk.length;
    } else if (name.startsWith(ARCHIVE_FILES_PREFIX)) {
      const area = name.slice(ARCHIVE_FILES_PREFIX.length).split('/', 1)[0];
      if (area !== 'assets' && area !== 'documents') {
        throw new BackupCryptoError('BAD_ARCHIVE', `Unknown file area in "${name}"`);
      }
      assertSafeObjectKey(name.slice(ARCHIVE_FILES_PREFIX.length + area.length + 1));
      files[area].objects += 1;
      for await (const chunk of entry.data) files[area].bytes += chunk.length;
    } else {
      throw new BackupCryptoError('BAD_ARCHIVE', `Unknown archive entry "${name}"`);
    }
  }
  if (!manifest) throw new BackupCryptoError('BAD_ARCHIVE', 'The archive has no manifest');
  if (!sawDump) throw new BackupCryptoError('BAD_ARCHIVE', 'The archive has no database dump');
  return {
    manifest,
    sha256: sink.hash.digest('hex'),
    sizeBytes: sink.bytes,
    dumpBytes,
    files,
  };
}

/** Streams only the database dump of an archive (stops reading after it). */
export async function* extractDump(
  source: AsyncIterable<Uint8Array>,
  ring: readonly BackupKey[],
): AsyncGenerator<Buffer> {
  for await (const entry of readArchive(decryptStream(source, ring))) {
    if (entry.header.name !== ARCHIVE_DUMP) continue;
    yield* entry.data;
    return;
  }
  throw new BackupCryptoError('BAD_ARCHIVE', 'The archive has no database dump');
}

export interface ArchivedFile {
  area: 'assets' | 'documents';
  key: string;
  entry: ReadArchiveEntry;
}

/** Streams the file entries (assets / documents) of an archive. */
export async function* archivedFiles(
  source: AsyncIterable<Uint8Array>,
  ring: readonly BackupKey[],
): AsyncGenerator<ArchivedFile> {
  for await (const entry of readArchive(decryptStream(source, ring))) {
    const { name } = entry.header;
    if (!name.startsWith(ARCHIVE_FILES_PREFIX)) continue;
    const rest = name.slice(ARCHIVE_FILES_PREFIX.length);
    const slash = rest.indexOf('/');
    const area = rest.slice(0, slash);
    if ((area !== 'assets' && area !== 'documents') || slash < 0) {
      throw new BackupCryptoError('BAD_ARCHIVE', `Unknown file area in "${name}"`);
    }
    const key = rest.slice(slash + 1);
    assertSafeObjectKey(key);
    yield { area, key, entry };
  }
}
