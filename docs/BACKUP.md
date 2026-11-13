# Backups and restore

Admin area: **Backups** (SUPER_ADMIN only). Everything is configurable there; nothing is hard-coded.

## What is backed up

One encrypted archive per backup:

- the PostgreSQL database (`pg_dump -Fc`, taken inside one exported snapshot so row counts and dump agree),
- every object of the **assets** and **documents** buckets (images including their AVIF / WebP variants, invoices, tickets, bank statements).

Not part of a backup: the backups bucket itself, Redis (carts, locks and queues are rebuilt), and the
schema `retained` (the GDPR erasure ledger, see below).

Archives live in their own bucket (`S3_BUCKET_BACKUPS`, default `tix-backups`, versioned). Optionally every
backup is copied to an external S3-compatible target (Settings on the Backups page). The catalogue is the
bucket itself (`backups/<time>-<kind>-<id>/` with `archive.tixbak`, `manifest.json`, `state.json`).

Kinds: `MANUAL`, `SCHEDULED`, `PRE_RESTORE` (safety backup taken automatically before every restore).

## Encryption and the key ring

Archives are encrypted with AES-256-GCM in 1 MiB chunks (STREAM construction; chunk index and the final
flag are authenticated, so reordering, truncation and bit flips are detected). The file key is derived with
HKDF from a key of `APP_ENCRYPTION_KEYS`; the key id is stored in the archive header.

**Restoring on another server requires the same `APP_ENCRYPTION_KEYS`** (at least the key with the id shown
in the backup). Keep a copy of the key ring outside this system - without it a backup cannot be read.

## Schedule, retention, verification

- Schedule: daily or weekly (weekday + time), in the shop time zone, DST-safe. A slot missed by more than
  six hours is skipped and shows as an alert. A failed scheduled run (or failed external upload) shows on the
  dashboard and optionally goes to an alert e-mail address.
- Retention: the newest N scheduled backups are kept. Manual and safety backups are kept until deleted,
  unless "delete after N days" is set (backups contain personal data - see GDPR below). The newest backup
  with a successful verification is never deleted automatically or by hand.
- **Verify** decrypts the whole archive, checks the checksum and file counts, restores the dump into a
  temporary database `tix_verify_<id>`, compares row counts with the manifest and drops the database again.
  This needs a database role that may create databases (the default Docker setup has one).

## Restore

Requirements: SUPER_ADMIN, fresh password, authenticator/recovery code (required by default, setting
"Restoring requires two-factor authentication"), and an explicit confirmation. The dialog shows what would
be lost: orders, invoices, payments and refunds created after the backup, and rows changed since.

Steps (progress is shown live):

1. Validate against the **authenticated** manifest inside the archive: migration level not newer than this
   software, key available, checksum, every chunk decrypts.
2. Maintenance mode on (Redis flag with heartbeat). The shop answers 503 with a maintenance page, PayPal
   webhooks get 503 (PayPal retries), new realtime connections are refused, all worker queues and loops pause.
   Running jobs are waited for.
3. Safety backup of the current state.
4. Other database sessions are terminated (and kept terminated).
5. **One transaction**: `DROP SCHEMA public` + restore + counters and sequences raised to
   `GREATEST(live, restored)` + durable `RESTORE_INCOMPLETE` marker + `COMMIT`. A failure before the commit
   rolls everything back and leaves the live database untouched.
6. Migrations run forward, recorded erasures are replayed, files are replaced (extra files are moved to
   `restore-quarantine/<id>/` in the backups bucket, never deleted), Redis mirrors are cleaned.
7. The marker and the maintenance flag are cleared.

If a step after the commit fails, the system **stays in maintenance mode** and the Backups page offers
"run the restore again" or "restore the safety backup". Admin sign-in and the Backups page stay reachable.

Numbers (orders, invoices, credit notes, ticket sync versions) are never reused: counters keep the higher
live values, so the sequence may contain gaps after a restore.

### Live seat chart during a restore

While the maintenance flag is set the realtime gateway tells every connected browser
(`maintenance:start`, retry hint 5 s), closes the sockets and refuses new connections. The seat
chart shows the maintenance notice, polls `/api/maintenance` and reconnects when the restore is
over (random delays spread the reconnects); every reconnect triggers a refetch of seat availability (after maintenance also the seat map; the cart and the waiting-room state are refreshed too, box office and seat change reload), so no missed delta can leave stale seat colours behind.

### Scanner devices after a restore

The restore transaction rotates the scanner `syncEpoch` (`scanner_sync_state`). Paired check-in devices see the new
epoch in the manifest / sync response, wipe their local tickets and cursors and resync (docs/SCANNER.md); their
pending offline scans are still uploaded and merged by time.

## GDPR

Erasures (anonymised customers) are recorded in `retained.erasures` (no personal data, outside the dumped
schema). After a restore from an older backup they are replayed so erased data does not come back. Backups
themselves contain personal data until they are deleted: set "delete manual and safety backups after N days"
and keep the external copy's retention in line. Quarantined files (`restore-quarantine/`) may contain
personal data as well and are not deleted automatically.

### Unfinished restore: manual recovery

The marker is the Redis key `<REDIS_KEY_PREFIX>:maintenance:restore-incomplete` (no TTL). The normal way
out is to run the restore again (or restore the safety backup) on the Backups page. If the page itself
cannot be used, fix the cause, then delete the key by hand (`redis-cli DEL <prefix>:maintenance:restore-incomplete`)

- only after checking that the database, files and migrations are in a consistent state, because
  deleting the marker re-opens the shop immediately. While the marker exists only sign-in and the Backups
  page are reachable, and `/admin` redirects to the Backups page.

## Erasure ledger on a new server

`retained.erasures` lives in its own schema and is **not** part of a backup. Migration 0019 backfills it
from `customers.anonymized_at`, but a restore on a **new server** starts with an empty ledger (plus
whatever the restored customers table already marks as anonymised). Erasures that were done after the
backup was taken, on the old server, are not known there. Before moving to a new server export the
ledger (`COPY retained.erasures TO STDOUT`, or `pg_dump -n retained`), keep that export with the backup
and re-apply it after the restore (`COPY retained.erasures FROM STDIN`) before the shop is used again;
the next restore on that server replays it. Ledger entries only contain customer ids and timestamps.

## Limits and operational notes

- The restore is not atomic across database and files: files are replaced after the commit.
- Delete markers and old versions accumulate in the versioned buckets.
- Outbox e-mails that were queued at backup time may be sent again by the sweeper; PayPal refunds use an
  idempotency key derived from the refund and are not duplicated by PayPal.
- **PayPal refunds are reconciled automatically after a restore.** PayPal keeps its state while the
  database is rewound, so a refund may have completed (or been made) after the backup.
  - **Marker.** Before the database is replaced the restore sets a Redis flag
    (`refunds:reconcile-pending`, no TTL); right after the migrations it writes the durable row
    `refund_reconcile_state` (migration 0030, authoritative; Redis is only the fast path). Both carry
    the same token. While a marker is set no automatic refund is sent or polled (the job fails with
    `REFUNDS_RECONCILING` and is retried; the stale-refund sweeper re-queues nothing).
  - **Pass.** The worker job `reconcile-refunds` (repeated by the 5-minute sweeper with back-off)
    runs single-flight (Redis lock with a short TTL that is renewed after every order; a pass that
    lost the lock stops without touching the marker). It pages through all PayPal payments that are still refundable
    (capture younger than 180 days) or have an open automatic refund and compares the refunds PayPal
    lists for each PayPal order with the local rows (matched by PayPal refund id or by our refund id,
    sent as `custom_id`; if the order details lack it, the refund resource is read). Per row:
    COMPLETED beats PENDING beats FAILED/CANCELLED; a row is only settled when amount and currency
    equal PayPal's. A row PayPal does not know stays PENDING and is sent later with the unchanged
    request id `tix-refund-<id>-<attempt>`. When all PayPal attempts of a row failed, its attempt
    counter is raised so a retry never reuses a request id PayPal has seen.
  - **Completion.** The marker is cleared only after a complete pass and only for its own token (an
    older pass cannot clear a newer restore's marker). Transient errors keep it (last error and
    attempts are shown on **Open refunds** and the dashboard). If PayPal does not know most orders
    (wrong PayPal account/environment restored) the marker stays and an alert is shown. A SUPER_ADMIN
    can skip the reconciliation (audited) – at the risk of double refunds.
  - **Review.** Findings are not booked automatically: refunds PayPal has but we do not (lost window,
    PayPal dashboard, also announced by a webhook), more than one completed PayPal refund for one
    request, amount mismatches, local refunds PayPal does not show, orders PayPal does not know or
    refuses to look up. The order appears under "Needs review after restore" on **Open refunds** and
    **all automatic refunds of that order are on hold** (`REFUND_REVIEW_OPEN`) – otherwise a normal
    cancellation would refund the money a second time. Use **Record existing PayPal refund**: it
    verifies the refund live at PayPal (completed, belongs to a capture of the order, currency),
    cancels the chosen tickets with a credit note and books the refund as SUCCEEDED with the PayPal
    id; nothing is sent to PayPal and the tickets (plus fees) must add up to its amount (the plan is
    pinned to the capture the refund belongs to, relevant after an additional payment). Choose
    "an overpayment" for refunds that paid an overpayment back: they are booked as overpayment refunds,
    without tickets. Otherwise mark the entry as reviewed once nothing is missing.
  - Limits: PayPal refunds captures for about 180 days; older captures are not checked unless a
    refund is open locally.
- Your own admin session may not exist in the restored data; you may have to sign in again.
- The maintenance probe fails open when Redis is unreachable.
- The worker image contains `pg_dump`, `pg_restore` and `psql` of the same major version as the server
  (18). They run as the application's database role. **That role is the database superuser in the default
  Docker setup**; a compromise of the worker is therefore a compromise of the database. For hardened
  setups use a dedicated role that owns the schema and may create databases, and keep the application
  environment free of unrelated secrets (the PostgreSQL tools only receive `PG*` variables).
- The external endpoint must be https and publicly routable unless the matching options are enabled; the
  stored keys must be re-entered when endpoint or bucket change.
- Uploads: the raw file is streamed (no size buffering) up to the configured maximum; invalid files are
  deleted, leftovers older than 24 h are swept.
