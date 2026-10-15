# FIX14 – Build-Paket korrigiert

- Korrigierte Paketstruktur: FIX14 ist jetzt der oberste Source-Ordner.
- `build.ps1` verwendet `npm ci`, wenn `package-lock.json` vorhanden ist.
- Fehlt der Lockfile, verwendet `build.ps1` automatisch `npm install` und prüft anschließend den erzeugten Lockfile.
- Die FIX13-Reparatur für `StdUtils.nsh` bleibt erhalten.
- App-Version bleibt 3.0.2 RC1.
- Keine Änderung am UI-/Update-Manager-Code gegenüber FIX13.
