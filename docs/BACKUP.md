# Backups and restore

Admin area: **Backups** (SUPER_ADMIN only). Everything is configurable there; nothing is hard-coded.

## What is backed up

One encrypted archive per backup:

- the PostgreSQL database (`pg_dump -Fc`, taken inside one exported snapshot so row counts and dump agree),
- every object of the **assets** and **documents** buckets (images including their AVIF / WebP variants, invoices, tickets, bank statements).

Not part of a backup: the backups bucket itself, Redis (carts, locks and queues are rebuilt), and the
schema `retained` (the GDPR erasure ledger, see below).

Archives live in their own local store, depending on the [storage driver](STORAGE.md): with the default
**filesystem** driver the directory `<STORAGE_DIR>/backups` (default `/data/storage/backups`), with the **S3**
driver the bucket `S3_BUCKET_BACKUPS` (default `tix-backups`, versioned when you run MinIO). Optionally every
backup is copied to an external S3-compatible target (Settings on the Backups page; this stays S3 for both
drivers). The catalogue is the store itself (`backups/<time>-<kind>-<id>/` with `archive.tixbak`,
`manifest.json`, `state.json`).

> **Local backups are not off-site backups.** With the filesystem driver the backups sit on the same volume as
> the files (and usually the same disk and server as the database). They survive container updates but not the
> loss of the disk. The Backups page therefore shows a warning while the filesystem driver is used and no
> external target is enabled; configure the external target.

Kinds: `MANUAL`, `SCHEDULED`, `PRE_RESTORE` (safety backup taken automatically before every restore).

## Encryption and the key ring

Archives are encrypted with AES-256-GCM in 1 MiB chunks (STREAM construction; chunk index and the final
flag are authenticated, so reordering, truncation and bit flips are detected). The file key is derived with
HKDF from a key of `APP_ENCRYPTION_KEYS`; the key id is stored in the archive header.

**Restoring a backup of another system requires that system's `APP_ENCRYPTION_KEYS`** (at least the key with
the id shown in the backup; the database content inside is encrypted with the same ring). Either start the new
system with the same ring, or enter it at restore time (see "Restoring a backup from another system"). Keep a
copy of the key ring outside this system - without it a backup cannot be read.

## Schedule, retention, verification

- Schedule: daily or weekly (weekday + time), in the shop time zone, DST-safe. A slot missed by more than
  six hours is skipped and shows as an alert. A failed scheduled run (or failed external upload) shows on the
  dashboard and optionally goes to an alert e-mail address.
- Retention: the newest N scheduled backups are kept. Manual and safety backups are kept until deleted,
  unless "delete after N days" is set (backups contain personal data - see GDPR below). The newest backup
  with a successful verification is never deleted automatically or by hand.
- **Verify** decrypts the whole archive, checks the checksum and file counts, restores the dump into a
  temporary database `tix_verify_<stack tag>_<id>`, compares row counts with the manifest and drops the database again.
  This needs a database role that may create databases (the default Docker setup has one).

### Automatic probe restore

A backup that was never restored is only a hope. Settings -> Backups -> "Automatic probe restore"
(default **off**; when switched on: weekly, Sunday 05:00 shop time, daily is possible) makes the worker verify the **newest**
backup (any kind) regularly, using the same code as "Verify" plus extra checks.

> **Enable it deliberately.** A probe restores the whole database into a second one, so the database server
> needs free disk of about **twice the database size** (plus the role must be allowed to create databases).
> It is therefore off by default and existing installations do not start a restore on their own. Switch it
> on once that headroom is confirmed.

1. checksum, full decryption pass, file counts (as in Verify);
2. restore of the dump into a throwaway database `tix_probe_<stack tag>_<random>` and row-count comparison with the
   manifest;
3. sanity checks on that copy: the migrations table is present and matches the manifest, the copy is then
   **migrated to the current structure** (exactly what a real restore does) and must end at the newest
   migration of the running code, and `events`, `orders`, `tickets` must be readable (counts are recorded).
   A backup from an older version is therefore expected to be "behind" and is brought up to date; a backup
   from a _newer_ version fails with `MIGRATION_NEWER`.

Safety rules:

- The target database name must match `tix_(verify|probe)_<stack tag>_...` and must never be the live
  database (refused otherwise). The stack tag is derived from the live database name and the key prefix, so
  stacks sharing one PostgreSQL server never drop each other's databases. It is dropped afterwards, also after
  a failure; leftovers of a crashed run (of this stack only) are dropped at worker start and at the start of
  the next probe, always under the backup operation lock.
- Single flight through the backup operation lock. A probe does not start while a backup, verify, import
  or restore runs, while maintenance mode is on, or while a restore request is queued. A busy lock is
  retried on a later check (every 10 minutes), nothing is paused and no session of the live database is
  terminated. A late slot is caught up; a failed probe is retried after 6 hours, except permanent errors (`CREATEDB_MISSING`, `MIGRATION_NEWER`),
  which wait for the next regular slot; the warning stays until a probe passes.
- The archive is read twice (inspection pass + restore), so a probe costs about the I/O of two downloads
  plus a restore on the database server; schedule it outside peak hours.
- Files are checked by their counts inside the archive, not against the live buckets (those change
  legitimately after the backup).

The result (time, backup, duration, status, error, counts, migrations applied) is shown on Backups
(last-probe badge, history of the last 10 runs, **Run probe now** for super admins), stored on the backup's
verification state (so a passing probe protects it like a manual Verify) and in the history file
`backups/probe-history.json` in the backup bucket (last 50 runs, survives a database restore), and written
to the audit log (`backup.probe`, actor SYSTEM; `backup.probe.requested` for the manual button). A failed
probe raises the admin warning "Backup failed" (variant "test restore failed", Notifications settings)
until a later probe passes; it is not raised while the probe is switched off or no backup exists yet.

## Pre-update backups

Before the `tix` container applies pending database migrations to an installation that already
has data, it writes a database-only backup in the same encrypted format (kind "Before update",
listed on the Backups page, restorable like any other; a restore of it replaces the database and
leaves all files untouched). The newest 3 are kept (`PRE_UPDATE_BACKUP_KEEP`) and they are not part
of the scheduled/manual retention. If the backups bucket is not reachable the archive is written as
a file to the fallback directory `PRE_UPDATE_BACKUP_DIR` when that is a mounted volume (installations of older releases used the volume `pre-update-backups`; upload such a file on the Backups page to restore it). If
no backup can be written the migration is not applied (`SKIP_PRE_UPDATE_BACKUP=1` disables the
step). Fresh installations skip it.

With the filesystem driver the "backups bucket" is `<STORAGE_DIR>/backups`. The migration step only uses
it when that directory is inside a **mounted volume** (checked in `/proc/self/mountinfo`: a mount at or above
the directory that is not the container's root layer or a memory file system), otherwise the archive would
vanish with the container and the directory counts as "not available" (fallback: `PRE_UPDATE_BACKUP_DIR`
when mounted, else the update stops). It logs a warning that the backup lives on the same disk as the files.

The backup holds your **data** from before the update. Restoring it replaces the database (files stay
untouched; files uploaded since then are left orphaned in storage, which is harmless) and re-runs the
migrations of the version that is running now: you stay on the **new** version. Going back to an
older application version is not supported once a newer schema was applied (older versions cannot
read the newer schema or the "Before update" backup type). A compose file of an older release cannot
take pre-update backups (the new image then warns and migrates without one): use the
compose file of the running release or `tix-update.sh`. The single `tix` image always counts as a new
compose file (the supervisor sets `TIX_COMPOSE_VERSION` to the image version when unset), so the
backup is never skipped silently.

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

### Restoring a backup from another system

A backup made by another installation is encrypted with that installation's key ring, and the secrets stored
in its database (bank PINs, API keys, ticket signing keys, settings secrets, TOTP secrets) use the same keys.
To restore it on a system with a different `APP_ENCRYPTION_KEYS`:

> **Switched off by default (`TIX_ALLOW_FOREIGN_BACKUP_KEYS`).** A restore streams the archive's dump through
> `pg_restore` into `psql` **as the database user**, which is a superuser in the stock PostgreSQL image. An
> archive can therefore contain `COPY ... TO PROGRAM` or similar and run commands inside the database
> container. With this system's own keys only someone who already holds them can build such an archive; the
> "key of another system" feature lets a SUPER_ADMIN supply a key of their own. So the operator must opt in:
> set `TIX_ALLOW_FOREIGN_BACKUP_KEYS=1` (or `true`) in `.env` and restart, migrate, then remove it again.
> **With the switch on, a SUPER_ADMIN has the power of the database superuser.** While it is off, the key
> section of the upload and restore dialogs is replaced by a hint, and the server refuses staged keys, key
> checks, uploads that carry a key token and restores with keys (web actions, upload route and worker alike).
> Keys that an earlier restore already stored in the additional-keys file keep working.

1. **Upload** the `.tixbak` file (Backups > Upload backup file, SUPER_ADMIN, streamed, limited by the setting
   "maximum upload size"). In the same dialog paste the source system's complete `APP_ENCRYPTION_KEYS` value
   (all entries, `id:base64`, separated by commas or lines; a pasted `APP_ENCRYPTION_KEYS=` prefix is fine).
   The file is checked completely (every block authenticated, checksum, manifest) before it appears in the
   list; without the key the import is rejected and the file deleted. Nothing is persisted at this step.
2. **Restore**: open the restore dialog of the backup, expand "Backup from another system", paste the key again
   and use **Check key**. The check reads only the archive header and the first encrypted block and reports
   "matches" / "key id not among the entered keys" / "does not match (or file damaged)"; it starts and stores
   nothing. It tests only the keys you pasted; if this system's own keys (including stored additional keys) can
   already read the archive it says so ("already readable by this system") instead of "matches". It proves the
   archive key only: paste the complete ring, because secrets inside the database may
   use older key ids of the source ring. The restore itself needs the usual confirmation (password, 2FA or
   passkey, acknowledgement) - unchanged.
3. **After the restore** the entered entries stay available as **additional, decrypt-only keys** in
   `<TIX_SECRETS_DIR, default /data/secrets>/extra-encryption-keys` (override: `TIX_EXTRA_KEYS_FILE`; one
   `id:base64` per line, mode 0600, on the data volume). The shared key-ring loader reads the file together with
   `APP_ENCRYPTION_KEYS` (the configured key stays first and is the only one that encrypts new data); running web
   and worker processes pick the file up on demand (no restart; the file is re-read when an envelope names an
   unknown key id, at most every 5 s). The backups page shows the ids of the additional keys. The keys are written
   BEFORE the database is replaced (a failure aborts the restore with nothing changed); a rolled-back restore may
   leave them behind, which is harmless. The file is replaced crash-safely: written to a unique, exclusively
   created temporary file next to it (a symlink at that name is never followed), fsynced, renamed over the
   target and the directory fsynced; then it is read back from disk and compared with what was meant to be
   stored, and only then does the restore proceed. A file that is broken anyway (empty, truncated) never makes
   web and worker crash-loop: an **empty** file counts as "no additional keys" and is logged; a **file that does
   not parse** is logged as an error and the processes continue with the configured keys only, so anything
   encrypted with an additional key then fails with an "unknown encryption key id" error that names the file
   problem. Repair or restore the file and the keys are picked up again (running processes re-read it on demand).
   A restore refuses to overwrite such a broken file (the keys inside it could be lost): fix or remove it first.

How the key travels: the web action parses it, encrypts it with the CURRENT key (secret box) and parks it in
Redis for at most one hour under an opaque random token; the queue job and the upload header carry only that
token, and the worker consumes it once (`GETDEL`). The key is never logged, never in job data, audit entries,
status or error messages (the audit entry records only that a key was supplied, and the ids of stored keys), and
is never echoed back to the browser. Rate limits apply to the check and staging actions.

**Key id collisions.** Envelopes and archives carry only the key id, so one id cannot stand for two different
keys. If the source ring uses an id that this system already uses with a different key (e.g. both are `k1`,
the id older versions of the key generator always used), the entry is rejected with a clear message. The
`keygen` command now picks a random id (`k` + 6 hex characters), so separate systems rarely collide. For a
target system with a `k1` key, give its own key another id (e.g. `k2:...`) in `APP_ENCRYPTION_KEYS` before
first use and restore again. An alternative
that avoids the rename (several keys per id, picked by trial decryption) is deliberately not implemented.

The same applies to the additional-keys file: if you restored the backup of system A (key id `k1`) and later
want to restore the backup of system B whose ring also uses `k1` with a different key, the second restore is
**rejected** because `k1` is already stored with other material. Be aware of the real limitation: one system
cannot hold two different keys under one id, and the ids inside existing archives and database values cannot be
rewritten. Workarounds, in order of preference: (1) restore B into a fresh installation whose own key has a
different id; (2) if A's data is no longer needed on this system (the restore of B replaces the whole database,
so the live data will only contain B's secrets), stop using A: delete the `k1:` line from the additional-keys
file and restore B. Note that this also makes A's backups, and the automatic safety backup created before the
restore (it contains A's secrets under `k1`), unreadable for their embedded secrets unless you keep a copy of A's
line elsewhere. Re-saving secrets (re-entering a bank PIN or API key) only re-encrypts the value you save with
this system's own key; it does not change old ids.

**Limitations.**

- The additional keys must be kept as long as the restored data (or backups of it) exist: the database still
  contains secrets encrypted with them. A **"re-encrypt everything with the current key"** action is **not
  offered**: encrypted values are spread over many tables with individual context strings (settings, bank
  connections, TAN challenges, ticket signing keys, scanner LAN secrets, admin TOTP secrets, ...), so a safe
  generic routine would be a separate project. Values are re-encrypted with the current key whenever they are
  saved again (for example by re-entering a bank PIN or API key).
- The "Verify" button of an imported foreign backup works only after a restore stored the key (verification of
  a backup that needs a key you have not stored fails with "key unknown"). The scheduled probe restore uses the
  stored additional keys as well.
- A backup made AFTER such a restore is encrypted with this system's key, but the secrets inside still use the
  source key id: restoring it elsewhere needs both keys.
- Docker: the file lives on the data volume (`/data/secrets`), shared by web and worker in the all-in-one
  image. With separate containers they must share that directory (or set `TIX_EXTRA_KEYS_FILE` on a shared
  path), otherwise only the process that ran the restore can read the restored secrets.

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
