import { createServer, type Server } from 'node:http';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PG_BINARIES,
  JobQueues,
  backupBucketsFromEnv,
  createCoreContext,
  getRestoreIncomplete,
  objectStorageFromEnv,
  type BackupRuntime,
} from '@tix/core';
import { createDb, loadRootEnv, pingDb } from '@tix/db';
import {
  RedisConnections,
  createKeyspace,
  inspectRedisConfig,
  pingRedis,
  removeWorkerHeartbeat,
  writeWorkerHeartbeat,
} from '@tix/redis';
import { APP_VERSION } from '@tix/shared';
import { createSecretBox, parseKeyRing } from '@tix/shared/server';
import { resolve } from 'node:path';
import { Queue, Worker } from 'bullmq';
import { loadEnv } from './env';
import { createLogger } from './logger';
import { startLoops } from './loops';
import { warnOnPgToolMismatch } from './processors/backups';
import { processorRegistrations } from './processors';

const VERSION = process.env.APP_VERSION ?? '0.1.0';

async function main(): Promise<void> {
  loadRootEnv();
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();

  // Fail fast on a broken key ring – bank / PayPal / SMTP credentials are decrypted here.
  const secrets = createSecretBox(parseKeyRing(env.APP_ENCRYPTION_KEYS));

  const dbHandle = createDb({
    connectionString: env.DATABASE_URL,
    poolMax: env.DATABASE_POOL_MAX,
    applicationName: `worker:${workerId}`,
    onPoolError: (err) => logger.error({ err }, 'postgres pool error'),
  });
  const redis = new RedisConnections(env.REDIS_URL, { serviceName: 'worker', logger });
  const keys = createKeyspace(env.REDIS_KEY_PREFIX);

  const dbLatency = await pingDb(dbHandle.pool);
  const redisLatency = await pingRedis(redis.command);
  const redisConfig = await inspectRedisConfig(redis.command);
  for (const warning of redisConfig.warnings) logger.warn({ warning }, 'redis configuration');
  logger.info({ workerId, dbLatency, redisLatency }, 'dependencies reachable');

  // ── Seat-lock sweeper + waiting-room ticker (leader-elected) ──────────────
  const jobs = new JobQueues(redis.bullmq, keys.bullPrefix());
  const core = createCoreContext({
    db: dbHandle.db,
    redis: redis.command,
    publisher: redis.publisher,
    keyPrefix: env.REDIS_KEY_PREFIX,
    sessionSecret: env.SESSION_SECRET,
    appUrl: env.APP_URL,
    secrets,
    storage: objectStorageFromEnv(env),
    jobs,
    logger,
  });
  const loops = startLoops(core, workerId, logger);

  // ── Queues & processors ───────────────────────────────────────────────────
  const bullPrefix = keys.bullPrefix();
  const backups: BackupRuntime = {
    ctx: core,
    buckets: backupBucketsFromEnv(env),
    keyRing: parseKeyRing(env.APP_ENCRYPTION_KEYS),
    databaseUrl: env.DATABASE_URL,
    migrationsDir: env.MIGRATIONS_DIR ?? resolve(process.cwd(), '../../packages/db/migrations'),
    appVersion: VERSION,
    pg: DEFAULT_PG_BINARIES,
    logger,
  };
  // A restore that replaced the database but did not finish keeps the system in maintenance mode.
  const incomplete = await getRestoreIncomplete(core).catch(() => null);
  if (incomplete) {
    logger.error(
      { backupId: incomplete.backupId, step: incomplete.step },
      'RESTORE INCOMPLETE: maintenance mode stays on until the restore is run again (Admin > Backups)',
    );
  }
  const serverVersion = await dbHandle.pool.query<{ v: string }>('SHOW server_version_num');
  await warnOnPgToolMismatch(backups, Number(serverVersion.rows[0]?.v ?? 0), logger).catch((err) =>
    logger.warn({ err }, 'could not check the PostgreSQL client tools'),
  );
  const registrations = processorRegistrations({ core, db: dbHandle.db, logger, backups });
  const schedulerQueues: Queue[] = [];
  for (const registration of registrations) {
    if (!registration.schedulers?.length) continue;
    const queue = new Queue(registration.queue, { connection: redis.bullmq, prefix: bullPrefix });
    for (const scheduler of registration.schedulers) {
      await queue.upsertJobScheduler(
        scheduler.name,
        { every: scheduler.everyMs },
        { name: scheduler.name, data: scheduler.data ?? {} },
      );
    }
    schedulerQueues.push(queue);
  }
  const workers: Worker[] = registrations.map(
    (registration) =>
      new Worker(registration.queue, registration.processor, {
        connection: redis.bullmq,
        prefix: bullPrefix,
        concurrency: registration.concurrency,
      }),
  );
  for (const w of workers) {
    w.on('failed', (job, err) =>
      logger.error({ queue: w.name, job: job?.name, jobId: job?.id, err }, 'job failed'),
    );
    w.on('error', (err) => logger.error({ queue: w.name, err }, 'worker error'));
  }

  // ── Heartbeat (consumed by web /api/health and the admin telemetry) ───────
  let lastBeatOk = 0;
  const beat = async () => {
    try {
      await writeWorkerHeartbeat(
        redis.command,
        keys,
        {
          workerId,
          hostname: hostname(),
          pid: process.pid,
          version: VERSION,
          startedAt,
          lastBeatAt: new Date().toISOString(),
          queues: workers.map((w) => w.name),
        },
        env.WORKER_HEARTBEAT_SECONDS * 3,
      );
      lastBeatOk = Date.now();
    } catch (err) {
      logger.warn({ err }, 'heartbeat failed');
    }
  };
  await beat();
  const heartbeatTimer = setInterval(beat, env.WORKER_HEARTBEAT_SECONDS * 1000);

  // ── Container health endpoint ─────────────────────────────────────────────
  const healthServer: Server = createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    const healthy =
      Date.now() - lastBeatOk < env.WORKER_HEARTBEAT_SECONDS * 3 * 1000 &&
      workers.every((w) => w.isRunning());
    res
      .writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' })
      .end(JSON.stringify({ status: healthy ? 'ok' : 'unhealthy', workerId }));
  });
  healthServer.listen(env.WORKER_HEALTH_PORT, '0.0.0.0');

  logger.info(
    { version: APP_VERSION, workerId, queues: workers.map((w) => w.name) },
    'worker started',
  );

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down – waiting for active jobs');
    const force = setTimeout(() => {
      logger.error('shutdown timeout exceeded – forcing exit');
      process.exit(1);
    }, env.WORKER_SHUTDOWN_TIMEOUT_MS);
    force.unref();

    clearInterval(heartbeatTimer);
    healthServer.close();
    await loops.stop();
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.all(schedulerQueues.map((q) => q.close()));
    await jobs.close();
    await removeWorkerHeartbeat(redis.command, keys, workerId).catch(() => {});
    await redis.close();
    await dbHandle.close();
    logger.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[worker] fatal startup error', err);
  process.exit(1);
});
