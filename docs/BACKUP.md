# Backups and restore

Admin area: **Backups** (SUPER_ADMIN only). Everything is configurable there; nothing is hard-coded.

## What is backed up

One encrypted archive per backup:

- the PostgreSQL database (`pg_dump -Fc`, taken inside one exported snapshot so row counts and dump agree),
- every object of the **assets** and **documents** buckets (images, invoices, tickets, bank statements).

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
- Pending refunds are not reconciled with PayPal automatically after a restore: check "Open refunds".
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
