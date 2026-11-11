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

## Self-hosted runner (Debian)

Both workflows (`ci.yml`, `release.yml`) run on GitHub-hosted `ubuntu-latest` by default. To use
your own Linux runner instead, set the repository variable `CI_RUNS_ON` (Settings -> Secrets and
variables -> Actions -> Variables, or from a shell):

```bash
gh variable set CI_RUNS_ON --body '["self-hosted","Linux","X64"]'
```

Every job uses `runs-on: ${{ vars.CI_RUNS_ON && fromJSON(vars.CI_RUNS_ON) || 'ubuntu-latest' }}`;
delete the variable to go back to GitHub-hosted runners.

### Prerequisites (runner host)

- Debian (or similar) x86-64 VM, runner user **without** root rights is enough: the workflows never
  call `sudo`.
- Docker Engine with the buildx plugin; the runner user must be in the `docker` group.
- `curl`, `unzip`, `git`, `tar` (needed by the runner, `setup-android` and the Android build).
- About 15 GB free disk (Gradle, Android SDK, Docker images, pnpm store) and outbound HTTPS to
  github.com, ghcr.io, Docker Hub, npm, Google (Android SDK / Maven) and the Gradle services.
- Node, Java and the Android SDK are downloaded by `actions/setup-node`, `actions/setup-java` and
  `android-actions/setup-android` into the runner's own directories / the user's home.

### Install and run as a service

1. Repository Settings -> Actions -> Runners -> New self-hosted runner (Linux, x64); run the shown
   download and `./config.sh --url ... --token ...` commands as the runner user (default labels
   `self-hosted`, `Linux`, `X64`).
2. Install it as a systemd service (the only step needing root, done once by an administrator):

   ```bash
   sudo ./svc.sh install <runner-user>
   sudo ./svc.sh start
   sudo ./svc.sh status
   ```

3. Logs: `journalctl -u 'actions.runner.*' -f`.

### What the workflows do on the host

- PostgreSQL 18 and Redis 8 for the tests run as plain containers `tix-ci-pg-<run>-<attempt>` /
  `tix-ci-redis-<run>-<attempt>` on **ephemeral** ports bound to `127.0.0.1`, so they never clash
  with a PostgreSQL / Redis or the shop stack on the same server. They are removed in an
  `if: always()` step.
- `pg_dump`, `pg_restore` and `psql` are wrapper scripts in `$RUNNER_TEMP/bin` that run the tools
  from the `postgres:18` image (`--network host`, `PG*` variables forwarded, stdin/stdout piped).
- The workflows only create and remove containers with their own per-run names, never use
  `docker compose` (no project name such as `tix` is touched), bind only ephemeral `127.0.0.1`
  ports (never 80/443/8080/8443/5432/6379) and run **no** `docker prune` of any kind. Release images
  are built by buildx (container driver, removed after the job) and pushed to GHCR with
  `push: true` and no `load`, so no image tags appear in the host daemon. Never add
  `docker system prune` or similar to the workflows. Pulled base images (`postgres:18`,
  `postgres:18-alpine`, `redis:8-alpine`) stay cached; remove them manually if disk gets tight.
- Register **one** runner on the host: a runner executes one job at a time, which is how at most
  one workflow job of this repository runs there at once (CI's `node` and `android` jobs and the
  three image builds queue up instead of running in parallel). Releases and CI runs cause
  noticeable CPU and disk load (Gradle, Docker builds): do not trigger them while the VM serves a
  live demo or presentation.
- `concurrency` groups keep two runs of the same ref / tag from running side by side;
  `actions/checkout` cleans the reused workspace.

### Security

A self-hosted runner executes repository code with the rights of its user.

- Use a dedicated VM and user with no access to production data, backups or secrets. The runner
  user is in the `docker` group, which is root-equivalent on the host: acceptable for a private
  repository with a single maintainer on a demo VM, **not** on the production server. Move the
  runner to a separate VM/host before going to production.
- Use it for a **private** repository only. Never attach a self-hosted runner to a public repository
  that accepts pull requests from forks.
- Keep the workflows on `push`, tags and `workflow_dispatch`; never use `pull_request_target`.
  `ci.yml` also skips `pull_request` runs whose head repository is not this repository (fork PRs).

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
