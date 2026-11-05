import type { Database } from '@tix/db';
import {
  QueueEngine,
  SeatLockEngine,
  createChannels,
  createKeyspace,
  type Channels,
  type Keyspace,
  type Redis,
} from '@tix/redis';

/**
 * Everything a domain service needs. Created once per process (web, worker, realtime)
 * and passed explicitly – no hidden singletons inside the core package.
 */
export interface CoreContext {
  db: Database;
  /** Command connection (auto-pipelined). */
  redis: Redis;
  /** Dedicated publisher connection for pub/sub fan-out. */
  publisher: Redis;
  keys: Keyspace;
  channels: Channels;
  seats: SeatLockEngine;
  queue: QueueEngine;
  /** HMAC secret for signed cookies / tokens. */
  sessionSecret: string;
}

export function createCoreContext(params: {
  db: Database;
  redis: Redis;
  publisher: Redis;
  keyPrefix: string;
  sessionSecret: string;
}): CoreContext {
  const keys = createKeyspace(params.keyPrefix);
  return {
    db: params.db,
    redis: params.redis,
    publisher: params.publisher,
    keys,
    channels: createChannels(params.keyPrefix),
    seats: new SeatLockEngine(params.redis, keys),
    queue: new QueueEngine(params.redis, keys),
    sessionSecret: params.sessionSecret,
  };
}

/** Domain error with a stable machine-readable code (mapped to HTTP status by the web app). */
export class DomainError extends Error {
  override name = 'DomainError';
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
