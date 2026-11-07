import type { Database } from '@tix/db';
import type { SecretBox } from '@tix/shared/server';
import type { JobQueues } from './job-queues';
import type { ObjectStorage } from './storage';
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
  /** Public base URL of the shop (links in e-mails, PayPal return URLs). Web + worker only. */
  appUrl?: string;
  /** Encryption of stored credentials (bank, PayPal, SMTP). Web + worker only. */
  secrets?: SecretBox;
  /** S3-compatible object storage (documents, statement files). Web + worker only. */
  storage?: ObjectStorage;
  /** BullMQ producers. Web + worker only. */
  jobs?: JobQueues;
}

type Capability = 'appUrl' | 'secrets' | 'storage' | 'jobs';

/** A context capability that the calling process must provide (web / worker). */
export function requireCapability<K extends Capability>(
  ctx: CoreContext,
  key: K,
): NonNullable<CoreContext[K]> {
  const value = ctx[key];
  if (value === undefined || value === null) {
    throw new Error(`Core context capability "${key}" is not configured in this process`);
  }
  return value as NonNullable<CoreContext[K]>;
}

export function createCoreContext(params: {
  db: Database;
  redis: Redis;
  publisher: Redis;
  keyPrefix: string;
  sessionSecret: string;
  appUrl?: string;
  secrets?: SecretBox;
  storage?: ObjectStorage;
  jobs?: JobQueues;
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
    appUrl: params.appUrl?.replace(/\/+$/, ''),
    secrets: params.secrets,
    storage: params.storage,
    jobs: params.jobs,
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
