# Entwicklungsstand vor dem ersten GitHub-Upload

Status: 2026-11-05. Version 4.18.19. COD4X CONTROL / COD4X Administration Tool is still in development. Block 24d (remote actions from the phone: message, kick, restart with TOTP step-up, limits and audit; also over the Caddy domain) is implemented with tests and the Remote Actions gate. Block 16 is still waiting. Next: real push, Discord and action test on Rafiki's phone.

Last run: node scripts/preflight-4.18.19.mjs on Linux (Node 22, unprivileged user, cloud container), exit 0 (381 tests: 375 PASS / 0 FAIL / 6 SKIP; native checks skipped there, no CoD4x core or test database). Remote Actions gate 11/11, Alerts gate 14/14, Runtime update gate 7/7, Remote Access gate 14/14, Monitoring gate 11/11. Local runs on 2026-11-06: Windows 11 (Node 24.21, after npm ci for Electron 45), exit 0 (381 tests: 371 PASS / 0 FAIL / 10 SKIP); WSL COD4X-Test (Node 24.21; the distro's Node 18 no longer meets >=22.12), exit 0 (381 tests: 339 PASS / 0 FAIL / 42 SKIP, the skips are the UI renderer tests that need the native Linux esbuild and one Windows-only inspection test), including the native checks: live kick against the real CoD4x 21.2 core, B3 admin, B3 database, B3 Manager health dashboard and B3 lifecycle all PASS.

Der verschlüsselte Credential-Service, seine API und Oberfläche sind vorhanden; jede Vault-Sperre bricht einen laufenden Runtime-Credential-Zugriff sofort ab und überschreibt dessen Buffer. RCON-Passwort und (seit 4.18.6) optionaler Master-Token werden bei entsperrtem Tresor in einem gemeinsamen withRuntimeCredentials-Scope kurzlebig als „+set rcon_password“ bzw. „+set sv_authtoken“ an den Dedicated Core übergeben und in Runtime-History, -State und -Ausgabe redigiert; bei gesperrtem Tresor oder fehlendem Eintrag startet der Server ohne diese Werte. Beide sind als Startargument für lokale Prozessinspektion sichtbar (Win32_Process.CommandLine, /proc/<pid>/cmdline) – bekanntes Restrisiko. Das Join-Passwort ist weiterhin nicht an den Core angeschlossen. Keine echten Zugangsdaten für diese unfertige Integration verwenden.

Die Quellkonfiguration unter config/ enthält ausschließlich geprüfte leere/default Projektvorlagen. Für lokale Ausführung COD4X_DATA_ROOT auf ein separates, ignoriertes Datenverzeichnis setzen, z. B. in PowerShell vor dem Backendstart:

```powershell
$env:COD4X_DATA_ROOT = Join-Path (Get-Location) 'data'
npm start
```

Backend-/Auth-/Vault-/Serverdaten, Spielassets, Dedicated-Binaries, Abhängigkeiten, Build-Ausgaben, lokale Testhomes und ältere Arbeitskopien gehören nicht ins Repository. .gitignore schützt nur ungetrackte Dateien; vor jedem Commit auch Änderungen bereits getrackter Konfigurationsdateien prüfen.

Das Originalprojekt und die lokalen Sicherungen bleiben beim GitHub-Upload erhalten. Für Versions- und Architekturregeln gelten die vorhandenen ROADMAP-Dateien.
