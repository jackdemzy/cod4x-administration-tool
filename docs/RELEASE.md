# Release bauen, prüfen und veröffentlichen (ab 4.18.30)

Roadmap Block 23. Ein Release entsteht nur über die Pipeline, nie über einen einzelnen `npm run build`.

## Pipeline

```text
Preflight → volle Testsuite → Build (Vite) → electron-builder → SHA-256 → Artefaktprüfung → Installer-Test
```

| Befehl | Was er tut |
|---|---|
| `npm run release:win` | Pipeline für Windows: Setup (NSIS) und Portable |
| `npm run release:linux` | Pipeline für Linux: AppImage |
| `node scripts/release.mjs --platform win --dry-run` | zeigt nur die Schritte |
| `npm run release:verify -- --platform win` | nur Artefaktprüfung + `SHA256SUMS` + `release-manifest.json` |
| `npm run release:verify -- --check <ordner>` | rechnet die Prüfsummen eines heruntergeladenen Releases nach |
| `COD4X_RELEASE_DIR=dist-installer node scripts/verify-4.18.30-installer-gate.mjs` | Installer-Gate gegen den Build |

`build.cmd` / `build.ps1` unter Windows macht dasselbe wie `release:win` ohne die volle Testsuite
(Dependencies, Preflight, Vite, Setup + Portable, Artefaktprüfung).

## Artefakte

| Datei | Inhalt |
|---|---|
| `COD4X-CONTROL-Setup-<v>-x64.exe` | Windows-Installer (Benutzer-Installation, Ordner wählbar) |
| `COD4X-CONTROL-Portable-<v>-x64.exe` | Windows ohne Installation |
| `COD4X-CONTROL-<v>-x86_64.AppImage` | Linux-Desktop-App |
| `SHA256SUMS` | SHA-256 jeder Datei, Format von `sha256sum` |
| `release-manifest.json` | Version, Commit, Größe, SHA-256, Node- und Electron-Version |

Die Artefaktprüfung bricht ab, wenn eine Datei fehlt, doppelt da ist oder kleiner als 1 MiB ist, und wenn
`app.asar` eine Pflichtdatei nicht enthält (Backend, Electron-Einstieg, `dist/index.html`,
`dist/remote/remote.html`, Produktionsabhängigkeiten) oder etwas Verbotenes enthält (`.env*`,
`config/users.json`, `config/auth-user.json`, Daten-, Tresor- und Backup-Ordner, `test/`, `docs/`,
`scripts/`, `*.pem`, `*.key`, Electron/electron-builder/Vite).

## Prüfsummen prüfen

```bash
sha256sum -c SHA256SUMS                     # Linux / WSL / Git Bash
node scripts/release-verify.mjs --check .   # überall mit Node
```

```powershell
Get-FileHash .\COD4X-CONTROL-Setup-4.18.30-x64.exe -Algorithm SHA256
```

## Veröffentlichen

1. `main` hat die Version im `package.json`, CI und der Workflow „Release“ sind grün.
2. Native Prüfungen aus `docs/WSL-NATIVE-CHECKLIST.md` Abschnitt 3g sind abgehakt.
3. Tag setzen: `git tag v4.18.30 && git push origin v4.18.30`.
4. Der Workflow „Release“ baut beide Plattformen, führt das Installer-Gate aus und legt einen
   **Entwurf** des GitHub-Releases mit allen Dateien und der gemeinsamen `SHA256SUMS` an.
   Stimmt der Tag nicht mit der Version überein, bricht er ab. Ein erneuter Lauf ersetzt die Dateien
   eines vorhandenen Entwurfs; ein schon veröffentlichtes Release ändert er nicht.
5. Entwurf auf GitHub prüfen und selbst veröffentlichen.

## Code-Signing

Die Dateien sind nicht signiert, Windows SmartScreen warnt beim ersten Start („Weitere Informationen“ →
„Trotzdem ausführen“). Mit einem Zertifikat später ohne Codeänderung: electron-builder liest
`CSC_LINK` und `CSC_KEY_PASSWORD` (im Workflow als Secrets). Die Pipeline setzt nur
`CSC_IDENTITY_AUTO_DISCOVERY=false`, damit nicht zufällig ein lokales Zertifikat verwendet wird.

## Linux

Das AppImage ist die volle Desktop-App (die Admin-Oberfläche gibt es nur in der App; das Backend lauscht
nur auf `127.0.0.1`). `chmod +x COD4X-CONTROL-<v>-x86_64.AppImage` und starten. Ohne FUSE:
`./COD4X-CONTROL-<v>-x86_64.AppImage --appimage-extract` und `squashfs-root/cod4x-control` starten.
Ohne Schlüsselbund (libsecret/kwallet) ist „Login merken“ bewusst aus.
