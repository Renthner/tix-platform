# TIX auf deinem eigenen Server installieren

[English](INSTALL.md) | Deutsch

Diese Anleitung hat zwei Teile. **Teil 1** bringt einen Ticketshop in etwa 15 Minuten zum Laufen:
Du kopierst ein paar Befehle und musst **kein** Docker-Experte sein. **Teil 2** ist der Anhang für
Sonderfälle (anderer Reverse-Proxy, Cloudflare), die vollständige Variablenübersicht, Monitoring
und Fehlersuche.

> TIX ist derzeit eine Vorabversion (Version siehe unten). Wo diese Anleitung „das neueste Release"
> sagt, nimm die Version von der [Release-Seite](https://github.com/Renthner/tix-platform/releases).

**Was läuft:** ein `tix`-Container (Shop, Admin, Realtime-Gateway und Hintergrund-Worker),
PostgreSQL und Redis. Der `tix`-Container spricht **Klartext-HTTP** auf Port 8080; HTTPS erledigt ein
Reverse-Proxy, den du davorsetzt (der Schnellstart ergänzt dafür Caddy mit zwei kleinen Dateien).
Dateien (Uploads, Rechnungen, Tickets, lokale Backups) liegen im Docker-Volume `tix-data`.

> **Du betreibst schon ein älteres Release** mit `tix-web` / `tix-worker` / `tix-realtime`,
> mitgeliefertem Caddy und MinIO? Ersetze deine Compose-Datei **nicht**, sondern folge
> [MIGRATE-SINGLE-IMAGE.de.md](MIGRATE-SINGLE-IMAGE.de.md). Deine Daten bleiben, wo sie sind.

## Teil 1: Schnellstart

### Was du brauchst

| Was              | Details                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Ein Linux-Server | Debian oder Ubuntu, `linux/amd64` oder `linux/arm64`, root oder `sudo`. 2 vCPU, 4 GB RAM und 20 GB Platte reichen für einen Verein.   |
| Docker           | Docker Engine **und** Docker Compose **ab 2.23.1** (`docker compose version`). Fehlt es: [Docker installieren](#docker-installieren). |
| Ein Domainname   | Zum Beispiel `tickets.example.org`, mit einem **A**-Eintrag (und **AAAA** für IPv6) auf den Server, **bevor** du startest.            |
| Offene Ports     | **80** und **443** aus dem Internet erreichbar (auch in der Firewall deines Hosters).                                                 |
| Ein SMTP-Konto   | Für Bestell-E-Mails und Tickets (Host, Port, Benutzer, Passwort). Du trägst es später im Admin-Bereich ein.                           |

Alles Fachliche (Preise, Gebühren, Bank, SMTP, PayPal, Gestaltung) trägst du im Admin-Bereich ein.
Die `.env`-Datei enthält nur die wenigen technischen Einstellungen.

### 1. Die zwei Dateien herunterladen

```bash
export TIX_VERSION=1.0.0-alpha.29
mkdir tix && cd tix
curl -fLO https://github.com/Renthner/tix-platform/releases/download/v$TIX_VERSION/docker-compose.yml
curl -fLO https://github.com/Renthner/tix-platform/releases/download/v$TIX_VERSION/env.example
mv env.example .env
```

Arbeite für alle `docker compose`-Befehle immer in diesem Ordner (`cd tix`). Sobald es ein
stabiles `1.0.0` gibt, kannst du stattdessen
`https://github.com/Renthner/tix-platform/releases/latest/download/<Datei>` verwenden; bis dahin
gibt diese Adresse einen Fehler 404.

### 2. Die `.env`-Datei ausfüllen

Ersetze die Domain in der ersten Zeile und füge den ganzen Block ein (er braucht `openssl`, das
Debian und Ubuntu haben; [ohne openssl](#die-env-datei-im-detail)). Er setzt deine Adresse und das
Datenbank-Passwort und erzeugt den Verschlüsselungsschlüssel:

```bash
DOMAIN=tickets.example.org   # <- deine Domain
KEYLINE=$(docker run --rm ghcr.io/renthner/tix:$TIX_VERSION keygen)
sed -i \
  -e "s|^APP_URL=.*|APP_URL=https://$DOMAIN|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" \
  -e "s|^APP_ENCRYPTION_KEYS=.*|$KEYLINE|" \
  -e "s|^# *HTTP_PORT=.*|HTTP_PORT=127.0.0.1:8081|" \
  -e "s|^# *TRUSTED_PROXIES=.*|TRUSTED_PROXIES=private_ranges|" \
  .env
unset TIX_VERSION            # die Version des Servers steht als TIX_VERSION in der .env
grep -E '^(APP_URL|POSTGRES_PASSWORD|APP_ENCRYPTION_KEYS|TIX_VERSION|HTTP_PORT|TRUSTED_PROXIES)=' .env
```

Kein Wert darf noch `change-me` oder `REPLACE_WITH` enthalten. `HTTP_PORT=127.0.0.1:8081` macht den Shop
nur vom Server selbst erreichbar: Besucher kommen über Caddy (nächster Schritt).
`TRUSTED_PROXIES=private_ranges` sagt TIX, dass dem Proxy davor (Caddy im Docker-Netz) zu glauben ist,
wenn er die Adresse des Besuchers meldet.

> **`TRUSTED_PROXIES` nicht auslassen.** Bleibt es leer, vertraut TIX niemandem und sieht für jeden
> Besucher die Adresse deines Proxys: Die Ratenbegrenzungen (Bestellungen und Sitzplatzwahlen je Adresse)
> und das Audit-Log behandeln dann **alle Besucher als einen**. Steht irgendein Proxy davor, trage ihn
> dort ein ([Details](#trusted_proxies-und-die-besucheradresse)).

**Sichere jetzt die Zeile `APP_ENCRYPTION_KEYS`:** Kopiere sie in deinen Passwortmanager, außerhalb des
Servers. Sie verschlüsselt gespeicherte Geheimnisse (Bank-PINs, API-Schlüssel, Ticket-Signaturschlüssel)
und deine Backups; ohne sie ist beides nicht wiederherstellbar, **auch nicht auf einem anderen Server**.
Ändere oder lösche nie einen Schlüssel, der in Benutzung ist.

### 3. HTTPS mit Caddy

Caddy holt und erneuert das kostenlose Let's-Encrypt-Zertifikat selbst. Lege zwei Dateien neben die
`docker-compose.yml` (nimm in der ersten deine Domain):

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

`docker-compose.override.yml` wird automatisch neben der `docker-compose.yml` gelesen; Updates ersetzen
nur die `docker-compose.yml`, die Datei bleibt also erhalten. Läuft auf dem Server schon Traefik, nginx
oder Nginx Proxy Manager? Dann überspring diesen Schritt und nimm einen
[anderen Reverse-Proxy](#https-varianten).

### 4. Starten

```bash
docker compose up -d
```

Der erste Start lädt die Images (einige hundert MB) und dauert ein bis drei Minuten;
`docker compose up -d` zeigt dabei evtl. keine Ausgabe. Prüfe mit `docker compose ps`: Alle Dienste
sollten `running` oder `healthy` sein (`tix` ist `healthy`, sobald die Migrationen gelaufen sind).
Kann das HTTPS-Zertifikat nicht ausgestellt werden, stimmt meist das DNS: siehe
[Fehlersuche](#fehlersuche).

Lege den ersten Administrator an (deine eigene E-Mail-Adresse und Name):

```bash
docker compose run --rm tix create-admin --email du@example.org --name "Dein Name"
```

Der Befehl zeigt **einmalig ein Passwort** an. Kopiere es.

### 5. Den Admin-Bereich öffnen

Öffne `https://tickets.example.org/admin`, melde dich an und ändere das Passwort. Schalte die
Zwei-Faktor-Authentifizierung ein (Klick auf deinen Namen unten links im Admin-Menü; unter
**Einstellungen → Sicherheit** kannst du sie verpflichtend machen). Das Dashboard zeigt dann eine
**Einrichtungs-Checkliste**, die dich durch die ersten Schritte führt: Veranstalterdaten, SMTP (mit
Test-E-Mail), Zahlungsarten, Steuern und Gebühren, Veranstaltungsort und Veranstaltung,
Scanner-URL und Backups. Dieselbe Liste mit Erklärungen steht unter
[Erste Einrichtung im Admin-Bereich](#erste-einrichtung-im-admin-bereich).

### Updates und Backups

```bash
cd tix
export TIX_VERSION=1.0.0-alpha.29
curl -fLO https://github.com/Renthner/tix-platform/releases/download/v$TIX_VERSION/tix-update.sh
chmod +x tix-update.sh        # einmalig; das Skript gehört zu jedem Release
unset TIX_VERSION
./tix-update.sh               # aktualisiert auf das neueste Release deines Kanals TIX_VERSION
```

Das Skript lädt die `docker-compose.yml` des Ziel-Releases und prüft ihre Prüfsumme, behält eine Kopie
deiner aktuellen Datei mit Zeitstempel, lädt das Image und startet den Stack neu. Es fasst `.env`
und `docker-compose.override.yml` nie an; `./tix-update.sh --dry-run` zeigt nur, was sich ändern würde.
Datenbank-Migrationen laufen automatisch, und **bevor ein Update eine bestehende Datenbank verändert,
wird automatisch ein Datenbank-Backup erstellt** (Admin → Backups, „Vor dem Update"). Details,
Versionen und warum ein Zurückgehen nicht unterstützt wird:
[Updates, Backups, Deinstallation](#updates-backups-deinstallation). Backups (Datenbank und Dateien,
zeitgesteuert, optional auf ein externes S3-Ziel) findest du im Admin unter **Backups**:
[BACKUP.md](BACKUP.md). **Ohne externes Ziel liegen die Backups im selben Volume wie die Dateien: Sie
überstehen ein Update, aber nicht den Verlust der Platte. Bewahre `APP_ENCRYPTION_KEYS` und ein
externes Backup-Ziel außerhalb des Servers auf.**

Du läufst hinter Traefik, nginx, Nginx Proxy Manager, einem Tunnel oder Cloudflare statt hinter Caddy?
Siehe [HTTPS-Varianten](#https-varianten) in Teil 2.

---

## Teil 2: Fortgeschritten (Anhang)

1. [Docker installieren](#docker-installieren)
2. [Die `.env`-Datei im Detail](#die-env-datei-im-detail)
3. [HTTPS-Varianten](#https-varianten): eigener Reverse-Proxy (Caddy, Traefik, nginx, Nginx Proxy Manager, Tunnel), `TRUSTED_PROXIES`, Cloudflare
4. [Erste Einrichtung im Admin-Bereich](#erste-einrichtung-im-admin-bereich)
5. [Check-in-Handys](#check-in-handys)
6. [Updates, Backups, Deinstallation](#updates-backups-deinstallation)
7. [Monitoring](#monitoring)
8. [Alle Variablen](#alle-variablen)
9. [Fehlersuche](#fehlersuche)

## Docker installieren

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

## Die `.env`-Datei im Detail

Der Schnellstart füllt die `.env`-Datei mit einem Befehl aus. Dieser Abschnitt erklärt die Regeln und
die Alternativen. Maßgeblich ist die heruntergeladene Datei: Ihre Kommentare erklären jeden Eintrag, und
die Liste aller Variablen steht unter [Alle Variablen](#alle-variablen). Regeln:

- Ein `SCHLÜSSEL=Wert` pro Zeile. **Keine Anführungszeichen**, keine Leerzeichen um `=`.
- Das Datenbank-Passwort steckt in einer Verbindungs-URL. Nimm **nur Buchstaben und Ziffern** (Hex-Text
  ist ideal). Zeichen wie `@ : / # ? %` brechen die Verbindung und führen zu verwirrenden Fehlern.

Nur drei Werte sind Pflicht: `APP_URL`, `POSTGRES_PASSWORD`, `APP_ENCRYPTION_KEYS` (dazu das
vorbelegte `TIX_VERSION`). `SESSION_SECRET` ist optional: Ohne ihn erzeugt der Container einen und legt
ihn im Volume `tix-data` ab (`/data/secrets`).

### Ohne `openssl`

Führe jeden Befehl einmal aus und füge die Ausgabe mit einem Editor (`nano .env`) in die `.env` ein:

```bash
# das Datenbank-Passwort (hex)
docker run --rm alpine sh -c "head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; echo"
# APP_ENCRYPTION_KEYS (gibt die ganze Zeile aus, mit APP_ENCRYPTION_KEYS=k3fa9c1:...)
docker run --rm ghcr.io/renthner/tix:next keygen
```

### `APP_ENCRYPTION_KEYS` jetzt sichern

`APP_ENCRYPTION_KEYS` verschlüsselt gespeicherte Geheimnisse (Bank-PINs, API-Schlüssel,
Ticket-Signaturschlüssel) und deine Backups. **Kopiere diese eine Zeile in deinen Passwortmanager,
außerhalb des Servers.** Stirbt der Server und du hast den Schlüssel nicht, sind Backups und
gespeicherte Geheimnisse nicht wiederherstellbar; ein Backup, das du auf einem **anderen System**
zurückspielst, braucht den Schlüsselbund des Systems, das es erstellt hat. Ändere oder lösche nie
einen Schlüssel, der in Benutzung ist.

### Dateispeicher

Neue Installationen legen Dateien in einem Verzeichnis auf dem Volume `tix-data` ab
(`STORAGE_DIR=/data/storage`): nichts zu konfigurieren. Um stattdessen MinIO oder einen anderen
S3-kompatiblen Dienst zu nutzen, siehe [STORAGE.md](STORAGE.md) und `docker-compose.s3.example.yml` in
`tix-deploy-<Version>.zip` des Releases. Installationen, die schon MinIO betreiben, laufen im S3-Modus
weiter ([MIGRATE-SINGLE-IMAGE.de.md](MIGRATE-SINGLE-IMAGE.de.md)).

### `TRUSTED_PROXIES` und die Besucheradresse

Der `tix`-Container hat einen eingebauten Proxy auf Port 8080, der entscheidet, welche Client-Adresse
der Shop für seine Begrenzungen je Adresse und für das Audit-Log benutzt:

- **`TRUSTED_PROXIES` leer (Standard):** Niemandem wird vertraut. Die Adresse der Verbindung ist der
  Besucher. Das stimmt nur, wenn Besucher direkt auf Port 8080 zugreifen. Hinter **irgendeinem**
  Reverse-Proxy erscheint jeder Besucher mit der Adresse des Proxys: alle teilen sich ein Limit, und das
  Audit-Log zeigt eine IP.
- **`TRUSTED_PROXIES` gesetzt** (durch Leerzeichen getrennte IPs, CIDR-Netze oder das Schlüsselwort
  `private_ranges` für alle privaten Netze, auch Docker-Netze): Kommt die Verbindung von einer dieser
  Adressen, wird die Besucheradresse aus deren `X-Forwarded-For`-Header gelesen (von rechts nach links,
  erfundene Adressen eines Besuchers werden also ignoriert). Verbindungen von anderen Adressen wird nie
  geglaubt.

Trage nur Proxys ein, die du selbst betreibst. Prüfe es im Admin: **Einstellungen → Kasse → „Erkannte IP
deiner aktuellen Anfrage"** muss **deine eigene** öffentliche Adresse zeigen.

Hinter einem TLS-Proxy lautet die Adresse `https://...` und ein Proxy steht **immer** davor. Trage daher
bei `TRUSTED_PROXIES` die **genaue IP oder das CIDR-Netz dieses Proxys** ein (bei einem Proxy-Container: das
Subnetz des gemeinsamen Docker-Netzes) und veröffentliche den Port nur auf der Schnittstelle, die der Proxy
nutzt (zum Beispiel `HTTP_PORT=127.0.0.1:8081`). `private_ranges` funktioniert, aber bei einem veröffentlichten
Port kann Docker Internet-Clients mit einer privaten Adresse ankommen lassen; TIX schreibt dafür beim Start
eine Warnung. Es warnt auch, wenn `APP_URL` mit `https://` beginnt und `TRUSTED_PROXIES` leer ist, oder
wenn jeder Adresse vertraut wird (`0.0.0.0/0`).

### Eingebauter Proxy: Host-Prüfung und Limits

Derselbe eingebaute Proxy schützt sich mit diesen optionalen Variablen (in `.env` setzen; die Vorgaben
passen für die meisten Installationen):

| Variable                       | Vorgabe   | Bedeutung                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TIX_ALLOWED_HOSTS`            | leer      | Zusätzliche Hostnamen (kommagetrennt oder mit Leerzeichen), für die der Shop antwortet. Ist `APP_URL` keine Loopback-Adresse, bekommt eine Anfrage von einer **nicht vertrauten** Adresse mit fremdem `Host` **421**: der direkte Aufruf `http://<Server-IP>:8080` scheitert, außer der Name steht hier oder du setzt `*` (alles erlaubt). Anfragen von einer `TRUSTED_PROXIES`-Adresse werden nie geprüft. |
| `TIX_PROXY_SOCKET_TIMEOUT_MS`  | `120000`  | Inaktivitätslimit je Client-Verbindung (Millisekunden, `0` = keins). Wird bei jedem Byte zurückgesetzt, große Uploads funktionieren also weiter.                                                                                                                                                                                                                                                            |
| `TIX_PROXY_REQUEST_TIMEOUT_MS` | `3600000` | Längste Zeit, um EINE Anfrage samt Body zu empfangen (`0` = unbegrenzt).                                                                                                                                                                                                                                                                                                                                    |
| `TIX_PROXY_MAX_CONNS_PER_IP`   | `200`     | Gleichzeitige Verbindungen je Client-Adresse, die kein vertrauter Proxy ist (`0` = unbegrenzt).                                                                                                                                                                                                                                                                                                             |

Jeder Kindprozess (Web, Worker, Realtime) erhält nur die Secrets, die er braucht: das Realtime-Gateway
bekommt weder die Datenbank-URL noch den Schlüsselbund, und `POSTGRES_PASSWORD` erreicht keinen von ihnen
(sie nutzen `DATABASE_URL`). Realtime-Gateway und Worker-Health-Endpunkt lauschen im Container auf
`127.0.0.1`; von anderen Containern ist nur Port 8080 erreichbar.

## HTTPS-Varianten

Besucher müssen HTTPS benutzen. Der `tix`-Container beendet TLS nicht: Du betreibst einen Reverse-Proxy,
der an `http://<Server>:8080` weiterleitet, **einschließlich WebSockets unter `/socket.io`**, und den
ursprünglichen `Host`-Header durchreicht. Was auch immer du benutzt: Setze `APP_URL` auf die öffentliche
`https://`-Adresse und `TRUSTED_PROXIES` auf den Proxy.

| Variante | Nimm sie, wenn …                                                                              |
| -------- | --------------------------------------------------------------------------------------------- |
| A        | Der Server nur für TIX da ist, Port 80 und 443 frei sind. **Am einfachsten, empfohlen.**      |
| B        | Auf dem Server schon **Traefik** auf Port 80/443 läuft.                                       |
| C        | Auf dem Server schon **nginx** auf dem Host läuft.                                            |
| D        | Du Nginx Proxy Manager, einen Cloudflare Tunnel, einen Router oder einen anderen Proxy nutzt. |

### A: Caddy als zusätzlicher Container (empfohlen)

Das macht der Schnellstart (Schritt 3): eine `Caddyfile` mit
`deine-domain { reverse_proxy tix:8080 }` und der Dienst `caddy` in `docker-compose.override.yml`.
`.env`: `APP_URL=https://tickets.example.org`, `HTTP_PORT=127.0.0.1:8081`,
`TRUSTED_PROXIES=private_ranges`.

1. Richte den DNS-**A**-Eintrag (und **AAAA**, wenn du IPv6 nutzt) deiner Domain **vor** dem ersten Start
   auf den Server. Prüfe vom Server aus: `getent hosts tickets.example.org` zeigt die IP-Adresse des
   Servers.
2. Stelle sicher, dass Port 80 und 443 von keinem anderen Programm benutzt und in jeder Firewall offen
   sind.

Zertifikate liegen im Docker-Volume `caddy-data`; sie überstehen Updates. Schlägt der erste Start fehl,
weil das DNS falsch ist, korrigiere das DNS und führe `docker compose up -d` erneut aus. Let's Encrypt
begrenzt fehlgeschlagene Versuche (einige pro Stunde und Domain), starte also nicht in einer Schleife neu;
siehe [Fehlersuche](#fehlersuche).

### Fortgeschrittene Varianten: die Datei `docker-compose.override.yml`

Die Varianten B und C ändern, wie der Dienst `tix` veröffentlicht wird. Mach das in einer eigenen Datei
namens `docker-compose.override.yml` im selben Ordner. Docker Compose liest sie automatisch neben der
`docker-compose.yml`. Updates ersetzen nur die `docker-compose.yml`, deine Änderungen bleiben also erhalten.

### B: Hinter Traefik

Annahmen: Traefik läuft in Docker, hat einen Entrypoint (hier `websecure`), einen Certificate Resolver
(hier `letsencrypt`) und ein gemeinsames Docker-Netz (hier `traefik`). Ersetze die Namen durch deine.

`.env`:

```bash
APP_URL=https://tickets.example.org
TRUSTED_PROXIES=private_ranges
```

`docker-compose.override.yml`:

```yaml
services:
  tix:
    # Keinen Host-Port veröffentlichen; Traefik erreicht tix über das Docker-Netz.
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

`tix` muss im Netz `default` bleiben, sonst erreicht es PostgreSQL und Redis nicht. WebSockets
funktionieren in Traefik ohne zusätzliche Einstellung.

`!reset []` braucht Docker Compose **2.24.4 oder neuer** (neuer als das Minimum 2.23.1). Ist dein
Compose älter, lösche die Zeile `ports: !reset []` und setze stattdessen in der `.env`
`HTTP_PORT=127.0.0.1:8081`; der Port ist dann nur vom Server selbst erreichbar.

### C: Hinter nginx auf dem Host

TIX soll nur auf dem Server selbst lauschen, auf Port 8080:

`.env`:

```bash
APP_URL=https://tickets.example.org
HTTP_PORT=127.0.0.1:8080
TRUSTED_PROXIES=private_ranges
```

`HTTP_PORT=127.0.0.1:8080` heißt „Port 8080, nur von diesem Server erreichbar". Dafür ist keine
Override-Datei nötig. nginx auf dem Host erreicht den Container über Docker, was als Docker-Gateway-Adresse
(eine private Adresse) ankommt: `private_ranges` deckt sie ab. Lege dann eine nginx-Site an (zum Beispiel
`/etc/nginx/sites-available/tickets.example.org`, dann in `sites-enabled` verlinken). Besorge das
Zertifikat auf deinem üblichen Weg (zum Beispiel `certbot --nginx -d tickets.example.org`).

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

1. `.env`: `APP_URL=https://tickets.example.org`, `HTTP_PORT=8080` (oder `127.0.0.1:8080`, wenn der Proxy
   auf demselben Server läuft), `TRUSTED_PROXIES=` die Adresse des Proxys (zum Beispiel `192.168.1.10`,
   ein Netz wie `192.168.1.0/24` oder `private_ranges`).
   Die IP-basierten Limits (Einstellungen → Kasse: Bestellungen je IP-Adresse, Sitzplatzwahlen je
   IP-Adresse) beruhen darauf: Ohne sie erscheint jeder Besucher mit der Adresse des Proxys und teilt sich
   ein Limit. Das Bestell-Limit je IP-Adresse ist standardmäßig aus; das Limit für Sitzplatzwahlen
   (600 pro Minute) ist standardmäßig an. Aktiviere das Bestell-Limit erst, wenn Einstellungen → Kasse
   deine echte Adresse als „Erkannte IP deiner aktuellen Anfrage" zeigt.
2. Leite `https://tickets.example.org` an `http://<Server-IP>:8080` weiter, Schema **http**.
3. **WebSockets müssen aktiviert sein.** Im Nginx Proxy Manager setze am Proxy-Host den Haken bei
   **Websockets Support**. Ohne ihn aktualisiert sich der Sitzplan nicht live.
4. Der Proxy muss den ursprünglichen `Host`-Header durchreichen und `X-Forwarded-For` setzen. (NPM tut das
   standardmäßig.) Setze die maximale Upload-Größe auf mindestens 50 MB, falls der Proxy ein solches
   Limit hat.
5. Im NPM das Zertifikat auf dem Reiter **SSL** anfordern und „Force SSL" ankreuzen.

Läuft der Proxy in Docker auf demselben Server, kannst du auch ein gemeinsames Docker-Netz wie in
Variante B benutzen und an `tix:8080` weiterleiten.

### Hinter Cloudflare

Cloudflare (orange Wolke) kann vor jeder der obigen Varianten stehen. Die Anfrage läuft dann über
mehrere Stationen:

```text
Besucher -> Cloudflare -> (Port-Weiterleitung im Router) -> Traefik / nginx / Caddy / anderer Proxy -> TIX
```

Jede Station muss der davor vertrauen, sonst sieht die App die Adresse eines Proxys statt die des
Besuchers (alle IP-Limits treffen dann alle auf einmal, das Audit-Log zeigt eine einzige IP).
Cloudflare schickt die Adresse des Besuchers in `X-Forwarded-For`; sie wird nur geglaubt, wenn die
Verbindung von einer vertrauenswürdigen Adresse kommt. Zwei Schritte:

**1. Der äußere Proxy muss Cloudflares Adressbereiche als vertrauenswürdig kennen.** Sonst ersetzt
er den von Cloudflare gesendeten `X-Forwarded-For`-Header durch Cloudflares eigene Adresse.

- **Traefik**, statische Konfiguration (`traefik.yml`), am Entrypoint, der den Verkehr annimmt:

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

  Dasselbe als Kommandozeilen-Flag (Bereiche kommagetrennt):
  `--entryPoints.websecure.forwardedHeaders.trustedIPs=173.245.48.0/20,103.21.244.0/22,...`
  Starte Traefik danach neu.

- **nginx**: eine Zeile `set_real_ip_from <Bereich>;` pro Bereich (im `http`- oder `server`-Block)
  plus `real_ip_header X-Forwarded-For;` und `real_ip_recursive on;`. nginx ersetzt dann
  `$remote_addr` durch die Adresse des Besuchers; zu TIX hin bleibt
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` bestehen.
- **Nginx Proxy Manager**: dieselben Zeilen (`set_real_ip_from ...;`,
  `real_ip_header X-Forwarded-For;`, `real_ip_recursive on;`) im Reiter **Advanced** des
  Proxy-Hosts (eigene Nginx-Konfiguration) eintragen; NPM hat dafür kein Kästchen.

**2. TIX muss dem äußeren Proxy und Cloudflare vertrauen.** Trage in der `.env` `private_ranges`
(der äußere Proxy in deinem LAN oder Docker-Netz) **und** die Cloudflare-Bereiche ein, durch
Leerzeichen getrennt in **einer** Zeile:

```bash
TRUSTED_PROXIES=private_ranges 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32
```

Danach `docker compose up -d`. Cloudflares Bereiche ändern sich selten; die aktuelle Liste steht auf
<https://www.cloudflare.com/ips/> (ab und zu prüfen und an beiden Stellen nachziehen).

**Prüfen:** Öffne im Admin Einstellungen → Kasse. „Erkannte IP deiner aktuellen Anfrage“ muss
deine eigene öffentliche Adresse zeigen, nicht eine Cloudflare- oder private Adresse.

**E-Mail-Adressen auf Shop-Seiten.** Cloudflares _Email Address Obfuscation_ (Scrape Shield) schreibt
jede E-Mail-Adresse im HTML in einen `/cdn-cgi/l/email-protection`-Link um und fügt ein Skript ein,
das die Content Security Policy des Shops blockiert - Besucher sähen „[email protected]“ statt der
Adresse. Der Shop umschließt deshalb jede E-Mail-Adresse und jeden `mailto:`-Link, den er ausgibt
(Veranstaltungsbeschreibungen, Infoboxen, Footer, Startseite, Bestell- und Kontoseiten), automatisch
mit Cloudflares Opt-out-Kommentaren `<!--email_off-->...<!--/email_off-->`; es ist nichts einzustellen.
Alternativ schaltest du die Funktion in Cloudflare ab (**Scrape Shield → Email Address Obfuscation**).

Tipps:

- Stelle im Cloudflare-Dashboard unter **SSL/TLS → Übersicht** den Modus **Vollständig (streng)**
  ein („Full (strict)“; der Ursprungsserver muss ein gültiges Zertifikat liefern, z. B. von
  Traefik oder Caddy). „Flexibel“ führt zu Weiterleitungsschleifen.
- Härtung: Wenn alles läuft, lass Firewall oder Router Port 443 nur noch von den
  Cloudflare-Bereichen annehmen, damit niemand den Server direkt erreicht und den Header fälschen
  kann.

## Erste Einrichtung im Admin-Bereich

Das Dashboard zeigt dieselben Schritte als Einrichtungs-Checkliste. Arbeite diese Liste im Admin-Bereich ab. Alles findest du in den Menüpunkten links.

1. **Einstellungen → Veranstalter:** Name, Adresse, Impressums- und Datenschutz-Links, Kontakt.
   Sie erscheinen im Shop und auf Rechnungen.
   - _Test- oder Demo-Server?_ Öffne **Einstellungen → SEO** und schalte **Suchmaschinen dürfen den
     Shop indexieren** gleich aus: Jede Seite bittet Google und andere dann, die Seite zu ignorieren,
     `robots.txt` sperrt das Crawlen und es gibt keine Sitemap. Bereits gelistete Seiten verschwinden
     erst nach Tagen (das Entfernen-Werkzeug der Google Search Console geht schneller). Im echten Shop
     stellst du dort außerdem Seitentitel, Beschreibung, Vorschaubild und Verifizierungs-Tokens ein.
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

- Die Handys müssen `APP_URL` erreichen können. Bei Heim- oder Vereinsroutern ist die öffentliche
  Adresse des Servers aus demselben WLAN manchmal nicht erreichbar („Hairpin NAT"). Teste, indem du
  `APP_URL` im Browser des Handys im WLAN des Veranstaltungsorts öffnest.
- Reines `http://` wird nur für private Adressen wie `http://192.168.1.20:8080` akzeptiert. Jede
  öffentliche Adresse braucht `https://`.
- Einstellungen → Scanner → Server-URL muss die Adresse sein, die die **Handys** erreichen.
- Die App aktualisiert sich immer genau auf die Version, die dein Server gerade betreibt (über GitHub
  Releases). Im Admin kannst du auf Updates von deinem eigenen Server umstellen.

Mehr dazu: [SCANNER.md](SCANNER.md) und [apps/android/README.md](../apps/android/README.md)
(Englisch).

## Updates, Backups, Deinstallation

### Updates

1. Lies das [CHANGELOG](../CHANGELOG.md) der neuen Version.
2. Führe das Update-Skript im Ordner deiner `docker-compose.yml` aus:

```bash
cd tix
./tix-update.sh                 # neuestes Release des Kanals in der .env (TIX_VERSION)
./tix-update.sh 1.0.0-alpha.21  # oder eine exakte Version
./tix-update.sh stable          # oder ein Kanal: stable, next, alpha, beta, rc, 1, 1.0
./tix-update.sh --dry-run       # nur herunterladen und prüfen, nichts ändern
```

Das Skript hängt an jedem Release (`tix-update.sh`, in `SHA256SUMS.txt` aufgeführt); speichere es
einmalig neben der `docker-compose.yml`. Es braucht `curl` oder `wget` und Docker Compose 2.23.1+,
prüft die SHA-256 der heruntergeladenen Compose-Datei, behält die bisherige als
`docker-compose.yml.bak-<Zeit>` und führt dann `docker compose pull` und
`docker compose up -d --remove-orphans` aus. Die Datei wird validiert (`docker compose config`) und das
Image geladen, bevor die alte Compose-Datei ersetzt wird; ein fehlgeschlagener Download oder Pull ändert
also nichts. `.env` und `docker-compose.override.yml` werden nie angefasst. Der Wechsel auf eine
**niedrigere** Version als die laufende wird ohne `--force` abgelehnt (siehe „Zurückgehen" unten). Ein
ausdrücklich angegebener Kanal oder eine Version gilt für diesen Lauf auch dann, wenn `TIX_VERSION` in der
`.env` etwas anderes sagt; das Skript erinnert dich, auch die `.env` zu ändern. Eine Compose-Datei des
alten Drei-Image-Layouts wird nie ersetzt: Das Skript hält an und verweist auf
[MIGRATE-SINGLE-IMAGE.de.md](MIGRATE-SINGLE-IMAGE.de.md).

**Von Hand** (Alternative): Lade die `docker-compose.yml` des Releases herunter (behalte deine `.env` und
`docker-compose.override.yml`), dann `docker compose pull && docker compose up -d`.

3. Prüfe **Admin → System**: Die laufende Version steht dort, in der Admin-Seitenleiste und unter
   `/api/health`. Das Admin-Dashboard sagt Super-Admins, wenn es ein neueres Release für deinen Kanal gibt
   (abschaltbar unter Einstellungen → Allgemein → Updates) und warnt, wenn deine `docker-compose.yml`
   älter ist als die laufende App.

**Automatisches Backup vor Datenbankänderungen.** Enthält ein Update Datenbank-Migrationen und hat die
Installation schon Daten, schreibt der `tix`-Container zuerst ein verschlüsseltes Backup nur der
Datenbank (gleiches Format und gleicher Schlüssel wie die Admin-Backups) und wendet die Migrationen erst an,
wenn das geklappt hat. Es erscheint unter **Admin → Backups** als „Vor dem Update" und wird wie jedes
andere Backup wiederhergestellt; eine Wiederherstellung ersetzt nur die Datenbank und lässt Bilder und PDFs
unberührt. Die neuesten `PRE_UPDATE_BACKUP_KEEP` (Standard 3) bleiben erhalten; sie zählen nicht zur
Aufbewahrung der zeitgesteuerten Backups. Beim Dateispeicher liegt das Backup im Volume `tix-data`
(dieselbe Platte wie die Dateien); bei S3 wird es in den Backup-Bucket geschrieben. Schlägt das Backup
fehl, wird **keine Migration angewendet** und der Container hält mit dem Grund in `docker compose logs tix`
an. Um ohne Backup zu aktualisieren (nicht empfohlen), setze `SKIP_PRE_UPDATE_BACKUP=1` in der `.env`.
Migrationen warten höchstens `MIGRATION_LOCK_TIMEOUT` Sekunden (Standard 10) auf eine Tabellensperre und
versuchen es erneut, eine hängende Transaktion kann den Shop also nie einfrieren.

**Zurückgehen.** Ein Backup vor dem Update enthält deine **Daten** wie vor dem Update. Spielst du es
zurück (Admin → Backups), ersetzt es die Datenbank durch diesen Stand und führt die Migrationen der laufenden
Version erneut aus: Du bleibst auf der **neuen** Version mit den alten Daten. Das Zurückgehen auf eine
**ältere Anwendungsversion wird nicht unterstützt**, sobald ein neueres Datenbankschema angewendet wurde:
ältere Versionen können das neuere Schema oder den Backup-Typ „Vor dem Update" nicht lesen. Macht ein
Update Probleme, melde sie und bleib auf der neuen Version (Backup zurückspielen, falls Daten beschädigt
wurden), oder installiere die alte Version neu und spiele ein normales Backup zurück, das diese alte
Version erstellt hat.

**Update-Prüfung.** Das Admin-Dashboard fragt höchstens alle 6 Stunden die GitHub-Releases-API
(`api.github.com`) nach neueren Releases; das ist eine ausgehende Anfrage, die nichts über deine
Installation sendet. Abschaltbar unter Einstellungen → Allgemein → Updates.

**Die Version wählst du mit `TIX_VERSION` in der `.env`:**

| Wert                     | Folgt                                               | Nimm es für                                                                      |
| ------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `next`                   | dem neuesten Release jeder Art, auch Vorabversionen | Tests und Demos; heute die einzige Wahl, weil es noch kein stabiles Release gibt |
| `stable`                 | dem neuesten stabilen Release                       | Produktion (ab 1.0.0)                                                            |
| `1` oder `1.0`           | dem neuesten stabilen Release dieser Linie          | Produktion ohne Überraschungen                                                   |
| `1.0.0-alpha.3`, `1.0.0` | genau dieser Version                                | Festnageln, Zurückgehen                                                          |

Eine frühere Version festzunageln funktioniert nur, solange das Datenbankschema unverändert ist. Hat ein
neueres Release die Datenbank migriert, wird das Zurückgehen **nicht unterstützt** (siehe „Zurückgehen"
oben): Das Backup vor dem Update stellt deine Daten auf der neuen Version wieder her, es lässt die alte
Version nicht wieder laufen.

Nutze keine automatischen Updater (Watchtower und ähnliche): Updates sollen bewusst geschehen.

### Backups und Wiederherstellung

Nutze **Admin → Backups**: Datenbank und Dateien, zeitgesteuert, mit optionalem externem S3-Ziel. Die
Wiederherstellung ist am selben Ort (nur SUPER_ADMIN). Details: [BACKUP.md](BACKUP.md). Bewahre
außerhalb des Servers auf:

- `APP_ENCRYPTION_KEYS` (und die ganze `.env`): Er wird auch gebraucht, um ein Backup **auf einem anderen
  System** wiederherzustellen,
- das externe Backup-Ziel. Ohne eines liegen die lokalen Backups im selben Docker-Volume (`tix_tix-data`)
  wie die Dateien: Sie schützen vor Fehlern und schlechten Updates, nicht vor dem Verlust der Platte.

Die Daten liegen in Docker-Volumes des Projekts `tix`: `tix_postgres-data`, `tix_redis-data` und
`tix_tix-data` (Dateien, lokale Backups, das erzeugte `SESSION_SECRET`), dazu `tix_caddy-data`
(Zertifikate), wenn du Caddy wie im Schnellstart nutzt. Liste sie mit `docker volume ls` auf.

### Deinstallation

```bash
cd tix
docker compose down        # stoppt und entfernt Container, BEHÄLT deine Daten
docker compose down -v     # LÖSCHT außerdem alle Daten (Datenbank, Dateien, Zertifikate) - unwiderruflich
```

## Monitoring

Die Admin-Seite **System** (Super-Admins) zeigt den Live-Status: Version und Laufzeit der
Anwendung, PostgreSQL-Verbindungen und -Größe, Redis-Speicher und -Durchsatz, die Job-Warteschlangen
mit ihren fehlgeschlagenen Jobs, den Warteraum, in Warenkörben gehaltene Plätze, verbundene
Echtzeit-Clients, Worker und offene Rückstände (E-Mails, Erstattungen, Bankumsätze). Sie
aktualisiert sich alle paar Sekunden und zeigt einen Verlauf der letzten zehn Minuten.

Für Prometheus (oder Grafana Agent, VictoriaMetrics, Zabbix, ...) stehen dieselben Zahlen als Text
unter `/api/metrics` bereit. Den Endpunkt gibt es erst, wenn du unter **Einstellungen, Sicherheit,
Monitoring** ein Token anlegst (es wird nur einmal angezeigt; ein neues Token ersetzt das alte,
Entfernen schaltet den Endpunkt wieder ab). Falsche Tokens werden pro Client-Adresse begrenzt.

```bash
curl -H "Authorization: Bearer <Token>" https://tickets.example.org/api/metrics
```

Eine minimale Prometheus-Scrape-Konfiguration:

```yaml
scrape_configs:
  - job_name: tix
    scrape_interval: 30s
    scheme: https
    metrics_path: /api/metrics
    authorization:
      type: Bearer
      credentials: <Token> # oder credentials_file: /etc/prometheus/tix.token
    static_configs:
      - targets: ['tickets.example.org']
```

Sinnvolle Alarme: `tix_queue_jobs{state="failed"} > 0`, `tix_workers == 0`,
`tix_worker_leader_present == 0`, `tix_postgres_connections / tix_postgres_max_connections > 0.85`,
`tix_redis_used_memory_bytes / tix_redis_max_memory_bytes > 0.9` (wenn `maxmemory` gesetzt ist)
und `tix_collect_error > 0`. Das Echtzeit-Gateway meldet sich alle 10 Sekunden bei Redis
(`tix_realtime_instances`); Images aus Versionen davor tun das nicht und erscheinen als „meldet
nicht“.

## Alle Variablen

Nur der erste Block ist Pflicht. Alles andere hat einen Standardwert; die mit „optional" markierten Zeilen
sind in der heruntergeladenen `.env` auskommentiert (zum Benutzen das `#` entfernen). Die ganze `.env`
wird an den `tix`-Container gereicht, jede Variable des Images funktioniert also auch dann, wenn sie in
der Compose-Datei nicht aufgeführt ist.

| Variable                                                                                                         | Pflicht   | Bedeutung                                                                                                                                                                                                                                                                                                                                                      | Beispiel                                       |
| ---------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `APP_URL`                                                                                                        | **ja**    | Die Adresse, die Besucher eintippen, mit `https://` und ohne Schrägstrich am Ende.                                                                                                                                                                                                                                                                             | `https://tickets.example.org`                  |
| `POSTGRES_PASSWORD`                                                                                              | **ja**    | Datenbank-Passwort (nur Buchstaben und Ziffern).                                                                                                                                                                                                                                                                                                               | `3f9a…` (48 Hex-Zeichen)                       |
| `APP_ENCRYPTION_KEYS`                                                                                            | **ja**    | Schlüsselbund: `id:base64key` (keygen wählt eine zufällige ID wie `k3fa9c1`), 32 Zufallsbytes in Base64. Mehrere Schlüssel kommagetrennt; der erste verschlüsselt. Erzeugen mit `docker run --rm ghcr.io/renthner/tix:next keygen`. **Sichern.**                                                                                                               | `k1:Zm9v…YmFy=`                                |
| `TIX_VERSION`                                                                                                    | vorbelegt | Welches Image läuft: `next`, `stable`, `1`, `1.0` oder eine exakte Version. Siehe [Updates](#updates-backups-deinstallation).                                                                                                                                                                                                                                  | `next`                                         |
| `TRUSTED_PROXIES`                                                                                                | optional  | **Hinter jedem Reverse-Proxy setzen:** dessen Adresse(n) oder `private_ranges`. Leer = niemandem wird vertraut (alle Besucher sehen aus wie der Proxy).                                                                                                                                                                                                        | `private_ranges`                               |
| `TIX_ALLOWED_HOSTS`, `TIX_PROXY_SOCKET_TIMEOUT_MS`, `TIX_PROXY_REQUEST_TIMEOUT_MS`, `TIX_PROXY_MAX_CONNS_PER_IP` | optional  | Eingebauter Proxy: zusätzlich akzeptierte Hostnamen (fremder `Host` bekommt 421, außer `APP_URL` ist Loopback oder `*`), Inaktivitäts-Timeout je Client (Vorgabe `120000` ms), Zeit zum Empfangen einer Anfrage (Vorgabe `3600000` ms), Verbindungen je Client-Adresse (Vorgabe `200`). Siehe [Eingebauter Proxy](#eingebauter-proxy-host-prüfung-und-limits). | `shop.example.org`, `120000`, `3600000`, `200` |
| `TIX_ALLOW_FOREIGN_BACKUP_KEYS`                                                                                  | optional  | `1` erlaubt die Wiederherstellung einer Sicherung einer anderen Installation durch Eingabe von deren Schlüssel (Standard aus). **Ein SUPER_ADMIN kann dann beliebiges SQL als Datenbankbenutzer ausführen**; nur für den Umzug aktivieren. Siehe [BACKUP.md](BACKUP.md#restoring-a-backup-from-another-system).                                                |
| `HTTP_PORT`                                                                                                      | optional  | Host-Port des Klartext-HTTP-Ports (Standard `8080`). `127.0.0.1:8081` = nur vom Server erreichbar.                                                                                                                                                                                                                                                             | `127.0.0.1:8081`                               |
| `SESSION_SECRET`                                                                                                 | optional  | Mindestens 32 Zeichen für signierte Cookies. Ohne ihn wird einer erzeugt und in `/data/secrets` abgelegt. Setze ihn, um Sitzungen beim Umzug des Volumes zu behalten.                                                                                                                                                                                          | `e4b8…`                                        |
| `COMPOSE_PROJECT_NAME`                                                                                           | optional  | Namenspräfix der Container und Volumes. Nach dem ersten Start nicht ändern (du bekämst leere neue Volumes).                                                                                                                                                                                                                                                    | `tix`                                          |
| `LOG_LEVEL`                                                                                                      | optional  | Log-Detailgrad: `info`, `debug`, `warn`, `error`.                                                                                                                                                                                                                                                                                                              | `info`                                         |
| `SKIP_PRE_UPDATE_BACKUP`, `PRE_UPDATE_BACKUP_KEEP`                                                               | optional  | Automatisches Datenbank-Backup vor anstehenden Migrationen: `1` überspringt es (nicht empfohlen); wie viele aufbewahrt werden (Standard `3`).                                                                                                                                                                                                                  | `3`                                            |
| `MIGRATION_LOCK_TIMEOUT`, `MIGRATION_STATEMENT_TIMEOUT`, `MIGRATION_LOCK_RETRIES`                                | optional  | Sekunden, die eine Schemaänderung auf eine Tabellensperre wartet (Standard `10`, `0` = unbegrenzt), Sekunden, die eine Anweisung laufen darf (Standard `600`), Versuche nach einem Sperr-Timeout (Standard `5`).                                                                                                                                               | `10`, `600`, `5`                               |
| `WEB_DATABASE_POOL_MAX`, `WORKER_DATABASE_POOL_MAX`                                                              | optional  | Datenbankverbindungen des Web-Teils (Standard `20`) und des Workers (Standard `8`); zusammen bleiben sie weit unter PostgreSQLs Standard von 100.                                                                                                                                                                                                              | `20`, `8`                                      |
| `TIX_ROLE`                                                                                                       | optional  | Welche Teile im Container laufen: `all` (Standard) oder eine Liste aus `web`, `worker`, `realtime` zum Skalieren.                                                                                                                                                                                                                                              | `all`                                          |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_NAME`                                                                       | optional  | Nur für ein externes PostgreSQL (Standard `postgres`, `5432`, `tix`, `tix`); oder `DATABASE_URL` direkt setzen.                                                                                                                                                                                                                                                | `db.example.org`                               |
| `REDIS_URL`                                                                                                      | optional  | Nur für ein externes Redis (Standard `redis://redis:6379/0`).                                                                                                                                                                                                                                                                                                  | `redis://:pw@host:6379/0`                      |
| `STORAGE_DRIVER`, `STORAGE_DIR`                                                                                  | optional  | `fs` (Standard; Verzeichnis `/data/storage`) oder `s3`. Siehe [STORAGE.md](STORAGE.md).                                                                                                                                                                                                                                                                        | `fs`                                           |
| `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_*`, `S3_REGION`                            | optional  | S3-Modus: Das Setzen von `S3_ENDPOINT` schaltet den Treiber auf `s3`; drei verschiedene Buckets sind nötig.                                                                                                                                                                                                                                                    | `https://s3.example.org`                       |

## Fehlersuche

Nützliche Befehle (im Ordner `tix` ausführen):

```bash
docker compose ps                     # Zustand aller Dienste
docker compose logs --tail 100 tix    # letzte Log-Zeilen der Anwendung
docker compose logs -f caddy          # das Caddy-Log live verfolgen (Beenden mit Strg+C)
curl -fsS http://localhost:8080/api/health   # nur wenn HTTP_PORT auf diesem Server 8080 ist
```

Der `tix`-Container schreibt für Web, Worker und Realtime ein JSON-Objekt pro Log-Zeile (Feld
`service`). Fehler haben `"level":50`, Warnungen `"level":40`:
`docker compose logs tix | grep '"level":50'`. Setze `LOG_LEVEL` in der `.env` (`error`, `warn`, `info`,
`debug`; Standard `info`), um die Ausführlichkeit zu ändern. Web-Log-Zeilen einer Anfrage tragen eine
`reqId`, die zum `X-Request-Id` des eingebauten Proxys passt.

Dienstnamen: `tix`, `postgres`, `redis` (dazu `caddy` / `minio`, wenn du sie ergänzt hast).

| Symptom                                                                                                                  | Ursache                                                                                                                                                              | Lösung                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose` meldet `set TIX_VERSION in .env - upgrading from the three-image layout`                                | `.env` / Compose-Datei stammen von einem älteren Release (`tix-web` / `tix-worker` / `tix-realtime`)                                                                 | Nicht mit der neuen Compose-Datei weitermachen: [MIGRATE-SINGLE-IMAGE.de.md](MIGRATE-SINGLE-IMAGE.de.md)                                                                                                                                                                                                                                                                                                                                                                      |
| `required variable ... is missing a value` / `set POSTGRES_PASSWORD in .env`                                             | Die Variable ist leer oder fehlt, oder die `.env` liegt nicht im aktuellen Ordner                                                                                    | Führe den Befehl im Ordner `tix` aus, die Datei muss `.env` heißen (nicht `env.example`), und fülle die genannte Variable.                                                                                                                                                                                                                                                                                                                                                    |
| `tix` hält sofort mit `APP_ENCRYPTION_KEYS is not set` / `is invalid` an                                                 | Der Schlüsselbund fehlt oder ist fehlerhaft                                                                                                                          | `docker run --rm ghcr.io/renthner/tix:next keygen` gibt eine gültige Zeile für die `.env` aus.                                                                                                                                                                                                                                                                                                                                                                                |
| Redis startet nach einem Absturz oder Stromausfall in einer Schleife neu: `Bad file format reading the append only file` | Das Ende der Append-Only-Datei von Redis wurde beim Ausfall nur halb geschrieben; mehr als 4 KB sind beschädigt (kleinere Schäden repariert Redis beim Start selbst) | `docker compose stop redis`, Volume sichern (`docker run --rm -v <Projekt>_redis-data:/data alpine tar czf - -C /data . > redis-backup.tgz`), dann `docker run --rm -it -v <Projekt>_redis-data:/data redis:8.10-alpine sh -c 'cd /data/appendonlydir && redis-check-aof --fix appendonly.aof.manifest'`, mit `y` bestätigen, `docker compose up -d`. Redis hält nur kurzlebige Daten (Warenkörbe, Sitzplatzsperren, Warteschlange, Jobs); Bestellungen liegen in PostgreSQL. |
| `tix` endet mit „The pre-update backup failed, so no migration was applied"                                              | Das Datenbank-Backup vor dem Update konnte nicht geschrieben werden (Speicher nicht beschreibbar, Schlüsselbund-Problem). Es wurde nichts geändert.                  | Grund mit `docker compose logs tix` lesen, beheben und das Update erneut ausführen. Nur als letzten Ausweg `SKIP_PRE_UPDATE_BACKUP=1` setzen.                                                                                                                                                                                                                                                                                                                                 |
| Log: „another session holds a lock on a table the migration needs"                                                       | Eine lang laufende Transaktion blockiert die Schemaänderung; die Migration versucht es erneut und gibt am Ende auf, ohne etwas zu ändern                             | Führe das Update (`docker compose up -d`) erneut aus, wenn im Shop wenig los ist                                                                                                                                                                                                                                                                                                                                                                                              |
| Der Container startet von selbst neu, `docker inspect` zeigt `OOMKilled`                                                 | Dem Host ist der Speicher ausgegangen                                                                                                                                | Speicher freigeben oder RAM aufrüsten; für einen Verein reicht ein Server mit 4 GB RAM locker.                                                                                                                                                                                                                                                                                                                                                                                |
| Fehler mit `configs.content`, „unknown key" oder „additional property"                                                   | Docker Compose ist älter als 2.23.1                                                                                                                                  | Docker aus dem offiziellen Repository installieren ([Docker installieren](#docker-installieren)). `docker compose version` muss 2.23.1 oder neuer zeigen.                                                                                                                                                                                                                                                                                                                     |
| `manifest unknown` / `not found` beim Laden von `...:stable`                                                             | Es gibt noch kein stabiles Release, der Image-Tag `stable` existiert also nicht                                                                                      | Setze `TIX_VERSION=next` (oder eine exakte Version wie `1.0.0-alpha.3`) in der `.env`, dann `docker compose pull && docker compose up -d`.                                                                                                                                                                                                                                                                                                                                    |
| Fehler wie `password authentication failed`                                                                              | Das Passwort enthält Sonderzeichen (`@ : / # ? %`), Anführungszeichen, oder wurde nach dem ersten Start geändert                                                     | Nur Buchstaben und Ziffern, keine Anführungszeichen. Das Datenbank-Passwort wird beim Anlegen des Daten-Volumes festgelegt: `POSTGRES_PASSWORD` später zu ändern braucht `docker compose down -v` bei einer frischen Installation (löscht Daten) oder eine manuelle Passwortänderung in PostgreSQL.                                                                                                                                                                           |
| Browser zeigt eine Zertifikatswarnung oder kein HTTPS (Caddy wie im Schnellstart)                                        | Caddy konnte kein Zertifikat holen: DNS falsch, Port 80/443 gesperrt oder Let's-Encrypt-Limit                                                                        | `docker compose logs caddy`. Prüfe, dass die Domain auf diesen Server zeigt, Port 80 und 443 offen sind (auch in der Firewall des Anbieters) und die Caddyfile nur die Domain enthält (kein `https://`). Warte eine Stunde, wenn das Log ein Limit erwähnt.                                                                                                                                                                                                                   |
| `port is already allocated` / `address already in use` auf Port 80 oder 443                                              | Ein anderer Webserver (apache2, nginx) belegt den Port                                                                                                               | Beende ihn (`sudo systemctl disable --now apache2`) oder nimm Variante B/C/D. `sudo ss -ltnp \| grep -E ':80 \|:443 '` zeigt, wer den Port benutzt.                                                                                                                                                                                                                                                                                                                           |
| Die Firewall (ufw) ist an, aber ein Port ist trotzdem erreichbar                                                         | Docker veröffentlicht Ports direkt und umgeht ufw-Regeln                                                                                                             | Nur der Proxy veröffentlicht Ports (80/443 oder dein `HTTP_PORT`). Um einen Port privat zu halten, binde ihn an `127.0.0.1` (`HTTP_PORT=127.0.0.1:8080`). Verlass dich bei Docker-Ports nicht allein auf ufw.                                                                                                                                                                                                                                                                 |
| Sitzplätze aktualisieren sich nicht live; die Browser-Konsole zeigt WebSocket-Fehler                                     | Dein Reverse-Proxy leitet WebSockets für `/socket.io` nicht weiter                                                                                                   | Variante C: den Block `/socket.io/` oben verwenden. NPM: Websockets Support aktivieren. Cloudflare: WebSockets müssen an sein.                                                                                                                                                                                                                                                                                                                                                |
| Alle bekommen „zu viele Anfragen", oder das Audit-Log zeigt für alle Besucher eine IP                                    | Ein Proxy steht davor, aber `TRUSTED_PROXIES` ist leer oder enthält seine Adresse nicht                                                                              | Setze `TRUSTED_PROXIES` auf die Adresse des Proxys oder `private_ranges`, dann `docker compose up -d`. Prüfe Einstellungen → Kasse → „Erkannte IP".                                                                                                                                                                                                                                                                                                                           |
| Handy kann nicht koppeln, meldet „Serveradresse nicht erlaubt"                                                           | `http://` mit öffentlicher Adresse, oder falsche Server-URL                                                                                                          | `https://` verwenden. `http://` geht nur für private IPs. Prüfe Einstellungen → Scanner → Server-URL.                                                                                                                                                                                                                                                                                                                                                                         |
| Handy kann nicht koppeln, keine Verbindung oder Timeout                                                                  | Das Handy erreicht `APP_URL` nicht (Hairpin-NAT, VPN, falsche URL)                                                                                                   | Öffne `APP_URL` im Browser des Handys im selben WLAN. Klappt das nicht, nimm mobile Daten oder korrigiere den Router (NAT-Loopback / lokales DNS).                                                                                                                                                                                                                                                                                                                            |
| Der Kopplungs-QR-Code enthält `localhost`                                                                                | Die Scanner-Server-URL ist nicht gesetzt                                                                                                                             | Einstellungen → Scanner → Server-URL auf `APP_URL` setzen.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Es kommen keine E-Mails an                                                                                               | Falsche SMTP-Daten, gesperrter Port, Spam-Ordner                                                                                                                     | Einstellungen → E-Mail → **Test-E-Mail senden** zeigt den Fehler. Probiere Port 587 (STARTTLS) oder 465 (TLS); `docker compose logs tix`.                                                                                                                                                                                                                                                                                                                                     |
| Backups oder gespeicherte Geheimnisse sind nach dem Umzug auf einen neuen Server nicht lesbar                            | `APP_ENCRYPTION_KEYS` weicht vom alten Server ab                                                                                                                     | Nimm die ursprüngliche Schlüsselzeile aus deinem Passwortmanager. Ohne sie sind die verschlüsselten Daten nicht zu retten; deshalb sicherst du sie.                                                                                                                                                                                                                                                                                                                           |
| Ein Dienst ist `unhealthy`                                                                                               | Start läuft noch, oder ein Konfigurationsfehler                                                                                                                      | Warte zwei Minuten (zuerst laufen die Migrationen). Dann `docker compose logs --tail 100 <Dienst>`. Die Prüfung von `tix` ist `GET /api/health` über das eigene Health-Kommando des Containers.                                                                                                                                                                                                                                                                               |
| Die Kasse zeigt Überweisung oder PayPal als „Derzeit nicht verfügbar"                                                    | Es gibt kein Standard-Empfangskonto (Überweisung), oder PayPal ist nicht eingerichtet/aktiviert                                                                      | Bank & Zahlungen → Konten & Verbindungen: ein Konto anlegen und als Standard markieren. PayPal: Einstellungen → Zahlungen.                                                                                                                                                                                                                                                                                                                                                    |
| Admin-Login sagt „Zu viele Versuche"                                                                                     | Mehr als 10 Fehlversuche je E-Mail-Adresse oder 20 je IP-Adresse innerhalb von 15 Minuten (auch durch Skripte/Tests)                                                 | Bis zu 15 Minuten warten; das Limit läuft von selbst ab. Passwort vergessen: `docker compose run --rm tix create-admin --email du@example.org --reset` gibt ein neues Passwort aus (Rollen bleiben).                                                                                                                                                                                                                                                                          |
| `docker compose up` / `pull` zeigt minutenlang keinen Fortschritt                                                        | Das Image wird noch geladen                                                                                                                                          | Warten, oder `docker compose pull` separat ausführen, um den Fortschritt zu sehen.                                                                                                                                                                                                                                                                                                                                                                                            |
| Die Seite zeigt lange „Wartung"                                                                                          | Eine Backup-Wiederherstellung läuft                                                                                                                                  | Warten; prüfe `docker compose logs tix`.                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Kommst du nicht weiter, öffne ein [Issue](https://github.com/Renthner/tix-platform/issues/new/choose)
mit der Ausgabe von `docker compose ps` und den relevanten Log-Zeilen. **Entferne Passwörter und
Schlüssel, bevor du Logs postest.**
