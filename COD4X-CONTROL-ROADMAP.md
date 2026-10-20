# COD4X CONTROL – Entwicklungs-Roadmap

## Ziel

COD4X CONTROL wird zu einem plattformübergreifenden Management- und Deployment-Tool für CoD4X Dedicated Server.

Unterstützte Zielplattformen:
- Windows Native
- Linux Native
- später optional Linux Remote/SSH
- später optional Linux Docker

Wichtige Trennung:

- `iw3mp.exe` = CoD4/CoD4X Client bzw. Game-Installation
- `cod4x18_dedrun.exe` = CoD4X Dedicated Server unter Windows
- `cod4x18_dedrun` = CoD4X Dedicated Server unter Linux

---

## Block 0 – Architektur einfrieren

Definition der zentralen Begriffe:

- Game Installation
- CoD4X Server Core
- Server Instance
- Runtime
- Master Server
- Plugin
- B3
- Database

Zentrale Datenstruktur:

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

**Gate:** Schema, Migration und Preflight PASS.

---

## Block 1 – CoD4X Dedicated Server Core

Core Discovery ausschließlich für Dedicated Server:

```text
Windows: cod4x18_dedrun.exe
Linux:   cod4x18_dedrun
```

Funktionen:

- automatische Discovery
- manuelle Core-Auswahl
- SHA-256-Fingerprint
- Core-Verifikation
- Versionserkennung
- falsche Executables blockieren

**Gate:**
- Windows Core FOUND
- Linux Core FOUND
- Invalid Core BLOCKED
- Wrong executable BLOCKED
- Hash mismatch BLOCKED

---

## Block 2 – BaseGame Manager

Validierung und Bereitstellung der erforderlichen CoD4 Base-Game-Dateien:

```text
main/*.iwd
zone/*
```

Funktionen:

- CoD4-Installation erkennen
- `main` prüfen
- `zone` prüfen
- fehlende Dateien melden
- Serverbestand vorbereiten
- keine unnötige Client-Installation kopieren

**Gate:** Server initialisiert ohne fehlende BaseGame-Dateien.

---

## Block 3 – Server Instance Manager

Eigene Serverinstanzen mit separatem `fs_homepath`.

Beispiel:

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

Funktionen:

- Server erstellen
- Server duplizieren
- Server starten
- Server stoppen
- Server neustarten
- Server konfigurieren
- Server löschen

**Gate:** Mindestens zwei Server gleichzeitig mit getrennten Homepaths.

---

## Block 4 – Windows Runtime

Dedizierter Prozessmanager für:

```text
cod4x18_dedrun.exe
```

Funktionen:

- Start
- Stop
- Restart
- PID-Verifikation
- stdout/stderr
- Exit-Code
- Crash Detection
- Runtime-History
- Audit Events

Bestehende Sicherheitsmechanismen beibehalten:

- `shell:false`
- PID Verification
- kontrolliertes Stoppen
- Verified-Core-Gate
- Correlation IDs

**Gate:** START → RUNNING → STOP → STOPPED sowie RESTART → RUNNING.

---

## Block 5 – Linux Runtime

Plattformadapter für:

```text
./cod4x18_dedrun
```

Architektur:

```text
ServerRuntime
├── WindowsAdapter
└── LinuxAdapter
```

Linux-spezifisch:

- executable bit
- Unix Signals
- PID Handling
- stdout/stderr
- graceful shutdown
- User/Group
- Path Handling
- keine Root-Ausführung

**Gate:** Windows und Linux verwenden dieselbe Runtime-API.

---

## Block 6 – Server Configuration Engine

Schema-basierte Konfiguration:

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

Änderungsablauf:

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

**Gate:** Konfigurationsänderungen sind validiert, gesichert und reproduzierbar.

---

## Block 7 – RCON

RCON-Subsystem:

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

Funktionen:

- Credentials sicher speichern
- Verbindung testen
- `status`
- `map`
- `map_rotate`
- Serverinformationen
- kontrollierte Admin Commands

Audit Events:

```text
rcon.command
rcon.login
rcon.failure
```

## RCON / Integrierte Server-Konsole

Die Runtime-Oberfläche erhält eine integrierte Server-Konsole auf Basis von RCON und Live-Runtime-/Server-Output. Sie ersetzt nicht die eigentliche CoD4X-In-Game-Konsole, sondern stellt deren administrative Funktionen zentral in CONTROL bereit.

Vorgesehen:

- Live Server-/Runtime-Log
- RCON Command Input
- Command History
- Enter zum Senden
- Auto-Scroll
- Log-/Command-Filter
- Copy to Clipboard
- Clear
- Zeitstempel
- Warn-/Fehlerdarstellung
- RCON-Verbindungsstatus und Reconnect
- Log-Export
- Audit für ausgeführte RCON-Befehle

Sicherheitsgrundsatz:

- RCON-Passwort niemals in normalen Logs ausgeben
- gefährliche Commands kontrollieren
- Serverprozess darf unabhängig von der UI-Konsole weiterlaufen

Gate:

**Live Output + RCON Command + Response + Reconnect + Audit PASS**

---

## Block 8 – Master Server / Token

Integration des CoD4X Masterservers.

Ziel:

- Token einrichten
- Token entfernen
- Registration Status anzeigen
- Heartbeat Status anzeigen
- Fehler diagnostizieren

UI-Zustände:

```text
NOT_CONFIGURED
TOKEN_CONFIGURED
REGISTERING
REGISTERED
REGISTRATION_FAILED
HEARTBEAT_OK
HEARTBEAT_LOST
```

Wichtig:

Ein fehlender Master-Token darf den lokalen Serverstart nicht verhindern.

Token möglichst sicher speichern und nur beim Runtime-Start an CoD4X übergeben.

Audit Events:

```text
master.token.configured
master.token.removed
master.registration.started
master.registration.succeeded
master.registration.failed
master.heartbeat.detected
```

---

## Block 9 – Master List Verification

Nicht nur lokale Konfiguration anzeigen, sondern nach Möglichkeit tatsächlich prüfen:

```text
Master Server
     ↓
Server Query
     ↓
IP/Port bzw. Serveridentität
     ↓
Listed?
```

UI:

```text
Registration       ✓
Heartbeat          ✓
Listed             ✓
Last seen          ...
```

Ziel: Unterschied zwischen „Token gesetzt“ und „Server tatsächlich gelistet“ sichtbar machen.

---

## Block 10 – Plugin Manager

CoD4X Plugin-Verwaltung.

Plugin-Daten:

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

Unter anderem berücksichtigen:

```text
b3hide.dll
```

---

## Block 11 – eBc-B3 Audit

Repository:

`kristiandz/ebc-b3`

Vor Integration vollständiges Audit von:

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
```

Wichtig:

B3 wird nicht neu implementiert. eBc-B3 wird als bestehende B3-Implementierung verwendet und von CONTROL verwaltet.

---

## Block 12 – B3 Runtime

B3 läuft als separater Prozess.

Architektur:

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

B3-Absturz darf den CoD4X Server nicht mitreißen.

---

## Block 13 – B3 Manager

UI:

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

Health Checks:

```text
Python       ✓
B3           ✓
MySQL        ✓
Parser       ✓
RCON         ✓
CoD4X        ✓
```

---

## Block 14 – B3 Datenbank

Database Wizard:

```text
Database
├── Host
├── Port
├── Database
├── Username
└── Password
```

Ablauf:

```text
Test Connection
      ↓
Schema Check
      ↓
Migration
      ↓
B3 Ready
```

Keine destruktiven Migrationen ohne Backup.

---

## Block 15 – B3 In-Game Administration

Verwaltung bzw. Anzeige von:

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

B3 bleibt für die eigentliche In-Game-Administration zuständig.

---

## Block 15b – Live Kick (addendum 2026-10-20)

Kick a connected player immediately: slot mapping via RCON `status`, only `clientkick` unblocked in the RCON allowlist, `server.manage`, confirmation and audit.

---

## Block 16 – eBc-B3 / CoD4X Plugin Integration

Integration:

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

CONTROL generiert und validiert die notwendige B3/CoD4X-Konfiguration.

---

Addendum (2026-10-20): B3 plugin management (create from template or upload, enable/disable, config, hash + trust confirmation + audit) is planned with/after this block.

---

## Block 17 – Multi-Server

Mehrere unabhängige Serverinstanzen:

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

Pro Server separat:

- Port
- Homepath
- Config
- RCON
- Master Token
- B3
- Database
- Logs

---

## Block 18 – Remote Linux / SSH

Erst nach stabiler lokaler Windows- und Linux-Runtime.

Remote-Funktionen:

```text
SSH
├── Install
├── Update
├── Start
├── Stop
├── Restart
├── Logs
└── Health
```

---

## Block 19 – Docker

Optionaler Deployment-Modus:

```text
Deployment
├── Windows Native
├── Linux Native
└── Linux Docker
```

Docker soll die CoD4X-Verzeichnisse sauber als Volumes verwalten:

```text
main
zone
mods
plugins
usermaps
```

---

## Block 20 – Security Audit

### Runtime

- Path Traversal
- Arbitrary Executable
- Shell Injection
- PID Spoofing
- Process Ownership
- Symlinks
- Permissions

### Secrets

- Master Token
- RCON Password
- DB Password
- SSH Credentials

### B3

- Python Process Isolation
- DB Credentials
- Plugin Trust
- Config Injection

### Linux

- Root Execution verhindern
- File Permissions
- Executable Ownership

---

## Block 21 – Recovery / Backup

Vor kritischen Änderungen:

```text
Config Change
Plugin Install
B3 Migration
Server Update
Core Update
```

Ablauf:

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

Bestehende Backup-/Integrity-Mechanismen sollen weiterverwendet werden.

---

## Block 22 – End-to-End-Test

### Windows

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

### Linux

Gleicher Ablauf.

### Multi-Server

Beispiel:

```text
Server 1 → Port 28960
Server 2 → Port 28961
Server 3 → Port 28962
```

### Absichtliche Fehlerfälle

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

Keiner dieser Fehler darf CONTROL selbst mitreißen.

---

## Block 23 – Release / Installer

Erst nach vollständigem Test:

```text
Preflight
 ↓
Node Syntax
 ↓
Unit Tests
 ↓
Integration Tests
 ↓
Runtime Tests
 ↓
Security Checks
 ↓
Build
 ↓
SHA-256
 ↓
Artifact Verification
```

Zielartefakte:

```text
Windows Installer
Portable Windows
Linux Package / Deployment
```

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

## Grundprinzipien

1. `iw3mp.exe` niemals als Dedicated Server starten.
2. `cod4x18_dedrun` ist die Server-Runtime.
3. Windows und Linux teilen sich eine gemeinsame Runtime-API.
4. Jeder Server besitzt einen eigenen `fs_homepath`.
5. Masterserver-Token ist optional für den lokalen Serverbetrieb, aber erforderlich für die gewünschte Master-List-Listung.
6. B3 läuft als separater Prozess.
7. eBc-B3 wird integriert, nicht neu erfunden.
8. RCON, Master, B3 und Plugins sind pro Serverinstanz getrennt.
9. Kritische Änderungen erfolgen über Snapshot → Backup → Change → Verify.
10. Jeder Block wird einzeln getestet, bevor der nächste darauf aufbaut.
11. Kein Release ohne vollständigen End-to-End-Test.
12. Bei Unsicherheit wird die offizielle CoD4X-Quelle bzw. der tatsächliche Server-Code geprüft, statt Verhalten zu erfinden.
