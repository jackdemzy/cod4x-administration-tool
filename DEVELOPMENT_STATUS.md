# Entwicklungsstand vor dem ersten GitHub-Upload

Stand: 2026-10-19. Version 4.18.11. COD4X CONTROL / COD4X Administration Tool ist weiterhin in Entwicklung. Block 13 (B3 Manager) ist umgesetzt und per /engineering:code-review geprüft; die Review-Befunde sind mit Regressionstests behoben. Das Gate „B3 Manager Health Dashboard“ ist PASS, zusätzlich nativ in WSL mit echtem CoD4x-21.2-Linux-Core neben echtem eBc-B3 bestanden. **Offen:** RCON ✓ zwischen B3 und Server folgt mit der Passwortübergabe (Block 16), MySQL mit Block 14. Nächster Roadmap-Block ist 14 (B3 Datenbank, Version 4.18.12). Dies ist kein fertiger Release und kein Sicherheitszertifikat.

Zuletzt ausgeführt: node scripts/preflight-4.18.11.mjs unter Windows, Exit 0 (209 Tests: 203 PASS / 0 FAIL / 6 SKIP), und in WSL COD4X-Test, Exit 0 (209 Tests: 198 PASS / 0 FAIL / 11 SKIP, inkl. nativem B3-Lebenszyklus und nativem Dashboard mit echtem Server); npm run build PASS. Der native CIM-Inspektionstest kann bei langsamem PowerShell-Kaltstart am 3-s-Timeout scheitern (fail-closed, vorbestehend). Ein erfolgreicher Preflight ersetzt keine native Runtime-, UI-, Installer- oder vollständige Sicherheitsprüfung.

Der verschlüsselte Credential-Service, seine API und Oberfläche sind vorhanden; jede Vault-Sperre bricht einen laufenden Runtime-Credential-Zugriff sofort ab und überschreibt dessen Buffer. RCON-Passwort und (seit 4.18.6) optionaler Master-Token werden bei entsperrtem Tresor in einem gemeinsamen withRuntimeCredentials-Scope kurzlebig als „+set rcon_password“ bzw. „+set sv_authtoken“ an den Dedicated Core übergeben und in Runtime-History, -State und -Ausgabe redigiert; bei gesperrtem Tresor oder fehlendem Eintrag startet der Server ohne diese Werte. Beide sind als Startargument für lokale Prozessinspektion sichtbar (Win32_Process.CommandLine, /proc/<pid>/cmdline) – bekanntes Restrisiko. Das Join-Passwort ist weiterhin nicht an den Core angeschlossen. Keine echten Zugangsdaten für diese unfertige Integration verwenden.

Die Quellkonfiguration unter config/ enthält ausschließlich geprüfte leere/default Projektvorlagen. Für lokale Ausführung COD4X_DATA_ROOT auf ein separates, ignoriertes Datenverzeichnis setzen, z. B. in PowerShell vor dem Backendstart:

```powershell
$env:COD4X_DATA_ROOT = Join-Path (Get-Location) 'data'
npm start
```

Backend-/Auth-/Vault-/Serverdaten, Spielassets, Dedicated-Binaries, Abhängigkeiten, Build-Ausgaben, lokale Testhomes und ältere Arbeitskopien gehören nicht ins Repository. .gitignore schützt nur ungetrackte Dateien; vor jedem Commit auch Änderungen bereits getrackter Konfigurationsdateien prüfen.

Das Originalprojekt und die lokalen Sicherungen bleiben beim GitHub-Upload erhalten. Für Versions- und Architekturregeln gelten die vorhandenen ROADMAP-Dateien.
