# COD4X CONTROL 4.17.2 — Runtime Discovery Build

## Neu in 4.17.2

- Absoluter Windows-Runtime-Pfad wird akzeptiert.
- Ordnerauswahl über die Windows-App.
- Automatische Suche nach `iw3mp.exe`.
- Gefundene Cores können direkt übernommen werden.
- Verified-Core-Gate bleibt verpflichtend.
- SHA-256 des tatsächlich gefundenen `iw3mp.exe` wird geprüft.
- Bei geschützten Installationsordnern kann der operator-adopted Core-Nachweis im lokalen Runtime-Core-Registry-Verzeichnis gespeichert werden, falls neben `iw3mp.exe` nicht geschrieben werden darf.

## Windows Build

Im entpackten Quellordner PowerShell oder CMD öffnen und ausführen:

```powershell
.\build.cmd
```

Alternativ:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
```

Der Build führt zuerst den 4.17.2-Preflight aus und baut anschließend den Electron/NSIS-Installer.

## Runtime-Test

1. COD4X CONTROL starten.
2. `Runtime` öffnen.
3. Entweder `Durchsuchen` verwenden und den Ordner mit `iw3mp.exe` auswählen oder `Automatisch nach iw3mp.exe suchen` drücken.
4. Einen gefundenen Core mit `Übernehmen` auswählen.
5. Prüfen, dass `VERIFIED` angezeigt wird.
6. Falls der Core noch nicht übernommen wurde, `Vorhandenen Core übernehmen` ausführen.
7. Erst danach `Start` testen.
