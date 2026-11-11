# TIX Platform - deploy bundle **TIX_VERSION**

Runs the published container images (`ghcr.io/__TIX_IMAGE_OWNER__/tix-web|tix-worker|tix-realtime`);
nothing is built on the server. Requires Docker Engine with the Compose plugin.

## Install

1. Log in to the registry **only if the packages are private** (the published packages should be
   public; the maintainer sets this once under Package settings -> Change visibility). For private
   packages create a GitHub token with the `read:packages` scope and run:

   ```bash
   echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
   ```

2. Configure:

   ```bash
   cp .env.example .env
   # edit .env: secrets, PUBLIC_URL / SITE_ADDRESS, TIX_CHANNEL
   ```

   `TIX_CHANNEL` selects the version: `next` (newest release incl. pre-releases, for demo/test
   servers), `stable` (newest stable release, for production), `1` / `1.0` (stable line) or an exact
   version such as `__TIX_VERSION__`. Keep `.env` and a copy of `APP_ENCRYPTION_KEYS` private and
   backed up outside the server.

3. Start (database migrations run automatically through the `migrate` service):

   ```bash
   docker compose pull
   docker compose up -d
   docker compose run --rm migrate node dist/create-admin.mjs --email you@example.org --name "Your Name"
   ```

   The shop is served by the `proxy` service on `HTTP_PORT` (default 8080); with a domain in
   `SITE_ADDRESS` Caddy obtains HTTPS certificates itself (ports 80 and 443 must be reachable).

## Update

1. Take a backup first (Admin -> Backups) and read the release notes: schema changes can not be
   rolled back.
2. `docker compose pull && docker compose up -d`

The running version is shown in the admin sidebar and in `GET /api/health`.

## Roll back / pin a version

Set `TIX_CHANNEL=<exact version>` in `.env`, then `docker compose pull && docker compose up -d`.
Only roll back to a version whose database schema matches; otherwise restore the backup taken
before the update.

## Files

| File                      | Purpose                                                |
| ------------------------- | ------------------------------------------------------ |
| `docker-compose.yml`      | services (proxy, web, realtime, worker, DB, Redis, S3) |
| `.env.example`            | configuration template                                 |
| `docker/caddy/Caddyfile`  | reverse proxy                                          |
| `docker/redis/redis.conf` | Redis configuration                                    |
| `docker/minio/init.sh`    | creates the buckets and the app user                   |

Verify the images (optional; they are available for linux/amd64 and linux/arm64):

```bash
cosign verify ghcr.io/__TIX_IMAGE_OWNER__/tix-web:__TIX_VERSION__ \
  --certificate-identity-regexp '^https://github\.com/__TIX_REPOSITORY__/\.github/workflows/release\.yml@refs/tags/v.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

More: https://github.com/__TIX_REPOSITORY__/blob/v__TIX_VERSION__/docs/RELEASES.md
