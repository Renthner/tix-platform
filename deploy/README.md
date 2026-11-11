# TIX Platform **TIX_VERSION** - deployment

Runs the published container images (`ghcr.io/__TIX_IMAGE_OWNER__/tix-web|tix-worker|tix-realtime`);
nothing is built on the server. You need exactly **two files**: `docker-compose.yml` and `.env`.
All configuration files (reverse proxy, Redis settings, bucket setup) are embedded in the compose
file.

Requirements: Docker Engine with **Docker Compose >= 2.23.1** (`docker compose version`).

## Quick start

```bash
mkdir tix && cd tix
curl -LO https://github.com/__TIX_REPOSITORY__/releases/download/v__TIX_VERSION__/docker-compose.yml
curl -Lo .env https://github.com/__TIX_REPOSITORY__/releases/download/v__TIX_VERSION__/env.example
# edit .env: replace every "change-me" / "REPLACE_WITH" value, set PUBLIC_URL, SITE_ADDRESS, TIX_CHANNEL

docker compose pull
docker compose up -d
docker compose run --rm migrate node dist/create-admin.mjs --email you@example.org --name "Your Name"
```

Database migrations run automatically (`migrate` service). Then open `PUBLIC_URL`, sign in with
the admin account and configure everything else (SMTP, payments, branding ...) in the admin
portal. Keep `.env` and a copy of `APP_ENCRYPTION_KEYS` private and backed up outside the server.

If the packages are private (the published ones should be public), log in first with a GitHub
token that has the `read:packages` scope:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
```

## HTTPS / reverse proxy

Only the `proxy` service (Caddy) publishes ports. Choose one:

1. **Caddy terminates TLS (automatic Let's Encrypt).** Point the DNS name at the server and set
   `SITE_ADDRESS=tickets.example.org`, `PUBLIC_URL=https://tickets.example.org`, `HTTP_PORT=80`,
   `HTTPS_PORT=443`. Ports 80 and 443 must be reachable from the internet.
2. **You already run a reverse proxy / load balancer / tunnel.** Keep `SITE_ADDRESS=:80`, choose a
   free `HTTP_PORT` (e.g. `8080`) and forward your HTTPS site to `http://<server>:<HTTP_PORT>`,
   including WebSockets (`/socket.io`). Set `PUBLIC_URL` to the public https address and
   `TRUSTED_PROXIES` to the address(es) of your proxy (space-separated IPs / CIDRs, or
   `private_ranges` for all private networks). Caddy then reads the visitor address from the
   `X-Forwarded-For` header your proxy sends; without it every visitor would share the proxy's
   address (rate limits, audit log). Your proxy must pass the original `Host` header.

Plain `http://localhost:8080` (the defaults) is for a first test only.

## Update

1. Take a backup first (Admin -> Backups) and read the release notes: schema changes can not be
   rolled back.
2. `docker compose pull && docker compose up -d`

To get a newer compose file (rarely needed; services only change in release notes), download the
`docker-compose.yml` of that release again and keep your `.env`. The running version is shown in
the admin sidebar and in `GET /api/health`.

## Versions

`TIX_CHANNEL` in `.env` selects the images: `stable` (newest stable release, production), `next`
(newest release incl. pre-releases, test servers), `1` / `1.0` (stable line) or an exact version
such as `__TIX_VERSION__` (pin). To roll back set the exact earlier version, then
`docker compose pull && docker compose up -d`. Only roll back to a version whose database schema
matches; otherwise restore the backup taken before the update.

## Backups

Use Admin -> Backups (database + files, optional upload to an external S3 target). The data lives
in the Docker volumes `postgres-data`, `redis-data`, `minio-data` and `caddy-data` of the compose
project (name from `COMPOSE_PROJECT_NAME`, default `tix`). Restoring on another server needs the
same `APP_ENCRYPTION_KEYS`.

## Debugging: reaching the database

PostgreSQL, Redis and MinIO publish no host ports. To reach one temporarily without editing the
compose file, use a throw-away container in the project network, e.g.

```bash
docker compose exec postgres psql -U tix tix
docker compose exec redis sh -c 'redis-cli'
```

or add a `ports: ['127.0.0.1:5432:5432']` entry to the service in `docker-compose.yml` (local
change, lost when you download a new compose file).

## Verify the download (optional)

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
gh attestation verify docker-compose.yml -R __TIX_REPOSITORY__ \
  --signer-workflow __TIX_REPOSITORY__/.github/workflows/release.yml
cosign verify ghcr.io/__TIX_IMAGE_OWNER__/tix-web:__TIX_VERSION__ \
  --certificate-identity-regexp '^https://github\.com/__TIX_REPOSITORY__/\.github/workflows/release\.yml@refs/tags/v.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The images are available for linux/amd64 and linux/arm64.

More: https://github.com/__TIX_REPOSITORY__/blob/v__TIX_VERSION__/docs/RELEASES.md
