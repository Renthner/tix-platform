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

| Option                                                                                                       | Bedeutung                                                                               |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `--target`, `--event-id`, `--event-slug`                                                                     | Server, Event(s) (kommagetrennt, bis zu 20), optionale öffentliche Eventseite(n)        |
| `--event-weights`, `--multi-event-ratio` (0.1)                                                               | mehrere Events: Anteil der Käufer:innen je Event, Anteil mit Warenkorb über zwei Events |
| `--yes`, `--dry-run`                                                                                         | bestätigen / nur den Plan ausgeben                                                      |
| `--loadtest-token` / `TIX_LOADTEST_TOKEN`                                                                    | Token des Lasttest-Modus                                                                |
| `--vus` (1000), `--workers`, `--ramp` (60s), `--ramp-profile`                                                | Nutzer, Prozesse, Anlauf (`linear`, `step` = 5 Schübe, `spike` = alle auf einmal)       |
| `--duration` (4m), `--hold` (60s, höchstens 8m)                                                              | Gesamtdauer inklusive Anlauf, mittlere Haltezeit des Warenkorbs                         |
| `--hot` (20), `--best-available` (0.3), `--ws-ratio` (1)                                                     | umkämpfte Plätze, Anteil Bestplatz / WebSocket                                          |
| `--checkout-ratio` mit `--allow-orders`                                                                      | Anteil mit Vorkasse-Bestellung (nur eigene Kopie)                                       |
| `--metrics-token` / `TIX_METRICS_TOKEN`, `--database-url`                                                    | Ressourcen-Momentaufnahmen, optionale lesende Doppelbuchungs-Prüfung per SQL            |
| `--max-failure-rate` (0.01), `--max-429-rate` (0.001), `--max-503-rate` (0.02), `--max-fanout-p95-ms` (2000) | Grenzen der Prüfungen                                                                   |
| `--ipv4-only`                                                                                                | IPv4 zuerst, kein Wettlauf der Adressfamilien (schließt AAAA- / Cloudflare-Weg aus)     |

Halte die Haltezeit deutlich unter der Warenkorb-Uhr (Standard 10 Minuten): eine Sperre, die
während des Tests abläuft, darf ein anderer legitim bekommen, was die Exklusivitätsprüfung nicht
von einer Doppelbuchung unterscheiden kann.

## Mehrere Events gleichzeitig

Ein Lauf kann bis zu 20 Events belasten, zum Beispiel ein Festival, dessen Vorstellungen
gleichzeitig in den Verkauf gehen:

```bash
node scripts/load/journey.mjs --target https://shop.example.org --event-id a,b,c,d,e,f --yes \
     --vus 1000 --checkout-ratio 0.3 --allow-orders --multi-event-ratio 0.15
```

(`a` … `f` stehen für die Event-IDs.)

- `--event-id` nimmt eine kommagetrennte Liste verschiedener Event-IDs. `--event-slug` ist
  optional; wenn du ihn angibst, dann einen Slug je ID in derselben Reihenfolge.
- Jede:r Käufer:in bekommt ein **Haupt-Event** und durchläuft dort den ganzen Weg (Seiten, Eintritt,
  Saalplan, WebSocket, Hot Seats, Bestplatz, zufällige Plätze, Zurückgeben). Standardmäßig werden
  die Käufer:innen gleichmäßig verteilt. `--event-weights 3,1,1` (eine positive Zahl je Event)
  verteilt sie anteilig. Die Zuordnung ist deterministisch.
- `--multi-event-ratio` (Standard 0.1, bei nur einem Event ohne Wirkung) ist der Anteil der
  Käufer:innen, die danach zusätzlich ein zweites, zufällig gewähltes Event betreten, dessen Saalplan
  laden und dort ein bis zwei Plätze sperren (Endpunkt `LOCK_MULTI`). Ihr Warenkorb umfasst dann
  zwei Events. Mit `--checkout-ratio` wird daraus eine Bestellung über zwei Events. Die Zähler
  `multi_event_carts` und `checkout_ok_multi` zeigen, wie viele es waren.
- **Je Event geprüft:** Jedes Event hat eigene `--hot` Hot Seats. Die Leck-Prüfung vergleicht die
  Sperren vor und nach dem Lauf für jedes Event. Die Prüfung summiert die Events und nennt die mit
  hängenden Sperren. Eine zusätzliche Prüfung verlangt, dass die Hot Seats jedes Events mindestens
  einmal vergeben und mindestens einmal abgewiesen wurden. Gib jedem Event deutlich mehr
  Käufer:innen als `--hot`. Die Exklusivitätsprüfung deckt alle Events ab (Platz-IDs sind eindeutig).
- Die Konsole zeigt eine Tabelle je Event (Käufer:innen, Hot Seats vergeben / abgewiesen,
  Platzsperren, Bestplatz, Bestellungen, Warenkörbe über zwei Events, hängende Sperren). Die
  JSON-Datei enthält dieselben Daten unter `events`. Die Endpunkt-Tabelle bleibt global. Jeder
  Generator-Prozess misst die Verteilzeit eines Events (Prozess `w` misst Event `w mod n`). Mit
  weniger Prozessen als Events werden manche Events nicht gemessen (erhöhe `--workers`).
- Jedes Event muss **veröffentlicht und im Verkauf** sein. Für Vorkasse-Bestellungen
  (`--checkout-ratio`) muss jedes Event Vorkasse annehmen. Die Bestellungen sind echt, also nur auf
  einer Testkopie.

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

### Wer hat geantwortet? (Fehlerproben, Netzwerkursachen, Zeitverlauf)

Unerklärliche Statuscodes (405 auf `POST /api/events/<id>/seats`, 504 von einem Proxy, der erst nach
15 Minuten abbricht, Seitenaufrufe im Timeout) kommen meist von etwas vor der Anwendung. Ausgabe und
JSON zeigen deshalb:

- **Fehlerproben** (`errorSamples`): bis zu 3 je `Endpunkt:Status` für jede Antwort, die nicht 2xx /
  304 und kein 409 (Sperrkonflikt) ist: Methode, Pfad (ohne Query), Zeit seit Start, Antwortzeit, eine
  sichere Auswahl der Antwort-Header (`server`, `via`, `allow`, `content-type`, `content-length`,
  `location`, `retry-after`, `x-request-id`, `x-tix-upstream`, `cf-ray`, `cf-cache-status`,
  `x-powered-by`, Traefik-Header; nie Cookies, Authorization oder das Lasttest-Token) und die ersten
  200 Zeichen des Bodys. Antworten der App sind JSON mit `code` / `message` (oder die kleine Seite des
  Proxys mit "ticket shop"); alles andere (`server: Microsoft-IIS`, ein Traefik-"404 page not found",
  eine Cloudflare-HTML-Seite) kam von einem anderen Gerät.
- **Netzwerkfehler** (`networkErrorCauses`): Status 0 nach Ursache gruppiert
  (`UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, `ECONNRESET`,
  `ECONNREFUSED`, `ETIMEDOUT`, ...) mit Zählung je Endpunkt. `TimeoutError` / `harness-timeout` ist
  der eigene 30-s-Abbruch des Generators (nichts hat rechtzeitig geantwortet); alles andere sind
  Fehler auf Verbindungsebene.
- **Wegindikator** (`pathIndicator`): "responses via Cloudflare: N of M" zählt `cf-ray` /
  `server: cloudflare`. Bei einem Lauf über einen Hosts-Datei-Eintrag ins LAN muss der Wert 0 sein.
  Ein Wert größer 0 heißt, dass Verbindungen den Eintrag umgangen haben (zum Beispiel IPv6 zum
  öffentlichen AAAA-Eintrag, wenn die LAN-Verbindung langsam ist): mit `--ipv4-only` wiederholen. Die
  Ausgabe nennt auch die Gegenstellen-Adressen der Verbindungen (Top 5, nur eingebautes fetch, keine
  WebSockets), damit man prüfen kann, dass der Eintrag greift.
- **Zeitverlauf** (`timeline`): je 10 s Anfragen, Fehler (5xx, Status 0, 4xx außer 409), p95,
  Timeouts und aktive Käufer (Summe der Spitzenwerte der Prozesse), damit man sieht, _wann_ es kippt.
- **Generator** (`generator`): Gesamt-CPU des Generator-Rechners (Mittel / Spitze, alle 2 s) und die
  p99-Spitze der Event-Loop-Verzögerung je Worker. Über 85 % CPU-Spitze (oder 200 ms Verzögerung)
  meldet die Diagnose "generator CPU is saturated: results are limited by the load generator":
  `--workers` erhöhen, stärkeren Rechner oder einen zweiten Generator nutzen.

Der Diagnoseblock verknüpft das: Cloudflare-Header vorhanden heißt, ein Teil des Verkehrs lief über
Cloudflare; eine 405- / 502- / 504-Probe, die weder App-JSON noch die Proxy-Seite ist, wird als "not
produced by the TIX app (header ... / body ...): check Traefik / the network device in front" gemeldet.

Was während eines Laufs auf dem Server zu beobachten ist:

- `docker stats` für **alle** Container (`tix`, Postgres, Redis, Proxy), nicht nur den Web-Container:
  CPU, Speicher und NET I/O. Ein ausgelasteter Postgres- oder Redis-Container erklärt langsame
  Antworten eines ruhigen Web-Prozesses.
- `top` (oder `vmstat 1`) auf der VM / dem Host: hohes `wa` (I/O-Wait) heißt langsame Platten, hohes
  `st` (Steal) heißt, der Hypervisor gibt der VM weniger CPU, als sie anzeigt (typisch bei geteilten
  Proxmox-Hosts).

#### 503 BUSY vom Proxy ist kein Serverfehler

Der eingebaute Proxy begrenzt die gleichzeitig laufenden Anfragen je Web-Prozess (Seiten 16, API 96,
Assets 128) und stellt den Rest in eine Warteschlange. Bei einem Ansturm bekommt eine Anfrage, die länger
als das Warte-Limit wartet (15 s Seiten, 10 s API/Assets), `503` mit `Retry-After: 5` und dem Code `BUSY`;
der Generator führt sie unter den Status-Spalten auf.
Das ist die gewollte, schnelle Antwort bei Überlast (früher verwarf der Kernel
Verbindungsversuche und der Generator sah ein `ETIMEDOUT` nach etwa 2 Minuten). Viele `BUSY`-Antworten
bedeuten, dass die Prozesse ausgelastet sind: mehr Web-Prozesse (`TIX_WEB_PROCESSES`) einsetzen oder den
Warteraum nutzen; siehe „Verhalten bei Überlast" in INSTALL.de.md. In `/__tix/health?detail=1` (innerhalb
des Containers) müssen `ListenOverflows` / `ListenDrops` konstant bleiben.

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

## Zahlungseingang unter Last

Der Journey-Test füllt eine Testkopie mit unbezahlten Vorkasse-Bestellungen. Dieser Teil testet die
andere Seite eines Vorverkaufs: **das Geld kommt an**. Ein Kontoauszug bezahlt hunderte dieser
Bestellungen in einer realistischen Mischung, und du misst und prüfst den automatischen Zahlungsabgleich:
Matching-Engine -> Bestellungen `PAID` -> Rechnungen, Tickets und vom Worker eingereihte E-Mails. Reines
Node, keine Abhängigkeiten:

| Werkzeug                                 | Zweck                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `scripts/load/open-orders.sql`           | Export der offenen Bestellungen (`\copy ... to stdout`)                                                            |
| `scripts/load/bank-statement.mjs`        | schreibt den Kontoauszug (camt.053, CSV oder MT940) und `<out>.expected.json` mit dem erwarteten Ergebnis          |
| `scripts/load/verify-reconciliation.mjs` | fragt die Datenbank ab (nur lesende SELECTs), zeigt Zeitverlauf und Zeiten, prüft das Ergebnis gegen expected.json |

**Nur auf einer Testkopie.** Der Lauf bezahlt Bestellungen wirklich: Rechnungsnummern werden verbraucht
(lückenlos, GoBD-unveränderlich), Tickets werden ausgestellt, E-Mails eingereiht. Niemals in Produktion.
Auf der Kopie einen SMTP-Sink (oder SMTP aus) verwenden, sonst gehen die E-Mails des Workers an
`load-...@example.invalid`.

#### Ablauf

1. **Bestellungen erzeugen** mit dem Journey-Test auf der Testkopie (siehe oben), zum Beispiel
   `node scripts/load/journey.mjs --target ... --event-id ... --yes --checkout-ratio 0.3 --allow-orders`.
   Exportiert werden nur Bestellungen mit `AWAITING_PAYMENT` / `BANK_TRANSFER`; anders bezahlte gehören nicht
   zu diesem Test. Unbezahlte Bestellungen werden standardmäßig nach 8 Tagen automatisch storniert
   (Einstellungen -> Zahlungen), eine stornierte Bestellung ist `ORDER_NOT_PAYABLE`; den Auszugstest also am
   selben Tag laufen lassen.
2. **Toleranz des Abgleichs setzen.** Der Generator geht von `--tolerance-cents 50` aus (Standard). Setze
   denselben Wert unter Einstellungen -> Zahlungen -> Überweisung ("Toleranz bei der Zuordnung", in Euro: 0,50) oder
   übergib den Wert des Ziels (der Standard des Shops ist 0; mit `--tolerance-cents 0` werden die
   Buchungen "knapp unterzahlt" zu Klärfällen wegen Unterzahlung, und die Erwartung sagt das auch).
   `verify-reconciliation.mjs` liest die Einstellung aus der Datenbank und schlägt bei der Prüfung "matching
   tolerance of the target equals the generator setting" fehl, wenn die Werte abweichen.
3. **Offene Bestellungen exportieren** (Referenz, offener Betrag in Cent, Währung, Käufername, Bestellnummer):

   ```sh
   # über Docker, bash / cmd
   docker exec -i <postgres-container> psql -U tix -d tix < scripts/load/open-orders.sql > orders.csv
   # über Docker, PowerShell
   Get-Content scripts/load/open-orders.sql | docker exec -i <postgres-container> psql -U tix -d tix | Set-Content -Encoding utf8 orders.csv
   # lokales psql
   psql "$DATABASE_URL" -f scripts/load/open-orders.sql > orders.csv
   ```

   Die Abfrage in `open-orders.sql` (dort muss sie in einer Zeile stehen, weil `\copy` nichts anderes erlaubt):

   ```sql
   select o.payment_reference as reference,
          o.total_gross - o.amount_paid as amount_cents,   -- offen, nicht der Gesamtbetrag
          o.currency,
          btrim(o.first_name || ' ' || o.last_name) as payer_name,
          o.order_number
   from orders o
   where o.status = 'AWAITING_PAYMENT' and o.payment_method = 'BANK_TRANSFER'
     and o.payment_reference is not null and not o.is_test   -- Testbestellungen werden nie automatisch verbucht
   order by o.created_at, o.order_number
   ```

4. **Kontoauszug erzeugen.**

   ```sh
   node scripts/load/bank-statement.mjs --orders orders.csv --format camt053 --out bank-statement.xml \
     --account-iban DE89370400440532013000 --seed 1 --split-files 3
   ```

   | Option                         | Bedeutung                                                                                                                                                                                   |
   | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `--format camt053\|csv\|mt940` | camt.053.001.08-XML (Standard), CSV mit Semikolon im Layout deutscher Online-Banking-Exporte oder MT940 mit `?xx`-Unterfeldern                                                              |
   | `--out <file>`                 | Auszugsdatei; daneben entsteht `<out>.expected.json` (mit `--split-files K`: `<name>-1ofK.<ext>` ... und eine Expected-Datei)                                                               |
   | `--account-iban <iban>`        | IBAN des Bankkontos, für das die Datei gilt (Standard: die Dokumentations-IBAN `DE89 3704 0044 0532 0130 00`); muss gültige Prüfziffern haben                                               |
   | `--date YYYY-MM-DD`            | Buchungs- und Valutadatum, Standard heute; nicht vor dem Anlegen der Bestellungen (die Engine zieht nur Bestellungen als Kandidaten heran, die vor Buchungsdatum + 2 Tagen angelegt wurden) |
   | `--mix exact=82,fuzzy=6,...`   | Prozent der Bestellungen je Szenario (unten); der Rest bleibt unbezahlt                                                                                                                     |
   | `--seed N`, `--limit N`        | deterministische Ausgabe; nur die ersten N Bestellungen verwenden                                                                                                                           |
   | `--split-files K`              | K Auszüge (um mehrere Importe zu testen); die beiden Zahlungen eines Doppelzahlers bleiben immer in einer Datei                                                                             |
   | `--tolerance-cents C`          | die Abgleich-Toleranz des Ziels (Standard 50)                                                                                                                                               |
   | `--head N`                     | die ersten N Zeilen jeder Datei ausgeben                                                                                                                                                    |

   Die Gegenseiten bekommen deterministische Beispiel-IBANs mit gültigen Prüfziffern. Jede Buchung trägt eine
   eindeutige End-to-End-Id `KT<runId>-<n>`; sie identifiziert die Banktransaktionen des Laufs in der Datenbank
   (und beginnt mit einem Buchstaben, den die Engine nicht für eine Ziffer hält, siehe "Einschränkungen").

5. **Importieren** unter Admin -> Bank & Zahlungen ("Kontoauszüge hochladen"): das Bankkonto wählen, **dessen IBAN die
   Datei nennt**, und die Datei(en) hochladen; mehrere Dateien auf einmal gehen. Der Import gehört zum
   gewählten Konto: Eine Datei mit einer anderen, gültigen IBAN wird mit "belongs to another account"
   abgelehnt; übergib deshalb die IBAN des Kontos, in das du importierst, als `--account-iban`. Der Upload
   nutzt das Datei-Import-Profil des Kontos: Ein dort eingestellter Formathinweis oder eine CSV-Spaltenzuordnung
   überstimmt die automatische Erkennung und kann das erzeugte CSV ablehnen (zurücksetzen oder camt053
   verwenden). **Der Abgleich läuft innerhalb der Upload-Anfrage**, Buchung für Buchung: Bei hunderten
   Buchungen `--split-files` verwenden, damit eine Anfrage nicht in ein Proxy-Timeout läuft. Wird eine Anfrage
   abgebrochen, gleicht das Sicherheitsnetz des Workers Buchungen nach 60 s nach, die noch nicht zugeordnet sind.
6. **Prüfen** (kann schon vor dem Import gestartet werden):

   ```sh
   node scripts/load/verify-reconciliation.mjs --expected bank-statement.xml.expected.json \
     --psql-cmd "docker exec -i <postgres-container> psql -U tix -d tix -At" \
     --wait 10m --interval 5s --out reconciliation-result.json \
     --logs-cmd "docker logs --since 20m <app-container>"
   ```

   `--psql-cmd` wird über die Shell gestartet und liest SQL von der Standardeingabe; alles, was eine
   nicht-interaktive psql-Sitzung liefert, geht, zum Beispiel `ssh host docker exec -i <postgres-container> psql -U tix -d tix -At`.
   Ergebniszeilen erkennt das Werkzeug am Präfix `TIXV:`, das Ausgabeformat von psql ist also egal. Gesendet
   werden nur `SELECT`-Anweisungen (vor dem Senden geprüft, dazu `set default_transaction_read_only = on`).
   Keine Passwörter in die Argumente (Container, `PGPASSWORD` oder `.pgpass` verwenden). Mit
   `--skip-fulfillment` entfallen die Prüfungen auf Rechnung / Tickets / E-Mail, wenn kein Worker läuft.

#### Szenarien und erwartetes Ergebnis

Das sind die Regeln der Matching-Engine (`packages/core/src/banking/matching.ts`). Der Integrationstest
`packages/core/test/bank-statement-tool.integration.test.ts` lässt für alle drei Formate den Generator, den
echten Import und den echten Matcher laufen und prüft genau das.

| Szenario (Standard-%) | Buchung                                                                                       | Erwartet                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `exact` (82)          | Referenz + genauer offener Betrag                                                             | `AUTO_MATCHED`, Bestellung `PAID`, eine Zahlung, eine AUTO-Zuordnung, Rechnung, Tickets, E-Mail                            |
| `fuzzy` (6)           | Referenz klein geschrieben / mit Leerzeichen / `O` statt `0` / ohne Bindestriche / kombiniert | wie `exact`                                                                                                                |
| `underWithin` (2)     | offener Betrag minus bis zur Toleranz                                                         | `AUTO_MATCHED`, Bestellung `PAID` (Fehlbetrag ausgebucht, `amount_paid` = erhaltenes Geld)                                 |
| `underBeyond` (2)     | weniger als offen minus Toleranz                                                              | Klärfall `UNDERPAYMENT`, keine Zahlung, Bestellung bleibt `AWAITING_PAYMENT`                                               |
| `over` (2)            | mehr als offen plus Toleranz                                                                  | Klärfall `OVERPAYMENT`, keine Zahlung, Bestellung bleibt offen                                                             |
| `unknown` (2)         | wohlgeformte Referenz eines Jahres ohne Bestellungen (1999)                                   | Klärfall `UNKNOWN_REFERENCE`; die Bestellung dieses Platzes bleibt unbezahlt                                               |
| `nameOnly` (1)        | keine Referenz, Zahlername = Käufer                                                           | Klärfall `NAME_MATCH_ONLY` (Name mindestens 3 Zeichen, ähnlich einem offenen Käufer), sonst `NO_REFERENCE`                 |
| `duplicate` (1)       | dieselbe Bestellung doppelt bezahlt (zwei identische Buchungen)                               | eine `AUTO_MATCHED` (Bestellung `PAID`, genau eine Zahlung) und ein Klärfall `OVERPAYMENT`; welche zuerst kommt, ist offen |
| `debit` (1)           | eine Belastung (DBIT), die die Referenz einer Bestellung nennt, plus 1 % fremde Belastungen   | `IGNORED`; die Bestellung bleibt `AWAITING_PAYMENT`                                                                        |
| Rest                  | keine Buchung                                                                                 | bleibt `AWAITING_PAYMENT`                                                                                                  |

Die Prozentwerte werden nach dem Largest-Remainder-Verfahren gerundet (die Anzahlen ergeben genau N); jedes
Szenario mit einem Anteil über 0 bekommt mindestens eine Buchung, wenn N das zulässt.

#### Was gemessen wird und wie man es liest

- **Zeitverlauf** (jede Abfrage): Banktransaktionen nach Status (`U`nmatched / `A`uto / `M`anuell / `N`eeds
  review / `I`gnored), Bestellungen `PAID` / `AWAITING_PAYMENT`, Zahlungen, Rechnungen, gültige Tickets und
  E-Mails (queued / sent / failed). Die Abfrage endet, wenn alle Buchungen importiert und zugeordnet sind,
  sich `--stable-polls` Abfragen lang (Standard 3) nichts geändert hat und der Worker für jede bezahlte
  Bestellung Rechnung und Zahlungs-E-Mail erzeugt hat (tut er das nie: nach viermal so vielen ruhigen Abfragen).
- **Zeiten** ab der ersten importierten Banktransaktion: letzte Zahlung gebucht (die Abgleichsphase, mit
  Bestellungen pro Sekunde), letzte Rechnung, letztes Ticket, letzte Zahlungs-E-Mail eingereiht. Sie nutzen
  `created_at` der Zeilen (`orders.paid_at` ist das Buchungsdatum, nicht der Verarbeitungszeitpunkt). Der
  Abstand zwischen "letzte Zahlung" und "letzte Rechnung / Ticket / E-Mail" ist der Rückstau des Workers.
- **Pro Szenario PASS / FAIL** mit bis zu fünf Beispielen je Prüfung: Bestellstatus, `amount_paid`,
  verbuchte Zahlungen (genau eine je bezahlter Bestellung), Zuordnung je Zahlung, keine Nebenwirkungen bei
  unbezahlten Bestellungen, Rechnung (genau eine), Tickets, Zahlungs-E-Mail, Transaktionsstatus, bei
  Doppelzahlung genau eine Zahlung und ein Klärfall.
- **Globale Invarianten:** keine Bestellung doppelt bezahlt, Summe `amount_paid` = Summe der Zahlungen =
  Summe der Zuordnungen, keine `UNMATCHED`-Buchungen übrig, alle erwarteten Buchungen importiert, keine
  Bestellung zu einer Belastung oder unbekannten Referenz `PAID`.
- `--logs-cmd` zählt Logzeilen mit Level >= 50 (oder dem Wort "error") und nennt die häufigsten Meldungen.
  Ein gesunder Lauf hat keine, die den Lauf betreffen.
- Der Exit-Code ist 0, wenn alles bestanden und der Zustand zur Ruhe gekommen ist, sonst 1. `--out`
  schreibt das ganze Ergebnis (Zeitverlauf, Prüfungen, Zeiten) als JSON; die letzte Ausgabezeile
  `TIXV-SUMMARY {...}` ist maschinenlesbar.

#### Einschränkungen

- **Referenz-Erkenner (in dieser Version behoben, Regel v3).** Eine frühere Engine durchsuchte Verwendungszweck
  und End-to-End-Id als einen zusammengesetzten Text. Eine ohne Bindestriche getippte Referenz, gefolgt von
  einer End-to-End-Id, die mit einem der Buchstaben `O Q D I L S B Z` beginnt (oder von weiteren Wörtern), wurde
  falsch gelesen: Der Buchstabe galt als Prüfziffer, und die Überweisung wurde `UNKNOWN_REFERENCE` (dieser
  Test hat das mit Ids gefunden, die mit `LT` begannen). Jetzt: (1) Der Verwendungszweck wird für sich
  durchsucht, und nur wenn er keine gültige Referenz in der erzeugten Form (6-stellige Nummer) enthält, wird
  die End-to-End-Id getrennt durchsucht. (2) Wortgrenzen: Ein ähnlich aussehender Buchstabe zählt nur dann als
  Prüfziffer, wenn kein Buchstabe oder keine Ziffer folgt; auf eine Prüfziffer folgt keine weitere Ziffer.
  (3) Wurde zwischen Jahr und Nummer ein Trennzeichen getippt, zählt nur die längste Aufteilung, sodass eine
  versehentlich eingetippte zusätzliche Ziffer nie zur gültigen Referenz einer anderen Bestellung wird; sie
  landet mit dem Hinweis „eine Abweichung“ im Klärfall. (4) Jahr und Nummer zusammen getippt
  (`TIX2026NNNNNNC`): Zuerst wird die 6-stellige Form versucht, danach die übrigen Aufteilungen auf eine
  gültige Prüfziffer; die getippte Aufteilung bleibt als ungültiger Eintrag sichtbar. Ausnahme: Eine Folge von 7-10
  Ziffern mit abgesetzter Prüfziffer (`TIX20268312426 2 Karten`) lässt sich nicht von einer versehentlich
  eingetippten zusätzlichen Ziffer unterscheiden und wird nie neu aufgeteilt, sie wird zum Klärfall (eine
  Schreibweise wie `TIX2026386416 5` mit genau 6 Ziffern vor der Lücke wird weiterhin zugeordnet). Der Generator beginnt
  seine Ids weiterhin mit `KT` und setzt die Referenz ans Ende des Verwendungszwecks; das ist unschädlich.
- Rechnungsnummern werden verbraucht und Tickets ausgestellt: nur auf einer Testkopie; ein Wiederherstellungspunkt
  vor dem Lauf macht das Aufräumen leicht.
- Das Werkzeug beurteilt die Datenbank, nicht die Zustellung der E-Mails: Bei abgeschaltetem SMTP-Sink bleiben
  sie `QUEUED` oder werden `FAILED`; die Prüfung verlangt nur, dass sie eingereiht sind.
- Die Erwartung setzt voraus, dass die Bestellungen zwischen Export und Prüfung unberührt bleiben (keine
  manuellen Zahlungen, keine Stornierung durch das Mahnwesen).
- Dieselbe Datei erneut zu importieren wird als doppelte Datei (SHA-256) abgelehnt; für einen weiteren Lauf einen
  neuen Auszug erzeugen (anderer `--seed` oder frische Bestellungen).
