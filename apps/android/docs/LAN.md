# LAN sync (check-in app, protocol version 1)

Scanners in one venue WiFi share check-ins through ONE master device so a ticket cannot enter at door A
and door B while the internet is down. No staff login: the per-event `lan.secret` from the manifest
(`docs/SCANNER.md`, base64url, 32 bytes, identical for all devices assigned to the event, rotated by the
server when a device is revoked/unassigned) is the only credential. See "Security model" below for what that means.

Code: `:core` package `org.tix.checkin.core.lan` (protocol, crypto, master handler, client logic, a tiny
socket HTTP server/client - all unit-tested on the JVM), `:app` package `org.tix.checkin.lan` (NSD,
foreground service, wiring).

## Security model (read this before relying on LAN)

- **Authentication is the shared per-event secret and nothing else.** Every device assigned to the event holds it
  (it is part of the manifest). Anyone who has it - a staff device, a rooted phone, a device that was revoked
  while it still holds the old secret - can read all LAN traffic of that event, send requests as ANY device id
  (the device id in a request is a label inside the authenticated envelope, not a separate credential), and can
  answer as a master if it is reachable under the master's address. The envelope protects against outsiders on the
  venue WiFi and against tampering/replay, not against holders of the secret.
- **A revoked device keeps LAN access until the master has fetched the rotated manifest** (the server rotates the
  secret on revocation). While the internet is down the master cannot fetch it: the revoked device stays
  trusted on the LAN until connectivity returns and the master syncs. There is no grace period for old secrets
  after that: only the CURRENT secret is accepted.
- Mitigations that are implemented:
  - The answering device id is authenticated (part of the response AAD) and must equal the advertised / known master
    id; a hello whose id differs from the authenticated header or the advertised id is not a valid master.
  - The master logs the device id and path of every authenticated request (bounded in-memory log,
    `LanPeers.recentRequests`, ids only, no ticket data), so an unexpected device id is visible.
  - The master decides only inside the event of the authenticated envelope: a ticket of another event is RED
    (`REJECTED_WRONG_EVENT`), a row of another event is never replaced.
  - Only sources on the local network (loopback, private IPv4, link-local, IPv6 unique-local) get a connection;
    a global IPv6 address reaching the phone over mobile data is dropped before it takes a slot.
  - Connection caps and hard deadlines (see "Transport").
- Two masters for one event are possible if two devices switch master mode on. Both browse DNS-SD, show a prominent
  warning when another master serves one of their events, and clients that see both pick one deterministically
  (see "Master selection"). Keep exactly one master on.

## Roles and precedence

- **Server online**: every device talks to the server directly. LAN is idle (clients only ping the master).
- **Server unreachable, master reachable**: a client sends the scan to the master, which decides.
- **Both unreachable**: the device decides alone (as before) and reports the scan to the master later.
- The **master** (Settings -> LAN, only possible when the server delivered a LAN secret) uses its normal
  chain (server -> local) and additionally serves LAN requests from the same local database. Every
  read-modify-write of ticket rows (own scans, LAN requests, server answers, delta pages, upload outcomes, LAN
  states) runs under one lock (`dbLock`, always taken before the Room transaction), and a decision and its write
  happen inside one critical section, so they cannot race (e.g. a cancellation from a delta page can never be
  overwritten by a decision that read the ticket as valid a moment earlier).
- Per scan on a client: server (if usable and the ticket has no unsent local state) -> LAN master -> local.
  Exception: if this device's own unsent state already makes the answer RED (e.g. the ticket is checked in
  here and the check-in is not reported yet) the master is not asked - it could not know and would admit
  the guest again.
- The master is not "forwarding to the server": each scan is uploaded by the device that made it, with its
  own device id and `clientScanId` (journal row `decidedBy = LAN`, `uploaded = false`), so the server
  journal stays correct and idempotent. The master writes only the ticket state (no journal row).
- Failure handling: scan timeout 800 ms as a hard deadline per LAN call (a peer that trickles bytes cannot exceed it; the
  socket is closed on timeout and the scan falls back to a local decision); on error the master is skipped for 5 s
  (no stall), a 401 for one event only blocks that event for 15 s.

## Discovery and master selection

DNS-SD service type `_tixscan._tcp`, TXT: `v` (protocol), `id` (master device id), `n` (name, <= 40),
`ev` (comma separated 8-hex hashes `sha256("tix-lan-ev:" + eventId)[0..4]`, <= 20). No secrets, no event ids.
The hash only pre-filters; the encrypted `hello` decides. Fallback: manual `host:port` in the settings (also
`[v6]:port`; both discovered and manual addresses must pass `ServerUrlPolicy`: private / link-local / loopback only).
A WifiManager multicast lock is held while advertising/browsing. The advert is registered again whenever the
set of served LAN events or the device name changes.

A **valid hello** requires that the answer decrypts (this proves the secret), that the device id inside equals the
authenticated response header, and - when known from the advert - the advertised device id.

**Selection rule (one rule, the same on every client):**
1. The current master is kept while it answers (no flapping).
2. Otherwise ALL candidates (up to 16) are probed in parallel with a 600 ms timeout, and among the valid answers the
   **last successful master** wins if it answers, else the one with the **lowest device id**.
3. The duplicate-master warning on a client comes from the live DNS-SD list (more than one distinct master advertises
   one of its events) and disappears when the second master is switched off. The master itself browses
   DNS-SD (while master mode is on) and shows the same warning when another device advertises one of its events.

## Transport

HTTP/1.1, one request per connection, `POST` only, `Content-Length` bodies (no chunked encoding), default port
47800 (configurable). Request and response bodies are capped at 1 MiB; buffers grow with the bytes that really
arrive (no allocation from the announced length). The body is ciphertext + tag (the nonce travels in a header);
all JSON lives inside the envelope. Plain `java.net` sockets (no Ktor server, no OkHttp: the server token never
goes to a peer).

Server limits: at most 32 connections (8 of them reserved for sources that authenticated successfully in the last 5 minutes, so unauthenticated peers cannot fill the server), at most 4 per source (IPv6 peers are counted per /64 prefix); every phase of a connection (reading the
request, writing the answer) has a hard 3 s deadline enforced by a timer that closes the socket (slow-loris safe);
a handler error answers 500 and always releases the slot. If the listener breaks the server closes its socket
(`isRunning` turns false) and the app-scope status ticker (every 2 s, also with the app in the background) starts it
again; the visible activity restarts it as well.

## Envelope (AES-256-GCM)

- Key: `HKDF-SHA256(ikm = lanSecret of the event, salt = empty, info = "tix-lan-v1", 32 bytes)`.
- Per message a random 96-bit nonce; body = `ciphertext || 16-byte tag`.
- Request headers (clear): `X-Tix-Event`, `X-Tix-Device`, `X-Tix-Ts` (ms, server-corrected clock),
  `X-Tix-Nonce` (base64url), `X-Tix-Key` (key id = base64url(SHA-256(secret)[0..8])).
- Request AAD: `"tix-lan-v1\n" + method + "\n" + path + "\n" + eventId + "\n" + ts + "\n" + deviceId`.
- Response headers: `X-Tix-Event`, `X-Tix-Device` (master), `X-Tix-Ts`, `X-Tix-Nonce`.
  Response AAD: `"tix-lan-v1\nRESPONSE\n" + path + "\n" + eventId + "\n" + ts + "\n" + masterDeviceId + "\n" + requestNonce`
  (bound to the request, so an old answer cannot be replayed to a new request).
- Receiver checks: event known (has a secret), key id, `|ts - now| <= 60 s`, GCM tag, nonce not seen
  (bounded LRU keyed `deviceId:nonce`, filled only after a successful decrypt).
- Every authentication problem is a bare `401` without body. Two cases add `X-Tix-Error` (neither reveals anything
  usable): `key-mismatch` (the key id is a hash prefix; the app shows "LAN key outdated - sync with server") and
  `clock` (the timestamp is outside the 60 s window, checked before any decryption; the app shows "Clock differs from
  master - check time settings"). Only the CURRENT secret is accepted; there is no grace period for old secrets.
- `404` unknown path / `400` malformed body / `500` internal are sent after authentication.

## Messages (JSON, `ScannerJson`, all under `/lan/v1`)

All are `POST` (a GET with a body would be non-standard; `hello` is a POST too).

| Path     | Request                                           | Response                                                      |
| -------- | ------------------------------------------------- | ------------------------------------------------------------- |
| `/hello` | `{deviceName}`                                    | `{protocol, deviceId, deviceName, events[]}`                  |
| `/scan`  | `{scan: ScanRequest, deviceName}`                 | `{clientScanId, result, notice, warnings, warningTexts, ticket, firstScan, state, provisional}` |
| `/sync`  | `{eventId, cursor, limit}`                        | `{changes: LanTicketState[], nextCursor, hasMore, maxCursor, epoch}` |
| `/scans` | `{deviceName, scans: [{scan: ScanRequest, result}]}` | `{results: [{clientScanId, applied}]}`                     |

- `/scan`: the master verifies the signature itself and runs the same `decideScan` table with the
  scanning device's entrance and name (`firstCheckedInDeviceName` = the client). The decision is bound to the
  authenticated envelope event (see "Security model"). Check-out permission is checked by the client before asking.
  Idempotent per `(deviceId, clientScanId)` (a client that timed out and decided locally with the same id gets the
  same answer on retry; another device using the same id does not). `state` carries the ticket's check-in fields so
  the client mirrors them (also for RED results, e.g. already checked in).
- `/sync`: change feed of tickets whose state changed on the master (scans, reported scans, and status/check-in
  changes learned from the server); `cursor` is a position (`tickets.lanSeq`). `epoch` names the generation of the
  master's counter: a client whose stored epoch for that master differs drops its cursor and starts at 0 (a master
  whose data was wiped / that was paired again counts from 1 again, which a plain cursor cannot detect). A client
  cursor above `maxCursor` (an older master without epoch) is restarted at 0 as well. Clients pull only while the
  server is not usable.
- `/scans`: offline scans the client decided alone (`decidedBy = LOCAL`, oldest first). The reported-up-to
  watermark is kept per (master, event) and counts local journal rows (append position), not scan times: a new
  master receives every scan it has not acknowledged, and a clock correction cannot hide a scan. The master applies
  accepted ones with the server's stale rule (`Merge.afterReportedScan`): a scan older than the ticket's last scan
  never changes the state; a stale check-in older than the first entry only moves the first-entry info; duplicates
  (same device and `clientScanId`) are ignored. A scan counts as done only after its commit succeeded.

## State rules

- `tickets.lanDirty` marks check-in fields learned from/decided for the LAN that the server may not know
  yet. A server delta row does not overwrite them until its `lastScanAt` (parsed, not string-compared)
  reaches ours; a tombstone always wins. `localDirty` keeps its old meaning (own unsent journal rows).
  A forced resync / epoch change deletes only rows that are neither `localDirty` nor `lanDirty`, and clears the
  LAN cursors (and epochs) of every master in the same reset.
- `lanSeq` numbers state changes on the master. It comes from a persistent counter (single-row table `lan_state`),
  incremented in the same transaction as the change, so a position is never reused - not after rows were deleted either.
  The table also holds the counter's `epoch` (created with the row; wiping the database starts a new one).
- Changes learned from the server also get a position: a delta row that changes status or any check-in field
  bumps `lanSeq`, so cancellations and check-ins made elsewhere reach the LAN clients through the feed.
- A client adopts a non-VALID status from the master (a tombstone, checked before the time rule, never revived by
  the LAN) and creates a tombstone row for a void ticket it does not know yet, so a scan of it is RED.
- Room schema v1 (`tickets.lanDirty` / `lanSeq`, `lan_state`, `scan_journal.seq` are part of it; no build was shipped
  before, so there are no migrations - the first release defines version 1).

## Android

- Master: foreground service `LanMasterService`, type `connectedDevice` (network/peer service; its
  prerequisite permission is `CHANGE_WIFI_MULTICAST_STATE`). `dataSync` is not used (Android 15 time
  limit). Permissions: `ACCESS_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_CONNECTED_DEVICE`, `POST_NOTIFICATIONS` (requested when the toggle is switched on;
  the service runs without it, only the notification is hidden). NSD needs no `NEARBY_WIFI_DEVICES`.
- The service is started from the visible app (settings toggle, `MainActivity`; Android 12+ background start limits)
  and is `START_STICKY`: after the process was killed the system restarts it, and it waits for the paired
  configuration to load before starting the server (it never shuts the master down because the configuration is not
  loaded yet). While master mode is on the service also runs the server sync loop, so the master keeps pulling tickets
  and cancellations with the app in the background (it coalesces with the activity's own loop).
- The server socket listens on all interfaces: every request must pass the source filter and the envelope, and a
  changing WiFi address needs no rebinding.
- Backup: `allowBackup=false`, plus `dataExtractionRules` (API 31+) and `fullBackupContent` (older) that exclude every
  domain from cloud backup AND device-to-device transfer (the database holds the Keystore-bound device token and the scan journal).

## Known limitations

- While the master is online, scans that online clients send straight to the server reach the master only
  with its next delta sync (it does not call `/scan` for them: that would record a second scan under the
  master's device id).
- Scans a client sent to the server are not reported to the master (the master learns them from the server).
- LAN clients pull every 10 s; the LAN log is the ticket table itself (no separate log table).
- A revoked device keeps LAN access until the master fetched the rotated manifest (see "Security model").
- Not tested on real devices (NSD, multicast lock, foreground service, sticky restart, Keystore failures).
