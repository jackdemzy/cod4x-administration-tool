# COD4X CONTROL 4.18.8

## Plugin Manager (Roadmap-Block 10)

### Quellenprüfung (offizielles CoD4x_Server-Repository, Branch `master`)

- `src/plugin_handler.c` / `src/plugin_internal.c`: Befehle `loadPlugin`, `unloadPlugin`, `plugins`, `pluginInfo`. `loadPlugin <name>` liest `plugins/<name>` + `DLL_EXT` per `FS_SV_ReadFile` (fs_homepath zuerst), prüft die Datei (`PHandler_VerifyPlugin`), kopiert sie nach `<fs_homepath>/plugin.<name>.tmp` und lädt diese Kopie. `DLL_EXT` ist `.dll` (Windows) bzw. `.so` (Linux) (`q_platform.h`). `MAX_PLUGINS 16`; Name max. 64 Byte inkl. `plugins/%s.dynlib`.
- Version/Beschreibung gibt es nur zur Laufzeit (`OnInfoRequest`, ausgegeben von `pluginInfo` als „Plugin version: x.y“). Library-Plugins lassen sich nicht entladen.
- Konsolenmeldungen: „Plugin %s loaded successfully“, „No such file found: plugins/…“, „… is not a plugin file or is corrupt …“, „… plugin.<name>.tmp checksum missmatch“ (securemode), „Failed to load the plugin …“.
- `plugins/cod4x_b3hide`: Ziel `b3hide.dll` / `b3hide.so`; Dvars `b3Prefix`, `b3Hide`, `b3HideLvl` (0–100). Offizielle Hashes werden nicht veröffentlicht.

### Umsetzung

- `lib/plugin-manager.mjs`: Plugin-Modell (Name, Plattform, SHA-256, aktiviert, Freigabezeitpunkt, Quelle, Konfiguration), Katalog mit `b3hide` (Quelle, Abhängigkeit B3 optional → Blöcke 11–16, Dvar-Schema). Discovery von `<home>/plugins` (nur reguläre Dateien, keine Symlinks/Hardlinks, 100 B–32 MiB, Namensregel `[A-Za-z0-9_]{1,40}`, fremde Plattform markiert). Zustände `NOT_APPROVED`, `DISABLED`, `ENABLED`, `INTEGRITY_MISMATCH`, `MISSING`, `WRONG_PLATFORM`, `INVALID`.
- Vertrauen: Ein Plugin gilt erst nach Installation aus lokaler Datei (Kopie ohne Überschreiben, exklusiver Link, Hash-Nachprüfung) oder nach Freigabe mit dem bestätigten Hash als vertrauenswürdig; neu freigegebene/installierte Plugins sind deaktiviert. Freigaben sind an die Instanz gebunden und werden nicht geklont.
- Start (`ServerInstanceManager.launch`): Prüfung aller aktivierten Plugins vor einem Restart-Stopp; Hash-Abweichung (`PLUGIN_INTEGRITY_FAILED`) oder fehlende Datei (`PLUGIN_MISSING`) blockiert den Start vor dem Spawn. Übergabe als `+loadPlugin <name>` plus validierte Plugin-Dvars vor `+exec server.cfg`. Fremd-Plattform-Dateien gleichen Namens blockieren weder Start noch Installation.
- Aktivieren, Deaktivieren, Konfigurieren, Installieren, Entfernen nur bei gestopptem Server; Entfernen archiviert nach `plugins/.removed/`, nichts wird gelöscht.
- Laufzeit: Ladezustand je Plugin aus den Konsolenmeldungen; Version per RCON `pluginInfo <name>`. Die RCON-Allowlist wurde dafür nur um die lesenden Befehle `plugins` und `pluginInfo <name>` erweitert; `loadPlugin`/`unloadPlugin` bleiben blockiert.
- API: `GET /api/instances/:id/plugins`, `POST …/plugins/install|approve|versions`, `POST …/plugins/:name/enable|disable|config|remove`. Audit `plugin.installed`, `plugin.approved`, `plugin.enabled`, `plugin.disabled`, `plugin.configured`, `plugin.removed` (Name, SHA-256).
- UI `lib/instance-plugin-manager.jsx`: Tabelle mit Status, Laufzeit-Ladezustand, Version, SHA-256 (inkl. freigegebenem Hash bei Abweichung), Abhängigkeiten, Aktionen, Dvar-Editor für Katalog-Plugins und Installation aus lokalem Pfad.

### Tests und Gate

- Neu: `test/plugin-manager.test.mjs`, `test/instance-plugin-manager.test.mjs`; RCON-Allowlist-, HTTP-Integrations- und Testdouble-Erweiterung (`pluginInfo`, Lademeldungen nach Quellformat).
- Gate `scripts/verify-4.18.8-plugin-gate.mjs`: **Plugin Discovery + Enable/Disable + Integrity PASS** (14/14) mit inerten Testdateien. Das Gate deckte zwei echte Fehler auf (eine gleichnamige `.so` blockierte Start bzw. Installation einer `.dll`); beide behoben und mit Regressionstest abgesichert.
- Preflight `node scripts/preflight-4.18.8.mjs`: Exit 0, 182 Tests (176 PASS / 0 FAIL / 6 SKIP) plus alle Gates.

### Grenzen / offen

- Kein echtes Plugin wurde von einem nativen `cod4x18_dedrun` geladen. Ob `+loadPlugin` auf der Kommandozeile in jeder Core-Version identisch zu `loadPlugin` in `server.cfg` wirkt, ist nativ zu bestätigen.
- Zwischen Hash-Prüfung und Lesen durch den Core bleibt ein kleines Zeitfenster (der Core liest die Datei selbst); Schreibrechte auf `plugins/` sollten nur beim Betreiber liegen.
- Die Version ist nur bei laufendem Server mit RCON lesbar. Keine Downloads; nur lokale Dateien. Linux-/WSL-Preflight nicht ausgeführt. Kein Release, kein Installer, kein Live-Deployment.
