# TIX auf deinem eigenen Server installieren

[English](INSTALL.md) | Deutsch

Diese Anleitung führt dich von einem leeren Linux-Server bis zum laufenden Ticketshop. Du musst
dich per SSH anmelden und Befehle kopieren und einfügen können. Du musst **kein** Docker-Experte
sein.

Zeitbedarf: etwa 30 Minuten, plus Wartezeit auf DNS, wenn du die Domain gerade erst bestellt hast.

> TIX ist derzeit eine Vorabversion (Version siehe unten). Wo diese Anleitung „das neueste Release"
> sagt, nimm die Version von der [Release-Seite](https://github.com/Renthner/tix-platform/releases).

## Inhalt

1. [Was du brauchst](#was-du-brauchst)
2. [Schritt 1: Docker installieren](#schritt-1-docker-installieren)
3. [Schritt 2: Die zwei Dateien herunterladen](#schritt-2-die-zwei-dateien-herunterladen)
4. [Schritt 3: Die `.env`-Datei ausfüllen](#schritt-3-die-env-datei-ausfüllen)
5. [Schritt 4: HTTPS-Variante wählen](#schritt-4-https-variante-wählen)
6. [Schritt 5: Starten und ersten Admin anlegen](#schritt-5-starten-und-ersten-admin-anlegen)
7. [Schritt 6: Erste Einrichtung im Admin-Bereich](#schritt-6-erste-einrichtung-im-admin-bereich)
8. [Check-in-Handys](#check-in-handys)
9. [Updates, Backups, Deinstallation](#updates-backups-deinstallation)
10. [Fehlersuche](#fehlersuche)

## Was du brauchst

| Was                | Details                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ein Linux-Server   | Debian oder Ubuntu (andere Distributionen gehen, die Docker-Befehle unterscheiden sich). `linux/amd64` oder `linux/arm64`. Root oder `sudo`.                    |
| Größe (Empfehlung) | 2 vCPU, 4 GB RAM, 20 GB Platte reichen für einen Vereinsshop. Plane mehr Platte für viele Bilder, PDFs und Backups ein, mehr RAM und CPU für große Vorverkäufe. |
| Ein Domainname     | Zum Beispiel `tickets.example.org`, mit einem **A**-Eintrag (und **AAAA** für IPv6) auf die öffentliche IP-Adresse des Servers.                                 |
| Offene Ports       | **80** und **443** aus dem Internet erreichbar (auch in der Firewall deines Hosters).                                                                           |
| Ein SMTP-Konto     | Zum Versand der E-Mails (Bestellbestätigung, Tickets). Host, Port, Benutzername und Passwort von deinem Mail-Anbieter.                                          |
| Docker             | Docker Engine **und** Docker Compose **ab 2.23.1**. Schritt 1 installiert beides.                                                                               |

Alles Fachliche (Preise, Gebühren, Bank, SMTP, PayPal, Gestaltung) trägst du später im
Admin-Bereich ein. Die `.env`-Datei enthält nur die technischen Einstellungen.

## Schritt 1: Docker installieren

Pakete aus der Distribution (`apt install docker.io`, `docker-compose`) sind oft zu alt. Installiere
Docker stattdessen aus dem offiziellen Docker-Repository. Melde dich per SSH am Server an und führe
die Befehle für dein System aus.

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

Andere Systeme: <https://docs.docker.com/engine/install/>.

### Prüfen

```bash
docker --version
docker compose version
```

`docker compose version` muss **2.23.1 oder neuer** anzeigen. Kommt `command not found` oder eine
ältere Nummer, ist das falsche Paket installiert: Entferne alte Pakete (`sudo apt-get remove docker
docker.io docker-compose`) und wiederhole die Schritte oben.

Optional: Damit du nicht bei jedem Docker-Befehl `sudo` brauchst, nimm dich in die Gruppe `docker`
auf und melde dich neu an: `sudo usermod -aG docker $USER`. Diese Anleitung geht davon aus, dass du
`docker` ohne `sudo` starten kannst; sonst setze `sudo` davor.

## Schritt 2: Die zwei Dateien herunterladen

TIX braucht genau zwei Dateien von der Release-Seite: `docker-compose.yml` und `env.example`.

```bash
export TIX_VERSION=1.0.0-alpha.15
mkdir tix && cd tix
curl -fLO https://github.com/Renthner/tix-platform/releases/download/v$TIX_VERSION/docker-compose.yml
curl -fLO https://github.com/Renthner/tix-platform/releases/download/v$TIX_VERSION/env.example
mv env.example .env
ls -la
```

Im Ordner `tix` müssen jetzt `docker-compose.yml` und `.env` liegen. Arbeite für alle
`docker compose`-Befehle immer in diesem Ordner (`cd tix`).

`curl -f` bricht mit einem Fehler ab, statt eine Fehlerseite zu speichern; eine falsche
Versionsnummer fällt also sofort auf. Sobald es ein stabiles `1.0.0` gibt, kannst du stattdessen
`https://github.com/Renthner/tix-platform/releases/latest/download/<Datei>` verwenden. Bis dahin
gibt es diese Adresse nicht (Fehler 404).

**Optional: Download prüfen.** Auf der Release-Seite liegt auch `SHA256SUMS.txt`:

```bash
curl -fLO https://github.com/Renthner/tix-platform/releases/download/v$TIX_VERSION/SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt --ignore-missing
```

Mach das _vor_ `mv env.example .env`, sonst passt der Dateiname nicht. Stärkere Prüfungen
(Signaturen, Attestierungen) stehen in [RELEASES.md](RELEASES.md#verifying-releases) (Englisch).

## Schritt 3: Die `.env`-Datei ausfüllen

Die `.env`-Datei enthält die Passwörter und die Web-Adresse. Regeln:

- Pro Zeile ein `SCHLÜSSEL=Wert`. **Keine Anführungszeichen**, keine Leerzeichen um das `=`.
- Passwörter werden in Verbindungs-URLs eingebaut. Nimm **nur Buchstaben und Ziffern** (Hex-Text
  ist ideal). Zeichen wie `@ : / # ? %` zerstören die Verbindung und führen zu verwirrenden Fehlern.
- Nimm für jeden Eintrag ein **anderes** Passwort.

### Schnell: alle Geheimnisse mit einem Befehl erzeugen

Kopiere diesen ganzen Block und füge ihn ein (funktioniert, wenn `openssl` installiert ist – bei
Debian und Ubuntu der Fall):

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

Prüfe das Ergebnis mit `grep -E 'PASSWORD|SECRET|ENCRYPTION' .env`. Kein Wert darf noch
`change-me` oder `REPLACE_WITH` enthalten.

### Ohne `openssl`

Führe jeden Befehl einmal pro Geheimnis aus und trage die Ausgabe mit einem Editor (`nano .env`)
in die `.env` ein:

```bash
# ein Passwort (hex): einmal pro Passwort-Eintrag ausführen
docker run --rm alpine sh -c "head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; echo"
# SESSION_SECRET (mindestens 32 Zeichen)
docker run --rm alpine sh -c "head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; echo"
# APP_ENCRYPTION_KEYS (die ganze Zeile, mit k1:)
docker run --rm alpine sh -c 'echo k1:$(head -c 32 /dev/urandom | base64)'
```

### `APP_ENCRYPTION_KEYS` jetzt sichern

`APP_ENCRYPTION_KEYS` verschlüsselt gespeicherte Geheimnisse (Bank-PINs, API-Schlüssel,
Ticket-Signaturschlüssel) und deine Backups. **Kopiere diese eine Zeile jetzt in deinen
Passwortmanager, außerhalb des Servers.** Fällt der Server aus und du hast den Schlüssel nicht,
lassen sich Backups und gespeicherte Geheimnisse nicht wiederherstellen. Ändere oder lösche nie
einen Schlüssel, der in Benutzung ist.

### Alle Variablen

„Pflicht" heißt: Du musst sie vor dem ersten Start setzen (oder den Wert aus der Datei behalten).

| Variable                                                                        | Pflicht                   | Bedeutung                                                                                                                                                         | Beispiel                      |
| ------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `TIX_CHANNEL`                                                                   | vorbelegt                 | Welche Image-Version läuft: `next`, `stable`, `1`, `1.0` oder eine genaue Version. Siehe [Updates](#updates-backups-deinstallation).                              | `next`                        |
| `TIX_IMAGE_OWNER`                                                               | vorbelegt                 | GitHub-Besitzer der Images (`ghcr.io/<owner>/tix-web`). Nicht ändern.                                                                                             | `renthner`                    |
| `COMPOSE_PROJECT_NAME`                                                          | optional                  | Namenspräfix der Container und Volumes. Nach dem ersten Start nicht ändern (du bekämst leere neue Volumes).                                                       | `tix`                         |
| `LOG_LEVEL`                                                                     | optional                  | Log-Detailgrad: `info`, `debug`, `warn`, `error`.                                                                                                                 | `info`                        |
| `PUBLIC_URL`                                                                    | **ja**                    | Die Adresse, die Besucher eintippen, mit `https://` und ohne Schrägstrich am Ende.                                                                                | `https://tickets.example.org` |
| `SITE_ADDRESS`                                                                  | **ja**                    | Nur der Domainname: Caddy holt dann selbst Zertifikate. `:80` bedeutet reines HTTP (hinter einem anderen Proxy oder für Tests).                                   | `tickets.example.org`         |
| `HTTP_PORT`                                                                     | **ja**                    | Host-Port für HTTP. `80`, wenn Caddy der öffentliche Eingang ist.                                                                                                 | `80`                          |
| `HTTPS_PORT`                                                                    | **ja**                    | Host-Port für HTTPS. `443`, wenn Caddy der öffentliche Eingang ist.                                                                                               | `443`                         |
| `TRUSTED_PROXIES`                                                               | optional                  | Nur wenn ein weiterer Reverse-Proxy davorsteht: dessen Adresse(n) oder `private_ranges`. Leer lassen, wenn Caddy der öffentliche Eingang ist.                     | `private_ranges`              |
| `POSTGRES_USER`                                                                 | vorbelegt                 | Datenbank-Benutzer.                                                                                                                                               | `tix`                         |
| `POSTGRES_PASSWORD`                                                             | **ja**                    | Datenbank-Passwort (nur Buchstaben und Ziffern).                                                                                                                  | `3f9a…` (48 Hex-Zeichen)      |
| `POSTGRES_DB`                                                                   | vorbelegt                 | Datenbankname.                                                                                                                                                    | `tix`                         |
| `POSTGRES_MAX_CONNECTIONS`, `WEB_DATABASE_POOL_MAX`, `WORKER_DATABASE_POOL_MAX` | optional (auskommentiert) | Verbindungs-Tuning für große Vorverkäufe. Die Standardwerte passen für Vereine.                                                                                   | `200`, `40`, `10`             |
| `REDIS_PASSWORD`                                                                | **ja**                    | Redis-Passwort (nur Buchstaben und Ziffern).                                                                                                                      | `b71c…`                       |
| `REDIS_MAXMEMORY`                                                               | vorbelegt                 | Speicherlimit von Redis. Sitzsperren werden nie verdrängt.                                                                                                        | `1gb`                         |
| `REDIS_KEY_PREFIX`                                                              | vorbelegt                 | Präfix aller Redis-Schlüssel.                                                                                                                                     | `tix`                         |
| `MINIO_ROOT_USER`                                                               | vorbelegt                 | Admin-Benutzer des mitgelieferten Dateispeichers (MinIO).                                                                                                         | `minio-admin`                 |
| `MINIO_ROOT_PASSWORD`                                                           | **ja**                    | Dessen Passwort (nur Buchstaben und Ziffern).                                                                                                                     | `9d2e…`                       |
| `S3_REGION`                                                                     | vorbelegt                 | Name der Speicher-Region; beim mitgelieferten MinIO nicht ändern.                                                                                                 | `us-east-1`                   |
| `S3_ACCESS_KEY_ID`                                                              | vorbelegt                 | Zugriffsschlüssel, den die Anwendung für den Speicher nutzt.                                                                                                      | `tix-app`                     |
| `S3_SECRET_ACCESS_KEY`                                                          | **ja**                    | Dessen Geheimnis (nur Buchstaben und Ziffern).                                                                                                                    | `a05f…`                       |
| `S3_BUCKET_ASSETS`, `S3_BUCKET_DOCUMENTS`, `S3_BUCKET_BACKUPS`                  | vorbelegt                 | Namen der drei Buckets (Bilder, Dokumente/PDFs, Backups).                                                                                                         | `tix-assets` …                |
| `APP_ENCRYPTION_KEYS`                                                           | **ja**                    | Schlüsselring: `id:base64key`, 32 Zufallsbytes in Base64 (44 Zeichen, endet auf `=`). Mehrere Schlüssel mit Komma getrennt; der erste verschlüsselt. **Sichern!** | `k1:Zm9v…YmFy=`               |
| `SESSION_SECRET`                                                                | **ja**                    | Zufallstext mit mindestens 32 Zeichen für signierte Cookies.                                                                                                      | `e4b8…` (64 Hex-Zeichen)      |
| `WORKER_CONCURRENCY`                                                            | vorbelegt                 | Parallele Hintergrundjobs (Mail, PDFs).                                                                                                                           | `8`                           |

Maßgeblich ist die heruntergeladene `.env`: Ihre Kommentare erklären noch mehr. Absichtlich nicht
aufgeführt sind Extras für Spezialfälle (`MINIO_IMAGE`, `MC_IMAGE`).

## Schritt 4: HTTPS-Variante wählen

Besucher müssen HTTPS benutzen. Wähle **eine** Variante.

| Variante | Nimm sie, wenn …                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------ |
| A        | der Server nur für TIX da ist und die Ports 80 und 443 frei sind. **Am einfachsten, empfohlen.** |
| B        | auf dem Server schon **Traefik** auf den Ports 80/443 läuft.                                     |
| C        | auf dem Server schon **nginx** direkt auf dem Host läuft.                                        |
| D        | du Nginx Proxy Manager, einen Cloudflare-Tunnel, einen Router oder einen anderen Proxy nutzt.    |

### A: Mitgelieferter Caddy mit automatischem HTTPS (empfohlen)

TIX bringt den Webserver Caddy mit. Er holt und erneuert kostenlose Let's-Encrypt-Zertifikate
selbständig.

1. Richte den DNS-**A**-Eintrag (und **AAAA** bei IPv6) deiner Domain auf den Server ein, **bevor**
   du zum ersten Mal startest. Prüfe auf dem Server: `getent hosts tickets.example.org` zeigt die
   IP-Adresse des Servers.
2. Stelle sicher, dass die Ports 80 und 443 von keinem anderen Programm belegt und in jeder
   Firewall offen sind.
3. Trage in der `.env` ein (Domain ersetzen):

```bash
sed -i \
  -e "s|^PUBLIC_URL=.*|PUBLIC_URL=https://tickets.example.org|" \
  -e "s|^SITE_ADDRESS=.*|SITE_ADDRESS=tickets.example.org|" \
  -e "s|^HTTP_PORT=.*|HTTP_PORT=80|" \
  -e "s|^HTTPS_PORT=.*|HTTPS_PORT=443|" \
  .env
grep -E '^(PUBLIC_URL|SITE_ADDRESS|HTTP_PORT|HTTPS_PORT|TRUSTED_PROXIES)=' .env
```

Lass `TRUSTED_PROXIES` leer. Die Zertifikate liegen im Docker-Volume `caddy-data` und überstehen
Updates. Scheitert der erste Start an falschem DNS, korrigiere DNS und starte erneut mit
`docker compose up -d`. Let's Encrypt begrenzt fehlgeschlagene Versuche (einige pro Stunde und
Domain), starte also nicht in einer Schleife neu; siehe [Fehlersuche](#fehlersuche).

### Fortgeschrittene Varianten: die Datei `docker-compose.override.yml`

Die Varianten B und C ändern, wie der Dienst `proxy` veröffentlicht wird. Das machst du in einer
eigenen Datei `docker-compose.override.yml` im selben Ordner. Docker Compose liest sie
automatisch neben `docker-compose.yml`. Updates ersetzen nur `docker-compose.yml`, deine
Änderungen bleiben also erhalten.

### B: Hinter Traefik

Annahmen: Traefik läuft in Docker, hat einen Entrypoint (hier `websecure`), einen
Zertifikats-Resolver (hier `letsencrypt`) und ein gemeinsames Docker-Netzwerk (hier `traefik`).
Ersetze die Namen durch deine.

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
    # Keinen Host-Port veröffentlichen; Traefik erreicht den Proxy über das Docker-Netzwerk.
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

Der Dienst heißt `proxy` (das ist der mitgelieferte Caddy). Er muss im Netzwerk `default`
bleiben, sonst erreicht er den Shop nicht. WebSockets funktionieren in Traefik ohne Zusatzeinstellung.

`!reset []` braucht Docker Compose **2.24.4 oder neuer** (neuer als das Minimum 2.23.1). Ist dein
Compose älter, lösche die Zeile `ports: !reset []` und setze stattdessen in der `.env`
`HTTP_PORT=127.0.0.1:8081` und `HTTPS_PORT=127.0.0.1:8444`; die Ports sind dann nur vom Server
selbst erreichbar.

### C: Hinter nginx auf dem Host

TIX lauscht nur auf dem Server selbst, auf Port 8080:

`.env`:

```bash
PUBLIC_URL=https://tickets.example.org
SITE_ADDRESS=:80
HTTP_PORT=127.0.0.1:8080
HTTPS_PORT=127.0.0.1:8443
TRUSTED_PROXIES=private_ranges
```

`HTTP_PORT=127.0.0.1:8080` heißt „Port 8080, nur von diesem Server aus erreichbar". Dafür brauchst
du keine Override-Datei. Lege dann eine nginx-Site an (zum Beispiel
`/etc/nginx/sites-available/tickets.example.org`, dann nach `sites-enabled` verlinken). Das
Zertifikat holst du wie gewohnt (zum Beispiel `certbot --nginx -d tickets.example.org`).

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

    # ssl_certificate / ssl_certificate_key: von certbot oder deinen eigenen Pfaden

    client_max_body_size 50m;   # Uploads: Bilder, Plan-Hintergründe, APK (eine APK hat etwa 25 MB)

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    # Live-Platzupdates (WebSocket)
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

Testen und neu laden: `sudo nginx -t && sudo systemctl reload nginx`.

### D: Nginx Proxy Manager, Tunnel, andere Proxys

Jeder Proxy funktioniert, wenn er Folgendes tut:

1. `.env`: `PUBLIC_URL=https://tickets.example.org`, `SITE_ADDRESS=:80`, `HTTP_PORT=8080`
   (oder `127.0.0.1:8080`, wenn der Proxy auf demselben Server läuft), `TRUSTED_PROXIES=` die
   Adresse des Proxys (zum Beispiel `192.168.1.10`, ein Netz wie `192.168.1.0/24` oder
   `private_ranges`). Die IP-basierten Limits (Einstellungen → Kasse: Bestellungen bzw.
   Platzauswahlen pro IP-Adresse) hängen davon ab: Ohne diese Angabe erscheinen alle Besucher mit
   der Adresse des Proxys und teilen sich ein Limit. Das Bestell-Limit pro IP-Adresse ist
   standardmäßig aus, das Limit für Platzauswahlen (600 pro Minute) standardmäßig an. Aktiviere
   das Bestell-Limit nur, wenn Einstellungen → Kasse unter „Erkannte IP deiner aktuellen Anfrage“
   deine echte Adresse zeigt.
2. `https://tickets.example.org` weiterleiten an `http://<Server-IP>:8080`, Schema **http**.
3. **WebSockets müssen aktiviert sein.** Im Nginx Proxy Manager setze am Proxy-Host den Haken bei
   **Websockets Support**. Ohne ihn aktualisiert sich der Sitzplan nicht live.
4. Der Proxy muss den ursprünglichen `Host`-Header weitergeben und `X-Forwarded-For` setzen (NPM
   macht das standardmäßig). Stelle die maximale Upload-Größe auf mindestens 50 MB, falls der Proxy
   ein Limit hat.
5. In NPM beantragst du das Zertifikat im Reiter **SSL** und setzt „Force SSL".

Läuft der Proxy in Docker auf demselben Server, kannst du auch wie in Variante B ein gemeinsames
Docker-Netzwerk nutzen und an `proxy:80` weiterleiten.

## Schritt 5: Starten und ersten Admin anlegen

```bash
docker compose up -d
```

Beim ersten Start werden die Images geladen (einige hundert MB); das dauert ein bis drei Minuten.
`docker compose up -d` kann dabei mehrere Minuten lang nichts anzeigen: Warte ab oder führe vorher
`docker compose pull` aus, um den Download-Fortschritt zu sehen. Fortschritt prüfen:

```bash
docker compose ps
```

Alle Dienste sollten `running` oder `healthy` sein. `minio-init` und `migrate` zeigen
`exited (0)`: Das ist richtig, es sind Einmal-Jobs. Bleibt etwas `unhealthy`, siehe
[Fehlersuche](#fehlersuche).

Lege den ersten Administrator an (nimm deine eigene E-Mail-Adresse und deinen Namen):

```bash
docker compose run --rm migrate node dist/create-admin.mjs --email du@example.org --name "Dein Name"
```

Der Befehl zeigt **einmalig ein Passwort** an. Kopiere es. Öffne dann
`https://tickets.example.org/admin`, melde dich an und ändere das Passwort.

**Schalte jetzt die Zwei-Faktor-Authentifizierung ein:** Klicke im Admin unten links auf deinen Namen (dein Konto) und
richte dort die Authenticator-App (TOTP) ein. Unter **Einstellungen → Sicherheit** kannst
du sie für alle Admins verpflichtend machen.

Schneller Gesundheitscheck vom Server aus: `curl -fsS https://tickets.example.org/api/health`.

## Schritt 6: Erste Einrichtung im Admin-Bereich

Arbeite diese Liste im Admin-Bereich ab. Alles findest du in den Menüpunkten links.

1. **Einstellungen → Veranstalter:** Name, Adresse, Impressums- und Datenschutz-Links, Kontakt.
   Sie erscheinen im Shop und auf Rechnungen.
2. **Einstellungen → E-Mail:** SMTP-Host, Port, Benutzer und Passwort eintragen. Klicke auf
   **Test-E-Mail senden**. Mach erst weiter, wenn sie ankommt.
3. **Einstellungen → Zahlungen:** Aktiviere die gewünschten Zahlarten.
   - _PayPal:_ Beginne mit **Sandbox** (der Reiter enthält eine Schritt-für-Schritt-Anleitung),
     teste eine Bestellung, wechsle dann auf Live.
   - _Vorkasse:_ Zahlungsfristen eintragen, dann unter **Bank & Zahlungen → Konten & Verbindungen**
     dein Empfangskonto anlegen und als **Standard** markieren. Solange kein Standardkonto
     existiert, zeigt der Checkout Vorkasse als „Derzeit nicht verfügbar" an. PayPal ebenso, bis
     die Zugangsdaten gespeichert und PayPal aktiviert ist.
4. **Gebühren & Steuern:** Steuersätze (zum Beispiel 7 %, 19 % oder steuerfrei) und Servicegebühren.
5. **Einstellungen → Kasse und Rechnungen:** Limits pro Bestellung, Reservierungszeit, Rechnungsdaten.
6. **Spielstätten & Pläne:** Lege deine Spielstätte an und zeichne den Sitzplan (oder importiere eine Plandatei).
7. **Veranstaltungen:** Lege eine Veranstaltung an, wähle den Plan, richte Kategorien, Preise und
   Tarife sowie den Vorverkaufsstart ein. Lass sie im Entwurf, bis alles geprüft ist.
8. **Ticket-Designs** und **E-Mail-Vorlagen:** Hintergrund hochladen, Texte anpassen, Test senden.
9. **Einstellungen → Scanner:** Trage als **Server-URL** deine öffentliche Adresse ein
   (`https://tickets.example.org`). Bleibt sie leer oder ist sie falsch, zeigt der Kopplungs-QR-Code
   für die Handys auf die falsche Adresse („localhost").
10. **Sicherungen:** Plane regelmäßige Backups und richte ein **externes S3-Ziel** ein (anderer Anbieter
    oder anderer Server). Ein Backup auf demselben Server hilft nicht, wenn der Server verloren geht.
    Siehe [BACKUP.md](BACKUP.md) (Englisch).
11. **Gib eine Testbestellung auf**, komplett (PayPal-Sandbox oder Vorkasse), öffne das Ticket-PDF
    und scanne es mit der App, bevor du echt verkaufst.

## Check-in-Handys

1. Lade auf der Release-Seite `tix-checkin-<Version>.apk` herunter
   (<https://github.com/Renthner/tix-platform/releases>).
2. Öffne sie auf dem Android-8+-Handy und erlaube die **Installation aus dieser Quelle**, wenn
   Android fragt.
3. Öffne im Admin **Einlass-Geräte**, erzeuge einen Kopplungscode für die Veranstaltungen und
   scanne den QR-Code in der App.
4. Wähle in der App die Veranstaltung und lade die Ticketdaten **vor** dem Einlass herunter, damit
   das Scannen auch ohne Netz funktioniert.

Stolpersteine:

- Die Handys müssen `PUBLIC_URL` erreichen können. Bei Heim- oder Vereinsroutern ist die öffentliche
  Adresse des Servers aus demselben WLAN manchmal nicht erreichbar („Hairpin NAT"). Teste, indem du
  `PUBLIC_URL` im Browser des Handys im WLAN des Veranstaltungsorts öffnest.
- Reines `http://` wird nur für private Adressen wie `http://192.168.1.20:8080` akzeptiert. Jede
  öffentliche Adresse braucht `https://`.
- Einstellungen → Scanner → Server-URL muss die Adresse sein, die die **Handys** erreichen.
- Die App aktualisiert sich immer genau auf die Version, die dein Server gerade betreibt (über GitHub
  Releases). Im Admin kannst du auf Updates von deinem eigenen Server umstellen.

Mehr dazu: [SCANNER.md](SCANNER.md) und [apps/android/README.md](../apps/android/README.md)
(Englisch).

## Updates, Backups, Deinstallation

### Updates

1. **Mach ein Backup** (Admin → Sicherungen). Datenbankänderungen eines Updates lassen sich nicht
   zurückrollen (Vorabversionen können sie enthalten).
2. Lies das [CHANGELOG](../CHANGELOG.md) der neuen Version (Englisch). Steht dort, dass sich die
   Compose-Datei geändert hat, lade die neue `docker-compose.yml` dieses Releases herunter (behalte
   deine `.env` und deine `docker-compose.override.yml`).
3. Aktualisiere:

```bash
cd tix
docker compose pull
docker compose up -d
```

Datenbank-Migrationen laufen automatisch. Die laufende Version steht in der Admin-Seitenleiste und
unter `/api/health`.

**Die Version wählst du mit `TIX_CHANNEL` in der `.env`:**

| Wert                     | Folgt                                               | Einsatz                                                                          |
| ------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `next`                   | dem neuesten Release jeder Art, auch Vorabversionen | Tests und Demos; heute die einzige Wahl, weil es noch kein stabiles Release gibt |
| `stable`                 | dem neuesten stabilen Release                       | Produktion (ab 1.0.0)                                                            |
| `1` oder `1.0`           | dem neuesten stabilen Release dieser Linie          | Produktion ohne Überraschungen                                                   |
| `1.0.0-alpha.3`, `1.0.0` | genau dieser Version                                | Festnageln, Zurückrollen                                                         |

Zum Zurückrollen setzt du eine genaue frühere Version und führst die Update-Befehle aus. Das geht
nur, wenn das Datenbankschema unverändert ist; sonst spiele das Backup von vor dem Update ein.

Nutze keine automatischen Updater (Watchtower u. ä.): Updates sollen bewusst passieren.

### Backups und Wiederherstellung

Nutze **Admin → Sicherungen**: Datenbank und Dateien, zeitgesteuert, mit optionalem externem S3-Ziel.
Die Wiederherstellung findest du am selben Ort (nur SUPER_ADMIN). Details: [BACKUP.md](BACKUP.md)
(Englisch). Bewahre außerhalb des Servers auf:

- `APP_ENCRYPTION_KEYS` (und die ganze `.env`),
- das externe Backup-Ziel.

Die Daten liegen in Docker-Volumes des Projekts `tix`: `tix_postgres-data`, `tix_redis-data`,
`tix_minio-data`, `tix_caddy-data`. Mit `docker volume ls` siehst du sie.

### Deinstallation

```bash
cd tix
docker compose down        # stoppt und entfernt die Container, BEHÄLT deine Daten
docker compose down -v     # LÖSCHT zusätzlich alle Daten (Datenbank, Dateien, Zertifikate) - unwiderruflich
```

## Fehlersuche

Nützliche Befehle (im Ordner `tix` ausführen):

```bash
docker compose ps                     # Zustand aller Dienste
docker compose logs --tail 100 web    # letzte Logzeilen eines Dienstes
docker compose logs -f proxy          # Log live mitlesen (Strg+C beendet)
docker compose logs minio-init migrate
curl -fsS http://localhost:8080/api/health   # nur wenn HTTP_PORT auf diesem Server 8080 ist
```

`web`, `worker` und `realtime` schreiben pro Logzeile ein JSON-Objekt. Fehler haben
`"level":50`, Warnungen `"level":40`: `docker compose logs web | grep '"level":50'`. Mit `LOG_LEVEL`
in der `.env` (`error`, `warn`, `info`, `debug`; Standard `info`) lässt sich die Ausführlichkeit
ändern. Logzeilen zu einer Anfrage enthalten eine `reqId`, die dem vom mitgelieferten Proxy
gesetzten `X-Request-Id` entspricht.

Dienstnamen: `web`, `worker`, `realtime`, `proxy`, `postgres`, `redis`, `minio`, `minio-init`,
`migrate`.

| Symptom                                                                               | Ursache                                                                                                              | Lösung                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fehler mit `configs.content`, „unknown key" oder „additional property"                | Docker Compose ist älter als 2.23.1                                                                                  | Docker aus dem offiziellen Repository installieren (Schritt 1). `docker compose version` muss 2.23.1 oder neuer zeigen.                                                                                                                                                                                     |
| `manifest unknown` / `not found` beim Laden von `...:stable`                          | Es gibt noch kein stabiles Release, das Image-Tag `stable` existiert nicht                                           | In der `.env` `TIX_CHANNEL=next` (oder eine genaue Version wie `1.0.0-alpha.3`) setzen, dann `docker compose pull && docker compose up -d`.                                                                                                                                                                 |
| `required variable ... is missing a value` / `set POSTGRES_PASSWORD in .env`          | Die Variable ist leer oder fehlt, oder die `.env` liegt nicht im aktuellen Ordner                                    | Den Befehl im Ordner `tix` ausführen, prüfen, dass die Datei `.env` heißt (nicht `env.example`) und die genannte Variable ausfüllen.                                                                                                                                                                        |
| Fehler wie `password authentication failed`, `invalid URL`, Redis `WRONGPASS`         | Ein Passwort enthält Sonderzeichen (`@ : / # ? %`) oder Anführungszeichen, oder wurde nach dem ersten Start geändert | Nur Buchstaben und Ziffern, keine Anführungszeichen. Das Datenbankpasswort wird beim Anlegen des Daten-Volumes festgelegt: Eine spätere Änderung von `POSTGRES_PASSWORD` braucht bei einer frischen Installation `docker compose down -v` (löscht Daten) oder eine manuelle Passwortänderung in PostgreSQL. |
| Browser zeigt eine Zertifikatswarnung oder kein HTTPS                                 | Caddy bekam kein Zertifikat: DNS falsch, Ports 80/443 gesperrt oder Let's-Encrypt-Limit                              | `docker compose logs proxy`. Prüfen: Domain zeigt auf diesen Server, Ports 80 und 443 offen (auch Hoster-Firewall), `SITE_ADDRESS` ist nur die Domain (ohne `https://`). Bei Rate-Limit-Meldung eine Stunde warten.                                                                                         |
| `port is already allocated` / `address already in use` auf Port 80 oder 443           | Ein anderer Webserver (apache2, nginx) belegt den Port                                                               | Ihn stoppen (`sudo systemctl disable --now apache2`) oder Variante B/C/D nutzen. `sudo ss -ltnp \| grep -E ':80 \|:443 '` zeigt, wer den Port belegt.                                                                                                                                                       |
| Firewall (ufw) ist an, aber ein Port ist trotzdem erreichbar                          | Docker veröffentlicht Ports direkt und umgeht ufw-Regeln                                                             | Nur der Proxy veröffentlicht Ports (80/443 oder dein `HTTP_PORT`). Soll ein Port privat bleiben, binde ihn an `127.0.0.1` (`HTTP_PORT=127.0.0.1:8080`). Verlasse dich bei Docker-Ports nicht allein auf ufw.                                                                                                |
| Plätze aktualisieren sich nicht live; die Browser-Konsole zeigt WebSocket-Fehler      | Dein Reverse-Proxy leitet WebSockets für `/socket.io` nicht weiter                                                   | Variante C: den `/socket.io/`-Block oben verwenden. NPM: Websockets Support aktivieren. Cloudflare: WebSockets müssen an sein.                                                                                                                                                                              |
| Alle bekommen „zu viele Anfragen", oder das Audit-Log zeigt für alle Besucher eine IP | Ein anderer Proxy steht davor, aber `TRUSTED_PROXIES` ist leer                                                       | `TRUSTED_PROXIES` auf die Adresse des Proxys oder `private_ranges` setzen, dann `docker compose up -d`. Leer lassen, wenn Caddy der öffentliche Eingang ist.                                                                                                                                                |
| Handy lässt sich nicht koppeln, meldet „Serveradresse nicht erlaubt"                  | `http://` mit öffentlicher Adresse oder falsche Server-URL                                                           | `https://` verwenden. `http://` geht nur für private IPs. Einstellungen → Scanner → Server-URL prüfen.                                                                                                                                                                                                      |
| Handy lässt sich nicht koppeln, keine Verbindung oder Zeitüberschreitung              | Das Handy erreicht `PUBLIC_URL` nicht (Hairpin NAT, VPN, falsche URL)                                                | `PUBLIC_URL` im Browser des Handys im selben WLAN öffnen. Klappt das nicht: mobile Daten nutzen oder den Router beheben (NAT-Loopback / lokales DNS).                                                                                                                                                       |
| Der Kopplungs-QR-Code enthält `localhost`                                             | Die Scanner-Server-URL ist nicht gesetzt                                                                             | Einstellungen → Scanner → Server-URL auf `PUBLIC_URL` setzen.                                                                                                                                                                                                                                               |
| Es kommen keine E-Mails an                                                            | Falsche SMTP-Daten, gesperrter Port, Spam-Ordner                                                                     | Einstellungen → E-Mail → **Test-E-Mail senden** zeigt den Fehler. Port 587 (STARTTLS) oder 465 (TLS) probieren; `docker compose logs worker`.                                                                                                                                                               |
| Backups oder gespeicherte Geheimnisse lassen sich auf einem neuen Server nicht lesen  | `APP_ENCRYPTION_KEYS` weicht vom alten Server ab                                                                     | Die ursprüngliche Schlüsselzeile aus deinem Passwortmanager verwenden. Ohne sie sind die verschlüsselten Daten nicht zu retten; deshalb sicherst du sie.                                                                                                                                                    |
| `minio-init` endete mit Fehlercode, `web` startet nie                                 | MinIO-Zugangsdaten in der `.env` passen nicht zu den gespeicherten, oder MinIO ist nicht gesund                      | `docker compose logs minio minio-init`. `MINIO_ROOT_PASSWORD` und `S3_SECRET_ACCESS_KEY` nach dem ersten Start nicht ändern (frische Installation: `docker compose down -v`, `.env` korrigieren, neu starten).                                                                                              |
| Ein Dienst ist `unhealthy`                                                            | Start läuft noch, oder ein Konfigurationsfehler                                                                      | Zwei Minuten warten. Dann `docker compose logs --tail 100 <Dienst>`. Der Web-Check ist `GET /api/health` (meldet PostgreSQL, Redis und Worker).                                                                                                                                                             |
| Checkout zeigt Vorkasse oder PayPal als „Derzeit nicht verfügbar"                     | Es gibt kein Standard-Empfangskonto (Vorkasse) oder PayPal ist nicht konfiguriert/aktiviert                          | Bank & Zahlungen → Konten & Verbindungen: Konto anlegen und als Standard markieren. PayPal: Einstellungen → Zahlungen.                                                                                                                                                                                      |
| Admin-Login meldet „Zu viele Versuche"                                                | Mehr als 10 Fehlversuche pro E-Mail-Adresse oder 20 pro IP-Adresse in 15 Minuten (auch durch Skripte/Tests)          | Bis zu 15 Minuten warten; die Sperre läuft von selbst ab. Passwort vergessen: `docker compose run --rm migrate node dist/create-admin.mjs --email du@example.org --reset` gibt ein neues Passwort aus (Rollen bleiben).                                                                                     |
| `docker compose up` / `pull` zeigt minutenlang nichts                                 | Die Images werden noch geladen                                                                                       | Warten oder `docker compose pull` separat ausführen, um den Fortschritt zu sehen.                                                                                                                                                                                                                           |
| Die Seite zeigt lange „Wartung"                                                       | Eine Backup-Wiederherstellung läuft                                                                                  | Abwarten; `docker compose logs web worker` ansehen.                                                                                                                                                                                                                                                         |

Kommst du nicht weiter, eröffne ein [Issue](https://github.com/Renthner/tix-platform/issues/new/choose)
mit der Ausgabe von `docker compose ps` und den relevanten Logzeilen. **Entferne Passwörter und
Schlüssel, bevor du Logs postest.**
