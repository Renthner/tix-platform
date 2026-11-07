# Ticketing Platform

Self-hosted, high-concurrency ticketing platform for organisers who want to run their own
ticket shop – theatres, clubs and associations, festivals:

- visual seating plan editor with per-event adjustable copies of a venue's master plan
- multi-event cart; tariffs (reduced, wheelchair, companion …) chosen per seat in the cart
- virtual waiting room and Redis-backed seat locking for high-demand presales
- guest checkout plus optional customer accounts
- PayPal and bank transfer (Vorkasse) with automated reconciliation (FinTS, PSD2 via finAPI,
  camt.052/053, MT940, CSV, IMAP) and GoBD-compliant invoices
- PDF tickets, Apple & Google Wallet passes, transactional e-mail
- offline-first Android check-in app with cryptographically signed QR codes

Every business parameter (prices, fees, tax rates, layouts, templates, credentials, queue
rules, branding) is configured in the Admin Portal – nothing organisation-specific is
hard-coded.

> **Status:** Phase 3 of 6 – seating plan editor, seat locking, multi-event cart, virtual
> waiting room, checkout (PayPal + bank transfer), bank reconciliation (FinTS, finAPI,
> camt/MT940/CSV, IMAP), invoices and transactional e-mail. Tickets and wallet passes follow
> in phase 4.
> See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DATABASE.md](docs/DATABASE.md) and
> [docs/REDIS.md](docs/REDIS.md).

## Requirements

- Node.js ≥ 24.7 (uses the built-in `crypto.argon2`)
- pnpm 12 (`corepack enable pnpm`)
- Docker with Compose v2

## Quick start (full stack in Docker)

```bash
cp .env.example .env        # fill in all secrets – generation commands are in the file
docker compose up -d --build
docker compose run --rm migrate node dist/create-admin.mjs --email you@example.org --name "Your Name"
open http://localhost:8080          # shop; admin portal at /admin
```

For production set `PUBLIC_URL=https://tickets.example.org` and `SITE_ADDRESS=tickets.example.org` –
the bundled Caddy proxy then obtains TLS certificates automatically.

## Local development

```bash
pnpm install
pnpm infra:up               # PostgreSQL, Redis, object storage
pnpm db:migrate && pnpm db:seed
pnpm admin:create --email you@example.org --name "Your Name"
pnpm db:demo                # optional: demo venue + event on sale (/events/demo-concert)
pnpm dev                    # web :3000, realtime gateway :3001, worker
```

| Command                                 | Description                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm typecheck`                        | TypeScript across all packages                                               |
| `pnpm test`                             | Unit tests + PostgreSQL integration tests (needs `TEST_DATABASE_URL`)        |
| `pnpm db:generate`                      | Generate a migration after changing `packages/db/src/schema`                 |
| `pnpm db:studio`                        | Drizzle Studio                                                               |
| `pnpm db:demo`                          | Demo venue, seating plan and event on sale                                   |
| `node scripts/smoke/shop.mjs <eventId>` | End-to-end check of locking, cart, tariffs, realtime against running servers |

## Health endpoints

- `GET /api/health?probe=live` – liveness
- `GET /api/health` – readiness (PostgreSQL, Redis, live workers)
- worker `GET :8081/healthz`, realtime gateway `GET :3001/healthz`

## License

Source-available under the [PolyForm Shield License 1.0.0](LICENSE). The license text is
binding; in plain words, the intent is:

### Allowed (free of charge)

- Running your own ticket shop for the events you organise – clubs, associations, theatres,
  schools, companies, including charging your own ticket buyers prices and fees.
- Modifying the code for your own shop and sharing those modifications under the same terms.
- Having a contractor install, host or customise it _for you_ as your own shop.

### Not allowed

- Selling this software or a product derived from it.
- Offering a ticketing platform or ticketing service to other organisers based on this
  software (e.g. hosting it as a multi-tenant service or earning platform fees across
  organisers).

This is not an OSI-approved open-source license, because it restricts competing use.
