# COD4X CONTROL 4.18.5

## RCON (Roadmap-Block 7)

### Quellenprüfung (offizielles CoD4x_Server-Repository)

Geprüft gegen `github.com/callofduty4x/CoD4x_Server`, Branch `master` (letzter Commit an `src/sv_main.c`: `e58cf8e`, 2023-09-19). Nichts davon ist erfunden; die Belegstellen:

- `src/sv_main.c` `SV_ConnectionlessPacket` / `SVC_RemoteCommand`: Anfrage ist ein Out-of-Band-Paket `0xFFFFFFFF` + `rcon <passwort> <befehl>`. Das Passwort wird per `strcmp` mit dem CVAR `rcon_password` verglichen. Falsches Passwort → Antwort `Bad rcon`, aber höchstens eine Ablehnung pro 100 ms (globaler Rate-Limit-Bucket), sonst keine Antwort. Ist das Server-Passwort kürzer als 8 Zeichen → `No rconpassword set on server or password is shorter than 8 characters.`
- `SV_FlushRedirect` / `src/common_io.c` `Com_PrintMessage`: Ausgaben werden in einen 1024-Byte-Puffer umgeleitet und als mehrere `0xFFFFFFFF print\n<text>`-Pakete ohne Endmarkierung gesendet.
- `SVC_Info`: `getinfo <challenge>` → `infoResponse` mit zurückgegebener Challenge (pro Adresse rate-limitiert); dient als unauthentifizierter Health-Check.
- `src/qcommon_parsecmdline.c` `Com_ParseCommandLine` / `Com_StartupVariable`: `+set <cvar> <wert>` auf der Kommandozeile ist der offizielle Weg, `rcon_password` beim Start zu setzen; die Kommandozeile wird an jedem `+` aufgetrennt.
- `src/sv_cmds.c` `SV_AddOperatorCommands`: Befehle `status`, `serverinfo`, `systeminfo`, `map`, `map_rotate` existieren.
- `src/sys_main.c` `Sys_Restart`: gibt bei einem Core-Neustart die vollständige Kommandozeile (inkl. `+set rcon_password …`) in die Konsole aus.

### Umsetzung

- `lib/rcon-protocol.mjs`: Paketformat, Antwort-Parser, Klassifizierung (`RCON_AUTH_FAILED`, `RCON_PASSWORD_NOT_ACTIVE`) und Befehls-Allowlist: `status`, `serverinfo`, `systeminfo`, `map_rotate`, `map <mapname>` (`[A-Za-z0-9_]{1,64}`). Alles andere (u. a. `rcon_password`, `exec`, `quit`, `killserver`, `kick`/Bans, `devmap`, CVAR-Schreibzugriffe, `;`, Zeilenumbrüche) wird vor jedem Tresor- oder Netzwerkzugriff mit `RCON_COMMAND_BLOCKED` abgelehnt.
- `lib/rcon-client.mjs`: ein kurzlebiger UDP-Socket je Anfrage, ausschließlich `127.0.0.1`, Ports 1024–65535. Pakete fremder Absenderadressen/-ports werden ignoriert. Mehrteilige Antworten werden bis zu einer Ruhepause gesammelt (max. 64 KiB). Das Paket mit Passwort wird nach dem Senden überschrieben.
- `lib/instance-rcon-service.mjs`: pro Instanz Connect (getinfo-Health), Authenticate (`serverinfo`), Command, Response und Health-Status (`CONNECTED`, `DISCONNECTED`, `RECONNECTING`, `AUTH_FAILED`, `UNREACHABLE`, `NOT_PROVISIONED`, `OFFLINE`). Reconnect mit Backoff (0/250/750 ms) nur bei transienten Fehlern; Authentifizierungsfehler werden nicht wiederholt. Ein neuer Lauf (Restart, Backend-Neustart) setzt den Verbindungsnachweis zurück. Das Passwort wird nur innerhalb von `InstanceCredentialService.withRuntimeCredentials` gelesen; Anfragen werden serialisiert. Befehlshistorie (100 Einträge, Antworten begrenzt und zeilenweise redigiert) nur im Speicher.
- Passwortübergabe an den Core (`lib/server-instance-manager.mjs` `launch`): Ist RCON im Tresor konfiguriert, wird der Core innerhalb des Credential-Scopes mit `+set rcon_password <wert>` vor `+exec server.cfg` gestartet. Der Tresorstatus wird vor einem Restart-Stopp geprüft. Gesperrter Tresor / kein Eintrag → Start ohne RCON (`VAULT_LOCKED` / `NOT_CONFIGURED`), der Server läuft unabhängig von RCON. Werte mit `+`, `"`, `;` oder `\` werden fail-closed mit `RCON_PASSWORD_UNSUPPORTED` vor dem Spawn blockiert; neue RCON-Werte mit `+` lehnt der Credential-Service schon beim Speichern ab (bestehende Tresordokumente bleiben lesbar).
- `lib/runtime-secret-redaction.mjs` + `lib/runtime-manager.mjs`: Werte von `rcon_password`, `g_password`, `sv_privatepassword`, `sv_authtoken` werden aus Runtime-History (`runtime.started`-Argumente), Prozessinfo bei fehlgeschlagener PID-Verifikation, persistiertem Runtime-State und erfasster stdout/stderr-Ausgabe (auch die `Restart commandline`-Zeile, auch über Chunk-Grenzen) entfernt. Die tatsächlichen Spawn-Argumente bleiben unverändert; `shell:false`, PID-Verifikation und Verified-Core-Gate sind unverändert.
- API (`installer-server.mjs`, Berechtigung `server.manage`): `GET /api/instances/:id/rcon`, `POST /api/instances/:id/rcon/connect`, `POST /api/instances/:id/rcon/command` (Body exakt `{ command }`). Fehler nur als feste Codes.
- Audit: `rcon.login`, `rcon.command` (Instanz, Akteur, normalisierter Befehl, Latenz, Paketanzahl, Run-ID) und `rcon.failure` (Phase, Code; bei blockierten Eingaben nur der Befehlsname, nie Argumente). Nie das Passwort.
- UI `lib/instance-rcon-console.jsx` in der Instanzansicht: Live-Ausgabe aus `qconsole.log` und Runtime-stdout, RCON-Eingabe mit Enter, Befehlshistorie (↑/↓), Auto-Scroll, Filter nach Text und Quelle, Kopieren, Leeren, Zeitstempel, Warn-/Fehlerfärbung, Verbindungs- und Übergabestatus, Reconnect-Button (ein automatischer Connect je Lauf) und Log-Export als Textdatei. Kein Passwortfeld.
- Credential-Editor-Hinweis angepasst: RCON wird beim nächsten Start übergeben; Master-Token und Join-Passwort sind weiterhin nicht an die Runtime angebunden.

### Tests und Gate

- Neu: `test/rcon-protocol.test.mjs`, `test/rcon-client.test.mjs` (echtes Loopback-UDP), `test/instance-rcon-service.test.mjs` (Launch → Tresor → Spawn-Argumente → UDP-Double → RCON, Redaktion, Allowlist, Reconnect, Mandantentrennung), `test/instance-rcon-console.test.mjs` (SSR-Render, Export).
- UDP-Testdouble `test/support/fake-cod4x-udp.mjs`, nachgebildet nach `sv_main.c` (1024-Byte-Redirect, 100-ms-Deny-Limit, `getinfo`). Gemeinsame Fixture `test/support/rcon-instance-fixture.mjs`.
- Gate `scripts/verify-4.18.5-rcon-gate.mjs`: **Live Output + RCON Command + Response + Reconnect + Audit PASS** gegen das UDP-Testdouble.
- `scripts/preflight-4.18.5.mjs`, `scripts/verify-4.18.5-runtime.mjs`, `scripts/verify-4.18.5-version.mjs`; der Block-6-Config-Gate läuft weiterhin mit.
- `test/windows-runtime-process-guard.test.mjs`: Der VM-Harness stellt die Redaktionsfunktionen bereit, weil der Runtime-Manager sie jetzt importiert.

### Grenzen / offen

- **Nicht nativ getestet:** RCON gegen einen echten `cod4x18_dedrun`-Core (Windows und Linux) ist offen. Das Gate beweist Protokoll- und Integrationsverhalten nur gegen das Testdouble.
- Linux-/WSL-Preflight und native Lifecycle-Gates wurden für diesen Block nicht ausgeführt.
- Bekannte Restrisiken: Als Startargument ist das Passwort für lokale Prozessinspektion sichtbar (Windows `Win32_Process.CommandLine` für Prozesse desselben Benutzers/Administratoren, Linux `/proc/<pid>/cmdline` ohne `hidepid`). JavaScript-Strings des Spawn-Arguments lassen sich nicht überschreiben. `qconsole.log` selbst kann nach einem Core-internen Neustart die Kommandozeile enthalten; CONTROL zeigt solche Zeilen nur redigiert an. Mit `developer 1` protokolliert der Core OOB-Pakete einschließlich Passwort (`Com_DPrintf` in `SV_ConnectionlessPacket`).
- Der bestehende Legacy-Endpunkt `POST /api/rcon/execute` (frei wählbarer Host, Passwort im Request) wurde nicht verändert.
- Kein Release, kein Installer, kein Live-Deployment.
