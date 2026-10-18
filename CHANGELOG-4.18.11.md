# COD4X CONTROL 4.18.11

## B3 Manager (Roadmap-Block 13)

### Umsetzung

- `lib/b3-manager.mjs`: Auswertung für das Dashboard ohne eigene Seiteneffekte.
  - **Status-Tabelle:** Status, Version (`eBc/B3 1.10.10 @ 9096624`), Parser, Database, RCON, publist.
  - **Health-Checks:** Python, B3, MySQL, Parser, RCON, CoD4X, jeweils als ✓ / ✗ / –.
  - **Fehlerdiagnose:** trennt `PYTHON_MISSING`, `PYTHON_INCOMPATIBLE`, `B3_MISSING`, `B3_INCOMPATIBLE`, `DEPENDENCY_MISSING`, `COD4X_OFFLINE`, `DB_OFFLINE`, `PARSER_OFFLINE`, `RCON_OFFLINE`. Die Hauptursache steht zuerst; ein gestoppter Server erklärt eine fehlschlagende RCON-Verbindung (`rconCause`).
- Grundlage der Auswertung sind die echten eBc-B3-Meldungen: `Starting Cod4XParser v0.4 for server`, `Start reading game events`, `Using database file:`, `Successfully established a connection with MySQL database`, `Database connection failed`, `Missing MySQL database tables`, `Get cvar <name> = [<antwort>]`, `RCON: too many tries`, `Cannot setup RCON`. Ein abgelehntes Passwort („No rconpassword set“, „Bad rcon“) zählt als `AUTH_FAILED`, nicht als verbunden.
- `InstanceB3Service.dashboard/logs/config`: Die Auswertung läuft auf dem unredigierten Log-Ende (`B3Runtime.inspectLog`) und gibt nur Zustandscodes heraus. Die Logansicht bleibt redigiert. Die Config-Ansicht schwärzt Passwörter und DSN-Zugangsdaten. Der Serverzustand wird nur gelesen (Instanzstatus plus kurze `getinfo`-Probe auf Loopback). Die Abhängigkeitsprüfung wird für Dashboards 30 s zwischengespeichert; ein Start prüft immer frisch.
- API: `GET /api/instances/:id/b3/dashboard` (`?fresh=1`), `GET …/b3/logs` (diagnostics.read), `GET …/b3/config` (config.manage).
- UI: Das B3-Panel ist jetzt ein Manager mit Status-Tabelle, Health-Checks, Diagnose sowie den Knöpfen Start, Stop, Restart, Logs und Config.

### Befunde aus dem nativen Test mit echtem Server

- In WSL lief ein echter CoD4x-21.2-Linux-Core (nur 127.0.0.1, `dedicated 1`) neben echtem eBc-B3 `9096624`.
- Bei `log_level 9` gibt es keine `RCON: received`-Zeilen. Die Antworten erscheinen als `Get cvar … = […]`; die Erkennung wurde daran angepasst.
- Die Antwort „No **rconpassword** set“ wurde von der Log-Redaktion ausgeblendet, bevor das Dashboard sie auswerten konnte. Deshalb läuft die Auswertung jetzt auf dem Rohtext.
- **`publist` ist ein Pflicht-Plugin von B3** und meldet Serverdaten per HTTP an bigbrotherbot.net, außer `public_ip` ist `127.0.0.1`. CONTROL schreibt das jetzt immer so, auch für öffentlich gebundene Instanzen. Das ist im Audit-Bericht nachgetragen.

### Code-Review (`/engineering:code-review`) und Korrekturen

- **Veraltete Hinweise aus dem vorigen B3-Lauf:** B3 schreibt `b3.log` über Neustarts hinweg weiter. Jetzt setzt jeder neue Parser-Start alle Hinweise zurück. Betroffen waren das Dashboard und der Health-Check aus Block 12.
- **Unbekannter Serverstatus galt als „CoD4X offline“:** Er wird jetzt als `UNKNOWN` ohne Diagnose angezeigt, z. B. wenn die Windows-Prozessprüfung in ihr Timeout läuft.
- **Schwärzung mit `@` im DSN-Passwort:** Der Rest des Passworts wurde nicht mehr verdeckt; jetzt wird bis zum letzten `@` geschwärzt.
- **Log-Zeilen ohne Datum:** Sie verloren ihr erstes Zeichen.
- **Cache der Abhängigkeitsprüfung:**
  - Nach dem Speichern neuer Pfade wird er verworfen.
  - Gleichzeitige Aufrufe teilen sich eine Prüfung.
  - Eine überholte, noch laufende Prüfung füllt ihn nicht mehr.
- Für jeden Punkt gibt es einen Regressionstest.

### Tests und Gates

- Neu: `test/b3-manager.test.mjs`. Erweitert wurden `test/b3-runtime.test.mjs`, `test/instance-b3-service.test.mjs`, `test/instance-b3-runtime.test.mjs` und der HTTP-Integrationstest.
- Gate `scripts/verify-4.18.11-b3-dashboard-gate.mjs`: **B3 Manager Health Dashboard PASS** (12/12, Testdoubles).
- **Nativ:** `scripts/verify-4.18.11-b3-dashboard-native.mjs` mit echtem Core 21.2, Python 2.7.18 und eBc-B3: 10/10 PASS.
  - Python ✓, B3 ✓, Parser ✓, CoD4X ✓, Database ✓ (SQLite), MySQL –.
  - RCON ✗ als `AUTH_FAILED`, Hauptursache `RCON_OFFLINE`.
  - publist unterdrückt.
  - Nach dem Server-Stopp läuft B3 weiter, Hauptursache `COD4X_OFFLINE`.
- Preflight `node scripts/preflight-4.18.11.mjs`:
  - Windows: Exit 0, 209 Tests (203 PASS / 0 FAIL / 6 SKIP).
  - WSL/Linux: Exit 0, 209 Tests (198 PASS / 0 FAIL / 11 SKIP), inklusive beider nativer B3-Prüfungen.

### Grenzen / offen

- RCON ✓ gegen den echten Server ist erst möglich, wenn das RCON-Passwort an B3 übergeben wird (Block 16).
- MySQL folgt in Block 14.
- Eine Dashboard-Abfrage löst unter Windows mehrere Prozessprüfungen aus und dauert deshalb einige Sekunden.
- B3-Logs sind für die Rolle `viewer` sichtbar (wie die Serverkonsole).
- Kein Release, kein Installer, kein Live-Deployment.
