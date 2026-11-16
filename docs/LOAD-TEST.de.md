# Lasttest

Das Versprechen der Plattform: **mehr als 1.000 Käufer:innen kämpfen um dieselben Plätze, ohne
Doppelbuchungen, Race Conditions oder Deadlocks**. Es gibt zwei Werkzeuge für zwei Fragen:

| Werkzeug                        | Frage                                                                                                          | Voraussetzung                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `scripts/load/journey.mjs`      | Wie verhält sich **dieser** Server (produktionsnah, mit Proxy / CDN / WAF) unter 1.000+ realistischen Käufern? | laufender Server, **Token des Lasttest-Modus**, veröffentlichtes Testevent |
| `scripts/load/run.mjs` (Teil B) | Halten die **Invarianten** von Sitzplatzsperre, Warteraum und Kasse (Abgleich mit Redis und PostgreSQL)?       | Docker; baut einen eigenen, isolierten Stack auf und wieder ab             |

Die englische Fassung ([LOAD-TEST.md](LOAD-TEST.md)) enthält zusätzlich Teil B (isolierter Stack,
Referenzergebnisse, Tuning) im Detail. Diese Seite deckt Teil A ab, den Lasttest gegen einen
echten Server.

## Was der Journey-Test macht

`journey.mjs` startet mehrere Generator-Prozesse (Standard `min(CPUs, ceil(Nutzer/250))`, höchstens
8), die zusammen N Käufer:innen simulieren. Jede:r hat ein eigenes Session-Cookie und durchläuft
den Weg eines echten Besuchers:

1. Startseite des Shops und (mit `--event-slug`) die Eventseite,
2. `POST /enter` und, falls ein Warteraum aktiv ist, Abfragen von `/queue` und `/claim` bis zur Zulassung,
3. Saalplan und Verfügbarkeit,
4. WebSocket-Abo (Socket.io) auf die Sitzplatz-Ereignisse,
5. Kampf um dieselben **Hot Seats** (Standard 20, je drei Versuche),
6. Bestplatzbuchung (Standard 30 %), ein bis zwei zufällige Plätze, einige geben einen Platz zurück,
7. Warenkorb etwa eine Minute halten (Warenkorb lesen), dann `DELETE /api/cart` (Aufräumen),
8. optional eine Bestellung per Vorkasse (`--checkout-ratio`, nur auf einer eigenen Kopie).

Gemessen und geprüft wird:

- p50 / p95 / p99 / Maximum der Antwortzeit, Status- und Fehlercode-Zähler je Endpunkt, Anfragen pro Sekunde;
- Raten von 5xx / Netzwerkfehlern, **429** (ein IP-Limit hat den Test verfälscht) und **503** (System ausgelastet);
- **WebSocket-Verteilzeit**: vom Senden einer Platzsperre bis das `seats:delta` an den eigenen
  Sockets des Generators ankommt (gleiche Rechneruhr, keine Zeitabweichung);
- **Exklusivität der Hot Seats**: jede Sperr-Antwort und jede Freigabe wird mit Zeitstempel
  aufgezeichnet; halten zwei verschiedene Sessions nachweislich denselben Platz zur selben Zeit,
  ist das eine Doppelbuchung und der Lauf schlägt fehl (auch für zufällige und Bestplatz-Buchungen);
- **keine hängenden Sperren**: nachdem alle Warenkörbe geleert sind, ist kein Platz gesperrt, der es vorher nicht war;
- optional `--database-url`: lesende SQL-Prüfung (schreibgeschützte Sitzung), dass kein Platz in zwei
  aktiven Bestellpositionen steckt; private / LAN-Datenbankhosts werden abgelehnt, außer mit `--allow-private`;
- Momentaufnahmen von `/__tix/health` und (mit `--metrics-token`) `/api/metrics` vor und nach dem
  Lauf sowie Spitzenwerte alle 10 s (Speicher, Datenbankverbindungen, Redis, Sockets, Sperren).

Ausgabe: eine Zusammenfassung auf der Konsole und eine maschinenlesbare JSON-Datei
(`scripts/load/results/journey.json` oder `--out`). Exit-Code `0` alle Prüfungen bestanden, `1`
eine Prüfung ist fehlgeschlagen, `2` abgelehnt / nicht lauffähig. Das Token erscheint weder in der
Ausgabe noch in der JSON-Datei.

## Sicherheitsgurte des Generators

- `--target` ist Pflicht und hat keinen Standardwert; `http://localhost:8080` und `:3000` (der
  normale Stack und der Dev-Server) werden abgelehnt.
- Ein echter Lauf braucht `--yes` **und** das Token des Lasttest-Modus (`--loadtest-token`, besser die
  Umgebungsvariable `TIX_LOADTEST_TOKEN`, die nicht in der Prozessliste steht).
- `--dry-run` zeigt den Plan und sendet nichts.
- Antworten mehr als 20 % der Anfragen mit 429 (falsches Token, Modus nicht aktiv, Proxy davor
  bremst den Generator), bricht der Lauf von selbst ab und räumt die Warenkörbe auf.
- `Strg+C` beendet die Käufer geordnet und leert die Warenkörbe; die Warenkorb-Uhr (Sperr-TTL) ist
  das Sicherheitsnetz für alles, was nicht aufgeräumt werden konnte.
- Bestellungen brauchen `--checkout-ratio` **und** `--allow-orders`: die Kasse erzeugt echte
  Bestellungen und stellt echte E-Mails an `load-...@example.invalid` in die Warteschlange. Nur auf
  einer eigenen Kopie mit SMTP-Senke, niemals in Produktion.

## Lasttest-Modus (Serverseite)

IP-Limits sind der richtige Schutz gegen automatisierten Missbrauch, und genau das blockiert einen
Lastgenerator, der von einer einzigen Adresse kommt. Admin -> **System** -> _Lasttest-Modus_
schaltet sie **für Anfragen mit einem geheimen Token und nur befristet** ab:

1. Als SUPER_ADMIN anmelden (am Konto muss eine Authenticator-App oder ein Passkey eingerichtet sein).
2. Dauer wählen (5 Minuten bis 4 Stunden, Standard 60), Passwort **und einen frischen zweiten
   Faktor** eingeben (Authenticator- oder Wiederherstellungscode oder eine an diese Aktion gebundene
   Passkey-Bestätigung - dass das Konto einen zweiten Faktor hat, genügt nicht), **Aktivieren** klicken.
3. Token kopieren. Es wird nur einmal angezeigt; gespeichert wird nur der SHA-256-Hash (in Redis, mit TTL).
4. Solange der Modus aktiv ist, zeigt jede Admin-Seite ein rotes Banner, und die System-Seite hat
   den Knopf **Jetzt deaktivieren**. Der Modus endet von selbst. `loadtest.enable`,
   `loadtest.disable` und `loadtest.expire` stehen im Audit-Log (mit der Zahl der übersprungenen
   Anfragen, nie mit dem Token).

Was eine Anfrage mit dem Header `X-Tix-Loadtest: <Token>` bei aktivem Modus überspringt, und
sonst nichts:

| Limit (Redis-Bucket) | Bedeutung                                                                           |
| -------------------- | ----------------------------------------------------------------------------------- |
| `shop-ip`            | Platz-, Stehplatz- und Bestplatz-Anfragen je IP (Einstellung "Platzanfragen je IP") |
| `checkout-ip`        | Bestellungen je IP (Einstellung "Bestellungen je IP", standardmäßig aus)            |
| `enter-ip`           | Eintritt in Shop / Warteraum                                                        |
| `realtime-token-ip`  | Realtime-Token für den WebSocket                                                    |

Bewusst **nicht** übersprungen: Anmeldung, Zwei-Faktor, Passkey, Passwort-Zurücksetzen und andere
Fehlversuch-Limits, Scanner-Authentifizierung, Limits gegen das Erraten von VIP- und Rabattcodes
(`code-ip`, `discount-code-ip`), Limits der Warteliste-Mails, Ticket-Selbstbedienung und
-Weitergabe, PayPal-Webhook, Limits je Session (`shop-session`, `checkout`, `presence`), je
E-Mail-Adresse und je Code, Bestellgrenzen, die Sitzplatzsperre selbst sowie CSRF- / Origin-Prüfungen.
Der Header wird ignoriert, wenn der Modus aus ist; ein falsches Token wirkt wie kein Header; der
Vergleich läuft in konstanter Zeit (Hash des Tokens); in den Logs wird der Header geschwärzt. Ein
Unit-Test legt das Überspringen auf genau diese vier Buckets fest. Ein Deaktivieren wirkt nach etwa
einer Sekunde (jeder Prozess puffert den Zustand eine Sekunde).

Anonyme Käufer können keine ENTWURF-Events öffnen (das ist ein Super-Admin-Recht, das Token
erweitert es **nicht**). Das Ziel muss also ein **veröffentlichtes** Event sein, am besten ein
nicht verlinktes Testevent.

## Welche Umgebung?

| Option                                                           | Wann                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Eigene Kopie** (eigener Stack, Backup eingespielt, SMTP-Senke) | Standardempfehlung: Kapazitätstests, Kassentests, alles, was Bestellungen erzeugt oder kaputtgehen darf.                                                                                                                 |
| **Produktion**                                                   | Nur um die echte Kette (CDN, WAF, Proxy, TLS, Limits) mit einem _veröffentlichten Testevent_ zu prüfen, außerhalb eines Verkaufs, nur Warenkorb (keine Kasse), kurz und mit Anlauf. Nie während eines Vorverkaufsstarts. |
| Isolierter Stack aus Teil B                                      | Invarianten- und Regressionsläufe auf dem Laptop / in der CI.                                                                                                                                                            |

Ein Laptop an einem Heimanschluss kann 1.000 Nutzer nicht ehrlich in Produktionsgeschwindigkeit
erzeugen: starte den Generator auf einem VPS in derselben Region wie der Server und rechne mit
einer vCPU je ~250 Nutzer.

## Schritt für Schritt in Produktion

1. **Testevent vorbereiten.** Ein Event mit kleinem Saalplan (einige hundert Plätze) anlegen,
   veröffentlichen, Verkauf öffnen, Bestellgrenzen großzügig und die Einzelplatz-Regel aus. Nicht
   verlinken (zum Beispiel ferner Vorverkaufsstart mit Zugangscode) und die Warteraum-Einstellungen
   echter Events in Ruhe lassen. Die Event-ID steht in der URL der Admin-Eventseite.
2. **Adresse des Generators.** Den Generator auf einem Rechner mit fester öffentlicher IP laufen
   lassen, hier `203.0.113.7`.
3. **Cloudflare** (falls der Shop dahinter liegt): _Security -> WAF -> Custom rules_, Aktion **Skip**
   (alle Rate-Limiting-Regeln, Bot Fight Mode / Super Bot Fight Mode, Security Level, Managed Rules
   nach Bedarf), Ausdruck
   `(ip.src eq 203.0.113.7 and any(http.request.headers["x-tix-loadtest"][*] ne ""))`.
   Während des Tests nicht "I'm Under Attack" aktivieren. Cloudflare sieht den Generator als einen
   sehr aktiven Besucher, und die Nutzungsbedingungen verlangen, große Tests auf proxied Hostnamen
   anzukündigen. Sauberer ist ein reiner DNS-Testhostname (graue Wolke) auf den Origin, der auch das
   CDN aus der Messung nimmt. Dieser Shop markiert `/api/*` und sein HTML nie als cachebar
   (`no-store`); prüfe es trotzdem am Header `cf-cache-status`.
4. **Traefik / dein Reverse Proxy.** Rate-Limit- und In-Flight-Middleware für den Generator
   entfernen oder umgehen, zum Beispiel mit einem Router höherer Priorität ohne diese Middleware:

   ```yaml
   - traefik.http.routers.tix-loadtest.rule=Host(`shop.example.org`) && ClientIP(`203.0.113.7/32`)
   - traefik.http.routers.tix-loadtest.priority=100
   - traefik.http.routers.tix-loadtest.service=tix
   ```

   (ohne `rateLimit` / `inFlightReq`). nginx: `map $remote_addr $limit_key { 203.0.113.7 ""; default $binary_remote_addr; }`
   und `limit_req_zone $limit_key ...` (ein leerer Schlüssel wird nicht begrenzt); für 1.000+
   WebSockets `worker_connections` erhöhen. Der Proxy muss `Upgrade` / `Connection` durchreichen und
   darf unbekannte Request-Header nicht entfernen (die üblichen tun das nicht; der eingebaute Proxy
   des Images reicht `X-Tix-Loadtest` unverändert durch, ein Unit-Test sichert das).

5. **CrowdSec / fail2ban.** CrowdSec: `cscli allowlists create loadtest -d "Lasttest"`, dann
   `cscli allowlists add loadtest 203.0.113.7`. fail2ban: `fail2ban-client set <Jail> addignoreip 203.0.113.7`
   für jeden Jail, der das Access-Log des Proxys liest. Beides nach dem Test wieder entfernen.
6. **`TRUSTED_PROXIES` und der eingebaute Proxy.** Die Client-Adresse, die die Anwendung sieht,
   stammt aus dem `X-Forwarded-For` eines vertrauten Proxys (`TRUSTED_PROXIES`, siehe INSTALL.de.md);
   hinter Cloudflare / Traefik ist es die öffentliche IP des Generators. Versuche **nicht**,
   Client-Adressen zu fälschen: ein gefälschtes `X-Forwarded-For` wird ignoriert, sofern der Peer
   kein vertrauter Proxy ist, und das Lasttest-Token ist der vorgesehene Weg an den IP-Limits
   vorbei. Der eingebaute Proxy begrenzt zusätzlich die gleichzeitigen Verbindungen je Client-Adresse,
   die kein vertrauter Proxy ist (`TIX_PROXY_MAX_CONNS_PER_IP`, Standard 200); Verbindungen über
   einen vertrauten Proxy sind ausgenommen. Spricht der Generator **direkt** mit dem Container (eine
   Staging-Kopie ohne Proxy davor), hält jeder Nutzer eine HTTP-Verbindung und einen WebSocket:
   setze für die Dauer des Tests `TIX_PROXY_MAX_CONNS_PER_IP=0` (oder mindestens die doppelte
   Nutzerzahl) und danach wieder den Standard. Schwäche den Standard nicht dauerhaft.
7. **Lasttest-Modus aktivieren** (siehe oben). Token kopieren und Endzeit notieren.
8. **Metriken (optional, empfohlen).** Einstellungen -> Sicherheit -> Prometheus-Endpunkt: ein
   Metrik-Token anlegen und als `TIX_METRICS_TOKEN` übergeben.
9. **Trockenlauf, dann kleiner Lauf.**

   ```bash
   export TIX_LOADTEST_TOKEN=...   # von der Admin-Seite
   node scripts/load/journey.mjs --target https://shop.example.org --event-id <uuid> --dry-run
   node scripts/load/journey.mjs --target https://shop.example.org --event-id <uuid> --yes \
        --vus 100 --ramp 30s --duration 2m
   ```

   Erst weitermachen, wenn das mit 429 = 0 besteht.

10. **Der echte Lauf**, zum Beispiel 1.200 Nutzer, Anlauf 90 s, fünf Minuten:
    `node scripts/load/journey.mjs --target ... --event-id ... --event-slug <slug> --yes --vus 1200 --ramp 90s --duration 5m --metrics-token ...`
    Daneben Admin -> System beobachten (Datenbankverbindungen, Redis, Sockets, Sperren).
11. **Deaktivieren** (Knopf auf der System-Seite), danach Cloudflare-Regel, Proxy-Ausnahmen,
    CrowdSec- / fail2ban-Einträge und die Änderung an `TIX_PROXY_MAX_CONNS_PER_IP` entfernen.
12. **Aufräumen.** Ohne `--checkout-ratio` hinterlässt der Test keine Bestellungen; Warenkörbe sind
    geleert, übrige Sperren laufen per TTL ab. Testevent archivieren oder zurückziehen. Mit
    `--checkout-ratio` auf der eigenen Kopie die Bestellungen stornieren und das Event dort löschen
    (ein Event mit Bestellungen lässt sich in einem Live-System nicht löschen, GoBD).

## Optionen

| Option                                                                                                       | Bedeutung                                                                         |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `--target`, `--event-id`, `--event-slug`                                                                     | Server, Event, optionale öffentliche Eventseite                                   |
| `--yes`, `--dry-run`                                                                                         | bestätigen / nur den Plan ausgeben                                                |
| `--loadtest-token` / `TIX_LOADTEST_TOKEN`                                                                    | Token des Lasttest-Modus                                                          |
| `--vus` (1000), `--workers`, `--ramp` (60s), `--ramp-profile`                                                | Nutzer, Prozesse, Anlauf (`linear`, `step` = 5 Schübe, `spike` = alle auf einmal) |
| `--duration` (4m), `--hold` (60s, höchstens 8m)                                                              | Gesamtdauer inklusive Anlauf, mittlere Haltezeit des Warenkorbs                   |
| `--hot` (20), `--best-available` (0.3), `--ws-ratio` (1)                                                     | umkämpfte Plätze, Anteil Bestplatz / WebSocket                                    |
| `--checkout-ratio` mit `--allow-orders`                                                                      | Anteil mit Vorkasse-Bestellung (nur eigene Kopie)                                 |
| `--metrics-token` / `TIX_METRICS_TOKEN`, `--database-url`                                                    | Ressourcen-Momentaufnahmen, optionale lesende Doppelbuchungs-Prüfung per SQL      |
| `--max-failure-rate` (0.01), `--max-429-rate` (0.001), `--max-503-rate` (0.02), `--max-fanout-p95-ms` (2000) | Grenzen der Prüfungen                                                             |

Halte die Haltezeit deutlich unter der Warenkorb-Uhr (Standard 10 Minuten): eine Sperre, die
während des Tests abläuft, darf ein anderer legitim bekommen, was die Exklusivitätsprüfung nicht
von einer Doppelbuchung unterscheiden kann.

## Ergebnisse lesen

- **Eine fehlgeschlagene Exklusivitäts- oder Leck-Prüfung ist das einzige echte Fehlersignal**; alles andere ist Kapazität.
- **429 über 0,1 %**: gemessen wurde das Limit, nicht das System. Falsches Token oder abgelaufener
  Modus, WAF / Proxy / CrowdSec davor, oder ein Limit, das das Überspringen nicht abdeckt (siehe Spalte Endpunkt).
- **503 / `BUSY`**: Sperr-Timeouts oder erschöpfter Verbindungspool der Datenbank unter Konkurrenz;
  siehe "Tuning" in der englischen Seite (`WEB_DATABASE_POOL_MAX`, PostgreSQL `max_connections`).
- **5xx und `TIMEOUT` bei niedriger Server-CPU**: der Generator selbst (CPU, `ulimit -n`) oder der
  Netzwerkweg; Generator-CPU ansehen und `--workers` erhöhen.
- **LOCK_HOT** ist eine Konkurrenzzahl (alle Nutzer auf 20 Plätzen); `LOCK_RANDOM` und `SEATMAP`
  kommen normalem Surfen näher. Eine gesunde Verteilzeit (p95) liegt deutlich unter einer Sekunde.
- Die Antwortzeit enthält das Netz zwischen Generator und Server; miss aus derselben Region.

## Den Engpass finden

Laufen viele Anfragen in den Timeout (30 s, Status 0), obwohl die CPU des Web-Containers ruhig
aussieht, zeigt der Generator, wo man suchen muss. Mit `--metrics-token` liest er alle 5 s
`/api/metrics` (vier schnelle Anfragen pro Takt, damit mehrere Web-Prozesse erfasst werden) und
behält den **Spitzenwert je Metrik und `pid`** im JSON (`resources.peaksDuringRun`); die Ausgabe
enthält einen Block "diagnosis hint", wenn mehr als 1 % der Anfragen in den Timeout liefen. Dieselben
Werte zeigt die System-Seite in der Karte "Auslastung des Web-Prozesses" (bei mehreren Web-Prozessen
zeigt jede Aktualisierung den Prozess, der gerade geantwortet hat).

| Metrik (je Web-Prozess, Label `pid`)                                           | Bedeutung                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `tix_db_pool_connections{state="total"}`, `idle`, `waiting`, `tix_db_pool_max` | Datenbank-Pool des Prozesses; `total - idle` = in Benutzung; **waiting** = Anfragen, die auf eine Verbindung warten |
| `tix_event_loop_lag_seconds{quantile="0.5"}`, `0.99`, `max`                    | wie spät die Event Loop (ein Thread) antwortet (10-ms-Timer, Fenster von 10-20 s)                                   |
| `tix_process_cpu_seconds_total`                                                | CPU-Zeit des Prozesses (die Rate ist der Anteil eines Kerns)                                                        |

So liest man sie:

- **Pool waiting > 0** (Spitzenwert): Anfragen warten auf eine Datenbankverbindung.
  `WEB_DATABASE_POOL_MAX` erhöhen (`TIX_DB_CONNECTION_BUDGET` und PostgreSQL `max_connections`
  beachten) und langsame Abfragen suchen (`tix_postgres_longest_query_seconds`). Braucht ein Abruf
  für den Datenbankteil mehr als 4 s, liefert der Endpunkt nur die Prozesswerte mit
  `tix_scrape_degraded 1`: Datenbank oder Pool sind überlastet.
- **Event-Loop-Verzögerung p99 über etwa 200 ms**: der Web-Prozess hängt an der CPU (auch wenn der
  Container-Durchschnitt niedrig aussieht, weil ein Prozess einen Kern nutzt). `TIX_WEB_PROCESSES`
  erhöhen oder der VM mehr CPU geben.
- **Beides niedrig, aber Timeouts** ("not CPU/DB/event-loop bound as seen by the server"): die Zeit
  geht außerhalb der Anwendung verloren. Netzwerkweg prüfen: Cloudflare, Traefik / Reverse Proxy,
  FritzBox / Router, Uplink von Generator und Server. Die Zusammenfassung nennt die empfangenen Bytes
  gesamt und pro Sekunde (dekodierte Bodys, ohne WebSocket-Verkehr): vergleiche das mit dem Uplink
  und mit `docker stats` NET I/O von Proxy und `tix`-Container im selben Zeitraum. Ein ausgelasteter
  Uplink zeigt sich als Timeouts bei ruhigem Server.
- **Timeouts je Endpunkt**: Timeouts bei billigen Endpunkten (`AVAILABILITY`) ebenso wie bei teuren
  deuten auf eine gemeinsame Warteschlange (Pool, Event Loop, Netz) statt auf eine langsame Abfrage.
- **Unbestimmte Überlappungen** (eine WARN, nie ein Fehler): eine Freigabe-Anfrage (`UNLOCK`,
  `CART_CLEAR`, `PROBE_UNLOCK`) lief in den Timeout, der Generator kann also nicht wissen, ob der
  Server den Platz freigegeben hat, bevor eine andere Sitzung ihn bekam. Nur eine _sichere_
  Überlappung lässt den Lauf fehlschlagen.

Was während eines Laufs auf dem Server zu beobachten ist:

- `docker stats` für **alle** Container (`tix`, Postgres, Redis, Proxy), nicht nur den Web-Container:
  CPU, Speicher und NET I/O. Ein ausgelasteter Postgres- oder Redis-Container erklärt langsame
  Antworten eines ruhigen Web-Prozesses.
- `top` (oder `vmstat 1`) auf der VM / dem Host: hohes `wa` (I/O-Wait) heißt langsame Platten, hohes
  `st` (Steal) heißt, der Hypervisor gibt der VM weniger CPU, als sie anzeigt (typisch bei geteilten
  Proxmox-Hosts).

## Einschränkungen

- Ein CDN oder eine WAF kann den Generator trotz Token begrenzen oder herausfordern; die
  `statuses`-Spalten zeigen 403- / 429- / 5xx-Antworten davon.
- Der Generator berichtet, was er von außen sieht; die Auslastung des Servers zeigen die
  System-Seite und die Metrik-Momentaufnahmen.
- Die IP-Limits selbst werden mit eingeschaltetem Token nicht geprüft. Teste sie getrennt ohne Token
  (ein kleiner Lauf mit falschem Token muss 429 liefern).
- Ein Testevent bringt Sitzplatzsperren, Sockets und Shop-Sessions in ein Live-System; das Dashboard
  ("im Shop") zeigt sie an.

## Größenhinweise

- Der Web-Teil ist CPU-gebunden: die Seiten werden je Anfrage gerendert, und ein Web-Prozess nutzt
  standardmäßig etwa einen Kern. Setze `TIX_WEB_PROCESSES` (`auto` = die CPUs des Containers, siehe
  [INSTALL.de.md](INSTALL.de.md#auf-mehr-kerne-skalieren)), um mehr zu nutzen: plane 2-4 vCPU für den
  Container bei 1.000 Nutzern im Vorverkaufsstart, dazu PostgreSQL und Redis auf demselben Host. Gemessen
  auf einer Maschine mit 600 simulierten Käufer:innen und einem auf 4 CPUs begrenzten Container: ein
  Web-Prozess war ausgelastet (Warenkorb-Anfragen p95 1,5 s, Platz-Anfragen p50 1,0 s), drei Prozesse
  bewältigten dieselbe Last mit Warenkorb p95 0,11 s und Platz p50 0,04 s. Das Realtime-Gateway
  (Live-Platzupdates) bleibt ein einzelner Prozess und zeigte in beiden Läufen ein Fan-out-p95 von etwa 3 s.
- Datenbankverbindungen: Web-Prozesse x (`WEB_DATABASE_POOL_MAX` + 2) + Worker + Realtime müssen unter
  PostgreSQL `max_connections` bleiben. Ohne explizites `WEB_DATABASE_POOL_MAX` wird das Budget von 20
  durch `TIX_WEB_PROCESSES` geteilt; das Startprotokoll nennt das Maximum und warnt ab 80.
- Redis ist bei dieser Größe nicht der Engpass (die Lua-Sperren sind O(1)); beobachte
  `tix_redis_used_memory_bytes` und die Clientzahl.
- Etwa ein WebSocket je Käufer:in auf dem Saalplan; das Realtime-Gateway ist ein Node-Prozess
  (`tix_realtime_sockets`, Verteilzeit).

## Testevent mit großem Saalplan

Der Demo-Plan hat nur ein paar hundert Plätze. Um Saalplan, Shop-Cache und das Realtime-Fan-out mit
einer realistischen Halle zu testen, erzeugst du einen Plan mit etwa 3.600 Plätzen und importierst
ihn wie jede andere Plandatei:

```bash
node scripts/load/make-seatplan.mjs --seats 3600 --out loadtest-seatplan.tixplan.json
```

Optionen: `--seats N` (100 bis 90.000, Standard 3.600), `--out <Pfad>`, `--name <Planname>`. Die Datei
ist deterministisch (gleiche Optionen, gleiche Datei) und enthält weder Bilder noch eigene Symbole.
Bei 3.600 Plätzen ist sie 1,2 MB groß (das Upload-Limit des Imports liegt bei 40 MB). Aufbau: eine
Bühne oben, ein Eingang, drei Preiskategorien (Cat 1 rot, Cat 2 blau, Cat 3 grün), sieben Blöcke in
geraden Reihen mit 20-28 Plätzen (Parkett links / Mitte / rechts, Balkon links / Mitte / rechts,
Loge; die drei Spalten fluchten, damit die Tastaturnavigation über Blöcke hinweg funktioniert),
Reihenbeschriftung, Sitznummern und vier Rollstuhl-/Begleitplatz-Paare. Plätze je Block: 600 / 780 /
600 / 420 / 420 / 420 / 360; je Kategorie: Cat 1 780 (Parkett Mitte), Cat 2 1.980, Cat 3 840.

1. **Plan importieren.** Admin -> **Spielstätten & Pläne** -> eine Spielstätte öffnen (vorher eine
   Test-Spielstätte anlegen) -> Karte **Saalplan importieren** -> Datei wählen. Die Vorschau zeigt 7
   Blöcke, 152 Reihen, 3.600 Plätze und die Kategorien; Namen übernehmen oder ändern, **Plan
   importieren** klicken. Der neue Hauptplan öffnet sich im Editor (der Import dauert etwa eine
   Sekunde).
2. **Veranstaltung anlegen.** Admin -> **Veranstaltungen** -> **Neue Veranstaltung**: Titel,
   Spielstätte, **Saalplan** = der importierte Plan, Beginn, Zeitzone, Währung und Steuersatz; die
   **Einzelplatz-Regel** für Lasttests ausschalten; **Veranstaltung anlegen**. Die drei
   Plan-Kategorien werden zu Preiskategorien der Veranstaltung.
3. **Preise.** Tab **Preise** der Veranstaltung: Cat 1, Cat 2 und Cat 3 einen Preis für den Tarif
   geben (ohne Preis ist eine Kategorie nicht verkäuflich).
4. **Verkauf.** Tab **Verkauf**: großzügige Bestelllimits (leer = unbegrenzt), **Plätze im Saalplan
   wählen** an lassen und **Bestplatzbuchung** einschalten (das Bestplatz-Feld im Shop bietet dann
   alle drei Kategorien an; Parkett Mitte wird zuerst vergeben).
5. **Veröffentlichen.** Tab **Details** (Karte Status): Status **Veröffentlicht**, **Status
   übernehmen**. Anonyme Käufer:innen und damit der Lastgenerator können nur veröffentlichte
   Veranstaltungen öffnen; auf einem Live-System das Event deshalb unverlinkt halten (kein Link,
   Vorverkauf weit in der Zukunft mit Zugangscode).
6. **Warteraum.** Den Warteraum der Veranstaltung (Tab **Warteraum**) **aus** lassen, um Saalplan und
   Sperren zu messen. Ein zweiter Lauf mit Modus `AUTO_THRESHOLD` und einer Schwelle deutlich unter der
   Zahl der simulierten Nutzer misst die Warteschlange; die Warteraum-Einstellungen echter
   Veranstaltungen nicht anfassen. Danach `journey.mjs` mit der Event-ID starten, wie oben beschrieben.

Gemessen auf einer Wegwerf-Datenbank (PostgreSQL 18): Der Import der Datei mit 3.600 Plätzen dauerte
etwa 1,1 s; der öffentliche Saalplan, den der Shop lädt, hat etwa 915 KB JSON (etwa 113 KB gzip, der
Shop liefert ihn mit ETag und beantwortet Wiederholungen mit `304`). Lösche Veranstaltung und
Test-Spielstätte danach (eine Veranstaltung ohne Bestellungen lässt sich nach dem Archivieren löschen).

## Lokal gemessen

Wegwerf-Container (`--target app`, ein Image) mit PostgreSQL 18 und Redis 8 auf demselben Windows-11-Entwicklungsrechner
wie der Generator (24 logische CPUs, nebenbei liefen andere Arbeiten und Testläufe, die Zahlen sind
also eine Größenordnung), Demo-Event mit 391 Sitzplätzen und 120 Stehplätzen, 20 Hot Seats,
Lasttest-Modus an, `TIX_PROXY_MAX_CONNS_PER_IP=0`, Generator direkt am Container (eine Client-Adresse):

| Lauf                             | Ergebnis                                                          | Eckdaten                                                                                                                                                                                                                                                                |
| -------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 300 Nutzer, Anlauf 30 s, 2 min   | bestanden                                                         | ~6.000 Anfragen (~80/s), 0 x 5xx / 429 / 503, 34 Hot-Seat-Sperren erteilt und 815 abgelehnt auf 20 Plätzen, 631 Halteintervalle ohne Überlappung, Verteilzeit p50 88 ms / p95 0,6 s, 0 hängende Sperren                                                                 |
| 1.000 Nutzer, Anlauf 30 s, 100 s | alle Invarianten bestanden, Grenze der Verteilzeit (p95) verfehlt | ~18.900 Anfragen (~210/s), 0 x 5xx / 429 / 503, 40 Hot-Seat-Sperren erteilt und 2.899 abgelehnt, 761 Intervalle ohne Überlappung, 0 hängende Sperren. Ein Container auf einem ausgelasteten Rechner war gesättigt: p95 mehrerer Endpunkte 1-18 s, Verteilzeit p95 2,8 s |

Prüfungen des Modus selbst auf demselben Stack: ohne Header (oder mit falschem) beantworteten 300
schnelle `POST /enter` von einer Adresse 120 x mit 200 und 180 x mit 429 (Limit 120 pro Minute); mit
Token 600 x 200 (als übersprungene Anfragen gezählt); nach **Deaktivieren** wurde das Token wie jedes
andere abgewiesen (120 x 200, dann 429); ein abgelaufener Lauf wird vom Worker innerhalb einer
Sekunde mit einem `loadtest.expire`-Audit-Eintrag geschlossen; das Token steht weder in Redis noch im
Audit-Log noch in den Logs.
