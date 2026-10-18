# Entwicklungsstand vor dem ersten GitHub-Upload

Stand: 2026-10-19. Version 4.18.10. COD4X CONTROL / COD4X Administration Tool ist weiterhin in Entwicklung. Block 12 (B3 Runtime) ist umgesetzt: Gate „B3 Lifecycle unabhängig vom CoD4X Lifecycle“ PASS, zusätzlich nativ in WSL mit echtem Python 2.7.18 und eBc-B3 bestanden. eBc-B3 ist auf Commit 9096624 festgeschrieben, weil der neueste Commit d44c05e nicht startet. **Offen:** B3 lief noch nicht neben einem echten CoD4x-Server (RCON, Ereignisse, Statusformat), MySQL folgt in Block 14. Nächster Roadmap-Block ist 13 (B3 Manager, Version 4.18.11). Dies ist kein fertiger Release und kein Sicherheitszertifikat.

Zuletzt ausgeführt: node scripts/preflight-4.18.10.mjs unter Windows, Exit 0 (199 Tests: 193 PASS / 0 FAIL / 6 SKIP), und in WSL COD4X-Test (Ubuntu 24.04, Node 18), Exit 0 (199 Tests: 188 PASS / 0 FAIL / 11 SKIP, inkl. nativem B3-Lebenszyklus 15/15); npm run build PASS. Der native CIM-Inspektionstest kann bei langsamem PowerShell-Kaltstart am 3-s-Timeout scheitern (fail-closed, vorbestehend). Ein erfolgreicher Preflight ersetzt keine native Runtime-, UI-, Installer- oder vollständige Sicherheitsprüfung.

Der verschlüsselte Credential-Service, seine API und Oberfläche sind vorhanden; jede Vault-Sperre bricht einen laufenden Runtime-Credential-Zugriff sofort ab und überschreibt dessen Buffer. RCON-Passwort und (seit 4.18.6) optionaler Master-Token werden bei entsperrtem Tresor in einem gemeinsamen withRuntimeCredentials-Scope kurzlebig als „+set rcon_password“ bzw. „+set sv_authtoken“ an den Dedicated Core übergeben und in Runtime-History, -State und -Ausgabe redigiert; bei gesperrtem Tresor oder fehlendem Eintrag startet der Server ohne diese Werte. Beide sind als Startargument für lokale Prozessinspektion sichtbar (Win32_Process.CommandLine, /proc/<pid>/cmdline) – bekanntes Restrisiko. Das Join-Passwort ist weiterhin nicht an den Core angeschlossen. Keine echten Zugangsdaten für diese unfertige Integration verwenden.

Die Quellkonfiguration unter config/ enthält ausschließlich geprüfte leere/default Projektvorlagen. Für lokale Ausführung COD4X_DATA_ROOT auf ein separates, ignoriertes Datenverzeichnis setzen, z. B. in PowerShell vor dem Backendstart:

```powershell
$env:COD4X_DATA_ROOT = Join-Path (Get-Location) 'data'
npm start
```

Backend-/Auth-/Vault-/Serverdaten, Spielassets, Dedicated-Binaries, Abhängigkeiten, Build-Ausgaben, lokale Testhomes und ältere Arbeitskopien gehören nicht ins Repository. .gitignore schützt nur ungetrackte Dateien; vor jedem Commit auch Änderungen bereits getrackter Konfigurationsdateien prüfen.

Das Originalprojekt und die lokalen Sicherungen bleiben beim GitHub-Upload erhalten. Für Versions- und Architekturregeln gelten die vorhandenen ROADMAP-Dateien.
