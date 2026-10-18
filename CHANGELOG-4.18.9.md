# COD4X CONTROL 4.18.9

## eBc-B3 Audit + Dependency Layer (Roadmap-Block 11)

### Audit

- Vollständiger statischer Audit von `kristiandz/ebc-b3` @ `d44c05e` (B3 1.10.10) in `docs/EBC-B3-AUDIT.md`, inkl. Dependency Matrix, Einzelbefunden und Zuordnung aller Roadmap-Fehlerfälle. Geprüft ohne Ausführung.
- Zusätzlich die übrigen eBc-Repositories (Hinweis des Nutzers): `kristiandz/CoD4x_Server` ist ein Fork ohne eigene Commits (0 voraus, 8 hinter dem Original) – die bisherige Quellprüfung gegen `callofduty4x/CoD4x_Server` gilt damit auch für eBc-Server. `kristiandz/ebc-pm` erklärt `b3-update-ebc.sql` als Statistikschema der eBc-Promod (Livebetrieb mit GSCLIB-MySQL-Plugin und eigenem CoD4X-Build). Kein Python-3-Port von B3 vorhanden.
- Kernbefunde: nur Python 2.7; Pflicht python-dateutil und ein MySQL-Treiber (PyMySQL → mysql-connector → MySQLdb); `feedparser` nur für `adv`/GUI; mitgelieferte `b3.xml` nutzt Parser `cod4` statt `cod4x` und hat leere Server-Einstellungen; Datenbank- und RCON-Passwort stehen in B3 im Klartext; b3hide wird über das nicht aktivierte ext-Plugin `auth` (`client_checkin`) angesteuert; `b3-update-ebc.sql` enthält 2× `DROP TABLE IF EXISTS`; CoD4x 21.x gibt `status` standardmäßig mit `playerid` und `steamid` aus, das von `Cod4XParser` erwartete Format nur mit `sv_legacyguidmode 1` (`src/sv_cmds.c`) – nur nativ abschließend prüfbar.

### Dependency Layer

- `lib/b3-dependencies.mjs`: `B3_SOURCE` (Repository, Commit, Version, CRLF-normalisierte SHA-256 zentraler Dateien, gesperrte SQL-Dateien), `B3_DEPENDENCY_MATRIX` (15 Zeilen: Anforderung, Pflicht/optional, Beleg, Prüfweg).
- Interpreter-Probe: nur Pfade mit Namen `python`, `python2`, `python2.7` (+ `.exe`); feste Import-Probe mit `shell:false`, `-E`, leerem temporärem Arbeitsverzeichnis, minimaler Umgebung, 15 s Timeout, 64 KiB Ausgabe. Funktioniert unter Python 2.7 und 3.x und meldet Version, Bitbreite und Module.
- Statische Quellprüfung: Pflichtdateien, B3-Version, Abgleich mit den auditierten Hashes (`UNAUDITED` bei Abweichung), Suche nach `DROP TABLE`/`DROP DATABASE`/`TRUNCATE` in `b3/sql/mysql`.
- Bewertung je Zeile: `OK`, `MISSING`, `INCOMPATIBLE`, `OPTIONAL_MISSING`, `UNAUDITED`, `NOT_CHECKED` (späterer Block), `UNVERIFIED` (nativer Test); Gesamt `BLOCKED`, `UNAUDITED` oder `READY_FOR_RUNTIME_TEST`.
- Einstellungen (globaler Python- und B3-Pfad) in `config/b3-environment.json` im Datenverzeichnis.
- API: `GET /api/b3/dependencies/matrix`, `GET|POST /api/b3/environment`, `POST /api/b3/dependencies/check`; Audit `b3.environment.configured`, `b3.dependencies.checked`, `b3.operation.blocked`.
- UI `lib/b3-dependency-panel.jsx` im Runtime-Bereich.

### Tests und Gate

- Neu: `test/b3-dependencies.test.mjs` (inkl. echter Probe des lokalen Interpreters – hier Python 3.11.5, korrekt als `INCOMPATIBLE` gemeldet), `test/b3-dependency-panel.test.mjs`; HTTP-Integrationstest erweitert.
- Gate `scripts/verify-4.18.9-b3-audit-gate.mjs`: **eBc-B3 Audit abgeschlossen + Dependency Matrix erstellt PASS** (13/13).
- Preflight `node scripts/preflight-4.18.9.mjs`: Exit 0, 189 Tests (183 PASS / 0 FAIL / 6 SKIP) plus alle Gates.

### Grenzen / offen

- Kein Python 2.7, kein MySQL und kein echter CoD4x 21.x waren verfügbar; B3 wurde nicht gestartet. Das folgt in Block 12 (Runtime) und Block 14 (Datenbank).
- Python 2.7 erhält keine Sicherheitsupdates mehr – Bewertung in Block 20.
- eBc-Promod-Livebetrieb (GSCLIB + eigener Core) ist eine offene Betreiberentscheidung gegenüber dem Verified-Core-Gate.
- Linux-/WSL-Preflight nicht ausgeführt. Kein Release, kein Installer, kein Live-Deployment.
