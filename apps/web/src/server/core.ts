import 'server-only';
import {
  JobQueues,
  createCoreContext,
  getSetting,
  objectStorageFromEnv,
  startShopCacheSync,
  useConservativeSharp,
  type CoreContext,
} from '@tix/core';
import { createSecretBox, parseKeyRing } from '@tix/shared/server';
import { getDb } from './db';
import { applyDefaultLocale } from './default-locale';
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
    const core = globalForCore.__tixCore;
    // Cross-instance invalidation of the shop data cache and the settings cache (Redis pub/sub,
    // non-blocking: until the subscription is confirmed entries live only seconds).
    startShopCacheSync(core, connections.subscriber, {
      // The URL prefix rules of the proxy follow the default locale live on every instance.
      onSettingChanged: (key) => {
        if (key !== undefined && key !== 'general') return;
        void getSetting(core, 'general')
          .then((general) => applyDefaultLocale(general.defaultLocale))
          .catch(() => undefined);
      },
    });
  }
  return globalForCore.__tixCore;
}
