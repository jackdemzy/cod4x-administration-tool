# COD4X CONTROL 4.18.15

## Monitoring (Roadmap Block 24a)

Modelled on cod4-monitor 1.0.0 (https://github.com/FloMtz2312/cod4-monitor, AGPL-3.0). The getstatus parser and the crash diagnosis are adapted from its Go source (commit 71aaf32) and carry the attribution header; the tool itself has been AGPL-3.0-or-later since PR #13.

### Implementation

- `buildStatusPacket` / `parseStatusResponse` / `RconClient.queryStatus()`: the unauthenticated CoD4x `getstatus <challenge>` query on loopback. Returns hostname, map, gametype, max clients and players (name, score, ping; colour codes stripped). No RCON password is read or sent.
- `lib/monitor-diagnose.mjs`: probable cause of an outage from the last 120 lines of `qconsole.log` (an `ERROR:` line wins, otherwise the last fatal match; a shutdown line alone counts as clean), with a German/English hint for known causes (asset limits, Hunk_Alloc, G_Spawn, segfault …).
- `lib/monitor-store.mjs`: one JSON line per instance and poll in `samples-YYYY-MM-DD.jsonl`, outages in `events-YYYY-MM-DD.jsonl` (directory 0700, files 0600, 30 days retention, torn lines after a crash are skipped). 24 h stay in memory; history in buckets of 1 min (24h), 15 min (7d) and 1 h (30d).
- `lib/monitor-collector.mjs`: polls every 15 s. A running server that does not answer is declared down only after 45 s (a map change does not answer for 20-40 s); a crash (`FAILED`) is reported at once, a planned stop once and without follow-ups; a server that was never up produces no outage. The recovery event carries the downtime.
- `lib/monitor-host.mjs`: host CPU share from deltas (os.loadavg is always 0 on Windows), RAM and free space of the volume of each instance home.
- API (all `monitor.read`, no audit entry per poll, `Cache-Control: no-store`): `GET /api/monitor/overview`, `GET /api/monitor/instances/:id/history?range=24h|7d|30d`, `GET /api/monitor/instances/:id/events?range=`. Outage console lines only with `diagnostics.read`. Audit events `monitor.server.down` / `monitor.server.up`.
- RBAC: new role `monitor` with `monitor.read` only (for a later phone/browser login); operator, auditor and viewer get `monitor.read`.
- UI: tab "Monitoring" with server cards (online / crashed / no answer / starting or map change / stopped, map, players, latency, uptime), host summary, history chart, availability and outage list with cause, hint and console.
- `COD4X_MONITOR=off` disables the collector.

### Not in this block

Remote access from browser and phone (separate gateway, PWA, cookie session, login rate limit, TOTP, AGPL §13 source link) is 24b; alerts and Caddy 24c; actions with step-up 24d.

### Tests

`test/monitor.test.mjs`, `test/monitor-dashboard.test.mjs`, `test/monitor-http.test.mjs` and the getstatus cases in `test/rcon-protocol.test.mjs` / `test/rcon-client.test.mjs` (fake CoD4x UDP server). Gate `scripts/verify-4.18.15-monitor-gate.mjs`.
