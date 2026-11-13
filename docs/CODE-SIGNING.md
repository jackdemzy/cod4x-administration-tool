# Windows-Dateien signieren (Code-Signing)

Stand der Prüfung: 2026-11-13. Ziel: Setup- und Portable-EXE (und die App-EXE darin) mit einer
Authenticode-Signatur ausliefern. Der Release-Workflow ist dafür vorbereitet und baut ohne
Zugangsdaten weiter unsigniert.

## Ergebnis der Prüfung

| Weg | Für COD4X CONTROL (Privatperson, Deutschland) | Kosten |
|---|---|---|
| **SignPath Foundation** | **möglich**, Kriterien größtenteils erfüllt, drei Punkte fehlen noch (unten) | kostenlos |
| Azure Artifact Signing (früher „Trusted Signing“) | **nicht möglich**: Einzelentwickler nur in USA und Kanada; EU nur für Organisationen | Basic ca. 9,99 USD/Monat, 5.000 Signaturen |
| OV-Zertifikat einer CA | möglich, Schlüssel muss auf Token/HSM liegen; im CI nur über einen Cloud-Signaturdienst der CA | laut Microsoft ca. 300–500 USD/Jahr |

Keine der drei Varianten nimmt die SmartScreen-Warnung sofort weg; sie verschwindet, wenn die
Signatur Reputation aufgebaut hat (Microsoft: typischerweise einige Wochen und viele saubere
Installationen). Bei SignPath steht im Zertifikat „SignPath Foundation“ als Herausgeber.

### SignPath-Foundation-Kriterien

| Kriterium (signpath.org/terms) | Stand | Beleg |
|---|---|---|
| OSI-Lizenz ohne kommerzielle Doppellizenz | erfüllt | `LICENSE` = AGPL-3.0-or-later, GitHub erkennt `agpl-3.0` |
| Öffentliches Repository, Build nachvollziehbar | erfüllt | Repo ist öffentlich; Build nur in GitHub Actions auf GitHub-Runnern |
| Keine proprietären Bestandteile | erfüllt | Produktionsabhängigkeiten MIT, ISC, BSD, BlueOak, Unlicense; keine Spieldateien im Paket |
| Aktiv gepflegt | erfüllt | laufende Commits und Releases-Pipeline |
| **Schon in der zu signierenden Form veröffentlicht** | **fehlt** | noch kein veröffentlichtes GitHub-Release |
| Funktion auf der Download-Seite beschrieben | teilweise | README; Release-Text ergänzen |
| Nur eigene Binärdateien | erfüllt | Konfiguration signiert nur die App-EXE und die zwei Installer, keine DLLs |
| Keine Hacking-Werkzeuge | erfüllt | Server-Verwaltung, keine Funktionen zum Ausnutzen von Schwachstellen |
| Datenschutz, Systemänderungen, Deinstallation | erfüllt mit Policy | Verbindungen in `docs/CODE-SIGNING-POLICY.md`; NSIS fragt den Ordner, hat einen Deinstaller |
| MFA für GitHub und SignPath | **von dir zu bestätigen** | kann ich nicht prüfen |
| **„Code signing policy“ auf der Projekt-Startseite** | **fehlt** | Entwurf: `docs/CODE-SIGNING-POLICY.md`, noch nicht verlinkt |
| Produktname und Version in den Dateien | erfüllt | electron-builder setzt `ProductName` und Version |
| Jede Signatur manuell freigegeben | erfüllt | Workflow wartet auf die Freigabe in SignPath |

SignPath entscheidet selbst und muss kein Projekt annehmen.

## Was du selbst tun musst

1. **MFA** auf deinem GitHub-Konto prüfen (Settings → Password and authentication).
2. **Ein Release veröffentlichen**: Tag `v4.18.30` setzen, Entwurf prüfen und veröffentlichen
   (unsigniert, wie in `docs/RELEASE.md`). Das ist die „schon veröffentlicht“-Bedingung.
3. **Policy veröffentlichen**: in der README einen Abschnitt „Code signing policy“ mit Link auf
   `docs/CODE-SIGNING-POLICY.md` einfügen (oder den Text direkt). Die GitHub-Pages-Seite
   des Repos zeigt derzeit nur eine leere Seite; als Startseite im Antrag die Repo-URL angeben.
4. **Antrag** auf <https://signpath.org/apply> (auf Englisch): Repo-URL, Lizenz AGPL-3.0,
   Release-URL, kurze Beschreibung (Windows/Linux-Verwaltung für CoD4x-Server, Electron-App,
   Artefakte: NSIS-Setup-EXE und Portable-EXE).
5. **Nach Zusage** in SignPath (mit MFA):
   - Projekt mit Slug `cod4x-administration-tool` anlegen, Trusted Build System **GitHub.com** verknüpfen.
   - Zwei Artifact Configurations anlegen, Slugs genau `win-unpacked` und `win-installers`,
     Inhalt aus `.signpath/artifact-configurations/*.xml`.
   - Signing Policy für Releases (Slug z. B. `release-signing`), dich als Approver.
   - Einen CI-Benutzer mit Submitter-Recht anlegen und dessen API-Token erzeugen.
6. **In GitHub** (Repo → Settings → Secrets and variables → Actions):
   - Secret `SIGNPATH_API_TOKEN` = API-Token.
   - Variable `SIGNPATH_ORGANIZATION_ID` = Organisations-ID aus SignPath.
   - Optional: Variablen `SIGNPATH_PROJECT_SLUG` und `SIGNPATH_SIGNING_POLICY_SLUG`, falls andere
     Slugs als `cod4x-administration-tool` / `release-signing`.
7. **Testlauf**: Actions → Release → „Run workflow“ mit Haken „sign“. Im SignPath-Portal zweimal
   freigeben (erst App-Ordner, dann Installer). Der Lauf scheitert, wenn eine EXE keine gültige
   Signatur hat.
8. Ab dann signiert jeder Tag-Build automatisch; das Release bleibt ein Entwurf, den du veröffentlichst.

## Wie der Workflow signiert

```text
Stufe 1: Preflight → volle Suite → Vite → electron-builder --dir (win-unpacked)
   └─ mit SignPath: App-Ordner hochladen → Signatur „win-unpacked“ (App-EXE) → Signatur prüfen
Stufe 2: electron-builder nsis + portable --prepackaged win-unpacked
   └─ mit SignPath: beide EXE hochladen → Signatur „win-installers“ → Signaturen prüfen
Artefaktprüfung (mit SignPath: --require-signed) → Installer-Gate → Entwurfs-Release
```

- Signiert wird nur, wenn `SIGNPATH_API_TOKEN` und `SIGNPATH_ORGANIZATION_ID` gesetzt sind **und**
  der Lauf ein Tag-Build oder ein manueller Lauf mit „sign“ ist. Pull Requests bauen immer unsigniert.
- Ohne Zugangsdaten läuft derselbe zweistufige Build, nur ohne die Signaturschritte.
- `node scripts/release-verify.mjs --platform win` zeigt für jede EXE „signed“ oder „not signed“;
  mit `--require-signed` schlägt eine unsignierte EXE fehl. Ob die Signatur gültig ist, prüft
  `Get-AuthenticodeSignature` im Workflow.
- Bekannte Grenze: Der NSIS-Deinstaller, den electron-builder im Installer erzeugt, bleibt unsigniert,
  weil SignPath NSIS-Installer nicht öffnen kann. Er läuft nur aus dem installierten Ordner.
- Lokal (`npm run release:win`, `build.ps1`) bleibt der Build einstufig und unsigniert.

## Quellen (abgerufen 2026-11-13)

- SignPath Foundation, Bedingungen: <https://signpath.org/terms>
- SignPath, GitHub-Integration: <https://docs.signpath.io/trusted-build-systems/github>
- SignPath, Artifact-Configuration-Referenz: <https://docs.signpath.io/artifact-configuration/reference>
- Erfahrungsbericht Antrag (2026-02-16): <https://zenn.dev/shm_7ec/articles/signpath-oss-code-signing?locale=en>
- Microsoft Learn, Code signing options: <https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options>
- Microsoft Learn, Artifact Signing Quickstart (Voraussetzungen): <https://learn.microsoft.com/azure/artifact-signing/quickstart>
- Microsoft Learn, Sign an MSIX package (Kosten, Einschränkungen): <https://learn.microsoft.com/windows/msix/package/signing-package-overview>
- Azure-Preisseite Artifact Signing (Kontingente, Abrechnung ab Kontoanlage): <https://azure.microsoft.com/pricing/details/artifact-signing/>
