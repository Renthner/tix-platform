# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with pre-release tags
(`alpha.N`, `beta.N`, `rc.N`). See [docs/RELEASES.md](docs/RELEASES.md).

## [Unreleased]

## [1.0.0-alpha.3] - 2026-11-11

### Added

- Check-in app updates from GitHub Releases with a channel (`stable` or `next`): the admin
  chooses the source (GitHub Releases or the own server with APK upload), the repository and
  the default channel, and whether devices may change the channel. The app verifies the
  checksum, the version and the signing certificate (including forward key rotation) before
  the system installer starts. Older apps can still step up once through an uploaded APK.
- Multi-architecture container images (linux/amd64 and linux/arm64), keyless cosign signatures,
  SBOM and provenance attestations for the images, and build provenance attestations for the
  APK and the deploy bundle.
- Container image vulnerability scanning with Trivy on every release and weekly, reported in
  code scanning.
- Dependabot updates for npm, Gradle, GitHub Actions and Docker base images.
- Two-file deployment: a server needs only `docker-compose.yml` and `env.example` (saved as
  `.env`) from the release page. The Caddyfile and the bucket setup script are embedded in the
  compose file (Compose 2.23.1 or newer), Redis settings are passed as flags, and PostgreSQL,
  Redis and MinIO publish no host ports. Both files are release assets (with checksums and
  attestations); `tix-deploy-<version>.zip` additionally has a README with TLS, update and
  backup instructions.
- `TRUSTED_PROXIES` setting for running behind another reverse proxy or load balancer (any
  product): Caddy takes the visitor address from the proxy's `X-Forwarded-For` header, so rate
  limits and audit logs see the real visitor. Empty (default) keeps Caddy as the public edge.

### Changed

- CI and releases run on GitHub-hosted runners; a self-hosted runner can still be selected for
  private forks, but never for fork or Dependabot pull requests.
- The release workflow uses least-privilege jobs (separate scan and attestation jobs), a
  protected `release` environment for the signing key, and fails instead of publishing a
  release without the APK.

### Fixed

- In-app updates on Android 9 and 10 (signing certificate lookup).

## [1.0.0-alpha.2] - 2026-11-11

### Added

- Release channels: moving image tags `next` (newest release of any kind), `alpha` / `beta` / `rc`
  (newest of that stage) and, for stable releases, `latest`, `stable`, `X` and `X.Y`. A tag only
  moves when the release has the highest SemVer precedence in its group
  (`scripts/release/channel-tags.mjs`, unit-tested).
- Deploy bundle `tix-deploy-<version>.zip` attached to every release: standalone production
  `docker-compose.yml` using the ghcr.io images with a `TIX_CHANNEL` setting, config files,
  `.env.example` and a README. The GitHub "latest" flag is only set for the highest stable release.
- CI runs on a self-hosted runner and can be started manually.

### Fixed

- Android SDK setup in CI.
- Executable bits of the shell scripts.

## [1.0.0-alpha.1] - 2026-11-11

First public pre-release: all six planned phases are built. Expect rough edges; see "Known
limitations" below.

### Added

#### Shop and seating

- Visual seating plan editor (sections, rows, seats, tables, standing areas, stage and facility
  symbols, entrances, custom symbol library); venue master plans are copied per event and stay
  editable; plan export and import.
- Public seating chart rendered identically to the editor; atomic Redis seat locking with live
  updates over WebSockets; best-available mode, orphan-seat rule, wheelchair and companion seats.
- Multi-event cart with a reservation timer, tariffs (reductions) chosen per seat, price matrix per
  category and tariff, order limits per order, category, tariff, access code and customer e-mail.
- Event page designer (blocks, info boxes, rich text), translatable event content (English and
  German UI), event duplication.
- Guest checkout plus optional customer accounts.

#### Virtual waiting room

- Redis-backed waiting room with the modes off, automatic threshold, scheduled pre-registration
  (FIFO or lottery) and access-code (VIP) modes; live position and announcements; signed,
  time-bound queue pass.

#### Checkout and payments

- PayPal (Orders API v2, server-side redirect flow, verified webhooks, automatic refunds).
- Bank transfer (Vorkasse) with a checksummed payment reference, deadlines, reminders and optional
  automatic cancellation.
- Bank reconciliation adapters: FinTS 3.0, finAPI (PSD2), camt.052/camt.053, MT940, CSV, ZIP
  uploads and an IMAP mailbox watcher; automatic matching and a review queue for unmatched,
  under- and overpayments.
- Cancellation of paid orders with refunds (automatic for PayPal, open-refund to-do list for bank
  transfers), tariff upgrades with additional payments, seat changes.

#### Invoices and accounting

- GoBD-oriented invoices with gapless numbers, credit notes and correction documents (PDF).
- Fees and tax rates configurable globally and per event.
- Accounting export: DATEV booking batch and simple CSV (invoices, credit notes, payments).

#### Tickets and wallet passes

- Ticket PDF designer with live preview; one PDF per order and single-ticket PDFs.
- Per-event Ed25519 signed QR codes that can be verified offline.
- Apple Wallet (`.pkpass`) and Google Wallet passes (optional, configurable).

#### E-mail

- Transactional e-mail with an outbox, SMTP settings with test mail, and a template editor (rich
  text and HTML, placeholders, per-event overrides, German and English defaults).

#### Admin portal and box office

- Role-based admin users with optional or mandatory TOTP two-factor authentication.
- Live dashboard, order and customer management (including GDPR export and erasure), box office
  (cash, card, complimentary) with immediate ticket printing, access codes, branding and all
  global settings in the UI.

#### Backups

- Scheduled database and file backups with retention, local storage and optional external
  S3-compatible target, and restore from the admin portal with maintenance mode and a safety
  backup.
- After a restore, pending PayPal refunds are reconciled with PayPal before any refund is sent;
  refunds made in the lost window are listed for review and can be recorded without paying out
  twice. Open seat charts disconnect during maintenance and resynchronise afterwards.

#### Check-in app (Android)

- Native Kotlin app (Jetpack Compose, CameraX + ML Kit, Room): device pairing via QR code,
  continuous scanning with configurable result colours per hint (valid, invalid, reduction proof,
  wheelchair/companion seat, wrong entrance, additional payment open), manual lookup and
  check-out.
- In-app update (download, checksum verification, system installer).
- Offline mode with local signature verification and a background upload queue.
- LAN sync through one master device in the venue network.
- Scanner device API, device management and APK distribution in the admin portal.

#### Operations

- Docker Compose stack (reverse proxy, web, realtime gateway, worker, PostgreSQL, Redis, object
  storage), health endpoints, versioning and release automation.
- Load test harness (`scripts/load/`) for seat rush, best available, waiting room and checkout
  with invariant checks; checkout is idempotent per cart and answers 503 `BUSY` under transient
  database contention.

### Known limitations / not yet verified in production

- FinTS, finAPI and IMAP integrations are tested against simulations only, not against a live
  bank or mailbox; chipTAN optical (flicker) is not supported.
- Apple Wallet with a real Pass Type ID certificate is not verified (Google Wallet works in demo
  mode).
- The DATEV export has not been test-imported by a tax advisor.
- Backups to an external S3-compatible target are not verified against real providers.
- Camera scanning is verified on one device only; the LAN master mode of the Android app is not
  yet verified on real devices.
- The load test (`scripts/load/`) has been run on a single machine only (up to 1,200 simulated
  users); production capacity depends on the server and the database pool size.
