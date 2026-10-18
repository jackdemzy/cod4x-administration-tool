# Entwicklungsstand vor dem ersten GitHub-Upload

Stand: 2026-10-18. Version 4.18.8. COD4X CONTROL / COD4X Administration Tool ist weiterhin in Entwicklung. Block 10 (Plugin Manager) ist auf Quellebene umgesetzt: Gate „Plugin Discovery + Enable/Disable + Integrity“ PASS mit inerten Testdateien gegen das UDP-Testdouble. Plugins werden nur mit freigegebenem SHA-256 geladen; Abweichung oder fehlende Datei blockiert den Start. **Offen:** Kein echtes Plugin (z. B. b3hide.dll/.so) wurde von einem nativen cod4x18_dedrun geladen; öffentliche Listung und RCON gegen einen echten Core sind weiterhin ungetestet. Nächster Roadmap-Block ist 11 (eBc-B3 Audit + Dependency Layer, Version 4.18.9). Dies ist kein fertiger Release und kein Sicherheitszertifikat.

Zuletzt unter Windows ausgeführt: node scripts/preflight-4.18.8.mjs, Exit 0 (182 Tests: 176 PASS / 0 FAIL / 6 SKIP, dazu statische Regressionsprüfungen, 13/13 Config-, 15/15 RCON-, 11/11 Master-, 12/12 Listing- und 14/14 Plugin-Gate-Prüfungen); npm run build PASS. Linux-/WSL-Gates wurden am aktuellen Stand nicht erneut ausgeführt und bleiben offen. Der native CIM-Inspektionstest kann bei langsamem PowerShell-Kaltstart am 3-s-Timeout scheitern (fail-closed, vorbestehend). Ein erfolgreicher Preflight ersetzt keine native Runtime-, UI-, Installer- oder vollständige Sicherheitsprüfung.

Der verschlüsselte Credential-Service, seine API und Oberfläche sind vorhanden; jede Vault-Sperre bricht einen laufenden Runtime-Credential-Zugriff sofort ab und überschreibt dessen Buffer. RCON-Passwort und (seit 4.18.6) optionaler Master-Token werden bei entsperrtem Tresor in einem gemeinsamen withRuntimeCredentials-Scope kurzlebig als „+set rcon_password“ bzw. „+set sv_authtoken“ an den Dedicated Core übergeben und in Runtime-History, -State und -Ausgabe redigiert; bei gesperrtem Tresor oder fehlendem Eintrag startet der Server ohne diese Werte. Beide sind als Startargument für lokale Prozessinspektion sichtbar (Win32_Process.CommandLine, /proc/<pid>/cmdline) – bekanntes Restrisiko. Das Join-Passwort ist weiterhin nicht an den Core angeschlossen. Keine echten Zugangsdaten für diese unfertige Integration verwenden.

Die Quellkonfiguration unter config/ enthält ausschließlich geprüfte leere/default Projektvorlagen. Für lokale Ausführung COD4X_DATA_ROOT auf ein separates, ignoriertes Datenverzeichnis setzen, z. B. in PowerShell vor dem Backendstart:

```powershell
$env:COD4X_DATA_ROOT = Join-Path (Get-Location) 'data'
npm start
```

Backend-/Auth-/Vault-/Serverdaten, Spielassets, Dedicated-Binaries, Abhängigkeiten, Build-Ausgaben, lokale Testhomes und ältere Arbeitskopien gehören nicht ins Repository. .gitignore schützt nur ungetrackte Dateien; vor jedem Commit auch Änderungen bereits getrackter Konfigurationsdateien prüfen.

Das Originalprojekt und die lokalen Sicherungen bleiben beim GitHub-Upload erhalten. Für Versions- und Architekturregeln gelten die vorhandenen ROADMAP-Dateien.
