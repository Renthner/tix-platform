import { Redis, type RedisOptions } from 'ioredis';

/**
 * Connection roles. Each role gets a dedicated TCP connection because their semantics
 * are incompatible:
 *  - command:    regular commands + Lua scripts, auto-pipelined for high concurrency
 *  - publisher:  PUBLISH for real-time fan-out (seat deltas, queue updates)
 *  - subscriber: SUBSCRIBE mode (connection cannot issue other commands)
 *  - bullmq:     BullMQ queues/workers (requires maxRetriesPerRequest = null)
 */
export type RedisRole = 'command' | 'publisher' | 'subscriber' | 'bullmq';

export interface RedisLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const consoleLogger: RedisLogger = {
  info: (obj, msg) => console.info(msg ?? '', obj),
  warn: (obj, msg) => console.warn(msg ?? '', obj),
  error: (obj, msg) => console.error(msg ?? '', obj),
};

export interface CreateRedisOptions {
  /** Service name, reported via CLIENT SETNAME (`web:command`, `worker:bullmq` …). */
  serviceName: string;
  logger?: RedisLogger;
}

export function createRedis(url: string, role: RedisRole, opts: CreateRedisOptions): Redis {
  const logger = opts.logger ?? consoleLogger;
  const options: RedisOptions = {
    connectionName: `${opts.serviceName}:${role}`,
    // Commands fail fast during an outage (HTTP 503) instead of queueing unboundedly;
    // blocking/subscriber connections must retry forever.
    maxRetriesPerRequest: role === 'command' || role === 'publisher' ? 2 : null,
    enableAutoPipelining: role === 'command',
    enableReadyCheck: true,
    enableOfflineQueue: true,
    connectTimeout: 10_000,
    keepAlive: 30_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    // After a Sentinel/replica failover the old primary answers READONLY: reconnect + resend.
    reconnectOnError: (err) => (err.message.startsWith('READONLY') ? 2 : false),
  };

  const client = new Redis(url, options);
  client.on('error', (err: Error) => {
    logger.error({ err: err.message, role, connection: options.connectionName }, '[redis] error');
  });
  client.on('reconnecting', (delay: number) => {
    logger.warn({ delay, role, connection: options.connectionName }, '[redis] reconnecting');
  });
  return client;
}

/**
 * Lazily created, process-wide set of Redis connections. Call `close()` on shutdown so
 * in-flight commands are flushed (QUIT) before the process exits.
 */
export class RedisConnections {
  readonly #url: string;
  readonly #opts: CreateRedisOptions;
  readonly #clients = new Map<RedisRole, Redis>();

  constructor(url: string, opts: CreateRedisOptions) {
    this.#url = url;
    this.#opts = opts;
  }

  get(role: RedisRole): Redis {
    let client = this.#clients.get(role);
    if (!client) {
      client = createRedis(this.#url, role, this.#opts);
      this.#clients.set(role, client);
    }
    return client;
  }

  get command(): Redis {
    return this.get('command');
  }

  get publisher(): Redis {
    return this.get('publisher');
  }

  get subscriber(): Redis {
    return this.get('subscriber');
  }

  get bullmq(): Redis {
    return this.get('bullmq');
  }

  async close(): Promise<void> {
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.allSettled(
      clients.map(async (c) => {
        try {
          await c.quit();
        } catch {
          c.disconnect();
        }
      }),
    );
  }
}
