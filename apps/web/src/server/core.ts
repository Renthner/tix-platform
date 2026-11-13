import 'server-only';
import {
  JobQueues,
  createCoreContext,
  objectStorageFromEnv,
  useConservativeSharp,
  type CoreContext,
} from '@tix/core';
import { createSecretBox, parseKeyRing } from '@tix/shared/server';
import { getDb } from './db';
import { getEnv } from './env';
import { logger } from './logger';
import { getRedis } from './redis';

const globalForCore = globalThis as typeof globalThis & { __tixCore?: CoreContext };

/** Process-wide domain context (DB pool, Redis engines, secrets). */
export function getCore(): CoreContext {
  if (!globalForCore.__tixCore) {
    // Upload normalisation runs in this process: keep sharp frugal (variants are made by the worker).
    useConservativeSharp();
    const env = getEnv();
    const { connections, keys } = getRedis();
    globalForCore.__tixCore = createCoreContext({
      db: getDb(),
      redis: connections.command,
      publisher: connections.publisher,
      keyPrefix: env.REDIS_KEY_PREFIX,
      sessionSecret: env.SESSION_SECRET,
      appUrl: env.APP_URL,
      secrets: createSecretBox(parseKeyRing(env.APP_ENCRYPTION_KEYS)),
      storage: objectStorageFromEnv(env),
      jobs: new JobQueues(connections.bullmq, keys.bullPrefix()),
      logger,
    });
  }
  return globalForCore.__tixCore;
}
