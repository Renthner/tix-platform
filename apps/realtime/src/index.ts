import { createServer } from 'node:http';
import {
  PresenceTracker,
  RedisConnections,
  QueueEngine,
  createChannels,
  createKeyspace,
} from '@tix/redis';
import type { SeatDeltaMessage, SeatDeltaStatus } from '@tix/shared';
import { verifyToken } from '@tix/shared/server';
import { pino } from 'pino';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';

/**
 * Realtime gateway (Socket.io).
 *
 * Producers (web, worker) publish JSON messages to Redis Pub/Sub; every gateway instance
 * pattern-subscribes and delivers them to its *local* sockets. Seat deltas are coalesced
 * per event for SEAT_BATCH_MS so a burst of 1,000 clicks becomes a handful of frames per
 * client instead of 1,000. Instances are stateless → scale horizontally behind the proxy.
 */

const env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    REDIS_URL: z.string().regex(/^rediss?:\/\//),
    REDIS_KEY_PREFIX: z
      .string()
      .regex(/^[a-z0-9_-]{1,32}$/)
      .default('tix'),
    SESSION_SECRET: z.string().min(32),
    APP_URL: z.url(),
    REALTIME_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    REALTIME_CORS_ORIGINS: z.string().optional(),
    SEAT_BATCH_MS: z.coerce.number().int().min(10).max(2_000).default(100),
  })
  .parse(process.env);

const logger = pino({ level: env.LOG_LEVEL, base: { service: 'realtime' } });
const keys = createKeyspace(env.REDIS_KEY_PREFIX);
const channels = createChannels(env.REDIS_KEY_PREFIX);
const redis = new RedisConnections(env.REDIS_URL, { serviceName: 'realtime', logger });
const queue = new QueueEngine(redis.command, keys);
const presence = new PresenceTracker(redis.command, keys);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EVENT_ROOMS = 8;
const PING_INTERVAL_MS = 10_000;
/** Shop clients send a presence heartbeat about every 15 s; faster beats are ignored. */
const PRESENCE_MIN_INTERVAL_MS = 5_000;

/**
 * Per-event presence only counts events whose inventory exists in Redis (= events that were put
 * on sale): random UUIDs from a client cannot grow the presence sets. Answers are cached briefly.
 */
const KNOWN_EVENT_TTL_MS = 30_000;
const UNKNOWN_EVENT_TTL_MS = 5_000;
const KNOWN_EVENT_CACHE_MAX = 2_000;
const knownEvents = new Map<string, { known: boolean; until: number }>();
async function isShopEvent(eventId: string): Promise<boolean> {
  const now = Date.now();
  const cached = knownEvents.get(eventId);
  if (cached && cached.until > now) return cached.known;
  const known = (await redis.command.exists(keys.inventoryReady(eventId))) === 1;
  if (knownEvents.size >= KNOWN_EVENT_CACHE_MAX) knownEvents.clear();
  knownEvents.set(eventId, {
    known,
    until: now + (known ? KNOWN_EVENT_TTL_MS : UNKNOWN_EVENT_TTL_MS),
  });
  return known;
}

const origins = (env.REALTIME_CORS_ORIGINS ?? env.APP_URL)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const http = createServer((req, res) => {
  if (req.url === '/healthz') {
    const ok = redis.command.status === 'ready' && redis.subscriber.status === 'ready';
    res
      .writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
      .end(JSON.stringify({ status: ok ? 'ok' : 'unhealthy' }));
    return;
  }
  res.writeHead(404).end();
});

const io = new Server(http, {
  path: '/socket.io',
  cors: { origin: origins, credentials: true },
  transports: ['websocket', 'polling'],
  pingInterval: 25_000,
  pingTimeout: 20_000,
  maxHttpBufferSize: 16 * 1024,
  serveClient: false,
});

interface SocketData {
  sid: string;
  rooms: Set<string>;
  lastPing: Map<string, number>;
  /** Events the socket reported presence for (removed again on disconnect). */
  presenceEvents: Set<string>;
  lastPresence: Map<string, number>;
}

// Maintenance (backup restore): no new subscriptions while the database is being replaced.
let maintenanceCache = { at: 0, active: false };
io.use(async (_socket, next) => {
  if (Date.now() - maintenanceCache.at > 1_500) {
    const active = await redis.command
      .exists(keys.maintenance(), keys.restoreIncomplete())
      .catch(() => 0);
    maintenanceCache = { at: Date.now(), active: active > 0 };
  }
  next(maintenanceCache.active ? new Error('maintenance') : undefined);
});

io.use((socket, next) => {
  const token = (socket.handshake.auth as { token?: unknown }).token;
  const claims = verifyToken<{ sid: string }>(
    typeof token === 'string' ? token : null,
    'rt',
    env.SESSION_SECRET,
  );
  if (!claims || typeof claims.sid !== 'string') return next(new Error('unauthorized'));
  const data: SocketData = {
    sid: claims.sid,
    rooms: new Set(),
    lastPing: new Map(),
    presenceEvents: new Set(),
    lastPresence: new Map(),
  };
  socket.data = data;
  next();
});

function eventRoomJoin(socket: Socket, prefix: 'seats' | 'queue', eventId: unknown): void {
  if (typeof eventId !== 'string' || !UUID.test(eventId)) return;
  const data = socket.data as SocketData;
  const room = `${prefix}:${eventId}`;
  if (!data.rooms.has(room) && data.rooms.size >= MAX_EVENT_ROOMS) return;
  data.rooms.add(room);
  void socket.join(room);
}

io.on('connection', (socket) => {
  const data = socket.data as SocketData;
  void socket.join(`sid:${data.sid}`);

  socket.on('seats:subscribe', (eventId: unknown) => eventRoomJoin(socket, 'seats', eventId));
  socket.on('queue:subscribe', (eventId: unknown) => eventRoomJoin(socket, 'queue', eventId));
  socket.on('unsubscribe', (eventId: unknown) => {
    if (typeof eventId !== 'string') return;
    for (const prefix of ['seats', 'queue']) {
      const room = `${prefix}:${eventId}`;
      data.rooms.delete(room);
      void socket.leave(room);
    }
  });
  // Shop presence for the dashboard ("im Shop"): connect/join + heartbeat every ~15 s. Sent by shop
  // pages only (admin sockets never emit it) and independent of the waiting-room counter below.
  socket.on('presence:beat', (eventId: unknown) => {
    if (typeof eventId !== 'string' || !UUID.test(eventId)) return;
    const now = Date.now();
    if (now - (data.lastPresence.get(eventId) ?? 0) < PRESENCE_MIN_INTERVAL_MS) return;
    if (!data.presenceEvents.has(eventId) && data.presenceEvents.size >= MAX_EVENT_ROOMS) return;
    data.lastPresence.set(eventId, now);
    isShopEvent(eventId)
      .then((known) => {
        if (!known) return;
        data.presenceEvents.add(eventId);
        return presence.touch(data.sid, [eventId], now);
      })
      .catch((err: unknown) => logger.warn({ err }, 'presence beat failed'));
  });
  socket.on('disconnect', () => {
    if (data.presenceEvents.size === 0) return;
    // Another tab of the same shopper on this instance keeps the shop-wide entry alive.
    const stillHere = (io.sockets.adapter.rooms.get(`sid:${data.sid}`)?.size ?? 0) > 0;
    presence
      .remove(data.sid, [...data.presenceEvents], !stillHere)
      .catch((err: unknown) => logger.warn({ err }, 'presence remove failed'));
  });
  // Shoppers holding a pass report activity → counted against the waiting-room threshold.
  socket.on('shop:ping', (eventId: unknown) => {
    if (typeof eventId !== 'string' || !UUID.test(eventId)) return;
    const now = Date.now();
    if (now - (data.lastPing.get(eventId) ?? 0) < PING_INTERVAL_MS) return;
    data.lastPing.set(eventId, now);
    queue.ping(eventId, data.sid).catch((err: unknown) => logger.warn({ err }, 'ping failed'));
  });
});

// ── Redis → sockets ────────────────────────────────────────────────────────
interface PendingDelta {
  seats: Map<string, SeatDeltaStatus>;
  ga: Record<string, number>;
  version?: number;
}
const pending = new Map<string, PendingDelta>();

function eventIdFromChannel(channel: string): string | null {
  const match = /:ch:ev:([^:]+):/.exec(channel);
  return match?.[1] ?? null;
}

function queueSeatDelta(message: SeatDeltaMessage): void {
  let entry = pending.get(message.eventId);
  if (!entry) {
    entry = { seats: new Map(), ga: {} };
    pending.set(message.eventId, entry);
  }
  for (const [id, status] of message.seats) entry.seats.set(id, status);
  if (message.ga) Object.assign(entry.ga, message.ga);
  if (message.version !== undefined) entry.version = Math.max(entry.version ?? 0, message.version);
}

const flushTimer = setInterval(() => {
  for (const [eventId, entry] of pending) {
    const payload: SeatDeltaMessage = {
      eventId,
      seats: [...entry.seats.entries()],
      ...(Object.keys(entry.ga).length ? { ga: entry.ga } : {}),
      ...(entry.version !== undefined ? { version: entry.version } : {}),
    };
    io.to(`seats:${eventId}`).emit('seats:delta', payload);
  }
  pending.clear();
}, env.SEAT_BATCH_MS);

const subscriber = redis.subscriber;
subscriber.on('pmessage', (pattern: string, channel: string, raw: string) => {
  try {
    const message = JSON.parse(raw) as Record<string, unknown>;
    if (pattern === channels.patterns.seats) {
      queueSeatDelta(message as unknown as SeatDeltaMessage);
    } else if (pattern === channels.patterns.queue) {
      const eventId = eventIdFromChannel(channel);
      if (eventId) io.to(`queue:${eventId}`).emit('queue:update', message);
    } else if (pattern === channels.patterns.sessions) {
      const sid = channel.slice(channel.lastIndexOf(':') + 1);
      io.to(`sid:${sid}`).emit('session:message', message);
    }
  } catch (err) {
    logger.warn({ err, channel }, 'invalid pub/sub message');
  }
});

async function main(): Promise<void> {
  await subscriber.psubscribe(
    channels.patterns.seats,
    channels.patterns.queue,
    channels.patterns.sessions,
  );
  http.listen(env.REALTIME_PORT, '0.0.0.0', () => {
    logger.info({ port: env.REALTIME_PORT, origins }, 'realtime gateway listening');
  });
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  clearInterval(flushTimer);
  await new Promise<void>((resolve) => io.close(() => resolve()));
  await redis.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  logger.fatal({ err }, 'realtime gateway failed to start');
  process.exit(1);
});
