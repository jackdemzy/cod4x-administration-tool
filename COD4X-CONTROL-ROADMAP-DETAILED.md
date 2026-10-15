# COD4X CONTROL – Technischer Masterplan / Roadmap

> **Status:** Arbeitsdokument  
> **Zweck:** Verbindlicher, blockweiser Entwicklungsplan für COD4X CONTROL  
> **Arbeitsweise:** Ein Block wird implementiert, geprüft und erst nach bestandenem Gate als Grundlage für den nächsten Block freigegeben.

---

# Gesamtziel

COD4X CONTROL wird zu einem Windows-/Linux-fähigen Management- und Deployment-Tool für CoD4X Dedicated Server.

Geplante Zielplattformen:

- Windows Native
- Linux Native
- später Linux Remote / SSH
- später optional Linux Docker

Grundlegende Trennung:

```text
iw3mp.exe
    = CoD4/CoD4X Client / Game Installation

cod4x18_dedrun.exe
    = CoD4X Dedicated Server unter Windows

cod4x18_dedrun
    = CoD4X Dedicated Server unter Linux
```

Die Server-Runtime darf `iw3mp.exe` niemals als Dedicated Server starten.

---

# BLOCK 0 – Architektur einfrieren

## Ziel

Die grundlegende Architektur und Begriffe werden festgelegt, bevor weitere Runtime-Funktionen darauf aufgebaut werden.

## Warum dieser Block notwendig ist

Die bisherigen Probleme entstanden unter anderem dadurch, dass Client- und Server-Executable nicht konsequent getrennt wurden.

Deshalb wird die Architektur jetzt explizit:

```text
Game Installation
        │
        ├── Client / BaseGame
        │
        └── Server Core
              │
              └── Server Instance
                    │
                    ├── Config
                    ├── RCON
                    ├── Master
                    ├── Plugins
                    └── B3
```

## Zentrale Begriffe

- Game Installation
- CoD4X Server Core
- Server Instance
- Runtime
- BaseGame
- Master Server
- Master Token
- Plugin
- B3
- Database
- RCON

## Zentrale Datenstruktur

```text
ServerInstance
├── id
├── name
├── platform
├── serverCore
├── basePath
├── homePath
├── savePath
├── configPath
├── port
├── rcon
├── master
├── plugins
└── b3
```

## Konkrete Implementierung

- Server-Instanzmodell definieren
- Plattform als expliziten Typ modellieren
- Runtime vom UI entkoppeln
- Core vom BaseGame trennen
- B3 vom CoD4X-Prozess trennen
- Masterserver-Konfiguration pro Serverinstanz speichern

## Abhängigkeiten

Keine.

## Tests

- Schema kann geladen werden
- bestehende Konfigurationen können migriert werden
- ungültige Serverinstanzen werden erkannt

## Fehlerfälle

- fehlende Pflichtfelder
- ungültige Plattform
- ungültige Pfade
- doppelte Server-ID
- Port-Konflikte

## Definition of Done

Das Datenmodell ist stabil und alle nachfolgenden Blöcke können darauf aufbauen.

## Gate

**Schema + Migration + Preflight PASS**

---

# BLOCK 1 – CoD4X Dedicated Server Core

## Ziel

CONTROL erkennt und verwaltet ausschließlich echte CoD4X Dedicated Server Cores.

## Unterstützte Executables

```text
Windows:
cod4x18_dedrun.exe

Linux:
cod4x18_dedrun
```

## Warum dieser Block notwendig ist

Der Server-Core darf nicht mehr mit `iw3mp.exe` verwechselt werden.

## Konkrete Implementierung

Core Discovery:

```text
Automatische Suche
        ↓
cod4x18_dedrun
        ↓
Validierung
        ↓
SHA-256
        ↓
Verified Core
```

Zusätzlich:

- manuelle Core-Auswahl
- Core-Version erfassen
- Plattform erkennen
- Dateigröße prüfen
- SHA-256 berechnen
- falsche Executables blockieren

## Sicherheitsanforderungen

Ein Core darf nur gestartet werden, wenn:

- Datei existiert
- Datei ausführbar ist
- erwarteter Dateityp vorhanden ist
- Pfad validiert wurde
- Core-Verifikation erfolgreich war

## Tests

```text
gültiger Windows Core → PASS
gültiger Linux Core → PASS
iw3mp.exe → BLOCK
beliebige EXE → BLOCK
fehlende Datei → BLOCK
ungültiger Pfad → BLOCK
```

## Definition of Done

CONTROL kann einen echten CoD4X Dedicated Server Core eindeutig erkennen und von `iw3mp.exe` unterscheiden.

## Gate

```text
Windows Core FOUND
Linux Core FOUND
Invalid Core BLOCKED
Wrong executable BLOCKED
Hash mismatch BLOCKED
```

---

# BLOCK 2 – BaseGame Manager

## Ziel

Die für den Dedicated Server erforderlichen CoD4 Base-Game-Dateien werden erkannt, geprüft und für Serverinstanzen bereitgestellt.

## Relevante Struktur

```text
main/
zone/
```

Insbesondere:

```text
main/*.iwd
zone/*
```

## Warum dieser Block notwendig ist

Der Server-Core allein ist keine vollständige Serverinstallation.

## Konkrete Implementierung

- CoD4-Installation erkennen
- `main` validieren
- `zone` validieren
- fehlende Dateien erkennen
- Serverbestand vorbereiten
- Dateiintegrität prüfen
- Clientbestand nicht unnötig duplizieren

## Architektur

```text
CoD4 Installation
       │
       ▼
Required Files
       │
       ▼
Validation
       │
       ▼
Server BaseGame
```

## Fehlerfälle

- `main` fehlt
- `zone` fehlt
- einzelne IWD fehlt
- Pfad ist keine CoD4-Installation
- Zugriff verweigert
- beschädigte Dateien

## Tests

- vollständige Installation
- unvollständige Installation
- falscher Pfad
- read-only Quelle

## Definition of Done

Eine Serverinstanz kann mit validiertem BaseGame aufgebaut werden.

## Gate

**BaseGame Validation PASS**

---

# BLOCK 3 – Server Instance Manager

## Ziel

Aus einem Server-Core wird eine verwaltbare, eigenständige Serverinstanz.

## Zielstruktur

```text
servers/
└── public-01/
    ├── main/
    ├── zone/
    ├── mods/
    ├── plugins/
    ├── usermaps/
    ├── players/
    ├── logs/
    └── server.cfg
```

## Wichtiger Punkt

Jede Serverinstanz erhält einen eigenen:

```text
fs_homepath
```

## UI

```text
Server
├── Neu
├── Duplizieren
├── Start
├── Stop
├── Restart
├── Konfiguration
└── Löschen
```

## Konkrete Implementierung

- Instanz erstellen
- Instanz klonen
- Pfade erzeugen
- Port reservieren
- Homepath erzeugen
- Config erzeugen
- Logs vorbereiten
- Instanz löschen

## Fehlerfälle

- Port bereits belegt
- Zielpfad existiert
- unzulässiger Pfad
- fehlende Schreibrechte
- Server-ID bereits vorhanden

## Tests

Mindestens zwei Serverinstanzen parallel:

```text
Server #1 → fs_homepath A
Server #2 → fs_homepath B
```

## Definition of Done

Mehrere Server können vollständig getrennt voneinander existieren.

## Gate

**Zwei parallele Instanzen mit getrennten Homepaths PASS**

---

# BLOCK 4 – Windows Runtime

## Ziel

Der Windows Dedicated Server wird als kontrollierter Prozess gestartet und überwacht.

## Executable

```text
cod4x18_dedrun.exe
```

## Architektur

```text
WindowsRuntime
├── Start
├── Stop
├── Restart
├── PID
├── stdout
├── stderr
├── Exit Code
└── Crash Detection
```

## Bestehende Sicherheitsmechanismen

Beibehalten:

- `shell:false`
- PID Verification
- kontrolliertes Stoppen
- Verified-Core-Gate
- Correlation IDs
- Runtime History
- Audit Events

## Konkrete Implementierung

Start:

```text
Validate Core
      ↓
Validate Instance
      ↓
Validate Config
      ↓
Spawn
      ↓
Verify PID
      ↓
RUNNING
```

Stop:

```text
RUNNING
   ↓
Graceful Stop
   ↓
Process Exit
   ↓
Verify Process Gone
   ↓
STOPPED
```

## Fehlerfälle

- Spawn schlägt fehl
- Prozess beendet sich sofort
- falscher PID
- Prozess läuft unter unerwartetem Pfad
- Core fehlt
- Port belegt

## Tests

```text
START
RUNNING
STOP
STOPPED

RESTART
RUNNING
```

Zusätzlich absichtlicher Crash.

## Definition of Done

Windows Dedicated Server kann zuverlässig gestartet, überwacht, beendet und neu gestartet werden.

## Gate

**Runtime Lifecycle PASS**

---

# BLOCK 5 – Linux Runtime

## Ziel

Dieselbe Serververwaltung wird für Linux verfügbar.

## Executable

```text
./cod4x18_dedrun
```

## Architektur

```text
ServerRuntime
├── WindowsAdapter
└── LinuxAdapter
```

Die gemeinsame Serverlogik darf nicht doppelt implementiert werden.

## Linux-spezifisch

- executable bit
- Unix Signals
- PID Handling
- stdout/stderr
- graceful shutdown
- User/Group
- Path Handling
- Permissions
- kein Root-Betrieb

## Tests

- Core gefunden
- Core ausführbar
- Server startet
- Server stoppt
- Server crasht kontrolliert
- Restart funktioniert

## Definition of Done

Windows und Linux besitzen dieselbe Runtime-API mit plattformspezifischen Adaptern.

## Gate

**Windows Runtime API = Linux Runtime API**

---

# BLOCK 6 – Server Configuration Engine

## Ziel

Serverkonfiguration wird nicht mehr als unkontrolliertes Textfeld behandelt, sondern schema-basiert verwaltet.

## Bereiche

```text
Server Identity
Network
Gameplay
RCON
Master Server
Maps
Mods
Plugins
Security
B3
```

## Änderungsablauf

```text
UI
 ↓
Validation
 ↓
Snapshot
 ↓
Backup
 ↓
Apply
 ↓
Verify
```

## Konkrete Implementierung

- Config Parser
- Config Writer
- Schema
- Validierung
- Backup
- Diff
- Restore
- Reload/Restart-Erkennung

## Fehlerfälle

- ungültige CVAR
- doppelte Einstellung
- beschädigte Config
- Syntaxfehler
- unzulässiger Wert

## Definition of Done

Jede UI-Konfigurationsänderung ist reproduzierbar und validiert.

## Gate

**Config Change → Backup → Apply → Verify PASS**

---

# BLOCK 7 – RCON

## Ziel

CONTROL kommuniziert kontrolliert mit dem Dedicated Server.

## Architektur

```text
CONTROL
   │
   └── RCON
        ├── Connect
        ├── Authenticate
        ├── Command
        ├── Response
        └── Health
```

## Funktionen

- Credentials sicher speichern
- Verbindung testen
- `status`
- `map`
- `map_rotate`
- Serverinformationen
- kontrollierte Admin Commands

## Audit

```text
rcon.command
rcon.login
rcon.failure
```

## Sicherheitsanforderungen

- Passwort nicht loggen
- keine Klartext-Secrets in normalen Logs
- Command Allowlist für gefährliche Aktionen
- Audit Trail

## Gate

**RCON Connect → Command → Response PASS**

---

# BLOCK 8 – Master Server / Server Token

## Ziel

Server können optional in der CoD4X Master List registriert werden.

## Masterserver

```text
cod4master.cod4x.ovh
```

## Token

Der Betreiber kann über die Masterserver-Infrastruktur einen Server-Token beziehen.

Dieser wird für die gewünschte Listung verwendet.

## UI

```text
Master Server
──────────────────────

Status:
● Connected

Token:
[ *************** ]

[ Token einrichten ]
[ Token entfernen ]

Registration:
REGISTERED
```

## Zustände

```text
NOT_CONFIGURED
TOKEN_CONFIGURED
REGISTERING
REGISTERED
REGISTRATION_FAILED
HEARTBEAT_OK
HEARTBEAT_LOST
```

## Konkrete Implementierung

- Token-Dialog
- Token-Validierung
- sichere Speicherung
- Runtime-Übergabe
- Registration State
- Fehlerdiagnose
- Statusanzeige

## Sicherheitsanforderungen

Der Token darf nicht unnötig in Logs erscheinen.

Der Token darf den lokalen Serverstart nicht blockieren.

```text
Token fehlt
   ↓
Server startet trotzdem
   ↓
Master = NOT REGISTERED
```

## Audit

```text
master.token.configured
master.token.removed
master.registration.started
master.registration.succeeded
master.registration.failed
master.heartbeat.detected
```

## Definition of Done

Ein Server kann mit oder ohne Masterserver-Token betrieben werden.

## Gate

**Lokaler Serverbetrieb unabhängig von Master-Registration PASS**

---

# BLOCK 9 – Master List Verification

## Ziel

CONTROL unterscheidet zwischen:

```text
Token vorhanden
```

und:

```text
Server tatsächlich in Master List sichtbar
```

## Ablauf

```text
Master Server
     ↓
Server Query
     ↓
IP / Port / Server Identity
     ↓
Listed?
```

## UI

```text
Master List
────────────────────

Registration       ✓
Heartbeat          ✓
Listed             ✓
Last seen          ...
```

## Fehlerfälle

- Token gültig, Server nicht sichtbar
- Masterserver nicht erreichbar
- falscher Port
- NAT/Firewall
- Server offline
- Heartbeat fehlt

## Definition of Done

Der Betreiber erhält einen überprüfbaren Status statt nur „Token gesetzt“.

## Gate

**Registration + Listing Verification PASS**

---

# BLOCK 10 – Plugin Manager

## Ziel

CoD4X-Plugins werden versioniert und kontrolliert verwaltet.

## Plugin-Modell

```text
Plugin
├── Name
├── Version
├── Platform
├── SHA256
├── Enabled
├── Dependencies
└── Config
```

## Konkrete Funktionen

- Plugin erkennen
- Plugin installieren
- Plugin deaktivieren
- Plugin aktivieren
- Plugin-Version anzeigen
- Hash prüfen
- Dependency prüfen
- Plugin-Konfiguration verwalten

## Besonders relevant

```text
b3hide.dll
```

für Windows sowie die jeweilige Linux-Pluginvariante.

## Gate

**Plugin Discovery + Enable/Disable + Integrity PASS**

---

# BLOCK 11 – eBc-B3 Audit

## Ziel

Das vorhandene eBc-B3-Projekt wird vollständig technisch geprüft, bevor es in CONTROL integriert wird.

## Quelle

`kristiandz/ebc-b3`

## Zu prüfen

```text
Python-Version
MySQL
PyMySQL
python-dateutil
Feedparser
CoD4 Parser
RCON
Log Parser
b3hide
SQL Schema
Plugins
Config Format
Startskripte
```

## Wichtige Architekturentscheidung

B3 wird nicht in Electron/CONTROL neu implementiert.

Stattdessen:

```text
CONTROL
   │
   └── B3 Manager
         │
         └── eBc-B3
```

## Warum

eBc-B3 besitzt bereits CoD4/CoD4X-spezifische Parser- und B3-Funktionalität.

CONTROL soll den Lifecycle und die Integration verwalten.

## Fehlerfälle

- veraltete Python-Abhängigkeit
- inkompatible Python-Version
- fehlende DB
- fehlende Plugins
- veraltete B3-API
- kaputte SQL Migration
- inkompatible CoD4X-Version

## Gate

**eBc-B3 Audit abgeschlossen + Dependency Matrix erstellt**

---

# BLOCK 12 – B3 Runtime

## Ziel

B3 läuft als separater Prozess.

## Architektur

```text
COD4X CONTROL
│
├── CoD4X Server
│
└── B3
     ├── Python
     ├── B3
     ├── Parser
     └── Database
```

## Wichtig

Wenn B3 abstürzt:

```text
B3 DOWN
```

aber:

```text
CoD4X Server RUNNING
```

Der CoD4X-Prozess darf nicht vom B3-Prozess abhängig sein.

## Konkrete Funktionen

- B3 Start
- B3 Stop
- B3 Restart
- PID
- stdout/stderr
- Exit Code
- Crash Detection
- Health Check

## Gate

**B3 Lifecycle unabhängig vom CoD4X Lifecycle PASS**

---

# BLOCK 13 – B3 Manager

## Ziel

B3 wird vollständig aus CONTROL verwaltbar.

## UI

```text
B3
────────────────────

Status       RUNNING
Version      eBc/B3
Parser       CoD4X
Database     Connected
RCON         Connected

[ Start ]
[ Stop ]
[ Restart ]
[ Logs ]
[ Config ]
```

## Health Checks

```text
Python       ✓
B3           ✓
MySQL        ✓
Parser       ✓
RCON         ✓
CoD4X        ✓
```

## Fehlerdiagnose

CONTROL muss unterscheiden:

```text
Python fehlt
B3 fehlt
Dependency fehlt
DB offline
RCON offline
Parser offline
CoD4X offline
```

## Gate

**B3 Manager Health Dashboard PASS**

---

# BLOCK 14 – B3 Datenbank

## Ziel

B3-Datenbanken können sicher eingerichtet und geprüft werden.

## Wizard

```text
Database
├── Host
├── Port
├── Database
├── Username
└── Password
```

## Ablauf

```text
Test Connection
      ↓
Schema Check
      ↓
Backup
      ↓
Migration
      ↓
B3 Ready
```

## Sicherheitsanforderungen

Keine destruktive Migration ohne Backup.

Passwörter niemals in normalen Logs.

## Fehlerfälle

- DB nicht erreichbar
- falsches Passwort
- falsches Schema
- fehlende Tabelle
- Migration fehlgeschlagen

## Gate

**DB Connection + Schema + Migration PASS**

---

# BLOCK 15 – B3 In-Game Administration

## Ziel

CONTROL stellt die B3-Administration übersichtlich dar, ohne B3 neu zu implementieren.

## Funktionen

```text
Players
Admins
Bans
Warnings
Kicks
Temp Bans
Permanent Bans
Commands
```

## Architektur

```text
CONTROL UI
    ↓
B3
    ↓
RCON / Parser
    ↓
CoD4X
```

## Grundsatz

B3 bleibt für die eigentliche In-Game-Administration verantwortlich.

CONTROL ist Management-Layer.

## Gate

**Spieler-/Admin-/Ban-Daten können zuverlässig über B3 verwaltet bzw. angezeigt werden.**

---

# BLOCK 16 – eBc-B3 / CoD4X Plugin Integration

## Ziel

B3 und CoD4X werden sauber über die vorhandene Plugin-Schicht verbunden.

## Zielarchitektur

```text
CoD4X
  │
  └── b3hide
        │
        ▼
       B3
        │
        ├── RCON
        └── Parser
```

## Konfiguration

Die eBc-B3-Dokumentation und tatsächliche Plugin-Konfiguration werden als Source of Truth verwendet.

CONTROL erzeugt und validiert:

- Plugin-Eintrag
- B3 Prefix
- b3hide-Konfiguration
- B3 Parser-Konfiguration
- Abhängigkeiten

## Gate

**CoD4X → b3hide → B3 → RCON/Parser End-to-End PASS**

---

# BLOCK 17 – Multi-Server

## Ziel

Mehrere unabhängige Serverinstanzen auf einer Maschine verwalten.

## Zielstruktur

```text
COD4X CONTROL
│
├── Server #1
│   ├── CoD4X
│   ├── RCON
│   ├── Master
│   └── B3
│
├── Server #2
│   ├── CoD4X
│   ├── RCON
│   ├── Master
│   └── B3
│
└── Server #3
```

## Pro Server getrennt

- Port
- Homepath
- Config
- RCON
- Master Token
- Plugins
- B3
- Database
- Logs

## Tests

```text
Server 1 → 28960
Server 2 → 28961
Server 3 → 28962
```

Alle parallel starten.

## Fehlerfälle

- Port collision
- falsches Homepath
- falsche Config
- falsche B3-Zuordnung
- falsches RCON
- falscher Master Token

## Gate

**Drei parallele Server ohne Cross-Contamination PASS**

---

# BLOCK 18 – Remote Linux / SSH

## Ziel

Linux-Server können später von einem Windows-Control-PC aus verwaltet werden.

## Architektur

```text
CONTROL
   │
   └── SSH
        │
        └── Linux Server
```

## Funktionen

```text
Install
Update
Start
Stop
Restart
Logs
Health
Config
Backup
Restore
```

## Sicherheitsanforderungen

- SSH Credentials nicht im Klartext
- Host-Key Verification
- kein blindes Trust-on-first-use ohne Warnung
- Command Injection verhindern
- Remote Path Validation

## Gate

**Remote Linux Install → Start → Stop → Logs PASS**

---

# BLOCK 19 – Docker

## Ziel

Optionaler Containerbetrieb.

## Deployment

```text
Deployment
├── Windows Native
├── Linux Native
└── Linux Docker
```

## Container-Daten

```text
main
zone
mods
plugins
usermaps
server.cfg
logs
```

## Grundsatz

Persistente Serverdaten dürfen nicht ausschließlich im Container liegen.

## Gate

**Container Restart ohne Datenverlust PASS**

---

# BLOCK 20 – Security Audit

## Ziel

Vor Release wird die gesamte Anwendung sicherheitstechnisch geprüft.

## Runtime

Prüfen:

- Path Traversal
- Arbitrary Executable
- Shell Injection
- PID Spoofing
- Process Ownership
- Symlinks
- Permissions

## Secrets

Prüfen:

- Master Token
- RCON Password
- DB Password
- SSH Credentials

## B3

Prüfen:

- Python Process Isolation
- DB Credentials
- Plugin Trust
- Config Injection

## Linux

Prüfen:

- Root Execution
- File Permissions
- Executable Ownership

## Gate

**Security Audit ohne High/Critical Findings**

---

# BLOCK 21 – Recovery / Backup

## Ziel

Alle kritischen Änderungen müssen rückgängig gemacht werden können.

## Kritische Aktionen

```text
Config Change
Plugin Install
B3 Migration
Server Update
Core Update
```

## Ablauf

```text
Snapshot
 ↓
Backup
 ↓
Change
 ↓
Verify
```

Bei Fehler:

```text
Rollback
```

## Zu sichern

- Config
- Server Settings
- Plugin Config
- B3 Config
- B3 DB
- Server Metadata
- ggf. Usermaps/Mods nach Konfiguration

## Gate

**Änderung → Fehler → Restore → funktionierender Zustand PASS**

---

# BLOCK 22 – End-to-End-Test

## Windows

```text
Install
 ↓
Detect Core
 ↓
BaseGame
 ↓
Create Server
 ↓
Config
 ↓
Start
 ↓
Map
 ↓
RCON
 ↓
Master List
 ↓
B3
 ↓
Client Join
 ↓
Stop
 ↓
Restart
```

## Linux

Der gleiche Ablauf mit Linux Runtime.

## Multi-Server

```text
Server 1 → 28960
Server 2 → 28961
Server 3 → 28962
```

## Absichtliche Fehler

```text
falscher Core
fehlende main-Datei
fehlende zone-Datei
falscher Port
falscher RCON
fehlender Master Token
falsche DB
B3 down
Server crash
Plugin fehlt
```

## Erwartung

Keiner dieser Fehler darf CONTROL selbst zum Absturz bringen.

## Gate

**Full End-to-End PASS**

---

# BLOCK 23 – Release / Installer

## Ziel

Erst nach bestandenen Gates wird ein Production Release erzeugt.

## Preflight

```text
Source Encoding
Node Syntax
Unit Tests
Integration Tests
Runtime Tests
Security Checks
```

## Build

```text
React/Vite
 ↓
Electron
 ↓
electron-builder
 ↓
NSIS
```

## Artifact Verification

```text
Build
 ↓
SHA-256
 ↓
Artifact Verification
 ↓
Installer Test
```

## Zielartefakte

```text
Windows Installer
Portable Windows
Linux Package / Deployment
```

## Gate

**Installer Installation + First Run + Core Discovery + Server Start PASS**

---

# Geplante Versionsfolge

| Version | Schwerpunkt |
|---|---|
| 4.18.0 | Architektur + Dedicated Core |
| 4.18.1 | BaseGame + Server Instance |
| 4.18.2 | Windows Runtime |
| 4.18.3 | Linux Runtime |
| 4.18.4 | Config Engine |
| 4.18.5 | RCON |
| 4.18.6 | Master Server + Token |
| 4.18.7 | Master List Verification |
| 4.18.8 | Plugin Manager |
| 4.18.9 | eBc-B3 Audit + Dependency Layer |
| 4.18.10 | B3 Runtime |
| 4.18.11 | B3 Manager + Database |
| 4.18.12 | b3hide Integration |
| 4.18.13 | Multi-Server |
| 4.18.14 | Security Hardening |
| 4.18.15 | Recovery / Backup Integration |
| 4.18.16 | Full E2E Test |
| 4.18.17 | Release Candidate |
| 4.18.18 | Production Release |

---

# Übergreifende Entwicklungsregeln

## 1. Dedicated Server und Client niemals vermischen

```text
iw3mp.exe
    ≠
cod4x18_dedrun.exe
```

## 2. Keine Feature-Entwicklung auf ungeprüften Annahmen

Wenn Verhalten unklar ist:

1. offiziellen CoD4X Source prüfen
2. offizielle Dokumentation prüfen
3. tatsächliches Runtime-Verhalten testen
4. erst danach Code ändern

## 3. Jeder Block besitzt ein Gate

Kein nächster Block, wenn der vorherige nicht reproduzierbar funktioniert.

## 4. Bestehende funktionierende Sicherheitsmechanismen nicht entfernen

Insbesondere:

- PID verification
- process kill guard
- runtime crash guard
- safeStorage
- backup/integrity
- verified-core checks
- filesystem path guards

## 5. B3 bleibt separater Prozess

Ein B3-Fehler darf keinen CoD4X-Server-Crash verursachen.

## 6. Master Token ist optional für den Serverbetrieb

Master List Registration ist ein zusätzlicher Dienst.

## 7. Secrets gehören nicht in normale Logs

Das betrifft insbesondere:

- Master Token
- RCON Password
- Database Password
- SSH Credentials

## 8. Plattformunterschiede gehören in Adapter

Nicht:

```text
if Windows ...
if Linux ...
if Windows ...
if Linux ...
```

über den gesamten Code verteilt.

Sondern:

```text
ServerRuntime
├── WindowsAdapter
└── LinuxAdapter
```

## 9. Änderungen müssen reversibel sein

```text
Snapshot
Backup
Change
Verify
Rollback
```

## 10. Kein Release ohne vollständigen E2E-Test

Ein erfolgreicher `npm run build` allein ist kein Release-Kriterium.

---

# Aktueller Arbeitsstand

Der bisherige 4.17.x-Zweig hat bereits mehrere Schutzmechanismen und Preflight-Prüfungen.

Die nächste größere Entwicklung soll diese Architektur nicht durch weitere Sonderfälle verkomplizieren.

Stattdessen wird der Dedicated-Server-Runtimepfad auf:

```text
cod4x18_dedrun(.exe)
```

zentriert und anschließend schrittweise um:

```text
BaseGame
Server Instances
Windows Runtime
Linux Runtime
Config
RCON
Master Server
Master Token
Master List Verification
Plugins
eBc-B3
Multi-Server
Remote Linux
Docker
Security
Recovery
```

erweitert.

---

# Definition des Gesamtziels

Am Ende soll der Benutzer in CONTROL einen Server wie folgt verwalten können:

```text
Server erstellen
      ↓
Windows / Linux auswählen
      ↓
CoD4X Core auswählen
      ↓
BaseGame validieren
      ↓
Serverinstanz erzeugen
      ↓
Server konfigurieren
      ↓
RCON konfigurieren
      ↓
Master Token optional hinterlegen
      ↓
Plugins auswählen
      ↓
B3/eBc-B3 optional aktivieren
      ↓
Server starten
      ↓
Runtime überwachen
      ↓
Master List Status prüfen
      ↓
B3 Status prüfen
      ↓
Logs / RCON / Spieler verwalten
      ↓
Backup / Update / Restart
```

Das Endprodukt ist damit kein einfacher „EXE-Starter“, sondern ein kontrollierter **CoD4X Server Manager** mit plattformabhängiger Runtime und separaten Management-Schichten für Masterserver, Plugins und B3.
