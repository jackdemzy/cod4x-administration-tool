# Entwicklungsstand vor dem ersten GitHub-Upload

Status: 2026-11-07. Version 4.18.22. COD4X CONTROL / COD4X Administration Tool is still in development. Block 17 (multi-server isolation) is implemented from the design in docs/superpowers/specs/2026-11-07-multi-server-design.md with TDD: two instances can no longer use the same B3 MySQL database (refused on save and on B3 start), a master token or RCON password shared with another instance is shown as a warning (instance IDs only), a hand-edited server.cfg cannot move g_log out of its instance, and instances with stored credentials can be launched in parallel (runtime credential scopes in the vault take turns with a bounded wait; before, the second launch failed with VAULT_OPERATION_BUSY). Block 16b (B3 plugin management, 4.18.21) and Block 16 (B3 <-> CoD4x integration, 4.18.20) are unchanged. Next: the native three-core check (scripts/verify-4.18.22-multi-server-native.mjs, not run yet), the phone test of 4.18.16-4.18.19, the manual hidden-chat check and a custom plugin command with a real game client.

Last run (cloud container, Linux, Node 22.23.4, non-root user): node scripts/preflight-4.18.22.mjs exit 0; full suite node --test "test/*.test.mjs" 525 tests: 518 PASS / 0 FAIL / 7 SKIP. As root five existing tests fail (four native Linux process tests and runtime-http-integration, "Dedicated runtime must not run as root"); they fail the same way on 4.18.21. Not re-run for 4.18.22: the Windows 11 run and the WSL COD4X-Test run with real CoD4x, Python 2.7 and eBc-B3 (last recorded for 4.18.21: Windows 475 PASS / 0 FAIL / 10 SKIP of 485, WSL 431 PASS / 0 FAIL / 54 SKIP of 485). The native checks of 4.18.15-4.18.21 stay part of the preflight and skip without their prerequisites.

Der verschlüsselte Credential-Service, seine API und Oberfläche sind vorhanden; jede Vault-Sperre bricht einen laufenden Runtime-Credential-Zugriff sofort ab und überschreibt dessen Buffer. RCON-Passwort und (seit 4.18.6) optionaler Master-Token werden bei entsperrtem Tresor in einem gemeinsamen withRuntimeCredentials-Scope kurzlebig als „+set rcon_password“ bzw. „+set sv_authtoken“ an den Dedicated Core übergeben und in Runtime-History, -State und -Ausgabe redigiert; bei gesperrtem Tresor oder fehlendem Eintrag startet der Server ohne diese Werte. Beide sind als Startargument für lokale Prozessinspektion sichtbar (Win32_Process.CommandLine, /proc/<pid>/cmdline) – bekanntes Restrisiko. Das Join-Passwort ist weiterhin nicht an den Core angeschlossen. Keine echten Zugangsdaten für diese unfertige Integration verwenden.

Die Quellkonfiguration unter config/ enthält ausschließlich geprüfte leere/default Projektvorlagen. Für lokale Ausführung COD4X_DATA_ROOT auf ein separates, ignoriertes Datenverzeichnis setzen, z. B. in PowerShell vor dem Backendstart:

```powershell
$env:COD4X_DATA_ROOT = Join-Path (Get-Location) 'data'
npm start
```

Backend-/Auth-/Vault-/Serverdaten, Spielassets, Dedicated-Binaries, Abhängigkeiten, Build-Ausgaben, lokale Testhomes und ältere Arbeitskopien gehören nicht ins Repository. .gitignore schützt nur ungetrackte Dateien; vor jedem Commit auch Änderungen bereits getrackter Konfigurationsdateien prüfen.

Das Originalprojekt und die lokalen Sicherungen bleiben beim GitHub-Upload erhalten. Für Versions- und Architekturregeln gelten die vorhandenen ROADMAP-Dateien.
