# Scanner API (Android check-in app)

Server side of the check-in scanner: device pairing, manifest, delta sync, online scans, offline
upload and manual lookup. The Kotlin app implements the client; this document is the contract.
Machine-readable schemas: `packages/shared/src/scanner/contract.ts` (zod). The decision table is
implemented once in `packages/shared/src/scanner/decision.ts` (`decideScan`) and must be mirrored
by the app for offline decisions.

- Base path: `/api/scanner/v1` (API version constant `SCANNER_API_VERSION = 1`).
- JSON only, UTF-8. Timestamps are ISO 8601 with offset (`2026-11-10T18:00:00+01:00` or `Z`).
- Every response carries `Cache-Control: no-store`.
- Auth: `Authorization: Bearer <device token>`. No cookies, no CSRF/Origin checks. Optional header
  `X-Scanner-App-Version: 1.2.3` is stored as the device's app version.
- Errors: `{ "error": "<CODE>", "message": "<English text>", "details"?: {...} }`.

## Pairing

The admin portal (Check-in devices, `/admin/scanners`) creates a one-time pairing code: 10 characters
Crockford Base32 (`ABCDE-FGHJK`; case, dashes and `O`/`I`/`L` aliases are tolerated). It is valid
`scanner.pairingCodeTtlMinutes` (default 15) and stored only as SHA-256. It carries the events the
device may scan, the entrance per event and whether check-out is allowed per event.

QR content:

```
tixscan://pair?v=1&u=<url-encoded server base URL>&c=<CODE>
```

`u` is `scanner.serverUrl` (admin setting, e.g. `http://192.168.1.20:8080`) or, when empty, the
public shop URL. Endpoints are `<u>/api/scanner/v1/...`. The app rejects other `v` values.

`POST /pair` (no auth, 10 requests/minute/IP)

```json
{
  "code": "ABCDE-FGHJK",
  "deviceName": "Pixel 8",
  "platform": "android",
  "appVersion": "1.0.0",
  "deviceModel": "Google Pixel 8"
}
```

201:
`{ "apiVersion": 1, "deviceId": "<uuid>", "deviceName": "...", "token": "tixd_...", "serverTime": "..." }`.
The token is shown **once**; the server keeps only its SHA-256. The device name is the admin's label
if one was entered, otherwise `deviceName`. The code is consumed by one atomic conditional UPDATE, so
two concurrent exchanges cannot both succeed. 400 `INVALID_PAIRING_CODE` for unknown, expired or used
codes.

## Status codes (all device endpoints)

| Status        | Code(s)                                  | App behaviour                                                    |
| ------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| 401           | `INVALID_TOKEN`, `DEVICE_REVOKED`        | Unpair: wipe token and local data, show the pairing screen       |
| 403           | `EVENT_NOT_ASSIGNED`                     | Drop that event locally (assignment changed in the admin portal) |
| 409           | -                                        | Reserved for conflicts                                           |
| 413           | `PAYLOAD_TOO_LARGE`                      | Split the batch                                                  |
| 415/400       | `UNSUPPORTED_MEDIA_TYPE`, `INVALID_JSON` | Bug in the client                                                |
| 422           | `VALIDATION_FAILED` (`details.issues`)   | Bug in the client                                                |
| 429           | `RATE_LIMITED` + `Retry-After`           | Back off for `Retry-After` seconds                               |
| 503           | `MAINTENANCE` + `Retry-After`            | Go offline mode, retry later (a backup restore is running)       |
| 503           | `BUSY` + `Retry-After`                   | Transient overload: decide locally, retry after `Retry-After`    |
| 5xx / network | -                                        | Offline mode; keep the local scan queue                          |

Rate limits (per device, per minute, one bucket per route): scan 600, batch 60, lookup 240, manifest 120,
sync 120, app/latest 30. Failed authentications are additionally limited per client address: the budget (30 failures per minute) is checked
before the token lookup and only charged on 401; once exhausted every request of that address is answered 429. `/pair` and `/app/download` are limited per client address (10 and
20 per minute).

All UUIDs in requests are case-insensitive; the server normalises them to lower case (responses are
lower case).

## Endpoints

### `GET /manifest`

Everything needed to scan the assigned events, also offline. Supports `If-None-Match` (ETag =
content hash; 304 when unchanged). Fetch on start, after pairing and every sync interval.

```jsonc
{
  "apiVersion": 1,
  "serverTime": "...",
  "etag": "...",
  "syncEpoch": "<opaque string>",
  "device": { "id": "<uuid>", "name": "Door A" },
  "settings": {
    "offlineModeAllowed": true,
    "lanSyncEnabled": true,
    "syncIntervalSeconds": 30,
    "resultColors": {
      "accepted": "#16A34A",
      "rejected": "#DC2626",
      "discountProof": "#FACC15",
      "seatFeature": "#14B8A6",
      "wrongEntrance": "#2563EB",
      "additionalPaymentOpen": "#F97316",
    },
    "warningPriority": [
      "DISCOUNT_PROOF_REQUIRED",
      "WRONG_ENTRANCE",
      "ADDITIONAL_PAYMENT_OPEN",
      "SEAT_FEATURE",
    ],
  },
  "events": [
    {
      "id": "<uuid>",
      "title": "...",
      "subtitle": null,
      "startsAt": "...",
      "doorsOpenAt": null,
      "endsAt": null,
      "timeZone": "Europe/Berlin",
      "venueName": "...",
      "entranceId": "<uuid>|null", // entrance this device is stationed at
      "allowCheckOut": true, // scanner.allowCheckOut AND the device's permission for this event
      "keys": [
        {
          "keyId": "ab12cd34",
          "status": "ACTIVE|RETIRED|REVOKED",
          "publicKey": "<base64url 32 bytes>|null",
        },
      ],
      "ticketTypes": [
        {
          "id": "...",
          "name": "...",
          "requiresProof": true,
          "scannerWarning": "Bitte Ermäßigungsnachweis prüfen!",
        },
      ],
      "categories": [{ "id": "...", "name": "...", "color": "#336699" }],
      "entrances": [{ "id": "...", "name": "North", "code": "N" }],
      "sections": [{ "id": "...", "name": "Stalls", "entranceId": "<uuid>|null" }],
      "lan": { "enabled": true, "secret": "<base64url 32 bytes>|null" },
    },
  ],
}
```

- **Keys.** ACTIVE and RETIRED keys verify tickets (see `docs/TICKETS.md`). A REVOKED key is listed with
  `publicKey: null`: delete it from the local store; tickets signed with it are invalid (the server
  re-issues them with the active key and they arrive through delta sync). The server creates the
  event's key before the first ticket is sold, so the manifest always contains an ACTIVE key.
- **Mutable event data lives here, not in the ticket rows**: ticket types (proof flag + warning
  text), block-to-entrance mapping and categories. Editing them in the admin portal changes the
  manifest, not the tickets, so re-fetch the manifest regularly.
- **LAN secret.** 32 random bytes per event, identical for all devices assigned to the event, only
  delivered here. Purpose: the devices at one venue authenticate peer-to-peer (LAN) sync messages with
  `HMAC-SHA256(secret, message)` so that foreign devices on the venue WiFi cannot inject check-ins.
  `lan.enabled` mirrors `scanner.lanSyncEnabled`; when disabled `secret` is `null`. The peer protocol
  itself is specified with the LAN work package. **The secret rotates** when a device assigned to the
  event is revoked or removed from the event (the manifest `etag` changes): re-fetch the manifest
  regularly and replace the stored secret.
- **`syncEpoch`.** Identifies the server database generation. A backup restore rotates it. When the
  manifest or a sync response carries an epoch different from the stored one, the app **wipes its
  local tickets and cursors** and resyncs from scratch (the check-in state of the restored database
  can be older than what the devices hold). Pending offline scans stay in the queue and are uploaded.

### `GET /sync?eventId=<uuid>&cursor=<opaque>&limit=<1..1000, default 500>`

One page of ticket changes of an event (403 for events not assigned to the device). `cursor` is empty
or absent for a full sync.

```jsonc
{
  "tickets": [
    {
      "id": "<uuid>",
      "ticketCode": "ABCDEFGHJK",
      "status": "VALID|CANCELLED|REFUNDED|REPLACED",
      "eventId": "<uuid>",
      "keyId": "ab12cd34",
      "sectionId": "<uuid>",
      "sectionLabel": "Stalls",
      "rowLabel": "B",
      "seatLabel": "7",
      "seatFeature": "WHEELCHAIR_SPACE|COMPANION_SEAT|null",
      "categoryId": "<uuid>",
      "categoryName": "Cat 1",
      "ticketTypeId": "<uuid>",
      "attendeeName": "Max Muster", // falls back to the buyer name
      "checkInState": "NONE|CHECKED_IN|CHECKED_OUT",
      "firstCheckedInAt": "...|null",
      "firstCheckedInDeviceName": "Door A|null",
      "checkInCount": 1,
      "lastScanAt": "...|null",
      "additionalPaymentOpen": false,
      "syncVersion": 12345,
    },
  ],
  "nextCursor": "c1....",
  "hasMore": false,
  "syncEpoch": "<opaque string>",
  "serverTime": "...",
}
```

Semantics:

- **Cursor.** Opaque string (never parse it; the format may change). Start with an empty cursor, follow
  `hasMore` by sending `nextCursor` as `cursor` until `hasMore=false`, store the final `nextCursor` and
  send it at the next sync run. A cursor of another epoch or an unparsable cursor is answered with a full
  sync (and the new `syncEpoch`).
- **Upsert by `id`, keep the highest `syncVersion`.** Tickets can be delivered more than once (across runs
  and when a later transaction committed). Apply a received ticket only when its `syncVersion` is higher
  than or equal to the stored one.
- **No lost updates.** Internally the cursor is a transaction-id horizon (`pg_snapshot_xmin`): the next run
  re-reads everything written by transactions that were still running when the previous run started, so a
  change that commits late (a long cancellation with lock waits) is never skipped. There is no delay before
  a change shows up.
- Every ticket change bumps `syncVersion` (database trigger): check-ins, voiding, re-issue, attendee name,
  and everything shown on the scanner that lives outside `tickets` - an additional payment (tariff change)
  that is created, confirmed, paid or cancelled, changes of the order item seat / tariff / category
  snapshot and wheelchair / companion flags of the seat. Generated file references (PDF, wallet passes)
  do not bump.
- **Tombstones.** Voided tickets stay in the delta with `status != VALID` (`CANCELLED`, `REFUNDED`,
  `REPLACED`). The app must keep them and reject the ticket as void (RED). A re-issued ticket arrives as
  a new `VALID` row; the old one as `REPLACED` (a ticket signed with a revoked key therefore keeps
  being rejected).
- Syncing updates the device `lastSyncAt` shown in the admin portal.

### `POST /scan` (online scan)

```jsonc
{
  "clientScanId": "<uuid generated on the device, one per scan>",
  "eventId": "<uuid>", // event the operator is scanning
  "action": "CHECK_IN|CHECK_OUT",
  "source": "CAMERA|MANUAL",
  "payload": "tix://v1/...", // camera: raw QR text   } exactly one of
  "ticketId": "<uuid>",
  "ticketCode": "ABCDEFGHJK", // manual: from lookup } these three
  "scannedAt": "2026-11-10T18:00:00+01:00", // device clock
  "entranceId": "<uuid>|null", // entrance in use (default: the device assignment)
}
```

Response (`ScanOutcome`):

```jsonc
{
  "clientScanId": "...",
  "result": "ACCEPTED",
  "color": "GREEN|YELLOW|RED",
  "warnings": ["DISCOUNT_PROOF_REQUIRED"],
  "warningTexts": { "DISCOUNT_PROOF_REQUIRED": "Bitte Ermäßigungsnachweis prüfen!" },
  "duplicate": false, // true: this clientScanId was recorded before; the original decision is returned
  "recorded": true, // false: not journaled (event not assigned to the device)
  "ticket": {
    "id": "...",
    "ticketCode": "...",
    "status": "VALID",
    "attendeeName": "...",
    "categoryName": "...",
    "ticketTypeName": "...",
    "sectionLabel": "...",
    "rowLabel": "B",
    "seatLabel": "7",
    "seatFeature": null,
    "checkInState": "CHECKED_IN",
  }, // state AFTER the scan
  "firstScan": { "at": "...", "deviceName": "Door A" }, // first check-in of the ticket, if any
}
```

For `REJECTED_ALREADY_CHECKED_IN` show `firstScan.at` and `firstScan.deviceName`. `payload` is verified on
the server (syntax, event, Ed25519 signature; REVOKED keys never verify). Manual scans (`ticketId` /
`ticketCode`) are not signature-checked: the operator picked a ticket from the lookup. Retrying a request
with the same `clientScanId` is always safe (idempotent per device).

### `POST /scans/batch` (offline upload)

`{ "sentAt": "<device clock now>", "scans": [ <scan request>, ... up to 200 ] }` - every item has the shape of `/scan`.
`sentAt` (optional, send it always) lets the server correct device clock skew: every `scannedAt` of the batch is
moved by `serverNow - sentAt`. Corrected times are limited to the time of the request (5 s tolerance) and
cannot be older than the ticket issue time (journal message `SCAN_BEFORE_ISSUE`). Response:
`{ "results": [ <ScanOutcome>, ... ], "serverTime": "..." }`, **one outcome per scan in request order**.
Idempotent per `(device, clientScanId)`; re-uploading a batch returns the recorded decisions with
`duplicate: true`. The app removes a scan from its queue once an outcome (any result) was returned for it
and uses the outcome to learn what the server decided (e.g. an offline "green" that the server
rejected as already checked in - show a hint to the operator / mark the ticket locally).

### `GET /lookup?eventId=<uuid>&q=<text>&limit=<1..50, default 20>`

Manual search (min. 2 chars) over attendee name, buyer name, ticket code (typo tolerant: `o`->`0`, `i`/`l`->`1`),
order number and seat (`Block A Reihe 3 Platz 5`, `A 3 5`, `stalls b 7`: every word must match a whole word of
block / row / seat label). VALID tickets first. Response
`{ "tickets": [ { ...ScanTicketDisplay, "orderNumber", "buyerName", "firstCheckedInAt" } ] }`. Use the ticket `id`
for the follow-up manual `/scan`.

### Device clock

The app learns its offset to the server from the manifest / sync `serverTime` and sends `scannedAt` and `sentAt`
on this offset-corrected clock. The server's per-batch correction (`serverNow - sentAt`) is then close to zero and
only catches drift since the last offset measurement (it also stays correct for devices that send raw clocks).

### `GET /app/latest` (device auth)

Current app release: `{ versionName, versionCode, sha256, sizeBytes, notes, downloadUrl, downloadUrlTtlSeconds }`;
404 `NO_RELEASE` when none was published. `downloadUrl` is always absolute (`scanner.serverUrl`, else the shop `APP_URL`; 503 `SERVER_URL_MISSING` if neither is set) and a signed link valid for one hour; compare
`versionCode` with the installed one and verify `sha256` after the download.

### `GET /app/download?t=<signed token>` (no auth)

Streams the APK. The signed, time-limited token is the credential. Staff phones without pairing use a link
(24 h) created in the admin portal ("Download link and QR code"). 403 `INVALID_LINK` when invalid or expired.

## Decision table (GREEN / YELLOW / RED)

Evaluated top to bottom; implemented in `decideScan`:

| #   | Condition                                           | Result (colour)                                      | New state   |
| --- | --------------------------------------------------- | ---------------------------------------------------- | ----------- |
| 1   | No ticket record                                    | `REJECTED_UNKNOWN_TICKET` (RED)                      | -           |
| 2   | `status != VALID`                                   | `REJECTED_TICKET_VOID` (RED)                         | -           |
| 3   | CHECK_OUT, check-out not allowed                    | `REJECTED_CHECK_OUT_NOT_ALLOWED` (RED)               | -           |
| 4   | CHECK_OUT, state != CHECKED_IN                      | `REJECTED_NOT_CHECKED_IN` (RED)                      | -           |
| 5   | CHECK_OUT otherwise                                 | `ACCEPTED` (GREEN)                                   | CHECKED_OUT |
| 6   | CHECK_IN, state == CHECKED_IN                       | `REJECTED_ALREADY_CHECKED_IN` (RED, show first scan) | -           |
| 7   | CHECK_IN, any warning below applies                 | `ACCEPTED_WITH_WARNING` (YELLOW)                     | CHECKED_IN  |
| 8   | CHECK_IN otherwise (NONE or CHECKED_OUT = re-entry) | `ACCEPTED` (GREEN)                                   | CHECKED_IN  |

Stale scans (see offline merge rules; `stale`, `scannedBeforeFirstEntry`, `exitBetween` inputs of `decideScan`) use
the same table but never change the state: a stale check-in is `REJECTED_ALREADY_CHECKED_IN` (duplicate entry)
unless `exitBetween` (a check-out of the ticket in the same upload between it and the first entry) makes it a real
second entry (then it is accepted, no state change), and a stale check-out is accepted only after the first entry.

Signature / event problems are decided before the table (RED, no state change): `REJECTED_MALFORMED` (not a
`tix://v1` payload), `REJECTED_WRONG_EVENT` (payload event differs from the scanned event),
`REJECTED_INVALID_SIGNATURE` (unknown key id, revoked key or bad signature). A ticket with a valid signature
but no local record is decided as #1 online; offline the app may admit it on the signature alone (it is
uploaded and merged later).

Warnings (CHECK_IN only, collected in this order, never block entry):

| Warning                   | Condition                                                         | Text                           |
| ------------------------- | ----------------------------------------------------------------- | ------------------------------ |
| `DISCOUNT_PROOF_REQUIRED` | ticket type `requiresProof`                                       | ticket type's `scannerWarning` |
| `WRONG_ENTRANCE`          | device entrance and the block's entrance are both set and differ  | app text                       |
| `SEAT_FEATURE`            | seat is a wheelchair space / companion seat                       | app text (`seatFeature`)       |
| `ADDITIONAL_PAYMENT_OPEN` | a tariff-change additional payment is open (PROPOSED / CONFIRMED) | app text                       |

### Result colours

The screen colours are admin settings (Settings -> Scanner -> Result colours) and are shipped in the
manifest as `settings.resultColors` (hex `#RRGGBB`, additive field; the manifest `etag` changes with them).
Defaults: `accepted` #16A34A (green), `rejected` #DC2626 (red), `discountProof` #FACC15 (yellow),
`seatFeature` #14B8A6 (turquoise), `wrongEntrance` #2563EB (blue), `additionalPaymentOpen` #F97316 (orange).

| Scan                        | Screen colour           |
| --------------------------- | ----------------------- |
| `REJECTED_*`                | `rejected`              |
| `ACCEPTED` without warnings | `accepted`              |
| `DISCOUNT_PROOF_REQUIRED`   | `discountProof`         |
| `WRONG_ENTRANCE`            | `wrongEntrance`         |
| `ADDITIONAL_PAYMENT_OPEN`   | `additionalPaymentOpen` |
| `SEAT_FEATURE`              | `seatFeature`           |

With several warnings the screen colour is that of the first warning in `settings.warningPriority`
(`DISCOUNT_PROOF_REQUIRED` > `WRONG_ENTRANCE` > `ADDITIONAL_PAYMENT_OPEN` > `SEAT_FEATURE`); the other
warnings are shown as chips in their own colour. The app must not hardcode the order or the colours (fall
back to the defaults above only when the manifest lacks the fields, e.g. an old server). Text on a colour:
black or white by luminance.

Check-out is allowed when `scanner.allowCheckOut` AND the device's `allow_check_out` for the event.

## Offline merge rules

Offline scans are uploaded with `POST /scans/batch` (`wasOffline = true` in the journal) whenever the server is
reachable again.

0. **Online scans** (`POST /scan`) are decided at the server receive time; the device `scannedAt` is not used.
1. **Append-only journal.** Every scan becomes a `check_in_logs` row with its (skew-corrected) `scannedAt`.
   The journal is never rewritten. Without `sentAt` a device clock more than 5 minutes ahead is clamped
   to the receive time (message `DEVICE_CLOCK_AHEAD`). The raw payload is stored for rejected scans only.
2. **Processing order.** The scans of one request are applied in `scannedAt` order (ties: request order).
   Each scan is decided with `decideScan` against the **current** server state of the ticket, after
   previous scans (online or from other devices) have been applied.
3. **Stale scans never change the state.** A scan is _stale_ when its time is older than the ticket
   `last_scan_at` (the last state-changing scan). It is journaled (message `STALE_SCAN`) but never changes
   `check_in_state`, `check_in_count` or `last_scan_at`. Its result is defined as:
   - stale `CHECK_IN` older than `first_checked_in_at`: `first_checked_in_at` / device move to this scan
     (the earliest entry owns the stay) and the result is `REJECTED_ALREADY_CHECKED_IN` with journal message
     `DUPLICATE_ENTRY` - exactly one check-in per stay is accepted, whatever the upload order. Exception: when the
     same upload contains a `CHECK_OUT` of this ticket between this scan and the old first entry, both entries
     were real (guest left and came back) and the scan is `ACCEPTED` / `ACCEPTED_WITH_WARNING` (message
     `STALE_SCAN_FIRST_ENTRY`),
   - any other stale `CHECK_IN`: `REJECTED_ALREADY_CHECKED_IN`,
   - stale `CHECK_OUT` after the first entry: `ACCEPTED` (historic exit), before it: `REJECTED_NOT_CHECKED_IN`,
   - void / unknown / check-out-not-allowed results are unchanged.

   Every offline-uploaded `CHECK_IN` answered `REJECTED_ALREADY_CHECKED_IN` is journaled as `DUPLICATE_ENTRY`
   (two entries without a check-out: possible copied ticket); the admin portal counts them and marks them in the
   scan log. Consequences: a late check-in of another device cannot undo a check-out, a late check-out cannot flip
   a newer check-in, and a guest can always enter again after the last recorded exit. In every case any
   `CHECK_IN` older than `first_checked_in_at` becomes the first entry, so "who scanned first" is accurate.

4. **Concurrency.** The ticket rows of a request are locked `FOR UPDATE ORDER BY id`, so concurrent
   uploads and online scans serialize per ticket without deadlocks; exactly one of two simultaneous
   check-ins is accepted.
5. **Idempotency.** `(device, clientScanId)` is unique: retries return the recorded decision
   (`duplicate: true`) and never change state twice.
6. Scans for events not assigned to the device are answered `REJECTED_WRONG_EVENT` with `recorded: false`.
7. A batch never fails because of one bad scan: an unknown `entranceId` (entrance deleted in the editor)
   falls back to the device's assignment, and a `payload` of up to 2048 characters is accepted (anything
   that is not a valid ticket payload, e.g. longer than 400 characters, is `REJECTED_MALFORMED`; only the
   first 512 characters are journaled). Only structural errors (422) reject a whole request.
8. A retry of a batch that is still being processed is safe: the journal is re-read after the ticket
   rows are locked and the unique `(device, clientScanId)` insert decides which request applies a scan.

## Admin portal

- `/admin/scanners` (EVENT_MANAGER, SUPER_ADMIN manage; DOOR_STAFF read-only): paired devices, pairing
  dialog (QR + code, polling until the device paired), edit (name, events, entrance, check-out), revoke,
  app download (link + QR), APK upload / publish / delete (SUPER_ADMIN), per-event check-in overview.
- Event tab "Check-in": live statistics and the scan journal with filters (result, device).
- Settings -> Scanner: `serverUrl`, `allowCheckOut`, `offlineModeAllowed`, `lanSyncEnabled`,
  `syncIntervalSeconds`, `pairingCodeTtlMinutes`. A phone cannot reach `localhost`: set `serverUrl` to the
  server's address on the venue network, otherwise the pairing page shows a warning.
- Revoking a device invalidates its token immediately (the next request is `401 DEVICE_REVOKED`) and rotates
  the LAN secret of its events (also when a device is removed from an event).
- A warning is shown when the scanner server address is plain `http://` to a public host (tokens would
  travel unencrypted); private network addresses (10.x, 172.16-31.x, 192.168.x, `.local`) are fine.
- A backup restore rotates `syncEpoch` (see above) and rewrites `sync_xid` of all tickets to the restore
  transaction, so restored rows are not re-delivered forever; devices wipe and resync.
- APKs are stored privately in the documents bucket under `scanner-apk/` (size limit 150 MB, ZIP magic
  checked; version name / code are entered by the admin, the binary manifest is not parsed) and are
  therefore included in the document backups.
