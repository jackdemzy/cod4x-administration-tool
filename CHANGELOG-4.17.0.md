# COD4X CONTROL 4.17.0 — Production Runtime Foundation

## Neu
- Persistenter Production-Runtime-State unter `config/runtime-state.json` (innerhalb des konfigurierten Data Root).
- Native Windows-Ausführung der festen CoD4x-Executable `iw3mp.exe`.
- Start/Stop/Restart API mit `server.manage` bzw. `diagnostics.read`.
- Verified-Core-Gate vor jedem Start.
- `shell:false` und sichere Installationspfadprüfung.
- PID-Verifikation über `tasklist.exe` vor einem `taskkill.exe`-Stop.
- Exit-/Failure-Erkennung und begrenzte Runtime-History.
- Audit-Ereignisse für Start, Stop, Restart und blockierte Aktionen.
- Expliziter `COD4X_DATA_ROOT`, damit GUI und späterer Windows-Background-Service nicht vom aktuellen Arbeitsverzeichnis abhängen.
- Neue Production-Runtime-Oberfläche.

## Abgrenzung
4.17.0 ist die Runtime-Grundlage. Die eigentliche SCM-Service-Registrierung und Boot-Autostart-Integration bleiben als separater 4.17.x-Schritt, damit die Service-Laufzeit nicht ungetestet in diesen Block hineingezogen wird.
