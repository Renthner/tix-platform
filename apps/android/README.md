# Check-in App (Android)

Offline-first door scanner (Phase 6). Native Kotlin, Jetpack Compose (Material 3), CameraX + ML Kit
barcode scanning (bundled model, QR only), Ktor client (OkHttp engine, kotlinx.serialization),
WorkManager, Room (SQLite, KSP 2.3.13 + Room 2.8.5 work with AGP 9.5.1 built-in Kotlin 2.4.21).
Distributed as a signed APK that is sideloaded (no Play Store). LAN sync via a master device
is built on the `ScanAuthority` seam (see "LAN protocol").

This directory is a standalone Gradle build. It is **not** part of the pnpm workspace or the
Turbo pipelines (there is no `package.json`), so `pnpm typecheck` / `pnpm test` ignore it.

## Modules

| Module  | Type            | Purpose                                                                         |
| ------- | --------------- | ------------------------------------------------------------------------------- |
| `:core` | pure Kotlin/JVM | Ticket QR parsing + Ed25519 verification, scan decisions, URL policy, utilities |
| `:app`  | Android app     | Compose UI, CameraX/ML Kit scanner, HTTP client, (later) Room + WorkManager sync |

Everything that can be unit-tested lives in `:core` (JUnit 5). `:core` has no Android
dependencies; the later LAN-sync protocol logic belongs there too so a master device and the
other scanners share one implementation.

Package `org.tix.checkin`, application id `org.tix.checkin`, app name "TIX Check-in" (organiser
branding comes from the server). UI languages: English (default) and German
(`values/strings.xml`, `values-de/strings.xml`; a unit test asserts identical key sets).

## Architecture

Contract: `docs/SCANNER.md`. All DTOs live in one file, `core/.../contract/Contract.kt` (shared
`ScannerJson`: `explicitNulls = false`, because the server treats `"ticketId": null` as present;
unknown enum values degrade to `UNKNOWN`/RED instead of failing a response).

| Layer (package)      | Content                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `:core` `scan`       | `decideScan` (port of `decision.ts`), `LocalScanAuthority`, `ServerScanAuthority`, `FallbackScanAuthority`, `ScanCoordinator`, `Merge` (state transitions), `LocalSearch` |
| `:core` `sync`       | `TicketSync` (opaque cursor, `hasMore` loop), `ScanUploader` (batches, bisect, quarantine)   |
| `:app` `data`        | Room entities/DAO, `RoomStore` (implements the `:core` store interfaces), `ConfigRepository`, `TokenVault` (Keystore AES/GCM), `AppSettings` |
| `:app` `net`         | `KtorScannerApi` (bearer auth, error mapping), `TixHttpClient` (URL policy guard)            |
| `:app` `sync`        | `SyncManager` (foreground loop + manual runs), `SyncWorker` (WorkManager, network constraint), `ConnectionMonitor` |
| `:app` `ui`          | Compose screens: pairing, events, scanner + result overlay, lookup, history, settings        |

`ScanAuthority` decides "where do scans go / who decides": the app wires
`FallbackScanAuthority(server = ServerScanAuthority, local = LocalScanAuthority)`; the LAN work
package adds a master-device authority there.

### Offline behaviour

- Online (network and last request OK): `POST /scan` with a 1.5 s timeout; on timeout/network
  error/5xx/503/429 the scan is decided locally with the SAME `clientScanId` (a scan the server did
  process is recognised as duplicate on upload). The server's answer wins and is journaled as uploaded.
- Offline (or `offlineModeAllowed = false` -> red "server not reachable", nothing is recorded):
  the decision table runs against the local ticket row, the manifest's ticket types and the block ->
  entrance map. A valid signature without a local row is admitted (check-in only) as a provisional
  ticket. The journal row and the new ticket state are written in one transaction, so a second scan
  on this device is red at once. Revoked keys are removed locally; tickets signed with them are red.
- A ticket with an unsent local scan is always decided locally (the server cannot know it yet);
  delta sync never overwrites its check-in fields (`localDirty`), a tombstone always wins.
- Upload: oldest first, <= 100 per batch; outcomes are matched by `clientScanId`; an offline
  green that the server rejected is marked as conflict in the history. A 413/422 batch is bisected,
  a single refused scan is quarantined only when other scans of the same batch got through (a batch that fails as a
  whole - proxy garbage, a server problem - is deferred and retried, never quarantined); quarantined scans are retried
  after an app update and counted in the history. Only a 401/403 whose JSON `error` is `INVALID_TOKEN` or
  `DEVICE_REVOKED` unpairs; any other 401 (captive portal, proxy) is treated like an outage. With scans that were never
  uploaded the app does NOT wipe silently: a blocking screen shows their number and offers an export as a JSON file
  (share sheet) before everything is deleted. A Keystore failure (token cannot be decrypted) never unpairs or wipes: the
  journal stays and the operator is told to restart the app or pair again. 503/5xx/network -> offline with exponential
  backoff (5 s .. 60 s, `Retry-After` honoured).
- Sync: manifest with ETag, then per event `cursor` (opaque text) until `hasMore = false`; a changed
  `syncEpoch` drops synced tickets and cursors but keeps the unsent journal. Clock skew: the offset to
  `serverTime` is learned from every response and applied to `scannedAt` and `sentAt`.

### LAN protocol

Several scanners in one venue WiFi sync through ONE master device (Settings -> LAN) so a ticket cannot
enter at two doors during an internet outage. Chain per scan: server -> LAN master -> this device alone.
Discovery by DNS-SD `_tixscan._tcp` (manual `host:port` fallback); every message is AES-256-GCM encrypted
with a key derived (HKDF-SHA256) from the event's `lan.secret`, bound to method/path/event/time/device,
replay- and clock-protected; an outdated key is reported ("LAN key outdated - sync with server").
Full specification, security model and limits: `docs/LAN.md`. Code: `:core` `lan` package (+ tests), `:app` `lan` package.
Every read-modify-write of ticket rows runs under one shared lock (`dbLock`; `Locked*Store` wrappers in `:core`).

### Pairing with a local server

Set Settings -> Scanner -> server URL in the admin to the PC's LAN address (e.g.
`http://192.168.1.20:8080`; `localhost` is not reachable from a phone), create a pairing code in
Check-in devices and scan its QR code in the app (or enter address + code manually). Cleartext
http is only accepted for local-network hosts (see below).

## Ticket QR verification (`:core`)

`TicketPayload.parse` / `TicketPayload.verify` are a byte-for-byte port of
`packages/shared/src/tickets/qr.ts`; the format and the test vector are in `docs/TICKETS.md`.
Ed25519 uses the BouncyCastle lightweight API (`Ed25519Signer`) because the platform provider only
has Ed25519 from API 33 and the app supports API 26+. The scalar half `S >= L` of a signature is
rejected explicitly. Verifiers must pass the expected event id (WRONG_EVENT is decided before any
key lookup) and a `PublicKeyResolver` that looks keys up by `(eventId, keyId)` and returns `null`
for unknown or revoked keys. Duplicate scans are detected by ticket id, never by payload string.

## Network policy (cleartext HTTP)

Android's `network-security-config` can only allow cleartext per domain, not per IP range, and the
server address is entered at runtime. So the manifest permits cleartext globally and the app
enforces the real rule itself: `ServerUrlPolicy` (in `:core`, unit-tested) is applied to **every
request** by the `ServerUrlGuard` plugin of `TixHttpClient` (the only place that creates HTTP
clients; redirects are not followed).

- `https://` is accepted for any host.
- `http://` is accepted only for private IPv4 (10/8, 172.16/12, 192.168/16 - includes the emulator
  host `10.0.2.2`), loopback (`127/8`, `localhost`, `::1`), link-local (`169.254/16`,
  `fe80::/10`) and mDNS `.local` names.
- Everything else (public hosts over http, other schemes, `user@host` URLs) is refused with a
  `ServerUrlRefusedException` before a byte is sent.

Plain HTTP on a trusted venue network is for the admin to decide; prefer https wherever possible.

## Build

### Requirements

- **Android Studio** (or the Android SDK command-line tools) with the SDK platform **android-36.1**
  and current build-tools. Install them in Android Studio under *Settings -> Languages & Frameworks ->
  Android SDK*.
- **A JDK 17 or newer** for Gradle. Android Studio's bundled JBR works, a separately installed JDK
  (17-25) works too. If `java -version` fails, set `JAVA_HOME` to Android Studio's `jbr` folder
  (Windows: `C:\Program Files\Android\Android Studio\jbr`).
- Nothing else: the Gradle wrapper is checked in (Gradle 9.9.0, checksum pinned).

**Android SDK location.** Gradle uses, in this order: `ANDROID_HOME` / `ANDROID_SDK_ROOT`, `sdk.dir` in
`apps/android/local.properties`, or - if neither is set - the default install location
(Windows `%LOCALAPPDATA%\Android\Sdk`, macOS `~/Library/Android/sdk`, Linux `~/Android/Sdk`).
When it finds the SDK there it writes `local.properties` itself (machine specific, git-ignored). If the
SDK lives somewhere else, set `ANDROID_HOME` or create `local.properties` with
`sdk.dir=D\:\\Android\\Sdk` (backslashes and the colon escaped, or use forward slashes).

### Debug build and tests

PowerShell (Windows):

```powershell
cd apps\android
.\gradlew.bat :core:test :app:assembleDebug :app:testDebugUnitTest
# APK: app\build\outputs\apk\debug\app-debug.apk
```

bash (macOS/Linux/Git Bash): the same with `./gradlew`.

A debug APK is signed with the local debug key and is fine for a first try on your own phone; for the
devices at the door use the signed release APK below.

`compileSdk` is 36 with minor version 1 (the platform `android-36.1`), `targetSdk` 36,
`minSdk` 26. Dependency versions live in `gradle/libs.versions.toml`; AndroidX libraries are
pinned to releases that still compile against API 36 (newer ones require compileSdk 37).

### Version

`versionCode` / `versionName` come from Gradle properties (defaults in `gradle.properties`). Every
release you install over an older one needs a **higher `versionCode`**:

```powershell
.\gradlew.bat :app:assembleRelease -Ptix.versionCode=12 -Ptix.versionName=1.2.0
```

### Signed release APK - step by step (Windows / PowerShell)

1. **Create a keystore once** and keep it (and its passwords) safe and backed up. Losing it means every
   device has to uninstall the app before it can install an update. Keep it **outside** the repository:

   ```powershell
   & "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" -genkeypair -v `
     -keystore "$env:USERPROFILE\tix-keys\tix-checkin.jks" -alias tix `
     -keyalg RSA -keysize 4096 -validity 10000
   ```

   (Create the folder first: `New-Item -ItemType Directory -Force "$env:USERPROFILE\tix-keys"`.
   `keytool` asks for a password and your name/organisation; the same password can be used for the
   key.)

2. **Tell the build where the key is** - either a git-ignored `apps\android\keystore.properties`:

   ```properties
   storeFile=C:/Users/<you>/tix-keys/tix-checkin.jks
   storePassword=...
   keyAlias=tix
   keyPassword=...
   ```

   or environment variables for the current PowerShell session:

   ```powershell
   $env:TIX_KEYSTORE_FILE = "$env:USERPROFILE\tix-keys\tix-checkin.jks"
   $env:TIX_KEYSTORE_PASSWORD = '...'
   $env:TIX_KEY_ALIAS = 'tix'
   $env:TIX_KEY_PASSWORD = '...'
   ```

3. **Build** with the release script (runs the unit tests, builds the minified APK, verifies the
   signature and prints path, size and SHA-256):

   ```powershell
   cd apps\android
   .\scripts\build-release.ps1 -VersionName 1.0.0 -VersionCode 1
   # APK: app\build\outputs\apk\release\app-release.apk
   ```

   If PowerShell refuses to run scripts ("running scripts is disabled"), allow it for this session:
   `Set-ExecutionPolicy -Scope Process Bypass`.

   On macOS/Linux/Git Bash use `scripts/build-release.sh 1.0.0 1` (same signing data).

4. **Install on a phone**, either
   - **via USB:** on the phone enable *Developer options* (tap *Settings -> About phone -> Build number*
     seven times) and *USB debugging*, connect it, accept the "Allow USB debugging?" prompt, then
     run the script with `-Install` (uses `adb` from the SDK's `platform-tools`):
     `.\scripts\build-release.ps1 -VersionName 1.0.0 -VersionCode 1 -Install`
     or manually `& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" install -r app\build\outputs\apk\release\app-release.apk`;
   - **without a cable:** upload the APK in the admin portal (see *Publishing an update*) and open the
     download link/QR code on the phone; Android asks once to allow installing apps from the browser.

   An app signed with a **different key** (e.g. an earlier debug build) cannot be updated in place:
   uninstall it first (`adb uninstall org.tix.checkin` or long-press the app icon -> *Uninstall*).

5. **Connect it to your server:** a phone cannot reach `localhost`. In the admin portal set
   *Settings -> Scanner -> Server address for the app* to an address the phone can reach, e.g. the PC's WiFi IP
   `http://192.168.x.y:8080` (phone and PC in the same WiFi; allow the port in the Windows firewall if
   needed), then *Check-in devices -> Pair device* and scan the QR code with the app. Plain `http://`
   is only accepted for private network addresses; everything public must use `https://`.

Without signing data the release build still succeeds but prints a warning and produces
`app-release-unsigned.apk`, which Android refuses to install. Keystores, `keystore.properties`,
`local.properties`, `.gradle/` and `build/` are git-ignored.

The release build is minified and resource-shrunk with R8 (`app/proguard-rules.pro`: kotlinx.serialization
DTOs, wire enums, the BouncyCastle Ed25519 classes, Ktor/OkHttp, coroutines; Room, ML Kit, CameraX and
WorkManager bring their own consumer rules). The size is dominated by the bundled ML Kit barcode model
(about 24 MB). After changing dependencies always smoke-test the release APK on a device: pair,
manual check-in and an offline check-in.

### Troubleshooting

| Message | Fix |
| --- | --- |
| `SDK location not found` | Install the SDK via Android Studio, or set `ANDROID_HOME` / `sdk.dir` (see *Requirements*). |
| `Android SDK not found ... Looked in: ...` | The SDK is not in a default location: set `ANDROID_HOME` to it. |
| `Failed to find target with hash string 'android-36.1'` / missing build-tools | Install *Android SDK Platform 36.1* and the build-tools in Android Studio's SDK Manager. |
| `JAVA_HOME is not set and no 'java' command could be found` / unsupported Java | Set `JAVA_HOME` to Android Studio's `jbr` folder. |
| `WARNING: no release signing configured` | Step 2 is missing or a value is empty. |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | An app signed with another key is installed: uninstall it first. |
| `INSTALL_FAILED_VERSION_DOWNGRADE` | Use a higher `-VersionCode` than the installed one. |
| `adb: no devices/emulators found` / `unauthorized` | Enable USB debugging, accept the prompt on the phone, try another cable/USB mode (*File transfer*). |
| App says the server address is not allowed | Use `https://`, or `http://` only with a private IP (192.168.x.y, 10.x.y.z, 172.16-31.x.y). |

### Publishing an update

1. Build with a `versionCode` higher than the installed one (the script above).
2. In the admin portal open **Check-in devices** -> **Scanner app** -> **Upload a new version**, choose the
   APK file, enter the same **Version name** and **Version code** and keep **Publish as current version**
   ticked (a super admin is required). Alternatively upload first and press **Publish** on the release later.
3. Paired devices see the update in Settings (the app compares `versionCode` and shows the SHA-256);
   staff without a paired phone use **Download link and QR code** (link valid 24 hours).
4. The update check answers "no public address configured" when neither the scanner server address
   (Settings -> Scanner) nor the shop `APP_URL` is set.

## Server contracts

The binding device contract is `docs/SCANNER.md` (machine-readable: `packages/shared/src/scanner/contract.ts`);
the Kotlin DTOs in `core/.../contract/Contract.kt` mirror it and `ContractTest` decodes the documented
examples. Unknown enum values from a newer server degrade to a safe fallback (unknown result = RED).

