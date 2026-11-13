# Block 23 – Release / Installer (4.18.30) – Umsetzungsplan

Grundlage: Spec `docs/superpowers/specs/2026-11-13-release-installer-design.md` (gemergt mit PR #55,
main 672eeaa). Arbeitsweise Sparvariante: je Task ein Commit und Push; zwischendurch nur die
betroffenen Testdateien (als Nicht-Root, `umask 022`); Preflight und volle Suite einmal in Task 8;
ein Prüfer am Ende. electron-builder läuft lokal nur für Linux (AppImage); Windows-Artefakte baut
und prüft ausschließlich der CI-Workflow auf `windows-latest`.

Findet der Installer-Test einen Fehler im Produktcode, wird er im selben Task behoben: erst der rote
Schritt als Beleg, dann der kleinste Fix, dann ein Regressionstest. Prüfungen werden nie gelockert.

## Task 1 – Build-Ziele und Skripte

Dateien: `package.json`.

- `win.target`: `["nsis", "portable"]`; `portable.artifactName`:
  `COD4X-CONTROL-Portable-${version}-${arch}.exe`.
- `linux`: `target: ["AppImage"]`, `category: "Utility"`,
  `artifactName: "COD4X-CONTROL-${version}-${arch}.AppImage"`, `executableName: "cod4x-control"`.
- Skripte: `dist:win` → `electron-builder --win nsis portable`, `dist:linux` →
  `electron-builder --linux AppImage`, `release:win`/`release:linux` →
  `node scripts/release.mjs --platform win|linux`, `release:verify` →
  `node scripts/release-verify.mjs`.
- Test: `test/release-config.test.mjs` prüft Ziele, Namen (Version im Namen), dass `files` keine
  Muster für `test/`, `docs/`, `config/`, `.env` enthält.

## Task 2 – Artefaktprüfung `scripts/release-verify.mjs` + `lib`-freie Helfer

Dateien: `scripts/release-verify.mjs` (neu), `scripts/release-lib.mjs` (neu, reine Funktionen),
`test/release-verify.test.mjs` (neu).

- `expectedArtifacts(platform, version)`; `sha256File`; `writeSums(dir, files)` im
  `sha256sum`-Format (`<hex>  <name>`); `checkSums(dir)`; `manifest({version, commit, files, …})`.
- `asarPolicy(entries, version, readPackageJson)`: Pflicht- und Verbotsliste aus der Spec;
  Rückgabe `{ ok, missing, forbidden }`. Liste der Einträge über `@electron/asar` (`listPackage`),
  dynamisch importiert, damit der Test ohne Build mit einer Fake-Liste läuft.
- CLI: `--platform win|linux [--dir dist-installer]` (Prüfen + Schreiben) und `--check <dir>`
  (nur nachrechnen). Exit 1 mit Grund bei jedem Fehler.
- Tests: Prüfsummen schreiben/prüfen (manipulierte Datei → FAIL), fehlendes Artefakt → FAIL,
  asar-Policy mit Fake-Listen (fehlend `dist/index.html`, verboten `config/users.json`,
  `node_modules/electron/…`, falsche Version).

## Task 3 – Release-Pipeline `scripts/release.mjs`

Dateien: `scripts/release.mjs` (neu), `test/release-pipeline.test.mjs` (neu).

- Schritte als Liste `[name, command, args]`: Preflight, `node --test test/`, `npm run build`,
  `electron-builder` (Ziele der Plattform), `release-verify`. `spawnSync` mit `shell: false`
  (auf Windows `npm.cmd`/`npx.cmd` über `process.env.npm_execpath` bzw. `node <npm-cli>`), Abbruch
  beim ersten Exit ≠ 0 mit dem Namen des Schritts. `--dry-run` gibt nur die Schritte aus.
- Test: `--dry-run` für beide Plattformen liefert die Reihenfolge der Roadmap; unbekannte
  Plattform → Exit 2.

## Task 4 – Installer-Gate Linux (AppImage)

Dateien: `test/support/e2e-backend.mjs` (Option `server: { command, args, env }`, Standard
unverändert), `scripts/verify-4.18.30-installer-gate.mjs` (neu), `test/installer-linux.test.mjs`
(neu).

- Ohne `COD4X_RELEASE_DIR` oder ohne AppImage darin: SKIP mit Grund. Sonst: in ein Temp-Verzeichnis
  kopieren, `--appimage-extract`, Backend über `squashfs-root/cod4x-control` mit
  `ELECTRON_RUN_AS_NODE=1` und `squashfs-root/resources/app.asar/installer-server.mjs`.
- Ablauf mit den vorhandenen Helfern: First Run (Admin anlegen, Login), Core Discovery
  (`adoptCore` mit `buildE2eCore`), `createInstance`, Start, `answers(port)`, Stop, `silent(port)`.
- Lokal einmal mit einem echten `npm run dist:linux` laufen lassen.

## Task 5 – Installer-Gate Windows (NSIS)

Dateien: `scripts/verify-4.18.30-installer-gate.mjs` (Windows-Zweig), `test/installer-windows.test.mjs`
(neu).

- Nur auf Windows mit `COD4X_RELEASE_DIR`, sonst SKIP. Setup mit `/S /D=<temp>\app` ausführen
  (`/D` zuletzt, ohne Anführungszeichen), `COD4X CONTROL.exe` und `resources\app.asar` vorhanden,
  Backend wie in Task 4 aus der Installation starten, First Run, Backend stoppen,
  `Uninstall COD4X CONTROL.exe /S`, warten bis der Ordner leer bzw. weg ist.
- Wird hier nur im CI ausgeführt (Task 6); lokal wird nur die SKIP-Logik getestet.

## Task 6 – Release-Workflow

Dateien: `.github/workflows/release.yml` (neu), `test/release-workflow.test.mjs` (neu, prüft Text).

- `on: workflow_dispatch` und `push: tags: ['v*']`; `permissions: contents: read`.
- Job `build` Matrix `windows-latest`/`ubuntu-latest`, Node 24, langer TEMP wie in `ci.yml`;
  Ubuntu installiert `libnss3 libgbm1 libasound2t64 libgtk-3-0 libxss1` und `gcc`.
  `npm ci` → `npm run release:<plattform>` → Installer-Gate mit `COD4X_RELEASE_DIR=dist-installer`
  → `actions/upload-artifact` (Artefakte, `SHA256SUMS`, `release-manifest.json`).
  `GH_TOKEN` wird electron-builder nicht gegeben (`--publish never`).
- Job `draft-release` nur bei Tag, `needs: build`, `permissions: contents: write`: Artefakte laden,
  Entwurfs-Release per `gh release create --draft` mit gemeinsamer `SHA256SUMS`.
- Actions wie in `ci.yml` (`@v4`).
- Nach dem Push einmal per `workflow_dispatch` auf dem Zweig auslösen (falls die Rechte das
  erlauben; sonst bitte ich Rafiki darum) und rot → Ursache beheben.

## Task 7 – build.ps1, Version 4.18.30, Doku

Dateien: `build.ps1`, `package.json`/`package-lock.json`, `BUILD_INFO.json`,
`scripts/preflight-4.18.30.mjs`, `scripts/verify-4.18.30-version.mjs`,
`scripts/verify-4.18.30-runtime.mjs`, `CHANGELOG-4.18.30.md`, `DEVELOPMENT_STATUS.md`, `README.md`,
`COD4X-CONTROL-ROADMAP.md` (Status-Notiz Block 23), `docs/RELEASE.md` (neu),
`docs/WSL-NATIVE-CHECKLIST.md` (Abschnitt Block 23).

- `build.ps1`: Banner 4.18.30, `electron-builder --win nsis portable`, danach
  `node scripts/release-verify.mjs --platform win`; prüft Setup und Portable.
- Preflight 4.18.30 = 4.18.29 plus Syntax der neuen Skripte, Release-Tests und Installer-Gate
  (SKIP ohne Artefakte). Version-Check wie bisher plus Portable-Name in `build.ps1`.
- `docs/RELEASE.md`: bauen, prüfen (`sha256sum -c SHA256SUMS`, `npm run release:verify -- --check`),
  Tag setzen, Entwurf veröffentlichen, SmartScreen-Hinweis, späteres Signieren über `CSC_LINK`.
- Checkliste mit den neun nativen Schritten aus der Spec.

## Task 8 – Abschluss

- Preflight 4.18.30 und volle Suite einmal (Nicht-Root, `umask 022`), Ergebnis im PR.
- Ein Prüfer (Opus) über den Diff; Befunde beheben.
- PR als Entwurf, bis CI und Release-Workflow grün sind; offene Issues/PRs laut CLAUDE.md nennen.
