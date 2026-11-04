import 'server-only';
import {
  RedisConnections,
  createChannels,
  createKeyspace,
  type Channels,
  type Keyspace,
} from '@tix/redis';
import { getEnv } from './env';

interface RedisContext {
  connections: RedisConnections;
  keys: Keyspace;
  channels: Channels;
}

const globalForRedis = globalThis as typeof globalThis & { __tixRedis?: RedisContext };

/** Process-wide Redis connections + key schema (lazy, HMR-safe). */
export function getRedis(): RedisContext {
  if (!globalForRedis.__tixRedis) {
    const env = getEnv();
    globalForRedis.__tixRedis = {
      connections: new RedisConnections(env.REDIS_URL, { serviceName: 'web' }),
      keys: createKeyspace(env.REDIS_KEY_PREFIX),
      channels: createChannels(env.REDIS_KEY_PREFIX),
    };
  }
  return globalForRedis.__tixRedis;
}
