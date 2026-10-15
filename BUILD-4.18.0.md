# COD4X CONTROL 4.18.0 – Build / Test Notes

## Ziel

Block 0 + Block 1 der technischen Roadmap: Architekturgrundlage und Dedicated Server Core Foundation.

## Core Identity

```text
Windows: cod4x18_dedrun.exe
Linux:   cod4x18_dedrun
Client:  iw3mp.exe  → NICHT als Dedicated Server Core akzeptiert
```

## Lokale Prüfungen

```text
4.18.0 preflight PASS
Node syntax PASS
Dedicated Server Core model PASS
Windows cod4x18_dedrun.exe identity PASS
Linux cod4x18_dedrun identity PASS
Client iw3mp.exe excluded from Dedicated Core model PASS
Cross-platform Core Discovery PASS
Verified-Core platform binding PASS
SHA-256 fingerprint validation PASS
PID verification / taskkill guard retained PASS
fs_basepath / fs_homepath separation retained PASS
Windows runtime only gate PASS
Remembered login / Windows safeStorage protection retained PASS
```

Zusätzlich wurde `scripts/verify-4.18.0-static.mjs` erfolgreich ausgeführt.

## Build-Hinweis

Der vollständige Vite/Electron-Build muss auf einem Rechner mit den Projekt-Dependencies ausgeführt werden:

```powershell
npm install
npm run preflight
npm run build
```

Der Linux-Runtime-Start ist absichtlich noch gesperrt und gehört zu Block 5.
