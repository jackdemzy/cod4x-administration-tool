# COD4X CONTROL 4.18.10

## B3 Runtime (Roadmap-Block 12)

### Architektur (Entscheidung des Betreibers)

- B3 läuft im selben Betriebssystem wie Backend und Instanz, über einen eigenen Prozessmanager nach dem Muster der Server-Runtime. Kein Umweg über `wsl.exe` aus Windows (PID wäre die von `wsl.exe`, Stop/Absturzerkennung unzuverlässig).

### Umsetzung

- `lib/b3-runtime.mjs`: B3-Prozess je Instanz mit `python2.7 -B -E b3_run.py --config <home>/b3/b3.xml`, `detached`, `shell:false`, minimale Umgebung, ohne B3-eigenes `-r` (CONTROL verwaltet Neustarts). Linux: Ausgabe in Dateien (überlebt Backend-Neustart), Ausführung als root blockiert.
  - Start erst nach Ablauf einer Startfrist als `RUNNING` (B3 beendet sich bei kritischen Startfehlern mit 220 nach ~2 s) → sonst `FAILED` mit Exit-Code und Ausgabe.
  - PID-Identität: Linux `/proc/<pid>/cmdline` + Eigentümer + Kernel-Startzeit (Schutz vor PID-Wiederverwendung), Windows CIM `CommandLine` + Erstellungszeit. Signale nur an verifizierte PIDs.
  - Stop: SIGTERM bzw. `taskkill /T`, Prüfung auf Prozessende, erst dann mit erneuter Identitätsprüfung SIGKILL bzw. `/F`.
  - Absturzerkennung (`CRASHED` mit Exit-Code/Signal), `LOST`, wenn ein nach Backend-Neustart erwarteter Prozess fehlt; laufende B3-Prozesse werden nach Backend-Neustart wiedererkannt.
  - Health: Prozessidentität, B3-Log-Marker „Start reading game events“, Fehler (`CRITICAL`, Traceback) → `DEGRADED`, RCON-Erreichbarkeit separat (`UNREACHABLE` ohne laufenden Server, B3 läuft weiter). Ausgabe begrenzt und redigiert.
- `lib/b3-config.mjs`: minimale B3-Laufzeitkonfiguration je Instanz (`parser cod4x`, SQLite unter `<home>/b3/b3.db`, eigener Log, Instanzport, `game_log` aus `g_log` der Instanz, Plugin `admin`, kein `autodoc`, kein Passwort). Atomar mit 0600 geschrieben. Die Spiel-Logdatei wird bei Bedarf leer angelegt, nie gekürzt.
- `lib/instance-b3-service.mjs`: Start nur bei `READY_FOR_RUNTIME_TEST` (Block 11), sonst `B3_DEPENDENCIES_BLOCKED`; Plattform muss zur Instanz passen. Keinerlei Kopplung an die CoD4x-Runtime; das Archivieren einer Instanz ist blockiert, solange B3 läuft.
- API: `GET /api/instances/:id/b3`, `POST …/b3/start|stop|restart`; Lebenszyklus-Ereignisse `b3.starting`, `b3.started`, `b3.start.failed`, `b3.stopping`, `b3.stopped`, `b3.crashed`, `b3.lost` im Audit.
- UI `lib/instance-b3-runtime.jsx`: Status, Health, PID, Laufzeit, Exit-Code/Signal, RCON-Hinweis, Ausgabe, Start/Stop/Neustart.

### eBc-B3-Stand neu festgeschrieben

- Der erste echte Start zeigte: Der neueste Commit `d44c05e` („Syntax update“) startet nie (`NameError: getAbsolutePath` in `b3/config.py`) und ändert zusätzlich die Ereignisverarbeitung. Auf Entscheidung des Betreibers ist jetzt `9096624` (direkter Vorgänger) der geprüfte Stand; `d44c05e` wird am Hash von `b3/config.py` erkannt und als `B3_KNOWN_BROKEN_COMMIT` blockiert. Audit-Bericht mit Nachtrag aktualisiert.

### Tests und Gates

- Neu: `test/b3-runtime.test.mjs`, `test/instance-b3-service.test.mjs` (Unabhängigkeit mit echtem `ServerInstanceManager`), `test/instance-b3-runtime.test.mjs`; Testdoubles `test/support/fake-b3-process.mjs`, `test/support/b3-instance-fixture.mjs`; Block-11- und HTTP-Tests erweitert.
- Gate `scripts/verify-4.18.10-b3-runtime-gate.mjs`: **B3 Lifecycle unabhängig vom CoD4X Lifecycle PASS** (13/13, Testdoubles).
- **Nativ** `scripts/verify-4.18.10-b3-native.mjs` in WSL `COD4X-Test` mit echtem Python 2.7.18 und eBc-B3 `9096624`: 15/15 PASS (Start → HEALTHY, RCON UNREACHABLE ohne Server, SIGKILL → CRASHED, Neustart, Wiedererkennung nach Backend-Neustart, SIGTERM-Stopp, unabhängiger Nachbarprozess unberührt, keine Restprozesse).
- Preflight `node scripts/preflight-4.18.10.mjs`: Windows Exit 0 (199 Tests: 193 PASS / 0 FAIL / 6 SKIP), WSL/Linux Exit 0 (199 Tests: 188 PASS / 0 FAIL / 11 SKIP, inkl. nativem B3-Test).
- Versionsprüfung kontrolliert jetzt auch `package-lock.json`. Ein Block-9-Test nutzte `import.meta.dirname` (erst ab Node 20.11) und lief unter Node 18 in WSL nicht – behoben.

### Grenzen / offen

- Kein echter CoD4x-Server lief neben B3; Ereignis-Parsing, RCON-Befehle und das Statusformat gegen 21.x sind weiterhin offen (Block 16 mit RCON-Passwort, nativer Test mit Server).
- B3 nutzt in dieser Stufe SQLite; MySQL/MariaDB folgt in Block 14.
- Unter Windows braucht B3 ein Windows-Python 2.7 (nicht installiert). Kein Release, kein Installer, kein Live-Deployment.
