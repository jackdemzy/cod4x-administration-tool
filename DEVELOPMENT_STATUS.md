# Entwicklungsstand vor dem ersten GitHub-Upload

Status: 2026-10-20. Version 4.18.14. COD4X CONTROL / COD4X Administration Tool is still in development. Block 15b (Live Kick) is implemented from the approved design (docs/superpowers/specs/2026-10-20-live-kick-design.md) with TDD and reviewed before the PR (superpowers:requesting-code-review); all important findings are fixed with regression tests. Next: Block 16 (eBc-B3 / CoD4X plugin integration, plus B3 plugin management).

Last run: node scripts/preflight-4.18.14.mjs on Windows, exit 0 (339 tests: 329 PASS / 0 FAIL / 10 SKIP), and in WSL COD4X-Test (Node 18), exit 0 (339 tests: 304 PASS / 0 FAIL / 35 SKIP, including the native checks: live kick against the real CoD4x 21.2 core with bots 8/8, B3 admin 16/16 and B3 database 15/15).

Der verschlüsselte Credential-Service, seine API und Oberfläche sind vorhanden; jede Vault-Sperre bricht einen laufenden Runtime-Credential-Zugriff sofort ab und überschreibt dessen Buffer. RCON-Passwort und (seit 4.18.6) optionaler Master-Token werden bei entsperrtem Tresor in einem gemeinsamen withRuntimeCredentials-Scope kurzlebig als „+set rcon_password“ bzw. „+set sv_authtoken“ an den Dedicated Core übergeben und in Runtime-History, -State und -Ausgabe redigiert; bei gesperrtem Tresor oder fehlendem Eintrag startet der Server ohne diese Werte. Beide sind als Startargument für lokale Prozessinspektion sichtbar (Win32_Process.CommandLine, /proc/<pid>/cmdline) – bekanntes Restrisiko. Das Join-Passwort ist weiterhin nicht an den Core angeschlossen. Keine echten Zugangsdaten für diese unfertige Integration verwenden.

Die Quellkonfiguration unter config/ enthält ausschließlich geprüfte leere/default Projektvorlagen. Für lokale Ausführung COD4X_DATA_ROOT auf ein separates, ignoriertes Datenverzeichnis setzen, z. B. in PowerShell vor dem Backendstart:

```powershell
$env:COD4X_DATA_ROOT = Join-Path (Get-Location) 'data'
npm start
```

Backend-/Auth-/Vault-/Serverdaten, Spielassets, Dedicated-Binaries, Abhängigkeiten, Build-Ausgaben, lokale Testhomes und ältere Arbeitskopien gehören nicht ins Repository. .gitignore schützt nur ungetrackte Dateien; vor jedem Commit auch Änderungen bereits getrackter Konfigurationsdateien prüfen.

Das Originalprojekt und die lokalen Sicherungen bleiben beim GitHub-Upload erhalten. Für Versions- und Architekturregeln gelten die vorhandenen ROADMAP-Dateien.
