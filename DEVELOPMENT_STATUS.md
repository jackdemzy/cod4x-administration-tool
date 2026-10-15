# Entwicklungsstand vor dem ersten GitHub-Upload

Stand: 2026-10-15. Version 4.18.3. COD4X CONTROL / COD4X Administration Tool ist weiterhin in Entwicklung. Block 6 (Config Engine) ist offen; dies ist kein fertiger Release und kein Sicherheitszertifikat.

Zuletzt unter Windows ausgeführt: node scripts/preflight-4.18.3.mjs, 130 PASS / 0 FAIL / 6 SKIP, Exit 0. Linux-/WSL-Gates wurden am aktuellen Stand nicht erneut ausgeführt und bleiben offen. Ein erfolgreicher Preflight ersetzt keine native Runtime-, UI-, Installer- oder vollständige Sicherheitsprüfung.

Der verschlüsselte Credential-Service, seine API und Oberfläche sind vorhanden. Ein interner kurzlebiger Runtime-Credential-Zugriff wird entwickelt und wurde in einer isolierten nativen Windows-Probe verwendet. Der normale ServerInstanceManager-Start ist noch nicht daran angeschlossen: gespeicherte Credentials bedeuten nicht, dass sie im Dedicated-Core aktiv sind.

Offener Review-Befund: Eine durch konkurrierendes Lesen ausgelöste Vault-Sperre muss auch den laufenden Credential-Zugriff sofort abbrechen und dessen Buffer überschreiben. Dieser Fehlerpfad ist noch zu korrigieren und zu testen. Start-/Lock-/Recovery-Regeln, kurzlebige Secret-Dateien und optionale Masterregistrierung sind nicht vollständig integriert. Keine echten Zugangsdaten für diese unfertige Integration verwenden.

Die Quellkonfiguration unter config/ enthält ausschließlich geprüfte leere/default Projektvorlagen. Für lokale Ausführung COD4X_DATA_ROOT auf ein separates, ignoriertes Datenverzeichnis setzen, z. B. in PowerShell vor dem Backendstart:

```powershell
$env:COD4X_DATA_ROOT = Join-Path (Get-Location) 'data'
npm start
```

Backend-/Auth-/Vault-/Serverdaten, Spielassets, Dedicated-Binaries, Abhängigkeiten, Build-Ausgaben, lokale Testhomes und ältere Arbeitskopien gehören nicht ins Repository. .gitignore schützt nur ungetrackte Dateien; vor jedem Commit auch Änderungen bereits getrackter Konfigurationsdateien prüfen.

Das Originalprojekt und die lokalen Sicherungen bleiben beim GitHub-Upload erhalten. Für Versions- und Architekturregeln gelten die vorhandenen ROADMAP-Dateien.
