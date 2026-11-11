/**
 * Central Redis key schema. Every key the platform writes is built here – no ad-hoc
 * strings elsewhere – so the layout stays reviewable and collision-free.
 *
 * Cluster readiness: all keys of one event share the hash tag `{ev:<eventId>}` and
 * therefore the same slot. Lua scripts that atomically touch many seats of an event
 * (multi-seat lock, GA holds, queue admission) remain valid on Redis Cluster.
 *
 * The spec's seat lock `SET seat:{eventId}:{seatId} {sessionId} NX EX {ttl}` maps to
 * `seatLock(eventId, seatId)` = `<prefix>:{ev:<eventId>}:seat:<seatId>`.
 */

const SAFE_SEGMENT = /^[A-Za-z0-9_.:-]{1,128}$/;

function seg(value: string, name: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`Invalid Redis key segment for ${name}: "${value}"`);
  }
  return value;
}

export function createKeyspace(prefix: string) {
  seg(prefix, 'prefix');
  const ev = (eventId: string) => `${prefix}:{ev:${seg(eventId, 'eventId')}}`;
  const sid = (sessionId: string) => seg(sessionId, 'sessionId');

  return {
    prefix,

    // ── Multi-event cart ─────────────────────────────────────────────────
    /**
     * HASH cart state of one shopping session across ALL events: cart expiry, events in the
     * cart and the tariff (ticket type) chosen per seat / GA spot. Deliberately not
     * hash-tagged (spans events); the locks themselves live in the per-event keys below.
     */
    cart: (sessionId: string) => `${prefix}:cart:${sid(sessionId)}`,

    // ── Seat locking ─────────────────────────────────────────────────────
    /** STRING cartSessionId, PXAT = cart expiry (+ payment grace once checkout starts). */
    seatLock: (eventId: string, seatId: string) => `${ev(eventId)}:seat:${seg(seatId, 'seatId')}`,
    /** SET of seatIds currently locked by one cart session (bulk release / TTL extension). */
    cartSeats: (eventId: string, sessionId: string) =>
      `${ev(eventId)}:cart:${sid(sessionId)}:seats`,
    /** ZSET seatId → lock expiry (epoch ms); swept to broadcast releases on expiry. */
    seatLockExpiries: (eventId: string) => `${ev(eventId)}:seat:expiries`,
    /**
     * HASH seatId → S (sold) | R (reserved, payment pending) | B (blocked) | X (removed).
     * Mirror of the database inventory so the lock script can reject unavailable seats
     * atomically. Rebuilt from PostgreSQL whenever `inventoryReady` is missing.
     */
    seatsTaken: (eventId: string) => `${ev(eventId)}:seat:taken`,
    /** STRING seat map version the inventory mirror was built from. */
    inventoryReady: (eventId: string) => `${ev(eventId)}:inventory`,

    // ── General admission (standing) holds ───────────────────────────────
    /** HASH sectionId → spots still sellable per DB (capacity − allocated). */
    generalAdmissionAvailable: (eventId: string) => `${ev(eventId)}:ga:available`,
    /** HASH sectionId → spots currently held in carts (all sessions). */
    generalAdmissionHeld: (eventId: string) => `${ev(eventId)}:ga:held`,
    /** HASH sessionId → JSON {sectionId: count} held by that session. */
    generalAdmissionHolds: (eventId: string) => `${ev(eventId)}:ga:holds`,
    /** ZSET sessionId → hold expiry (epoch ms). */
    generalAdmissionExpiries: (eventId: string) => `${ev(eventId)}:ga:expiries`,

    /** STRING JSON of the public seat map, keyed by seat map version. */
    /** Public plan snapshot; `format` = PUBLIC_MAP_FORMAT so a deploy never serves old shapes. */
    seatMapSnapshot: (eventId: string, version: number, format: number) =>
      `${ev(eventId)}:seatmap:f${format}:v${version}`,
    /** SET of eventIds that may hold locks / GA holds (iterated by the expiry sweeper). */
    activeLockEvents: () => `${prefix}:locks:events`,

    // ── Virtual waiting room ─────────────────────────────────────────────
    /** ZSET sessionId → queue number (admission order). */
    queueWaiting: (eventId: string) => `${ev(eventId)}:queue:waiting`,
    /** ZSET sessionId → join time, pre-registration lobby before T-0. */
    queueLobby: (eventId: string) => `${ev(eventId)}:queue:lobby`,
    /** ZSET sessionId → admission time (epoch ms); admitted users claim their pass. */
    queueAdmitted: (eventId: string) => `${ev(eventId)}:queue:admitted`,
    /** ZSET sessionId → last activity (epoch ms) of shoppers holding a pass. */
    queueActive: (eventId: string) => `${ev(eventId)}:queue:active`,
    /** HASH runtime state: seq, cursor, drawnAt, lastTickAt. */
    queueState: (eventId: string) => `${ev(eventId)}:queue:state`,
    /** STRING pass token id (jti) of a valid QueuePassToken, TTL = shopping window. */
    queuePass: (eventId: string, sessionId: string) =>
      `${ev(eventId)}:queue:pass:${sid(sessionId)}`,
    /** STRING access code id redeemed by a session for this event. */
    queueAccessCode: (eventId: string, sessionId: string) =>
      `${ev(eventId)}:queue:code:${sid(sessionId)}`,
    /** SET of eventIds with an active waiting room (iterated by the admission ticker). */
    activeQueueEvents: () => `${prefix}:queue:events`,

    // ── Shop presence (dashboard) ─────────────────────────────────────────
    /** ZSET sessionId → last heartbeat (epoch ms) of shoppers currently on the event. */
    presence: (eventId: string) => `${ev(eventId)}:presence`,
    /** ZSET sessionId → last heartbeat (epoch ms) of shoppers anywhere in the shop. */
    presenceShop: () => `${prefix}:presence:shop`,

    // ── Cross-cutting ────────────────────────────────────────────────────
    /** Fixed-window rate limiter bucket. */
    rateLimit: (bucket: string, subject: string) =>
      `${prefix}:rl:${seg(bucket, 'bucket')}:${seg(subject, 'subject')}`,
    /** Short-lived distributed mutex / leader lock. */
    mutex: (name: string) => `${prefix}:mutex:${seg(name, 'name')}`,
    /** Idempotency record for retried client requests (checkout submit, webhooks). */
    idempotency: (scope: string, key: string) =>
      `${prefix}:idem:${seg(scope, 'scope')}:${seg(key, 'key')}`,
    /** STRING cached OAuth access token of a payment provider (TTL = token lifetime). */
    providerToken: (provider: string, key: string) =>
      `${prefix}:oauth:${seg(provider, 'provider')}:${seg(key, 'key')}`,

    // ── Banking ──────────────────────────────────────────────────────────
    /**
     * STRING admin response to a FinTS TAN challenge (encrypted TAN, decoupled approval or
     * cancel), consumed by the worker that keeps the bank dialog open. TTL = challenge expiry.
     */
    bankTanResponse: (challengeId: string) =>
      `${prefix}:bank:tan:${seg(challengeId, 'challengeId')}`,

    // ── Backups ──────────────────────────────────────────────────────────
    /** STRING JSON maintenance flag (restore running); TTL + heartbeat, so it heals itself. */
    maintenance: () => `${prefix}:maintenance`,
    /** STRING JSON marker without TTL: a restore replaced the database but did not finish. */
    restoreIncomplete: () => `${prefix}:maintenance:restore-incomplete`,
    /** STRING token (NX, TTL) of a queued restore request: at most one at a time. */
    restoreRequest: () => `${prefix}:backup:restore-request`,
    /** STRING JSON progress of the running / last backup operation. */
    backupStatus: () => `${prefix}:backup:status`,
    /** STRING JSON last failed scheduled backup (dashboard alert, cleared by the next success). */
    backupFailure: () => `${prefix}:backup:failure`,

    /** STRING JSON (no TTL): PayPal refunds must be reconciled with PayPal after a restore first. */
    refundReconcilePending: () => `${prefix}:refunds:reconcile-pending`,
    /** STRING token (NX, PX): single flight of the reconciliation pass. */
    refundReconcileLock: () => `${prefix}:refunds:reconcile-lock`,

    // ── Infrastructure ───────────────────────────────────────────────────
    /** ZSET workerId → last heartbeat (epoch ms). */
    workerHeartbeats: () => `${prefix}:workers:heartbeats`,
    /** STRING JSON heartbeat details, TTL ≈ 3 × interval. */
    workerHeartbeat: (workerId: string) => `${prefix}:workers:hb:${seg(workerId, 'workerId')}`,
    /** Key prefix handed to BullMQ (`<prefix>:bull:<queue>:…`). */
    bullPrefix: () => `${prefix}:bull`,
  } as const;
}

export type Keyspace = ReturnType<typeof createKeyspace>;

/** Pub/Sub channels consumed by the realtime service (and config caches). */
export function createChannels(prefix: string) {
  seg(prefix, 'prefix');
  return {
    /** Seat / GA deltas of an event (JSON `SeatDeltaMessage`). */
    seatUpdates: (eventId: string) => `${prefix}:ch:ev:${seg(eventId, 'eventId')}:seats`,
    /** Queue cursor ticks and organizer announcements of an event. */
    queueUpdates: (eventId: string) => `${prefix}:ch:ev:${seg(eventId, 'eventId')}:queue`,
    /** Check-in progress for the live dashboard. */
    checkInUpdates: (eventId: string) => `${prefix}:ch:ev:${seg(eventId, 'eventId')}:checkin`,
    /** Messages addressed to one browser session (e.g. "you have been admitted"). */
    sessionMessages: (sessionId: string) => `${prefix}:ch:sid:${seg(sessionId, 'sessionId')}`,
    /** Pattern subscriptions used by the realtime service. */
    patterns: {
      seats: `${prefix}:ch:ev:*:seats`,
      queue: `${prefix}:ch:ev:*:queue`,
      sessions: `${prefix}:ch:sid:*`,
    },
    /** Settings changed in the Admin Portal → processes drop their config caches. */
    configInvalidation: () => `${prefix}:ch:config`,
  } as const;
}

export type Channels = ReturnType<typeof createChannels>;
