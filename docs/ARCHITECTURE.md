# Architecture

## Monorepo layout

```
apps/
  web/        Next.js 16 (App Router) – storefront, Admin Portal, REST/route handlers
  worker/     BullMQ worker – PDFs, wallet passes, e-mail, bank polling, dunning, lock sweeps
  android/    Offline-first check-in app (Kotlin, Phase 6)
packages/
  shared/     Isomorphic: enums, Zod schemas, settings registry; `./server`: crypto helpers
  db/         Drizzle schema, migrations, client, transaction helpers, seed & CLIs
  redis/      ioredis connection roles, key schema, pub/sub channels, queue names, health
docker/       Redis config, object-storage bootstrap
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
| `web`        | Next.js standalone    | Public + admin HTTP                                                       |
| `worker`     | worker image          | Background jobs, heartbeat, `/healthz`                                    |

Real-time fan-out (Socket.io with Redis adapter) and a TLS reverse proxy are added in Phase 2.

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
| **Bundled worker**                     | One ESM file per entry (worker, migrate, seed, create-admin); tiny runtime image                                                                                                              |
| **S3 abstraction**                     | Any S3-compatible backend; the compose default is a maintained MinIO community build because upstream MinIO stopped publishing images                                                         |

## Environment vs. database configuration

Only infrastructure is configured through environment variables (see `.env.example`):
database / Redis / S3 endpoints and credentials, the encryption key ring and the cookie
signing secret. Everything else – prices, fees, tax rates, TTLs, queue rules, payment
providers, bank connections, SMTP, wallet certificates, templates, branding – is stored in
PostgreSQL and managed in the Admin Portal.

## Implementation phases

1. **Architecture, database schema & Docker foundation** ← current
2. Visual seating editor, Redis locking & waiting room
3. Checkout, PayPal & bank-transfer reconciliation engine
4. PDF ticket designer, Apple/Google Wallet & e-mail worker
5. Admin Portal completion & box office
6. Offline-first Android check-in app & pairing API
