# Check-in App (Android)

Offline-first door scanner, implemented in **Phase 6**.

Planned stack: Kotlin, Jetpack Compose, Room (SQLite), CameraX + ML Kit barcode scanning,
Ktor client, WorkManager for background sync.

Server-side contracts already defined in the database schema (see `docs/DATABASE.md`):

- Pairing via one-time QR codes (`device_pairing_codes`) → long-lived device token
  (`scanner_devices.token_hash`).
- Delta sync of tickets via `tickets.sync_version` (monotonic, bumped by trigger).
- Offline verification of QR payloads with the event's Ed25519 public key
  (`event_signing_keys`).
- Idempotent upload of offline scans via `(device_id, client_scan_id)` on `check_in_logs`.
