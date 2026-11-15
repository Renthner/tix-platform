import 'server-only';
import { parseStorageEnv } from '@tix/core';
import { resolveSecretEnv } from '@tix/shared/server';
import { z } from 'zod';

/**
 * Infrastructure configuration from the environment. Business configuration (prices,
 * TTLs, templates, credentials …) is NOT read from env – it lives in the database and is
 * edited in the Admin Portal.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    APP_URL: z.url(),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(40),
    REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// URL'),
    REDIS_KEY_PREFIX: z
      .string()
      .regex(/^[a-z0-9_-]{1,32}$/)
      .default('tix'),
    /** Key ring for secrets at rest: `id:base64(32 bytes)[,id:base64…]`, first = active. */
    APP_ENCRYPTION_KEYS: z.string().min(1),
    /** HMAC key for signed cookies (QueuePassToken, cart session, admin CSRF). */
    SESSION_SECRET: z.string().min(32),
    /** Public URL of the realtime gateway; unset = same origin (/socket.io behind the proxy). */
    REALTIME_PUBLIC_URL: z.url().optional(),
    /** fs (default for new installations) or s3; unset = s3 when S3_ENDPOINT is set, else fs. */
    STORAGE_DRIVER: z.string().optional(),
    /** fs driver: storage directory (assets, documents, backups); default /data/storage. */
    STORAGE_DIR: z.string().optional(),
    // s3 driver only (validated together with the driver by parseStorageEnv below).
    S3_ENDPOINT: z.string().optional(),
    S3_PUBLIC_URL: z.url().optional(),
    S3_REGION: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_BUCKET_ASSETS: z.string().optional(),
    S3_BUCKET_DOCUMENTS: z.string().optional(),
    S3_BUCKET_BACKUPS: z.string().optional(),
    S3_FORCE_PATH_STYLE: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    const storage = parseStorageEnv(env);
    if (storage.ok) return;
    for (const issue of storage.issues) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: [issue.path] });
    }
  });

export type ServerEnv = z.infer<typeof envSchema>;

/** S3 credentials may come from files (S3_*_FILE, mounted secrets of the S3 service). */
function resolveStorageSecrets(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  try {
    return resolveSecretEnv(['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'], source);
  } catch (error) {
    throw new Error(`Invalid web environment:
  - ${error instanceof Error ? error.message : error}`);
  }
}

let cached: ServerEnv | undefined;

/** Validated environment; throws a readable error listing every invalid variable. */
export function getEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(resolveStorageSecrets(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid web environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
