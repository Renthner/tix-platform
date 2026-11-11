# Releases

Releases are published on GitHub (Releases page) together with container images on GHCR and the
signed Android check-in APK. They are produced by `.github/workflows/release.yml` when a version
tag is pushed.

## Version scheme

[Semantic Versioning](https://semver.org/) with pre-release tags:

```
MAJOR.MINOR.PATCH                final release        1.0.0
MAJOR.MINOR.PATCH-alpha.N        alpha                1.0.0-alpha.1
MAJOR.MINOR.PATCH-beta.N         beta                 1.0.0-beta.2
MAJOR.MINOR.PATCH-rc.N           release candidate    1.0.0-rc.1
```

The root `VERSION` file is the single source of truth. `scripts/release/set-version.mjs` copies it
into every `package.json`, `packages/shared/src/version.ts` (shown in the admin sidebar, in
`GET /api/health` and in the worker / realtime start log) and `apps/android/gradle.properties`.
CI fails when these drift apart (`node scripts/release/set-version.mjs --check`).

### Android versionCode

Derived deterministically so it always increases:

```
versionCode = MAJOR*1_000_000 + MINOR*10_000 + PATCH*100 + stage
stage: alpha.N -> N (1-29)   beta.N -> 30+N (N 1-29)   rc.N -> 60+N (N 1-29)   final -> 99
```

Examples: `1.0.0-alpha.1` -> 1000001, `1.0.0-beta.1` -> 1000031, `1.0.0` -> 1000099. MINOR and PATCH
must be at most 99, N between 1 and 29; the script rejects anything else.

## Cutting a release

1. Add the new section to `CHANGELOG.md` (`## [1.0.0-alpha.2] - YYYY-MM-DD`); the release body is
   taken from it.
2. `node scripts/release/set-version.mjs 1.0.0-alpha.2`
3. Commit (`VERSION`, `package.json` files, `gradle.properties`, `version.ts`, `CHANGELOG.md`) and
   push to `main`; wait for CI.
4. `git tag v1.0.0-alpha.2 && git push origin v1.0.0-alpha.2`

The workflow then verifies that the tag matches `VERSION` and that the changelog section exists,
re-runs the CI checks, builds and pushes the images, builds the signed APK and creates the GitHub
Release (marked as pre-release when the version has a suffix; named `TIX Platform v<version>`).
To re-run it for an existing tag use Actions -> Release -> Run workflow and enter the tag.

### Published artifacts

| Artifact                                                | Notes                                                                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ghcr.io/<owner>/tix-web`, `tix-worker`, `tix-realtime` | linux/amd64; tags `<version>`, `latest` (final releases only), `alpha` / `beta` / `rc` (moving, latest of that stage) |
| `tix-checkin-<version>.apk`, `SHA256SUMS.txt`           | release assets, only when the signing secrets exist                                                                   |

The one-shot `migrate` service uses the worker image (as in `docker-compose.yml`), so there is
no separate migrate image. The packages must be readable by your servers: after the first
release set the package visibility to public under the repository owner's Packages settings (or
`docker login ghcr.io` on the server).

## Android signing secrets

Repository settings -> Secrets and variables -> Actions:

| Secret                      | Content                           |
| --------------------------- | --------------------------------- |
| `ANDROID_KEYSTORE_BASE64`   | the keystore file, base64 encoded |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password                 |
| `ANDROID_KEY_ALIAS`         | key alias                         |
| `ANDROID_KEY_PASSWORD`      | key password                      |

Base64 in PowerShell (copy the output into the secret):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\tix-keys\tix-checkin.jks"))
```

Always sign releases with the same key; Android refuses updates signed with a different one.
The workflow decodes the keystore to a temporary file, never prints it and deletes it afterwards.

Without these secrets the release is still created (images, notes) but has no APK and says so in
its body.

### Attaching a locally signed APK manually

```bash
cd apps/android
export TIX_KEYSTORE_FILE=... TIX_KEYSTORE_PASSWORD=... TIX_KEY_ALIAS=... TIX_KEY_PASSWORD=...
scripts/build-release.sh 1.0.0-alpha.2 1000002      # scripts/build-release.ps1 on Windows
cp app/build/outputs/apk/release/app-release.apk tix-checkin-1.0.0-alpha.2.apk
sha256sum tix-checkin-1.0.0-alpha.2.apk >> SHA256SUMS.txt
gh release upload v1.0.0-alpha.2 tix-checkin-1.0.0-alpha.2.apk SHA256SUMS.txt --clobber
```

Use the versionCode printed by `node scripts/release/set-version.mjs --print`.

## Updating a server to a new version

With the published images (no build on the server):

```bash
export TIX_IMAGE_OWNER=<github-owner, lower case>
export TIX_IMAGE_TAG=1.0.0-alpha.2
docker compose -f docker-compose.yml -f docker-compose.release.yml pull
docker compose -f docker-compose.yml -f docker-compose.release.yml up -d --no-build
```

`migrate` applies database migrations before web and worker start. Take a backup first (Admin ->
Backups) and read the release notes: alpha versions may contain schema changes that cannot be
rolled back. `GET /api/health` reports the running `version`.

Building from source still works: `git checkout v1.0.0-alpha.2 && docker compose up -d --build`.

## Updating the check-in app

1. Download `tix-checkin-<version>.apk` from the GitHub Release.
2. Admin -> Check-in devices -> Scanner app -> Upload a new version (SUPER_ADMIN): choose the APK and
   enter the same version name and version code as in the release (`--print` shows the code); keep
   "Publish as current version" ticked.
3. Paired devices see the update in Settings; staff without a paired phone use the download link /
   QR code. The APK installs over the old one (same signing key, higher versionCode). Details:
   [apps/android/README.md](../apps/android/README.md) ("Publishing an update").
