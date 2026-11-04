/**
 * Central Redis key schema. Every key the platform writes is built here – no ad-hoc
 * strings elsewhere – so the layout stays reviewable and collision-free.
 *
 * Cluster readiness: all keys of one event share the hash tag `{ev:<eventId>}` and
 * therefore the same slot. Lua scripts that atomically touch many seats of an event
 * (multi-seat lock, best-available, orphan-seat check) remain valid on Redis Cluster.
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

  return {
    prefix,

    // ── Multi-event cart (Phase 2) ───────────────────────────────────────
    /**
     * HASH cart state of one shopping session across ALL events: events in the cart and the
     * tariff (ticket type) chosen per seat / GA spot in the cart. Deliberately not hash-tagged
     * (spans events); the locks themselves live in the per-event keys below.
     */
    cart: (sessionId: string) => `${prefix}:cart:${seg(sessionId, 'sessionId')}`,

    // ── Seat locking (Phase 2) ───────────────────────────────────────────
    /** STRING cartSessionId, TTL = cart lock TTL (+ payment grace once checkout starts). */
    seatLock: (eventId: string, seatId: string) => `${ev(eventId)}:seat:${seg(seatId, 'seatId')}`,
    /** SET of seatIds currently locked by one cart session (bulk release / TTL extension). */
    cartSeats: (eventId: string, sessionId: string) =>
      `${ev(eventId)}:cart:${seg(sessionId, 'sessionId')}:seats`,
    /** HASH sectionId → spots held by one cart session in STANDING sections. */
    cartGeneralAdmission: (eventId: string, sessionId: string) =>
      `${ev(eventId)}:cart:${seg(sessionId, 'sessionId')}:ga`,
    /** HASH sectionId → total GA spots currently held in carts (all sessions). */
    generalAdmissionHeld: (eventId: string) => `${ev(eventId)}:ga:held`,
    /** ZSET seatId → lock expiry (epoch ms); swept to broadcast SEAT_RELEASED on expiry. */
    seatLockExpiries: (eventId: string) => `${ev(eventId)}:seat:expiries`,
    /** STRING JSON snapshot of the public seat map, keyed by seat map version. */
    seatMapSnapshot: (eventId: string, version: number) => `${ev(eventId)}:seatmap:v${version}`,

    // ── Virtual waiting room (Phase 2) ───────────────────────────────────
    /** ZSET sessionId → queue ticket number (FIFO) or random score (lottery). */
    queueWaiting: (eventId: string) => `${ev(eventId)}:queue:waiting`,
    /** ZSET sessionId → join time, pre-registration lobby before T-0. */
    queueLobby: (eventId: string) => `${ev(eventId)}:queue:lobby`,
    /** ZSET sessionId → last activity (epoch ms) of admitted shoppers (AUTO_THRESHOLD). */
    queueActive: (eventId: string) => `${ev(eventId)}:queue:active`,
    /** STRING monotonic counter issuing FIFO queue ticket numbers. */
    queueSequence: (eventId: string) => `${ev(eventId)}:queue:seq`,
    /** HASH runtime state (admission cursor, effective mode, paused flag). */
    queueState: (eventId: string) => `${ev(eventId)}:queue:state`,
    /** STRING token id of a valid QueuePassToken, TTL = shopping window. */
    queuePass: (eventId: string, sessionId: string) =>
      `${ev(eventId)}:queue:pass:${seg(sessionId, 'sessionId')}`,

    // ── Cross-cutting ────────────────────────────────────────────────────
    /** Sliding-window rate limiter bucket. */
    rateLimit: (bucket: string, subject: string) =>
      `${prefix}:rl:${seg(bucket, 'bucket')}:${seg(subject, 'subject')}`,
    /** Short-lived distributed mutex (e.g. one bank sync per connection). */
    mutex: (name: string) => `${prefix}:mutex:${seg(name, 'name')}`,
    /** Idempotency record for retried client requests (checkout submit, webhooks). */
    idempotency: (scope: string, key: string) =>
      `${prefix}:idem:${seg(scope, 'scope')}:${seg(key, 'key')}`,

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

/** Pub/Sub channels (application events; Socket.io adapter channels are managed by Socket.io). */
export function createChannels(prefix: string) {
  seg(prefix, 'prefix');
  return {
    /** Seat deltas: SEAT_LOCKED / SEAT_RELEASED / SEAT_SOLD / SEAT_BLOCKED. */
    seatUpdates: (eventId: string) => `${prefix}:ch:ev:${seg(eventId, 'eventId')}:seats`,
    /** Queue position ticks, admissions, organizer announcements. */
    queueUpdates: (eventId: string) => `${prefix}:ch:ev:${seg(eventId, 'eventId')}:queue`,
    /** Check-in progress for the live dashboard and LAN-less scanner fan-out. */
    checkInUpdates: (eventId: string) => `${prefix}:ch:ev:${seg(eventId, 'eventId')}:checkin`,
    /** Settings changed in the Admin Portal → processes drop their config caches. */
    configInvalidation: () => `${prefix}:ch:config`,
  } as const;
}

export type Channels = ReturnType<typeof createChannels>;
