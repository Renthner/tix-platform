# Umstieg vom Drei-Image-Layout auf das einzelne `tix`-Image

English: [MIGRATE-SINGLE-IMAGE.md](MIGRATE-SINGLE-IMAGE.md)

Releases bis `1.0.0-alpha.27` liefen als `tix-web`, `tix-worker` und `tix-realtime` plus einem
mitgelieferten Caddy-Proxy und einem MinIO-Dateispeicher. Ab dem nächsten Release liefert TIX **ein
Image**, `ghcr.io/renthner/tix`, das Shop, Realtime-Gateway und Worker in einem Container betreibt und
Klartext-HTTP auf Port 8080 spricht. Die neue Compose-Datei hat nur noch drei Dienste (`tix`,
`postgres`, `redis`).

**Deine Daten bleiben, wo sie sind.** Diese Anleitung behält deine PostgreSQL-, Redis- und
MinIO-Volumes und startet das neue Image im **S3-Modus** gegen das MinIO, das du schon hast. Es wird
nichts kopiert und nichts umgewandelt. Im S3-Modus zu bleiben ist dauerhaft unterstützt; du kannst
später auf den neuen Dateisystem-Speicher wechseln (letzter Abschnitt), musst es aber nie.

> Die neue `docker-compose.yml` startet mit deiner alten `.env` nicht, und das neue `tix-update.sh`
> ersetzt keine alte Compose-Datei: Es wird nichts versehentlich verändert. Deine **alte** Kopie von
> `tix-update.sh` kennt das nicht, bricht aber ebenfalls ab („nothing was changed"), weil die neue
> Compose-Datei mit der alten `.env` nicht validiert. Aktualisiere nicht, bevor du dieser
> Anleitung gefolgt bist.

## Was sich ändert

| Vorher                                                           | Nachher                                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `tix-web`, `tix-worker`, `tix-realtime`                          | ein `tix`-Container (`docker compose logs tix`)                                          |
| Einmal-Dienst `migrate`                                          | läuft beim Start von `tix` mit (Migrationen, Seed, Backup vor dem Update)                |
| `docker compose run --rm migrate node dist/create-admin.mjs ...` | `docker compose run --rm tix create-admin --email ... --name ...`                        |
| Caddy (`proxy`) terminiert TLS                                   | dein eigener Reverse-Proxy terminiert TLS (oder Caddy behalten, siehe Schritt 5)         |
| `TIX_CHANNEL`, `PUBLIC_URL` in der `.env`                        | `TIX_VERSION`, `APP_URL` in der `.env`                                                   |
| Redis mit Passwort                                               | Redis im internen Netz ohne Passwort (das alte `REDIS_PASSWORD` wird nicht mehr benutzt) |
| MinIO-Zugangsdaten von `storage-credentials`                     | dieselben Dateien im selben Volume, von `tix` gelesen (`S3_*_FILE`)                      |
| `SESSION_SECRET` in der `.env`                                   | unverändert (behalten, sonst sind alle abgemeldet)                                       |

## Bevor du anfängst

1. **Sichern.** Admin -> Backups: ein vollständiges Backup erstellen und herunterladen. Bewahre deine
   `.env` (`cp .env .env.three-image.bak`) und eine Kopie von `APP_ENCRYPTION_KEYS` außerhalb des
   Servers auf. Behalte die `docker-compose.yml` als `docker-compose.three-image.yml.bak`.
2. Docker Compose 2.23.1 oder neuer (`docker compose version`).
3. Plane eine kurze Downtime ein (ein paar Minuten). **Nie `docker compose down -v`** in diesem
   Ablauf: `-v` löscht die Volumes mit deinen Daten.

## Schritt 1 - den alten Stack stoppen

```bash
cd /pfad/zu/deinem/tix      # der Ordner mit docker-compose.yml und .env
docker compose down         # ohne -v!
docker volume ls | grep tix # postgres-data, redis-data, minio-data, storage-credentials ... müssen noch da sein
```

Die Volume-Namen tragen den Compose-Projektnamen als Präfix (`COMPOSE_PROJECT_NAME`, Standard `tix`:
`tix_postgres-data` ...). Die neuen Dateien benutzen dieselben Namen, die Volumes werden also wieder
verwendet.

## Schritt 2 - die neue Compose-Datei

```bash
mv docker-compose.yml docker-compose.three-image.yml.bak
curl -LO https://github.com/Renthner/tix-platform/releases/latest/download/docker-compose.yml
```

(`releases/latest` zeigt auf das neueste **stabile** Release; solange es nur Vorabversionen gibt,
nimm `releases/download/v<Version>/docker-compose.yml` mit der Version von der Release-Seite.)

## Schritt 3 - `.env` anpassen

Behalte alles, was du hast (vor allem `POSTGRES_PASSWORD`, `APP_ENCRYPTION_KEYS`, `SESSION_SECRET` und
`POSTGRES_USER` / `POSTGRES_DB`, falls du sie geändert hattest). Ergänze oder ändere:

```ini
APP_URL=https://tickets.example.org   # der Wert deiner alten PUBLIC_URL
TIX_VERSION=stable                    # der Wert deines alten TIX_CHANNEL (stable, next, 1, 1.0 oder exakt)
HTTP_PORT=8080                        # siehe unten
TRUSTED_PROXIES=                      # siehe unten
```

`TIX_CHANNEL`, `PUBLIC_URL`, `SITE_ADDRESS`, `HTTPS_PORT` und `REDIS_PASSWORD` werden nicht mehr
gelesen; du kannst sie später löschen (die `.env` wird unverändert an den Container gereicht,
ungenutzte Zeilen schaden nicht).

`HTTP_PORT` und `TRUSTED_PROXIES` hängen davon ab, wie dein Shop erreicht wurde:

- **Ein anderer Reverse-Proxy vor dem mitgelieferten Caddy** (deine `.env` hatte `SITE_ADDRESS=:80`
  und ein `TRUSTED_PROXIES`): `HTTP_PORT` und `TRUSTED_PROXIES` bleiben genau wie sie sind. Dein
  Proxy leitet weiter an denselben Port, jetzt beantwortet direkt von `tix`. Schritt 5 entfällt.
- **Caddy war der öffentliche Eingang mit Domain** (`SITE_ADDRESS=tickets.example.org`, Ports 80/443):
  entweder einen eigenen TLS-Proxy davorsetzen (wie oben) oder Caddy behalten, siehe Schritt 5. Für
  Letzteres setze `HTTP_PORT=127.0.0.1:8081` (dann ist `tix` nur vom Server selbst erreichbar) und
  `TRUSTED_PROXIES=private_ranges`.
- **Reiner HTTP-Test** (`SITE_ADDRESS=:80`): `HTTP_PORT` behalten, `TRUSTED_PROXIES` leer lassen. Nennt
  `APP_URL` einen Host (nicht `localhost`), du öffnest den Shop aber unter einem anderen Namen oder über
  `IP:8080`, antwortet `tix` mit 421: trage den Namen in `TIX_ALLOWED_HOSTS` ein (oder `*`).

Bei einer `https://`-`APP_URL` nimm für `TRUSTED_PROXIES` lieber die **genaue IP/das CIDR-Netz** deines Proxys
statt `private_ranges` (TIX warnt davor) und veröffentliche den Port nur auf der Schnittstelle des Proxys.
Anfragen eines vertrauten Proxys werden von der Host-Prüfung nie abgelehnt; `TIX_ALLOWED_HOSTS` ist also nur für
direkten Zugriff nötig ([Details](INSTALL.de.md#eingebauter-proxy-host-prüfung-und-limits)).

$1
**Lösche die Zeilen `MINIO_ROOT_USER` und `MINIO_ROOT_PASSWORD` aus der `.env`**, falls deine alte Datei sie
hat (Installationen aus der Zeit vor den generierten Zugangsdaten). Die ganze `.env` wird an den
`tix`-Container gereicht, und er darf das MinIO-Administrator-Paar nie sehen; MinIO selbst liest es aus dem
Volume `storage-credentials` (Schritt 4), das Entfernen der Zeilen ist also unbedenklich.

## Schritt 4 - die Override-Datei

**Hast du schon eine `docker-compose.override.yml`?** Dann ersetze sie nicht einfach. Die alten Dienste
gibt es nicht mehr, und ein Override, der weiter `proxy`, `web`, `worker`, `realtime` oder `migrate`
konfiguriert, lässt `docker compose config` scheitern (ein Dienst ohne Image). Wandle sie zuerst um:

- Alles unter `proxy:` (Traefik-Labels, `networks`, `ports: !reset []`, veröffentlichte Ports) wandert nach
  `tix:`. In den Traefik-Labels ändere `loadbalancer.server.port` von `80` auf `8080`.
- Lösche die Abschnitte von `web`, `worker`, `realtime`, `migrate`, `minio-init` und
  `storage-credentials` (Speicherlimits und Ähnliches gibt es in der neuen Compose-Datei nicht; ergänze,
  was du noch brauchst, unter `tix:`).
- Führe dann die folgenden Blöcke in dieselbe Datei ein: eine Datei, ein `services:`-Schlüssel, ein
  `volumes:`-Schlüssel.

Lege `docker-compose.override.yml` neben die `docker-compose.yml`. Compose liest sie automatisch, und
`tix-update.sh` fasst sie nie an; spätere Updates ersetzen nur die `docker-compose.yml`. Sie richtet
`tix` auf dein vorhandenes MinIO und fügt MinIO selbst wieder hinzu (Buckets, Anwendungsbenutzer und
Richtlinie existieren bereits im MinIO-Volume; die Hilfsdienste `storage-credentials` und
`minio-init` werden nicht mehr gebraucht):

```yaml
services:
  tix:
    environment:
      STORAGE_DRIVER: s3
      S3_ENDPOINT: http://minio:9000
      S3_REGION: ${S3_REGION:-us-east-1}
      S3_ACCESS_KEY_ID_FILE: /run/tix-storage/s3-access-key-id
      S3_SECRET_ACCESS_KEY_FILE: /run/tix-storage/s3-secret-access-key
      S3_BUCKET_ASSETS: ${S3_BUCKET_ASSETS:-tix-assets}
      S3_BUCKET_DOCUMENTS: ${S3_BUCKET_DOCUMENTS:-tix-documents}
      S3_BUCKET_BACKUPS: ${S3_BUCKET_BACKUPS:-tix-backups}
      S3_FORCE_PATH_STYLE: 'true'
    volumes:
      - storage-credentials:/run/tix-storage:ro
    depends_on:
      minio:
        condition: service_healthy

  minio:
    image: ${MINIO_IMAGE:-pgsty/minio:RELEASE.2026-08-04T00-00-00Z}
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    command: ['server', '/data', '--console-address', ':9001']
    environment:
      MINIO_ROOT_USER_FILE: /run/tix-storage/minio-root-user
      MINIO_ROOT_PASSWORD_FILE: /run/tix-storage/minio-root-password
    volumes:
      - minio-data:/data
      - storage-credentials:/run/tix-storage:ro
    healthcheck:
      test: ['CMD', 'curl', '-fsS', 'http://127.0.0.1:9000/minio/health/live']
      interval: 5s
      timeout: 3s
      retries: 20

volumes:
  minio-data:
  storage-credentials:
```

Hinweise:

- Das Volume `storage-credentials` enthält vier Dateien des alten Stacks: das MinIO-Root-Paar
  (`minio-root-user`, `minio-root-password`, nur für root lesbar, von `minio` benutzt) und das
  Anwendungspaar (`s3-access-key-id`, `s3-secret-access-key`, Besitzer uid 1000, der Benutzer `node`
  des Images, `tix` kann sie also lesen). `tix` sieht das Root-Paar nie.
- Hast du `MINIO_IMAGE`, `S3_BUCKET_*` oder `S3_REGION` in deiner alten `.env` gesetzt, gelten diese
  Werte, weil das Override sie einsetzt.
- Installationen aus der Zeit vor den generierten Zugangsdaten hatten evtl. `S3_ACCESS_KEY_ID` und
  `S3_SECRET_ACCESS_KEY` in der `.env`: Der alte Stack hat sie einmal ins Volume kopiert, die Dateien
  existieren also; die Klartextwerte aus der `.env` gehen an `tix` und sind mit den Dateien identisch.
  (`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` müssen aus der `.env` entfernt werden, siehe Schritt 3.)
- Redis: Das Override übernimmt das Passwort **nicht**. Redis ist nur im Docker-Netz erreichbar. Dein
  Volume `redis-data` (das Redis-AOF) wird unverändert benutzt; das Passwort war eine
  Servereinstellung, kein Teil der Daten. Nutzt du ein **externes** Redis, setze stattdessen
  `REDIS_URL=redis://:passwort@host:6379/0` unter `tix: environment:` (der mitgelieferte
  `redis`-Dienst ist dann ungenutzt).
- PostgreSQL: Hast du `POSTGRES_USER` / `POSTGRES_DB` nie geändert (beide `tix`), ist nichts zu tun.
  Sonst ergänze im Override unter `tix: environment:` `DB_USER` und `DB_NAME` mit deinen Werten sowie
  unter `postgres:` `environment:` `POSTGRES_USER` / `POSTGRES_DB` und
  `healthcheck: { test: ['CMD-SHELL', 'pg_isready -U <user> -d <db>'] }`. `POSTGRES_PASSWORD` gilt wie
  bisher.
- Das alte Volume `pre-update-backups` wird nicht mehr eingehängt: Das Backup vor dem Update geht jetzt
  in den Bucket `tix-backups`. Dateien, die noch im alten Volume liegen, bleiben dort (auflisten mit
  `docker run --rm -v tix_pre-update-backups:/b alpine ls -la /b`); lösche das Volume, sobald du sie
  nicht mehr brauchst.

## Schritt 5 - Caddy für HTTPS (nur wenn Caddy dein öffentlicher Eingang war)

Überspring diesen Schritt, wenn dein eigener Reverse-Proxy TLS terminiert. Sonst speichere diese
`Caddyfile` neben der Compose-Datei:

```
{$SITE_ADDRESS} {
	encode zstd gzip
	reverse_proxy tix:8080
}
```

und füge den Dienst samt seiner zwei Volumes in `docker-compose.override.yml` ein (die Zertifikate
liegen im Volume `caddy-data` des alten Stacks und werden wieder verwendet):

```yaml
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
    environment:
      SITE_ADDRESS: ${SITE_ADDRESS:?set SITE_ADDRESS in .env}
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
```

(Führe die Blöcke `services:` und `volumes:` mit denen aus Schritt 4 zusammen: eine Datei, ein
`services:`-Schlüssel.) Lass `SITE_ADDRESS=tickets.example.org` in der `.env`, setze
`HTTP_PORT=127.0.0.1:8081` und `TRUSTED_PROXIES=private_ranges` wie in Schritt 3 beschrieben.

## Schritt 6 - starten

```bash
docker compose config -q                 # prüft Compose + .env + Override, gibt bei Erfolg nichts aus
docker compose pull
docker compose up -d --remove-orphans    # entfernt auch die Container der alten Dienste web/worker/realtime/proxy
docker compose logs -f tix               # zuerst laufen die Migrationen; Strg+C, sobald der Shop antwortet
```

Prüfen: Shop und Admin öffnen sich, Bilder und Dokumente laden (sie kommen aus deinem MinIO), Admin ->
System zeigt die neue Version, und `docker compose ps` listet `tix`, `postgres`, `redis`, `minio`
(und `caddy`). Einen Admin legst du bei Bedarf mit
`docker compose run --rm tix create-admin --email du@example.org --name "Dein Name"` an.

Läuft etwas nicht, `docker compose down` und zuerst die Logs lesen. Der Weg **zurück zum alten Layout**
funktioniert nur, wenn das neue Release noch keine Datenbank-Migration angewendet hat (siehe CHANGELOG; eine
Migration läuft beim Start des `tix`-Containers): Dann `docker-compose.three-image.yml.bak` und
`.env.three-image.bak` wieder an ihren Platz legen und den alten Stack mit den alten Image-Tags starten.
Sonst können die alten Images das neuere Schema nicht lesen: Installiere die alte Version frisch und spiele
ein normales Backup zurück, das vor dem Umstieg erstellt wurde (Schritt 1 unter „Bevor du anfängst"). Ein
Backup „Vor dem Update" wird vor der ersten Migration automatisch erstellt (Admin -> Backups); es bringt
deine Daten auf der **neuen** Version zurück, nicht auf der alten.

## Danach

- **Updates** laufen wie bisher mit `./tix-update.sh` (das Skript des neuen Releases einmal
  herunterladen). Es ersetzt nur die `docker-compose.yml`; deine `.env` und das Override bleiben.
- **Aufräumen** nach einer Woche ohne Probleme: `docker image prune` entfernt die alten Images
  `tix-web` / `tix-worker` / `tix-realtime`; `docker volume rm tix_pre-update-backups`, sobald dessen
  Dateien nicht mehr gebraucht werden.
- **GitHub-Pakete:** Die alten `tix-*`-Pakete werden nicht mehr gebaut; vorhandene Tags bleiben ladbar.

## Optional: später auf den Dateisystem-Speicher wechseln

Der neue Standard legt Dateien in einem normalen Verzeichnis auf dem Volume `tix-data` ab statt in MinIO
(siehe [STORAGE.md](STORAGE.md)). Es gibt keinen Umwandler und keinen Bedarf dafür. Wenn du MinIO
trotzdem loswerden willst:

1. Admin -> Backups: ein vollständiges Backup (Datenbank + Dateien) auf der laufenden S3-Installation
   erstellen und herunterladen.
2. Eine zweite, leere Installation mit der Standard-Compose-Datei aufsetzen (kein Override, neue
   Volumes, anderer `COMPOSE_PROJECT_NAME`, **derselbe `APP_ENCRYPTION_KEYS`**) in derselben Version.
3. Im Admin der neuen Installation das Backup hochladen (Backups -> Hochladen) und wiederherstellen.
   Datenbank und Dateien landen im neuen Speicher; Shop prüfen, dann DNS / Proxy umstellen und den
   alten Stack abschalten.

Bedenke: Backups auf demselben Volume wie die Dateien überstehen den Verlust der Platte nicht;
richte unter Admin -> Backups ein externes Backup-Ziel ein.
