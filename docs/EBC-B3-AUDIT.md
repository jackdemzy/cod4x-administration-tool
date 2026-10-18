# eBc-B3 Audit (Roadmap-Block 11)

Stand: 2026-10-18 · Geprüft für COD4X CONTROL 4.18.9 · Methode: statische Quellprüfung, nichts wurde ausgeführt.

## Quelle

| Feld | Wert |
|---|---|
| Repository | https://github.com/kristiandz/ebc-b3 |
| Geprüfter Commit | `d44c05eaa809c7047073e0d3776bcdb5d1827fee` (2022-08-12, „Syntax update“), Branch `master` |
| Letzte Aktivität | 2022-08-12 (seitdem keine Commits) |
| Basis | BigBrotherBot `1.10.10` (`b3/__init__.py`), eBc-Anpassungen |
| Lizenz | Repository GPL-3.0; B3-Quelldateien GPL-2.0-or-later. CONTROL bündelt und verändert eBc-B3 nicht. |
| Umfang | 275 Dateien; Start über `run.sh` → `python b3_run.py` |
| Weitere geprüfte eBc-Repositories | `kristiandz/CoD4x_Server` (Fork, 0 eigene Commits, 8 hinter `callofduty4x/CoD4x_Server` – gleichwertig zum geprüften Original); `kristiandz/ebc-pm` (Promod, Commit `acc8da0`, 2026-03-29). Kein Python-3-Port von B3 vorhanden. |

## Ergebnis in Kürze

eBc-B3 lässt sich als **separater Prozess** verwalten, wie es die Roadmap vorsieht. Es gibt aber vier harte Punkte, die CONTROL beim Start prüfen und klar anzeigen muss:

1. **Nur Python 2.7.** `b3_run.py` beendet sich bei Python 3 mit „B3 is not yet compatible with python version 3“ und bei Python < 2.7. Python 2.7 ist seit 2020 ohne Upstream-Support. CONTROL liefert kein Python mit.
2. **CoD4x-21.x-Statusformat nicht belegt.** `b3/parsers/cod4x.py` (`Cod4XParser`, v0.4) erwartet eine `status`-Zeile mit **einer** GUID-Spalte und IPv4-Adressen. CoD4x 21.x gibt standardmäßig `playerid` **und** `steamid` aus (`src/sv_cmds.c` `SV_Status_f`); das alte Format nur mit `sv_legacyguidmode 1`, das zugleich die GUIDs in `games_mp.log` ändert. Nur nativ prüfbar (Block 12).
3. **Mitgelieferte Konfiguration ist nicht CoD4x-fertig.** `b3/conf/b3.xml` setzt `parser` auf `cod4`, nicht `cod4x`; `game_log`, `rcon_password`, `port` und `database` sind leer. CONTROL muss die Konfiguration erzeugen (Block 16).
4. **Destruktive SQL-Datei.** `b3/sql/mysql/b3-update-ebc.sql` (phpMyAdmin-Dump der Datenbank `ebc_b3_pm`) enthält zweimal `DROP TABLE IF EXISTS`. Laut `ebc-pm`-README ist sie das Statistik-Schema der eBc-Promod (Spieler-Prestige u. a.), nicht Teil des B3-Kerns. Sie wird nie automatisch ausgeführt; nur als ausdrücklich gewählte Option mit vorherigem Backup (Block 14).

## Dependency Matrix

Maschinenlesbar in `lib/b3-dependencies.mjs` (`B3_DEPENDENCY_MATRIX`), dort auch die Prüflogik.

| Komponente | Anforderung | Pflicht | Beleg | Prüfung durch CONTROL |
|---|---|---|---|---|
| Python | `>= 2.7, < 3` | ja | `b3_run.py` Versionsprüfung | Interpreter-Probe (Block 11) |
| python-dateutil | beliebig, importierbar | ja | `b3/parser.py` `import dateutil.tz` (Zeitzone) | Import-Probe |
| MySQL-Treiber | PyMySQL, sonst mysql-connector, sonst MySQLdb | ja (für MySQL) | `b3/storage/mysql.py` Treiberauswahl in dieser Reihenfolge | Import-Probe |
| MySQL/MariaDB-Server | erreichbar, Schema `b3/sql/mysql/b3.sql` | ja | `b3.sql`: 6× `CREATE TABLE IF NOT EXISTS` (aliases, ipaliases, clients, groups, penalties, data); Dump-Server MariaDB 10.3 | Block 14 (Database Wizard) |
| feedparser | importierbar | optional | nur `plugins/adv` (RSS-Nachrichten) und `b3/gui` | Import-Probe |
| requests | importierbar | optional | `extplugins/discord.py`, `plugins/geolocation` | Import-Probe |
| paramiko | importierbar | optional | `plugins/sftpytail` (Remote-Log per SFTP) | Import-Probe |
| psycopg2 | importierbar | optional | `b3/storage/postgresql.py` | Import-Probe |
| PyQt5 | – | nicht genutzt | nur `b3/gui` (Desktop-GUI); CONTROL startet headless | nicht geprüft |
| subprocess32 | – | optional | `b3/run.py` mit Fallback auf `subprocess` | nicht nötig |
| CoD4x-Parser | `b3/parsers/cod4x.py` vorhanden | ja | `Cod4XParser` erbt von `cod4.Cod4Parser` | Quellprüfung |
| CoD4x-Server-Log | `g_log`, `g_logsync`, lokaler Pfad | ja | `b3/parser.py` liest `game_log` lokal oder per ftp/sftp/http | Config Engine erlaubt `g_log`, `g_logsync` (Block 6); Pfad-Erzeugung Block 16 |
| RCON | UDP `0xFFFFFFFF rcon <pw> <cmd>` | ja | `b3/parsers/q3a/rcon.py` | Passwort aus dem Credential-Vault (Block 7), Übergabe an B3 erst Block 16 |
| b3hide | CoD4x-Plugin `b3hide` + B3-Plugin `auth` | optional | `extplugins/auth.py` sendet `client_checkin <cid> <level>`; `auth` ist in `b3.xml` **nicht** aktiviert | Plugin-Manager (Block 10), Verdrahtung Block 16 |
| CoD4x-Statusformat | eine GUID-Spalte, IPv4 | ja | siehe Punkt 2 oben | **offen, nativ in Block 12** |
| eBc-Promod-Statistikschema | `b3-update-ebc.sql` | optional | `ebc-pm` README (MySQL-Livebetrieb) | nur Opt-in mit Backup (Block 14) |
| GSCLIB-Plugin + eigener CoD4X-Build | nur für eBc-Promod-Livebetrieb mit MySQL | optional | `ebc-pm` README | **offen**: kollidiert mit dem Verified-Core-Gate; eigene Entscheidung nötig |

## Einzelbefunde

### Python-Version
- Harte Grenze Python 2.7 (`b3_run.py`), Code nutzt Python-2-Module (`thread`, `Queue`, `ConfigParser`, `imp`).
- Folge: CONTROL fragt den Pfad zu einem Python-2.7-Interpreter ab und prüft ihn, bevor B3 jemals gestartet wird. Ein Python 3 wird als `PYTHON_INCOMPATIBLE` gemeldet, nicht still „ausprobiert“.

### MySQL / Schema / Migrationen
- Kernschema `b3.sql` legt Tabellen nur `IF NOT EXISTS` an (nicht destruktiv).
- Update-Skripte `b3-update-1.3.0` bis `1.10.0` enthalten `ALTER TABLE` (1.3.0: 1, 1.6.0: 5, 1.9.0: 2) und `CREATE TABLE` (1.7.0: 1, 1.8.1: 14). Ihre Anwendung ist eine Migration und braucht Backup (Roadmap Block 14: „Keine destruktiven Migrationen ohne Backup“).
- `b3-update-ebc.sql`: 2× `DROP TABLE IF EXISTS`, 4× `ALTER TABLE`, betrifft die eBc-Promod-Statistik (`player_core` u. a.), nicht B3. Laut `ebc-pm` README die Referenzstruktur für den Promod-MySQL-Betrieb. In CONTROL gesperrt für automatische Ausführung, später nur Opt-in mit Backup.
- Plugin-Schemata (callvote, chatlogger, cmdmanager, nickreg, xlrstats) liegen je Plugin unter `plugins/<name>/sql/mysql/`.

### Konfigurationsformat
- Hauptkonfiguration `b3/conf/b3.xml` (XML, `<settings name="…"><set name="…">`), alternativ `b3.distribution.ini`.
- Sektionen: `b3` (parser, database, logfile, time_zone …), `server` (rcon_password, port, public_ip, rcon_ip, game_log, punkbuster …), `messages`, `plugins` (external_dir `@b3/extplugins`), `update` (channel `skip`).
- `database` ist eine DSN-URL (`mysql://user:pass@host/db`, `b3/functions.py` `splitDSN`) – Passwort und RCON-Passwort stehen **im Klartext** in der Datei. CONTROL muss diese Datei mit restriktiven Rechten erzeugen und darf sie nie loggen (Block 16 / Block 20).
- Aktivierte Plugins in `b3.xml`: admin, adv, cmdmanager, pluginmanager, status, customcommands, xlrstats, reportplayer, location, duel, nickreg, namechangers, mute, geowelcome, spree, chatlogger. Nicht aktiviert: `auth` (für b3hide), `publist` (würde Serverdaten an den B3-Master melden).

### Parser / RCON / Log
- `Cod4XParser`: angepasste Befehle (`tell`, `clientkick`, `banclient`, `tempban … m`, `unban <guid>`), Tempban max. 43 200 Minuten, `_guidLength = 6`.
- RCON über `b3/parsers/q3a/rcon.py` (UDP, Quake-3-Format) – kompatibel mit dem in Block 7 geprüften CoD4x-Format.
- Log-Leser: lokale Datei oder ftp/sftp/http (`b3/parser.py`). CONTROL nutzt nur den lokalen Instanz-Log.

### Externe Plugins (eBc-spezifisch)
- `discord.py`, `discordban.py` (benötigen `requests` und Discord-Zugangsdaten in eigener XML), `mute`, `namechangers`, `reportplayer`, `auth`, `autoreg`.

### Startskripte
- `run.sh`: `python b3_run.py` ohne Pfadangaben, ohne Interpreter-Version, ohne Konfigurationsargument. CONTROL nutzt es **nicht**, sondern startet später (Block 12) einen geprüften Interpreter direkt mit `shell:false` und expliziter Konfigurationsdatei.

## Fehlerfälle aus der Roadmap → Erkennung

| Fehlerfall | Erkennung in CONTROL |
|---|---|
| veraltete Python-Abhängigkeit | Import-Probe meldet fehlende/zu alte Pakete (`DEPENDENCY_MISSING`) |
| inkompatible Python-Version | `PYTHON_INCOMPATIBLE` (z. B. Python 3.x) |
| fehlende DB | `NOT_CHECKED` bis Block 14; dort Verbindungs- und Schemaprüfung |
| fehlende Plugins | Quellprüfung: Pflichtdateien (`parsers/cod4x.py`, `extplugins/auth.py` für b3hide) |
| veraltete B3-API | Quellprüfung: B3-Version muss `1.10.10` sein (`B3_VERSION_MISMATCH`) |
| kaputte SQL-Migration | Sperrliste destruktiver Dateien (`b3-update-ebc.sql`), Migrationen nur mit Backup (Block 14) |
| inkompatible CoD4X-Version | Statusformat als `UNVERIFIED` ausgewiesen, nativer Test in Block 12 |

## Offene Punkte für die nächsten Blöcke

- Block 12: B3 als separaten Prozess mit geprüftem Python 2.7 starten; Statusformat gegen echten CoD4x 21.x prüfen, ggf. `sv_legacyguidmode` bewusst entscheiden.
- Block 14: Datenbank-Wizard, Schema `b3.sql`, Migrationen nur mit Backup, `b3-update-ebc.sql` gesperrt.
- Block 16: `b3.xml` erzeugen (`parser cod4x`, lokaler `game_log`, RCON aus dem Vault, `auth`-Plugin für b3hide), Datei mit restriktiven Rechten.
- Sicherheitsfrage (Block 20): Python 2.7 erhält keine Sicherheitsupdates mehr; B3 sollte nur lokal und mit minimalen Rechten laufen.
- eBc-Promod-Livebetrieb: benötigt das GSCLIB-Plugin (`.dll`/`.so`, über den Plugin-Manager aus Block 10 freigebbar) und einen selbst kompilierten CoD4X-Core. Ein solcher Core muss das Verified-Core-Gate bestehen (eigener Manifest-/Hash-Nachweis) – das ist eine bewusste Betreiberentscheidung, keine automatische Freigabe.
