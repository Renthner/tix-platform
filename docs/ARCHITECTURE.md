# Architecture

## Monorepo layout

```text
apps/
  web/        Next.js 16 (App Router, next-intl) – storefront, Admin Portal, route handlers
  realtime/   Socket.io gateway – live seat deltas, waiting-room updates (stateless, scalable)
  worker/     BullMQ jobs + leader-elected loops (lock sweeper, waiting-room ticker)
  android/    Offline-first check-in app (Kotlin)
packages/
  shared/     Isomorphic: enums, Zod schemas, settings registry, seating rules, pricing, geometry
  db/         Drizzle schema, migrations, client, transaction helpers, seed & CLIs
  redis/      Connection roles, key schema, Lua engines (seat locks, waiting room, rate limit)
  core/       Server-side domain services shared by web/worker: cart, waiting room, seat-map
              save/clone, inventory mirror, public seat map cache, realtime publishing,
              checkout/orders/payments (PayPal), dunning, banking, e-mail, invoices
docker/       Redis config, object-storage bootstrap, Caddy reverse proxy
scripts/      Smoke tests against running servers
```

Internal packages are consumed as TypeScript source (`exports` → `src/*.ts`): Next.js
transpiles them (`transpilePackages`), the worker is bundled by esbuild into self-contained
ESM files, so runtime images need no workspace `node_modules`.

## Runtime topology (`docker-compose.yml`)

| Service      | Image                 | Role                                                                      |
| ------------ | --------------------- | ------------------------------------------------------------------------- |
| `postgres`   | `postgres:18-alpine`  | Primary data store (ACID orders, invoices)                                |
| `redis`      | `redis:8-alpine`      | Seat locks, waiting room, rate limits, BullMQ, pub/sub. `noeviction`, AOF |
| `minio`      | S3-compatible storage | Uploaded assets, generated PDFs / `.pkpass`, bank statements              |
| `minio-init` | `mc`                  | Creates buckets + least-privilege app user (idempotent)                   |
| `migrate`    | worker image          | One-shot: advisory-locked migrations + idempotent seed                    |
| `web`        | Next.js standalone    | Shop + Admin Portal + API (only reachable through `proxy`)                |
| `realtime`   | Socket.io gateway     | WebSockets; Redis Pub/Sub fan-out, 100 ms delta batching                  |
| `worker`     | worker image          | Background jobs, lock sweeper + waiting-room ticker, heartbeat            |
| `proxy`      | `caddy:2-alpine`      | Public entry: `/socket.io` → realtime, rest → web; automatic HTTPS        |

Seat locking, waiting room and realtime data flow: see [REDIS.md](REDIS.md).

## Request flow of a seat click

1. Browser `POST /api/events/:id/seats` (session cookie + QueuePassToken cookie).
2. Web validates the pass and rate limits, loads the cached public seat map, ensures the Redis
   inventory mirror is current, runs the `lockSeats` Lua script (all-or-nothing).
3. Web publishes `[seatId, 'L']` to Redis Pub/Sub; every realtime instance batches deltas for
   100 ms and pushes one frame to all browsers watching the event.
4. Unclaimed locks expire (`PXAT` = cart expiry); the worker sweeper broadcasts the release.
5. At checkout PostgreSQL's partial unique index is the final authority.

## Shop data cache

Presale traffic (> 1,000 buyers opening the event page at T-0) must not turn into thousands of
identical database queries, while everything that matters for a purchase stays live. The pages
cannot be cached as HTML (every response carries a per-request CSP nonce and cookies), so the
**data** behind them is cached in each web process.

**What is cached** (`packages/core/src/shop-data.ts`, `seatmaps/public.ts`, `events.ts`):
event + venue + cover + info box symbols by slug, the event list of the home page (with
"from" prices), queue display texts and announcements, the public seat plan (geometry, categories,
tariffs, prices) as ready-to-send JSON per locale with an ETag, the media catalogue row, and the
event row used by the seat / cart API (`getEventCached`). Settings keep their own small cache
(`settings.ts`), which now also follows invalidations of other instances.

**What is never cached:** seat status and counters (Redis / realtime), carts, queue positions and
passes, customer / admin sessions, rate limits. Nothing time dependent is evaluated at load time:
the sale state (`computeSaleState`), "event already started" and announcement expiry are decided
at render time from the cached timestamps; a cached list expires itself when its first event starts.

**Mechanism** (`packages/core/src/cache/`): in-process LRU (`TagCache`) with single-flight loading,
tags, a safety TTL (60 s; 10 s for the event row of the seat API) and Redis pub/sub for
cross-instance invalidation (channel `<prefix>:ch:cache`; settings use `<prefix>:ch:config`).
`invalidateShopCache(ctx, tags)` evicts locally at once and publishes; every web instance and the
worker subscribe (`startShopCacheSync`). A load that was running while one of its tags was
invalidated is never stored. While the subscription is down entries live only 2 s (concurrent misses
still share one load, so there is no stampede), and every (re)subscription flushes the cache, so a
missed message can never go unnoticed.
Processes without a subscription (CLI, tests) cap the TTL at 3 s. Next.js `use cache` was not used:
its default handler is per process and cannot be invalidated across replicas.

**Tags:** `event:<id>` (one event: row, categories, tariffs, matrix, plan, info boxes),
`events` (catalogue: slugs, status, order, visibility, list), `venues`, `media`, `symbols`,
`queue`. `eventTags(id)` = `events` + `event:<id>` is the safe default after any event edit.

**Rules for new features**

1. Data that is cached must be identical for every visitor and must not embed live state or the
   current time.
2. Every code path that changes cached data calls `invalidateShopCache` (or, in the web admin,
   `refreshShop` from `server/admin/shop-refresh.ts`) **after** its transaction committed – never
   inside it, otherwise another instance can reload the old row and cache it.
3. Prefer invalidating inside the core function that writes (covers every caller, including the
   worker); admin server actions that write directly call `refreshShop(eventTags(eventId))`.
   **Prices are the exception to "invalidate after commit":** the public plan's cache keys contain
   `seat_maps.version` and `events.public_map_generation` (bumped by database triggers on
   categories, tariffs, the pricing matrix and the currency, in the writer's transaction), and every
   money path (cart, quote, checkout, box office) reads that stamp from the database
   (`getPublicSeatMap(..., { fresh: true })`). A stale snapshot is therefore never looked up after a
   commit, whatever happens to the invalidation.
4. New cached read model = new loader in `shop-data.ts` with tags; add the matching invalidation to
   every writer of the tables it reads (`grep` for `.update(<table>)`).
5. Backup restore flushes everything (`invalidateShopCache(ctx, 'all')`).

The admin System page and `/api/metrics` show hit / miss / bypass counters of the process that
answered (`tix_shop_cache_*`). The seat plan endpoint answers `Cache-Control: no-cache` with a
strong ETag: browsers revalidate on every load (304 without a body), so a price change is never
hidden by a browser cache. Measurements: [LOAD-TEST.md](LOAD-TEST.md#shop-page-data-cache).

## Checkout, orders & payments

```text
cart (Redis locks) ──"Proceed to checkout"──▶ +payment grace once (two-stage TTL)
   │
   └─"Place binding order" (POST /api/checkout)
        quote per payment method (tariffs, fees, VAT) – rejected if the total changed
        re-checks: sale state, held locks, orphan / companion rules, companion seat bought
        alone → wheelchair space must be SOLD to the same e-mail, per-customer limit,
        access-code quota (row locks on customer + code)
        ┌ one transaction: customer upsert (lower(email)), gapless order number, items
        │ (partial unique index), fees, GA capacity, history, outbox e-mail
        └ after commit: Redis "taken" = R, locks removed, GA holds committed, cart cleared
   ├─ BANK_TRANSFER → AWAITING_PAYMENT: reference PREFIX-YYYY-NNNNNN-C (Luhn), due date
   │    (business days, regional holidays), reminder + auto-cancel dates, order page shows
   │    bank details; bank sync / manual entry → recordPayment
   └─ PAYPAL → PENDING: order page → PayPal Orders v2 (server-side redirect flow)
        → /api/paypal/return captures → recordPayment; webhooks (signature verified via
        PayPal's API, idempotent inbox `webhook_events`) cover buyers who never return

recordPayment: fully paid → PAID, items CONFIRMED, Redis "taken" = S, `documents` job
`order-paid` (invoice PDF + payment confirmation e-mail).
Dunning job (`dunning` queue, every 5 min): one reminder, auto-cancel overdue Vorkasse orders
unless "keep reserved" or partially paid, expire abandoned PayPal orders after asking PayPal
(approved → captured; money arriving for an expired order is refunded automatically).
```

Order e-mails use a transactional outbox: the `email_messages` row is written in the same
transaction as the state change, the BullMQ job is added after commit, and the worker
re-queues stored-but-undispatched messages.

## Test orders

A signed-in **SUPER_ADMIN** (and only that role; the role is read from the database on every
request and two-factor set-up must be complete) may test-buy. Core stays auth agnostic: the web
layer derives a `ShopActor` (`apps/web/src/server/shop-actor.ts`) and passes it to
`requireShopAccess`, `enterShop`, `queueStatus` and `placeOrder`; the sale state for that actor is
`shopSaleState` (`packages/core/src/shop-actor.ts`), `computeSaleState` itself is untouched (it
also drives the queue ticker, badges and structured data).

- **Draft events** (`status = DRAFT`) exist only for super-admins: the event page loads them with
  `getDraftEventBySlug` – never through the public shop cache – and every `/api/events/<id>/…` route
  returns 404 for everybody else (`loadShopEvent`). Draft responses are `private, no-store`, the page is
  `noindex` and has no structured data; drafts are not in the home list or the sitemap.
- **Sale window**: the bypass only ever WIDENS access. Whenever customers could buy (`ON_SALE`) so can
  super-admins; in addition they pass the closed windows – a draft, presale, "not started", pause and a
  passed sale-end – but only until the event itself starts (then `ENDED`; door sales are the box office's
  job). CANCELLED / ARCHIVED stay closed. Order limits are unchanged.
- **Waiting room**: super-admins get a signed pass whose id is never stored in Redis and
  `requireShopAccess` waives the pass for them: no queue slot, no active-shopper entry. The staff cookie
  `tix_admin_queue_test` (set by `POST /api/admin/queue-test`) turns the bypass off.
- **Test orders**: `is_test` is decided **at checkout**: an order whose events are all DRAFT then gets
  `orders.is_test = true` and a number from its own series (`TEST-<year>-<seq>`; the real order and invoice
  series stay gapless when test orders are deleted). It never changes afterwards: moving a PUBLISHED event
  back to DRAFT keeps its existing orders real (invoiced, counted), and a test order stays a test order
  after publishing. A cart mixing draft and published events is refused. Orders on published events
  bought outside the sale window are normal orders. The checkout also sets `events.had_test_orders`
  (never reset) in the order transaction and refuses when the event is no longer DRAFT (this UPDATE
  serialises with publishing, see below). Test orders get **no invoice** (`issueInvoiceInTransaction`
  returns null – no number from the GoBD series is consumed, also with `force`), a TEST watermark on
  ticket PDFs, a `[TEST]` subject prefix + banner on every e-mail (`renderEmail`) and **no wallet passes**
  (buttons and links are omitted, `ensureApplePass` / `ensureGoogleSaveUrl` refuse with
  `WALLET_TEST_ORDER`). They are excluded from statistics, dashboard KPIs, customer history and
  revenue. Payments (PayPal as configured – possibly live –, bank transfer) work normally; money is real.
- **Bank matching**: test orders are never offered as candidates and a transfer carrying the exact
  reference of a test order goes to review (`ORDER_NOT_PAYABLE`, candidate reason `TEST_ORDER`), never
  auto-fulfilled. Manual assignment needs an explicit confirmation (`confirmTestOrder`).
- **Money rules** (accounting). A test order that **never received money** is deleted completely
  (`deleteTestOrder`, SUPER_ADMIN): items, tickets, payments, adjustments, e-mail outbox rows, stored
  ticket PDFs, the shop session's access-code redemptions (code counters lowered, single-use codes usable
  again) and the order in every bank transaction's review candidates; seats and standing capacity are
  released and an `order.test.delete` audit entry is written. Open PayPal attempts are checked at PayPal
  first (`reconcilePayPalOrder`, outside the transaction); an attempt that stays open keeps the order
  (`PAYMENT_OPEN`). If the deleted order already had tickets the scanner **sync epoch** is rotated
  (`rotateSyncEpoch`): the xid-horizon feed cannot express deletions, and a new epoch makes every device
  drop its synced tickets and re-sync (unsent scans stay). Test orders without tickets leave the epoch
  alone. Once real money was **captured** (a payment with `captured_at`, or a bank allocation – also
  when refunded since) the order is a financial record and **cannot be deleted**
  (`MONEY_CAPTURED`): `cancelAndHideTestOrder` cancels it through the normal flow (PayPal refunded
  automatically, bank transfers become an open refund; no invoice → no credit note) and hides it
  (`orders.test_hidden_at`) from the default order list; it stays findable by search and the test
  filter. Its payments, refunds, reversals and write-offs stay in the accounting export (CSV column
  `test` = `TEST`, DATEV booking text prefixed `TEST `, voucher = order number), never with an invoice or
  credit-note number. Bulk delete deletes the money-free orders and reports the others as "cancel only".
  A multi-event test order is deleted entirely, including its items at the other draft events.
- **Publishing** (`changeEventStatus`, the only writer of `events.status`): going live (DRAFT /
  ARCHIVED → PUBLISHED / POSTPONED) is refused (`TEST_ORDERS_PRESENT`) while a test order of the event exists that is not cancelled & hidden
  (cancelled & hidden ones are inert: void tickets, released seats; they stay for accounting). When the event ever had test orders (`had_test_orders`) all
  its signing keys are revoked and a fresh one created in the same transaction – scanners list revoked
  keys without key material, so old test QR codes are RED ("invalid signature") after the next manifest
  sync, also offline. Refused (`TEST_KEY_ROTATION_REAL_TICKETS`) if real tickets exist. The event row is
  locked `FOR UPDATE`, the test checkout's `had_test_orders` UPDATE takes the same lock.
- **Open item (not fixed)**: the realtime gateway has no database and joins socket rooms by event id
  only, so a socket that knows the id of a DRAFT event receives its seat deltas (opaque seat ids and
  lock states of test purchases; the id is unguessable and only shown in the admin). Gating this needs
  the event status at every one of the ~14 `publishSeatDelta` call sites (many of them have no event
  row: jobs, fulfilment) plus a super-admin claim in the `rt` token – no cheap, stale-proof way yet.
- In-flight ticket PDF jobs skip deleted orders and never leave an object behind.

## Internationalisation

`next-intl` with English as default (no URL prefix) and German under `/de`. Messages live in
`apps/web/messages/<locale>/<namespace>.json`; `pnpm --filter @tix/web test` verifies that all
locales have identical keys and ICU placeholders. Adding a language = new message folder +
entry in `SUPPORTED_LOCALES` (`packages/shared/src/i18n.ts`).

## Key decisions

| Decision                               | Rationale                                                                                                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Drizzle ORM** (not Prisma)           | Partial unique indexes, CHECK constraints, composite FKs, `NULLS NOT DISTINCT` and expression indexes are first-class – the double-booking guard lives in the schema. No query-engine binary. |
| **PostgreSQL 18**                      | Native `uuidv7()`, data checksums by default                                                                                                                                                  |
| **Per-event seat map copy**            | The venue master plan is copied per event; the copy stays editable (e.g. remove seats for a camera) without affecting the template or other events. Seats with order history are soft-removed |
| **Multi-event orders**                 | The cart spans events; the event lives on each order item. Tariffs are chosen per seat in the cart; reductions are verified at the door, not online                                           |
| **Guest checkout + optional accounts** | One customer row per e-mail; registering adds a password to it. Orders are shown only after e-mail verification                                                                               |
| **Global fees, adjustable per event**  | Global PER_TICKET / PER_EVENT / PER_ORDER fees; events override or waive them individually                                                                                                    |
| **Two-layer seat protection**          | Redis Lua locks for fast UX (sub-ms, TTL) + PostgreSQL partial unique index as the final authority                                                                                            |
| **Redis hash tags `{ev:<id>}`**        | All keys of one event share a cluster slot → multi-seat Lua scripts stay atomic on Redis Cluster                                                                                              |
| **Connection roles**                   | Separate command (auto-pipelined), publisher, subscriber and BullMQ connections                                                                                                               |
| **Secrets in DB, encrypted**           | Zero-hardcoding: credentials are edited in the Admin Portal; only infrastructure lives in env                                                                                                 |
| **Node built-in Argon2id**             | `crypto.argon2` (Node ≥ 24.7) – no native addon to compile                                                                                                                                    |
| **Bundled worker / realtime**          | One ESM file per entry (worker, migrate, seed, create-admin, realtime); tiny runtime images                                                                                                   |
| **S3 abstraction**                     | Any S3-compatible backend; the compose default is a maintained MinIO community build because upstream MinIO stopped publishing images                                                         |
| **SVG symbol library in the DB**       | Seat shapes and element icons are stored as sanitised SVG fragments (allow-listed shape tags only, no scripts/links/styles) and inlined once per plan as `<symbol>` + `<use>`                 |
| **Rich text as sanitised HTML**        | Event descriptions are edited with TipTap and stored as allow-listed HTML; sanitised again on save so the shop can render it directly                                                         |

## Media: originals and responsive variants

Uploads (`POST /api/admin/media`, `uploadMediaAsset`) are decoded with `sharp` (undecodable files are
rejected with `MEDIA_UNDECODABLE`), auto-oriented and stripped of EXIF / XMP (GPS position, camera data) when
they carry any; clean PNG / JPEG files are stored byte for byte, WebP uploads are always converted to JPEG
(opaque) or PNG (transparent). This **original / master** (PNG or JPEG – legacy assets may still be WebP, key
`media/<kind>/<year>/<sha>-<rand>.<ext>`) stays the file that ticket PDFs, wallet passes and e-mails use
(`/api/media/<id>` without parameters).

Public kinds (`PUBLIC_MEDIA_KINDS`) additionally get **AVIF (q55) and WebP (q75) variants** at 320 / 640 / 960 /
1280 / 1920 / 2560 px plus the source width (never upscaled), stored next to the original as
`<original key without extension>.w<width>.<format>` and recorded in `media_asset_variants`. A failed
conversion never fails an upload: the worker job `media-backfill-variants` (queue `media`, concurrency 1,
every 10 minutes and on start) generates variants for every public asset that has none yet, so existing
assets are converted automatically. `/api/media/<id>?w=<width>&f=avif|webp` serves the smallest variant that
is at least that wide (the widest if the source is narrower) with immutable caching; `w` and `f` are
allow-listed (400 otherwise) and assets without variants answer with the original (cached for 5 minutes
only). The shop renders them with `<MediaImage>` (`<picture>` with AVIF and WebP sources, original as
`<img>`). Variants are deleted with their asset; they are part of the assets bucket and therefore of
backups, and are regenerated by the backfill if missing after a restore.

## Check-in scanner API

The Android app talks to `/api/scanner/v1/*` (pairing, manifest, delta sync, online scan, offline batch
upload, lookup, app download). It uses Bearer device tokens only (no cookies / CSRF), has its own
JSON/error helper (`apps/web/src/server/scanner-api.ts`) and logic in `packages/core/src/scanner`; the
decision table lives in `packages/shared/src/scanner`. See [SCANNER.md](SCANNER.md) for the full contract,
sync semantics and offline merge rules.

## Environment vs. database configuration

Only infrastructure is configured through environment variables (see `.env.example`):
database / Redis / S3 endpoints and credentials, the encryption key ring and the cookie
signing secret. Everything else – prices, fees, tax rates, TTLs, queue rules, payment
providers, bank connections, SMTP, wallet certificates, templates, branding – is stored in
PostgreSQL and managed in the Admin Portal.
