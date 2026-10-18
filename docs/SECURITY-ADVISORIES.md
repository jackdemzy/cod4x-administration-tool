# Bewertung offener Sicherheitswarnungen (Dependabot)

Stand: 2026-10-19 · Branch `control-4.18.11` (4.18.11) · Bewertet mit `npm audit` (GitHub Advisory Database) gegen `package-lock.json`, die auf `main` und `control-4.18.11` dieselben Abhängigkeitsversionen enthält. Abhängigkeiten wurden **nicht** geändert.

GitHub meldete beim Push 2 Warnungen auf dem Default-Branch: 1 hoch, 1 mittel. `npm audit` listet 9 Einträge; 7 davon sind nur Pakete, die diese beiden Advisories weitervererben (`@electron/get`, `app-builder-lib`, `dmg-builder`, `electron-builder`, `electron-builder-squirrel-windows`, `global-agent`, `roarr`).

## Übersicht

| Advisory | Paket (installiert) | Schwere | Gepatchte Version | Ausgeliefert? | Bewertung |
|---|---|---|---|---|---|
| [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) / CVE-2026-93748 | `http-cache-semantics` 4.2.0 | hoch (CVSS 7.5) | keine | nein (nur Build) | im Projekt nicht ausnutzbar, Risiko akzeptiert |
| [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) / CVE-2026-97058 | `sprintf-js` 1.1.3 | mittel (CVSS 5.3) | keine | nein (nur Build) | im Projekt nicht ausnutzbar, Risiko akzeptiert |

## Wo die Pakete hängen

Beide kommen ausschließlich über das Installer-Bauwerkzeug `electron-builder` (devDependency):

```text
electron-builder 26.15.3
└── app-builder-lib 26.15.3
    └── @electron/get 3.1.0          (lädt beim Bauen Electron-Binaries herunter)
        ├── got 11.8.6
        │   └── cacheable-request 7.0.4
        │       └── http-cache-semantics 4.2.0
        └── global-agent 3.0.0
            └── roarr 2.15.4
                └── sprintf-js 1.1.3
```

- Der App-Code (`lib/`, `src/`, `installer-server.mjs`, `electron-main.cjs`, `electron-preload.cjs`, `scripts/`) importiert keines dieser Pakete.
- Produktionsabhängigkeiten sind nur `adm-zip`, `express`, `react`, `react-dom` und `tar`. `npm ls http-cache-semantics sprintf-js --omit=dev` ist leer.
- electron-builder packt keine devDependencies in den Installer. `build.files` enthält nur `dist/**`, die Electron-Einstiegsdateien, `installer-server.mjs`, `lib/**` und `package.json`.

## 1. GHSA-ch52-4w7c-c8xp – `http-cache-semantics` ≤ 4.2.0 (hoch)

**Problem laut Advisory:** Bei Client-Anfragen mit `max-stale` werden aus Sicherheitsgründen geleerte Einträge eines **geteilten** Caches nicht korrekt geprüft. Ein Angreifer kann so zwischengespeicherte Antworten anderer Nutzer abrufen, etwa deren `Set-Cookie`-Sitzungsdaten.

**Bewertung für COD4X CONTROL:**
- Das Paket läuft nur beim Bauen des Installers. `@electron/get` lädt dabei über `got`/`cacheable-request` Electron-Archive herunter. Es gibt keinen geteilten Cache, keine Fremdnutzer und keine Sitzungs-Cookies; der Angriffsweg existiert in diesem Kontext nicht.
- Die ausgelieferte App und das CONTROL-Backend enthalten das Paket nicht.

**Warum kein Update auf 4.3.0:** `http-cache-semantics` 4.3.0 (npm, veröffentlicht am 2026-10-04) liegt formal außerhalb des Bereichs „≤ 4.2.0“. Der Vergleich der npm-Pakete 4.2.0 → 4.3.0 zeigt aber nur zwei Änderungen: den `Vary`-Abgleich (Prüfung mit `hasOwnProperty`) und einen zurückgegebenen Statuswert. **Die `max-stale`-Behandlung ist unverändert.** Das Advisory nennt keine gepatchte Version. Ein Override auf 4.3.0 würde die Warnung also zum Verschwinden bringen, ohne die Lücke nachweislich zu schließen. Darauf wurde bewusst verzichtet.

## 2. GHSA-hp3w-g68c-fv3c – `sprintf-js` ≤ 1.1.3 (mittel)

**Problem laut Advisory:** Unbegrenzte Präzisionsangaben in Format-Strings werden ungeprüft an `toFixed`/`toExponential`/`toPrecision` weitergegeben. Wer den Format-String kontrolliert, kann damit einen `RangeError` auslösen (Denial of Service).

**Bewertung für COD4X CONTROL:**
- Das Paket läuft nur beim Bauen. `roarr` (Logger von `global-agent`) formatiert damit Log-Meldungen, deren Format-Strings fest im Code stehen und nicht von außen kommen.
- Die ausgelieferte App und das CONTROL-Backend enthalten das Paket nicht.
- `sprintf-js` 1.1.3 ist die neueste Version; eine gepatchte gibt es nicht. Auch `@electron/get` 4.x führt `global-agent` weiterhin als optionale Abhängigkeit, ein Wechsel würde die Kette also nicht entfernen.

## Warum nicht `npm audit fix`

Der Probelauf (`npm audit fix --dry-run`) würde nur ältere bzw. Alpha-Komponenten des Bauwerkzeugs einspielen, u. a. `app-builder-bin 5.0.0-alpha.12`, und `@electron/rebuild` von 4.2.0 auf 4.0.1 zurückstufen. Das behebt keine der beiden Lücken nachweislich und gefährdet den Installer-Build. Auch das neueste `electron-builder` der 26er-Reihe (26.17.0, Tag `v26`) hängt weiterhin an `@electron/get ^3`.

## Empfehlung und Wiedervorlage

- Keine Änderung an den Abhängigkeiten. Beide Warnungen können auf GitHub als „Risk is tolerable / vulnerable code is not actually used“ geschlossen werden, mit Verweis auf dieses Dokument. Das muss der Repository-Owner tun.
- **Erneut prüfen, sobald** eine der beiden Advisories eine gepatchte Version nennt, `electron-builder` auf `@electron/get` ≥ 4 ohne `global-agent` umstellt oder das Bauen in einer Umgebung mit geteiltem HTTP-Cache bzw. Proxy stattfindet.
- In Roadmap-Block 20 (Security Audit) wird diese Bewertung erneut aufgegriffen; Block 23 (Release) setzt einen frischen `npm audit` voraus.
