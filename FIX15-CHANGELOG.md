# FIX15 – 4.10.5 Diagnostics & Health Monitor

## Audit-Block 4.10.5

Implementiert im bestehenden 3.0.2 RC1 Source-Stand:

- zentrale **Diagnostics & Health Monitor** Oberfläche
- lesender Diagnose-Lauf; keine Dateien werden verändert
- Prüfung von CoD4x-Version
- Prüfung des Client/Server-Zielprofils
- Prüfung des Installationspfads
- Prüfung des Installationsziels
- Verified-Core-Prüfung über vorhandenes `iw3mp.exe`
- Core-Manifest-Prüfung
- `server.cfg`-Datei- und Basis-DVAR-Prüfung
- Modul-/`mods`-Prüfung
- Prüfung des ausgewählten Moduls
- FPS Promod-Profilprüfung
- RCON-Host-Prüfung
- RCON-Port-Prüfung
- Netzwerk-Port-Bereichsprüfung
- Gesamtstatus `healthy` / `degraded`
- detaillierte Einzelprüfungen mit PASS/WARN/FAIL
- neue Diagnostics-Navigation im bestehenden UI-Stil
- bestehender Update Manager und Installer bleiben erhalten
- Build-Reparaturen aus FIX13/FIX14 bleiben erhalten
- App-Version bleibt **3.0.2 RC1**

Hinweis: Ein vorhandenes `iw3mp.exe` wird als Core-Präsenz geprüft; ohne autoritativen Referenz-Hash wird keine kryptographische Core-Echtheitsbehauptung erfunden.
