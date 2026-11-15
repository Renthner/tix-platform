import { join, resolve } from 'node:path';
import type { BackupBuckets } from './backup/bucket';
import { S3Bucket } from './backup/s3';
import { S3ObjectStorage, type ObjectStorage } from './storage';
import {
  FsBucket,
  FsObjectStorage,
  InvalidStorageKeyError,
  validateStorageKey,
} from './storage-fs';

/**
 * Storage configuration from the environment (one parser for web, worker and the migrate service).
 *
 *   STORAGE_DRIVER   fs | s3. Default: s3 when S3_ENDPOINT is set (existing installations keep
 *                    working unchanged), otherwise fs.
 *   STORAGE_DIR      fs only: storage directory (default /data/storage) with the sub-directories
 *                    assets, documents and backups. Must be a persistent volume.
 *   S3_*             s3 only: S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET_ASSETS,
 *                    S3_BUCKET_DOCUMENTS (required), S3_BUCKET_BACKUPS (default tix-backups),
 *                    S3_REGION (default us-east-1), S3_FORCE_PATH_STYLE (default true).
 * Empty values count as unset (compose `${VAR:-}`).
 */
export const DEFAULT_STORAGE_DIR = '/data/storage';

export interface StorageEnv {
  STORAGE_DRIVER?: string | undefined;
  STORAGE_DIR?: string | undefined;
  S3_ENDPOINT?: string | undefined;
  S3_REGION?: string | undefined;
  S3_ACCESS_KEY_ID?: string | undefined;
  S3_SECRET_ACCESS_KEY?: string | undefined;
  S3_BUCKET_ASSETS?: string | undefined;
  S3_BUCKET_DOCUMENTS?: string | undefined;
  S3_BUCKET_BACKUPS?: string | undefined;
  S3_FORCE_PATH_STYLE?: string | boolean | undefined;
}

export type StorageConfig =
  | { driver: 'fs'; dir: string }
  | {
      driver: 's3';
      endpoint: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
      buckets: { assets: string; documents: string; backups: string };
    };

export interface StorageEnvIssue {
  path: string;
  message: string;
}

const text = (value: string | boolean | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

export function parseStorageEnv(
  env: StorageEnv,
): { ok: true; config: StorageConfig } | { ok: false; issues: StorageEnvIssue[] } {
  const issues: StorageEnvIssue[] = [];
  const endpoint = text(env.S3_ENDPOINT);
  const requested = text(env.STORAGE_DRIVER)?.toLowerCase();
  if (requested !== undefined && requested !== 'fs' && requested !== 's3') {
    return {
      ok: false,
      issues: [{ path: 'STORAGE_DRIVER', message: 'must be "fs" or "s3"' }],
    };
  }
  const driver = (requested ?? (endpoint ? 's3' : 'fs')) as 'fs' | 's3';
  if (driver === 'fs') {
    return {
      ok: true,
      config: { driver: 'fs', dir: resolve(text(env.STORAGE_DIR) ?? DEFAULT_STORAGE_DIR) },
    };
  }
  if (!endpoint) {
    issues.push({ path: 'S3_ENDPOINT', message: 'required when STORAGE_DRIVER=s3' });
  } else {
    try {
      new URL(endpoint);
    } catch {
      issues.push({ path: 'S3_ENDPOINT', message: 'must be a URL' });
    }
  }
  const accessKeyId = text(env.S3_ACCESS_KEY_ID);
  const secretAccessKey = text(env.S3_SECRET_ACCESS_KEY);
  const assets = text(env.S3_BUCKET_ASSETS);
  const documents = text(env.S3_BUCKET_DOCUMENTS);
  const backups = text(env.S3_BUCKET_BACKUPS) ?? 'tix-backups';
  if (!accessKeyId)
    issues.push({ path: 'S3_ACCESS_KEY_ID', message: 'required for the s3 driver' });
  if (!secretAccessKey) {
    issues.push({ path: 'S3_SECRET_ACCESS_KEY', message: 'required for the s3 driver' });
  }
  for (const [name, value] of [
    ['S3_BUCKET_ASSETS', assets],
    ['S3_BUCKET_DOCUMENTS', documents],
    ['S3_BUCKET_BACKUPS', backups],
  ] as const) {
    if (!value || value.length < 3) {
      issues.push({ path: name, message: 'required (at least 3 characters) for the s3 driver' });
    }
  }
  if (assets && documents && new Set([assets, documents, backups]).size !== 3) {
    issues.push({
      path: 'S3_BUCKET_BACKUPS',
      message:
        'S3_BUCKET_ASSETS, S3_BUCKET_DOCUMENTS and S3_BUCKET_BACKUPS must be three different buckets',
    });
  }
  const style = env.S3_FORCE_PATH_STYLE;
  const styleText = typeof style === 'boolean' ? String(style) : (text(style) ?? 'true');
  if (styleText !== 'true' && styleText !== 'false') {
    issues.push({ path: 'S3_FORCE_PATH_STYLE', message: 'must be "true" or "false"' });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    config: {
      driver: 's3',
      endpoint: endpoint!,
      region: text(env.S3_REGION) ?? 'us-east-1',
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      forcePathStyle: styleText === 'true',
      buckets: { assets: assets!, documents: documents!, backups },
    },
  };
}

/** Like {@link parseStorageEnv} but throws one readable error. */
export function storageConfigFromEnv(env: StorageEnv): StorageConfig {
  const parsed = parseStorageEnv(env);
  if (!parsed.ok) {
    throw new Error(
      `Invalid storage configuration:\n${parsed.issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')}`,
    );
  }
  return parsed.config;
}

export function createObjectStorage(config: StorageConfig): ObjectStorage {
  if (config.driver === 'fs') return new FsObjectStorage(config.dir);
  return new S3ObjectStorage({
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle,
    buckets: { assets: config.buckets.assets, documents: config.buckets.documents },
  });
}

export function createBackupBuckets(config: StorageConfig): BackupBuckets {
  if (config.driver === 'fs') {
    const make = (name: 'assets' | 'documents' | 'backups') =>
      new FsBucket({
        root: join(config.dir, name),
        metaRoot: join(config.dir, '.meta', name),
        tmpRoot: join(config.dir, '.tmp'),
      });
    return { assets: make('assets'), documents: make('documents'), backups: make('backups') };
  }
  const base = {
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle,
  };
  return {
    assets: new S3Bucket({ ...base, bucket: config.buckets.assets }),
    documents: new S3Bucket({ ...base, bucket: config.buckets.documents }),
    backups: new S3Bucket({ ...base, bucket: config.buckets.backups }),
  };
}

/** Application storage from the environment (driver chosen as described above). */
export function objectStorageFromEnv(env: StorageEnv): ObjectStorage {
  return createObjectStorage(storageConfigFromEnv(env));
}

/** Backup buckets from the environment. */
export function backupBucketsFromEnv(env: StorageEnv): BackupBuckets {
  return createBackupBuckets(storageConfigFromEnv(env));
}

/**
 * Copies every object of the application buckets from one storage to another (for example from
 * S3/MinIO to the filesystem driver). Skips objects that already exist with the same size. The
 * backups bucket is not copied (create a fresh backup in the target instead). Returns counters.
 */
export async function copyBuckets(
  from: Pick<BackupBuckets, 'assets' | 'documents'>,
  to: Pick<BackupBuckets, 'assets' | 'documents'>,
  onProgress?: (area: 'assets' | 'documents', key: string) => void,
): Promise<{
  copied: number;
  skipped: number;
  bytes: number;
  /** Objects not copied because the target (filesystem driver / restore) rejects their key. */
  rejected: { area: 'assets' | 'documents'; key: string }[];
}> {
  let copied = 0;
  let skipped = 0;
  let bytes = 0;
  const rejected: { area: 'assets' | 'documents'; key: string }[] = [];
  for (const area of ['assets', 'documents'] as const) {
    for await (const object of from[area].list('')) {
      try {
        validateStorageKey(object.key);
      } catch (err) {
        if (!(err instanceof InvalidStorageKeyError)) throw err;
        rejected.push({ area, key: object.key.slice(0, 300) });
        continue;
      }
      const existing = await to[area].tryGetBytes(object.key);
      if (existing && existing.length === object.size) {
        skipped += 1;
        continue;
      }
      const source = await from[area].getStream(object.key);
      const written = await to[area].putStream(
        object.key,
        source.stream,
        source.contentType ?? 'application/octet-stream',
      );
      copied += 1;
      bytes += written.sizeBytes;
      onProgress?.(area, object.key);
    }
  }
  return { copied, skipped, bytes, rejected };
}
