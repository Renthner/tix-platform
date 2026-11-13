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
