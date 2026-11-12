# Install TIX on your own server

English | [Deutsch](INSTALL.de.md)

This guide takes you from an empty Linux server to a running ticket shop. You need to be able to
log in with SSH and copy and paste commands. You do **not** need to know Docker.

Time needed: about 30 minutes, plus waiting for DNS if you have just ordered a domain.

> TIX is currently a pre-release (see the version pinned below). Wherever this guide says "the latest
> release", use the version shown on the [releases page](https://github.com/Renthner/tix-platform/releases).

## Contents

1. [What you need](#what-you-need)
2. [Step 1: Install Docker](#step-1-install-docker)
3. [Step 2: Download the two files](#step-2-download-the-two-files)
4. [Step 3: Fill in the `.env` file](#step-3-fill-in-the-env-file)
5. [Step 4: Choose how HTTPS works](#step-4-choose-how-https-works)
6. [Step 5: Start and create the first admin](#step-5-start-and-create-the-first-admin)
7. [Step 6: First configuration in the admin](#step-6-first-configuration-in-the-admin)
8. [Check-in phones](#check-in-phones)
9. [Updates, backups, uninstall](#updates-backups-uninstall)
10. [Troubleshooting](#troubleshooting)

## What you need

| What                  | Details                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Linux server        | Debian or Ubuntu (other distributions work, the Docker commands differ). `linux/amd64` or `linux/arm64`. Root or `sudo` access.                           |
| Size (recommendation) | 2 vCPU, 4 GB RAM, 20 GB disk is enough for a club shop. Plan more disk if you store many images, PDFs and backups, and more RAM and CPU for big presales. |
| A domain name         | For example `tickets.example.org`, with an **A** record (and **AAAA** for IPv6) pointing to the server's public IP address.                               |
| Open ports            | **80** and **443** reachable from the internet (firewall of your hosting provider included).                                                              |
| An SMTP account       | To send e-mails (order confirmations, tickets). Host, port, user name and password from your mail provider.                                               |
| Docker                | Docker Engine **and** Docker Compose **2.23.1 or newer**. Step 1 installs it.                                                                             |

Everything business-related (prices, fees, bank, SMTP, PayPal, design) is entered later in the
admin area. The `.env` file only holds the technical settings.

## Step 1: Install Docker

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

## Step 2: Download the two files

TIX needs exactly two files from the release page: `docker-compose.yml` and `env.example`.

```bash
export TIX_VERSION=1.0.0-alpha.11
mkdir tix && cd tix
curl -fLO https://github.com/Renthner/tix-platform/releases/download/v$TIX_VERSION/docker-compose.yml
curl -fLO https://github.com/Renthner/tix-platform/releases/download/v$TIX_VERSION/env.example
mv env.example .env
ls -la
```

You should see `docker-compose.yml` and `.env` in the folder `tix`. Always work inside this
folder (`cd tix`) when you run `docker compose`.

`curl -f` stops with an error instead of saving an error page, so a wrong version number is
noticed immediately. Once a stable `1.0.0` exists, you can use
`https://github.com/Renthner/tix-platform/releases/latest/download/<file>` instead. Until then
that address does not exist (error 404).

**Optional: check the download.** The release page also has `SHA256SUMS.txt`:

```bash
curl -fLO https://github.com/Renthner/tix-platform/releases/download/v$TIX_VERSION/SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt --ignore-missing
```

Do this _before_ `mv env.example .env`, or the file name will not match. Stronger checks
(signatures, attestations) are in [RELEASES.md](RELEASES.md#verifying-releases).

## Step 3: Fill in the `.env` file

The `.env` file holds the passwords and the web address. Rules:

- One `KEY=value` per line. **No quotes**, no spaces around `=`.
- Passwords are placed inside connection URLs. Use **only letters and digits** (hex text is
  perfect). Characters like `@ : / # ? %` break the connection and cause confusing errors.
- Use a **different** password for every entry.

### Quick way: generate all secrets with one command

Copy and paste this whole block (it works when `openssl` is installed, which is the case on
Debian and Ubuntu):

```bash
gen() { openssl rand -hex 24; }
sed -i \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(gen)|" \
  -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(gen)|" \
  -e "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=$(gen)|" \
  -e "s|^S3_SECRET_ACCESS_KEY=.*|S3_SECRET_ACCESS_KEY=$(gen)|" \
  -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" \
  -e "s|^APP_ENCRYPTION_KEYS=.*|APP_ENCRYPTION_KEYS=k1:$(openssl rand -base64 32)|" \
  .env
```

Check the result with `grep -E 'PASSWORD|SECRET|ENCRYPTION' .env`. No value may still contain
`change-me` or `REPLACE_WITH`.

### Without `openssl`

Run each command once per secret and paste the output into `.env` with an editor (`nano .env`):

```bash
# a password (hex): run once per password entry
docker run --rm alpine sh -c "head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; echo"
# SESSION_SECRET (at least 32 characters)
docker run --rm alpine sh -c "head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; echo"
# APP_ENCRYPTION_KEYS (the whole line, including k1:)
docker run --rm alpine sh -c 'echo k1:$(head -c 32 /dev/urandom | base64)'
```

### Back up `APP_ENCRYPTION_KEYS` now

`APP_ENCRYPTION_KEYS` encrypts stored secrets (bank PINs, API keys, ticket signing keys) and your
backups. **Copy that one line into your password manager now, outside the server.** If the
server dies and you do not have the key, backups and stored secrets cannot be restored. Never
change or delete a key that is in use.

### All variables

Required means: you must set it (or accept the value from the file) before the first start.

| Variable                                                                        | Required                 | Meaning                                                                                                                                                  | Example                       |
| ------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `TIX_CHANNEL`                                                                   | pre-filled               | Which image version runs: `next`, `stable`, `1`, `1.0` or an exact version. See [Updates](#updates-backups-uninstall).                                   | `next`                        |
| `TIX_IMAGE_OWNER`                                                               | pre-filled               | GitHub owner of the images (`ghcr.io/<owner>/tix-web`). Leave as is.                                                                                     | `renthner`                    |
| `COMPOSE_PROJECT_NAME`                                                          | optional                 | Name prefix of the containers and volumes. Do not change after the first start (you would get empty new volumes).                                        | `tix`                         |
| `LOG_LEVEL`                                                                     | optional                 | Log detail: `info`, `debug`, `warn`, `error`.                                                                                                            | `info`                        |
| `PUBLIC_URL`                                                                    | **yes**                  | The address visitors type, with `https://` and without a trailing slash.                                                                                 | `https://tickets.example.org` |
| `SITE_ADDRESS`                                                                  | **yes**                  | Domain name only: Caddy then gets certificates automatically. `:80` means plain HTTP (behind another proxy, or tests).                                   | `tickets.example.org`         |
| `HTTP_PORT`                                                                     | **yes**                  | Host port for HTTP. `80` when Caddy is the public entry.                                                                                                 | `80`                          |
| `HTTPS_PORT`                                                                    | **yes**                  | Host port for HTTPS. `443` when Caddy is the public entry.                                                                                               | `443`                         |
| `TRUSTED_PROXIES`                                                               | optional                 | Only when another reverse proxy sits in front: its address(es) or `private_ranges`. Leave empty when Caddy is the public entry.                          | `private_ranges`              |
| `POSTGRES_USER`                                                                 | pre-filled               | Database user.                                                                                                                                           | `tix`                         |
| `POSTGRES_PASSWORD`                                                             | **yes**                  | Database password (letters and digits only).                                                                                                             | `3f9a…` (48 hex characters)   |
| `POSTGRES_DB`                                                                   | pre-filled               | Database name.                                                                                                                                           | `tix`                         |
| `POSTGRES_MAX_CONNECTIONS`, `WEB_DATABASE_POOL_MAX`, `WORKER_DATABASE_POOL_MAX` | optional (commented out) | Connection tuning for big presales. The defaults are fine for clubs.                                                                                     | `200`, `40`, `10`             |
| `REDIS_PASSWORD`                                                                | **yes**                  | Redis password (letters and digits only).                                                                                                                | `b71c…`                       |
| `REDIS_MAXMEMORY`                                                               | pre-filled               | Memory limit of Redis. Seat locks are never evicted.                                                                                                     | `1gb`                         |
| `REDIS_KEY_PREFIX`                                                              | pre-filled               | Prefix of all Redis keys.                                                                                                                                | `tix`                         |
| `MINIO_ROOT_USER`                                                               | pre-filled               | Admin user of the bundled file storage (MinIO).                                                                                                          | `minio-admin`                 |
| `MINIO_ROOT_PASSWORD`                                                           | **yes**                  | Its password (letters and digits only).                                                                                                                  | `9d2e…`                       |
| `S3_REGION`                                                                     | pre-filled               | Storage region name; leave as is for the bundled MinIO.                                                                                                  | `us-east-1`                   |
| `S3_ACCESS_KEY_ID`                                                              | pre-filled               | Access key the application uses for storage.                                                                                                             | `tix-app`                     |
| `S3_SECRET_ACCESS_KEY`                                                          | **yes**                  | Its secret (letters and digits only).                                                                                                                    | `a05f…`                       |
| `S3_BUCKET_ASSETS`, `S3_BUCKET_DOCUMENTS`, `S3_BUCKET_BACKUPS`                  | pre-filled               | Names of the three buckets (images, documents/PDFs, backups).                                                                                            | `tix-assets` …                |
| `APP_ENCRYPTION_KEYS`                                                           | **yes**                  | Key ring: `id:base64key`, 32 random bytes in base64 (44 characters ending in `=`). Several keys are comma-separated; the first encrypts. **Back it up.** | `k1:Zm9v…YmFy=`               |
| `SESSION_SECRET`                                                                | **yes**                  | Random text of at least 32 characters for signed cookies.                                                                                                | `e4b8…` (64 hex characters)   |
| `WORKER_CONCURRENCY`                                                            | pre-filled               | Parallel background jobs (mail, PDFs).                                                                                                                   | `8`                           |

The `.env` file you downloaded is the authority: it contains more explanation in its comments.
Not listed here on purpose: optional extras that only matter for advanced setups
(`MINIO_IMAGE`, `MC_IMAGE`).

## Step 4: Choose how HTTPS works

Visitors must use HTTPS. Pick **one** variant.

| Variant | Use it when                                                                          |
| ------- | ------------------------------------------------------------------------------------ |
| A       | The server is dedicated to TIX, ports 80 and 443 are free. **Easiest, recommended.** |
| B       | The server already runs **Traefik** on ports 80/443.                                 |
| C       | The server already runs **nginx** on the host.                                       |
| D       | You use Nginx Proxy Manager, Cloudflare Tunnel, a router or any other proxy.         |

### A: Bundled Caddy with automatic HTTPS (recommended)

TIX includes the Caddy web server, which fetches and renews free Let's Encrypt certificates by
itself.

1. Point the DNS **A** record (and **AAAA** if you use IPv6) of your domain to the server **before**
   the first start. Check from the server: `getent hosts tickets.example.org` shows the server's
   IP address.
2. Make sure ports 80 and 443 are not used by another program and are open in every firewall.
3. Set in `.env` (replace the domain):

```bash
sed -i \
  -e "s|^PUBLIC_URL=.*|PUBLIC_URL=https://tickets.example.org|" \
  -e "s|^SITE_ADDRESS=.*|SITE_ADDRESS=tickets.example.org|" \
  -e "s|^HTTP_PORT=.*|HTTP_PORT=80|" \
  -e "s|^HTTPS_PORT=.*|HTTPS_PORT=443|" \
  .env
grep -E '^(PUBLIC_URL|SITE_ADDRESS|HTTP_PORT|HTTPS_PORT|TRUSTED_PROXIES)=' .env
```

Leave `TRUSTED_PROXIES` empty. Certificates are stored in the Docker volume `caddy-data`; they
survive updates. If the first start fails because DNS is wrong, fix DNS and run
`docker compose up -d` again. Let's Encrypt limits failed attempts (a few per hour per domain),
so do not restart in a loop; see [Troubleshooting](#troubleshooting).

### Advanced variants: use the file `docker-compose.override.yml`

Variants B and C change how the `proxy` service is published. Do this in a separate file named
`docker-compose.override.yml` in the same folder. Docker Compose reads it automatically next to
`docker-compose.yml`. Updates replace only `docker-compose.yml`, so your changes survive.

### B: Behind Traefik

Assumptions: Traefik runs in Docker, has an entrypoint (here `websecure`), a certificate resolver
(here `letsencrypt`) and a shared Docker network (here `traefik`). Replace the names with yours.

`.env`:

```bash
PUBLIC_URL=https://tickets.example.org
SITE_ADDRESS=:80
TRUSTED_PROXIES=private_ranges
```

`docker-compose.override.yml`:

```yaml
services:
  proxy:
    # Do not publish any host port; Traefik reaches the proxy over the Docker network.
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
      - traefik.http.services.tix.loadbalancer.server.port=80

networks:
  traefik:
    external: true
```

The service is called `proxy` (it is the bundled Caddy). It must stay in the `default` network,
otherwise it cannot reach the shop. WebSockets work in Traefik without extra settings.

`!reset []` needs Docker Compose **2.24.4 or newer** (newer than the 2.23.1 minimum). If your
Compose is older, delete the `ports: !reset []` line and instead set in `.env`
`HTTP_PORT=127.0.0.1:8081` and `HTTPS_PORT=127.0.0.1:8444`; the ports are then only reachable from
the server itself.

### C: Behind nginx on the host

Let TIX listen only on the server itself, on port 8080:

`.env`:

```bash
PUBLIC_URL=https://tickets.example.org
SITE_ADDRESS=:80
HTTP_PORT=127.0.0.1:8080
HTTPS_PORT=127.0.0.1:8443
TRUSTED_PROXIES=private_ranges
```

`HTTP_PORT=127.0.0.1:8080` means "port 8080, reachable from this server only". This needs no
override file. Then create an nginx site (for example
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

1. `.env`: `PUBLIC_URL=https://tickets.example.org`, `SITE_ADDRESS=:80`, `HTTP_PORT=8080`
   (or `127.0.0.1:8080` if the proxy runs on the same server), `TRUSTED_PROXIES=` the address of the
   proxy (for example `192.168.1.10`, a network such as `192.168.1.0/24`, or `private_ranges`).
2. Forward `https://tickets.example.org` to `http://<server-ip>:8080`, scheme **http**.
3. **WebSockets must be enabled.** In Nginx Proxy Manager tick **Websockets Support** on the proxy
   host. Without it the seat plan does not update live.
4. The proxy must pass the original `Host` header and set `X-Forwarded-For`. (NPM does this by
   default.) Set the maximum upload size to at least 50 MB if the proxy has such a limit.
5. In NPM, request the certificate on the **SSL** tab and tick "Force SSL".

If the proxy runs in Docker on the same server, you can also use a shared Docker network like in
variant B and forward to `proxy:80`.

## Step 5: Start and create the first admin

```bash
docker compose up -d
```

The first start downloads the images (a few hundred MB) and takes one to three minutes. `docker compose up -d`
can show no output for several minutes while this happens: wait, or run `docker compose pull`
first to see the download progress. Check progress:

```bash
docker compose ps
```

All services should be `running` or `healthy`. `minio-init` and `migrate` show `exited (0)`: that
is correct, they are one-time jobs. If something stays `unhealthy`, see
[Troubleshooting](#troubleshooting).

Create the first administrator (use your own e-mail address and name):

```bash
docker compose run --rm migrate node dist/create-admin.mjs --email you@example.org --name "Your Name"
```

The command prints a **password once**. Copy it. Then open `https://tickets.example.org/admin`,
sign in and change the password.

**Turn on two-factor authentication now:** click your name at the bottom left of the admin menu (your account) and
set up the authenticator app (TOTP). Under **Settings → Security** you can make it mandatory for
all admins.

A quick health check from the server: `curl -fsS https://tickets.example.org/api/health`.

## Step 6: First configuration in the admin

Work through this list in the admin area. Everything is under the menu entries on the left.

1. **Settings → Organiser:** organiser name, address, imprint and privacy links, contact. They
   appear in the shop and on invoices.
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

- Phones must be able to reach `PUBLIC_URL`. On a home or club router the server's public
  address is sometimes not reachable from inside the same WiFi ("hairpin NAT"). Test by opening
  `PUBLIC_URL` in the phone's browser while on the venue WiFi.
- Plain `http://` is accepted only for private addresses such as `http://192.168.1.20:8080`.
  Every public address must use `https://`.
- Settings → Scanner → server URL must be the address the **phones** can reach.
- The app always updates to exactly the version your server runs (from GitHub Releases). You can
  switch to updates from your own server in the admin.

More details: [SCANNER.md](SCANNER.md) and [apps/android/README.md](../apps/android/README.md).

## Updates, backups, uninstall

### Updates

1. **Take a backup** (Admin → Backups). Database changes during an update cannot be rolled back
   (pre-releases may contain them).
2. Read the [CHANGELOG](../CHANGELOG.md) of the new version. If it says that the compose file
   changed, download the new `docker-compose.yml` of that release (keep your `.env` and your
   `docker-compose.override.yml`).
3. Update:

```bash
cd tix
docker compose pull
docker compose up -d
```

Database migrations run automatically. The running version is shown in the admin sidebar and at
`/api/health`.

**Choose the version with `TIX_CHANNEL` in `.env`:**

| Value                    | Follows                                                | Use for                                                                     |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| `next`                   | the newest release of any kind, including pre-releases | tests and demos; today the only choice because no stable release exists yet |
| `stable`                 | the newest stable release                              | production (from 1.0.0 on)                                                  |
| `1` or `1.0`             | the newest stable release of that line                 | production without surprises                                                |
| `1.0.0-alpha.3`, `1.0.0` | exactly this version                                   | pinning, rolling back                                                       |

To roll back, set an exact earlier version and run the update commands. This only works when the
database schema is unchanged; otherwise restore the backup you took before the update.

Do not use automatic updaters (Watchtower and similar): updates should be deliberate.

### Backups and restore

Use **Admin → Backups**: database and files, scheduled, with an optional external S3 target.
Restore is in the same place (SUPER_ADMIN only). Details: [BACKUP.md](BACKUP.md). Keep these
outside the server:

- `APP_ENCRYPTION_KEYS` (and the whole `.env`),
- the external backup target.

The data lives in Docker volumes of the project `tix`: `tix_postgres-data`, `tix_redis-data`,
`tix_minio-data`, `tix_caddy-data`. List them with `docker volume ls`.

### Uninstall

```bash
cd tix
docker compose down        # stops and removes containers, KEEPS your data
docker compose down -v     # also DELETES all data (database, files, certificates) - irreversible
```

## Troubleshooting

Useful commands (run them inside the `tix` folder):

```bash
docker compose ps                     # state of all services
docker compose logs --tail 100 web    # last log lines of one service
docker compose logs -f proxy          # follow a log live (stop with Ctrl+C)
docker compose logs minio-init migrate
curl -fsS http://localhost:8080/api/health   # only if HTTP_PORT is 8080 on this server
```

The `web`, `worker` and `realtime` services write one JSON object per log line. Errors have
`"level":50`, warnings `"level":40`: `docker compose logs web | grep '"level":50'`. Set `LOG_LEVEL`
in `.env` (`error`, `warn`, `info`, `debug`; default `info`) to change the verbosity. Web log
lines of a request carry a `reqId` that matches the `X-Request-Id` set by the bundled proxy.

Service names: `web`, `worker`, `realtime`, `proxy`, `postgres`, `redis`, `minio`, `minio-init`,
`migrate`.

| Symptom                                                                           | Cause                                                                                                            | Fix                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Error mentioning `configs.content`, "unknown key" or "additional property"        | Docker Compose is older than 2.23.1                                                                              | Install Docker from the official repository (Step 1). `docker compose version` must show 2.23.1 or newer.                                                                                                                                              |
| `manifest unknown` / `not found` when pulling `...:stable`                        | No stable release exists yet, so the image tag `stable` does not exist                                           | Set `TIX_CHANNEL=next` (or an exact version such as `1.0.0-alpha.3`) in `.env`, then `docker compose pull && docker compose up -d`.                                                                                                                    |
| `required variable ... is missing a value` / `set POSTGRES_PASSWORD in .env`      | The variable is empty or missing, or `.env` is not in the current folder                                         | Run the command inside the `tix` folder, make sure the file is called `.env` (not `env.example`), and fill the named variable.                                                                                                                         |
| Errors such as `password authentication failed`, `invalid URL`, Redis `WRONGPASS` | A password contains special characters (`@ : / # ? %`), quotes, or was changed after first start                 | Use letters and digits only, no quotes. The database password is fixed when the data volume is created: changing `POSTGRES_PASSWORD` later needs `docker compose down -v` on a fresh install (deletes data) or a manual password change in PostgreSQL. |
| Browser shows a certificate warning or no HTTPS                                   | Caddy could not get a certificate: DNS wrong, ports 80/443 blocked, or Let's Encrypt limit                       | `docker compose logs proxy`. Check that the domain points to this server, ports 80 and 443 are open (provider firewall too) and `SITE_ADDRESS` is only the domain (no `https://`). Wait one hour if the log mentions a rate limit.                     |
| `port is already allocated` / `address already in use` on port 80 or 443          | Another web server (apache2, nginx) uses the port                                                                | Stop it (`sudo systemctl disable --now apache2`) or use variant B/C/D. `sudo ss -ltnp \| grep -E ':80 \|:443 '` shows who uses the port.                                                                                                               |
| Firewall (ufw) is on, but a port is still reachable                               | Docker publishes ports directly and bypasses ufw rules                                                           | Only the proxy publishes ports (80/443 or your `HTTP_PORT`). To keep a port private, bind it to `127.0.0.1` (`HTTP_PORT=127.0.0.1:8080`). Do not rely on ufw alone for Docker ports.                                                                   |
| Seats do not update live; the browser console shows WebSocket errors              | Your reverse proxy does not forward WebSockets for `/socket.io`                                                  | Variant C: use the `/socket.io/` block above. NPM: enable Websockets Support. Cloudflare: WebSockets must be on.                                                                                                                                       |
| Everyone gets "too many requests", or the audit log shows one IP for all visitors | Another proxy sits in front but `TRUSTED_PROXIES` is empty                                                       | Set `TRUSTED_PROXIES` to the proxy's address or `private_ranges`, then `docker compose up -d`. Leave it empty when Caddy is the public entry.                                                                                                          |
| Phone cannot pair, says "server address not allowed"                              | `http://` with a public address, or a wrong server URL                                                           | Use `https://`. `http://` works only for private IPs. Check Settings → Scanner → server URL.                                                                                                                                                           |
| Phone cannot pair, no connection or timeout                                       | Phone cannot reach `PUBLIC_URL` (hairpin NAT, VPN, wrong URL)                                                    | Open `PUBLIC_URL` in the phone's browser on the same WiFi. If it fails, use mobile data or fix the router (NAT loopback / local DNS).                                                                                                                  |
| The pairing QR code contains `localhost`                                          | Scanner server URL is not set                                                                                    | Settings → Scanner → set the server URL to `PUBLIC_URL`.                                                                                                                                                                                               |
| No e-mails arrive                                                                 | Wrong SMTP data, blocked port, spam folder                                                                       | Settings → E-mail → **Send test e-mail** shows the error. Try port 587 (STARTTLS) or 465 (TLS); `docker compose logs worker`.                                                                                                                          |
| Backups or stored secrets cannot be read after moving to a new server             | `APP_ENCRYPTION_KEYS` differs from the old server                                                                | Use the original key line from your password manager. Without it the encrypted data cannot be recovered; this is why you back it up.                                                                                                                   |
| `minio-init` exited with a non-zero code, `web` never starts                      | MinIO credentials in `.env` do not match the stored ones, or MinIO is not healthy                                | `docker compose logs minio minio-init`. Do not change `MINIO_ROOT_PASSWORD` or `S3_SECRET_ACCESS_KEY` after the first start (on a fresh install: `docker compose down -v`, fix `.env`, start again).                                                   |
| A service is `unhealthy`                                                          | Start still in progress, or a configuration error                                                                | Wait two minutes. Then `docker compose logs --tail 100 <service>`. The web check is `GET /api/health` (it reports PostgreSQL, Redis and workers).                                                                                                      |
| Checkout shows bank transfer or PayPal as "Currently not available"               | No default receiving bank account exists (bank transfer), or PayPal is not configured/enabled                    | Bank & payments → Accounts & connections: create an account and mark it as default. PayPal: Settings → Payments.                                                                                                                                       |
| Admin login says "Too many attempts"                                              | More than 10 failed attempts per e-mail address or 20 per IP address within 15 minutes (also from scripts/tests) | Wait up to 15 minutes; the limit expires by itself. If you forgot the password: `docker compose run --rm migrate node dist/create-admin.mjs --email you@example.org --reset` prints a new password (roles are kept).                                   |
| `docker compose up` / `pull` shows no progress for minutes                        | The images are still downloading                                                                                 | Wait, or run `docker compose pull` separately to see the progress.                                                                                                                                                                                     |
| Page says "maintenance" for a long time                                           | A backup restore is running                                                                                      | Wait; check `docker compose logs web worker`.                                                                                                                                                                                                          |

If you are stuck, open an [issue](https://github.com/Renthner/tix-platform/issues/new/choose)
with the output of `docker compose ps` and the relevant log lines. **Remove passwords and keys
before you post logs.**
