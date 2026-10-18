# COD4X CONTROL 4.18.6

## Master Server / Token (Roadmap-Block 8)

### Quellenprüfung (offizielles CoD4x_Server-Repository, Branch `master`)

- `src/sv_main.c` `SV_InitCvarsOnce`: Token-CVAR ist `sv_authtoken` („Token to register on masterserver. You can get it from http://cod4master.cod4x.ovh“); Host-Migration verlangt genau 32 Zeichen.
- `SV_MasterHeartbeat`: Heartbeats nur bei `dedicated 2`, alle 180 s.
- `SV_SendHeartbeatThread`: Heartbeats werden **nicht** von IPv4-Adressen `127.x` (bzw. IPv6 ab `fe..`) gesendet.
- `SV_HeartBeatMessageLoop` / `SV_SendReceiveHeartbeatTCP` / `SV_CreateAndSendMasterheartbeatMessage`: Meldungen für Token angefordert, Token-Datenbank nicht geladen, `sv_authtoken is invalid!`, Fehlercode, Adresse gesperrt, Timeout, ungültige Antwort, fehlender Token. „Server is registered on the masterserver“ und „Sending master heartbeat“ werden nur mit `developer` ausgegeben (`Com_DPrintf`).

### Umsetzung

- Start (`lib/server-instance-manager.mjs`): RCON-Passwort und Master-Token werden in einem gemeinsamen kurzlebigen `withRuntimeCredentials`-Scope übergeben; der Token als `+set sv_authtoken` vor `+exec server.cfg`, fail-closed geprüft auf `[A-Za-z0-9]{32}` (`MASTER_TOKEN_UNSUPPORTED`). Kein Token oder gesperrter Tresor → Start ohne Token, nie ein blockierter Serverstart.
- `lib/instance-master-service.mjs`: Klassifizierung der Konsolenmeldungen (letzte relevante Zeile gewinnt, nur feste Codes), Zustandsableitung pro Lauf (`NOT_CONFIGURED`, `TOKEN_CONFIGURED`, `REGISTERING`, `REGISTERED`, `REGISTRATION_FAILED`, zusätzlich `UNKNOWN` bei gesperrtem Tresor bzw. unbelegter Übergabe) mit Begründungscodes, u. a. `LOOPBACK_BINDING`, `MASTER_TOKEN_INVALID`, `VAULT_LOCKED_AT_START`, `RUN_TRANSFER_UNKNOWN`. `verified` bleibt `false` bis Block 9.
- `lib/instance-console-log.mjs`: optionaler interner `inspect`-Hook auf dem unredigierten Log-Ende; nach außen gelangt nur dessen Ergebnis. Die normale Konsolenansicht blendet Token-Zeilen weiterhin aus.
- API: `GET /api/instances/:id/master` (Berechtigung `diagnostics.read`).
- Audit: `master.token.configured` / `master.token.removed` (nur bei tatsächlicher Tresoränderung), `master.registration.started` (Lauf mit Token), `master.registration.failed` / `master.registration.succeeded` einmal je Lauf und Ergebnis. Nie der Token.
- UI: `lib/instance-master-status.jsx` (Statusprüfung, Erklärung je Begründungscode, Token-/Übergabe-/Netzwerk-/Verifikationsstatus, kein Tokenfeld); Hinweistext im Credential-Editor angepasst.

### Tests und Gate

- Neu: `test/instance-master-service.test.mjs` (Klassifizierung, Zustandsmatrix, Launch mit/ohne Token, gesperrter Tresor, Fehlerdiagnose bei laufendem Server, Audit-Deduplizierung, Mandantentrennung, keine Token-Lecks), `test/instance-master-status.test.mjs` (SSR-Render). HTTP-Integrationstest prüft Route und `master.token.configured`.
- Gate `scripts/verify-4.18.6-master-gate.mjs`: **Lokaler Serverbetrieb unabhängig von Master-Registration PASS** (11/11) gegen das UDP-Testdouble.
- `scripts/preflight-4.18.6.mjs` mit Config-, RCON- und Master-Gate.

### Grenzen / offen

- **Keine echte Listung möglich:** Verwaltete Instanzen binden an `127.0.0.1`/`::1`; CoD4x sendet von dort keinen Heartbeat. Status ist dann `TOKEN_CONFIGURED` / `LOOPBACK_BINDING`. Eine öffentliche Bindung ist eine bewusste Sicherheitsentscheidung und gehört zu Block 9.
- `HEARTBEAT_OK` / `HEARTBEAT_LOST` und `REGISTERED` sind ohne `developer`-Ausgabe (die CONTROL wegen Secret-Ausgaben nicht aktiviert) nur extern belegbar → Block 9 (Master List Verification).
- Registrierung gegen `cod4master.cod4x.ovh` und ein echter `cod4x18_dedrun` wurden nicht getestet; Linux-/WSL-Preflight nicht ausgeführt.
- Wie beim RCON-Passwort ist der Token als Startargument für lokale Prozessinspektion sichtbar (gleiche Restrisiken wie in 4.18.5 dokumentiert).
- Kein Release, kein Installer, kein Live-Deployment.
