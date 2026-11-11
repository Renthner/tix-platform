# Load test

`scripts/load/` is a self-contained load generator plus invariant checker for the high-concurrency
promise of the platform: more than 1,000 buyers competing for the same seats without double
bookings, race conditions or deadlocks.

The runner starts an **isolated copy of the stack** (separate Docker Compose project `tixload` with
its own volumes and host ports), seeds the demo event, runs the scenarios, verifies the invariants
in Redis and PostgreSQL, scans the logs for deadlocks and tears everything down again. It never
touches the regular stack (project `tix`, port 8080).

## Quick start (Windows PowerShell)

```powershell
# prerequisites: Docker Desktop, Node >= 24.7, `pnpm install` once
.\scripts\load\run.ps1 -Vus 200            # smoke-size run, builds the images (a few minutes)
.\scripts\load\run.ps1 -Vus 1200           # full run, all four scenarios
.\scripts\load\run.ps1 -Vus 1200 -Scenarios seat-rush,checkout-rush -Keep   # keep the stack afterwards
```

If Windows PowerShell refuses to run the script (execution policy), start it with
`powershell -ExecutionPolicy Bypass -File scriptsload
un.ps1 -Vus 200` or use `pwsh`.

Linux / macOS: `scripts/load/run.sh --vus 1200` (same options, `--no-build`, `--keep`, ...).

| Option                                | Meaning                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `-Vus` / `--vus`                      | virtual users per scenario (default 1200)                                                |
| `-Scenarios` / `--scenarios`          | comma separated subset of `seat-rush,best-available,waiting-room,checkout-rush`          |
| `-Keep` / `--keep`                    | do not tear down (`docker compose -p tixload down -v` removes it later)                  |
| `-NoBuild` / `--no-build`             | use existing images instead of building (see `-ImageRegistry`)                           |
| `-ImageRegistry` / `--image-registry` | image name prefix; default `tixload` (built fresh and removed afterwards, never `tix/*`) |
| `-HttpPort`, `--postgres-port`, ...   | host ports of the isolated stack (defaults 18080, 15432, 16379, 19000/19001)             |
| `-QueueSeconds` / `--queue-seconds`   | observation window of the waiting-room scenario (default 150 s)                          |
| `-Observers` / `--observers`          | realtime Socket.io observer clients (default 200)                                        |

Exit code: `0` all invariants held, `1` an invariant failed or a deadlock was logged, `2` the run
itself failed. Results land in `scripts/load/results/` (git-ignored): one JSON per scenario with
all numbers, and `summary.txt`.

## What is simulated

The generator is a Node script (global `fetch`, no extra dependencies). Every virtual user (VU) is
a browser session with its own cookie jar and its own client address, and speaks the real shop API
(`/api/events/{id}/enter`, `/seats`, `/best-available`, `/general-admission`, `/availability`,
`/queue`, `/claim`, `/api/cart`, `/api/checkout`, the order page and the Socket.io gateway).
All VUs are created and warmed up first (session cookie + queue pass), then released through a
barrier in the same instant ("doors open"). Warm-up and rush are measured separately; only the
rush is reported.

| Scenario         | What happens                                                                                                                                                                                                                      | Invariants checked (after the rush, before any cleanup)                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seat-rush`      | all VUs try one of 20 hot seats (up to 3 attempts), 1-2 random seats and a standing spot; 15 % release a seat and retry; 200 realtime observers watch                                                                             | no seat granted to two VUs; Redis lock set equals the set of seats clients were told they got, each owned by the right session; lock keys and per-session cart sets agree; every hot seat has exactly one winner; standing area granted exactly its capacity; observers converge to the Redis state                                                                                                         |
| `best-available` | all VUs ask for 2-4 adjacent seats in a random category; 10 % give them back                                                                                                                                                      | same ledger / Redis checks, only business refusals (`NOT_ENOUGH_SEATS`), observers converge                                                                                                                                                                                                                                                                                                                 |
| `waiting-room`   | queue mode `AUTO_THRESHOLD` (threshold 100, batch 50 / 5 s); all VUs enter at once, queued VUs poll, claim their pass when admitted, then lock a seat; queued VUs also try to lock without a pass and with another session's pass | direct admissions <= threshold; no lock without a pass; forged pass rejected; admission batches <= batch size; active shoppers never above the threshold; admitted users get in; lock invariants                                                                                                                                                                                                            |
| `checkout-rush`  | all VUs race for seats / standing spots, everybody who got something places a **Vorkasse order** at the same time; 5 % double-submit the checkout; 20 % open the order page                                                       | orders in DB equal orders clients saw succeed, item counts and totals as shown in the cart, one order per customer, unique order numbers and payment references, ordered seats equal active order items and are `R/S` in Redis without cart lock, no seat in two active items, sold <= capacity, standing `allocated_count` equals ordered spots and <= capacity, invoice numbers unique, totals consistent |

Generic checks on every scenario: HTTP 5xx / network error rate below 1 %, and no HTTP 429 (a 429
would mean the per-IP rate limiter distorted the test).

After all scenarios the runner greps the PostgreSQL log for `deadlock detected`, `still waiting for`
(lock waits), errors and unique violations, and the web / worker / realtime logs for errors. Any
deadlock fails the run.

Latency targets are **reported only** (they depend on the machine): p95 lock and best-available
requests, checkout. Fail criteria are the invariants, the 5xx rate and deadlocks.

### Reading the output

```
endpoint                 reqs     p50     p95     p99     max   statuses
LOCK_HOT                 2400   410.2  1210.3  1630.0  2011.4   {"200":20,"409":2380}
                       codes {"409:SEAT_LOCKED":2380}
```

Latencies are milliseconds from sending the request to receiving the full body, measured in the
generator process. `409 SEAT_LOCKED` is the expected loser answer of a seat fight, not an error.
`details` holds scenario counters (hot seat winners, queue admissions, orders created, ...);
`invariants` lists every check with `PASS` / `FAIL` and the measured numbers.

## Why Node and not k6

k6 cannot speak Socket.io, and the decisive checks need a **cross-user ledger** (which VU was told
it holds which seat, compared with Redis and PostgreSQL afterwards). That is natural in one Node
process and awkward in k6, where VUs are isolated. A Node generator also needs no extra image and
reuses `pg`, `ioredis` and `socket.io-client` from the monorepo. Its limit: one JavaScript thread
generates the load (about 1-2k requests/s is no problem for it), and it shares the machine with
the system under test.

## Per-IP rate limits (important for the test setup)

The shop limits per client address: 120 `/enter` and 600 cart mutations per minute, 30 presence
heartbeats per session, and so on (code constants in `apps/web`). A single generator machine is
one address, so without precautions most requests would get HTTP 429 and you would test the rate
limiter instead of the seat locking.

The isolated stack therefore uses `scripts/load/Caddyfile.load` (via
`scripts/load/docker-compose.load.yml`): the proxy trusts the private-range peer (the Docker host)
and takes the client address from the `X-Forwarded-For` header the generator sends, one distinct
address per VU (`100.64.x.x`). The application code is unchanged and sees 1,200 different
visitors. This overlay must never be used in production, where the client could forge addresses.
The generator only sends the header when started with `--fake-ip` (the runner does for the isolated
stack).

Note for operators: the limits are constants in code and not configurable in the admin portal.

## What the runner changes in the isolated database

Only the throwaway database of the `tixload` project: `pnpm db:demo` (demo venue + event),
`orphan_seat_rule_enabled = false` on the event (random seat picks would otherwise be rejected at
checkout; the rule itself is covered by the integration tests), a default bank account (public
example IBAN) so Vorkasse is offered, and a per-event waiting-room configuration for the
`waiting-room` scenario. The runner verifies the target database (name, host, no events yet)
before seeding. It then writes a random isolation token into the throwaway database (database comment)
and Redis; `run-scenario.mjs --isolated` refuses to change anything unless both carry that token,
and without `--isolated` it requires `--confirm-non-production` (the runner passes it on for
external targets).

## Pointing the test at a staging server

```powershell
.\scripts\load\run.ps1 -Target https://staging.example.org -EventId <event uuid> `
  -DatabaseUrl "postgres://user:pass@staging-db:5432/tix" -RedisUrl "redis://:pass@staging-redis:6379/0" `
  -Vus 500 -Scenarios seat-rush,best-available,checkout-rush -ConfirmNonProduction
```

> **WARNING - never run this against production or against anything connected to real payment
> providers, real mailboxes or real customers.** It locks seats, **creates orders** (checkout
> scenario), writes invoices-in-waiting, e-mail outbox rows and bank reservations, and it hammers
> the server. Use a copy of the system with its own database. `-ConfirmNonProduction` is required
> to confirm that.

Prerequisites on the staging system, which the runner does **not** change for you:

- the event is on sale, **waiting room off** for `seat-rush`, `best-available`, `checkout-rush`
  (the `waiting-room` scenario modifies queue settings and is therefore only available for the
  isolated stack);
- the orphan-seat rule is off for the event (or expect `422 ORPHAN_SEATS` answers at checkout);
- Vorkasse is enabled with a default bank account;
- all seats are free at the start (`seat-rush` and `best-available` compare the exact lock set);
- the generator's address is exempt from the per-IP limits, or the limits are raised: without the
  `X-Forwarded-For` trick every VU shares one address and the run reports the resulting 429s as a
  failed check;
- PostgreSQL and Redis are reachable from the generator (read-only access is sufficient for
  the checks); the Redis key prefix is `tix` unless you pass `--redis-prefix` to `run-scenario.mjs`.

You can also run a single scenario directly:
`node scripts/load/run-scenario.mjs seat-rush --target ... --event-id ... --database-url ... --redis-url ... --vus 500`.

## Limits of a single-machine test

- The generator, the proxy, web, realtime, worker, PostgreSQL, Redis and MinIO all share the CPU of
  one machine, typically a laptop. Latencies measured here are **worse** than on dedicated servers
  and are dominated by CPU contention (see the container CPU peaks in `summary.txt`).
- One generator process is a single JavaScript thread; at very high VU counts the measured
  latencies include event-loop delay of the generator. Use several machines / generator processes
  for realistic capacity numbers.
- All traffic comes over the Docker network on one host, there is no WAN latency and no TLS.
- The data set is small (a 397-seat demo plan). That is deliberate: with 1,200 buyers for roughly
  500 places contention is maximal.
- Orders created by `checkout-rush` stay in the database of the isolated stack until it is torn
  down; re-run `run.ps1` (a fresh stack) instead of repeating a scenario on a used one.
- E-mails are not sent (no SMTP in the isolated stack); the outbox rows and worker retries still
  occur and appear as worker log noise.

## Reference results (single developer machine)

Windows 11, 24 logical CPUs, 32 GB RAM, Docker Desktop, everything (generator included) on the
same machine, 1,200 virtual users per scenario, one web / worker / realtime container each,
`WEB_DATABASE_POOL_MAX=20` (default). Other work was running on the machine at the same time, so
treat the figures as an order of magnitude.

| Scenario         | Result      | Highlights                                                                                                                                                                                                                                             |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `seat-rush`      | PASS        | 12.7k requests, ~750/s; 20 hot seats: exactly 20 winners from 3,560 attempts; 120 of 120 standing spots granted; 200 observers converged in 0.3 s                                                                                                      |
| `best-available` | PASS        | 1,200 requests in 4 s: 141 groups (409 seats) granted, 1,059 `NOT_ENOUGH_SEATS`; no overlaps; 134 of 141 groups in one row                                                                                                                             |
| `waiting-room`   | PASS        | 99 admitted directly, 1,101 queued, 100 admitted in batches of 50; 0 of 1,101 pass-less and 0 of 118 forged-pass lock attempts succeeded; 75k requests                                                                                                 |
| `checkout-rush`  | FAIL / PASS | ~280 Vorkasse orders in 25-40 s (about 8-10 orders/s), 0 duplicates, PostgreSQL and Redis inventory identical, no deadlock; with the default pool 0.1 - 7 % of the requests failed with HTTP 500, with `WEB_DATABASE_POOL_MAX=60` none (see finding 2) |

Postgres log over the whole run: 0 deadlocks; 1 s lock-wait notices only during the checkout rush
(row lock on the standing section counter and the gapless order number).

## Findings of the first runs

1. **Double submit of the checkout created two orders (fix in `placeOrder`).** Two parallel `POST /api/checkout`
   requests of the same session both passed the Redis cart checks. For seats the partial unique
   index `order_items_active_seat_uq` rejected the second one (visible as `duplicate key` lines in
   the PostgreSQL log, answered as `409 SEAT_UNAVAILABLE`), but for standing spots nothing
   stopped it: the same cart produced two orders and allocated the spots twice
   (`allocated_count` 120 vs. 113 ordered). `placeOrder` now holds a per-session Redis mutex; a
   racing second request gets `409 CHECKOUT_IN_PROGRESS` (the mutex has a 60 s lease that is renewed
   while the checkout runs and released by compare-and-delete with a token; regression tests are in
   `packages/core/test/checkout.integration.test.ts`).
2. **Checkout throughput and capacity limit of one web container.** The order transactions queue
   on shared rows (standing-area counter, gapless order number), which gives roughly 8-10 orders per
   second on this machine; the rest of the 1,200 buyers wait for their turn. With 1,200 users submitting at the same moment a single
   `web` container saturates one CPU core. Requests then queue for a database connection
   (`DATABASE_POOL_MAX` 20, `connectionTimeoutMillis` 10 s) or hit the 5 s `lock_timeout` on the
   hot `seat_map_sections` row of the standing area, and are answered with `500 INTERNAL_ERROR`
   (observed 0.1 - 7 % of the requests of the checkout scenario, depending on machine load).
   `WEB_DATABASE_POOL_MAX=60` removed the errors in the comparison run; more `web` replicas should help as well (not
   measured). The same errors appeared at 300 users (0.6 % - 3.8 %) with the image built before the fix as
   well as with the fixed one, so they are not caused by it. No seat or order inconsistency was found in any of the failing runs (all
   invariants held; orders committed while the client had already timed out are listed as
   informational "committed after the client gave up").
3. The per-IP rate limits (see above) are constants in code.

Consequences in the code: transient database overload (lock timeout 55P03, statement timeout,
serialization failure / deadlock that escaped the transaction retries, pool connect timeout) is now
answered with `503 BUSY` + `Retry-After: 2` (web API and scanner API) instead of `500`. The checkout
shows "Lots of traffic right now - please try again in a moment" and keeps the form; the order
transaction has rolled back, so a retry creates exactly one order. The default web pool is 40.

## Tuning

- **Web pool** `WEB_DATABASE_POOL_MAX` (default 40 per `web` replica; `.env.example`). One checkout
  holds one connection for the whole order transaction, so the pool caps parallel checkouts per
  replica; further requests queue up to 10 s for a connection.
- **PostgreSQL `max_connections`** (`POSTGRES_MAX_CONNECTIONS`, default 200 in `docker-compose.yml`).
  Budget: replicas x web pool + worker pool (10) + realtime + migrate/backup jobs + headroom for
  admin tools. With the defaults one replica uses ~60 of 200; with 3 replicas raise the limit or
  lower the pool.
- **Replicas** scale the CPU-bound part (a single `web` container saturates one core at 1,200
  simultaneous checkouts) but not the serialised rows: the gapless order number and the
  standing-area counter (`seat_map_sections.allocated_count`) are row-locked until commit, which
  bounds throughput to roughly 8-10 orders/s on the reference machine. The section counter is
  claimed before the order number is allocated (same lock order as the box office); moving it to
  the end of the transaction would shorten the hold slightly but invert that order, so it was left
  as is.
