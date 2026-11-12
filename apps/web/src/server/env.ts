import 'server-only';
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
    S3_ENDPOINT: z.url(),
    S3_PUBLIC_URL: z.url().optional(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_BUCKET_ASSETS: z.string().min(3),
    S3_BUCKET_DOCUMENTS: z.string().min(3),
    S3_BUCKET_BACKUPS: z.string().min(3).default('tix-backups'),
    S3_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  })
  .refine(
    (e) => new Set([e.S3_BUCKET_ASSETS, e.S3_BUCKET_DOCUMENTS, e.S3_BUCKET_BACKUPS]).size === 3,
    {
      message:
        'S3_BUCKET_ASSETS, S3_BUCKET_DOCUMENTS and S3_BUCKET_BACKUPS must be three different buckets',
      path: ['S3_BUCKET_BACKUPS'],
    },
  );

export type ServerEnv = z.infer<typeof envSchema>;

let cached: ServerEnv | undefined;

/** Validated environment; throws a readable error listing every invalid variable. */
export function getEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid web environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
