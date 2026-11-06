# Entwicklungsstand vor dem ersten GitHub-Upload

Status: 2026-11-06. Version 4.18.20. COD4X CONTROL / COD4X Administration Tool is still in development. Block 16 (B3 <-> CoD4x integration: one switch wires the b3hide core plugin and the eBc-B3 auth plugin with one prefix and level threshold; B3 gets the RCON password from the vault; optional !auth passwords per level; the b3hide status format is parsed) is implemented from the approved design (docs/superpowers/specs/2026-11-06-b3-cod4x-integration-design.md) with TDD. Next: Block 16b (B3 plugin management), then the phone test of 4.18.16-4.18.19 and the manual hidden-chat check with a real game client.

Last run: node scripts/preflight-4.18.20.mjs on Windows 11 (Node 24.21), exit 0 (425 tests: 415 PASS / 0 FAIL / 10 SKIP), and in WSL COD4X-Test (Node 24.21), exit 0 (425 tests: 379 PASS / 0 FAIL / 46 SKIP; the skips are the UI renderer tests that need the native Linux esbuild and Windows-only tests), including the native checks: B3 integration 12/12 against the real CoD4x 21.2 core with the official 21.2 release b3hide.so and two bots, live kick, B3 admin, B3 database, B3 Manager health dashboard and B3 lifecycle all PASS. B3 integration gate 13/13. The 4.18.15-4.18.19 gates stay part of the preflight.

Der verschlüsselte Credential-Service, seine API und Oberfläche sind vorhanden; jede Vault-Sperre bricht einen laufenden Runtime-Credential-Zugriff sofort ab und überschreibt dessen Buffer. RCON-Passwort und (seit 4.18.6) optionaler Master-Token werden bei entsperrtem Tresor in einem gemeinsamen withRuntimeCredentials-Scope kurzlebig als „+set rcon_password“ bzw. „+set sv_authtoken“ an den Dedicated Core übergeben und in Runtime-History, -State und -Ausgabe redigiert; bei gesperrtem Tresor oder fehlendem Eintrag startet der Server ohne diese Werte. Beide sind als Startargument für lokale Prozessinspektion sichtbar (Win32_Process.CommandLine, /proc/<pid>/cmdline) – bekanntes Restrisiko. Das Join-Passwort ist weiterhin nicht an den Core angeschlossen. Keine echten Zugangsdaten für diese unfertige Integration verwenden.

Die Quellkonfiguration unter config/ enthält ausschließlich geprüfte leere/default Projektvorlagen. Für lokale Ausführung COD4X_DATA_ROOT auf ein separates, ignoriertes Datenverzeichnis setzen, z. B. in PowerShell vor dem Backendstart:

```powershell
$env:COD4X_DATA_ROOT = Join-Path (Get-Location) 'data'
npm start
```

Backend-/Auth-/Vault-/Serverdaten, Spielassets, Dedicated-Binaries, Abhängigkeiten, Build-Ausgaben, lokale Testhomes und ältere Arbeitskopien gehören nicht ins Repository. .gitignore schützt nur ungetrackte Dateien; vor jedem Commit auch Änderungen bereits getrackter Konfigurationsdateien prüfen.

Das Originalprojekt und die lokalen Sicherungen bleiben beim GitHub-Upload erhalten. Für Versions- und Architekturregeln gelten die vorhandenen ROADMAP-Dateien.
