# COD4X CONTROL 4.18.7

## Master List Verification (Roadmap-Block 9)

### Quellen- und Datenprüfung

- `src/sys_net.c`: CoD4x-Standard `net_ip "0.0.0.0"`, `net_ip6 "::"`; `src/sv_main.c` `SV_SendHeartbeatThread` sendet keine Heartbeats von `127.x`. Ohne öffentliche Bindung ist keine Listung möglich (siehe 4.18.6).
- `globalconfig.cfg` (vom Core beim Start geladen): `sv_masterservers "*cod4master.cod4x.ovh;cod4master.ax-servers.hu;"`; `src/sys_cod4defs.h`: `PORT_MASTER 20810`.
- Die CoD4x-Master beantworten die Q3-Abfrage `getservers` per UDP nicht (live geprüft mit Protokoll 6/21 und weiteren Varianten; der Activision-Master antwortet dagegen). Offiziell dokumentierter Prüfweg ist die Webseite `cod4master.cod4x.ovh` („search your server name“); diese lädt ihre Daten aus `https://cod4master.cod4x.ovh/serverstatus.json` (`assets/js/cod4x.js`). Felder: `hn`, `map`, `maxcl`, `tokhash`, `addr` (`[ip]:port$alive|$dead`, IPv4 als `::ffff:`). Der Parser wurde einmal gegen die echte Liste geprüft (448 Server).
- `tokhash` wird von mehreren Servern geteilt; dass es SHA-256 von `sv_authtoken` ist, ist **nicht belegt** und dient nur als Zusatzindiz (`tokenHashMatch`), nie als Entscheidungsgrundlage.

### Umsetzung

- Netzwerkbindung pro Instanz (`lib/instance-network.mjs`, `lib/server-instance-store.mjs`): Standard `LOOPBACK` (127.0.0.1 / ::1) für neue, bestehende und geklonte Instanzen. `PUBLIC` (0.0.0.0 / ::) nur über `POST /api/instances/:id/network` mit `confirm: "PUBLIC_EXPOSURE"` (sonst HTTP 428), nur bei gestopptem Server, wird nie geklont. Optionale erwartete öffentliche Adresse (keine Loopback-/Link-Local-/Unspecified-Werte). `server.cfg` darf `net_ip` nur auf die Instanzbindung setzen; eine gepinnte alte Bindung blockiert den Wechsel (`INSTANCE_NETWORK_CONFIG_PINNED`). Audit `network.exposure.changed` (öffentlich als `warn`).
- `lib/master-list.mjs`: Abruf ausschließlich der festen URL (kein Redirect, 10 s Timeout, max. 4 MiB, max. 10 000 Einträge), Parser, Abgleich über konfigurierte Adresse + Port oder über Serveridentität (Hostname ohne Farbcodes + maxclients aus `getinfo` des laufenden Cores) auf dem Instanzport. Ergebnisse: `MASTER_LIST_ALIVE`, `MASTER_LIST_DEAD`, `MASTER_LIST_NOT_LISTED`, `MASTER_LIST_PORT_MISMATCH`, `MASTER_LIST_AMBIGUOUS`, `MASTER_LIST_UNREACHABLE`, `MASTER_LIST_INVALID`. Fremde Einträge verlassen den Dienst nie.
- `lib/instance-master-service.mjs`: `verify()` nur auf ausdrückliche Anforderung (`POST /api/instances/:id/master/verify`, `server.manage`), kein Polling; ohne laufenden Server (`SERVER_NOT_RUNNING`) oder bei Loopback (`LOOPBACK_BINDING`) keine ausgehende Anfrage. Zustände `HEARTBEAT_OK` (gelistet, alive), `HEARTBEAT_LOST` (dead oder in diesem Lauf verschwunden, `MASTER_LIST_MISSING`); `verified` nur bei tatsächlicher Listung. „Last seen“ je Lauf; ein neuer Lauf übernimmt keine Listungsnachweise. Zusammenfassung Registration / Heartbeat / Listed / Last seen. Audit `master.list.verified`, `master.heartbeat.detected`, `master.heartbeat.lost`.
- UI (`lib/instance-master-status.jsx`): Bindungs-Editor mit Warnung (RCON teilt den UDP-Port), Pflicht-Bestätigung und optionaler Adresse; Button „Master-Liste prüfen“; Tabelle Registration / Heartbeat / Listed / Last seen mit Eintrag und Diagnose.

### Tests und Gate

- Neu: `test/master-list-verification.test.mjs` (Parser, Abgleichsmatrix, feste URL und Fehlercodes, Netzwerkmodell, Bindung pro Instanz inkl. Klon/Laufzeit/Pinning, Prüfung im laufenden Betrieb mit Heartbeat/Last seen/Audit). UI- und HTTP-Integrationstests erweitert (428 ohne Bestätigung, Audit).
- Gate `scripts/verify-4.18.7-listing-gate.mjs`: **Registration + Listing Verification PASS** (12/12) mit allen Roadmap-Fehlerfällen (Token gültig/nicht sichtbar, Master nicht erreichbar, falscher Port, NAT/Firewall, Server offline, Heartbeat fehlt) gegen das UDP-Testdouble und eine synthetische Liste.

### Grenzen / offen

- Kein echter `cod4x18_dedrun` wurde öffentlich gestartet, registriert oder gelistet. Das Gate belegt Logik und Integration, nicht die reale Listung.
- „Last seen“ liegt nur im Speicher und beginnt nach einem Backend-Neustart neu.
- Identitätsabgleich ohne konfigurierte Adresse ist eine Heuristik (Hostname + maxclients + Port); bei Mehrdeutigkeit wird nichts behauptet.
- Öffentliche Bindung macht auch RCON auf demselben UDP-Port erreichbar; Firewall/Port-Weiterleitung liegen beim Betreiber. Linux-/WSL-Preflight nicht ausgeführt. Kein Release, kein Installer, kein Live-Deployment.
