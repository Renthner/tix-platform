# Install TIX on your own server

English | [Deutsch](INSTALL.de.md)

This guide has two parts. **Part 1** gets a ticket shop running in about 15 minutes: you copy and
paste a handful of commands and do **not** need to know Docker. **Part 2** is the appendix for
special setups (another reverse proxy, Cloudflare), the full variable reference, monitoring and
troubleshooting.

> TIX is currently a pre-release (see the version pinned below). Wherever this guide says "the latest
> release", use the version shown on the [releases page](https://github.com/Renthner/tix-platform/releases).

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
export TIX_VERSION=1.0.0-alpha.19
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
and Ubuntu have; [without openssl](#the-env-file-in-detail)). It sets your address and generates
the four secrets:

```bash
DOMAIN=tickets.example.org   # <- your domain
gen() { openssl rand -hex 24; }
sed -i \
  -e "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" \
  -e "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$DOMAIN|" \
  -e "s|^HTTP_PORT=.*|HTTP_PORT=80|" \
  -e "s|^HTTPS_PORT=.*|HTTPS_PORT=443|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(gen)|" \
  -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(gen)|" \
  -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" \
  -e "s|^APP_ENCRYPTION_KEYS=.*|APP_ENCRYPTION_KEYS=k1:$(openssl rand -base64 32)|" \
  .env
grep -E '^(PUBLIC_URL|SITE_ADDRESS|POSTGRES_PASSWORD|REDIS_PASSWORD|SESSION_SECRET|APP_ENCRYPTION_KEYS)=' .env
```

No value may still contain `change-me` or `REPLACE_WITH`. That is all: the passwords of the
bundled file storage (MinIO) are generated on the first start and stored in a Docker volume, you
do not enter them anywhere.

**Back up the `APP_ENCRYPTION_KEYS` line now:** copy it into your password manager, outside the
server. It encrypts stored secrets (bank PINs, API keys, ticket signing keys) and your backups;
without it neither can be restored. Never change or delete a key that is in use.

### 3. Start

```bash
docker compose up -d
```

The first start downloads the images (a few hundred MB) and takes one to three minutes;
`docker compose up -d` can show no output meanwhile. Check with `docker compose ps`: all services
should be `running` or `healthy`; `storage-credentials`, `minio-init` and `migrate` show
`exited (0)` because they are one-time jobs. If the HTTPS certificate cannot be issued, DNS is
usually wrong: see [Troubleshooting](#troubleshooting).

Create the first administrator (your own e-mail address and name):

```bash
docker compose run --rm migrate node dist/create-admin.mjs --email you@example.org --name "Your Name"
```

The command prints a **password once**. Copy it.

### 4. Open the admin

Open `https://tickets.example.org/admin`, sign in and change the password. Turn on
two-factor authentication (click your name at the bottom left of the admin menu; under
**Settings → Security** you can make it mandatory). The dashboard then shows a **setup checklist**
that leads you through the first steps: organiser data, SMTP (with a test e-mail), payment
methods, taxes and fees, venue and event, scanner URL and backups. The same list with
explanations is in [First configuration in the admin](#first-configuration-in-the-admin).

### Updating and backups

```bash
cd tix
# Admin -> Backups: take a backup first, then download the new docker-compose.yml of the release
# (only if its CHANGELOG says the compose file changed), then:
docker compose pull
docker compose up -d
```

Database migrations run automatically. Details, versions and rolling back:
[Updates, backups, uninstall](#updates-backups-uninstall). Backups (database and files, scheduled,
optionally to an external S3 target) are in the admin under **Backups**: [BACKUP.md](BACKUP.md).
**Keep `APP_ENCRYPTION_KEYS` and an external backup target outside the server.**

Running behind Traefik, nginx, Nginx Proxy Manager, a tunnel or Cloudflare instead of the bundled
HTTPS? See [HTTPS variants](#https-variants) in Part 2.

---

## Part 2: Advanced (appendix)

1. [Installing Docker](#installing-docker)
2. [The `.env` file in detail](#the-env-file-in-detail)
3. [HTTPS variants](#https-variants): own reverse proxy (Traefik, nginx, Nginx Proxy Manager, tunnels), Cloudflare
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
- Passwords are placed inside connection URLs. Use **only letters and digits** (hex text is
  perfect). Characters like `@ : / # ? %` break the connection and cause confusing errors.
- Use a **different** password for every entry.

### Without `openssl`

Run each command once per secret and paste the output into `.env` with an editor (`nano .env`):

```bash
# a password (hex): run once for POSTGRES_PASSWORD and once for REDIS_PASSWORD
docker run --rm alpine sh -c "head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; echo"
# SESSION_SECRET (at least 32 characters)
docker run --rm alpine sh -c "head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; echo"
# APP_ENCRYPTION_KEYS (the whole line, including k1:)
docker run --rm alpine sh -c 'echo k1:$(head -c 32 /dev/urandom | base64)'
```

### Back up `APP_ENCRYPTION_KEYS` now

`APP_ENCRYPTION_KEYS` encrypts stored secrets (bank PINs, API keys, ticket signing keys) and your
backups. **Copy that one line into your password manager, outside the server.** If the server
dies and you do not have the key, backups and stored secrets cannot be restored. Never change or
delete a key that is in use.

### File storage credentials (MinIO): nothing to enter

The bundled file storage (MinIO) needs no entries in `.env`. On the first start the one-time
service `storage-credentials` generates the MinIO administrator name and password and the access
key and secret the application uses, and stores them as four files in the Docker volume
`storage-credentials` (`tix_storage-credentials` with the default project name). Existing files
are never regenerated, so restarts and updates keep them. The MinIO administrator pair can only
be read by MinIO's own containers; the application containers get only their access key pair,
read-only.

- **Look at them** (for example to log in to the MinIO console, which is not published by default):
  `docker compose exec minio cat /run/tix-storage/minio-root-user` and
  `docker compose exec minio cat /run/tix-storage/minio-root-password`.
- **Installations created before the credentials were generated** may still have
  `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` in their
  `.env`. Keep them there for the next start: the values are copied into the volume and MinIO
  keeps working with its existing data. Afterwards the entries in `.env` are optional (the
  volume holds the values). A `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` in `.env` that
  _differs_ from the stored pair is **refused**: `storage-credentials` stops with an explanation,
  because MinIO keeps the administrator credentials it was first started with (overwriting them
  would lock the stack out of its own storage). Remove the two entries from `.env`; to rotate the
  pair on purpose, follow the MinIO documentation for changing root credentials and then replace
  the files `minio-root-user` and `minio-root-password` in the volume. If you delete
  them _before_ that first start on the new version, `storage-credentials` stops with an
  explanation instead of inventing a new administrator password for existing data; put the old
  `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` back once.
- **Changing the application key pair** (`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` in `.env`) is
  allowed. Edit `.env`, run `docker compose up -d` (this re-runs `storage-credentials` and
  `minio-init`, which rotates the user secret to the new value) and then
  `docker compose up -d --force-recreate web worker`: the running containers read the files only at
  start and would otherwise keep using the old secret.
- **MinIO runs as root:** the bundled MinIO and `mc` images must run as root, because the
  administrator pair is readable by root only. A custom `MINIO_IMAGE` / `MC_IMAGE` that switches
  to another user is not supported.
- **Moving to another server or restoring a backup:** the volume is _not_ part of TIX backups and
  is _not_ needed. Backups are encrypted with `APP_ENCRYPTION_KEYS` and contain the data and files
  themselves, not the storage passwords; a new installation generates new ones and the restore
  uses them.

## HTTPS variants

Visitors must use HTTPS. The quick start used variant A. Pick another variant only if you cannot use it.

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
3. Set in `.env` (the quick start already did this; replace the domain):

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
variant B and forward to `proxy:80`.

### Behind Cloudflare

Cloudflare (orange cloud) can sit in front of any of the variants above. The request then travels
through several hops:

```text
Visitor -> Cloudflare -> (router port forward) -> Traefik / nginx / other proxy -> bundled Caddy -> TIX
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
  present a valid certificate, for example from Traefik or the bundled Caddy). "Flexible" causes
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

**Rolling back across the release that introduced the generated storage credentials** needs that
older release's `docker-compose.yml` (the newer file reads the credentials from files, the older
one from `.env`), and the credentials must be in `.env` again. Read them from the running stack
before you roll back and add them to `.env`:

```bash
docker compose exec web cat /run/tix-storage/s3-access-key-id; echo
docker compose exec web cat /run/tix-storage/s3-secret-access-key; echo
docker compose exec minio cat /run/tix-storage/minio-root-user; echo
docker compose exec minio cat /run/tix-storage/minio-root-password; echo
```

They become `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `MINIO_ROOT_USER` and
`MINIO_ROOT_PASSWORD` in `.env`.

Do not use automatic updaters (Watchtower and similar): updates should be deliberate.

### Backups and restore

Use **Admin → Backups**: database and files, scheduled, with an optional external S3 target.
Restore is in the same place (SUPER_ADMIN only). Details: [BACKUP.md](BACKUP.md). Keep these
outside the server:

- `APP_ENCRYPTION_KEYS` (and the whole `.env`),
- the external backup target.

The data lives in Docker volumes of the project `tix`: `tix_postgres-data`, `tix_redis-data`,
`tix_minio-data`, `tix_caddy-data` and `tix_storage-credentials` (the generated storage passwords, see
[File storage credentials](#file-storage-credentials-minio-nothing-to-enter); not needed to restore a backup). List them with `docker volume ls`.

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

Only the first block is required. Everything else has a default in `docker-compose.yml`; the rows
marked "optional" are commented out in the downloaded `.env` (remove the `#` to use them).

| Variable                                                                             | Required   | Meaning                                                                                                                                                                                                                                                                            | Example                       |
| ------------------------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `PUBLIC_URL`                                                                         | **yes**    | The address visitors type, with `https://` and without a trailing slash.                                                                                                                                                                                                           | `https://tickets.example.org` |
| `POSTGRES_PASSWORD`                                                                  | **yes**    | Database password (letters and digits only).                                                                                                                                                                                                                                       | `3f9a…` (48 hex characters)   |
| `REDIS_PASSWORD`                                                                     | **yes**    | Redis password (letters and digits only).                                                                                                                                                                                                                                          | `b71c…`                       |
| `APP_ENCRYPTION_KEYS`                                                                | **yes**    | Key ring: `id:base64key`, 32 random bytes in base64 (44 characters ending in `=`). Several keys are comma-separated; the first encrypts. **Back it up.**                                                                                                                           | `k1:Zm9v…YmFy=`               |
| `SESSION_SECRET`                                                                     | **yes**    | Random text of at least 32 characters for signed cookies.                                                                                                                                                                                                                          | `e4b8…` (64 hex characters)   |
| `SITE_ADDRESS`                                                                       | pre-filled | Domain name only: Caddy then gets certificates automatically (the quick start sets it). `:80` means plain HTTP (behind another proxy, or tests).                                                                                                                                   | `tickets.example.org`         |
| `HTTP_PORT`                                                                          | pre-filled | Host port for HTTP. `80` when Caddy is the public entry.                                                                                                                                                                                                                           | `80`                          |
| `HTTPS_PORT`                                                                         | pre-filled | Host port for HTTPS. `443` when Caddy is the public entry.                                                                                                                                                                                                                         | `443`                         |
| `TIX_CHANNEL`                                                                        | pre-filled | Which image version runs: `next`, `stable`, `1`, `1.0` or an exact version. See [Updates](#updates-backups-uninstall).                                                                                                                                                             | `next`                        |
| `TRUSTED_PROXIES`                                                                    | optional   | Only when another reverse proxy sits in front: its address(es) or `private_ranges`. Leave empty when Caddy is the public entry.                                                                                                                                                    | `private_ranges`              |
| `COMPOSE_PROJECT_NAME`                                                               | optional   | Name prefix of the containers and volumes. Do not change after the first start (you would get empty new volumes).                                                                                                                                                                  | `tix`                         |
| `LOG_LEVEL`                                                                          | optional   | Log detail: `info`, `debug`, `warn`, `error`.                                                                                                                                                                                                                                      | `info`                        |
| `POSTGRES_USER`, `POSTGRES_DB`                                                       | optional   | Database user and name.                                                                                                                                                                                                                                                            | `tix`                         |
| `POSTGRES_MAX_CONNECTIONS`, `WEB_DATABASE_POOL_MAX`, `WORKER_DATABASE_POOL_MAX`      | optional   | Connection tuning for big presales. The defaults are fine for clubs.                                                                                                                                                                                                               | `200`, `40`, `10`             |
| `REDIS_MAXMEMORY`, `REDIS_KEY_PREFIX`                                                | optional   | Memory limit of Redis (seat locks are never evicted) and prefix of all Redis keys.                                                                                                                                                                                                 | `1gb`, `tix`                  |
| `WORKER_CONCURRENCY`                                                                 | optional   | Parallel background jobs (mail, PDFs).                                                                                                                                                                                                                                             | `8`                           |
| `S3_REGION`                                                                          | optional   | Storage region name; leave as is for the bundled MinIO.                                                                                                                                                                                                                            | `us-east-1`                   |
| `S3_BUCKET_ASSETS`, `S3_BUCKET_DOCUMENTS`, `S3_BUCKET_BACKUPS`                       | optional   | Names of the three buckets (images, documents/PDFs, backups).                                                                                                                                                                                                                      | `tix-assets` …                |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | legacy     | **Not needed any more:** generated on the first start and kept in the `storage-credentials` volume. Only for installations created earlier: keep their old values (copied into the volume once). See [File storage credentials](#file-storage-credentials-minio-nothing-to-enter). |                               |
| `TIX_IMAGE_OWNER`                                                                    | optional   | GitHub owner of the images (`ghcr.io/<owner>/tix-web`). Pre-set inside `docker-compose.yml`; leave as is.                                                                                                                                                                          | `renthner`                    |

Not listed here on purpose: optional extras that only matter for advanced setups
(`MINIO_IMAGE`, `MC_IMAGE`).

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
`storage-credentials`, `migrate`.

| Symptom                                                                                          | Cause                                                                                                                                        | Fix                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Error mentioning `configs.content`, "unknown key" or "additional property"                       | Docker Compose is older than 2.23.1                                                                                                          | Install Docker from the official repository ([Installing Docker](#installing-docker)). `docker compose version` must show 2.23.1 or newer.                                                                                                                                                                           |
| `manifest unknown` / `not found` when pulling `...:stable`                                       | No stable release exists yet, so the image tag `stable` does not exist                                                                       | Set `TIX_CHANNEL=next` (or an exact version such as `1.0.0-alpha.3`) in `.env`, then `docker compose pull && docker compose up -d`.                                                                                                                                                                                  |
| `required variable ... is missing a value` / `set POSTGRES_PASSWORD in .env`                     | The variable is empty or missing, or `.env` is not in the current folder                                                                     | Run the command inside the `tix` folder, make sure the file is called `.env` (not `env.example`), and fill the named variable.                                                                                                                                                                                       |
| Errors such as `password authentication failed`, `invalid URL`, Redis `WRONGPASS`                | A password contains special characters (`@ : / # ? %`), quotes, or was changed after first start                                             | Use letters and digits only, no quotes. The database password is fixed when the data volume is created: changing `POSTGRES_PASSWORD` later needs `docker compose down -v` on a fresh install (deletes data) or a manual password change in PostgreSQL.                                                               |
| Browser shows a certificate warning or no HTTPS                                                  | Caddy could not get a certificate: DNS wrong, ports 80/443 blocked, or Let's Encrypt limit                                                   | `docker compose logs proxy`. Check that the domain points to this server, ports 80 and 443 are open (provider firewall too) and `SITE_ADDRESS` is only the domain (no `https://`). Wait one hour if the log mentions a rate limit.                                                                                   |
| `port is already allocated` / `address already in use` on port 80 or 443                         | Another web server (apache2, nginx) uses the port                                                                                            | Stop it (`sudo systemctl disable --now apache2`) or use variant B/C/D. `sudo ss -ltnp \| grep -E ':80 \|:443 '` shows who uses the port.                                                                                                                                                                             |
| Firewall (ufw) is on, but a port is still reachable                                              | Docker publishes ports directly and bypasses ufw rules                                                                                       | Only the proxy publishes ports (80/443 or your `HTTP_PORT`). To keep a port private, bind it to `127.0.0.1` (`HTTP_PORT=127.0.0.1:8080`). Do not rely on ufw alone for Docker ports.                                                                                                                                 |
| Seats do not update live; the browser console shows WebSocket errors                             | Your reverse proxy does not forward WebSockets for `/socket.io`                                                                              | Variant C: use the `/socket.io/` block above. NPM: enable Websockets Support. Cloudflare: WebSockets must be on.                                                                                                                                                                                                     |
| Everyone gets "too many requests", or the audit log shows one IP for all visitors                | Another proxy sits in front but `TRUSTED_PROXIES` is empty                                                                                   | Set `TRUSTED_PROXIES` to the proxy's address or `private_ranges`, then `docker compose up -d`. Leave it empty when Caddy is the public entry.                                                                                                                                                                        |
| Phone cannot pair, says "server address not allowed"                                             | `http://` with a public address, or a wrong server URL                                                                                       | Use `https://`. `http://` works only for private IPs. Check Settings → Scanner → server URL.                                                                                                                                                                                                                         |
| Phone cannot pair, no connection or timeout                                                      | Phone cannot reach `PUBLIC_URL` (hairpin NAT, VPN, wrong URL)                                                                                | Open `PUBLIC_URL` in the phone's browser on the same WiFi. If it fails, use mobile data or fix the router (NAT loopback / local DNS).                                                                                                                                                                                |
| The pairing QR code contains `localhost`                                                         | Scanner server URL is not set                                                                                                                | Settings → Scanner → set the server URL to `PUBLIC_URL`.                                                                                                                                                                                                                                                             |
| No e-mails arrive                                                                                | Wrong SMTP data, blocked port, spam folder                                                                                                   | Settings → E-mail → **Send test e-mail** shows the error. Try port 587 (STARTTLS) or 465 (TLS); `docker compose logs worker`.                                                                                                                                                                                        |
| Backups or stored secrets cannot be read after moving to a new server                            | `APP_ENCRYPTION_KEYS` differs from the old server                                                                                            | Use the original key line from your password manager. Without it the encrypted data cannot be recovered; this is why you back it up.                                                                                                                                                                                 |
| `minio-init` exited with a non-zero code, `web` never starts                                     | MinIO is not healthy, or the stored storage credentials do not match the MinIO data                                                          | `docker compose logs storage-credentials minio minio-init`. Do not delete the volume `storage-credentials` while `minio-data` exists (on a fresh install: `docker compose down -v`, start again).                                                                                                                    |
| `storage-credentials` exits with "MinIO already holds data but no stored root credential exists" | An existing installation whose old `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` were removed from `.env` before the first start of this version | Put the old values back into `.env` once (`MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`), run `docker compose up -d`; they are then kept in the volume.                                                                                                                                                                   |
| Where are the MinIO / storage credentials? What happens when I restore on another server?        | They are generated on the first start and live in the Docker volume `storage-credentials`                                                    | `docker compose exec minio cat /run/tix-storage/minio-root-password` (also `minio-root-user`). The volume is not part of TIX backups and not needed for a restore: backups are encrypted with `APP_ENCRYPTION_KEYS` and contain data and files, and the new installation uses its own generated storage credentials. |
| A service is `unhealthy`                                                                         | Start still in progress, or a configuration error                                                                                            | Wait two minutes. Then `docker compose logs --tail 100 <service>`. The web check is `GET /api/health` (it reports PostgreSQL, Redis and workers).                                                                                                                                                                    |
| Checkout shows bank transfer or PayPal as "Currently not available"                              | No default receiving bank account exists (bank transfer), or PayPal is not configured/enabled                                                | Bank & payments → Accounts & connections: create an account and mark it as default. PayPal: Settings → Payments.                                                                                                                                                                                                     |
| Admin login says "Too many attempts"                                                             | More than 10 failed attempts per e-mail address or 20 per IP address within 15 minutes (also from scripts/tests)                             | Wait up to 15 minutes; the limit expires by itself. If you forgot the password: `docker compose run --rm migrate node dist/create-admin.mjs --email you@example.org --reset` prints a new password (roles are kept).                                                                                                 |
| `docker compose up` / `pull` shows no progress for minutes                                       | The images are still downloading                                                                                                             | Wait, or run `docker compose pull` separately to see the progress.                                                                                                                                                                                                                                                   |
| Page says "maintenance" for a long time                                                          | A backup restore is running                                                                                                                  | Wait; check `docker compose logs web worker`.                                                                                                                                                                                                                                                                        |

If you are stuck, open an [issue](https://github.com/Renthner/tix-platform/issues/new/choose)
with the output of `docker compose ps` and the relevant log lines. **Remove passwords and keys
before you post logs.**
