import 'server-only';
import { backupBucketsFromEnv, storageConfigFromEnv, type BackupBuckets } from '@tix/core';
import { getEnv } from './env';

const globalForBackups = globalThis as typeof globalThis & { __tixBackupBuckets?: BackupBuckets };

/** Streaming access to the assets, documents and backups buckets (S3 or storage directory); web only reads / uploads / deletes. */
export function getBackupBuckets(): BackupBuckets {
  if (!globalForBackups.__tixBackupBuckets) {
    globalForBackups.__tixBackupBuckets = backupBucketsFromEnv(getEnv());
  }
  return globalForBackups.__tixBackupBuckets;
}

/** Storage driver in use (never includes credentials). */
export function getStorageInfo(): { driver: 'fs' | 's3'; dir: string | null } {
  const config = storageConfigFromEnv(getEnv());
  return { driver: config.driver, dir: config.driver === 'fs' ? config.dir : null };
}
