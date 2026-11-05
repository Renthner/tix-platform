import 'server-only';
import { createCoreContext, type CoreContext } from '@tix/core';
import { getDb } from './db';
import { getEnv } from './env';
import { getRedis } from './redis';

const globalForCore = globalThis as typeof globalThis & { __tixCore?: CoreContext };

/** Process-wide domain context (DB pool, Redis engines, secrets). */
export function getCore(): CoreContext {
  if (!globalForCore.__tixCore) {
    const env = getEnv();
    const { connections } = getRedis();
    globalForCore.__tixCore = createCoreContext({
      db: getDb(),
      redis: connections.command,
      publisher: connections.publisher,
      keyPrefix: env.REDIS_KEY_PREFIX,
      sessionSecret: env.SESSION_SECRET,
    });
  }
  return globalForCore.__tixCore;
}
