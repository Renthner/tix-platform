import 'server-only';
import { backupBucketsFromEnv, type BackupBuckets } from '@tix/core';
import { getEnv } from './env';

const globalForBackups = globalThis as typeof globalThis & { __tixBackupBuckets?: BackupBuckets };

/** Streaming S3 access to the assets, documents and backups buckets (web only reads / uploads / deletes). */
export function getBackupBuckets(): BackupBuckets {
  if (!globalForBackups.__tixBackupBuckets) {
    globalForBackups.__tixBackupBuckets = backupBucketsFromEnv(getEnv());
  }
  return globalForBackups.__tixBackupBuckets;
}
