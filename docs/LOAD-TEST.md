# Load test

The promise of the platform is **more than 1,000 buyers competing for the same seats without double
bookings, race conditions or deadlocks**. There are two tools for two questions:

| Tool                            | Question                                                                                                   | Needs                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `scripts/load/journey.mjs`      | How does **this** server (production-like, with proxy / CDN / WAF) behave under 1,000+ realistic shoppers? | a running server, the **load test mode token**, a published test event |
| `scripts/load/run.mjs` (Part B) | Are the seat-locking, waiting-room and checkout **invariants** intact (Redis + PostgreSQL cross-checks)?   | Docker; builds and tears down its own isolated stack                   |

German edition of this page: [LOAD-TEST.de.md](LOAD-TEST.de.md).

## Part A - journey test against a real server

### What it does

`journey.mjs` starts several generator processes (default `min(CPUs, ceil(users/250))`, at most 8)
that together simulate N shoppers. Each shopper has its own session cookie and runs the journey of
a real visitor:

1. shop home page and (with `--event-slug`) the event page,
2. `POST /enter` and, when a waiting room is on, polling `/queue` and `/claim` until admitted,
3. seat map and availability,
4. WebSocket (Socket.io) subscription to the seat events,
5. a fight for the same **hot seats** (default 20, three tries each),
6. best available (default 30 % of the shoppers), one or two random seats, some give a seat back,
7. keeping the cart for about a minute (cart reads), then `DELETE /api/cart` (cleanup),
8. optionally a bank-transfer checkout (`--checkout-ratio`, dedicated copy only, see below).

What is measured and asserted:

- p50 / p95 / p99 / max latency, status and error-code counts per endpoint, requests per second;
- rates of 5xx / network errors, **429** (an IP limit distorted the test) and **503** (system busy);
- **WebSocket fan-out latency**: from sending a seat lock until the `seats:delta` arrives at the
  generator's own sockets (same host clock, so no clock skew);
- **hot-seat exclusivity**: every lock response and every release is recorded with timestamps; two
  different sessions certainly holding the same seat at the same time is a double booking and
  fails the run (checked for hot, random and best-available seats alike);
- **no leaked locks**: after all carts were emptied no seat is held that was not held before;
- optional `--database-url`: read-only SQL check (a read-only session) that no seat is in two active
  order items; private / LAN database hosts are refused unless `--allow-private` is given;
- snapshots of `/__tix/health` and (with `--metrics-token`) `/api/metrics` before and after, and
  peaks sampled every 10 s (memory, database connections, Redis memory / clients, sockets, locks).

Output: a human summary on stdout and a machine-readable JSON (`scripts/load/results/journey.json`
or `--out`). Exit code `0` all assertions held, `1` an assertion failed, `2` refused / could not
run. The token never appears in the output or the JSON.

### Safety rails of the generator

- `--target` is mandatory and has no default; `http://localhost:8080` and `:3000` (the regular
  stack and the dev server) are refused.
- A real run needs `--yes` **and** the load test token (`--loadtest-token`, or better the
  environment variable `TIX_LOADTEST_TOKEN`, which does not show up in the process list).
- `--dry-run` prints the plan and sends nothing.
- The run aborts itself when more than 20 % of the requests answer 429 (wrong token, mode not
  active, or a proxy in front limits the generator) and still cleans up the carts.
- `Ctrl+C` stops the shoppers gracefully and empties the carts; the cart timer (lock TTL) is the
  safety net for anything that could not be cleaned up.
- Orders need `--checkout-ratio` **and** `--allow-orders`: checkout creates real orders and queues
  real e-mails to `load-...@example.invalid`. Only on a dedicated copy with an SMTP sink, never on
  production.

### Load test mode (server side)

Per-IP limits are the right protection against scripted abuse, and exactly what blocks a load
generator that comes from a single address. Admin -> **System** -> _Load test mode_ switches them
off **for requests that carry a secret token, for a limited time**:

1. Sign in as SUPER_ADMIN (an authenticator app or a passkey must be set up on the account).
2. Choose the duration (5 minutes to 4 hours, default 60), enter your password **and a fresh second
   factor** (authenticator or recovery code, or a passkey confirmation bound to this action - the
   mere existence of a second factor on the account is not enough), click **Enable**.
3. Copy the token. It is shown once; only its SHA-256 hash is stored (in Redis, with a TTL).
4. While active, a red banner shows on every admin page and the System page has a **Disable now**
   button. The mode ends by itself. `loadtest.enable`, `loadtest.disable` and `loadtest.expire` are
   in the audit log (with the number of bypassed requests, never the token).

What a request with the header `X-Tix-Loadtest: <token>` skips while the mode is active, and
nothing else:

| Limit (Redis bucket) | Meaning                                                                           |
| -------------------- | --------------------------------------------------------------------------------- |
| `shop-ip`            | seat / standing / best-available requests per IP (setting "seat requests per IP") |
| `checkout-ip`        | orders per IP (setting "checkouts per IP", off by default)                        |
| `enter-ip`           | entering the shop / waiting room                                                  |
| `realtime-token-ip`  | realtime token for the WebSocket                                                  |

Deliberately **not** skipped: sign-in, two-factor, passkey, password-reset and other failed-auth
limits, scanner authentication, VIP-code and discount-code guessing limits (`code-ip`,
`discount-code-ip`), waiting-list mail limits, ticket self-service and transfer limits, PayPal
webhook limits, per-session limits (`shop-session`, `checkout`, `presence`), per-e-mail and
per-code limits, order limits, the seat-lock engine itself, and the CSRF / origin checks. The
header is ignored when the mode is off, a wrong token behaves as no header, the comparison is
constant time (hash of the token), and the header is redacted in the logs. A unit test pins the
bypass to exactly these four buckets. A disable takes effect within about a second (each process
caches the state for one second).

Anonymous shoppers cannot open DRAFT events (that is a super-admin privilege and the token does
**not** widen it), so the target must be a **published** event, ideally an unlisted test event
(see "Cleanup").

### Which environment?

| Option                                                     | When                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Dedicated copy** (own stack, backup restored, SMTP sink) | Default recommendation: capacity tests, checkout tests, anything that creates orders, anything you may break.                                                                  |
| **Production**                                             | Only to verify the real chain (CDN, WAF, proxy, TLS, limits) with a _published test event_, outside sales, cart only (no checkout), short and ramped. Never during an on-sale. |
| Isolated stack of Part B                                   | Invariant checks and regression runs on a laptop / CI.                                                                                                                         |

A laptop on a home connection cannot honestly produce 1,000 users at production request rates; run
the generator on a VPS in the same region as the server and give it one vCPU per ~250 users.

### Step by step for production

1. **Prepare a test event.** Create an event with a small plan (a few hundred seats), publish it,
   open sales, set the order limits generously and the orphan-seat rule off. Keep it unlisted
   (for example a far-future presale with an access code, or simply do not link it) and leave the
   waiting room settings of real events alone. Note the event id (in the URL of the admin event page).
2. **Generator address.** Run the generator on a machine with a fixed public IP, here
   `203.0.113.7`.
3. **Cloudflare** (if the shop is behind it): _Security -> WAF -> Custom rules_, action **Skip**
   (all rate limiting rules, Bot Fight Mode / Super Bot Fight Mode, Security Level, managed rules as
   needed), expression
   `(ip.src eq 203.0.113.7 and any(http.request.headers["x-tix-loadtest"][*] ne ""))`.
   Do not enable "I'm Under Attack" during the test. Cloudflare sees the generator as one very busy
   visitor, and its terms ask you to inform them before large tests on proxied hostnames. A cleaner
   option is a DNS-only (grey cloud) test hostname that points to the origin, which also takes the
   CDN out of the measurement. This shop never marks `/api/*` or its HTML as cacheable (`no-store`),
   but check the `cf-cache-status` header.
4. **Traefik / your reverse proxy.** Remove or bypass per-IP rate limit and in-flight middleware for
   the generator, for example with a higher-priority router without the middleware:

   ```yaml
   - traefik.http.routers.tix-loadtest.rule=Host(`shop.example.org`) && ClientIP(`203.0.113.7/32`)
   - traefik.http.routers.tix-loadtest.priority=100
   - traefik.http.routers.tix-loadtest.service=tix
   ```

   (no `rateLimit` / `inFlightReq` middleware on it). nginx: `map $remote_addr $limit_key { 203.0.113.7 ""; default $binary_remote_addr; }`
   and `limit_req_zone $limit_key ...` (an empty key is not limited); raise `worker_connections` for
   1,000+ WebSockets. The proxy must pass `Upgrade` / `Connection` and must not strip unknown
   request headers (none of the common ones do; the built-in proxy of the image forwards
   `X-Tix-Loadtest` untouched, which a unit test pins).

5. **CrowdSec / fail2ban.** CrowdSec: `cscli allowlists create loadtest -d "load test"`, then
   `cscli allowlists add loadtest 203.0.113.7`. fail2ban: `fail2ban-client set <jail> addignoreip 203.0.113.7`
   for every jail that reads the proxy access log. Remove both after the test.
6. **`TRUSTED_PROXIES` and the built-in proxy.** The client address the application sees comes from
   `X-Forwarded-For` of a trusted proxy (`TRUSTED_PROXIES`, see INSTALL.md); behind Cloudflare /
   Traefik it is the generator's public IP. Do **not** try to spoof client addresses: a forged
   `X-Forwarded-For` is ignored unless the peer is a trusted proxy, and the load test token is the
   sanctioned way past the per-IP limits. The built-in proxy additionally caps the concurrent
   connections per client address that is _not_ a trusted proxy (`TIX_PROXY_MAX_CONNS_PER_IP`,
   default 200); connections that arrive through a trusted proxy are exempt. If the generator talks
   to the container **directly** (a staging copy without a proxy in front), every user holds an
   HTTP connection and a WebSocket: set `TIX_PROXY_MAX_CONNS_PER_IP=0` (or at least twice the number
   of users) for the duration of the test and restore the default afterwards. Do not weaken the
   default permanently.
7. **Enable the load test mode** (see above). Copy the token and note the end time.
8. **Metrics (optional, recommended).** Settings -> Security -> Prometheus endpoint: create a
   metrics token and pass it as `TIX_METRICS_TOKEN`.
9. **Dry run, then a small run.**

   ```bash
   export TIX_LOADTEST_TOKEN=...   # from the admin page
   node scripts/load/journey.mjs --target https://shop.example.org --event-id <uuid> --dry-run
   node scripts/load/journey.mjs --target https://shop.example.org --event-id <uuid> --yes \
        --vus 100 --ramp 30s --duration 2m
   ```

   Continue only when this passes with 429 = 0.

10. **The real run**, for example 1,200 users, ramp 90 s, five minutes:
    `node scripts/load/journey.mjs --target ... --event-id ... --event-slug <slug> --yes --vus 1200 --ramp 90s --duration 5m --metrics-token ...`
    Watch Admin -> System (database connections, Redis, sockets, locks) next to it.
11. **Disable** the load test mode (button on the System page), then remove the Cloudflare rule, the
    proxy exemptions, the CrowdSec / fail2ban entries and the `TIX_PROXY_MAX_CONNS_PER_IP` change.
12. **Cleanup.** Without `--checkout-ratio` the journey leaves no orders; carts were emptied and any
    remaining lock expires by TTL. Archive or unpublish the test event. With `--checkout-ratio`,
    cancel the orders on the dedicated copy and delete the event there (an event with orders cannot
    be deleted on a live system, GoBD).

### Options

| Option                                                                                                       | Meaning                                                                               |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `--target`, `--event-id`, `--event-slug`                                                                     | server, event, optional public event page                                             |
| `--yes`, `--dry-run`                                                                                         | confirm / only print the plan                                                         |
| `--loadtest-token` / `TIX_LOADTEST_TOKEN`                                                                    | token of the load test mode                                                           |
| `--vus` (1000), `--workers`, `--ramp` (60s), `--ramp-profile`                                                | users, processes, ramp-up (`linear`, `step` = 5 batches, `spike` = everybody at once) |
| `--duration` (4m), `--hold` (60s, max 8m)                                                                    | total run time including the ramp, average cart hold time                             |
| `--hot` (20), `--best-available` (0.3), `--ws-ratio` (1)                                                     | contention seats, share using best available / WebSockets                             |
| `--checkout-ratio` with `--allow-orders`                                                                     | share placing a bank-transfer order (dedicated copy only)                             |
| `--metrics-token` / `TIX_METRICS_TOKEN`, `--database-url`                                                    | resource snapshots, optional read-only double-booking SQL check                       |
| `--max-failure-rate` (0.01), `--max-429-rate` (0.001), `--max-503-rate` (0.02), `--max-fanout-p95-ms` (2000) | assertion limits                                                                      |

Keep the hold time well below the cart timer (default 10 minutes): a lock that expires during the
test can legitimately be taken by someone else, which the exclusivity check cannot tell from a
double booking.

### Reading the results

- **A failing exclusivity or leak check is the only real "bug" signal**; everything else is capacity.
- **429 above 0.1 %**: the limiter, not the system, was measured. Wrong token or expired mode, a
  WAF / proxy / CrowdSec in front, or a limit that the bypass does not cover (see the endpoint column).
- **503 / `BUSY`**: database lock timeouts or pool exhaustion under contention; see "Tuning" below
  (`WEB_DATABASE_POOL_MAX`, PostgreSQL `max_connections`).
- **5xx and `TIMEOUT` with low CPU on the server**: the generator itself (CPU, `ulimit -n`) or the
  network path; look at the generator CPU and raise `--workers`.
- **LOCK_HOT** is a contention number (all users on 20 seats); `LOCK_RANDOM` and `SEATMAP` are closer
  to normal browsing. A healthy fan-out p95 is well below one second.
- Latency includes the network between generator and server; measure from the same region.

### Finding the bottleneck

When many requests time out (30 s, status 0) although the web container's CPU looks calm, the
generator tells you where to look. With `--metrics-token` it scrapes `/api/metrics` every 5 s (four
quick requests per tick, so that several web processes are seen) and keeps the **peak per metric and
`pid`** in the JSON (`resources.peaksDuringRun`); the stdout summary adds a "diagnosis hint" block
when more than 1 % of the requests timed out. The same figures are on the System page, card "Web
process load" (with several web processes each refresh shows the one that answered).

| Metric (per web process, label `pid`)                                          | Meaning                                                                                               |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `tix_db_pool_connections{state="total"}`, `idle`, `waiting`, `tix_db_pool_max` | database pool of the process; `total - idle` = in use; **waiting** = requests queued for a connection |
| `tix_event_loop_lag_seconds{quantile="0.5"}`, `0.99`, `max`                    | how late the single-threaded event loop answers (10 ms timer, window of 10-20 s)                      |
| `tix_process_cpu_seconds_total`                                                | CPU time of the process (its rate is the share of one core)                                           |

How to read them:

- **Pool waiting > 0** (peak): requests wait for a database connection. Raise `WEB_DATABASE_POOL_MAX`
  (mind `TIX_DB_CONNECTION_BUDGET` and PostgreSQL `max_connections`) and look for slow queries
  (`tix_postgres_longest_query_seconds`). If a scrape needs more than 4 s for the database part, the
  endpoint answers only the process figures with `tix_scrape_degraded 1`: the database or its pool is
  saturated.
- **Event loop lag p99 above about 200 ms**: the web process is CPU bound (even if the container
  average looks low, because one process uses one core). Raise `TIX_WEB_PROCESSES` or give the VM
  more CPU.
- **Both low, but timeouts** ("not CPU/DB/event-loop bound as seen by the server"): the time is lost
  outside the application. Check the network path: Cloudflare, Traefik / reverse proxy, FritzBox /
  router, the uplink of the generator and of the server. The summary prints the bytes received in
  total and per second (decoded bodies, no WebSocket traffic): compare that with the uplink, and with
  `docker stats` NET I/O of the proxy and the `tix` container over the same time. A saturated uplink
  shows as timeouts with an idle server.
- **Timeouts by endpoint**: timeouts on cheap endpoints (`AVAILABILITY`) as well as on expensive ones
  point to a shared queue (pool, event loop, network) rather than one slow query.
- **Indeterminate hold overlaps** (a WARN, never a failure): a release request (`UNLOCK`,
  `CART_CLEAR`, `PROBE_UNLOCK`) timed out, so the generator cannot know whether the server released
  the seat before another session got it. Only a _certain_ overlap fails the run.

What to watch on the server during a run:

- `docker stats` for **all** containers (`tix`, postgres, redis, the proxy), not only the web one:
  CPU, memory and NET I/O. A busy postgres or redis container explains slow answers from a calm web
  process.
- `top` (or `vmstat 1`) on the VM / host: a high `wa` (I/O wait) means slow disks, a high `st`
  (steal) means the hypervisor gives the VM less CPU than it shows (typical on shared Proxmox hosts).

### Caveats

- A CDN or WAF may rate limit or challenge the generator even with the token; the `statuses`
  columns show 403 / 429 / 5xx answers from it.
- The generator reports what it sees from outside; server saturation shows in the System page and
  the metrics snapshots.
- The per-IP limits themselves are not exercised with the token on. Test them separately without
  it (a small run with a wrong token must answer 429).
- A test event adds seat locks, sockets and shop sessions to a live system; the dashboard
  ("shoppers right now") shows them.

### Sizing hints

- The web part is CPU-bound: pages are rendered per request, and by default one web process uses
  about one core. Set `TIX_WEB_PROCESSES` (`auto` = the CPUs of the container, see
  [INSTALL.md](INSTALL.md#scaling-to-more-cores)) to use more: budget 2-4 vCPU for the container for a
  1,000-user presale, plus PostgreSQL and Redis on the same host (see "Reference results" and "Tuning"
  in Part B). Measured on one machine with 600 simulated shoppers and a container limited to 4 CPUs: one
  web process was saturated (cart requests p95 1.5 s, seat requests p50 1.0 s), three processes answered
  the same load with cart p95 0.11 s and seat p50 0.04 s. The realtime gateway (live seat updates) stays
  a single process and showed a fan-out p95 of about 3 s in both runs.
- Database connections: web processes x (`WEB_DATABASE_POOL_MAX` + 2) + worker + realtime must stay below
  PostgreSQL `max_connections`. Without an explicit `WEB_DATABASE_POOL_MAX` the budget of 20 is divided
  by `TIX_WEB_PROCESSES`; the startup log prints the maximum and warns above 80.
- Redis is not the bottleneck at this scale (the Lua locks are O(1)); watch
  `tix_redis_used_memory_bytes` and the client count.
- About one WebSocket per shopper on the seating plan; the realtime gateway is one Node process
  (`tix_realtime_sockets`, fan-out latency).

### Test event with a large seating plan

The demo plan has a few hundred seats. To test the seat map, the shop cache and the realtime
fan-out with a realistic hall, generate a plan of about 3,600 seats and import it like any other plan
file:

```bash
node scripts/load/make-seatplan.mjs --seats 3600 --out loadtest-seatplan.tixplan.json
```

Options: `--seats N` (100 to 90,000, default 3,600), `--out <path>`, `--name <plan name>`. The file is
deterministic (same options, same file) and has no images or custom symbols. For 3,600 seats it is
1.2 MB (the upload limit of the importer is 40 MB). Layout: a stage at the top, one entrance,
three price categories (Cat 1 red, Cat 2 blue, Cat 3 green), seven blocks in straight rows of 20-28
seats (Parkett links / Mitte / rechts, Balkon links / Mitte / rechts, Loge; the three columns line
up, so keyboard navigation across blocks works), row labels, seat numbers and four wheelchair /
companion pairs. Seats per block: 600 / 780 / 600 / 420 / 420 / 420 / 360; per category: Cat 1 780
(Parkett Mitte), Cat 2 1,980, Cat 3 840.

1. **Import the plan.** Admin -> **Venues & plans** -> open a venue (create a test venue first) ->
   card **Import seating plan** -> choose the file. The preview shows 7 blocks, 152 rows, 3,600 seats
   and the categories; keep or change the name, click **Import plan**. A new master plan opens in
   the editor (the import takes about one second).
2. **Create the event.** Admin -> **Events** -> **New event**: title, venue, **Seating plan** = the
   imported plan, start date, time zone, currency and tax rate; switch the **Orphan seat rule** off
   for load tests; **Create event**. The three plan categories become price categories of the event.
3. **Prices.** Event tab **Pricing**: give Cat 1, Cat 2 and Cat 3 a price for the tariff (without a
   price a category is not sellable).
4. **Sales.** Event tab **Sales**: set generous order limits (empty = unlimited), keep **Pick seats
   on the plan** and switch **Best available seats** on (the best-available block of the shop then
   offers all three categories; Parkett Mitte is picked first).
5. **Publish.** Event tab **Details** (status card): status **Published**, **Apply status**. Anonymous
   shoppers, and so the load generator, can only open published events, so keep the event unlisted
   (no link, far-future presale with an access code) on a live system.
6. **Waiting room.** Leave the event's waiting room **off** (event tab **Waiting room**) to measure
   the seat map and the locks. A second run with mode `AUTO_THRESHOLD` and a threshold well below the
   number of simulated users measures the queue; do not touch the waiting room settings of real
   events. Then run `journey.mjs` with the event id as described above.

Measured on a throwaway database (PostgreSQL 18): importing the 3,600-seat file took about 1.1 s;
the public seat map the shop downloads is about 915 KB of JSON (about 113 KB gzipped, the
shop serves it with an ETag and answers revalidations with `304`). Delete the event and the test
venue afterwards (an event without orders can be deleted after archiving).

### Measured locally

Throwaway single-image container (`--target app`) with PostgreSQL 18 and Redis 8 on the same
Windows 11 developer machine as the generator (24 logical CPUs, other work and other test runs
were going on at the same time, so read the numbers as an order of magnitude), demo event with
391 plain seats and 120 standing places, 20 hot seats, load test mode on, `TIX_PROXY_MAX_CONNS_PER_IP=0`,
generator direct to the container (one client address):

| Run                           | Result                                        | Highlights                                                                                                                                                                                                                                |
| ----------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 300 users, ramp 30 s, 2 min   | PASS                                          | ~6,000 requests (~80/s), 0 x 5xx / 429 / 503, 34 hot-seat locks granted and 815 refused on 20 seats, 631 hold intervals without overlap, fan-out p50 88 ms / p95 0.6 s, 0 leaked locks                                                    |
| 1,000 users, ramp 30 s, 100 s | all invariants PASS, fan-out p95 limit FAILED | ~18,900 requests (~210/s), 0 x 5xx / 429 / 503, 40 hot-seat locks granted and 2,899 refused, 761 intervals without overlap, 0 leaked locks. One container on a busy machine saturated: p95 of several endpoints 1-18 s, fan-out p95 2.8 s |

Checks of the mode itself on the same stack: without the header (or with a wrong one) 300 rapid
`POST /enter` from one address answered 120 x 200 and 180 x 429 (limit 120 per minute); with the
token 600 x 200 (counted as bypassed requests); after **Disable** the token was refused like any
other (120 x 200, then 429); an expired run is closed by the worker with a `loadtest.expire`
audit entry within a second; the token appears neither in Redis, the audit log nor the logs.

## Part B - isolated stack with invariant checks

`scripts/load/run.mjs` is a self-contained runner plus invariant checker. It starts an **isolated copy of
the stack** (separate Docker Compose project `tixload` with its own volumes and host ports), seeds the
demo event, runs the scenarios, verifies the invariants in Redis and PostgreSQL, scans the logs for
deadlocks and tears everything down again. It never touches the regular stack (project `tix`, port 8080).

## Quick start (Windows PowerShell)

```powershell
# prerequisites: Docker Desktop, Node >= 24.7, `pnpm install` once
.\scripts\load\run.ps1 -Vus 200            # smoke-size run, builds the images (a few minutes)
.\scripts\load\run.ps1 -Vus 1200           # full run, all four scenarios
.\scripts\load\run.ps1 -Vus 1200 -Scenarios seat-rush,checkout-rush -Keep   # keep the stack afterwards
```

If Windows PowerShell refuses to run the script (execution policy), start it with
`powershell -ExecutionPolicy Bypass -File scripts/load/run.ps1 -Vus 200` or use `pwsh`.

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

The isolated stack therefore sets `TRUSTED_PROXIES=private_ranges` (see `scripts/load/run.mjs`): the
built-in proxy of the `tix` container trusts the private-range peer (the Docker host)
and takes the client address from the `X-Forwarded-For` header the generator sends, one distinct
address per VU (`100.64.x.x`). The application code is unchanged and sees 1,200 different
visitors. Never set this on a system whose clients could forge addresses.
The generator only sends the header when started with `--fake-ip` (the runner does for the isolated
stack).

Note for operators: most limits are constants in code; only "seat requests per IP per minute" and "checkouts per IP" are settings. For tests of a real server use the **load test mode** of Part A instead of spoofing addresses.

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

- The generator, the `tix` container (proxy, web, realtime, worker), PostgreSQL and Redis all share the CPU of
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
same machine, 1,200 virtual users per scenario, one `tix` container (web, worker and realtime processes),
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

## Shop page data cache

The shop pages are rendered per request (CSP nonce, cookies), so the data behind them is cached
in each web process and invalidated by tags over Redis pub/sub (docs/ARCHITECTURE.md, "Shop data
cache"). Measured with [autocannon](https://github.com/mcollina/autocannon) against the isolated
e2e stack (`E2E_KEEP=1 node scripts/e2e/run.mjs`, project `tix-e2e`, one web container, demo
event, Docker Desktop on a developer PC that was doing other work). 100 connections, 20 s per URL,
anonymous visitors (no cookies); database transactions per request = delta of
`pg_stat_database.xact_commit` minus the idle rate of the background worker, divided by the number
of requests (every query of these pages is an autocommit statement).

| Page                 | Before (rps / p50 / DB tx per request)   | After (rps / p50 / DB tx per request)             |
| -------------------- | ---------------------------------------- | ------------------------------------------------- |
| Shop home `/`        | 39 rps / 2,290 ms / **2.27**             | 75–77 rps / 1,120–1,135 ms / **0.01**             |
| Event page           | 53 rps / 1,690 ms / **4.53**             | 71–84 rps / 1,070–1,200 ms / **0.03**             |
| Seat plan JSON (API) | 367 rps / 145 ms (p97.5 1,025 ms) / 0.17 | 546–629 rps / 62–71 ms (p97.5 2,100–2,900 ms) / 0 |

"After" are two runs of the final build, "before" one run of the previous build (single run, the
machine was noisy: earlier "after" runs of the same code gave 56–70 rps for the home page and
46–64 rps for the event page, so differences below roughly 20 % are not significant). Honest
reading:

- **Database load is the clear win:** a page view no longer touches PostgreSQL in steady state
  (2.3 / 4.5 queries before; what remains is the 60 s safety reloads and the 1 s seat map version
  check). At T-0 the number of database queries no longer grows with the number of visitors, and
  an admin edit costs one reload per instance instead of one per page view.
- **Throughput of the pages is bound by server-side rendering (CPU), not by the database.** The
  cache alone changed page throughput little (run-to-run noise on the event page). The page
  HTML shrank from 138 KB to 73 KB because the shop no longer ships the 74 KB admin message
  catalogue to every visitor (it only needs the admin menu and form feedback strings); together
  with the cache this roughly doubled the home page rate and gave +35–60 % on the event page.
- The seat plan endpoint no longer re-localises and re-serialises the plan per request and answers
  revalidations with `304` (ETag); its tail latency under 100 connections is dominated by the
  single Node process of the test stack.
- Several web replicas multiply throughput linearly (each caches independently; the invalidation
  fan-out is one small Redis message per admin change).

Reproduce: start the stack as above, then run autocannon (`npx autocannon -c 100 -d 20 http://localhost:18090/events/demo-concert`)
and read `xact_commit` before and after:
`docker exec tix-e2e-postgres-1 psql -U tix -d tix -Atc "select xact_commit from pg_stat_database where datname='tix'"`.
The cache counters of a running instance are on the admin System page and in `/api/metrics`
(`tix_shop_cache_lookups_total{result="hit|miss|coalesced|bypass|discarded"}`).

## Tuning

- **Web pool** `WEB_DATABASE_POOL_MAX` (default 40 per `web` replica; `.env.example`). One checkout
  holds one connection for the whole order transaction, so the pool caps parallel checkouts per
  replica; further requests queue up to 10 s for a connection.
- **PostgreSQL `max_connections`** (`POSTGRES_MAX_CONNECTIONS`, default 200 in `docker-compose.yml`).
  Budget: replicas x web pool + worker pool (10) + realtime + migrate/backup jobs + headroom for
  admin tools. With the defaults one replica uses ~60 of 200; with 3 replicas raise the limit or
  lower the pool.
- **Web processes** (`TIX_WEB_PROCESSES`) or replicas scale the CPU-bound part (a single web process saturates one core at 1,200
  simultaneous checkouts) but not the serialised rows: the gapless order number and the
  standing-area counter (`seat_map_sections.allocated_count`) are row-locked until commit, which
  bounds throughput to roughly 8-10 orders/s on the reference machine. The section counter is
  claimed before the order number is allocated (same lock order as the box office); moving it to
  the end of the transaction would shorten the hold slightly but invert that order, so it was left
  as is.
