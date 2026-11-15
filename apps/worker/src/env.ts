import { parseStorageEnv } from '@tix/core';
import { resolveSecretEnv } from '@tix/shared/server';
import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// URL'),
    REDIS_KEY_PREFIX: z
      .string()
      .regex(/^[a-z0-9_-]{1,32}$/)
      .default('tix'),
    /** Public shop URL (links in e-mails). */
    APP_URL: z.url(),
    APP_ENCRYPTION_KEYS: z.string().min(1),
    /** fs (default for new installations) or s3; unset = s3 when S3_ENDPOINT is set, else fs. */
    STORAGE_DRIVER: z.string().optional(),
    /** fs driver: storage directory (assets, documents, backups); default /data/storage. */
    STORAGE_DIR: z.string().optional(),
    // s3 driver only (validated together with the driver by parseStorageEnv below).
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_BUCKET_ASSETS: z.string().optional(),
    S3_BUCKET_DOCUMENTS: z.string().optional(),
    S3_BUCKET_BACKUPS: z.string().optional(),
    /** SQL migrations + journal (backups record / compare the migration level). */
    MIGRATIONS_DIR: z.string().optional(),
    S3_FORCE_PATH_STYLE: z.string().optional(),
    SESSION_SECRET: z.string().min(32),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(8),
    WORKER_HEARTBEAT_SECONDS: z.coerce.number().int().min(2).max(300).default(10),
    WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8081),
    /** Bind address of the health endpoint; the single-image supervisor sets 127.0.0.1. */
    WORKER_HEALTH_HOST: z.string().min(1).default('0.0.0.0'),
    WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  })
  .superRefine((env, ctx) => {
    const storage = parseStorageEnv(env);
    if (storage.ok) return;
    for (const issue of storage.issues) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: [issue.path] });
    }
  });

export type WorkerEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  let resolved: NodeJS.ProcessEnv;
  try {
    // S3 credentials may come from files (S3_*_FILE, mounted secrets of the S3 service).
    resolved = resolveSecretEnv(['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'], source);
  } catch (error) {
    throw new Error(`Invalid worker environment:
  - ${error instanceof Error ? error.message : error}`);
  }
  const parsed = envSchema.safeParse(resolved);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid worker environment:\n${issues}`);
  }
  return parsed.data;
}
