# Block 23 – Release / Installer (Zielversion 4.18.30) – Design

Stand: Entwurf zur Freigabe, 2026-11-13. Grundlage: main 4fa78d7 (4.18.29), Roadmap Block 23
(`COD4X-CONTROL-ROADMAP.md`, `COD4X-CONTROL-ROADMAP-DETAILED.md`). Sparvariante.
Entscheidung Rafiki (Karte 2026-11-13 20:40 UTC): **CI-Workflow, Linux als AppImage**.

## Ziel

Ein Release entsteht nur noch über **eine** Pipeline, in der Reihenfolge der Roadmap:

Preflight → Node-Syntax → Unit → Integration → Runtime → Security → Build → SHA-256 →
Artefaktprüfung → Installer-Test

Zielartefakte:

| Artefakt | Datei | Plattform |
|---|---|---|
| Windows-Installer | `COD4X-CONTROL-Setup-<v>-x64.exe` (NSIS, wie bisher) | Windows |
| Windows portabel | `COD4X-CONTROL-Portable-<v>-x64.exe` (electron-builder `portable`) | Windows |
| Linux | `COD4X-CONTROL-<v>-x86_64.AppImage` (volle Desktop-App) | Linux |

Dazu je Plattform `SHA256SUMS` und `release-manifest.json`.

Gate der Roadmap: **Installer Installation + First Run + Core Discovery + Server Start PASS**.

## Bestandsaufnahme

- `package.json`: `dist:win` baut nur NSIS; keine Portable-/Linux-Ziele. `build.ps1` macht
  `npm ci` → Preflight → Vite → `electron-builder --win nsis` und prüft nur, ob die EXE existiert.
  Keine Prüfsummen, kein Inhaltscheck, kein Installationstest.
- Preflight 4.18.29 deckt Syntax, Runtime-, E2E-, Recovery-, Security- und Block-Gates ab, aber
  nicht die ganze Testsuite (`node --test test/`).
- CI (`ci.yml`): Preflight + Vite-Build auf Windows/Ubuntu × Node 22/24, Electron-Download
  abgeschaltet. Kein Release-Workflow.
- Die volle Admin-Oberfläche ist die Electron-Renderer-Seite (`file://`); das Backend
  (`installer-server.mjs`) lauscht nur auf `127.0.0.1` und wird von Electron mit
  `ELECTRON_RUN_AS_NODE=1` aus dem Paket gestartet. Ein headless Linux-Paket hätte nur das Gateway.
- `test/support/e2e-backend.mjs` startet das echte Backend über HTTP, `test/support/e2e-core.mjs`
  liefert einen nativen Test-Core (Linux + gcc). Beides lässt sich für den Installer-Test nutzen.
- Issue #21 (minimatch über electron-builder) betrifft nur die Build-Werkzeuge, nicht das
  ausgelieferte Paket; bleibt offen.

## Umfang

### 1. Build-Ziele (`package.json`)

- `win.target`: `nsis` und `portable`; `portable.artifactName` eigener Name (siehe Tabelle).
- `linux.target`: `AppImage`, `category: Utility`, eigener `artifactName`.
- Skripte: `release:win`, `release:linux` (→ `scripts/release.mjs`), `release:verify`.
- `files` bleibt eine Positivliste; `dist/remote` ist über `dist/**/*` schon enthalten.

### 2. Release-Pipeline `scripts/release.mjs --platform win|linux`

Führt die Schritte nacheinander aus und bricht beim ersten Fehler ab (Exit ≠ 0, Schritt genannt):

1. `npm run preflight` (Syntax, Runtime, Security usw.).
2. Volle Testsuite `node --test test/` (Unit + Integration; einmal pro Release).
3. `npm run build` (Vite, Admin + Remote).
4. `electron-builder` mit den Zielen der Plattform.
5. `scripts/release-verify.mjs` (Punkt 3) schreibt `SHA256SUMS` + `release-manifest.json`
   und prüft die Artefakte.

`build.ps1` ruft danach dieselbe Prüfung auf und baut zusätzlich Portable; der bisherige Ablauf
(Dependencies zuerst, StdUtils-Reparatur) bleibt.

### 3. Artefaktprüfung `scripts/release-verify.mjs`

- Erwartete Dateien je Plattform vorhanden, Name enthält die Version aus `package.json`.
- SHA-256 jeder Datei → `SHA256SUMS` (Format von `sha256sum`, unter Linux mit `sha256sum -c`
  prüfbar) und `release-manifest.json` (Version, Commit, Größe, SHA-256, Node-/Electron-Version,
  Zeitstempel).
- Inhalt des `app.asar` (aus `dist-installer/<plattform>-unpacked/resources/app.asar`, gelesen mit
  `@electron/asar`, das electron-builder mitbringt):
  - Pflicht: `package.json` mit gleicher Version, `installer-server.mjs`, `electron-main.cjs`,
    `electron-preload.cjs`, `dist/index.html`, `dist/remote/remote.html`, `lib/`, `LICENSE`,
    Produktionsabhängigkeiten (`express`, `ssh2`, `tar`, `adm-zip`, `express-rate-limit`).
  - Verboten: `.env*`, `config/users.json`, `config/auth-user.json`, `data/`, `credential-vault/`,
    `backups/`, `test/`, `docs/`, `*.pem`, `*.key`, `node_modules/electron/`,
    `node_modules/electron-builder/`, `node_modules/vite/`.
- `--check <ordner>`: rechnet nur die Prüfsummen gegen eine vorhandene `SHA256SUMS` nach
  (für heruntergeladene Releases).

### 4. Installer-Test (Gate)

`scripts/verify-4.18.30-installer-gate.mjs` mit einem Test pro Plattform. Läuft nur, wenn
gebaute Artefakte da sind; sonst SKIP mit Grund (im normalen Preflight also SKIP).

- **Linux (CI, voll):** AppImage mit `--appimage-extract` entpacken (kein FUSE nötig) → Backend
  aus dem Paket starten (`<extrahiert>/cod4x-control` mit `ELECTRON_RUN_AS_NODE=1` und
  `resources/app.asar/installer-server.mjs`, wie `electron-main.cjs` es tut) → **First Run**
  (`/api/auth/status`, Ersteinrichtung des Admins) → **Core Discovery** (E2E-Test-Core als
  `cod4x18_dedrun` übernehmen) → Instanz anlegen → **Server Start** (antwortet auf `getinfo`) →
  Stop. Dafür bekommt `e2eBackend` eine Option für Programm und Skriptpfad; die Logik bleibt.
- **Windows (CI, teilweise):** NSIS still installieren (`/S /D=<ordner>`) → Dateien prüfen →
  Backend aus der installierten App starten (wie oben) → First Run → still deinstallieren
  (`Uninstall COD4X CONTROL.exe /S`) → Ordner weg. Core Discovery und Server Start brauchen einen
  echten Windows-Core und bleiben ein manueller Schritt (Checkliste).
- **Portabel:** nur Prüfsumme und Größe im CI; Start manuell.

### 5. CI-Workflow `.github/workflows/release.yml`

- Auslöser: `workflow_dispatch` und Tags `v*`.
- Jobs `windows-latest` und `ubuntu-latest`, Node 24: `npm ci` → `release.mjs` →
  Installer-Gate → Artefakte + `SHA256SUMS` + Manifest als Workflow-Artefakt hochladen.
- Nur bei einem Tag: ein **Entwurf** eines GitHub-Releases mit den Dateien (Rechte
  `contents: write` nur in diesem Job). Veröffentlichen bleibt Rafikis Schritt.
- Kein Code-Signing (kein Zertifikat vorhanden). SmartScreen-Warnung wird dokumentiert;
  electron-builder würde `CSC_LINK`/`CSC_KEY_PASSWORD` später ohne Codeänderung nutzen.
- `ci.yml` bleibt unverändert.

### 6. Version, Doku, Checkliste

- Version 4.18.30 (Release Candidate): `package.json`, `BUILD_INFO.json`, `build.ps1`,
  `CHANGELOG-4.18.30.md`, `DEVELOPMENT_STATUS.md`, README-Abschnitt, Preflight
  `scripts/preflight-4.18.30.mjs`, `verify-4.18.30-version.mjs`/`-runtime.mjs` wie üblich.
- `docs/RELEASE.md`: wie man ein Release baut, prüft (`sha256sum -c`, `release:verify --check`)
  und veröffentlicht.
- `docs/WSL-NATIVE-CHECKLIST.md` bekommt den Abschnitt „Block 23 – Windows-Release“ für Rafiki
  (siehe unten).

## Native Prüfungen für Rafiki (Windows, Node 24 LTS)

1. `build.cmd` läuft durch; Setup + Portable + `SHA256SUMS` liegen in `dist-installer/`.
2. `node scripts/release-verify.mjs --check dist-installer` → PASS.
3. Setup interaktiv installieren (eigener Ordner), Desktop-/Startmenü-Verknüpfung da.
4. Erststart: Fenster öffnet, Ersteinrichtung, Login.
5. Core Discovery mit echtem `cod4x18_dedrun.exe`, Server anlegen und starten, Client verbindet.
6. SmartScreen-Hinweis (unsigniert) erscheint wie dokumentiert.
7. Portable-EXE von einem USB-/anderen Ordner starten, Daten landen im Benutzerprofil.
8. Deinstallation entfernt Programm und (laut `deleteAppDataOnUninstall`) App-Daten.
9. Optional Linux-Desktop: AppImage starten (`chmod +x`), Erststart; ohne Schlüsselbund ist
   „Login merken“ bewusst aus.

## Nicht im Umfang

- Code-Signing, Auto-Update, Store-Pakete, `.deb`/`.rpm`, headless Linux-Paket.
- Änderungen am Produktcode außer Versionsangaben; findet der Installer-Test einen Fehler,
  wird er mit Regressionstest behoben.
- Issue #40 (A1-5) und #21.

## Risiken

- Die Electron-Binärdatei braucht auch mit `ELECTRON_RUN_AS_NODE` Systembibliotheken; auf
  `ubuntu-latest` werden fehlende Pakete (z. B. `libnss3`, `libgbm1`, `libasound2t64`) im
  Workflow installiert.
- Stille NSIS-Installation auf dem Windows-Runner: `/D=` muss das letzte Argument und ohne
  Anführungszeichen sein.
- electron-builder lädt Electron und NSIS/AppImage-Werkzeuge im CI herunter (Netz, Dauer).
