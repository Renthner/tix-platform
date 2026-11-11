# Releases

Releases are published on GitHub (Releases page) together with container images on GHCR and the
Android check-in APK (signed). Images are signed with cosign, the APK and the deploy bundle carry
build provenance attestations (see [Verifying releases](#verifying-releases)). They are produced by `.github/workflows/release.yml` when a version
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
To re-run it for an existing tag use Actions -> Release -> Run workflow, select the **tag** under "Use workflow from" (not `main`) and enter the same tag (`gh workflow run Release --ref v1.0.0-alpha.3 -f tag=v1.0.0-alpha.3`). The signature identity contains the ref the workflow ran from, so a run from `main` would not match the verification command in [Verifying releases](#verifying-releases); the workflow refuses such a run.

### Published artifacts

| Artifact                                                | Notes                                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ghcr.io/<owner>/tix-web`, `tix-worker`, `tix-realtime` | linux/amd64 + linux/arm64, signed, with SBOM and provenance; tags `<version>` plus the moving channel tags (see [Channels](#channels)) |
| `docker-compose.yml`, `env.example`                     | the two files a server needs (config inline, see Deploying); `env.example` = `.env.example`                                            |
| `tix-deploy-<version>.zip`                              | both files plus README                                                                                                                 |
| `tix-checkin-<version>.apk`                             | release asset, only when the signing secrets exist                                                                                     |
| `SHA256SUMS.txt`                                        | checksums of the compose file, env.example, the zip and the APK                                                                        |

The one-shot `migrate` service uses the worker image (as in `docker-compose.yml`), so there is
no separate migrate image. The packages must be readable by your servers: after the first
release set each of the three packages (`tix-web`, `tix-worker`, `tix-realtime`) to **public**
(GitHub -> your profile/organisation -> Packages -> package -> Package settings -> Change
visibility), so servers can pull without logging in. `docker login ghcr.io` (token with
`read:packages`) is only needed while a package is private. **Never delete untagged versions** of the `tix-*` packages: the per-architecture images, SBOM / provenance attestations and signatures are untagged versions that the tags depend on. Only the old single `buildcache` tag of the amd64-only releases is obsolete (it is now `buildcache-amd64` / `buildcache-arm64`).

## Verifying releases

Everything below is optional for operators but lets you check that an artifact really was built by
this repository's release workflow from the tagged commit.

**Container images** (keyless cosign signature on the multi-arch image index; the moving tags
`next`, `stable`, ... point to the same signed index):

```bash
cosign verify ghcr.io/<owner>/tix-web:<version> \
  --certificate-identity-regexp '^https://github\.com/<owner>/<repo>/\.github/workflows/release\.yml@refs/tags/v.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The same for `tix-worker` and `tix-realtime`. `<owner>` is the lower-case GitHub owner of the images, `<repo>` the repository the release
was built in (case as on GitHub). SBOM and SLSA provenance are stored as attestations in the image (`docker buildx
imagetools inspect <image> --format '{{ json .SBOM }}'` / `'{{ json .Provenance }}'`).

**APK, compose file and deploy bundle** (GitHub artifact attestations):

```bash
gh attestation verify tix-checkin-<version>.apk -R <owner>/<repo> \
  --signer-workflow <owner>/<repo>/.github/workflows/release.yml
gh attestation verify docker-compose.yml -R <owner>/<repo> \
  --signer-workflow <owner>/<repo>/.github/workflows/release.yml
gh attestation verify tix-deploy-<version>.zip -R <owner>/<repo> \
  --signer-workflow <owner>/<repo>/.github/workflows/release.yml
```

**Checksums:** `sha256sum -c SHA256SUMS.txt` in the folder with the downloaded files (add
`--ignore-missing` if you only downloaded some of them). A checksum from the same release page
only detects a corrupted download; use the signature / attestation to check the origin.

## Architectures

Images are built for `linux/amd64` and `linux/arm64` (Raspberry Pi 4/5 with a 64-bit OS, Apple
silicon servers, Ampere / Graviton cloud VMs); Docker pulls the matching one automatically. Each
architecture is built **natively** (`ubuntu-latest` and `ubuntu-24.04-arm`, both free for public
repositories) and the two results are merged into one index. QEMU emulation was rejected: the
Next.js build and the native `sharp` install would take far too long emulated. The arm64 job
always uses GitHub's arm runner; the `CI_RUNS_ON` override only applies to the other jobs.
`sharp` ships prebuilt musl binaries for both architectures, so the Dockerfile has no
architecture-specific code. MinIO / Caddy / PostgreSQL / Redis from the compose file are multi-arch
as well (check the MinIO image you configure).

## Security scanning

- Every pushed image is scanned by Trivy (CRITICAL and HIGH, unfixed issues ignored) in the release
  workflow; results are uploaded as SARIF (Security -> Code scanning, categories
  `trivy-image-*`). Findings **never block** a release.
- `.github/workflows/security.yml` repeats this every Monday for the `next` images and scans the
  repository files (dependencies, Dockerfile / workflow misconfiguration, secrets, category
  `trivy-fs`). Run it manually from Actions -> Security scan.
- Code scanning needs a public repository (or GitHub Advanced Security on a private one); the upload
  step is allowed to fail so the workflows still pass without it.
- All third-party GitHub Actions are pinned by full commit SHA (the version is in a comment).

## Dependency updates

`.github/dependabot.yml` opens weekly pull requests for npm (pnpm workspace), Gradle
(`apps/android`), GitHub Actions and the images in both compose files (PostgreSQL / Redis major versions are excluded: upgrade those by hand, and keep `docker-compose.yml` and `deploy/docker-compose.yml` in step, CI checks it). The Node base image of the Dockerfile is passed via `ARG NODE_IMAGE`, which Dependabot may not follow: bump it by hand when needed. Minor and
patch updates are grouped per ecosystem; major updates are separate PRs. Their CI runs on
GitHub-hosted runners and uses no secrets. Merge only when CI is green and, for Actions, after
checking the new SHA matches the tag shown in the PR. Enable "Dependabot alerts" and "Dependabot
security updates" in Settings -> Advanced Security.

## Channels

Besides the exact version tag every release moves some **channel tags** on the three images
(set by the `promote` job after the images are pushed and the GitHub Release exists):

| Tag                   | Points to                                          | Use for                           |
| --------------------- | -------------------------------------------------- | --------------------------------- |
| `1.0.0-alpha.2`       | exactly this version (never moves)                 | pinning, rollback                 |
| `next`                | newest release of any kind (pre-release or stable) | **demo / test servers**           |
| `alpha`, `beta`, `rc` | newest pre-release of that stage                   | following one stage               |
| `stable`, `latest`    | newest stable release (identical tags)             | **production**                    |
| `1`                   | newest stable `1.x.y`                              | production without major upgrades |
| `1.0`                 | newest stable `1.0.y`                              | production, patch releases only   |

Pre-releases move only `next` and their stage tag; the stable-only tags (`latest`, `stable`, `X`,
`X.Y`) are never moved by a pre-release.

A tag moves only if the new version has the **highest SemVer precedence** among all `v*` tags that
would map to it (`scripts/release/channel-tags.mjs <version>` prints the tags to apply; precedence
is `alpha < beta < rc < final`, then numeric). Examples:

| Published              | Existing releases | Tags moved                                  |
| ---------------------- | ----------------- | ------------------------------------------- |
| `1.0.0-alpha.2`        | `1.0.0-alpha.1`   | `next`, `alpha`                             |
| `1.0.0`                | `1.0.0-rc.1`      | `next`, `latest`, `stable`, `1`, `1.0`      |
| `1.1.0-alpha.1`        | `1.0.0`           | `next`, `alpha`                             |
| `1.0.1`                | `1.1.0-alpha.1`   | `latest`, `stable`, `1`, `1.0` (not `next`) |
| `1.0.1`                | `1.1.0`           | `1.0` only                                  |
| `1.0.0-alpha.1` re-run | `1.0.0-alpha.2`   | none                                        |

The GitHub Release is marked "latest" only for a stable release that is also the highest stable
version; pre-releases never are. The comparison uses the tags of the repository, so keep tags of
failed or abandoned releases out of the repository (delete them) or they block lower versions.

Recommendation: the demo server follows `next`, production follows `stable` (or `1`).

## Deploying with the release files

A server needs exactly two files from the release page: `docker-compose.yml` and `env.example`
(saved as `.env`). The config files (Caddyfile, Redis settings, bucket setup script) are embedded
in the compose file as inline `configs`, so there is no `docker/` folder. Requires Docker Compose
2.23.1 or newer. Checksums are in `SHA256SUMS.txt`.

```bash
mkdir tix && cd tix
curl -LO https://github.com/<owner>/<repo>/releases/download/v<version>/docker-compose.yml
curl -Lo .env https://github.com/<owner>/<repo>/releases/download/v<version>/env.example
# edit .env: secrets, PUBLIC_URL, SITE_ADDRESS, TIX_CHANNEL
docker compose pull && docker compose up -d
docker compose run --rm migrate node dist/create-admin.mjs --email you@example.org --name "Your Name"
```

(`env.example` is the same file as `.env.example` in the zip; GitHub renames release assets with a
leading dot, so it is published without it.) `tix-deploy-<version>.zip` contains both files plus a
`README.md` (TLS options, updates, pinning, backups). Both files have the image owner (the
repository owner, lower case) and the default channel (`next` for pre-releases, `stable`
otherwise) filled in; `TIX_IMAGE_OWNER` / `TIX_CHANNEL` in `.env` override them.

**TLS.** Only the `proxy` service (Caddy) publishes ports; PostgreSQL, Redis and MinIO publish none.

- Caddy as the edge: `SITE_ADDRESS=<domain>`, `PUBLIC_URL=https://<domain>`, `HTTP_PORT=80`,
  `HTTPS_PORT=443` (automatic Let's Encrypt certificates).
- Your own reverse proxy / load balancer / tunnel terminates TLS: keep `SITE_ADDRESS=:80`, pick
  `HTTP_PORT`, forward to it (WebSockets under `/socket.io` included, `Host` preserved) and set
  `TRUSTED_PROXIES` to the proxy's IP / CIDR list (or `private_ranges`). Caddy then reads the
  visitor address from the proxy's `X-Forwarded-For` (right to left) and passes exactly that
  address on, so rate limits and the audit log see the real visitor. Leave it empty when Caddy
  is the edge. No proxy-specific configuration is part of the stack.

Update: `docker compose pull && docker compose up -d`. Roll back: set `TIX_CHANNEL` to an exact
earlier version (only if its schema matches; otherwise restore the backup). Backups: Admin ->
Backups.

**Maintaining the compose file (repository).** `deploy/docker-compose.yml` is a template: the marker
lines `__CADDYFILE__` and `__MINIO_INIT__` are replaced by `docker/caddy/Caddyfile` and
`docker/minio/init.sh` when a release is built (`scripts/release/deploy-bundle.mjs`, helpers in
`compose-embed.mjs`: indented as YAML block scalars with every `$` escaped as `$$`, because
Compose interpolates `content:`). The Redis settings of `docker/redis/redis.conf` are passed as
`redis-server` flags. `node scripts/release/deploy-bundle.mjs <version> <outdir> --owner <github-owner>`
builds the folder and the zip. CI runs `node scripts/release/deploy-bundle.mjs --check`, which
compares the fully resolved services of both compose files (commands, environment, healthchecks,
volumes, dependencies, ports), verifies that the inline configs equal their source files after
unescaping and that every redis.conf directive is a flag, so they cannot drift apart: change
both together. Intentionally different: image source, inline configs instead of bind mounts,
no published PostgreSQL / Redis / MinIO ports.

**Automatic updates:** not recommended. Tools such as Watchtower can pull new images, but an update
can run schema migrations that cannot be rolled back and should be preceded by a backup, so update
deliberately. A demo server on `next` may be updated more freely.

## Android signing secrets

Settings -> Environments -> `release` -> Environment secrets (not repository secrets; see
[Protecting the signing key](#protecting-the-signing-key)):

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

Without these secrets the `android` job **fails** and so does the release (no images are pushed): devices update from the GitHub release, so a release without the signed APK is not published.

### Protecting the signing key

Whoever can push a `v*` tag (or run the workflow) can make the workflow sign an APK. Restrict that:

1. Settings -> Environments -> New environment `release`: set **Deployment branches and tags** to
   a selected tag pattern `v*`, optionally add **Required reviewers** (the maintainer approves
   each release), and move the four `ANDROID_*` secrets there (delete the repository-level copies).
   The android job uses `environment: release`; if the environment or its secrets are missing the
   job fails loudly.
2. Settings -> Rules -> Rulesets -> New tag ruleset: target tags `v*`, restrict creation, update and
   deletion to the maintainers (bypass list), so nobody else can create or move release tags.
3. Keep branch protection on `main` and require 2FA for all collaborators.

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

## Runners

All workflows run on **GitHub-hosted** runners (`ubuntu-latest`, plus `ubuntu-24.04-arm` for the
arm64 image builds); these are free for public repositories. A self-hosted runner is **only for
private forks** and must **never** be attached to a public repository (fork pull requests could run
code on it). If a self-hosted runner from earlier releases still exists (e.g. the demo VM), remove
it:

```bash
cd <runner-directory>
sudo ./svc.sh stop && sudo ./svc.sh uninstall
./config.sh remove --token <removal-token>   # Settings -> Actions -> Runners -> the runner -> Remove
```

Delete the repository variable `CI_RUNS_ON` if it is still set.

### Self-hosted runner for a private fork (Debian)

The workflows keep an optional override: set the repository variable `CI_RUNS_ON` (Settings -> Secrets and
variables -> Actions -> Variables, or from a shell):

```bash
gh variable set CI_RUNS_ON --body '["self-hosted","Linux","X64"]'
```

Every job uses `runs-on: ${{ (vars.CI_RUNS_ON != '' && github.actor != 'dependabot[bot]') && fromJSON(vars.CI_RUNS_ON) || 'ubuntu-latest' }}`;
Dependabot runs always use GitHub-hosted runners. Delete the variable to go back to GitHub-hosted runners.

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
  `ci.yml` runs fork `pull_request` workflows only while `CI_RUNS_ON` is unset (GitHub-hosted runners); with a self-hosted override they are skipped. Also set Settings -> Actions -> General -> Fork pull request workflows to **Require approval for all outside collaborators**, so a maintainer reviews a fork PR before CI runs. Fork PRs get no secrets and a read-only token.

## Updating a server to a new version

With the release files (see above): `docker compose pull && docker compose up -d` (or change
`TIX_CHANNEL` first). Take a backup first (Admin -> Backups) and read the release notes: alpha
versions may contain schema changes that cannot be rolled back. `GET /api/health` reports the
running `version`.

In a repository checkout, the override file still works:

```bash
export TIX_IMAGE_OWNER=<github-owner, lower case>
export TIX_IMAGE_TAG=1.0.0-alpha.2        # or a channel such as next
docker compose -f docker-compose.yml -f docker-compose.release.yml pull
docker compose -f docker-compose.yml -f docker-compose.release.yml up -d --no-build
```

Building from source also works: `git checkout v1.0.0-alpha.2 && docker compose up -d --build`.

## Updating the check-in app

1. Download `tix-checkin-<version>.apk` from the GitHub Release.
2. Admin -> Check-in devices -> Scanner app -> Upload a new version (SUPER_ADMIN): choose the APK and
   enter the same version name and version code as in the release (`--print` shows the code); keep
   "Publish as current version" ticked.
3. Paired devices see the update in Settings; staff without a paired phone use the download link /
   QR code. The APK installs over the old one (same signing key, higher versionCode). Details:
   [apps/android/README.md](../apps/android/README.md) ("Publishing an update").
