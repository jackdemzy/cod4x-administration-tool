# Entwicklungsstand vor dem ersten GitHub-Upload

Status: 2026-11-05. Version 4.18.16. COD4X CONTROL / COD4X Administration Tool is still in development. Block 24b (remote access from browser and phone: gateway, PWA, cookie session, login brake, TOTP) is implemented with tests, the Remote Access gate and a Playwright phone check. Block 16 is still waiting. Next: Block 24c (alerts, optional public domain with Caddy).

Last run: node scripts/preflight-4.18.16.mjs on Linux (Node 22, unprivileged user, cloud container), exit 0 (365 tests: 359 PASS / 0 FAIL / 6 SKIP; native checks skipped there, no CoD4x core or test database). Remote Access gate 14/14, Monitoring gate 11/11. Windows and WSL runs for 4.18.15/4.18.16 are still open; last Windows/WSL run was 4.18.14 (339 tests, exit 0).

Der verschlüsselte Credential-Service, seine API und Oberfläche sind vorhanden; jede Vault-Sperre bricht einen laufenden Runtime-Credential-Zugriff sofort ab und überschreibt dessen Buffer. RCON-Passwort und (seit 4.18.6) optionaler Master-Token werden bei entsperrtem Tresor in einem gemeinsamen withRuntimeCredentials-Scope kurzlebig als „+set rcon_password“ bzw. „+set sv_authtoken“ an den Dedicated Core übergeben und in Runtime-History, -State und -Ausgabe redigiert; bei gesperrtem Tresor oder fehlendem Eintrag startet der Server ohne diese Werte. Beide sind als Startargument für lokale Prozessinspektion sichtbar (Win32_Process.CommandLine, /proc/<pid>/cmdline) – bekanntes Restrisiko. Das Join-Passwort ist weiterhin nicht an den Core angeschlossen. Keine echten Zugangsdaten für diese unfertige Integration verwenden.

Die Quellkonfiguration unter config/ enthält ausschließlich geprüfte leere/default Projektvorlagen. Für lokale Ausführung COD4X_DATA_ROOT auf ein separates, ignoriertes Datenverzeichnis setzen, z. B. in PowerShell vor dem Backendstart:

```powershell
$env:COD4X_DATA_ROOT = Join-Path (Get-Location) 'data'
npm start
```

Backend-/Auth-/Vault-/Serverdaten, Spielassets, Dedicated-Binaries, Abhängigkeiten, Build-Ausgaben, lokale Testhomes und ältere Arbeitskopien gehören nicht ins Repository. .gitignore schützt nur ungetrackte Dateien; vor jedem Commit auch Änderungen bereits getrackter Konfigurationsdateien prüfen.

Das Originalprojekt und die lokalen Sicherungen bleiben beim GitHub-Upload erhalten. Für Versions- und Architekturregeln gelten die vorhandenen ROADMAP-Dateien.
