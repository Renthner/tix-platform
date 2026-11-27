# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with pre-release tags
(`alpha.N`, `beta.N`, `rc.N`). See [docs/RELEASES.md](docs/RELEASES.md).

## [Unreleased]

## [1.0.0-alpha.47] - 2026-11-27

### Added

- Shop page cache: the start page and event pages are rendered once and shared between anonymous
  visitors for a few seconds (per web process, single-flight; `TIX_PAGE_CACHE_TTL_MS`, default
  5000, `0` = off, at most 60000). Every response still gets its own CSP nonce and session cookie;
  signed-in customers and admins, bots, URLs with a query string and app-internal navigations bypass
  it. Flushed on every shop data or settings change and never kept past a sale-state boundary.
  Response header `x-tix-page-cache: hit|miss|bypass`, metrics `tix_page_cache_*`.
- Waiting room: optional server-wide cap of active shoppers across all events (Settings -> Waiting
  room, SUPER_ADMIN only; empty = off). Direct entry and the admission ticker respect it; freed
  slots are shared between events in turn. Events in mode Off and access-code bypasses are counted
  but never held back. The live dashboard shows the server-wide figure.
- Journey load test: page loads are sent like browser navigations, the run reports page cache
  hits / misses, and the default number of generator processes is at least the number of events.

### Changed

- Waiting room: the threshold is labelled and explained as active shoppers **per event**.

## [1.0.0-alpha.46] - 2026-11-26

### Added

- Journey load test: **several events in one run** (`--event-id a,b,c`, up to 20; optional
  `--event-weights`) with multi-event carts and orders (`--multi-event-ratio`, default 0.1), hot
  seats, leak check and hot-seat contention per event, and a per-event table / `events` in the JSON.
  See docs/LOAD-TEST.md.

### Fixed

- Journey load test: best available only picks categories where it is offered and that have at
  least two plain seats in best-available blocks (no more 403 `BEST_AVAILABLE_CATEGORY_DISABLED`).
- Journey load test: the fan-out probe paces its requests (at least 700 ms apart, 1 s pause after a
  refused seat, honours `retryAfterMs`), so it stays below the per-session limit (no more 429 on
  `PROBE_LOCK`).

- `demo-orders`: Vorkasse orders only go to events that currently take Vorkasse (events inside the
  "disable N days before the event" window get box office sales only), and seat picking skips
  categories without enough regular seats (e.g. a wheelchair-only category) and tries the next
  category instead of skipping the order.

## [1.0.0-alpha.45] - 2026-11-26

### Fixed

- Bank-transfer order confirmations and payment reminders are no longer sent when the order was
  paid (or cancelled) between queueing and sending; they asked for "0,00 €" (seen with demo data,
  possible with a fast bank match or a mail queue backlog). Such mails are retired as obsolete.

## [1.0.0-alpha.44] - 2026-11-26

### Update notes

- Migrations 0045 (Google Wallet image columns on wallet designs) and 0046 (two new e-mail
  template keys) run automatically; the new default templates are added on start.

### Added

- **Separate wallet images for Apple and Google**: the wallet design (global and per event) has an
  "Apple Wallet" section (logo, icon, strip image) and a "Google Wallet" section with an optional
  logo (square, ≥ 660 × 660 px; empty = shop logo), hero image (1032 × 336 px; empty = event cover)
  and wide logo / wordmark (empty = none). Google images are public (Google downloads them).
  Removing an image now also removes it from the Google pass class.
- **Customer e-mail change moves the orders**: when an admin changes a customer's e-mail address,
  "Also move the orders to the new address" (default on) moves every active order of an event that
  has not ended (not pending PayPal approvals, not orders with a PayPal additional payment in
  progress) with the same rules as the per-order change (old links stop working, open mails are
  re-created for the new address). Instead of one mail per order, the new address gets one summary
  with all order links and the old address one notice (new templates
  `CUSTOMER_EMAIL_CHANGED_ORDERS` / `CUSTOMER_EMAIL_CHANGED_OLD`).
- **Own account → Sessions**: "Sign out on all other devices" (keeps the current session).

### Fixed

- **Admin alert e-mails and the backup probe did not run since alpha.36** (worker log every 5 min:
  "ALERT_TEMPLATE_KEYS is not iterable" / "attemptKey is not a function"; also the manual restore
  probe): a dynamic import made the worker bundle skip the initialisation of some modules. The
  worker build now fails if this can happen again.
- Event mailings: the send button label ("Send…") looked like a running send while the button was
  only disabled because no recipient matched; it now says "Send", explains a count of 0 or a failed
  count, and is locked while a mailing is being sent (no double send).
- Event cancellation: the progress of a running cancellation is shown live and the page switches to
  the result by itself (before, it showed "a cancellation is running" until reloaded).
- "Sign out everywhere" on an admin user was only offered while the user had an active admin
  session; it is now available for every other active user.
- Lock order of buyer e-mail changes aligned with the payment confirmation (avoids deadlock
  retries).

## [1.0.0-alpha.43] - 2026-11-26

### Changed

- **Admin portal redesign** (structure and layout; colours and design tokens unchanged):
  - Navigation by work area (Events, Sales, On site, Finance) plus hubs for Design, Settings and
    System; command palette (Ctrl K) with page and settings search; old URLs redirect.
  - **Settings hub**: overview with search and status badges; one page per topic in collapsible
    groups with icons (open state remembered per user); header fixed, menu and content scroll
    separately. Fees & taxes and the waiting room moved into the settings; data retention moved
    from the customers page to Settings › System › "Data protection & retention" (also linked on
    the System hub).
  - **Event area**: event overview (KPIs, dates, quick links, publish card) with a side menu;
    details and status/publishing on their own pages; actions (duplicate, export) in a menu.
  - **Dashboard**: alerts, "Needs attention" (open to-dos only), KPIs, one events table with
    capacity bars, compact first steps. Test orders no longer count towards seats and check-in.
  - **Lists**: one filter bar everywhere (search, key filters, "More filters", removable chips,
    reset); filters apply immediately without an "Apply" button; status tabs; secondary row
    actions in a "⋯" menu; empty states.
  - **Detail pages** (orders, customers, discounts, users, bank accounts/connections/transactions,
    venues): main column plus aside; one primary action in the header, the rest under "Actions"
    in dialogs that cannot be closed while their action runs (prevents double submissions, e.g.
    recording a payment twice).
  - **Door check-in**: KPI strip with progress bar, guest cards in a responsive grid with full-width
    check-in buttons, result banner stays visible while scrolling.
  - Scanner devices: the per-event check-in links come first on phones.

### Fixed

- Event managers could save the global wallet design (now SUPER_ADMIN only; event designs
  unchanged).
- The customer's order count on the order page no longer includes test orders.

## [1.0.0-alpha.42] - 2026-11-25

### Update notes

- Migration 0044 adds the e-mail status `SKIPPED` (runs automatically).
- The bank-transfer confirmation and the payment reminder now contain a GiroCode (EPC QR code) via
  the new placeholder `{{paymentQrCode}}`. Unedited default templates are upgraded automatically;
  **edited templates and per-event overrides need `{{paymentQrCode}}` added by hand** (next to the
  bank details).
- Download the new `tix-update.sh` once; from now on it updates itself.

### Added

- **Demo orders for demo and test installations** (`docker compose run --rm tix demo-orders --yes-create-demo-data [--count 40] [--real a,b,c] [--events …] [--seed …]`). It creates regular orders through the shop and box-office code: unpaid and paid Vorkasse, multi-event orders, box office cash, card and complimentary sales, and reduced tariffs. It takes at most 40 % of the free capacity per event. Fake buyers are on `example.org`. Up to three real addresses get scripted orders and a ticket hand-over. Never use it in production: paid orders create invoices that cannot be deleted, so take a backup first. See docs/INSTALL.md.

### Changed

- **GiroCode in e-mails**: the bank-transfer order confirmation and the payment reminder show an
  EPC QR code (inline image, open amount, EUR only) that banking apps can scan.
- E-mails to reserved example domains (`example.com/.org/.net`, `.test`, `.invalid`,
  `.example`, `.localhost`) are never handed to SMTP: they are marked "not sent" (`SKIPPED`)
  without retries or admin warnings. A buyer e-mail change re-creates such mails for the new address.
- The shop order page now refreshes by itself while an order awaits payment (every 12 s while the
  tab is visible), whichever way the payment is recorded – also when an admin records it manually.
- `tix-update.sh` without arguments now also updates installations with an exact version in
  `TIX_VERSION`: a pre-release follows the newest release of its major version, a final version the
  newest final release of its major version, and the new version is written to `.env` (only that
  line). Before, the script re-installed the pinned version and nothing changed. After a successful
  update the script replaces itself with the checksum-verified `tix-update.sh` of the new release.

## [1.0.0-alpha.41] - 2026-11-25

**Update notes:** two database migrations (0042, 0043) run automatically on start. **IMAP bank import now requires a sender allowlist** (Banking → connection; without it the connection imports nothing and shows an error), and IMAP transactions are only matched automatically when the mail passed DKIM/SPF for the allow-listed sender domain – otherwise they land in the reconciliation queue (Klärfälle). See docs/DATABASE.md. Redis gets a memory ceiling (`REDIS_MAXMEMORY`, default 1gb, see below).

### Security

- Request bodies are size-limited (64 KB by default, larger only for checkout and template previews); the PayPal webhook reads at most a bounded body.
- Bank CSV export is protected against spreadsheet formula injection and audit-logged; camt files with DOCTYPE/ENTITY declarations or above 20 MB are rejected.
- Order links can be revoked: admins can reset an order's access links (old mail links stop working, the buyer gets fresh ones); existing links keep working otherwise.
- Login throttling per IP and per account, with a high account lock threshold so attackers cannot lock out real users.
- `/api/health` only reports the overall status publicly; details require the metrics token or an admin session. Ticket PDF and wallet downloads are rate-limited per order.
- Access code redemptions are unique per code and cart session (duplicates are cleaned up by migration 0042).

### Added

- **Event cancellation assistant.** Cancelling an event can cancel all its active orders automatically: PayPal payments are refunded automatically, bank transfers become open refund to-dos, buyers get a cancellation mail ("refund fees" is chosen per run, default yes). The run is resumable, shows its progress and ends "with errors" when orders are left over. Items of a cancelled event never get tickets; PayPal payments for them are refused, bank transfers go to the reconciliation queue and a paid order raises an admin alert. Holders of passed-on tickets get their own cancellation mail stating that the refund goes to the buyer. Requires migration 0043.
- **Buyer communication.** Postponement notice, messages to all buyers of an event (paid / active / one category, with test mail) and to a single order; new e-mail templates for cancellation, postponement, messages and e-mail changes. Postponement notices and event messages also reach holders of passed-on tickets (with their ticket link, never the order link).
- **Buyer e-mail can be corrected by an admin** (name and address stay unchanged). Old order links stop working, pending mails to the old address are retired and ticket / payment mails are re-created for the new address; the old address is informed without revealing the new one.
- **Admin lists and box office tools.** Orders list with sorting, date range, filter chips, CSV export and bulk actions (resend, payment reminder); test orders are hidden by default. Events list with search, sorting and sold count. New cash-up report (`/admin/cash-up`, by seller, payment method and currency, CSV) and door desk (`/admin/door`) for guest list check-in in the browser. Dashboard to-do tiles, audit history on event, customer and order pages, "sign out everywhere" for admins.
- **Shop.** Order lookup page (`/orders/lookup`, the order mail is sent again to the order's address), GiroCode (EPC QR) next to the bank details, reservation expiry warning, retry instead of endless spinners, price and subtotal in the seat selection, sticky mobile bar, touch-friendly seat plan, live connection notice, share button, event search and filters on the start page, upcoming orders first in the account with ticket download.
- **Accessibility.** Skip links, ARIA labels for navigation, waiting room, remove buttons and the checkout form (error summary, field descriptions, reasons for a disabled submit button), larger small text.

### Changed

- **Event managers may cancel paid orders and record payments.** Marking refunds as done, banking and accounting stay with the finance role (docs/ADMIN-SECURITY.md).

- **Redis memory ceiling now applies to existing installations on update.** `REDIS_MAXMEMORY` (default **1gb**) with the `noeviction` policy is part of the compose file: when Redis is full it refuses writes (seat selection and checkout fail) instead of evicting locks or jobs. A normal installation uses a few dozen MB, a large sale some hundred MB; if you expect more, set e.g. `REDIS_MAXMEMORY=2gb` in `.env` before updating (see the install guide, Redis memory).
- **PostgreSQL logs no bind parameters** (`log_parameter_max_length=0`, also on error), so slow-query and error logs contain no customer data.
- Seat engine: events with live locks are registered inside the Lua lock scripts and untracked atomically (fixes a race that could stop the sweeper from broadcasting releases). The seat engine scripts need a single-node Redis (documented).

### Fixed

- Realtime gateway: per-socket event rate limit, per-session connection cap, bounded per-socket maps; a flooding client can no longer affect other clients.
- Checkout re-validates the per-order category, tariff and ticket limits.
- Worker loop leadership is renewed after every step (lease 15 s) and a lost lease aborts the remaining steps.
- Checkout and box office re-check that the event is still on sale inside the order transaction (an event cancelled or paused in the same moment can no longer get new orders).
- Scanner app: only one ticket is accepted per camera frame, sync versions survive a server restore, the clock offset is monotonic, the LAN master remembers answered requests across restarts, LAN discovery and the LAN foreground service fail gracefully.

## [1.0.0-alpha.40] - 2026-11-17

Contains the admin portal reorganisation of 1.0.0-alpha.38 below. The tags `v1.0.0-alpha.38` and `v1.0.0-alpha.39` were created while the release pipeline was not ready and were never published; use this version.

### Fixed

- **Release pipeline checks (tests only, no change to the application).** The end-to-end colour-contrast test of the admin area no longer hangs after the menu reorganisation (it expands only the menu sections, not the language dropdown), and the payment reference fuzz test has an explicit timeout so it does not fail on slow CI runners.

## [1.0.0-alpha.38] - 2026-11-17

### Changed

- **Admin portal reorganised.** The sidebar is shorter: dashboard and box office stay visible, the other entries live in collapsible sections (Sales, Events & check-in, Design & content, Finance, Administration; the section with the current page opens automatically, open refunds show their badge on the collapsed heading). PayPal moved to the Finance section and opens only its own card.
- **Settings: one topic per page.** The settings tabs became a grouped, collapsible side menu with one card per page (27 pages instead of 13 tabs) and a search over page names and field labels. The URLs `appearance`, `payments`, `email`, `wallet` and `accounts` stay valid but now show only their first card; new pages: start page, event list, sponsors, seat colours, cookie notice, waiting list, ticket self-service, PayPal, e-mail header, Apple Wallet, Google Wallet, monitoring.
- Shorter menu labels and card descriptions (German and English); no function was added or removed.

## [1.0.0-alpha.37] - 2026-11-17

### Changed

- **Larger e-mail logo.** The configurable e-mail header logo height now goes up to 200 px (was 64) and the logo may be as wide as the mail content area (528 px); it scales down proportionally when the width limit is reached.
- **Price categories without a price get activated automatically.** A category created deactivated and without a price (seat plan swap, plan import, event import) becomes active and is offered in all tariffs as soon as a price above 0 is saved; existing matrix rows are never overwritten and deliberately deactivated priced categories stay untouched.

## [1.0.0-alpha.36] - 2026-11-17

### Added

- **Ticket design export / import.** A ticket design can be exported to one file (`*.tixticket.json`, images embedded, no database ids) and imported again as a new design (library, event or price category) – like seat plans. Strict validation, preview, documented in docs/TICKETS.md.
- **Event export / import.** A whole event (settings, texts and translations, seat plan, categories, tariffs, pricing matrix, fees, waiting room, page designer, ticket designs, images; no orders, tickets, customers or codes) can be exported and imported as a new draft event (`*.tixevent.json`). E-mail overrides are exported and imported by super admins only. Documented in docs/EVENT-TRANSFER.md.
- **Different seat plan for a draft event.** A draft event without orders, tickets or cart holds can swap its seat plan for a copy of another plan of the venue or an imported plan file; plan categories are matched by name, new ones start deactivated without a price.

### Fixed

- **Admin e-mail preview showed a broken logo.** Public media is now served with a cross-origin resource policy that allows the sandboxed preview and webmail clients to load it (private media stays same-origin).
- **E-mail header in Gmail / Outlook.** The centred logo is centred with a real table wrapper, the logo cell no longer crops the image in Outlook desktop (no zero line-height, explicit width/height attributes).
- **Backup alerts.** Enabling the scheduled backup no longer raises an immediate "missed" alert (only slots after the schedule was configured count; a separate `scheduleConfiguredAt` is set only when the schedule really changes). A successful backup clears the warning in the admin portal consistently with the "resolved" mail, a manual backup no longer makes the "missed" alert flap, and backup alert mails use the same HTML template as the other admin alerts (with a direct plain-text fallback if the database is down).

## [1.0.0-alpha.35] - 2026-11-16

### Added

- **Load test: payment receipt.** After a load run created unpaid bank-transfer orders, `scripts/load/bank-statement.mjs` writes ONE bank statement (camt.053, CSV or MT940, optionally split into several files) that pays them in a realistic mix (exact, typo-ed references, underpaid within / beyond the tolerance, overpaid, unknown reference, name only, duplicate payment, unrelated debits) together with an `expected.json`, and `scripts/load/verify-reconciliation.mjs` watches the automatic reconciliation (matching, orders PAID, invoices, tickets, e-mails queued by the worker) through read-only SQL, prints a timeline and timings and checks the result per scenario. `scripts/load/open-orders.sql` exports the open orders. The expectations are proven against the real import and matching engine by an integration test for all three formats. Documented in docs/LOAD-TEST.md / .de.md ("Payment receipt under load").

### Fixed

- **Bank reconciliation misread a hyphen-less payment reference.** The engine searched the remittance text and the end-to-end id as one concatenated string, so a reference typed without hyphens that was followed by an end-to-end id starting with a letter read as a digit (`O Q D I L S B Z`, e.g. `D4711...`) or by other words (`...5 OL-99`, `...5Danke`) took that letter for the check digit; the Luhn check failed and a correct transfer landed in "Klärfälle" as unknown reference. The remittance text is now searched on its own, and the end-to-end id separately, only when the remittance holds no valid reference of the generated form (6-digit number). Token boundaries: a look-alike letter counts as check digit only when no letter or digit follows it, and a long digit string is not a reference. With a separator typed between year and number only the longest split is read (a mistyped extra digit never becomes the valid reference of another order and still goes to review with a "one edit" hint); when year and number are typed together the 6-digit form is tried first, then the other splits, and the reference as typed stays visible as an invalid entry. A run of 7-10 digits followed by a set-apart check digit (`TIX20268312426 2 Karten`) is never re-split (it cannot be told from a mistyped extra digit, so it becomes a review case; `TIX2026386416 5` with exactly 6 digits before the gap still matches). The "extracted reference" of a review case shows what the payer typed. Found by the bank statement load test.

## [1.0.0-alpha.34] - 2026-11-16

### Changed

- Repository root tidied: `Dockerfile` and `deploy/` moved to `docker/` (`docker/Dockerfile`, `docker/deploy/`), `CONTRIBUTING.md` and `SECURITY.md` to `.github/`, `README.de.md` to `docs/de/README.md`, `tsconfig.base.json` to `packages/tsconfig/base.json`, `.dockerignore` to `docker/Dockerfile.dockerignore` (BuildKit), `VERSION` to `scripts/release/VERSION`, `e2e/` to `apps/e2e/`, `.env.example` to `docker/dev.env.example`, the Prettier settings into `package.json`. Build with `docker build -f docker/Dockerfile .`; `docker compose up -d --build` and all release assets are unchanged.

## [1.0.0-alpha.33] - 2026-11-16

### Fixed

- **Connection attempts silently dropped in a traffic spike.** Measured with 2,000 simulated users: the
  kernel counters `ListenOverflows` and `ListenDrops` were 600, exactly the number of `proxy web error
ETIMEDOUT` lines (a ~2 minute wait, then a 504). The built-in proxy opened up to 1024 simultaneous
  connections to ONE web process, which renders pages CPU-bound and could not accept them fast enough, so
  its accept queue (511) overflowed. The proxy now bounds the requests in flight per web process and
  request class (pages 16, API 96, assets 128 by default, far below 511), queues the rest and answers
  `503 BUSY` with `Retry-After: 5` when a request waits longer than the queue timeout (30 s pages, 10 s
  API/assets). Page renders can no longer starve API calls (seat locks, cart); the next request goes to the
  process with the fewest requests of its class. A client that gives up while queued leaves the queue.

### Added

- **Overload settings and counters.** `TIX_WEB_PAGE_CONCURRENCY`, `TIX_WEB_API_CONCURRENCY`, `TIX_WEB_STATIC_CONCURRENCY` (per web process) and `TIX_PROXY_QUEUE_TIMEOUT_MS`; `/__tix/health?detail=1` (loopback) lists queued, served and 503 BUSY per class and web process plus the kernel `ListenOverflows` / `ListenDrops`; the log shows `proxy overload: ...` (at most every 10 s) and a warning when the kernel dropped connection attempts. New section "Overload behaviour" in docs/INSTALL.md / .de.md.
- **Load test diagnostics: which component answered?** The journey test now keeps error samples (up to 3 per endpoint and status, with safe response headers and the first 200 body characters), groups network errors by cause (harness 30 s abort vs. connection-level), counts responses via Cloudflare and lists the remote addresses used, prints a 10 s timeline (requests, errors, p95, timeouts, active shoppers) and reports generator CPU and event loop lag; new flag `--ipv4-only`. The diagnosis flags status codes that were not produced by the app. Documented in docs/LOAD-TEST.md / .de.md.

## [1.0.0-alpha.32] - 2026-11-16

### Added

- **Large test seating plan for load tests:** `node scripts/load/make-seatplan.mjs` writes a seat plan file (default 3,600 seats in 7 blocks, 3 categories) for the admin seat plan import; documented in docs/LOAD-TEST.md / .de.md.
- **Finding the bottleneck of a load test.** `/api/metrics` and the System page (card "Web process
  load") now report per web process (label `pid`): `tix_db_pool_connections{state="total|idle|waiting"}`,
  `tix_db_pool_max`, `tix_event_loop_lag_seconds{quantile="0.5|0.99|max"}` and
  `tix_process_cpu_seconds_total`. When the database is so busy that the full scrape takes longer than
  4 s, the endpoint answers only these in-memory figures (`tix_scrape_degraded 1`). The journey load test
  samples them every 5 s (peak per metric and process), prints bytes received in total and per second,
  timeouts per endpoint and a "diagnosis hint" (database pool, event loop or network path). New section
  "Finding the bottleneck" in docs/LOAD-TEST.md / .de.md.

### Fixed

- **Dialogs no longer scroll sideways:** the shared dialog keeps its content within its width (long text wraps), and the restore dialog is wider (the upload dialog slightly), so a restore from another system scrolls vertically only.
- Journey load test: a release request (`UNLOCK`, `CART_CLEAR`, `PROBE_UNLOCK`) that timed out was treated as
  "seat stays held forever", so a later legitimate lock by another session was reported as a double booking.
  Holds now end at the moment the release was sent; overlaps that only exist if a timed-out release is
  assumed never to have happened are reported as a warning ("indeterminate", with details in the JSON) and
  no longer fail the run. A best-available answer without a usable body is counted as an endpoint failure
  instead of a journey error.

## [1.0.0-alpha.31] - 2026-11-16

### Changed

- **Behaviour change: the waiting list is shown by default only when really sold out.** Until now the banner
  appeared as soon as no seat of a category could be selected, also while the seats were merely held in other
  visitors' carts (which may expire again). The new setting Settings → Waiting list → "Show the waiting list"
  defaults to **"Only when sold out"**: seats under a cart lock still count as available, so buyers do not give
  up too early. The previous behaviour stays available as "As soon as nothing can be selected", globally and per
  event (tab "Sales": inherit / own value). Notification e-mails are unaffected: they go out as soon as tickets
  can be bought again. Upgrade note: installations that relied on the old behaviour switch the setting.
- **The waiting-list banner is a block of the event page designer** (tab "Shop page", "Waiting list"): movable
  by drag and drop, single or wide, next to other blocks, stacked on mobile. Events saved before this release
  keep the banner where it was (above everything else). The per-event switch still decides whether the waiting
  list is offered; a hidden banner leaves no gap in its row.

- Waiting list: signing up with an address that is already confirmed gets the same answer as a new sign-up
  (no second e-mail, nothing revealed about membership); simultaneous identical sign-ups no longer fail. The
  confirmation page says so when tickets are available right now (with a link to the event), and a failing
  availability check no longer breaks the confirmation link. The sign-up form stays put while a visitor types.
  Deleting a price category that has confirmed waiting-list entries now names their number and requires an
  explicit confirmation (recorded in the audit log).

### Added

- **Database connection budget (`TIX_DB_CONNECTION_BUDGET`, default 90).** All database connections of the
  container are kept within the budget: when `TIX_WEB_PROCESSES` and the pools would exceed it, the pool of each web
  process is reduced (at least 2, with a startup warning naming the numbers); if even that does not fit, startup
  is refused with a request to reduce `TIX_WEB_PROCESSES`. **Upgrade note:** `WEB_DATABASE_POOL_MAX` is now
  explicitly **per web process** (multiplied by their number; the budget clamps the total). The statistics queries
  take at most a quarter of a process's pool.
- **Several web processes in the single image (`TIX_WEB_PROCESSES`).** The web part used one Node.js process and
  therefore about one CPU core, so a bigger server did not help at 1,000 simultaneous shoppers. `TIX_WEB_PROCESSES=<1-16>`
  or `auto` (the CPUs the container may use, honouring a Docker CPU limit, at most 8) starts that many web processes behind
  the built-in proxy, which spreads requests by fewest requests in flight, skips a restarting process (body-less requests
  refused by one process move to another, a reset on a reused connection is retried once on the same process only,
  requests with a body never; a process that exited is out of the rotation until its health check passes) and shows the "Starting" page only when no process is up. Each
  process is restarted on its own; `/__tix/health` stays healthy while at least one is ready (status `degraded` while some are not;
  the process counts are only in `/__tix/health?detail=1` from loopback, not in the public answer). The database pool budget of 20 is divided by the process count (an explicit
  `WEB_DATABASE_POOL_MAX` applies per process); startup warns when the heap limits exceed the
  container memory limit. Default is `1` (unchanged). Measured on one machine with 600 simulated shoppers and a 4-CPU
  container: cart p95 1.5 s with one process, 0.11 s with three. See [Scaling to more cores](docs/INSTALL.md#scaling-to-more-cores).
- **"Any category" on the waiting list.** The sign-up form always offers "Any category – notify me for every
  category" (preselected when the whole event is out) next to the sold-out categories, in one banner. An entry
  without category is notified when at least one category has enough tickets for the requested number. One
  address can hold an entry per category plus an "any" entry; it receives at most one e-mail per availability
  wave (the earliest matching entry wins, the others wait for the next wave). An "any" entry that is already
  servable when it is confirmed does not fire immediately. The admin list, the CSV and the data export show
  "any".
- The banner appears and disappears live from the realtime seat deltas (no extra requests). Realtime seat deltas
  carry a new optional `gaOpen` field (sellable standing capacity without cart holds).
- Migration `0041_waitlist_trigger_any_category`: `events.waitlist_trigger`, one waiting-list entry per event,
  address **and category** (unique index) and entries of a deleted price category are now deleted with it
  (previously they turned into "any" entries, which could collide).

### Fixed

- **Dialogs scroll** when their content is taller than the screen (the restore dialog could not be scrolled): the shared dialog is limited to the viewport height and scrolls inside.
- **Dev compose** (`docker-compose.yml`, from-source stack) passes `TIX_ALLOW_FOREIGN_BACKUP_KEYS` and `TIX_ALLOWED_HOSTS` to the container; a `.env` entry alone did not reach it.
- **`pnpm db:demo`** no longer mixes the root `.env` into an explicitly given `DATABASE_URL` (its `REDIS_URL` pointed the cache flush at another stack).

## [1.0.0-alpha.30] - 2026-11-16

### Upgrade note

- **Pre-release numbering widened:** `alpha.N` may now go up to 49 (beta `1-19`, rc `1-19`; Android version codes of released alphas are unchanged). The check-in app of **alpha.29 and older cannot parse `alpha.30`** and therefore does not offer it as an automatic update: install the alpha.30 APK once by hand (admin → Scanners or the GitHub release); later updates work again.

### Added

- **Manual "Reconcile with PayPal" and clearer PayPal reconciliation after a restore.** Open refunds now has a
  button that compares all open PayPal refunds and all still refundable PayPal payments with PayPal on demand
  (finance / super admin, audited; automatic refunds pause until it is done, like after a restore) and a "Retry
  now" button while a reconciliation is pending. A restore into a system without PayPal credentials, or with
  rejected credentials, no longer loops with errors: the pass stops, shows a notice with the fix, marks nothing
  as failed and repeats automatically once PayPal is configured. Limit: PayPal offers no cheap time-based
  listing of payments, so a capture made at PayPal after the backup time but unknown here is not discovered by
  this comparison (see docs/BACKUP.md).
- **Realtime epoch after a restore.** The realtime gateway announces an opaque epoch (rotated when the Redis
  seat state is wiped by a restore) to every client on connect and to all connected clients when it changes.
  A browser that saw another epoch before drops its view of seats, locks and cart and reloads everything, even
  if it slept or was offline during the maintenance window. Reconnect and poll spreading now uses one tested
  helper.

### Fixed

- **Keyboard navigation across blocks in the seating plan:** the arrow keys were limited to one block. At the
  edge of a block they now continue into the neighbouring block in that direction (nearest seat within a 60
  degree cone by the real seat coordinates, so offset, staggered, rotated and curved layouts work). Ctrl+Home /
  Ctrl+End jump to the first / last seat of the whole plan; Page Up / Page Down still change the block.
  Standing areas are now keyboard controls on the plan too (Enter opens the quantity panel). Keyboard help text
  updated (EN/DE).

### Added

- **Configurable handling of full discounts (orders of 0.00).** Organisers now decide how the shop treats free
  tickets; the software takes no tax position (whether a free ticket is a gift without consideration is for each
  organiser's tax adviser). Settings → Checkout: policy "Full discounts" (`ALLOW` default = unchanged,
  `ALLOW_WITH_NOTE`, `DISALLOW`), "Minimum order total after discounts" (default 0 = unrestricted; `DISALLOW`
  always needs at least 0.01) and "Maximum percentage of a code" (default 100). A code that would push the total
  below the minimum is refused when entered and again at checkout (stacked codes are dropped from the last one;
  orders that are free without any code are never refused); percentage codes above the cap are refused in the shop
  and cannot be saved. The discount code form warns about 100 % / fixed amounts when the policy is not `ALLOW`.
  Settings → Invoices: "Invoice for orders of 0.00" (issue an invoice as before, or none), a translatable invoice
  note per language (frozen into the invoice text when it is issued) printed on invoices of discount-reduced 0.00
  orders under `ALLOW_WITH_NOTE`, and optionally on every discounted invoice. Admin → Accounting: leave 0.00
  invoices out of the simple documents CSV (the DATEV file never contains 0,00 bookings). No database migration.
  Docs: `docs/ACCOUNTING.md`.
- **Load test mode and journey load test.** Admin → System has a new card "Load test mode" (SUPER_ADMIN with a
  second factor or passkey, password re-entered): it creates a random token (shown once, only its hash is stored in
  Redis with a TTL) for 5 minutes to 4 hours, shows a banner in the admin while active and writes `loadtest.enable`,
  `loadtest.disable` and `loadtest.expire` audit entries (the expiry exactly once, by the worker or the System
  page). While active, requests carrying `X-Tix-Loadtest: <token>` skip only the per-IP throughput limits of the shop
  (`shop-ip` seat requests, `checkout-ip`, `enter-ip`, `realtime-token-ip`); login, two-factor, scanner, per-session,
  per-e-mail and per-code limits, seat locking, order limits and CSRF checks are untouched, and the header is ignored
  when the mode is off. New generator `scripts/load/journey.mjs` (several worker processes, ramp profiles, pages, waiting room, seat map, WebSocket fan-out latency, contention on hot seats, best available, cart churn, hot-seat
  exclusivity check, `/api/metrics` and `/__tix/health` snapshots, JSON + text report) refuses to run without `--yes`
  and the token. `docs/LOAD-TEST.md` rewritten for production-like targets (Cloudflare, Traefik, CrowdSec / fail2ban,
  `TIX_PROXY_MAX_CONNS_PER_IP`), German edition `docs/LOAD-TEST.de.md`. `pnpm test:load` runs its unit tests.

- **Bank statement import: camt.054 and MT942.** Debit/credit notifications (camt.054, versions .001.02 to
  .001.08) and SWIFT interim transaction reports (MT942) can be dropped into the file import, a ZIP or an IMAP
  attachment like any other statement; the format is detected automatically. Only booked camt.054 entries are
  imported (pending ones are reported and skipped); MT942 totals (`:90D:`/`:90C:`) are ignored. Duplicate
  detection works across formats, so a later camt.053 / MT940 of the same bookings creates no duplicates and
  leaves matching and allocations untouched. **MT942 entries are interim (often pending credits) and never pay
  an order:** they are stored as "interim (not booked yet)", are never matched, assigned or auto-fulfilled, and
  are linked to the final MT940 / camt booking (same IBAN, signed amount and currency, within 7 days, similar
  text) when it arrives, so the credit counts once. camt.054: entries without booking date and without bank /
  end-to-end reference are held ("needs review", release by hand); two identical-looking entries from different
  camt.054 files without a reference are stored as "possible duplicate – review" instead of being dropped (with
  different references both count); the same notification re-sent is recognised by its id; a camt.053 batch entry
  is not counted again when its payments were imported as camt.054 entries. No schema change (markers live in
  `raw_data`, status `IGNORED`); see `docs/DATABASE.md` for the guarantees and limits.

### Changed

- **Restoring a backup from another system works with equal key ids and can re-encrypt the secrets.** The key
  ring now keeps several candidate keys per id (decryption tries all, encryption always uses the first key of
  `APP_ENCRYPTION_KEYS`), so a source system that also uses `k1` is accepted; the "key id already used"
  rejection is gone. New: **re-encryption of all secrets with this system's key** - as a checkbox of the restore
  dialog (default on, runs as its own job after the restore) and as a standalone "Re-encrypt now" action on the
  Backups page (SUPER_ADMIN, password + second factor). A central secret registry (settings secrets, bank
  connections, ticket signing keys, scanner LAN secrets, admin TOTP secrets, queued e-mail variables) drives a
  batched, idempotent, verified routine; the additional keys are removed only when everything was converted and
  verified, rows no key opens are reported and left untouched. Tests fail when a new encrypted column or
  `encrypt(` call site is not registered. Counts per table are shown on the Backups page and in the
  `secrets.reencrypt` audit entry (no values, no key material). Clearer hints: when this system cannot read an
  uploaded or selected backup the dialogs and the status panel explain that it was made by another system and
  either ask for its `APP_ENCRYPTION_KEYS` or show the exact `TIX_ALLOW_FOREIGN_BACKUP_KEYS=1` line and the
  command to apply it (`docker compose up -d`, not `restart`). The opt-in stays off by default. No database
  migration. Docs: `docs/BACKUP.md`.

### Security

- **Load test mode needs a fresh second factor.** Enabling it required only that the account has 2FA; now the
  password **and** a fresh authenticator / recovery code or a passkey assertion (challenge bound to this action
  only) are checked, with the same shared re-authentication helper as restore and re-encryption. Docs updated.
- **Archives open with the configured keys only unless the foreign-key opt-in is on.** Additional keys already
  stored in the key file no longer decrypt backup archives (upload, restore, verify, probe) while
  `TIX_ALLOW_FOREIGN_BACKUP_KEYS` is off; the secrets stored in the database keep using them.

### Fixed

- **0.00 orders that later received real money get an invoice.** The "no invoice for 0.00 orders" policy is now
  decided on money, not on the payment method: a free order that was upgraded to a paying tariff and paid by
  PayPal / bank transfer (method stays FREE) is invoiced, also by the backfill.
- **A restore no longer silently loses secrets.** After every restore all stored secrets are opened with this
  system's keys; unreadable ones raise a persistent notice on the Backups page and an alert mail. Manifests list
  the key fingerprints their secrets depend on (restore dialog notice, "check key" shows what is still missing),
  "Re-encrypt now" shows how many catalogued backups reference the keys to be removed and needs an explicit
  acknowledgement, the probe's deep check opens the secrets of its copy, and the re-encryption queued after a
  restore is retried while the operation lock is busy and shows a "pending" notice meanwhile.
- **Sent e-mails no longer overwrite re-encrypted variables.** Marking a mail as sent merges only the new keys
  in SQL, so a re-encryption between reading and writing is never undone.
- **Load test mode writes its audit entry reliably.** Enabling rolls back if the entry cannot be written, ending
  keeps the run until the entry is stored, and a late bypass counter gets a TTL. `scripts/load/journey.mjs`
  checks the database in a read-only session and refuses private / LAN database hosts without `--allow-private`.
- **Discount minimum total blames the right code,** and the percentage cap help text says it applies per code.

## [1.0.0-alpha.29] - 2026-11-16

### Changed

- **E-mail header is configurable** (Settings → E-mail → “E-mail header”, with live preview): the shop logo now
  sits directly on the brand colour by default (no more white box); alternatively no logo or a box with its own
  colour, corners and padding. Layouts: logo left / title right, logo only (the name is then only the alt text),
  title only, logo above a centred title; left or centred alignment; own logo height (16–64 px) and an optional
  dedicated e-mail logo (PNG/JPEG). Existing templates need no change (`{{shopHeader}}`).

## [1.0.0-alpha.28] - 2026-11-15

### Changed

- `keygen` now creates a random key id (`k` + 6 hex characters) instead of always `k1`, so independently
  set-up systems rarely collide when restoring a foreign backup. Existing `k1` keys keep working.
- The image keeps its server bundles read-only for the runtime user (only `/data` and `.next/cache` are
  writable); `.dockerignore` excludes `.env*` files in every directory. Documented the proxy variables
  `TIX_ALLOWED_HOSTS`, `TIX_PROXY_SOCKET_TIMEOUT_MS`, `TIX_PROXY_REQUEST_TIMEOUT_MS`,
  `TIX_PROXY_MAX_CONNS_PER_IP`, the startup warnings and the exact-address advice for `TRUSTED_PROXIES`.

- **One image instead of three, three services instead of nine.** TIX is published as the single image
  `ghcr.io/<owner>/tix` (shop, admin, realtime gateway and worker in one container, built-in proxy on
  port 8080) and `deploy/docker-compose.yml` now defines only `tix`, `postgres` and `redis`. There is no
  bundled Caddy any more (HTTPS is done by your own reverse proxy, `docs/INSTALL.md` shows Caddy, Traefik,
  nginx and Nginx Proxy Manager) and no MinIO by default: files live in the volume `tix-data`
  (`docker-compose.s3.example.yml` shows MinIO / S3). The required `.env` values are `APP_URL`,
  `POSTGRES_PASSWORD` and `APP_ENCRYPTION_KEYS` (`docker run --rm ghcr.io/<owner>/tix:next keygen`);
  `SESSION_SECRET` is generated when unset; the image is chosen by `TIX_VERSION` (was `TIX_CHANNEL`).
  **Set `TRUSTED_PROXIES` behind a reverse proxy**, otherwise every visitor shares the proxy's address in
  the rate limits and the audit log. `create-admin` is now `docker compose run --rm tix create-admin ...`.
  The images `tix-web`, `tix-worker` and `tix-realtime` are no longer built or published.
- **Existing installations must not simply replace their compose file:** the new compose file refuses a
  `.env` of the three-image layout and `tix-update.sh` refuses an old compose file, both with a pointer to
  `docs/MIGRATE-SINGLE-IMAGE.md` (also in German), which moves an installation to the new image **keeping
  its PostgreSQL, Redis and MinIO volumes** (S3 mode stays supported).
- Release assets: `docker-compose.yml`, `env.example`, `tix-update.sh`, the zip (now with
  `docker-compose.s3.example.yml`), APK and `SHA256SUMS.txt`; the images are signed with cosign as before
  (`cosign verify ghcr.io/<owner>/tix:<version>`).
- Supervisor tests and the new compose checks run in CI; the end-to-end suite builds the single image.
- Default disk alert paths now include `/data`.

### Security

- Restoring a backup of **another system** (entering that system's encryption key) is now disabled unless
  the operator sets `TIX_ALLOW_FOREIGN_BACKUP_KEYS=1` (or `true`). A restore feeds the archive's SQL to
  `psql` as the database user, so with the feature on a SUPER_ADMIN who builds an archive under their own key
  has database-superuser power (`COPY ... PROGRAM`). The switch is enforced server-side (key staging, key
  check, upload key token, restore, worker); the dialogs show an explanation how to enable it and the risk.
- The built-in proxy no longer forwards a client-sent `x-middleware-subrequest` header, closes an HTTP/1.0
  connection that sent `Transfer-Encoding: chunked` after the response, answers a request with invalid framing
  exactly once (no second 400, pipelined bytes behind it are dropped) and counts IPv6 clients per /64 for the
  per-address connection cap.

### Fixed

- The additional-keys file (keys of another system after a restore) is written crash-safely (unique exclusive
  temp file, fsync, rename, directory fsync) and read back before the restore replaces the database. A broken
  file no longer crash-loops web and worker: an empty file means no additional keys (logged), a file that does
  not parse is logged and the processes continue with the configured keys, with an error that names the file
  when a key is missing.
- A backup no longer includes stored files whose object key the restore would reject (it would have made the
  whole backup unrestorable): such files are skipped, logged, recorded in the manifest and shown as a warning
  in the backup status. `copyBuckets` reports them as `rejected`.
- The "Check key" step tests only the pasted keys and says when the backup is already readable with this
  system's own keys.
- The proxy's per-address connection-limit message is throttled (one line per 10 s with a count) and, like a
  one-time warning when connections arrive from a private address with an empty `TRUSTED_PROXIES`, points at
  `TRUSTED_PROXIES`.
- The backup download route audits before it opens the stream. The one-off commands `migrate`, `seed` and
  `create-admin` no longer generate or persist a `SESSION_SECRET` nor need a writable `/data`; the
  supervisor's exclusive secret-file creation falls back to an exclusive create when hard links are not
  supported (EPERM, ENOTSUP, EXDEV, ENOSYS).

### Removed

- The bundled Caddy proxy (`docker/caddy`), the `storage-credentials` / `minio-init` / `migrate` services
  of the production compose file, the compose-embedding of config files (`compose-embed.mjs`) and the
  Dockerfile targets `web`, `worker` and `realtime`.

## [1.0.0-alpha.27] - 2026-11-15

### Added

- **Shop logo in the header of every e-mail:** the brand-colour band shows the logo (PNG/JPEG, on a small
  white chip) in front of the shop name; without a logo, or with an unsupported format, it looks as before.
  Unedited default templates upgrade automatically (new variable `{{shopHeader}}`); edited templates can
  replace `{{shopName}}` in their header with it.

## [1.0.0-alpha.25] - 2026-11-15

### Added

- **Passkeys (WebAuthn) for the admin login:** sign in with a passkey (usernameless, user verification
  required) or use a passkey as the second factor after the password, as an alternative to the
  authenticator app. Manage passkeys in the account (register, rename, remove); registering and removing
  need the password, and registering another one also needs an existing second factor. A "passkey added"
  e-mail is sent. Relying party and origin come only from `APP_URL` (HTTPS or localhost). Passkeys also
  confirm a backup restore. Reset of two-factor (admin and CLI) removes passkeys. See
  `docs/ADMIN-SECURITY.md`. Migration 0040 (not deployed).
- **Mandatory two-factor for super admins:** new security setting (default off); a passkey counts as a
  second factor.
- **Automatic probe restore:** the newest backup is restored into a throwaway database on a schedule
  (default **off**; needs free disk of about twice the database size), checked (migrations, row counts)
  and dropped again. Result and history on the backups page, "Run probe now", alert on failure. Scratch
  databases are tagged per stack and cleaned up at worker start.
- **Audit log** (`/admin/audit`, super admins): search, filters, date range, expandable details with
  secrets masked, CSV export.
- **Reports per event:** seating occupancy PDF for the entrance (sold / reserved / blocked / free,
  optional holder names) and guest list as CSV or PDF, on the Check-in tab.

### Changed

- Shop and admin order pages share one view model and common components.
- Large admin components (box office, ticket designer, fees, seat plan properties) split into smaller
  modules; no behaviour change.
- A failed backup alert is no longer hidden by a later verify or probe result; presale codes are masked
  in audit entries.

## [1.0.0-alpha.23] - 2026-11-15

### Changed

- **Ticket self-service after review:** once a ticket has been transferred only its current holder can
  pass it on (holder ticket page, same deadline / limits / policy); the buyer can no longer rename or
  re-transfer it. Admins can always intervene, including handing the ticket back to the buyer (admin
  "transfer" to the buyer's address). The buyer check covers the order e-mail and the owning account's
  e-mail. Hard caps (10 transfers per seat, 20 per order and 5 per recipient address per 24 h) apply
  regardless of the settings; neutral subject, escaped message with line breaks. Holders get "ticket
  updated" / "ticket no longer valid" e-mails (`TICKET_HOLDER_UPDATED`, `TICKET_HOLDER_CANCELLED`) on
  re-issue, cancellation, refund and reversal; refunds always go to the buyer. A bank allocation
  reversal followed by a new payment keeps holders and names. The old Google Wallet object is set
  INACTIVE. Event override "0 = unlimited changes". GDPR erasure finds holder mails by order and keeps
  the holder address of still valid tickets. "Resend tickets" and box-office counts include handed-over
  tickets. Migration 0039 extended (not deployed).
- **Discount codes after review:** re-submitting the checkout of a cart with a single-use code returns
  the existing order instead of "code already used" (the order of the same cart is not another use);
  the code endpoint has a per-IP limit; a fee reduced by a code is invoiced as one line (quantity in
  the description) so unit price x quantity equals the total; the invoice's discount line names only
  the codes that took something off that ticket (`order_items.code_discount_codes`); orders of 0 EUR
  get the payment method `FREE` (statistics no longer count them as PayPal).

### Added

- **Accessible seat selection (WCAG 2.2 AA):** the shop seating plan is now a keyboard widget. Tab
  enters the plan on the last focused (initially the first available) seat; arrow keys move to the
  neighbouring seat (same row left/right, row above/below nearest by x), Home/End jump to the row
  ends, Page Up/Down change the section, Enter/Space select or release a seat (same server calls and
  rules as a click), Escape leaves the plan, +/- zoom. The focused seat is panned into view and has a
  visible focus ring (dark ring with white halo on the always-light sheet). Every seat has an
  accessible name (block, row, seat, wheelchair/companion type, category and price range, state
  available/selected/not available); a polite live region announces selections, releases and errors,
  and realtime changes of the focused seat only. Decorative plan layers are hidden from screen
  readers. New "List instead of plan" view: sections, rows and available seats as buttons with a
  category filter and a wheelchair/companion filter, sharing the selection with the plan. Zoom
  changes are instant, so `prefers-reduced-motion` needs no special handling (en/de).
- **Admin warning e-mails:** a worker job (every 5 minutes, leader-elected) checks for failed or overdue backups, low disk / storage, failing background jobs or backlog, undeliverable e-mails, old bank review cases, failing bank sync or pending TAN, PayPal credential errors and failed refunds, open manual refunds and (opt-in) updates. Each admin chooses the warnings on the account page (role defaults: super admin everything except updates, finance the money topics, event managers none). Thresholds, cooldown, hourly cap, digest time and a master switch live in Settings → Notifications; the texts are editable e-mail templates (`ADMIN_ALERT`, `ADMIN_ALERT_RESOLVED`, en + de); a short "resolved" mail follows when a warning clears. The System page lists the last 50 warnings. Migration 0039.
- **Waiting list:** a sold-out event (or a sold-out price category) offers "Join the waiting list" on
  the event page: e-mail, optional name, number of tickets, optional category. Double opt-in
  confirmation e-mail; per-IP, per-session and per-address limits plus a honeypot (no captcha). The
  worker checks events with confirmed entries (debounced per event, setting "Availability check
  interval", default 2 min) and, when tickets become available again (cancellation, expiry, refund,
  released or added seats), notifies every matching entry at once - first come, first served, no seats
  reserved. An entry is notified at most once per availability wave (it is re-armed when its wish is
  sold out again, with a configurable pause), is removed once the address bought, and stays on the list
  otherwise. Admin: Settings -> Checkout "Waiting list" (global default on), per-event override and
  entry list with CSV export, "Notify now" and removal in the event tab "Sales". E-mail templates
  `WAITLIST_CONFIRM`, `WAITLIST_AVAILABLE`, `WAITLIST_REMOVED` (en/de, editable). Privacy: entries are
  deleted by the retention job once the event started (unconfirmed ones after the confirmation period),
  with the customer erasure, via the unsubscribe link and admin removal; they are part of the GDPR
  export; removals are kept as bare ids in the `retained` ledger so a restore re-applies them.
  Migration 0039.
- **Add to calendar and directions:** `/api/events/<id>/calendar.ics` and
  `/api/orders/<id>/calendar.ics` (RFC 5545, UTC times, folded lines, escaped text, organiser, event
  page URL, coordinates), "Add to calendar" on the event page, and calendar (.ics), Google Calendar and
  directions buttons on the shop order page and in the ticket e-mails. New template variables
  `{{calendarLinks}}` and `{{directionsUrl}}` (default "payment received" and "tickets resent"
  templates; unedited earlier defaults are upgraded by fingerprint). New setting General -> "Calendar
  entry length" for events without an end time. The venue map link helper is shared (`venueMapsUrl`).
- **Discount codes** (admin -> Discount codes, EVENT_MANAGER / FINANCE): fixed amount per order or percent of the eligible ticket prices; scope all / selected events, optional price categories and tariffs; validity window, max. total uses, max. uses per customer e-mail, minimum value, optional discount on fees, stackable (default: one code per order), internal note; bulk generation of single-use codes with CSV export; usage list and statistics per code. Shop: "Discount code" field in cart and checkout with translated errors; the discount is its own line in cart, checkout, order page, e-mails and the invoice PDF. Usage limits are enforced atomically when the order is placed (code rows locked, one winner for the last use); cancelled / expired / fully refunded orders release the use; test orders never count. Orders that cost 0 EUR (100 % discount) are paid immediately without payment reference. Migration 0039 (`discount_codes`, `order_discounts`, `code_discount_*` columns). Accounting: revenue is booked net of discount, see docs/ACCOUNTING.md.
- **Customer self-service for tickets:** buyers can change the attendee name of a ticket and pass a
  ticket on to someone else from the order page (new QR code, the old one is rejected RED at the
  entrance after the next scanner sync; recipient gets a ticket-only link by e-mail). Off by default;
  global setting (Settings → Customer accounts) with deadline and change limit, per-event override in
  the Sales tab. Admins can do both without limits; the admin order page lists the history. Migration 0039.

## [1.0.0-alpha.22] - 2026-11-14

### Added

- **Android app, slow network at the door:** after a server timeout or connect failure the link is
  DEGRADED and scans go straight to the LAN master / local verification (no per-scan wait, decision
  rules unchanged). A background probe (conditional manifest request, 1.5 s) restores ONLINE; its
  backoff is 30 s, doubling up to 5 min, reset on success. The scanner status shows "Slow connection -
  checking locally" (en/de).
- **Android app, LAN master:** holds WiFi locks (low latency on API 29+, plus high performance on API
  28-33, which keeps the radio awake with the screen off) and a partial wake lock while master mode
  runs; the wake lock's 12 h safety timeout is renewed hourly. Released on stop and crash paths;
  Settings -> LAN offers a one-tap "allow background use" (battery optimisation) button. Keep the
  master plugged in, screen on recommended (docs).
- **Android app, attendee search:** the offline lookup uses a Room FTS4 index over a folded text column
  (case, diacritics and letters without a decomposition such as ø, æ, ß, ł: "soren" finds "Søren")
  with word-prefix matching and ranking (exact ticket code or order number, code / order number
  start, name, seat). 1-2 character queries use whole-word and 2-letter-prefix full-text queries, so
  seat lookups ("b 7", "a 12", "12") and short surnames that are not the first word ("li" for "Wei
  Li") work. **Order number:** the scanner sync now delivers each ticket's `orderNumber` (additive,
  optional field; older apps ignore it) and the app searches it ("000123", "2026-000123" or the full
  number; the leading words alone never match). Database version 3 (migration 2 -> 3 adds the columns,
  builds the index from the existing tickets and resets the sync cursors so the next sync fills in the
  order numbers; no data is touched). Substring matches in the middle of a word ("ller" for
  "Muller") do not match.
- **Admin lists:** the customer list now has a page-size switcher (10/25/50/100, default 25),
  sortable columns (name, orders, last order, created) and a "created" column; search covers name
  (either order), e-mail, phone and company. Migration 0038 adds trigram indexes on e-mail, phone
  and "last first" name so the search stays fast with many customers. The event list is paged on the
  server (it was capped at 500 rows). Orders, customers, events, media library and the scan log
  share one pagination component and query helper.
- **Unsaved-changes guard** for the e-mail template editor, the rich-text settings forms (start
  page, branding/footer, SEO, event details, event page designer, translations), the ticket
  designer and the seat plan editor: reload/close shows the browser prompt, clicking an internal link
  shows an in-page "Discard unsaved changes?" dialog.

### Changed

- **Android app, LAN master:** enforces the check-out permission itself (the master's own event flag)
  instead of trusting the client; a forbidden check-out is answered `REJECTED_CHECK_OUT_NOT_ALLOWED`.
  A check-out reported by another door after an outage (`/scans`) is ignored the same way.
- **Android app, slow network:** the probe loop starts independently of app initialisation and survives
  a cancellation raised inside the probe request; the link state is updated atomically; the unknown
  signing key refresh also runs while the link is DEGRADED.
- Remaining native `confirm()` prompts in the admin (customer login removal, user operations,
  ticket template deletion, metrics token removal, block to standing area, editor leave) are
  in-page confirmation dialogs with translated, destructive-styled buttons.

## [1.0.0-alpha.21] - 2026-11-14

### Added

- **Container hardening** (both compose files): log rotation for every service
  (`LOG_MAX_SIZE` 10m, `LOG_MAX_FILES` 5), `no-new-privileges`, all Linux capabilities dropped for
  web, worker, realtime, migrate, storage-credentials (only CHOWN/FOWNER/DAC_OVERRIDE) and proxy
  (only NET_BIND_SERVICE), memory ceilings for the app containers (`WEB_MEMORY`, `WORKER_MEMORY`, `REALTIME_MEMORY`,
  `PROXY_MEMORY`, `MIGRATE_MEMORY`; Redis, Postgres and MinIO have none unless you set
  `REDIS_MEMORY`/`POSTGRES_MEMORY`/`MINIO_MEMORY`) and a process
  limit (`APP_PIDS_LIMIT`). All have generous defaults; existing installations keep working with the
  new compose file without `.env` changes.
- **Safe migrations:** a table-lock timeout (`MIGRATION_LOCK_TIMEOUT`, default 10 s) with retries and
  a log line naming the blocking table and session, a statement timeout, and an automatic encrypted
  **database backup before pending migrations** of an existing installation (Admin -> Backups, type
  "Before update"; newest 3 kept; fallback file in the volume `pre-update-backups`; no backup, no
  migration; `SKIP_PRE_UPDATE_BACKUP=1` opts out). Restoring such a backup replaces only the database.
  Upgrading from an older release: replace `docker-compose.yml` with this release's file (or run
  `tix-update.sh`) to get the pre-update backup; the new image with an old compose file warns and
  migrates without a backup instead of failing.
- **Update notice** on the super admin dashboard when a newer release exists for the installation's
  `TIX_CHANNEL` (GitHub Releases API, server-side, at most every 6 hours, switchable and repository
  configurable in Settings -> General), and a warning when `docker-compose.yml` is older than the
  running app (`TIX_COMPOSE_VERSION`).
- **`tix-update.sh`**: release asset that downloads and verifies the compose file of a version or
  channel, keeps a timestamped copy, pulls the images and restarts the stack (`--dry-run`).

### Changed

- The Redis image is pinned to `redis:8.10-alpine` (was the floating `8-alpine`): the corrupt-AOF-tail
  directive needs Redis 8.4+, and Redis cannot read data written by a newer version, so the pin is the
  version `8-alpine` resolved to when this was added.

### Fixed

- Redis survives a crash or power loss: a corrupt tail of up to 4 KB in the append-only file is
  discarded on start instead of blocking the whole stack (`aof-load-corrupt-tail-max-size`); install
  guide troubleshooting row for larger damage.

## [1.0.0-alpha.20] - 2026-11-14

### Added

- Price categories: switch **"Offer best-available booking"** (default on, in the category
  dialog of the event's Pricing tab). Off hides the category from the shop's best-available
  dropdown (and the box when no category remains) and the server refuses best-available for it;
  manual seat selection is unaffected. Migration 0037 (`price_categories.best_available_enabled`);
  the public seat map format is bumped (6), event duplication copies the switch.

### Changed

- Shop header reworked: logo and sponsors on the left (sponsor label now sits small and centred
  **above** the banner, also on phones), one consistent 36 px control group on the right
  ("Events" is a proper navigation item with icon; account, cart, language, theme and admin share
  the same height; labels collapse to icons below 1024 px). The header is always a single row
  (never wraps): below 640 px language and colour
  theme share ONE "Language & appearance" menu button (theme items only when visitors may choose
  the theme, languages only with more than one language); from 640 px the two separate switchers.
  The logo/sponsor area shrinks instead of wrapping.
- Shop footer reworked for phones: compact stacked layout, readable line length, legal links as a
  wrapping row with separators, long URLs and e-mail addresses break instead of overflowing
  (fixes horizontal scrolling on phones); the cookie notice stacks its button on phones.

## [1.0.0-alpha.19] - 2026-11-14

### Added

- Settings → Appearance, **colour theme of the shop**: visitors choose (with a default of device
  setting, light or dark for visitors without a choice) or the theme is fixed to always light /
  always dark. With a fixed theme the shop renders it regardless of the visitor's cookie and hides
  the theme switch (also in the shop admin dropdown on phones). The admin portal is not affected.
  The proxy tells shop and admin apart (`x-tix-area` header; the client re-evaluates on navigation).
- **Sponsors** in the shop header (setting `sponsors`, Settings → Appearance): several sponsors rotate
  directly next to the logo (desktop and phones alike; the nav link and the controls follow). Per sponsor an image (media library), alt text per language,
  an optional link (https or shop path, new tab, `rel="noopener sponsored"`) and its own display time
  (1-120 s, default 5); global switch, banner height (slider + free number input), optional label per
  language and ordering with up / down buttons. Smooth fade, pauses on hover and focus, no automatic
  rotation with `prefers-reduced-motion` (previous / next buttons instead), not a live region.
- Logo height in the shop header is configurable (slider 24-96 px plus a number input up to 200 px);
  phones show it at 75 % (at most 56 px) and the header grows with the logo.
- E-mail addresses and `mailto:` links on shop pages are wrapped in Cloudflare's
  `<!--email_off-->` comments at render time, so Cloudflare's e-mail obfuscation no longer breaks
  them behind Cloudflare (see docs/INSTALL.md, "Behind Cloudflare"). New e-mail variable
  `{{brandColor}}` and `{{brandForegroundColor}}` (black or white, whichever reads better on the
  brand colour).

### Changed

- **Android app build:** `compileSdk` raised to 37 (platform `android-37.0`, `targetSdk` unchanged at 36) so
  current AndroidX releases build again; updated navigation-compose 2.10.2, Compose BOM 2026.09.00,
  core-ktx 1.19.1, Ktor 3.6.1, BouncyCastle 1.87, Robolectric 4.17 and Gradle 9.9.1. CI and release
  workflows install the 37.0 platform; the Dependabot AndroidX ignore rules were removed.
- **One brand colour** replaces primary + accent colour (setting `branding.brandColor`; stored
  `primaryColor` values are migrated, `accentColor` is dropped). It drives the primary / ring tokens
  of the shop (buttons, links, active and selected items, focus rings, progress bars, shop name), the
  buttons and links in e-mails, the wallet pass fallback colour and the `theme-color` of the browser
  (light: the brand colour, dark: the dark page background, `#0a0a0a`). An optional dark-theme colour can be set; without it a dark
  variant is computed (OKLCH lightness raised until contrast is at least 4.5:1) and the text colour on
  the brand colour is chosen automatically. The settings page shows a live light / dark preview and
  warns when the colour has less than 4.5:1 contrast on white. The e-mail variables `{{primaryColor}}`
  and `{{accentColor}}` stay valid as aliases of the brand colour. The admin portal keeps its neutral
  palette. Text on e-mail buttons and the e-mail banner follows the brand colour automatically
  (`{{brandForegroundColor}}` instead of a fixed white); unedited default templates are upgraded,
  edited ones stay untouched.

## [1.0.0-alpha.18] - 2026-11-14

### Added

- SEO settings in the admin (Settings → SEO, setting `seo`, super admin): a switch **Allow search
  engines to index the shop** (for test / demo servers: off sends `X-Robots-Tag: noindex, nofollow`
  and a `robots` meta tag on every page, `robots.txt` becomes `Disallow: /` without a sitemap,
  `/sitemap.xml` answers 404 and the structured data is omitted), a title pattern (`%s | {siteTitle}`),
  a site title and a default description per language, a default share image (Open Graph / Twitter),
  the Twitter / X account and Google / Bing site verification tokens. Events have a switch
  "Exclude this event from search engines" on the Sales tab (`events.seo_noindex`, migration `0036`):
  noindex, not in the sitemap, no structured data.
- Test purchases for super admins: a signed-in SUPER_ADMIN can open the shop page of a **draft**
  event (`/events/<slug>`, hidden from everybody else: 404, home list, sitemap, structured data,
  `noindex`) and buy like a customer – cart, seat selection, best available, standing areas,
  checkout and payment. A banner on the event page, cart and checkout says that the event is a draft
  and that orders are test orders; the event admin page has a "Test in shop" button. Draft data
  never enters the public shop cache. On **any** event super admins bypass presale, "not started",
  paused and ended online sale (until the event itself starts) and the waiting room (no queue slot,
  not counted as active shopper); the shop header menu has a "Test waiting room" switch to
  experience the queue like a customer. New staff cookie `tix_admin_queue_test` (listed on `/cookies`).
- Test orders (orders on draft events, migration `0035`, `orders.is_test`, `orders.test_hidden_at`,
  `events.had_test_orders`): own number series `TEST-<year>-<seq>`, never invoiced (no number from the
  gapless invoice series is consumed), ticket PDFs carry a TEST watermark, all e-mails get a `[TEST]`
  subject prefix and a banner, no Apple / Google Wallet passes, and they are excluded from statistics,
  the dashboard KPIs and customer history. Mixed carts (draft + published events) are refused. The
  admin order list shows a TEST badge and has a filter. Bank matching never proposes or auto-fulfils
  test orders (exact reference → review; manual assignment needs a confirmation).
  - A test order that never received money can be deleted completely by a super admin (single, or all
    of an event): items, tickets, payments, e-mail outbox rows, stored ticket PDFs and access-code
    redemptions are removed, seats are released, scanner devices drop deleted tickets on their next
    sync. Once real money was captured it cannot be deleted any more (accounting): "Cancel & hide"
    cancels it through the normal refund flow and hides it from the default order list; its payments
    and refunds stay in the accounting / DATEV export, marked TEST (CSV column, booking text `TEST …`),
    never with an invoice or credit-note number.
  - A draft with active test orders cannot be published (test orders that were cancelled & hidden do
    not count); the publish dialog offers "Delete test orders & publish" (super admins, only while
    none held money) or cancel. When an event
    that had test orders goes live its ticket signing key is rotated, so test QR codes stop verifying.
- Dark mode in the shop and the admin portal. A theme menu (System / Light / Dark) sits in the shop
  header and the admin sidebar / top bar, next to the language switcher. The default follows the
  operating system (`prefers-color-scheme`); an explicit choice is stored in the strictly necessary
  cookie `tix_theme` (1 year, listed on the cookie page) so the server renders the right theme
  without a flash. The "System" case is resolved before first paint by a tiny inline script that
  carries the CSP nonce.
- Semantic colour tokens (`success`, `warning`, `info`, `danger`, solid destructive, `paper`) with
  dark variants; hard-coded status colours were replaced by them.
- Playwright `e2e/theme.spec.ts`: switch, persistence, OS default and an axe-core colour-contrast
  check (WCAG AA) of the shop and all admin pages in both themes. `scripts/e2e/run.mjs` accepts
  `E2E_PROJECT` (must start with `tix-e2e`) to run a second isolated stack in parallel.

### Changed

- Releases need only one CI run: the release workflow reuses the successful CI run of the tagged commit on `main` (waits for a running one, runs CI itself only if none exists; `force_ci` input to always re-run).
- The seating chart and the plan editor keep a light "sheet" in the dark theme (plan colours,
  symbols and background images are designed on white); the rest of the page is dark. The ticket
  designer paper, the e-mail editor / preview and QR codes also stay light.
- The custom HTML start page is rendered on a light sheet and is never themed (hint text updated);
  author-chosen text colours in rich text fall back to theme colours in the dark theme.
- Slightly darker light-theme muted and destructive text colours for contrast; the version label in
  the admin sidebar is no longer dimmed below AA.
- Standalone error and maintenance pages follow the operating system colour scheme.

## [1.0.0-alpha.17] - 2026-11-14

### Added

- Shop data cache for presale load: event pages, the shop home, queue texts and announcements,
  the public seat plan and media catalogue rows are served from a per-process cache (single-flight,
  tag invalidation, 60 s safety TTL) instead of the database. Admin changes (events, sales pause,
  prices, tariffs, seat plan, venues, symbols, translations, media, waiting room texts, settings,
  backup restore) are visible on the next page load on **all** web instances, because every change
  publishes an invalidation over Redis pub/sub; while that subscription is down entries live
  only 2 s (concurrent misses still share one load). Seat status, carts, the waiting room and sessions are never cached. The seat plan JSON
  is built once per plan version, price generation and locale and delivered with an ETag
  (`no-cache` + 304).
  Cache hit / miss counters on the System page and in `/api/metrics`. See
  docs/ARCHITECTURE.md ("Shop data cache") and docs/LOAD-TEST.md.

### Changed

- Shop pages are about half the size: the whole admin message catalogue (74 KB) was embedded in
  every shop page; only the admin menu and form feedback strings are sent now.
- **MinIO credentials are generated automatically.** The new one-shot service `storage-credentials`
  creates the MinIO administrator pair and the application's access key pair on the first start
  and keeps them in the Docker volume `storage-credentials` (existing files are never
  regenerated; the MinIO administrator pair is readable only by the MinIO containers, the
  application gets only its own pair, read-only). `web` and `worker` read `S3_ACCESS_KEY_ID_FILE` /
  `S3_SECRET_ACCESS_KEY_FILE` (a plain `S3_*` variable still wins). `minio-init` always sets the
  stored secret on the application user. **Existing installations:** keep `MINIO_ROOT_USER`,
  `MINIO_ROOT_PASSWORD`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` in `.env` for the first start of
  this version (the values are copied into the volume; afterwards they are optional). If they are
  removed before that, `storage-credentials` stops instead of inventing a new administrator
  password for existing MinIO data. The compose file changed: download the new
  `docker-compose.yml` of this release. A `MINIO_ROOT_*` value in `.env` that differs from the
  stored pair is refused (MinIO keeps its original root credentials). After changing the
  application key pair run `docker compose up -d --force-recreate web worker`. Rolling back across
  this release needs that release's compose file and the credentials in `.env` (INSTALL.md,
  Updates).
- **Minimal `.env`:** the release `env.example` lists only `PUBLIC_URL`, the address settings,
  `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `APP_ENCRYPTION_KEYS`, `SESSION_SECRET` and
  `TIX_CHANNEL`; everything else is an optional, commented-out block with defaults in the compose
  file (`TIX_IMAGE_OWNER` is no longer in the file).
- **Install guide restructured** (`docs/INSTALL.md`, `docs/INSTALL.de.md`, README quick guide):
  Part 1 is a one-screen quick start (download, one command for the `.env`, start, first admin,
  setup checklist, updating); Part 2 is the appendix (Docker installation, `.env` details,
  HTTPS variants incl. own reverse proxy and Cloudflare, first configuration, check-in phones,
  updates, monitoring, variable reference, troubleshooting incl. storage credentials).

### Fixed

- Prices and tariffs can never be served stale from the seat plan cache: price categories,
  tariffs, the pricing matrix and the currency carry a generation (database triggers, same
  transaction as the change) that is part of every plan cache key, and checkout, quotes and the
  box office read it from the database (migration 0034). A plan snapshot built while an admin saved a price is
  never looked up again, even if the post-commit invalidation fails.
- `?locale=` values other than the supported UI languages no longer create cache entries of
  their own (unknown values use the shop default language).
- Settings read while an invalidation arrives are no longer cached from the pre-invalidation
  load; a secret setting changed on another instance is refreshed as well.
- `pnpm db:demo` publishes a full shop cache invalidation (best effort) when Redis is reachable.
- Changing a setting on one web instance now reaches the others within a second (the
  invalidation was published but never consumed; they used to catch up after up to 10 s). The
  shop default language of the URL rules follows the same way.
- The seat plan response is no longer cached by browsers for 30 s: after a price change the
  next load shows the new prices.

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
