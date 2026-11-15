import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StorageEnv } from '../../src/storage-config';

/** The root `.env` targets the running stack: S3 is only used with TEST_S3_OPT_IN=1. */
export const s3OptIn = process.env.TEST_S3_OPT_IN === '1' && !!process.env.S3_ENDPOINT;

/**
 * Storage environment for integration tests: the S3 service of the dev stack on explicit opt-in,
 * otherwise a throwaway directory (filesystem driver, removed when the process exits). Running a
 * suite with and without TEST_S3_OPT_IN exercises both drivers.
 */
export function testStorageEnv(): StorageEnv {
  if (s3OptIn) return { ...process.env, STORAGE_DRIVER: 's3' } as StorageEnv;
  const dir = mkdtempSync(join(tmpdir(), 'tix-test-storage-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return { STORAGE_DRIVER: 'fs', STORAGE_DIR: dir };
}
