# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with pre-release tags
(`alpha.N`, `beta.N`, `rc.N`). See [docs/RELEASES.md](docs/RELEASES.md).

## [Unreleased]

## [1.0.0-alpha.16] - 2026-11-13

### Added

- Responsive images: uploaded public images (event covers, venue backgrounds, logos, e-mail images)
  are converted to AVIF and WebP variants in several widths (320–2560 px, never upscaled). The shop
  (event cards, event cover, start page, logo) and the admin media library / event list use them
  through `<picture>`; `/api/media/<id>?w=<width>&f=avif|webp` serves them with strict parameter
  validation and immutable caching once an asset's variants are complete (briefly cached
  stand-ins while the worker is still converting). The variants are generated in the background by
  the worker right after the upload (the upload request itself only normalises the original and
  queues a job); an asset whose conversion keeps failing is given up on after three attempts and
  keeps being served as the original. The stored original stays PNG / JPEG (WebP uploads are converted
  to JPEG / PNG), so ticket PDFs, wallet passes and e-mails keep working. Existing images are converted in the background by the
  worker (new queue `media`). The media library shows the storage used by the variants.
- Existing images are cleaned once in the background: the stored originals of all earlier uploads
  (also ticket backgrounds, wallet images, logos and e-mail images) are auto-oriented, stripped of
  metadata (EXIF, GPS position, XMP, IPTC) and WebP files are converted to JPEG / PNG, exactly like
  new uploads. Changed files are written to a new object (the old one is removed afterwards), the
  image variants are regenerated when the orientation changed, files that are already clean stay
  byte for byte. The original under `/api/media/<id>` now revalidates (hourly, ETag) instead of
  being cached for a year. Existing documents (tickets, invoices) are not touched.
- SEO: `robots.txt` (shop open; admin, API, cart, checkout, account and orders disallowed, also
  under the language prefixes; event images stay crawlable), a dynamic `sitemap.xml` (home, cookies
  page and every shop-visible event per language, with hreflang alternates and last-modified) and
  a web manifest with the shop name, theme colour and the configured favicon/logo. All URLs use
  the configured public URL (`PUBLIC_URL`); the unprefixed language follows the live default
  language setting.
- Shop home and event pages: canonical URL, hreflang links (including `x-default`), Open Graph and
  Twitter card metadata (translated title and description, event cover with size), `metadataBase`
  and the browser theme colour from the branding settings. Event pages carry schema.org `Event`
  structured data (dates with time zone offset, doors, status, venue with address and
  coordinates, organiser, the real customer price range over categories and tariffs, and
  availability, an ended sale is marked as discontinued rather than sold out) for search engine rich results.
- Install guide (English and German): new section "Behind Cloudflare" with the trusted proxy
  setup for Traefik, nginx and Nginx Proxy Manager and the matching `TRUSTED_PROXIES` line.
- Admin **Statistics** (`/admin/statistics`, event managers and finance): sales KPIs with
  comparison to the previous period (revenue gross / net of refunds, tickets, orders, average
  order value, tickets per order), revenue, tickets and orders over time, presale sales curve per
  event (cumulative tickets by days before the event), sales by price category, tariff, payment
  method, channel and block, a weekday x hour heat map, booking lead time, refunds and
  cancellations over time, new versus returning customers and customers who bought for several
  events. Filters live in the URL (today, 7 / 30 days, this year, custom range, events, sales
  channel, payment method), the bucket size follows the range (hour, day, week, month) and uses
  the shop time zone. Every chart has a data table, an accessible summary and works on a phone;
  the time series can be exported as CSV. All figures are aggregated in SQL and cached for 45
  seconds per filter; the definitions are explained in an info popover. Charts are dependency-free
  SVG and follow the light / dark theme (`--chart-1..8`).
- Admin **System** page (`/admin/system`, super admins): live status refreshed every 8 seconds with
  ten minute sparklines: application version, uptime and memory, PostgreSQL connections, size and
  longest query, Redis memory, clients, operations per second and hit ratio, BullMQ queues with
  the last failed jobs, waiting room and seat locks per event, connected realtime clients, workers
  and the loop leader, and backlogs (queued / failed e-mails, open refunds, unmatched bank
  transactions). The realtime gateway now reports a heartbeat to Redis (sockets per instance), so
  no network path from the web app to the gateway is needed; older gateway images show "not
  reporting".
- Optional Prometheus endpoint `/api/metrics` (text format, bearer token from Settings, Security,
  Monitoring; no token means 404, wrong tokens are rate limited) with the numbers of the System
  page. Monitoring section with a scrape configuration in the install guide (English and German).

### Changed

- Image uploads are decoded and validated (new error "image could not be read" for damaged files),
  auto-oriented by their EXIF orientation and stripped of metadata such as the GPS position when
  they contain any. Database migration 0033: table `media_asset_variants` and
  `media_assets.variants_processed_at` / `variants_attempts` / `master_sha256` (hash of the stored
  original, used to recognise re-imported seat plan images). The web image now ships `sharp` (new dependency of
  `apps/web`).

## [1.0.0-alpha.15] - 2026-11-13

### Added

- Settings → Checkout: optional maximum cart lifetime (5–1440 minutes since the first reserved
  seat). Adding seats still restarts the reservation timer, but never beyond this limit; the
  one-time extra checkout time comes on top and is not re-armed at the limit. Empty = off (as
  before); box office holds are not affected.
- Settings → Checkout: configurable per-IP safety nets for orders (default off) and seat
  selections (default 600 per minute); empty or 0 switches them off. The primary limits stay per
  browser. The settings page shows the IP address the server detects for the current request and
  warns when it looks like a proxy address (set `TRUSTED_PROXIES`, see the install guide). The
  order limit is only charged for requests that passed input validation.
- Cookie notice in the shop (information only: all cookies are strictly necessary) with a new page
  "Cookies" listing every cookie with purpose and lifetime plus a note on the short-lived
  processing of IP addresses for abuse protection. Linked in the shop footer. Settings →
  Appearance: switch the notice off or replace its text per language.

### Changed

- Database migration 0032: partial index on `orders.cart_session_id` for the checkout re-submit
  lookup, and a unique partial index on `bank_transaction_allocations.payment_id` (one allocation
  per payment; allocations are now created with `ON CONFLICT DO NOTHING`).
- SMTP and IMAP hosts that point at the stack's own services (`postgres`, `redis`, `minio`, `web`,
  `worker`, `realtime`, `proxy`), at loopback or at link-local / cloud-metadata addresses are now
  rejected. Private LAN addresses and `host.docker.internal` stay allowed (mail relay on the
  Docker host). A rejected SMTP host is logged as an error (throttled); the resolved service
  addresses are cached for about one minute.
- Bank review: an overpayment case on an already fully allocated transfer is no longer a dead end.
  The assign form is hidden, the affected orders are linked (refund the excess there) and the case
  can be closed with "Mark as resolved" (Finance role, audited). Re-running the matching keeps an
  overpayment case in review, and a transfer allocated for more than its amount is put back into
  review instead of being marked as matched.
- Cart: when a maximum cart lifetime is set and less than 30 seconds of it remain, adding seats is
  refused with a clear message.
- Checkout: stored phone number and billing address of a registered account are only filled in
  when empty, never overwritten.

## [1.0.0-alpha.14] - 2026-11-13

### Added

- Start page builder: position of the button (left, centred, right).

### Changed

- Shop event list: at most 6 events per row (stored higher values are treated as 6); at most 4
  columns on large screens below the widest breakpoint. Event cards adapt to their own width:
  narrow cards use a compact layout (status above the title, shorter date, tighter spacing), and
  with 1 event per row the card spans the full width with the cover image beside the text. Phones
  always show 1 card per row.

### Fixed

- Start page builder: the text block now uses the full page width.

## [1.0.0-alpha.13] - 2026-11-13

### Added

- Settings → Appearance: number of events per row in the shop event list (1–10, default 3; fewer
  columns on small screens).
- Media library: "Copy ID" on every image and "Copy URL" for public images.
- Every image field can reuse an image from the media library ("Choose from library") instead of
  uploading it again; private images (ticket backgrounds, wallet images) cannot be used in public
  places.
- Scan log (device page and event check-in tab): entries per page (5–100, default 25), page
  navigation and a search by order number, ticket code, seat and name.

### Changed

- Start page card: one language at a time with a content-language dropdown (default: shop
  default language), in the builder and in custom-HTML mode.
- Admin event list and dashboard "upcoming events": the whole row opens the event; buttons in the
  row (e.g. Duplicate) keep working.
- Wallet pass images must be PNG (Apple Wallet requirement) and show their error at the field.

## [1.0.0-alpha.12] - 2026-11-13

### Added

- Start page: besides the builder, the page can be filled completely with custom HTML and CSS
  (per language). Scripts, frames, forms and event handlers are removed; images from the media
  library can be inserted.

### Changed

- Dashboard "first steps": the collapse and hide buttons sit to the right of the title on wider
  screens and below it on phones.
- Admin event list: cover thumbnails keep their original aspect ratio instead of being cropped to
  16:9.

## [1.0.0-alpha.11] - 2026-11-12

### Added

- Customisable shop start page while no event is published (Settings → Appearance): headline,
  sub-headline, rich text, optional button, a main image and up to four gallery images, per
  language with fallback to the shop default language.
- The admin event list shows the event cover as a small thumbnail.
- The dashboard "first steps" card can be collapsed (remembered per browser).

### Changed

- The "first steps" card's hide button is clearer (outline button with a hint) and can be restored
  under Settings → General.
- The shop default language (Settings → General) now also decides which language has no URL prefix;
  the other languages use `/<code>/`.

## [1.0.0-alpha.10] - 2026-11-12

### Changed

- The rule "companion seats only together with their wheelchair space" is now on by default for
  new installations (Settings → Checkout; can still be changed globally and per event). The hint
  explains the exception (wheelchair space already sold to the same e-mail address) and that the
  rule is checked again before payment.

### Fixed

- An integration test of the FinTS TAN flow could fail by timing.

## [1.0.0-alpha.9] - 2026-11-12

The tag `v1.0.0-alpha.8` was never published (its release run stopped at the tests); this release
replaces it.

### Added

- PayPal settings: "Test connection" checks the saved client ID and secret (and the webhook ID).

### Fixed

- Rejected PayPal credentials were shown to buyers as "PayPal temporarily unreachable" and logged as
  an unhandled error. They now log a clear configuration error and buyers get a distinct notice.
- Restoring a backup that contains tickets failed with `relation "ticket_sync_version_seq" does
not exist` and was rolled back. Existing backups can be restored again; the ticket sync trigger
  now references the sequence with its schema (migration 0031).
- A PayPal payment approved by the buyer is no longer marked failed when the PayPal credentials
  are rejected at capture; it is captured once the credentials work again. Automatic refunds keep
  retrying instead of failing permanently.
- A restore could stop as "incomplete" when the last session-termination round hit the migration
  connection opened right after the database was replaced.

## [1.0.0-alpha.7] - 2026-11-12

### Added

- Check-in app: a small hint on the scanner screen when the app version differs from the server
  (update available, or server older than the app).

### Changed

- Ticket designer: the preview uses the same font (Noto Sans) as the PDF, so line breaks match.
- SMTP test e-mails: delivery errors are explained in the admin language (login, connection,
  timeout, host name, TLS, recipient) with the technical detail below.

## [1.0.0-alpha.6] - 2026-11-12

### Changed

- Check-in app: updates now install exactly the version of the connected server (from GitHub
  Releases or from your own server), and a newer app is never downgraded. The admin marks devices
  whose app version differs from the server. The update channel setting only applies to servers
  that do not report a version.

### Fixed

- Check-in app: "Read result aloud" did not speak (it relied on TalkBack). The app now reads the
  result itself with the phone's text-to-speech engine, on the notification volume like the tones;
  the setting shows a hint when no engine or voice is installed.

## [1.0.0-alpha.5] - 2026-11-12

### Fixed

- Check-in app: the scan result was not announced by TalkBack. The announcement is now an option
  in the app settings ("Read result aloud (TalkBack)"), off by default.

## [1.0.0-alpha.4] - 2026-11-12

### Added

- Setup checklist on the admin dashboard for new installations (organiser details, e-mail
  delivery, payment method, check-in server address, venue, published event, backups, two-factor
  authentication); it hides itself when everything is done and can be hidden and shown again.
- Translated error and "page not found" pages for the shop and the admin portal.
- Content-Security-Policy with a per-request nonce and `Cross-Origin-Opener-Policy`.
- Check-in app: database migrations are tested against the real schema of every version; the
  scan result is announced by screen readers.
- Check-in app on tablets and in landscape: navigation rail, camera and status side by side,
  content limited to a readable width.
- Structured JSON logs (pino) in the web app and the shared core, with secrets redacted, a
  request id set by the proxy (`X-Request-Id`) and the `LOG_LEVEL` setting.
- Browser end-to-end tests (Playwright) against an isolated stack built from the current code
  (`pnpm test:e2e`), also run in CI: seat selection, live seat updates, cart, checkout, admin
  pages, not-found pages and the Content-Security-Policy.

### Changed

- The check-in app's pairing starts with manual entry (the camera opens via "Scan QR code");
  the device name defaults to the name set in the phone's settings.
- `S3_PUBLIC_URL` is no longer needed (optional, ignored).
- `Strict-Transport-Security` no longer sends `preload` and `includeSubDomains`, so other
  subdomains of the organiser's domain are not forced to HTTPS.
- Check-in app: the result tone follows the notification volume instead of the media volume
  (still silent in silent and do-not-disturb mode); large system font sizes no longer push the
  result text off screen.
- Documentation overhaul: new README (English and German) with screenshots, a step-by-step
  server installation guide (`docs/INSTALL.md`, `docs/INSTALL.de.md`) with HTTPS variants and a
  troubleshooting table, documentation index, `SECURITY.md`, `CONTRIBUTING.md`, issue and pull
  request templates. The release guide no longer refers to `docker-compose.release.yml`.

### Fixed

- The ticket count in the admin order list was always 0.
- The connection count in the bank account list was always 0.
- The seat count per seating plan in the venue list was always 0.

### Removed

- `docker-compose.release.yml` (use the two-file release deploy).

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
