# Redis: Seat Locking, Waiting Room & Realtime

Redis holds all short-lived, high-contention state. PostgreSQL stays the source of truth for
orders and inventory; Redis mirrors what the lock scripts need to decide atomically.
Key builders: [`packages/redis/src/keys.ts`](../packages/redis/src/keys.ts) ·
scripts: [`seat-engine.ts`](../packages/redis/src/seat-engine.ts),
[`queue-engine.ts`](../packages/redis/src/queue-engine.ts) ·
tests: [`engine.integration.test.ts`](../packages/redis/test/engine.integration.test.ts).

Server settings (the `command:` of the `redis` service in `docker/deploy/docker-compose.yml`; the development
file uses [`docker/redis/redis.conf`](../docker/redis/redis.conf)): `maxmemory-policy noeviction` (locks
and jobs are never evicted), AOF with per-second fsync and `aof-load-corrupt-tail-max-size` so Redis starts
again after a power loss. Redis is not published and runs without a password inside the Docker network
(`REDIS_URL` defaults to `redis://redis:6379/0`).

## Key layout

All keys of one event share the hash tag `{ev:<eventId>}` → same cluster slot, so multi-key
Lua scripts of one event stay valid on Redis Cluster. **Exception:** the seat engine scripts (`lockSeats`, `holdGeneralAdmission`, `extendCart`, `untrackIfIdle`) also touch the global set `<p>:locks:events` (events with live locks, tracked atomically for the sweeper), which lives in another slot, and the waiting-room scripts (`queueAdmit`, `queueEnterDirectly`, `queueClaim`, `queuePing`, `queueReset`) maintain the global set `<p>:queue:active:all` (server-wide cap). They therefore need a **single-node Redis** (Cluster would answer `CROSSSLOT`); this is what the bundled `redis` service is. `<p>` is `REDIS_KEY_PREFIX` (default `tix`).

| Key                                     | Type   | Content                                                                                            |
| --------------------------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| `<p>:{ev:E}:seat:<seatId>`              | STRING | cart session holding the lock, `PXAT` = cart expiry                                                |
| `<p>:{ev:E}:seat:expiries`              | ZSET   | seatId → expiry (sweeper index)                                                                    |
| `<p>:{ev:E}:seat:taken`                 | HASH   | seatId → `S` sold · `R` reserved · `B` blocked · `X` removed (DB mirror)                           |
| `<p>:{ev:E}:inventory`                  | STRING | seat map version the mirror was built from                                                         |
| `<p>:{ev:E}:cart:<sid>:seats`           | SET    | seats locked by one session in this event                                                          |
| `<p>:{ev:E}:ga:available`               | HASH   | standing section → sellable capacity (DB)                                                          |
| `<p>:{ev:E}:ga:held`                    | HASH   | standing section → spots held in carts                                                             |
| `<p>:{ev:E}:ga:holds`                   | HASH   | sid → JSON `{section: count}`                                                                      |
| `<p>:{ev:E}:ga:expiries`                | ZSET   | sid → hold expiry                                                                                  |
| `<p>:{ev:E}:seatmap:f<format>:v<n>`     | STRING | cached public seat map JSON (1 h); `format` = `PUBLIC_MAP_FORMAT`, bumped when the payload changes |
| `<p>:cart:<sid>`                        | HASH   | multi-event cart: `exp`, `ev:<E>`, tariff per seat `tt:<E>:<seat>`, per GA spot `ga:<E>:<section>` |
| `<p>:{ev:E}:queue:waiting`              | ZSET   | sid → queue number                                                                                 |
| `<p>:{ev:E}:queue:lobby`                | ZSET   | sid → join time (pre-registration)                                                                 |
| `<p>:{ev:E}:queue:admitted`             | ZSET   | sid → admission time (claim window)                                                                |
| `<p>:{ev:E}:queue:active`               | ZSET   | sid → last heartbeat of pass holders                                                               |
| `<p>:{ev:E}:queue:state`                | HASH   | `seq`, `cursor`, `drawnAt`, `lastTickAt`                                                           |
| `<p>:{ev:E}:queue:pass:<sid>`           | STRING | id (jti) of the valid QueuePassToken, TTL = shopping window                                        |
| `<p>:{ev:E}:queue:code:<sid>`           | STRING | redeemed access code id                                                                            |
| `<p>:queue:active:all`                  | ZSET   | `<E>:<sid>` → moment the entry stops counting (active + admitted of ALL events, server-wide cap)   |
| `<p>:locks:events` / `<p>:queue:events` | SET    | events the worker loops have to visit                                                              |
| `<p>:rl:<bucket>:<subject>`             | STRING | fixed-window rate limit counter                                                                    |

## Lua scripts (all atomic, all-or-nothing)

| Script                                                                                                      | Guarantees                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lockSeats`                                                                                                 | Rejects if any seat is taken/blocked or locked by another session, or the session would exceed its per-event limit (seats + GA). Otherwise `SET … PXAT` every seat. Test: 300 concurrent sessions on one seat → exactly 1 lock. |
| `releaseSeats`                                                                                              | Releases only locks owned by the caller.                                                                                                                                                                                        |
| `extendCart`                                                                                                | Moves all locks + GA holds of a session to a new expiry (payment grace period).                                                                                                                                                 |
| `sweepSeats`                                                                                                | Pops expired entries from the expiry index → released seat ids for broadcasting.                                                                                                                                                |
| `holdGeneralAdmission`                                                                                      | `held + delta ≤ available`, per-session limit; increments/decrements atomically. Test: 50 concurrent holds on capacity 5 → exactly 5.                                                                                           |
| `sweepGeneralAdmission`                                                                                     | Returns expired GA holds to the pool.                                                                                                                                                                                           |
| `queueJoin` / `queueDraw` / `queueAdmit` / `queueClaim` / `queueEnterDirectly` / `queuePing` / `queueReset` | Waiting room: idempotent join, one-time lobby draw (crypto-shuffled order passed from Node), batch admission capped by the per-event active-shopper threshold and the optional server-wide cap, claim window.                   |
| `rateLimit`                                                                                                 | `INCR` + `PEXPIRE` fixed window.                                                                                                                                                                                                |

## Seat state as seen by a browser

`seatmap` (static, cached per version) + `availability` snapshot (`taken`, `locked`, `mine`, GA
remaining) + live deltas. Deltas are published to `<p>:ch:ev:<E>:seats`; every realtime gateway
instance pattern-subscribes, **coalesces deltas per event for 100 ms** and emits one
`seats:delta` frame to its local sockets in room `seats:<E>`. A seat map save publishes a new
`version`, which makes clients reload the plan.

## Waiting room flow

1. `POST /api/events/:id/enter` → `GRANTED` (pass cookie) · `QUEUED` · `LOBBY` · `CODE_REQUIRED` · `NOT_STARTED` · `CLOSED`.
2. The worker (leader-elected loop, 1 s) draws the lobby at T-0 and admits batches every
   `admissionIntervalSeconds`, capped by `activeSessionThreshold − active − admitted` **of that
   event** (the global queue config applies to every event separately) and, when the setting
   `queueCapacity.maxActiveShoppers` is set, by `cap − active+admitted of all events`.
3. Admitted sessions get a `session:message {type: admitted}` and `POST /claim` → pass cookie
   (signed, HttpOnly, bound to session + event + jti stored in Redis → revocable).
4. Clients compute their position from the broadcast `cursor` (`number − cursor`), so no
   per-user messages are needed while waiting; a 20 s poll is the fallback.
5. Every cart mutation requires a valid pass; releasing seats never does.

**Per event vs. server-wide.** `activeSessionThreshold` counts the active shoppers (pass holders
with a heartbeat in the last 2 minutes + admitted visitors who have not claimed yet) of one event:
with 6 events and a threshold of 300, up to 1,800 shoppers can be in the shops before anybody
queues. The optional server-wide cap (Settings → Waiting room, super-admins only, empty = off) counts the same figure
over all events in `<p>:queue:active:all` (member `<E>:<sid>`, score = last heartbeat + 2 min or
admission + claim window; every script prunes expired members first, so a leaked slot heals within
that window; reset of an event removes its members). When set, direct entry (`AUTO_THRESHOLD`,
`SCHEDULED_PRE_REGISTRATION` after the draw) and batch admission also need a free global slot;
visitors beyond it queue in their event's queue. Claiming an admission never re-checks the cap (the
slot was reserved at admission; the claim window ends exactly where the global slot is pruned).
Mode `OFF`, `VIP_CODE_ONLY` and access codes that skip the queue are counted but never refused;
super-admins are neither counted nor refused. Event deletion and a backup restore also clear the
event's / all members of the set.

**Fairness across events.** The ticker rotates the event it starts with on every tick, so slots
freed under the cap are shared among the waiting lines of several events over consecutive ticks.
There is no strict order across events: a newcomer of an event whose queue is empty can take a
freed slot directly before another event's next tick, and bypass entries take slots without ever
being refused.

**Soft limit.** The cap is a soft limit: a pass holder whose heartbeat lapsed (pruned after the
2-minute active window) is re-registered by its next heartbeat (`queuePing`) without a cap
check, so the count can briefly exceed the cap until other entries expire.
