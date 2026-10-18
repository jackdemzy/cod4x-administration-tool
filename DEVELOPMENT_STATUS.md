# Entwicklungsstand vor dem ersten GitHub-Upload

Stand: 2026-10-18. Version 4.18.9. COD4X CONTROL / COD4X Administration Tool ist weiterhin in Entwicklung. Block 11 (eBc-B3 Audit + Dependency Layer) ist umgesetzt: Audit in docs/EBC-B3-AUDIT.md, Gate „eBc-B3 Audit abgeschlossen + Dependency Matrix erstellt“ PASS. Wichtigste Befunde: eBc-B3 läuft nur mit Python 2.7, braucht python-dateutil und PyMySQL, und das CoD4x-21.x-Statusformat passt nur mit sv_legacyguidmode sicher zum Parser (nativ zu prüfen). **Offen:** B3 wurde noch nicht gestartet (Block 12); kein echtes Plugin, keine öffentliche Listung und kein RCON gegen einen nativen Core getestet. Nächster Roadmap-Block ist 12 (B3 Runtime, Version 4.18.10). Dies ist kein fertiger Release und kein Sicherheitszertifikat.

Zuletzt unter Windows ausgeführt: node scripts/preflight-4.18.9.mjs, Exit 0 (189 Tests: 183 PASS / 0 FAIL / 6 SKIP, dazu statische Regressionsprüfungen, 13/13 Config-, 15/15 RCON-, 11/11 Master-, 12/12 Listing-, 14/14 Plugin- und 13/13 B3-Audit-Gate-Prüfungen); npm run build PASS. Linux-/WSL-Gates wurden am aktuellen Stand nicht erneut ausgeführt und bleiben offen. Der native CIM-Inspektionstest kann bei langsamem PowerShell-Kaltstart am 3-s-Timeout scheitern (fail-closed, vorbestehend). Ein erfolgreicher Preflight ersetzt keine native Runtime-, UI-, Installer- oder vollständige Sicherheitsprüfung.

Der verschlüsselte Credential-Service, seine API und Oberfläche sind vorhanden; jede Vault-Sperre bricht einen laufenden Runtime-Credential-Zugriff sofort ab und überschreibt dessen Buffer. RCON-Passwort und (seit 4.18.6) optionaler Master-Token werden bei entsperrtem Tresor in einem gemeinsamen withRuntimeCredentials-Scope kurzlebig als „+set rcon_password“ bzw. „+set sv_authtoken“ an den Dedicated Core übergeben und in Runtime-History, -State und -Ausgabe redigiert; bei gesperrtem Tresor oder fehlendem Eintrag startet der Server ohne diese Werte. Beide sind als Startargument für lokale Prozessinspektion sichtbar (Win32_Process.CommandLine, /proc/<pid>/cmdline) – bekanntes Restrisiko. Das Join-Passwort ist weiterhin nicht an den Core angeschlossen. Keine echten Zugangsdaten für diese unfertige Integration verwenden.

Die Quellkonfiguration unter config/ enthält ausschließlich geprüfte leere/default Projektvorlagen. Für lokale Ausführung COD4X_DATA_ROOT auf ein separates, ignoriertes Datenverzeichnis setzen, z. B. in PowerShell vor dem Backendstart:

```powershell
$env:COD4X_DATA_ROOT = Join-Path (Get-Location) 'data'
npm start
```

Backend-/Auth-/Vault-/Serverdaten, Spielassets, Dedicated-Binaries, Abhängigkeiten, Build-Ausgaben, lokale Testhomes und ältere Arbeitskopien gehören nicht ins Repository. .gitignore schützt nur ungetrackte Dateien; vor jedem Commit auch Änderungen bereits getrackter Konfigurationsdateien prüfen.

Das Originalprojekt und die lokalen Sicherungen bleiben beim GitHub-Upload erhalten. Für Versions- und Architekturregeln gelten die vorhandenen ROADMAP-Dateien.
