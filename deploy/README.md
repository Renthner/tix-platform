# TIX Platform **TIX_VERSION** - deployment

Runs the published container image `ghcr.io/__TIX_IMAGE_OWNER__/tix` (shop, admin, realtime
gateway and worker in one container) together with PostgreSQL and Redis; nothing is built on the
server. You need exactly **two files**: `docker-compose.yml` and `.env`.

Requirements: Docker Engine with **Docker Compose >= 2.23.1** (`docker compose version`; distribution packages are often older: install Docker from Docker's official repository).

The complete step-by-step guide (HTTPS with your own reverse proxy: Caddy, Traefik, nginx, Nginx Proxy Manager; first configuration; troubleshooting): https://github.com/__TIX_REPOSITORY__/blob/v__TIX_VERSION__/docs/INSTALL.md

> **Upgrading from the three-image layout** (`tix-web` / `tix-worker` / `tix-realtime`, bundled Caddy and MinIO)? Do not replace your compose file: follow https://github.com/__TIX_REPOSITORY__/blob/v__TIX_VERSION__/docs/MIGRATE-SINGLE-IMAGE.md

## Quick start

```bash
mkdir tix && cd tix
curl -LO https://github.com/__TIX_REPOSITORY__/releases/download/v__TIX_VERSION__/docker-compose.yml
curl -Lo .env https://github.com/__TIX_REPOSITORY__/releases/download/v__TIX_VERSION__/env.example
# edit .env: APP_URL, POSTGRES_PASSWORD, APP_ENCRYPTION_KEYS (docker run --rm ghcr.io/__TIX_IMAGE_OWNER__/tix:__TIX_VERSION__ keygen)

docker compose pull
docker compose up -d
docker compose run --rm tix create-admin --email you@example.org --name "Your Name"
```

Database migrations run automatically when the container starts. The shop listens on plain HTTP
on `HTTP_PORT` (default 8080). Open `APP_URL`, sign in with the admin account and configure
everything else (SMTP, payments, branding ...) in the admin portal. Keep `.env` and a copy of
`APP_ENCRYPTION_KEYS` private and backed up outside the server.

If the packages are private (the published ones should be public), log in first with a GitHub
token that has the `read:packages` scope:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
```

## HTTPS / reverse proxy

The image speaks plain HTTP only. Put a reverse proxy in front that terminates TLS (Caddy,
Traefik, nginx, Nginx Proxy Manager, a Cloudflare tunnel ...) and forwards your site to
`http://<server>:<HTTP_PORT>`, including WebSockets (`/socket.io`) and the original `Host` header.
Set `APP_URL` to the public https address.

**Set `TRUSTED_PROXIES`** in `.env` to the address(es) of that proxy (space-separated IPs / CIDRs,
or `private_ranges` for all private networks). TIX then reads the visitor address from the
`X-Forwarded-For` header your proxy sends. Left empty, nobody is trusted: every visitor appears with
the proxy's address, so rate limits and the audit log would treat all visitors as one.

With an `https://` `APP_URL` a proxy is always in front: use its **exact IP/CIDR** (not a broad range)
and publish the port only on the proxy's interface (`HTTP_PORT=127.0.0.1:8081`). TIX warns at startup
about an empty list with https, about `private_ranges` and about `0.0.0.0/0`.

The built-in proxy answers **421** to a foreign `Host` header from an untrusted address when `APP_URL` is
not a loopback address, so `http://<server-ip>:8080` does not work directly: add the name to
`TIX_ALLOWED_HOSTS` (comma separated, `*` = any) if you need it. Optional limits (defaults in brackets):
`TIX_PROXY_SOCKET_TIMEOUT_MS` (120000), `TIX_PROXY_REQUEST_TIMEOUT_MS` (3600000),
`TIX_PROXY_MAX_CONNS_PER_IP` (200); `0` disables each. Each process only receives the secrets it needs
and the internal realtime/worker ports listen on `127.0.0.1` inside the container. Details:
[docs/INSTALL.md](../docs/INSTALL.md#built-in-proxy-host-check-and-limits).

## Update

1. Read the release notes.
2. `./tix-update.sh` (the script of the release, saved next to `docker-compose.yml`; `--dry-run`
   only shows what would change; `./tix-update.sh 1.2.0` or `./tix-update.sh stable` choose a
   version or channel). It downloads the `docker-compose.yml` of the target release, verifies its
   checksum, keeps the old file as `docker-compose.yml.bak-<time>`, pulls the image and restarts
   the stack. `.env` and `docker-compose.override.yml` are never touched.

By hand: download the `docker-compose.yml` of the release (keep your `.env`), then
`docker compose pull && docker compose up -d`.

Before database changes of an update are applied, an encrypted database backup is taken
automatically (Admin -> Backups, "Before update"); if that fails, nothing is migrated. Restoring it
keeps the new version and brings back the old data; going back to an older version is not supported
once a newer schema was applied (`tix-update.sh` refuses a lower version without `--force`). The running
version is shown in Admin -> System, the admin sidebar and in `GET /api/health`.

## Versions

`TIX_VERSION` in `.env` selects the image: `stable` (newest stable release, production), `next`
(newest release incl. pre-releases, test servers), `1` / `1.0` (stable line) or an exact version
such as `__TIX_VERSION__` (pin). Pinning an earlier version works only while the database schema is
unchanged; once a newer release migrated the database, going back is not supported.

## Backups

Use Admin -> Backups (database + files, optional upload to an external S3 target). Without an
external target the backups live in the same volume as the files: they survive container updates
but not the loss of the disk. The data lives in the Docker volumes `tix-data`, `postgres-data` and
`redis-data` of the compose project (name from `COMPOSE_PROJECT_NAME`, default `tix`). Restoring on
another server needs the same `APP_ENCRYPTION_KEYS`. To keep files in MinIO / S3 instead of the
volume see `docker-compose.s3.example.yml` in this bundle.

## Debugging

PostgreSQL and Redis publish no host ports:

```bash
docker compose exec postgres psql -U tix tix
docker compose exec redis redis-cli
docker compose logs -f tix
```

## Verify the download (optional)

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
gh attestation verify docker-compose.yml -R __TIX_REPOSITORY__ \
  --signer-workflow __TIX_REPOSITORY__/.github/workflows/release.yml
# needs cosign v3 or newer
cosign verify ghcr.io/__TIX_IMAGE_OWNER__/tix:__TIX_VERSION__ \
  --certificate-identity-regexp '^https://github\.com/__TIX_REPOSITORY__/\.github/workflows/release\.yml@refs/tags/v.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The image is available for linux/amd64 and linux/arm64.

More: https://github.com/__TIX_REPOSITORY__/blob/v__TIX_VERSION__/docs/RELEASES.md
