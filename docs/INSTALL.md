# Install TIX on your own server

English | [Deutsch](INSTALL.de.md)

This guide has two parts. **Part 1** gets a ticket shop running in about 15 minutes: you copy and
paste a handful of commands and do **not** need to know Docker. **Part 2** is the appendix for
special setups (another reverse proxy, Cloudflare), the full variable reference, monitoring and
troubleshooting.

> TIX is currently a pre-release (see the version pinned below). Wherever this guide says "the latest
> release", use the version shown on the [releases page](https://github.com/Renthner/tix-platform/releases).

**What runs:** one `tix` container (shop, admin, realtime gateway and background worker), PostgreSQL
and Redis. The `tix` container speaks **plain HTTP** on port 8080; HTTPS is done by a reverse proxy
that you run in front of it (the quick start adds Caddy for that in two small files). Files
(uploads, invoices, tickets, local backups) live in the Docker volume `tix-data`.

> **Already running an older release** with `tix-web` / `tix-worker` / `tix-realtime`, a bundled Caddy
> and MinIO? Do **not** replace your compose file: follow
> [MIGRATE-SINGLE-IMAGE.md](MIGRATE-SINGLE-IMAGE.md). Your data stays where it is.

## Part 1: Quick start

### What you need

| What            | Details                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A Linux server  | Debian or Ubuntu, `linux/amd64` or `linux/arm64`, root or `sudo`. 2 vCPU, 4 GB RAM and 20 GB disk are enough for a club.                 |
| Docker          | Docker Engine **and** Docker Compose **2.23.1 or newer** (`docker compose version`). [Installing Docker](#installing-docker) if missing. |
| A domain name   | For example `tickets.example.org`, with an **A** record (and **AAAA** for IPv6) pointing to the server **before** you start.             |
| Open ports      | **80** and **443** reachable from the internet (also in your hosting provider's firewall).                                               |
| An SMTP account | For order e-mails and tickets (host, port, user, password). You enter it in the admin later.                                             |

Everything business-related (prices, fees, bank, SMTP, PayPal, design) is entered in the admin
area. The `.env` file only holds the few technical settings.

### 1. Download the two files

```bash
export TIX_VERSION=1.0.0-alpha.43
mkdir tix && cd tix
curl -fLO https://github.com/Renthner/tix-platform/releases/download/v$TIX_VERSION/docker-compose.yml
curl -fLO https://github.com/Renthner/tix-platform/releases/download/v$TIX_VERSION/env.example
mv env.example .env
```

Always work inside this folder (`cd tix`) when you run `docker compose`. Once a stable `1.0.0`
exists you can use `https://github.com/Renthner/tix-platform/releases/latest/download/<file>`
instead; until then that address does not exist (error 404).

### 2. Fill in the `.env` file

Replace the domain in the first line and paste the whole block (it needs `openssl`, which Debian
and Ubuntu have; [without openssl](#the-env-file-in-detail)). It sets your address, the database
password and creates the encryption key:

```bash
DOMAIN=tickets.example.org   # <- your domain
KEYLINE=$(docker run --rm ghcr.io/renthner/tix:$TIX_VERSION keygen)
sed -i \
  -e "s|^APP_URL=.*|APP_URL=https://$DOMAIN|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" \
  -e "s|^APP_ENCRYPTION_KEYS=.*|$KEYLINE|" \
  -e "s|^# *HTTP_PORT=.*|HTTP_PORT=127.0.0.1:8081|" \
  -e "s|^# *TRUSTED_PROXIES=.*|TRUSTED_PROXIES=private_ranges|" \
  .env
unset TIX_VERSION            # the version the server runs is TIX_VERSION in .env
grep -E '^(APP_URL|POSTGRES_PASSWORD|APP_ENCRYPTION_KEYS|TIX_VERSION|HTTP_PORT|TRUSTED_PROXIES)=' .env
```

No value may still contain `change-me` or `REPLACE_WITH`. `HTTP_PORT=127.0.0.1:8081` makes the shop
reachable from the server itself only: visitors come through Caddy (next step).
`TRUSTED_PROXIES=private_ranges` tells TIX that the proxy in front of it (Caddy in the Docker
network) is trusted to report the visitor's address.

> **Do not skip `TRUSTED_PROXIES`.** Left empty, TIX trusts nobody and sees the address of your
> proxy for every visitor: the rate limits (orders and seat selections per address) and the audit
> log then treat **all visitors as one**. Whenever a proxy sits in front, list it there
> ([details](#trusted_proxies-and-the-visitor-address)).

**Back up the `APP_ENCRYPTION_KEYS` line now:** copy it into your password manager, outside the
server. It encrypts stored secrets (bank PINs, API keys, ticket signing keys) and your backups;
without it neither can be restored, **not even on another server**. Never change or delete a key that
is in use.

### 3. HTTPS with Caddy

Caddy fetches and renews the free Let's Encrypt certificate by itself. Create two files next to
`docker-compose.yml` (use your domain in the first one):

```bash
cat > Caddyfile <<EOF
$DOMAIN {
	encode zstd gzip
	reverse_proxy tix:8080
}
EOF

cat > docker-compose.override.yml <<'EOF'
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    ports:
      - 80:80
      - 443:443
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      tix:
        condition: service_healthy

volumes:
  caddy-data:
  caddy-config:
EOF
```

`docker-compose.override.yml` is read automatically next to `docker-compose.yml`; updates replace only
`docker-compose.yml`, so it survives. Already running Traefik, nginx or Nginx Proxy Manager on this
server? Skip this step and use [another reverse proxy](#https-variants) instead.

### 4. Start

```bash
docker compose up -d
```

The first start downloads the images (a few hundred MB) and takes one to three minutes;
`docker compose up -d` can show no output meanwhile. Check with `docker compose ps`: all services
should be `running` or `healthy` (`tix` is `healthy` after the migrations ran). If the HTTPS
certificate cannot be issued, DNS is usually wrong: see [Troubleshooting](#troubleshooting).

Create the first administrator (your own e-mail address and name):

```bash
docker compose run --rm tix create-admin --email you@example.org --name "Your Name"
```

The command prints a **password once**. Copy it.

### 5. Open the admin

Open `https://tickets.example.org/admin`, sign in and change the password. Turn on
two-factor authentication (click your name at the bottom left of the admin menu; under
**Settings → Security** you can make it mandatory). The dashboard then shows a **setup checklist**
that leads you through the first steps: organiser data, SMTP (with a test e-mail), payment
methods, taxes and fees, venue and event, scanner URL and backups. The same list with
explanations is in [First configuration in the admin](#first-configuration-in-the-admin).

### Updating and backups

```bash
cd tix
export TIX_VERSION=1.0.0-alpha.43
curl -fLO https://github.com/Renthner/tix-platform/releases/download/v$TIX_VERSION/tix-update.sh
chmod +x tix-update.sh        # once; the script is part of every release
unset TIX_VERSION
./tix-update.sh               # updates to the newest release of your TIX_VERSION channel
```

The script downloads the `docker-compose.yml` of the target release and checks its checksum, keeps a
timestamped copy of your current file, pulls the image and restarts the stack. It never touches
`docker-compose.override.yml`; in `.env` it only moves an exact `TIX_VERSION` to the new version, and it
updates itself to the script of the new release; `./tix-update.sh --dry-run` only shows what would change.
Database migrations run automatically, and **before an update changes an existing database a
database backup is taken automatically** (Admin → Backups, "Before update"). Details, versions and
why going back is not supported:
[Updates, backups, uninstall](#updates-backups-uninstall). Backups (database and files, scheduled,
optionally to an external S3 target) are in the admin under **Backups**: [BACKUP.md](BACKUP.md).
**Without an external target the backups sit in the same volume as the files: they survive an update
but not the loss of the disk. Keep `APP_ENCRYPTION_KEYS` and an external backup target outside the
server.**

Running behind Traefik, nginx, Nginx Proxy Manager, a tunnel or Cloudflare instead of Caddy?
See [HTTPS variants](#https-variants) in Part 2.

---

## Part 2: Advanced (appendix)

1. [Installing Docker](#installing-docker)
2. [The `.env` file in detail](#the-env-file-in-detail)
3. [HTTPS variants](#https-variants): own reverse proxy (Caddy, Traefik, nginx, Nginx Proxy Manager, tunnels), `TRUSTED_PROXIES`, Cloudflare
4. [First configuration in the admin](#first-configuration-in-the-admin)
5. [Check-in phones](#check-in-phones)
6. [Updates, backups, uninstall](#updates-backups-uninstall)
7. [Monitoring](#monitoring)
8. [All variables](#all-variables)
9. [Troubleshooting](#troubleshooting)

## Installing Docker

Distribution packages (`apt install docker.io`, `docker-compose`) are often too old. Install
Docker from Docker's official repository instead. Log in to your server with SSH and run the
commands for your system.

### Debian

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

### Ubuntu

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Other systems: follow <https://docs.docker.com/engine/install/>.

### Check it

```bash
docker --version
docker compose version
```

`docker compose version` must show **2.23.1 or newer**. If it shows `command not found` or an
older number, the wrong package is installed: remove old packages (`sudo apt-get remove docker
docker.io docker-compose`) and repeat the steps above.

Optional: so you do not need `sudo` for every Docker command, add yourself to the `docker` group
and log in again: `sudo usermod -aG docker $USER`. The rest of this guide assumes you can run
`docker` without `sudo`; otherwise put `sudo` in front.

## The `.env` file in detail

The quick start fills in the `.env` file with one command. This section explains the rules and
the alternatives. The downloaded file is the authority: its comments explain each entry, and the
list of every variable is in [All variables](#all-variables). Rules:

- One `KEY=value` per line. **No quotes**, no spaces around `=`.
- The database password is placed inside a connection URL. Use **only letters and digits** (hex
  text is perfect). Characters like `@ : / # ? %` break the connection and cause confusing errors.

Only three values are required: `APP_URL`, `POSTGRES_PASSWORD`, `APP_ENCRYPTION_KEYS` (plus
`TIX_VERSION`, pre-filled). `SESSION_SECRET` is optional: without it the container generates one and keeps it in the volume `tix-data` (`/data/secrets`).

### Without `openssl`

Run each command once and paste the output into `.env` with an editor (`nano .env`):

```bash
# the database password (hex)
docker run --rm alpine sh -c "head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; echo"
# APP_ENCRYPTION_KEYS (prints the whole line, including APP_ENCRYPTION_KEYS=k3fa9c1:...)
docker run --rm ghcr.io/renthner/tix:next keygen
```

### Back up `APP_ENCRYPTION_KEYS` now

`APP_ENCRYPTION_KEYS` encrypts stored secrets (bank PINs, API keys, ticket signing keys) and your
backups. **Copy that one line into your password manager, outside the server.** If the server
dies and you do not have the key, backups and stored secrets cannot be restored, and a backup
restored on **another system** needs the key ring of the system that created it. Never change or
delete a key that is in use.

**Keep it apart from the backups.** A backup archive is encrypted with this key ring, so the key must NOT live
only where the backups live: the volume `tix-data` (local backups, generated secrets in `/data/secrets`), the
same server or the same external backup target. Store the `.env` (at least the `APP_ENCRYPTION_KEYS` line)
in a different place than the backups, for example a password manager; copy `/data/secrets` the same way if you
rely on the generated `SESSION_SECRET`. A backup without its key ring cannot be read.

### File storage

New installations keep files in a directory on the volume `tix-data` (`STORAGE_DIR=/data/storage`):
nothing to configure. To use MinIO or another S3-compatible service instead, see
[STORAGE.md](STORAGE.md) and `docker-compose.s3.example.yml` in `tix-deploy-<version>.zip` of the
release. Installations that already run MinIO keep working in S3 mode
([MIGRATE-SINGLE-IMAGE.md](MIGRATE-SINGLE-IMAGE.md)).

### `TRUSTED_PROXIES` and the visitor address

The `tix` container has a built-in proxy on port 8080 that decides which client address the shop
uses for its per-address limits and the audit log:

- **`TRUSTED_PROXIES` empty (default):** nobody is trusted. The address of the connection is the
  visitor. Correct only if visitors connect to port 8080 directly. Behind **any** reverse proxy, every
  visitor appears with the proxy's address, so all visitors share one rate limit and the audit
  log shows one IP.
- **`TRUSTED_PROXIES` set** (space-separated IPs, CIDR networks, or the keyword `private_ranges`
  for all private networks, including Docker networks): when the connection comes from one of
  them, the visitor address is read from its `X-Forwarded-For` header (right to left, so addresses
  a visitor invented are ignored). Connections from other addresses are never believed.

List only proxies you run. Check it in the admin: **Settings → Checkout → "Detected IP of your current
request"** must show **your own** public address.

Behind a TLS proxy the address is `https://...` and a proxy is **always** in front, so set
`TRUSTED_PROXIES` to the **exact IP or CIDR of that proxy** (for a proxy container: the subnet of the
Docker network they share) and publish the port only on the interface the proxy uses (for example
`HTTP_PORT=127.0.0.1:8081`). `private_ranges` works, but with a published port Docker can make
internet clients arrive from a private address, so TIX logs a startup warning for it. It also warns
when `APP_URL` is `https://` and `TRUSTED_PROXIES` is empty, or trusts every address (`0.0.0.0/0`).

### Built-in proxy: host check and limits

The same built-in proxy protects itself with these optional variables (set them in `.env`; the defaults
suit most installations):

| Variable                       | Default                          | Meaning                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TIX_ALLOWED_HOSTS`            | empty                            | Extra host names (comma or space separated) the shop answers for. When `APP_URL` is not a loopback address, a request from an **untrusted** address with a foreign `Host` gets **421**: opening `http://<server-ip>:8080` directly fails unless the name is listed here or you set `*` (any). Requests from a `TRUSTED_PROXIES` address are never checked. |
| `TIX_PROXY_SOCKET_TIMEOUT_MS`  | `120000`                         | Inactivity limit per client connection (milliseconds, `0` = none). Resets with every byte, so large uploads still work.                                                                                                                                                                                                                                    |
| `TIX_PROXY_REQUEST_TIMEOUT_MS` | `3600000`                        | Longest time to receive ONE request including its body (`0` = unlimited).                                                                                                                                                                                                                                                                                  |
| `TIX_PROXY_MAX_CONNS_PER_IP`   | `200`                            | Concurrent connections per client address that is not a trusted proxy (`0` = unlimited).                                                                                                                                                                                                                                                                   |
| `TIX_WEB_PAGE_CONCURRENCY`     | `16`                             | Page renders (HTML, server actions) the proxy runs at the same time **per web process**; more wait in a queue. Minimum `1`.                                                                                                                                                                                                                                |
| `TIX_WEB_API_CONCURRENCY`      | `96`                             | The same for API calls (`/api/...`: seat locks, cart, status). Own limit, so page renders cannot starve them.                                                                                                                                                                                                                                              |
| `TIX_WEB_STATIC_CONCURRENCY`   | `128`                            | The same for assets (`/_next/static`, images, fonts, files with an extension).                                                                                                                                                                                                                                                                             |
| `TIX_PROXY_QUEUE_TIMEOUT_MS`   | `30000` page, `10000` api/static | How long a request may wait for a free slot before it is answered with `503 BUSY` + `Retry-After: 5` (milliseconds, `0` = wait forever). Set, it applies to all three classes.                                                                                                                                                                             |

Each child process (web, worker, realtime) receives only the secrets it needs: the realtime gateway gets
neither the database URL nor the key ring, and `POSTGRES_PASSWORD` reaches none of them (they use
`DATABASE_URL`). The realtime gateway and the worker health endpoint listen on `127.0.0.1` inside the
container; only port 8080 is reachable from other containers.

### Overload behaviour

A web process renders pages CPU-bound and accepts new connections only in between. If a spike sent it
hundreds of connections at once, its accept queue (backlog 511) would overflow and the kernel would
silently drop connection attempts; the visitor then waited about two minutes for a timeout. The built-in
proxy therefore never lets more than a fixed number of requests run **per web process and request class**
(pages 16, API 96, assets 128: far below 511). Everything else waits in the proxy's own queue and is
served as slots free up; the least busy process of that class gets the next request.

- A request that waits longer than the queue timeout (30 s for pages, 10 s for API and assets) is answered
  with `503` and `Retry-After: 5`. That is the intended, graceful answer: the "busy" page reloads itself, API
  clients receive `{"error":{"code":"BUSY",...}}`. A visitor who closes the page while waiting leaves the
  queue immediately.
- Classes are separate on purpose: a backlog of page renders does not delay seat locks or the cart.
- Tuning: the page limit should roughly match the CPU time a render costs, not the number of visitors. With
  one core per process, 8-16 is usually right; raising it makes each render slower, not the shop faster. Add
  web processes (`TIX_WEB_PROCESSES`) for more throughput. Keep the three limits together below 500 (startup
  note otherwise).
- The waiting room complements this: it keeps the number of simultaneous shoppers within
  what the server can handle, while the limits only protect the server against bursts (for example at the
  start of the sale).
- Diagnosis: `/__tix/health?detail=1` (loopback only, from inside the container) lists per web process and
  class the requests queued now, served and answered `503 BUSY`, plus the kernel counters
  `ListenOverflows` / `ListenDrops` of the container. The log shows `proxy overload: N requests answered
503 BUSY ...` (at most every 10 s) and, when the counters grow, `kernel dropped connection attempts:
listen queue overflowed`.

### Scaling to more cores

The web part (shop, admin, API) is **one Node.js process** by default and can use about one CPU core.
With a thousand simultaneous shoppers that core is full while the rest of the machine idles, so a
bigger server alone does not help. `TIX_WEB_PROCESSES` starts several web processes inside the same
container; the built-in proxy spreads the requests over them (fewest requests in flight first) and skips
a process that is restarting. Nothing else changes: one container, one port, one volume.

| Variable                | Default | Meaning                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TIX_WEB_PROCESSES`     | `1`     | Number of web processes: `1`-`16` or `auto`. `auto` = the CPUs the container may use (a Docker `--cpus` / compose `cpus:` limit is honoured), at most 8, at least 1; the startup log names the number and the reason. `1` is today's behaviour.                                                                |
| `WEB_MAX_OLD_SPACE_MB`  | `768`   | Heap limit **per web process**. Memory use grows with the number of processes (each one caches its own shop data and renders pages): plan about `TIX_WEB_PROCESSES x WEB_MAX_OLD_SPACE_MB` plus worker (1024) and realtime (256). A warning is logged at startup when that exceeds the container memory limit. |
| `WEB_DATABASE_POOL_MAX` | `20`    | Database connections **per web process**. Not set: the budget of 20 is divided by the number of processes (at least 4 each), so the default stays at the same total. **Set explicitly, it applies to every web process and is multiplied by their number** (before this release it was a total).               |

How it works and what to know:

- The processes listen on `127.0.0.1` only: `TIX_WEB_PORT` (default `3000`) for the first, then the next
  free ports upwards, skipping the realtime (`3001`), worker health (`8081`) and public (`8080`) ports,
  e.g. `3000`, `3002`, `3003` for three processes. Nothing is published; only `8080` is reachable.
- PostgreSQL allows 100 connections by default. All connections of the container (web processes with
  their pool plus two single-connection readers each, worker, tools) are kept within
  `TIX_DB_CONNECTION_BUDGET` (default `90`). Above it the pool of each web process is reduced (at least 2;
  the startup log names the numbers); if even that does not fit, the container refuses to start and asks
  you to reduce `TIX_WEB_PROCESSES`. Raise the budget together with PostgreSQL `max_connections`.
- Each process restarts on its own with growing delays; `/__tix/health` (and the Docker health check) is
  healthy as long as at least one web process is ready and reports `"webProcesses":{"ready":3,"total":3}`.
  The "Starting" page appears only while no web process answers.
- All processes serve the same build; caches that must be shared (shop data, settings, queue, seat locks,
  rate limits, load test state) already live in Redis or are invalidated through it. Per-process values
  are only the technical figures of the admin page **System** and `/api/metrics` (memory, uptime, cache
  counters: they come from whichever process answered), the 45 s cache of the sales statistics (numbers
  can differ slightly between two refreshes) and the 5 s cache of the default language and the search
  engine switch (a change is visible everywhere within seconds).
- Start with `auto` on a server with two or more CPUs; leave one core for PostgreSQL, Redis, the worker and
  the realtime gateway when they share the machine. The realtime gateway (live seat updates) and the
  worker stay single processes.

### Memory limit, Redis memory and PostgreSQL

**Container memory limit (optional).** The release `docker-compose.yml` sets no limit, so a running
installation behaves exactly as before. To cap the application, remove the `#` before
`mem_limit: ${TIX_MEM_LIMIT:-2g}` in the `tix` service (and set `TIX_MEM_LIMIT` in `.env` if you want another
value). At startup `tix` reads the limit from the container and logs a memory warning when
`TIX_WEB_PROCESSES x WEB_MAX_OLD_SPACE_MB` plus the worker (1024 MB) and realtime gateway (256 MB) heap limits
exceed it. The heap limits are caps, not reservations, but a busy process can reach them. Recommended: **2g**
with one web process (default heap 768 MB), plus about **1g per additional web process**, e.g. `4g` for
`TIX_WEB_PROCESSES=3`. A limit below the sum is not an error, but the container is killed (and restarted) when it
is really exceeded; lower `WEB_MAX_OLD_SPACE_MB` or add memory instead.

**Redis memory.** Redis holds the seat locks, carts, the waiting room and the job queues. These must never be
evicted, so the policy is `noeviction` on purpose: when Redis is full it **refuses writes** (seat selection and
checkout then fail with errors) instead of silently dropping locks or jobs. `--maxmemory` is a safety ceiling
that keeps a runaway Redis from exhausting the server; it defaults to **1gb** (a normal installation uses a few
dozen MB, a large sale some hundred MB). Change it with `REDIS_MAXMEMORY=2gb` in `.env`. If it ever fills up:
check the admin page **System** (Redis memory, queue sizes) or `docker compose exec redis redis-cli info memory`,
look for a queue that grows (failed jobs piling up, a stopped worker) and fix the cause; then raise
`REDIS_MAXMEMORY` if the load is real and run `docker compose up -d`. Do not set an eviction policy.

> **Updating from an older release:** the 1gb ceiling is now applied to existing installations as well (earlier
> versions had no limit). If you expect a very large presale, raise `REDIS_MAXMEMORY` in `.env` _before_
> updating; otherwise writes fail once Redis is full.

**PostgreSQL.** The `postgres` service logs lock waits, deadlocks (`deadlock_timeout=1s`) and statements slower than
500 ms (`docker compose logs postgres`; bind parameters are not logged, so the logs contain no customer data). `max_connections` is 100 (`POSTGRES_MAX_CONNECTIONS` in `.env` changes it);
the application stays within `TIX_DB_CONNECTION_BUDGET` (default 90), so raise both together. The flags are
runtime settings: they do not change the data directory and are safe on an existing installation.

## HTTPS variants

Visitors must use HTTPS. The `tix` container does not terminate TLS: you run a reverse proxy that
forwards to `http://<server>:8080`, **including WebSockets under `/socket.io`**, and passes the original
`Host` header. Whatever you use, set `APP_URL` to the public `https://` address and
`TRUSTED_PROXIES` to the proxy.

| Variant | Use it when                                                                          |
| ------- | ------------------------------------------------------------------------------------ |
| A       | The server is dedicated to TIX, ports 80 and 443 are free. **Easiest, recommended.** |
| B       | The server already runs **Traefik** on ports 80/443.                                 |
| C       | The server already runs **nginx** on the host.                                       |
| D       | You use Nginx Proxy Manager, Cloudflare Tunnel, a router or any other proxy.         |

### A: Caddy as an extra container (recommended)

This is what the quick start does (step 3): a `Caddyfile` with
`your-domain { reverse_proxy tix:8080 }` and the `caddy` service in `docker-compose.override.yml`.
`.env`: `APP_URL=https://tickets.example.org`, `HTTP_PORT=127.0.0.1:8081`,
`TRUSTED_PROXIES=private_ranges`.

1. Point the DNS **A** record (and **AAAA** if you use IPv6) of your domain to the server **before**
   the first start. Check from the server: `getent hosts tickets.example.org` shows the server's
   IP address.
2. Make sure ports 80 and 443 are not used by another program and are open in every firewall.

Certificates are stored in the Docker volume `caddy-data`; they survive updates. If the first start
fails because DNS is wrong, fix DNS and run `docker compose up -d` again. Let's Encrypt limits
failed attempts (a few per hour per domain), so do not restart in a loop; see
[Troubleshooting](#troubleshooting).

### Advanced variants: use the file `docker-compose.override.yml`

Variants B and C change how the `tix` service is published. Do this in a separate file named
`docker-compose.override.yml` in the same folder. Docker Compose reads it automatically next to
`docker-compose.yml`. Updates replace only `docker-compose.yml`, so your changes survive.

### B: Behind Traefik

Assumptions: Traefik runs in Docker, has an entrypoint (here `websecure`), a certificate resolver
(here `letsencrypt`) and a shared Docker network (here `traefik`). Replace the names with yours.

`.env`:

```bash
APP_URL=https://tickets.example.org
TRUSTED_PROXIES=private_ranges
```

`docker-compose.override.yml`:

```yaml
services:
  tix:
    # Do not publish any host port; Traefik reaches tix over the Docker network.
    ports: !reset []
    networks:
      - default
      - traefik
    labels:
      - traefik.enable=true
      - traefik.docker.network=traefik
      - traefik.http.routers.tix.rule=Host(`tickets.example.org`)
      - traefik.http.routers.tix.entrypoints=websecure
      - traefik.http.routers.tix.tls=true
      - traefik.http.routers.tix.tls.certresolver=letsencrypt
      - traefik.http.services.tix.loadbalancer.server.port=8080

networks:
  traefik:
    external: true
```

`tix` must stay in the `default` network, otherwise it cannot reach PostgreSQL and Redis.
WebSockets work in Traefik without extra settings.

`!reset []` needs Docker Compose **2.24.4 or newer** (newer than the 2.23.1 minimum). If your
Compose is older, delete the `ports: !reset []` line and instead set in `.env`
`HTTP_PORT=127.0.0.1:8081`; the port is then only reachable from the server itself.

### C: Behind nginx on the host

Let TIX listen only on the server itself, on port 8080:

`.env`:

```bash
APP_URL=https://tickets.example.org
HTTP_PORT=127.0.0.1:8080
TRUSTED_PROXIES=private_ranges
```

`HTTP_PORT=127.0.0.1:8080` means "port 8080, reachable from this server only". This needs no
override file. nginx on the host reaches the container through Docker, which shows up as the Docker
gateway address (a private address): `private_ranges` covers it. Then create an nginx site (for example
`/etc/nginx/sites-available/tickets.example.org`, then link it into `sites-enabled`). Obtain the
certificate with your usual method (for example `certbot --nginx -d tickets.example.org`).

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name tickets.example.org;

    # ssl_certificate / ssl_certificate_key: managed by certbot or your own paths

    client_max_body_size 50m;   # uploads: images, plan backgrounds, APK (an APK is about 25 MB)

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    # Live seat updates (WebSocket)
    location /socket.io/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name tickets.example.org;
    return 301 https://$host$request_uri;
}
```

Test and reload: `sudo nginx -t && sudo systemctl reload nginx`.

### D: Nginx Proxy Manager, tunnels, other proxies

Any proxy works if it does these things:

1. `.env`: `APP_URL=https://tickets.example.org`, `HTTP_PORT=8080` (or `127.0.0.1:8080` if the proxy
   runs on the same server), `TRUSTED_PROXIES=` the address of the proxy (for example `192.168.1.10`,
   a network such as `192.168.1.0/24`, or `private_ranges`).
   The IP-based limits (Settings → Checkout: orders per IP address, seat selections per IP
   address) rely on this: without it every visitor appears with the proxy's address and shares
   one limit. The order limit per IP address is off by default; the seat selection limit
   (600 per minute) is on by default. Enable the order limit only when Settings → Checkout shows
   your real address as "Detected IP of your current request".
2. Forward `https://tickets.example.org` to `http://<server-ip>:8080`, scheme **http**.
3. **WebSockets must be enabled.** In Nginx Proxy Manager tick **Websockets Support** on the proxy
   host. Without it the seat plan does not update live.
4. The proxy must pass the original `Host` header and set `X-Forwarded-For`. (NPM does this by
   default.) Set the maximum upload size to at least 50 MB if the proxy has such a limit.
5. In NPM, request the certificate on the **SSL** tab and tick "Force SSL".

If the proxy runs in Docker on the same server, you can also use a shared Docker network like in
variant B and forward to `tix:8080`.

### Behind Cloudflare

Cloudflare (orange cloud) can sit in front of any of the variants above. The request then travels
through several hops:

```text
Visitor -> Cloudflare -> (router port forward) -> Traefik / nginx / Caddy / other proxy -> TIX
```

Every hop must trust the one before it, otherwise the app sees a proxy address instead of the
visitor (all per-IP limits then hit everybody at once, and the audit log shows one IP). Cloudflare
sends the visitor's address in `X-Forwarded-For`; it is only believed when the connection comes
from a trusted address. Two steps:

**1. The outer proxy must trust Cloudflare's address ranges.** Otherwise it replaces the
`X-Forwarded-For` header sent by Cloudflare with Cloudflare's own address.

- **Traefik**, static configuration (`traefik.yml`), on the entrypoint that receives the traffic:

  ```yaml
  entryPoints:
    websecure:
      address: ':443'
      forwardedHeaders:
        trustedIPs:
          - 173.245.48.0/20
          - 103.21.244.0/22
          - 103.22.200.0/22
          - 103.31.4.0/22
          - 141.101.64.0/18
          - 108.162.192.0/18
          - 190.93.240.0/20
          - 188.114.96.0/20
          - 197.234.240.0/22
          - 198.41.128.0/17
          - 162.158.0.0/15
          - 104.16.0.0/13
          - 104.24.0.0/14
          - 172.64.0.0/13
          - 131.0.72.0/22
          - 2400:cb00::/32
          - 2606:4700::/32
          - 2803:f800::/32
          - 2405:b500::/32
          - 2405:8100::/32
          - 2a06:98c0::/29
          - 2c0f:f248::/32
  ```

  The same as a command-line flag (ranges comma-separated):
  `--entryPoints.websecure.forwardedHeaders.trustedIPs=173.245.48.0/20,103.21.244.0/22,...`
  Restart Traefik afterwards.

- **nginx**: add one `set_real_ip_from <range>;` line per range (in the `http` or `server` block)
  plus `real_ip_header X-Forwarded-For;` and `real_ip_recursive on;`. nginx then replaces
  `$remote_addr` with the visitor's address; keep
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` towards TIX.
- **Nginx Proxy Manager**: put the same lines (`set_real_ip_from ...;`,
  `real_ip_header X-Forwarded-For;`, `real_ip_recursive on;`) into the proxy host's **Advanced**
  tab (custom Nginx configuration); NPM has no checkbox for this.

**2. TIX must trust the outer proxy and Cloudflare.** In `.env` put `private_ranges` (the outer
proxy on your LAN or Docker network) **and** the Cloudflare ranges, space-separated on **one** line:

```bash
TRUSTED_PROXIES=private_ranges 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32
```

Then `docker compose up -d`. Cloudflare's ranges change rarely; the current list is at
<https://www.cloudflare.com/ips/> (check it now and then and update both places).

**Check it:** open Settings → Checkout in the admin. "Detected IP of your current request" must
show your own public address, not a Cloudflare or private address.

**E-mail addresses on shop pages.** Cloudflare's _Email Address Obfuscation_ (Scrape Shield) rewrites
every e-mail address in the HTML into a `/cdn-cgi/l/email-protection` link and injects a script,
which the shop's Content Security Policy blocks - visitors would see "[email protected]" instead of
the address. The shop therefore wraps every e-mail address and `mailto:` link it renders (event
descriptions, info boxes, footer, start page, order and account pages) in Cloudflare's opt-out
comments `<!--email_off-->...<!--/email_off-->` automatically; nothing has to be configured.
Alternatively switch the feature off in Cloudflare (**Scrape Shield → Email Address Obfuscation**).

Tips:

- In the Cloudflare dashboard set **SSL/TLS → Overview** to **Full (strict)** (the origin must
  present a valid certificate, for example from Traefik or Caddy). "Flexible" causes
  redirect loops.
- Hardening: once everything works, let your firewall or router accept port 443 only from the
  Cloudflare ranges, so nobody can reach the server directly and fake the header.

## First configuration in the admin

The dashboard shows the same steps as a setup checklist. Work through this list in the admin area. Everything is under the menu entries on the left.

1. **Settings → Organiser:** organiser name, address, imprint and privacy links, contact. They
   appear in the shop and on invoices.
   - _Test or demo server?_ Open **Settings → SEO** and switch **Allow search engines to index the
     shop** off right away: every page then asks Google and others to ignore the site, `robots.txt`
     blocks crawling and there is no sitemap. Removal of pages that are already listed can take
     days (the removal tool in Google Search Console is faster). On the live shop you can also set
     the site title, description, preview image and verification tokens there.
2. **Settings → E-mail:** enter SMTP host, port, user and password. Press **Send test e-mail**.
   Do not continue until it arrives.
3. **Settings → Payments:** enable the methods you want.
   - _PayPal:_ start with **Sandbox** (the tab has a step-by-step guide), test one order, then
     switch to Live.
   - _Bank transfer (Vorkasse):_ enter the payment deadlines, then create your receiving bank
     account under **Bank & payments → Accounts & connections** and mark it as the **default**.
     Until a default account exists, checkout shows bank transfer as "Currently not available".
     PayPal is likewise shown as unavailable until its credentials are saved and it is enabled.
4. **Fees & taxes:** tax rates (for example 7 %, 19 % or tax exempt) and service fees.
5. **Settings → Checkout and Invoices:** limits per order, reservation time, invoice data.
6. **Venues & plans:** create your venue and draw the seating plan (or import a plan file).
7. **Events:** create an event, choose the plan, set up categories, prices and tariffs, and the
   presale start. Keep it in draft until everything is checked.
8. **Ticket designs** and **E-mail templates:** upload your background, adapt the texts, send a
   test.
9. **Settings → Scanner:** set the **server URL** to your public address
   (`https://tickets.example.org`). If you leave it empty or wrong, the pairing QR code for
   phones points to the wrong address ("localhost").
10. **Backups:** schedule regular backups and add an **external S3 target** (another provider or
    another server). A backup on the same server does not help when the server is lost. See
    [BACKUP.md](BACKUP.md).
11. **Place a test order** end to end (PayPal sandbox or bank transfer), open the ticket PDF and
    scan it with the app before you sell for real.

## Check-in phones

1. On the release page download `tix-checkin-<version>.apk`
   (<https://github.com/Renthner/tix-platform/releases>).
2. Open it on the Android 8+ phone and allow **installing from this source** when Android asks.
3. In the admin open **Check-in devices**, create a pairing code for the events and scan the QR
   code in the app.
4. In the app choose the event and download the ticket data **before** doors open, so scanning
   works even without network.

Pitfalls:

- Phones must be able to reach `APP_URL`. On a home or club router the server's public
  address is sometimes not reachable from inside the same WiFi ("hairpin NAT"). Test by opening
  `APP_URL` in the phone's browser while on the venue WiFi.
- Plain `http://` is accepted only for private addresses such as `http://192.168.1.20:8080`.
  Every public address must use `https://`.
- Settings → Scanner → server URL must be the address the **phones** can reach.
- The app always updates to exactly the version your server runs (from GitHub Releases). You can
  switch to updates from your own server in the admin.

More details: [SCANNER.md](SCANNER.md) and [apps/android/README.md](../apps/android/README.md).

## Updates, backups, uninstall

### Updates

1. Read the [CHANGELOG](../CHANGELOG.md) of the new version.
2. Run the update script from the folder of your `docker-compose.yml`:

```bash
cd tix
./tix-update.sh                 # newest release of the channel in .env (TIX_VERSION)
./tix-update.sh 1.0.0-alpha.43  # or one exact version
./tix-update.sh stable          # or a channel: stable, next, alpha, beta, rc, 1, 1.0
./tix-update.sh --dry-run       # download and verify only, change nothing
```

The script is attached to every release (`tix-update.sh`, listed in `SHA256SUMS.txt`); save it
next to `docker-compose.yml` once. It needs `curl` or `wget` and Docker Compose 2.23.1+, checks
the SHA-256 of the downloaded compose file, keeps the previous one as
`docker-compose.yml.bak-<time>`, then runs `docker compose pull` and
`docker compose up -d --remove-orphans`. The file is validated (`docker compose config`) and the
image is pulled before the old compose file is replaced, so a failed download or pull changes
nothing. `docker-compose.override.yml` is never touched. Without an argument an **exact version** in
`TIX_VERSION` (e.g. `1.0.0-alpha.40`) follows its line: a pre-release moves to the newest release of
the same major version (alpha, beta, rc or final), a final version to the newest final release of the
same major version; the script then writes the new version to `.env` (only that line changes), so a
later plain `docker compose up` keeps it. A channel (`next`, `stable`, ...) in `.env` is never
changed. After a successful update the script replaces itself with the `tix-update.sh` of the new
release (checksum from `SHA256SUMS.txt`). Going to a **lower** version
than the running one is refused without `--force` (see "Going back" below). An explicit version or channel argument is used for that run even when `TIX_VERSION`
in `.env` says something else; the script reminds you to change `.env` too. A compose file of the old
three-image layout is never replaced: the script stops and points to
[MIGRATE-SINGLE-IMAGE.md](MIGRATE-SINGLE-IMAGE.md).

**By hand** (alternative): download the `docker-compose.yml` of the release (keep your `.env`
and `docker-compose.override.yml`), then `docker compose pull && docker compose up -d`.

3. Check **Admin → System**: the running version is shown there, in the admin sidebar and, with the
   metrics bearer token, at `/api/health`. The admin dashboard tells super admins when a newer release exists for your
   channel (switch off under Settings → General → Updates) and warns when your
   `docker-compose.yml` is older than the running app.

**Automatic backup before database changes.** When an update contains database migrations and the
installation already has data, the `tix` container first writes an encrypted, database-only
backup (same format and key as the admin backups) and applies the migrations only after that
succeeded. It appears under **Admin → Backups** as "Before update" and is restored like any other
backup; a restore of it replaces the database only and leaves images and PDFs untouched. The newest
`PRE_UPDATE_BACKUP_KEEP` (default 3) are kept; they do not count against the scheduled-backup
retention. With the file storage the backup lives in the volume `tix-data` (same disk as the
files); with S3 it is written to the backups bucket. If the backup fails, **no migration is
applied** and the container stops with the reason in `docker compose logs tix`. To update without
a backup (not recommended) set `SKIP_PRE_UPDATE_BACKUP=1` in `.env`. Migrations wait at most
`MIGRATION_LOCK_TIMEOUT` seconds (default 10) for a table lock and retry, so a stuck transaction
can never freeze the shop.

**Going back.** A pre-update backup contains your **data** as it was before the update. Restoring it
(Admin → Backups) replaces the database with that state and re-runs the migrations of the version
you are running, so you stay on the **new** version with the old data. Going back to an **older
application version is not supported** once a newer database schema was applied: older versions
cannot read the newer schema or the "Before update" backup type. If an update misbehaves, report it
and stay on the new version (restore the backup if data was damaged), or install the old version
fresh and restore a normal backup that this old version created.

**Update check.** The admin dashboard asks the GitHub Releases API (`api.github.com`) for newer
releases at most every 6 hours; this is an outbound request that sends nothing about your
installation. Switch it off under Settings → General → Updates.

**Choose the version with `TIX_VERSION` in `.env`:**

| Value            | Follows                                                | Use for                                                                     |
| ---------------- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| `next`           | the newest release of any kind, including pre-releases | tests and demos; today the only choice because no stable release exists yet |
| `stable`         | the newest stable release                              | production (from 1.0.0 on)                                                  |
| `1` or `1.0`     | the newest stable release of that line                 | production without surprises                                                |
| `1.0.0-alpha.43` | exactly this version                                   | pinning, rolling back                                                       |

Pinning an earlier version works only while the database schema is unchanged. Once a newer release
migrated the database, going back is **not supported** (see "Going back" above): the pre-update
backup restores your data on the new version, it does not make the old version run again.

Do not use automatic updaters (Watchtower and similar): updates should be deliberate.

### Backups and restore

Use **Admin → Backups**: database and files, scheduled, with an optional external S3 target.
Restore is in the same place (SUPER_ADMIN only). Details: [BACKUP.md](BACKUP.md). Keep these
outside the server:

- `APP_ENCRYPTION_KEYS` (and the whole `.env`): it is also needed to restore a backup **on another
  system**,
- the external backup target. Without one, the local backups live in the same Docker volume
  (`tix_tix-data`) as the files: they protect against mistakes and bad updates, not against losing the
  disk.

The data lives in Docker volumes of the project `tix`: `tix_postgres-data`, `tix_redis-data` and
`tix_tix-data` (files, local backups, the generated `SESSION_SECRET`), plus `tix_caddy-data`
(certificates) if you use Caddy as in the quick start. List them with `docker volume ls`.

### Demo orders (demo and test installations only)

To try the admin with realistic data, `demo-orders` creates regular orders through the normal shop
and box-office code. You get unpaid and paid bank-transfer orders, multi-event orders, box-office
sales (cash, card, complimentary) and some reduced tariffs. It only uses published events that are
on sale and takes at most 40 % of their free seats:

```bash
docker compose run --rm tix demo-orders --yes-create-demo-data --count 40 \
  --real you@example.org,colleague@example.org,third@example.org   # optional, up to 3
```

- **Never run it on a production system.** Paid orders get invoices (GoBD) that cannot be
  deleted. Take a backup first (Admin → Backups): restoring it is the only way to remove the
  demo data again.
- Fake buyers use `@example.org` addresses (mails to them are not delivered). Real addresses
  (`--real`) get real mails from the running worker: A gets an unpaid, a paid and a
  multi-event order and passes one ticket on to B (only if ticket self-service allows
  transfers). B gets a paid order. C gets a paid and an unpaid order.
- Vorkasse needs a bank account. Box-office sales are recorded as the oldest active super admin.
  `--events slug1,slug2` limits the events, and `--seed <n>` repeats a run. The plan is printed
  before anything is created; in an interactive terminal you confirm it with `y` (without a
  terminal, e.g. `docker compose run -T`, the flag `--yes-create-demo-data` is the confirmation).
- The command takes its settings only from the installation's environment (database, Redis, keys);
  it never reads a `.env` file of its own.

### Uninstall

```bash
cd tix
docker compose down        # stops and removes containers, KEEPS your data
docker compose down -v     # also DELETES all data (database, files, certificates) - irreversible
```

## Monitoring

The admin page **System** (super admins) shows the live status: application version and uptime,
PostgreSQL connections and size, Redis memory and throughput, the job queues with their failed
jobs, the waiting room, seat locks held in carts, connected realtime clients, workers and open
backlogs (e-mails, refunds, bank transactions). It refreshes itself every few seconds and keeps a
ten minute trend.

For Prometheus (or Grafana Agent, VictoriaMetrics, Zabbix, ...) the same numbers are available as
text at `/api/metrics`. The endpoint does not exist until you create a token in **Settings,
Security, Monitoring** (the token is shown once; creating a new one replaces the old one, removing
it switches the endpoint off again). Wrong tokens are rate limited per client address.

```bash
curl -H "Authorization: Bearer <token>" https://tickets.example.org/api/metrics
```

A minimal Prometheus scrape configuration:

```yaml
scrape_configs:
  - job_name: tix
    scrape_interval: 30s
    scheme: https
    metrics_path: /api/metrics
    authorization:
      type: Bearer
      credentials: <token> # or credentials_file: /etc/prometheus/tix.token
    static_configs:
      - targets: ['tickets.example.org']
```

Useful alerts: `tix_queue_jobs{state="failed"} > 0`, `tix_workers == 0`,
`tix_worker_leader_present == 0`, `tix_postgres_connections / tix_postgres_max_connections > 0.85`,
`tix_redis_used_memory_bytes / tix_redis_max_memory_bytes > 0.9` (when `maxmemory` is set) and
`tix_collect_error > 0`. The realtime gateway reports itself to Redis every 10 seconds
(`tix_realtime_instances`); images from before this version do not and show as "not reporting".

## All variables

Only the first block is required. Everything else has a default; the rows marked "optional" are
commented out in the downloaded `.env` (remove the `#` to use them). The whole `.env` is passed to
the `tix` container, so every variable of the image (also those not listed in the compose file) works.

| Variable                                                                                                         | Required   | Meaning                                                                                                                                                                                                                                                                                                                    | Example                                        |
| ---------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `APP_URL`                                                                                                        | **yes**    | The address visitors type, with `https://` and without a trailing slash.                                                                                                                                                                                                                                                   | `https://tickets.example.org`                  |
| `POSTGRES_PASSWORD`                                                                                              | **yes**    | Database password (letters and digits only).                                                                                                                                                                                                                                                                               | `3f9a…` (48 hex characters)                    |
| `APP_ENCRYPTION_KEYS`                                                                                            | **yes**    | Key ring: `id:base64key` (keygen picks a random id such as `k3fa9c1`), 32 random bytes in base64. Several keys are comma-separated; the first encrypts. Create with `docker run --rm ghcr.io/renthner/tix:next keygen`. **Back it up.**                                                                                    | `k1:Zm9v…YmFy=`                                |
| `TIX_VERSION`                                                                                                    | pre-filled | Which image runs: `next`, `stable`, `1`, `1.0` or an exact version. See [Updates](#updates-backups-uninstall).                                                                                                                                                                                                             | `next`                                         |
| `TRUSTED_PROXIES`                                                                                                | optional   | **Set it behind any reverse proxy:** its address(es) or `private_ranges`. Empty = nobody trusted (all visitors look like the proxy).                                                                                                                                                                                       | `private_ranges`                               |
| `TIX_ALLOWED_HOSTS`, `TIX_PROXY_SOCKET_TIMEOUT_MS`, `TIX_PROXY_REQUEST_TIMEOUT_MS`, `TIX_PROXY_MAX_CONNS_PER_IP` | optional   | Built-in proxy: extra accepted host names (foreign `Host` gets 421 unless `APP_URL` is loopback or `*`), client inactivity timeout (default `120000` ms), time to receive one request (default `3600000` ms), connections per client address (default `200`). See [Built-in proxy](#built-in-proxy-host-check-and-limits). | `shop.example.org`, `120000`, `3600000`, `200` |
| `TIX_ALLOW_FOREIGN_BACKUP_KEYS`                                                                                  | optional   | `1` allows restoring a backup of another installation by entering its key (default off). **A SUPER_ADMIN can then run arbitrary SQL as the database user**; enable it only for the migration. See [BACKUP.md](BACKUP.md#restoring-a-backup-from-another-system).                                                           |
| `HTTP_PORT`                                                                                                      | optional   | Host port of the plain-HTTP port (default `8080`). `127.0.0.1:8081` = reachable from the server only.                                                                                                                                                                                                                      | `127.0.0.1:8081`                               |
| `SESSION_SECRET`                                                                                                 | optional   | At least 32 characters for signed cookies. Without it one is generated and kept in `/data/secrets`. Set it to keep sessions when you move the volume.                                                                                                                                                                      | `e4b8…`                                        |
| `COMPOSE_PROJECT_NAME`                                                                                           | optional   | Name prefix of the containers and volumes. Do not change after the first start (you would get empty new volumes).                                                                                                                                                                                                          | `tix`                                          |
| `LOG_LEVEL`                                                                                                      | optional   | Log detail: `info`, `debug`, `warn`, `error`.                                                                                                                                                                                                                                                                              | `info`                                         |
| `SKIP_PRE_UPDATE_BACKUP`, `PRE_UPDATE_BACKUP_KEEP`                                                               | optional   | Automatic database backup before pending migrations: `1` skips it (not recommended); how many to keep (default `3`).                                                                                                                                                                                                       | `3`                                            |
| `MIGRATION_LOCK_TIMEOUT`, `MIGRATION_STATEMENT_TIMEOUT`, `MIGRATION_LOCK_RETRIES`                                | optional   | Seconds a schema change waits for a table lock (default `10`, `0` = no limit), seconds one statement may run (default `600`), attempts after a lock timeout (default `5`).                                                                                                                                                 | `10`, `600`, `5`                               |
| `TIX_WEB_PROCESSES`, `WEB_MAX_OLD_SPACE_MB`, `WEB_DATABASE_POOL_MAX`                                             | optional   | Number of web processes (`1`-`16` or `auto`, default `1`), heap limit and database connections per web process. See [Scaling to more cores](#scaling-to-more-cores).                                                                                                                                                       | `auto`, `768`, `20`                            |
| `WORKER_DATABASE_POOL_MAX`                                                                                       | optional   | Database connections of the worker (default `8`). The web part together with the worker should stay well below PostgreSQL's default of 100.                                                                                                                                                                                | `8`                                            |
| `TIX_ROLE`                                                                                                       | optional   | Which parts run in the container: `all` (default) or a list of `web`, `worker`, `realtime` for scaling out.                                                                                                                                                                                                                | `all`                                          |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_NAME`                                                                       | optional   | Only for an external PostgreSQL (defaults `postgres`, `5432`, `tix`, `tix`); or set `DATABASE_URL` directly.                                                                                                                                                                                                               | `db.example.org`                               |
| `REDIS_URL`                                                                                                      | optional   | Only for an external Redis (default `redis://redis:6379/0`).                                                                                                                                                                                                                                                               | `redis://:pw@host:6379/0`                      |
| `STORAGE_DRIVER`, `STORAGE_DIR`                                                                                  | optional   | `fs` (default; directory `/data/storage`) or `s3`. See [STORAGE.md](STORAGE.md).                                                                                                                                                                                                                                           | `fs`                                           |
| `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_*`, `S3_REGION`                            | optional   | S3 mode: setting `S3_ENDPOINT` switches the driver to `s3`; three different buckets are required.                                                                                                                                                                                                                          | `https://s3.example.org`                       |

## Troubleshooting

Useful commands (run them inside the `tix` folder):

```bash
docker compose ps                     # state of all services
docker compose logs --tail 100 tix    # last log lines of the application
docker compose logs -f caddy          # follow the Caddy log live (stop with Ctrl+C)
curl -fsS http://localhost:8080/api/health   # only if HTTP_PORT is 8080 on this server
```

The `tix` container writes one JSON object per log line for web, worker and realtime (field
`service`). Errors have `"level":50`, warnings `"level":40`:
`docker compose logs tix | grep '"level":50'`. Set `LOG_LEVEL` in `.env` (`error`, `warn`, `info`,
`debug`; default `info`) to change the verbosity. Web log lines of a request carry a `reqId` that
matches the `X-Request-Id` set by the built-in proxy.

Service names: `tix`, `postgres`, `redis` (plus `caddy` / `minio` if you added them).

| Symptom                                                                                              | Cause                                                                                                                                                                                                                                                                                                         | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docker compose` says `set TIX_VERSION in .env - upgrading from the three-image layout`              | The `.env` / compose file come from an older release (`tix-web` / `tix-worker` / `tix-realtime`)                                                                                                                                                                                                              | Do not continue with the new compose file: [MIGRATE-SINGLE-IMAGE.md](MIGRATE-SINGLE-IMAGE.md)                                                                                                                                                                                                                                                                                                                                                          |
| `required variable ... is missing a value` / `set POSTGRES_PASSWORD in .env`                         | The variable is empty or missing, or `.env` is not in the current folder                                                                                                                                                                                                                                      | Run the command inside the `tix` folder, make sure the file is called `.env` (not `env.example`), and fill the named variable.                                                                                                                                                                                                                                                                                                                         |
| `tix` stops at once with `APP_ENCRYPTION_KEYS is not set` / `is invalid`                             | The key ring is missing or malformed                                                                                                                                                                                                                                                                          | `docker run --rm ghcr.io/renthner/tix:next keygen` prints a valid line for `.env`.                                                                                                                                                                                                                                                                                                                                                                     |
| Redis restarts in a loop after a crash or power loss: `Bad file format reading the append only file` | The end of Redis' append-only file was half written when the machine went down; more than 4 KB are damaged (smaller damage is repaired automatically on start)                                                                                                                                                | `docker compose stop redis`, back up the volume (`docker run --rm -v <project>_redis-data:/data alpine tar czf - -C /data . > redis-backup.tgz`), then `docker run --rm -it -v <project>_redis-data:/data redis:8.10-alpine sh -c 'cd /data/appendonlydir && redis-check-aof --fix appendonly.aof.manifest'`, confirm with `y`, `docker compose up -d`. Redis only holds short-lived data (carts, seat locks, queue, jobs); orders live in PostgreSQL. |
| `tix` exits with "The pre-update backup failed, so no migration was applied"                         | The database backup before the update could not be written (storage not writable, key ring problem). Nothing was changed.                                                                                                                                                                                     | Read the reason with `docker compose logs tix`, fix it and run the update again. Only as a last resort set `SKIP_PRE_UPDATE_BACKUP=1`                                                                                                                                                                                                                                                                                                                  |
| Log: "another session holds a lock on a table the migration needs"                                   | A long-running transaction blocks the schema change; the migration retries and finally gives up without changing anything                                                                                                                                                                                     | Run the update again (`docker compose up -d`) when the shop is quiet                                                                                                                                                                                                                                                                                                                                                                                   |
| The container restarts by itself, `docker inspect` shows `OOMKilled`                                 | The host ran out of memory                                                                                                                                                                                                                                                                                    | Free memory or add RAM; the application needs about 2 GB.                                                                                                                                                                                                                                                                                                                                                                                              |
| Error mentioning `configs.content`, "unknown key" or "additional property"                           | Docker Compose is older than 2.23.1                                                                                                                                                                                                                                                                           | Install Docker from the official repository ([Installing Docker](#installing-docker)). `docker compose version` must show 2.23.1 or newer.                                                                                                                                                                                                                                                                                                             |
| `manifest unknown` / `not found` when pulling `...:stable`                                           | No stable release exists yet, so the image tag `stable` does not exist                                                                                                                                                                                                                                        | Set `TIX_VERSION=next` (or an exact version such as `1.0.0-alpha.43`) in `.env`, then `docker compose pull && docker compose up -d`.                                                                                                                                                                                                                                                                                                                   |
| Errors such as `password authentication failed`                                                      | The password contains special characters (`@ : / # ? %`), quotes, or was changed after first start                                                                                                                                                                                                            | Use letters and digits only, no quotes. The database password is fixed when the data volume is created: changing `POSTGRES_PASSWORD` later needs `docker compose down -v` on a fresh install (deletes data) or a manual password change in PostgreSQL.                                                                                                                                                                                                 |
| Browser shows a certificate warning or no HTTPS (Caddy as in the quick start)                        | Caddy could not get a certificate: DNS wrong, ports 80/443 blocked, or Let's Encrypt limit                                                                                                                                                                                                                    | `docker compose logs caddy`. Check that the domain points to this server, ports 80 and 443 are open (provider firewall too) and the Caddyfile holds only the domain (no `https://`). Wait one hour if the log mentions a rate limit.                                                                                                                                                                                                                   |
| `port is already allocated` / `address already in use` on port 80 or 443                             | Another web server (apache2, nginx) uses the port                                                                                                                                                                                                                                                             | Stop it (`sudo systemctl disable --now apache2`) or use variant B/C/D. `sudo ss -ltnp \| grep -E ':80 \|:443 '` shows who uses the port.                                                                                                                                                                                                                                                                                                               |
| Firewall (ufw) is on, but a port is still reachable                                                  | Docker publishes ports directly and bypasses ufw rules                                                                                                                                                                                                                                                        | Only the proxy publishes ports (80/443 or your `HTTP_PORT`). To keep a port private, bind it to `127.0.0.1` (`HTTP_PORT=127.0.0.1:8080`). Do not rely on ufw alone for Docker ports.                                                                                                                                                                                                                                                                   |
| Seats do not update live; the browser console shows WebSocket errors                                 | Your reverse proxy does not forward WebSockets for `/socket.io`                                                                                                                                                                                                                                               | Variant C: use the `/socket.io/` block above. NPM: enable Websockets Support. Cloudflare: WebSockets must be on.                                                                                                                                                                                                                                                                                                                                       |
| Everyone gets "too many requests", or the audit log shows one IP for all visitors                    | A proxy sits in front but `TRUSTED_PROXIES` is empty or does not contain its address                                                                                                                                                                                                                          | Set `TRUSTED_PROXIES` to the proxy's address or `private_ranges`, then `docker compose up -d`. Check Settings → Checkout → "Detected IP".                                                                                                                                                                                                                                                                                                              |
| Phone cannot pair, says "server address not allowed"                                                 | `http://` with a public address, or a wrong server URL                                                                                                                                                                                                                                                        | Use `https://`. `http://` works only for private IPs. Check Settings → Scanner → server URL.                                                                                                                                                                                                                                                                                                                                                           |
| Phone cannot pair, no connection or timeout                                                          | Phone cannot reach `APP_URL` (hairpin NAT, VPN, wrong URL)                                                                                                                                                                                                                                                    | Open `APP_URL` in the phone's browser on the same WiFi. If it fails, use mobile data or fix the router (NAT loopback / local DNS).                                                                                                                                                                                                                                                                                                                     |
| The pairing QR code contains `localhost`                                                             | Scanner server URL is not set                                                                                                                                                                                                                                                                                 | Settings → Scanner → set the server URL to `APP_URL`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| No e-mails arrive                                                                                    | Wrong SMTP data, blocked port, spam folder                                                                                                                                                                                                                                                                    | Settings → E-mail → **Send test e-mail** shows the error. Try port 587 (STARTTLS) or 465 (TLS); `docker compose logs tix`.                                                                                                                                                                                                                                                                                                                             |
| Backups or stored secrets cannot be read after moving to a new server                                | `APP_ENCRYPTION_KEYS` differs from the old server                                                                                                                                                                                                                                                             | Use the original key line from your password manager. Without it the encrypted data cannot be recovered; this is why you back it up.                                                                                                                                                                                                                                                                                                                   |
| A service is `unhealthy`                                                                             | Start still in progress, or a configuration error                                                                                                                                                                                                                                                             | Wait two minutes (migrations run first). Then `docker compose logs --tail 100 <service>`. The check of `tix` is `GET /api/health` through the container's own health command.                                                                                                                                                                                                                                                                          |
| Checkout shows bank transfer or PayPal as "Currently not available"                                  | No default receiving bank account exists (bank transfer), or PayPal is not configured/enabled                                                                                                                                                                                                                 | Bank & payments → Accounts & connections: create an account and mark it as default. PayPal: Settings → Payments.                                                                                                                                                                                                                                                                                                                                       |
| Admin login says "Too many attempts"                                                                 | More than 10 sign-in attempts (per Settings -> Security, at least 10) for one e-mail address from the same client, or 20 from one client (IPv6: one /64 network), within 15 minutes; also from scripts/tests. A single address tried more than 100 times in 15 minutes from anywhere is blocked for everybody | Wait up to 15 minutes; the limit expires by itself. If you forgot the password: `docker compose run --rm tix create-admin --email you@example.org --reset` prints a new password (roles are kept).                                                                                                                                                                                                                                                     |
| `docker compose up` / `pull` shows no progress for minutes                                           | The image is still downloading                                                                                                                                                                                                                                                                                | Wait, or run `docker compose pull` separately to see the progress.                                                                                                                                                                                                                                                                                                                                                                                     |
| Page says "maintenance" for a long time                                                              | A backup restore is running                                                                                                                                                                                                                                                                                   | Wait; check `docker compose logs tix`.                                                                                                                                                                                                                                                                                                                                                                                                                 |

If you are stuck, open an [issue](https://github.com/Renthner/tix-platform/issues/new/choose)
with the output of `docker compose ps` and the relevant log lines. **Remove passwords and keys
before you post logs.**
