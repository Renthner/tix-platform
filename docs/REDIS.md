# Redis: Seat Locking, Waiting Room & Realtime

Redis holds all short-lived, high-contention state. PostgreSQL stays the source of truth for
orders and inventory; Redis mirrors what the lock scripts need to decide atomically.
Key builders: [`packages/redis/src/keys.ts`](../packages/redis/src/keys.ts) ·
scripts: [`seat-engine.ts`](../packages/redis/src/seat-engine.ts),
[`queue-engine.ts`](../packages/redis/src/queue-engine.ts) ·
tests: [`engine.integration.test.ts`](../packages/redis/test/engine.integration.test.ts).

Server settings ([`docker/redis/redis.conf`](../docker/redis/redis.conf)): `maxmemory-policy noeviction`
(locks and jobs are never evicted), AOF with per-second fsync.

## Key layout

All keys of one event share the hash tag `{ev:<eventId>}` → same cluster slot, so multi-key
Lua scripts stay valid on Redis Cluster. `<p>` is `REDIS_KEY_PREFIX` (default `tix`).

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
| `<p>:locks:events` / `<p>:queue:events` | SET    | events the worker loops have to visit                                                              |
| `<p>:rl:<bucket>:<subject>`             | STRING | fixed-window rate limit counter                                                                    |

## Lua scripts (all atomic, all-or-nothing)

| Script                                                                                       | Guarantees                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lockSeats`                                                                                  | Rejects if any seat is taken/blocked or locked by another session, or the session would exceed its per-event limit (seats + GA). Otherwise `SET … PXAT` every seat. Test: 300 concurrent sessions on one seat → exactly 1 lock. |
| `releaseSeats`                                                                               | Releases only locks owned by the caller.                                                                                                                                                                                        |
| `extendCart`                                                                                 | Moves all locks + GA holds of a session to a new expiry (payment grace period).                                                                                                                                                 |
| `sweepSeats`                                                                                 | Pops expired entries from the expiry index → released seat ids for broadcasting.                                                                                                                                                |
| `holdGeneralAdmission`                                                                       | `held + delta ≤ available`, per-session limit; increments/decrements atomically. Test: 50 concurrent holds on capacity 5 → exactly 5.                                                                                           |
| `sweepGeneralAdmission`                                                                      | Returns expired GA holds to the pool.                                                                                                                                                                                           |
| `queueJoin` / `queueDraw` / `queueAdmit` / `queueClaim` / `queueEnterDirectly` / `queuePing` | Waiting room: idempotent join, one-time lobby draw (crypto-shuffled order passed from Node), batch admission capped by the active-shopper threshold, claim window.                                                              |
| `rateLimit`                                                                                  | `INCR` + `PEXPIRE` fixed window.                                                                                                                                                                                                |

## Seat state as seen by a browser

`seatmap` (static, cached per version) + `availability` snapshot (`taken`, `locked`, `mine`, GA
remaining) + live deltas. Deltas are published to `<p>:ch:ev:<E>:seats`; every realtime gateway
instance pattern-subscribes, **coalesces deltas per event for 100 ms** and emits one
`seats:delta` frame to its local sockets in room `seats:<E>`. A seat map save publishes a new
`version`, which makes clients reload the plan.

## Waiting room flow

1. `POST /api/events/:id/enter` → `GRANTED` (pass cookie) · `QUEUED` · `LOBBY` · `CODE_REQUIRED` · `NOT_STARTED` · `CLOSED`.
2. The worker (leader-elected loop, 1 s) draws the lobby at T-0 and admits batches every
   `admissionIntervalSeconds`, capped by `activeSessionThreshold − active − admitted`.
3. Admitted sessions get a `session:message {type: admitted}` and `POST /claim` → pass cookie
   (signed, HttpOnly, bound to session + event + jti stored in Redis → revocable).
4. Clients compute their position from the broadcast `cursor` (`number − cursor`), so no
   per-user messages are needed while waiting; a 20 s poll is the fallback.
5. Every cart mutation requires a valid pass; releasing seats never does.
