# TIX auf deinem eigenen Server installieren

[English](INSTALL.md) | Deutsch

Diese Anleitung hat zwei Teile. **Teil 1** bringt einen Ticketshop in etwa 15 Minuten zum Laufen:
Du kopierst ein paar Befehle und musst **kein** Docker-Experte sein. **Teil 2** ist der Anhang für
Sonderfälle (anderer Reverse-Proxy, Cloudflare), die vollständige Variablenübersicht, Monitoring
und Fehlersuche.

> TIX ist derzeit eine Vorabversion (Version siehe unten). Wo diese Anleitung „das neueste Release"
> sagt, nimm die Version von der [Release-Seite](https://github.com/Renthner/tix-platform/releases).

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
export TIX_VERSION=1.0.0-alpha.16
mkdir tix && cd tix
curl -fLO https://github.com/Renthner/tix-platform/releases/download/v$TIX_VERSION/docker-compose.yml
curl -fLO https://github.com/Renthner/tix-platform/releases/download/v$TIX_VERSION/env.example
mv env.example .env
```

Arbeite für alle `docker compose`-Befehle immer in diesem Ordner (`cd tix`). Sobald es ein
stabiles `1.0.0` gibt, kannst du stattdessen
`https://github.com/Renthner/tix-platform/releases/latest/download/<Datei>` verwenden; bis dahin
gibt es diese Adresse nicht (Fehler 404).

### 2. Die `.env`-Datei ausfüllen

Ersetze in der ersten Zeile die Domain und füge den ganzen Block ein (er braucht `openssl`, das bei
Debian und Ubuntu dabei ist; [ohne openssl](#die-env-datei-im-detail)). Er trägt deine Adresse ein
und erzeugt die vier Geheimnisse:

```bash
DOMAIN=tickets.example.org   # <- deine Domain
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

Kein Wert darf noch `change-me` oder `REPLACE_WITH` enthalten. Mehr ist nicht nötig: Die Passwörter
des mitgelieferten Dateispeichers (MinIO) werden beim ersten Start erzeugt und in einem
Docker-Volume abgelegt; du trägst sie nirgends ein.

**Sichere jetzt die Zeile `APP_ENCRYPTION_KEYS`:** Kopiere sie in deinen Passwortmanager, außerhalb
des Servers. Sie verschlüsselt gespeicherte Geheimnisse (Bank-PINs, API-Schlüssel,
Ticket-Signaturschlüssel) und deine Backups; ohne sie lässt sich beides nicht wiederherstellen.
Ändere oder lösche nie einen Schlüssel, der in Benutzung ist.

### 3. Starten

```bash
docker compose up -d
```

Beim ersten Start werden die Images geladen (einige hundert MB); das dauert ein bis drei Minuten,
und `docker compose up -d` kann dabei nichts anzeigen. Prüfe mit `docker compose ps`: Alle Dienste
sollten `running` oder `healthy` sein; `storage-credentials`, `minio-init` und `migrate` zeigen
`exited (0)`, weil es Einmal-Jobs sind. Bekommt Caddy kein HTTPS-Zertifikat, ist meist das DNS
falsch: siehe [Fehlersuche](#fehlersuche).

Lege den ersten Administrator an (deine eigene E-Mail-Adresse und dein Name):

```bash
docker compose run --rm migrate node dist/create-admin.mjs --email du@example.org --name "Dein Name"
```

Der Befehl zeigt **einmalig ein Passwort** an. Kopiere es.

### 4. Den Admin-Bereich öffnen

Öffne `https://tickets.example.org/admin`, melde dich an und ändere das Passwort. Schalte die
Zwei-Faktor-Authentifizierung ein (klicke unten links im Admin-Menü auf deinen Namen; unter
**Einstellungen → Sicherheit** kannst du sie für alle verpflichtend machen). Das Dashboard zeigt
danach eine **Einrichtungs-Checkliste**, die dich durch die ersten Schritte führt: Veranstalterdaten,
SMTP (mit Test-E-Mail), Zahlarten, Steuern und Gebühren, Spielstätte und Veranstaltung,
Scanner-URL und Backups. Dieselbe Liste mit Erklärungen steht unter
[Erste Einrichtung im Admin-Bereich](#erste-einrichtung-im-admin-bereich).

### Updates und Backups

```bash
cd tix
# Admin -> Sicherungen: erst ein Backup machen, dann die neue docker-compose.yml des Releases laden
# (nur wenn im CHANGELOG steht, dass sich die Compose-Datei geändert hat), dann:
docker compose pull
docker compose up -d
```

Datenbank-Migrationen laufen automatisch. Einzelheiten, Versionswahl und Zurückrollen:
[Updates, Backups, Deinstallation](#updates-backups-deinstallation). Backups (Datenbank und Dateien,
zeitgesteuert, optional auf ein externes S3-Ziel) findest du im Admin unter **Sicherungen**:
[BACKUP.md](BACKUP.md) (Englisch). **Bewahre `APP_ENCRYPTION_KEYS` und ein externes Backup-Ziel
außerhalb des Servers auf.**

Du willst statt des mitgelieferten HTTPS hinter Traefik, nginx, Nginx Proxy Manager, einem Tunnel
oder Cloudflare laufen? Siehe [HTTPS-Varianten](#https-varianten) in Teil 2.

---

## Teil 2: Fortgeschritten (Anhang)

1. [Docker installieren](#docker-installieren)
2. [Die `.env`-Datei im Detail](#die-env-datei-im-detail)
3. [HTTPS-Varianten](#https-varianten): eigener Reverse-Proxy (Traefik, nginx, Nginx Proxy Manager, Tunnel), Cloudflare
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

Der Schnellstart füllt die `.env`-Datei mit einem Befehl aus. Dieser Abschnitt erklärt die Regeln
und die Alternativen. Maßgeblich ist die heruntergeladene Datei: Ihre Kommentare erklären jeden
Eintrag, und alle Variablen stehen unter [Alle Variablen](#alle-variablen). Regeln:

- Pro Zeile ein `SCHLÜSSEL=Wert`. **Keine Anführungszeichen**, keine Leerzeichen um das `=`.
- Passwörter werden in Verbindungs-URLs eingebaut. Nimm **nur Buchstaben und Ziffern** (Hex-Text
  ist ideal). Zeichen wie `@ : / # ? %` zerstören die Verbindung und führen zu verwirrenden Fehlern.
- Nimm für jeden Eintrag ein **anderes** Passwort.

### Ohne `openssl`

Führe jeden Befehl einmal pro Geheimnis aus und trage die Ausgabe mit einem Editor (`nano .env`)
in die `.env` ein:

```bash
# ein Passwort (hex): einmal für POSTGRES_PASSWORD und einmal für REDIS_PASSWORD ausführen
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

### Zugangsdaten des Dateispeichers (MinIO): nichts einzutragen

Der mitgelieferte Dateispeicher (MinIO) braucht keine Einträge in der `.env`. Beim ersten Start
erzeugt der Einmal-Dienst `storage-credentials` den Administrator-Namen und das Passwort von MinIO
sowie Zugriffsschlüssel und Geheimnis, die die Anwendung nutzt, und legt sie als vier Dateien im
Docker-Volume `storage-credentials` ab (`tix_storage-credentials` beim Standard-Projektnamen).
Vorhandene Dateien werden nie neu erzeugt; Neustarts und Updates behalten sie. Das
Administrator-Paar können nur die MinIO-eigenen Container lesen; die Anwendungs-Container
bekommen nur ihr Zugriffsschlüssel-Paar, schreibgeschützt.

- **Ansehen** (zum Beispiel für die Anmeldung an der MinIO-Konsole, die standardmäßig nicht
  veröffentlicht ist):
  `docker compose exec minio cat /run/tix-storage/minio-root-user` und
  `docker compose exec minio cat /run/tix-storage/minio-root-password`.
- **Installationen aus der Zeit, bevor die Zugangsdaten erzeugt wurden,** haben womöglich noch
  `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_ACCESS_KEY_ID` und `S3_SECRET_ACCESS_KEY` in der
  `.env`. Lass sie für den nächsten Start dort stehen: Die Werte werden in das Volume kopiert,
  und MinIO arbeitet mit seinen vorhandenen Daten weiter. Danach sind die Einträge in der `.env`
  optional (das Volume hält die Werte). Ein `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` in der
  `.env`, der sich vom gespeicherten Paar _unterscheidet_, wird **abgelehnt**: `storage-credentials`
  bricht mit einer Erklärung ab, denn MinIO behält die Administrator-Zugangsdaten, mit denen es
  zuerst gestartet wurde (Überschreiben würde den Stack aus seinem eigenen Speicher aussperren).
  Entferne die beiden Einträge aus der `.env`; um das Paar bewusst zu wechseln, folge der
  MinIO-Dokumentation zum Ändern der Root-Zugangsdaten und ersetze danach die Dateien
  `minio-root-user` und `minio-root-password` im Volume. Löschst du sie _vor_ dem ersten Start mit der neuen Version, bricht
  `storage-credentials` mit einer Erklärung ab, statt für vorhandene Daten ein neues
  Administrator-Passwort zu erfinden; trage dann die alten `MINIO_ROOT_USER` und
  `MINIO_ROOT_PASSWORD` einmal wieder ein.
- **Das Zugriffsschlüssel-Paar der Anwendung ändern** (`S3_ACCESS_KEY_ID` /
  `S3_SECRET_ACCESS_KEY` in der `.env`) ist erlaubt. Ändere die `.env`, führe `docker compose up -d` aus (das startet
  `storage-credentials` und `minio-init` erneut, das Geheimnis des Benutzers wird auf den neuen Wert
  gesetzt) und danach `docker compose up -d --force-recreate web worker`: Die laufenden Container
  lesen die Dateien nur beim Start und würden sonst das alte Geheimnis weiter benutzen.
- **MinIO läuft als root:** Die mitgelieferten Images von MinIO und `mc` müssen als root laufen,
  weil das Administrator-Paar nur für root lesbar ist. Ein eigenes `MINIO_IMAGE` / `MC_IMAGE`,
  das auf einen anderen Benutzer wechselt, wird nicht unterstützt.
- **Umzug auf einen anderen Server oder Backup einspielen:** Das Volume gehört _nicht_ zu den
  TIX-Backups und wird _nicht_ gebraucht. Backups sind mit `APP_ENCRYPTION_KEYS` verschlüsselt und
  enthalten Daten und Dateien selbst, nicht die Speicher-Passwörter; eine neue Installation erzeugt
  neue, und die Wiederherstellung nutzt diese.

## HTTPS-Varianten

Besucher müssen HTTPS benutzen. Der Schnellstart nutzte Variante A. Wähle eine andere nur, wenn du sie nicht verwenden kannst.

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
3. Trage in der `.env` ein (der Schnellstart hat das schon getan; Domain ersetzen):

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

### Hinter Cloudflare

Cloudflare (orange Wolke) kann vor jeder der obigen Varianten stehen. Die Anfrage läuft dann über
mehrere Stationen:

```text
Besucher -> Cloudflare -> (Port-Weiterleitung im Router) -> Traefik / nginx / anderer Proxy -> mitgelieferter Caddy -> TIX
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

Tipps:

- Stelle im Cloudflare-Dashboard unter **SSL/TLS → Übersicht** den Modus **Vollständig (streng)**
  ein („Full (strict)“; der Ursprungsserver muss ein gültiges Zertifikat liefern, z. B. von
  Traefik oder dem mitgelieferten Caddy). „Flexibel“ führt zu Weiterleitungsschleifen.
- Härtung: Wenn alles läuft, lass Firewall oder Router Port 443 nur noch von den
  Cloudflare-Bereichen annehmen, damit niemand den Server direkt erreicht und den Header fälschen
  kann.

## Erste Einrichtung im Admin-Bereich

Das Dashboard zeigt dieselben Schritte als Einrichtungs-Checkliste. Arbeite diese Liste im Admin-Bereich ab. Alles findest du in den Menüpunkten links.

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

**Zurückrollen über das Release hinweg, das die erzeugten Speicher-Zugangsdaten eingeführt hat,**
braucht die `docker-compose.yml` des älteren Releases (die neue Datei liest die Zugangsdaten aus
Dateien, die ältere aus der `.env`), und die Zugangsdaten müssen wieder in der `.env` stehen. Lies
sie vor dem Zurückrollen aus dem laufenden Stack und trage sie in die `.env` ein:

```bash
docker compose exec web cat /run/tix-storage/s3-access-key-id; echo
docker compose exec web cat /run/tix-storage/s3-secret-access-key; echo
docker compose exec minio cat /run/tix-storage/minio-root-user; echo
docker compose exec minio cat /run/tix-storage/minio-root-password; echo
```

Sie werden zu `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `MINIO_ROOT_USER` und
`MINIO_ROOT_PASSWORD` in der `.env`.

Nutze keine automatischen Updater (Watchtower u. ä.): Updates sollen bewusst passieren.

### Backups und Wiederherstellung

Nutze **Admin → Sicherungen**: Datenbank und Dateien, zeitgesteuert, mit optionalem externem S3-Ziel.
Die Wiederherstellung findest du am selben Ort (nur SUPER_ADMIN). Details: [BACKUP.md](BACKUP.md)
(Englisch). Bewahre außerhalb des Servers auf:

- `APP_ENCRYPTION_KEYS` (und die ganze `.env`),
- das externe Backup-Ziel.

Die Daten liegen in Docker-Volumes des Projekts `tix`: `tix_postgres-data`, `tix_redis-data`,
`tix_minio-data`, `tix_caddy-data` und `tix_storage-credentials` (die erzeugten Speicher-Passwörter, siehe
[Zugangsdaten des Dateispeichers](#zugangsdaten-des-dateispeichers-minio-nichts-einzutragen); für die Wiederherstellung eines Backups nicht nötig). Mit `docker volume ls` siehst du sie.

### Deinstallation

```bash
cd tix
docker compose down        # stoppt und entfernt die Container, BEHÄLT deine Daten
docker compose down -v     # LÖSCHT zusätzlich alle Daten (Datenbank, Dateien, Zertifikate) - unwiderruflich
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

Nur der erste Block ist Pflicht. Alles andere hat einen Standardwert in `docker-compose.yml`; die
Zeilen mit „optional“ sind in der heruntergeladenen `.env` auskommentiert (zum Verwenden das
`#` entfernen).

| Variable                                                                             | Pflicht   | Bedeutung                                                                                                                                                                                                                                                                                                                        | Beispiel                      |
| ------------------------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `PUBLIC_URL`                                                                         | **ja**    | Die Adresse, die Besucher eintippen, mit `https://` und ohne Schrägstrich am Ende.                                                                                                                                                                                                                                               | `https://tickets.example.org` |
| `POSTGRES_PASSWORD`                                                                  | **ja**    | Datenbank-Passwort (nur Buchstaben und Ziffern).                                                                                                                                                                                                                                                                                 | `3f9a…` (48 Hex-Zeichen)      |
| `REDIS_PASSWORD`                                                                     | **ja**    | Redis-Passwort (nur Buchstaben und Ziffern).                                                                                                                                                                                                                                                                                     | `b71c…`                       |
| `APP_ENCRYPTION_KEYS`                                                                | **ja**    | Schlüsselring: `id:base64key`, 32 Zufallsbytes in Base64 (44 Zeichen, endet auf `=`). Mehrere Schlüssel mit Komma getrennt; der erste verschlüsselt. **Sichern!**                                                                                                                                                                | `k1:Zm9v…YmFy=`               |
| `SESSION_SECRET`                                                                     | **ja**    | Zufallstext mit mindestens 32 Zeichen für signierte Cookies.                                                                                                                                                                                                                                                                     | `e4b8…` (64 Hex-Zeichen)      |
| `SITE_ADDRESS`                                                                       | vorbelegt | Nur der Domainname: Caddy holt dann selbst Zertifikate (der Schnellstart setzt ihn). `:80` bedeutet reines HTTP (hinter einem anderen Proxy oder für Tests).                                                                                                                                                                     | `tickets.example.org`         |
| `HTTP_PORT`                                                                          | vorbelegt | Host-Port für HTTP. `80`, wenn Caddy der öffentliche Eingang ist.                                                                                                                                                                                                                                                                | `80`                          |
| `HTTPS_PORT`                                                                         | vorbelegt | Host-Port für HTTPS. `443`, wenn Caddy der öffentliche Eingang ist.                                                                                                                                                                                                                                                              | `443`                         |
| `TIX_CHANNEL`                                                                        | vorbelegt | Welche Image-Version läuft: `next`, `stable`, `1`, `1.0` oder eine genaue Version. Siehe [Updates](#updates-backups-deinstallation).                                                                                                                                                                                             | `next`                        |
| `TRUSTED_PROXIES`                                                                    | optional  | Nur wenn ein weiterer Reverse-Proxy davorsteht: dessen Adresse(n) oder `private_ranges`. Leer lassen, wenn Caddy der öffentliche Eingang ist.                                                                                                                                                                                    | `private_ranges`              |
| `COMPOSE_PROJECT_NAME`                                                               | optional  | Namenspräfix der Container und Volumes. Nach dem ersten Start nicht ändern (du bekämst leere neue Volumes).                                                                                                                                                                                                                      | `tix`                         |
| `LOG_LEVEL`                                                                          | optional  | Log-Detailgrad: `info`, `debug`, `warn`, `error`.                                                                                                                                                                                                                                                                                | `info`                        |
| `POSTGRES_USER`, `POSTGRES_DB`                                                       | optional  | Datenbank-Benutzer und -Name.                                                                                                                                                                                                                                                                                                    | `tix`                         |
| `POSTGRES_MAX_CONNECTIONS`, `WEB_DATABASE_POOL_MAX`, `WORKER_DATABASE_POOL_MAX`      | optional  | Verbindungs-Tuning für große Vorverkäufe. Die Standardwerte passen für Vereine.                                                                                                                                                                                                                                                  | `200`, `40`, `10`             |
| `REDIS_MAXMEMORY`, `REDIS_KEY_PREFIX`                                                | optional  | Speicherlimit von Redis (Sitzsperren werden nie verdrängt) und Präfix aller Redis-Schlüssel.                                                                                                                                                                                                                                     | `1gb`, `tix`                  |
| `WORKER_CONCURRENCY`                                                                 | optional  | Parallele Hintergrundjobs (Mail, PDFs).                                                                                                                                                                                                                                                                                          | `8`                           |
| `S3_REGION`                                                                          | optional  | Name der Speicher-Region; beim mitgelieferten MinIO nicht ändern.                                                                                                                                                                                                                                                                | `us-east-1`                   |
| `S3_BUCKET_ASSETS`, `S3_BUCKET_DOCUMENTS`, `S3_BUCKET_BACKUPS`                       | optional  | Namen der drei Buckets (Bilder, Dokumente/PDFs, Backups).                                                                                                                                                                                                                                                                        | `tix-assets` …                |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | veraltet  | **Werden nicht mehr gebraucht:** Sie werden beim ersten Start erzeugt und im Volume `storage-credentials` gehalten. Nur für früher angelegte Installationen: die alten Werte behalten (werden einmal in das Volume kopiert). Siehe [Zugangsdaten des Dateispeichers](#zugangsdaten-des-dateispeichers-minio-nichts-einzutragen). |                               |
| `TIX_IMAGE_OWNER`                                                                    | optional  | GitHub-Besitzer der Images (`ghcr.io/<owner>/tix-web`). In `docker-compose.yml` vorbelegt; nicht ändern.                                                                                                                                                                                                                         | `renthner`                    |

Absichtlich nicht aufgeführt sind Extras für Spezialfälle (`MINIO_IMAGE`, `MC_IMAGE`).

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
`storage-credentials`, `migrate`.

| Symptom                                                                                               | Ursache                                                                                                                                                      | Lösung                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fehler mit `configs.content`, „unknown key" oder „additional property"                                | Docker Compose ist älter als 2.23.1                                                                                                                          | Docker aus dem offiziellen Repository installieren ([Docker installieren](#docker-installieren)). `docker compose version` muss 2.23.1 oder neuer zeigen.                                                                                                                                                                                                         |
| `manifest unknown` / `not found` beim Laden von `...:stable`                                          | Es gibt noch kein stabiles Release, das Image-Tag `stable` existiert nicht                                                                                   | In der `.env` `TIX_CHANNEL=next` (oder eine genaue Version wie `1.0.0-alpha.3`) setzen, dann `docker compose pull && docker compose up -d`.                                                                                                                                                                                                                       |
| `required variable ... is missing a value` / `set POSTGRES_PASSWORD in .env`                          | Die Variable ist leer oder fehlt, oder die `.env` liegt nicht im aktuellen Ordner                                                                            | Den Befehl im Ordner `tix` ausführen, prüfen, dass die Datei `.env` heißt (nicht `env.example`) und die genannte Variable ausfüllen.                                                                                                                                                                                                                              |
| Fehler wie `password authentication failed`, `invalid URL`, Redis `WRONGPASS`                         | Ein Passwort enthält Sonderzeichen (`@ : / # ? %`) oder Anführungszeichen, oder wurde nach dem ersten Start geändert                                         | Nur Buchstaben und Ziffern, keine Anführungszeichen. Das Datenbankpasswort wird beim Anlegen des Daten-Volumes festgelegt: Eine spätere Änderung von `POSTGRES_PASSWORD` braucht bei einer frischen Installation `docker compose down -v` (löscht Daten) oder eine manuelle Passwortänderung in PostgreSQL.                                                       |
| Browser zeigt eine Zertifikatswarnung oder kein HTTPS                                                 | Caddy bekam kein Zertifikat: DNS falsch, Ports 80/443 gesperrt oder Let's-Encrypt-Limit                                                                      | `docker compose logs proxy`. Prüfen: Domain zeigt auf diesen Server, Ports 80 und 443 offen (auch Hoster-Firewall), `SITE_ADDRESS` ist nur die Domain (ohne `https://`). Bei Rate-Limit-Meldung eine Stunde warten.                                                                                                                                               |
| `port is already allocated` / `address already in use` auf Port 80 oder 443                           | Ein anderer Webserver (apache2, nginx) belegt den Port                                                                                                       | Ihn stoppen (`sudo systemctl disable --now apache2`) oder Variante B/C/D nutzen. `sudo ss -ltnp \| grep -E ':80 \|:443 '` zeigt, wer den Port belegt.                                                                                                                                                                                                             |
| Firewall (ufw) ist an, aber ein Port ist trotzdem erreichbar                                          | Docker veröffentlicht Ports direkt und umgeht ufw-Regeln                                                                                                     | Nur der Proxy veröffentlicht Ports (80/443 oder dein `HTTP_PORT`). Soll ein Port privat bleiben, binde ihn an `127.0.0.1` (`HTTP_PORT=127.0.0.1:8080`). Verlasse dich bei Docker-Ports nicht allein auf ufw.                                                                                                                                                      |
| Plätze aktualisieren sich nicht live; die Browser-Konsole zeigt WebSocket-Fehler                      | Dein Reverse-Proxy leitet WebSockets für `/socket.io` nicht weiter                                                                                           | Variante C: den `/socket.io/`-Block oben verwenden. NPM: Websockets Support aktivieren. Cloudflare: WebSockets müssen an sein.                                                                                                                                                                                                                                    |
| Alle bekommen „zu viele Anfragen", oder das Audit-Log zeigt für alle Besucher eine IP                 | Ein anderer Proxy steht davor, aber `TRUSTED_PROXIES` ist leer                                                                                               | `TRUSTED_PROXIES` auf die Adresse des Proxys oder `private_ranges` setzen, dann `docker compose up -d`. Leer lassen, wenn Caddy der öffentliche Eingang ist.                                                                                                                                                                                                      |
| Handy lässt sich nicht koppeln, meldet „Serveradresse nicht erlaubt"                                  | `http://` mit öffentlicher Adresse oder falsche Server-URL                                                                                                   | `https://` verwenden. `http://` geht nur für private IPs. Einstellungen → Scanner → Server-URL prüfen.                                                                                                                                                                                                                                                            |
| Handy lässt sich nicht koppeln, keine Verbindung oder Zeitüberschreitung                              | Das Handy erreicht `PUBLIC_URL` nicht (Hairpin NAT, VPN, falsche URL)                                                                                        | `PUBLIC_URL` im Browser des Handys im selben WLAN öffnen. Klappt das nicht: mobile Daten nutzen oder den Router beheben (NAT-Loopback / lokales DNS).                                                                                                                                                                                                             |
| Der Kopplungs-QR-Code enthält `localhost`                                                             | Die Scanner-Server-URL ist nicht gesetzt                                                                                                                     | Einstellungen → Scanner → Server-URL auf `PUBLIC_URL` setzen.                                                                                                                                                                                                                                                                                                     |
| Es kommen keine E-Mails an                                                                            | Falsche SMTP-Daten, gesperrter Port, Spam-Ordner                                                                                                             | Einstellungen → E-Mail → **Test-E-Mail senden** zeigt den Fehler. Port 587 (STARTTLS) oder 465 (TLS) probieren; `docker compose logs worker`.                                                                                                                                                                                                                     |
| Backups oder gespeicherte Geheimnisse lassen sich auf einem neuen Server nicht lesen                  | `APP_ENCRYPTION_KEYS` weicht vom alten Server ab                                                                                                             | Die ursprüngliche Schlüsselzeile aus deinem Passwortmanager verwenden. Ohne sie sind die verschlüsselten Daten nicht zu retten; deshalb sicherst du sie.                                                                                                                                                                                                          |
| `minio-init` endete mit Fehlercode, `web` startet nie                                                 | MinIO ist nicht gesund, oder die gespeicherten Speicher-Zugangsdaten passen nicht zu den MinIO-Daten                                                         | `docker compose logs storage-credentials minio minio-init`. Das Volume `storage-credentials` nicht löschen, solange `minio-data` existiert (frische Installation: `docker compose down -v`, neu starten).                                                                                                                                                         |
| `storage-credentials` endet mit „MinIO already holds data but no stored root credential exists“       | Eine bestehende Installation, bei der die alten `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` vor dem ersten Start dieser Version aus der `.env` entfernt wurden | Die alten Werte einmal wieder in die `.env` eintragen (`MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`), `docker compose up -d` ausführen; danach liegen sie im Volume.                                                                                                                                                                                                  |
| Wo sind die MinIO- bzw. Speicher-Zugangsdaten? Was passiert beim Einspielen auf einem anderen Server? | Sie werden beim ersten Start erzeugt und liegen im Docker-Volume `storage-credentials`                                                                       | `docker compose exec minio cat /run/tix-storage/minio-root-password` (auch `minio-root-user`). Das Volume gehört nicht zu den TIX-Backups und wird für die Wiederherstellung nicht gebraucht: Backups sind mit `APP_ENCRYPTION_KEYS` verschlüsselt und enthalten Daten und Dateien, und die neue Installation nutzt ihre eigenen erzeugten Speicher-Zugangsdaten. |
| Ein Dienst ist `unhealthy`                                                                            | Start läuft noch, oder ein Konfigurationsfehler                                                                                                              | Zwei Minuten warten. Dann `docker compose logs --tail 100 <Dienst>`. Der Web-Check ist `GET /api/health` (meldet PostgreSQL, Redis und Worker).                                                                                                                                                                                                                   |
| Checkout zeigt Vorkasse oder PayPal als „Derzeit nicht verfügbar"                                     | Es gibt kein Standard-Empfangskonto (Vorkasse) oder PayPal ist nicht konfiguriert/aktiviert                                                                  | Bank & Zahlungen → Konten & Verbindungen: Konto anlegen und als Standard markieren. PayPal: Einstellungen → Zahlungen.                                                                                                                                                                                                                                            |
| Admin-Login meldet „Zu viele Versuche"                                                                | Mehr als 10 Fehlversuche pro E-Mail-Adresse oder 20 pro IP-Adresse in 15 Minuten (auch durch Skripte/Tests)                                                  | Bis zu 15 Minuten warten; die Sperre läuft von selbst ab. Passwort vergessen: `docker compose run --rm migrate node dist/create-admin.mjs --email du@example.org --reset` gibt ein neues Passwort aus (Rollen bleiben).                                                                                                                                           |
| `docker compose up` / `pull` zeigt minutenlang nichts                                                 | Die Images werden noch geladen                                                                                                                               | Warten oder `docker compose pull` separat ausführen, um den Fortschritt zu sehen.                                                                                                                                                                                                                                                                                 |
| Die Seite zeigt lange „Wartung"                                                                       | Eine Backup-Wiederherstellung läuft                                                                                                                          | Abwarten; `docker compose logs web worker` ansehen.                                                                                                                                                                                                                                                                                                               |

Kommst du nicht weiter, eröffne ein [Issue](https://github.com/Renthner/tix-platform/issues/new/choose)
mit der Ausgabe von `docker compose ps` und den relevanten Logzeilen. **Entferne Passwörter und
Schlüssel, bevor du Logs postest.**
