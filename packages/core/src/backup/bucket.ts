export interface BackupObjectInfo {
  key: string;
  size: number;
  lastModified: Date | undefined;
}

/**
 * One bucket-like key space as used by backups, restore, verification and the pre-update backup.
 * Implemented by `S3Bucket` (any S3-compatible service, also the external target) and `FsBucket`
 * (a directory on a mounted volume). Keys use `/` as separator and no leading slash.
 */
export interface BackupBucket {
  /** Bucket name (S3) or directory name (filesystem); for messages only. */
  readonly bucket: string;
  /** Absolute directory of a filesystem bucket (undefined for S3). */
  readonly localPath?: string;
  /** All objects whose key starts with `prefix` (plain string prefix, ascending key order). */
  list(prefix: string): AsyncIterable<BackupObjectInfo>;
  /** Immediate "sub-directories" below `prefix` (each returned entry ends with `/`). */
  listDirectories(prefix: string): Promise<string[]>;
  getStream(
    key: string,
  ): Promise<{ stream: AsyncIterable<Uint8Array>; size: number; contentType?: string }>;
  getBytes(key: string): Promise<Buffer>;
  /** Bytes of an object or null when it does not exist. */
  tryGetBytes(key: string): Promise<Buffer | null>;
  putBytes(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  deleteMany(keys: readonly string[]): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  /** Streams `source` into the object (bounded memory); returns size and SHA-256 of the content. */
  putStream(
    key: string,
    source: AsyncIterable<Uint8Array>,
    contentType?: string,
  ): Promise<{ sizeBytes: number; sha256: string }>;
  /** Connectivity + permission check: write, read back and delete a small probe object. */
  checkAccess(probeKey: string): Promise<void>;
  destroy(): void;
}

/** The three local buckets used by backups. */
export interface BackupBuckets {
  assets: BackupBucket;
  documents: BackupBucket;
  backups: BackupBucket;
}
