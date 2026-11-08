# COD4X CONTROL 4.18.24

## Remote RCON, B3 database, monitoring and phone actions (Roadmap Block 18b)

Design: `docs/superpowers/specs/2026-11-08-remote-rcon-b3-design.md`, plan: `docs/superpowers/plans/2026-11-08-remote-rcon-b3.md`. Block 18 (4.18.23) managed Linux servers over SSH but blocked RCON, the console, B3, monitoring and the phone gateway for them. This block closes those gaps. Model: cod4-monitor 1.0.0 (https://github.com/FloMtz2312/cod4-monitor, Florian Martinez, AGPL-3.0), which administers remote servers through RCON and through B3's own database instead of running B3.

### Decisions

- **RCON over SSH.** UDP does not travel through SSH. A fixed command (`rconExchangeCommand`, python3 only) runs on the server, sends one packet to `127.0.0.1:<port>` there and returns the reply datagrams (150 ms silence, at most 1.5 s and 64 KiB). The packet carries the password, so it is written to the command's stdin (`exec(command, { stdin })`) and wiped afterwards; it never appears in a command line. No python3 on the server: `REMOTE_RCON_TOOL_MISSING` (no bash fallback for a secret).
- **RCON password at start.** The remote core gets `+exec rcon-<runId>.cfg`, a private file (0600) written over SFTP. It is deleted once the core printed `execing rcon-<runId>.cfg` (at most 15 s), and every start, stop, restart, recover and status that finds the core gone sweeps `main/rcon-*.cfg`. The password is never a process argument.
- **B3 through its database.** CONTROL does not start B3 on a remote server. It reads and writes B3's MySQL/MariaDB database with the existing helper: players, admins, groups, penalties, ban (optionally with an immediate kick over remote RCON), unban, lift a warning, set a group. No schema migration (`REMOTE_B3_MIGRATE_UNSUPPORTED`), no SQLite for remote. The helper has no TLS: the remote form warns that the password crosses the network in clear text unless a VPN or Tailscale is used.
- **Ids.** Remote and local ids share one pattern; where both meet (vault, monitoring, phone gateway) a remote id is `rmt_<id>`. Each remote instance has a private data directory on this PC (`remote-data/<id>`) for what the shared services keep per instance.
- **Monitoring.** Remote servers appear in the dashboard. Their runtime is the saved state (no connection); liveness comes from a `getstatus` probe over one pooled SSH session per host (idle close 60 s). A remote crash is therefore declared after the 45 s offline grace, unless a status call through the UI reconciled the state first. The crash cause reads the last 64 KiB of the remote console (redacted).
- **Phone gateway.** Players, say, kick and restart work for `rmt_` ids behind the existing step-up confirmation; the gateway route list is unchanged.

### New routes (all in the permission map)

- `GET /api/remote-instances/:id/rcon` and `POST …/rcon/connect|command|kick` (`server.manage`), `GET …/rcon/online` (`diagnostics.read`) — same shapes and permissions as the local routes.
- `GET /api/remote-instances/:id/credentials`, `POST …/credentials/:kind[/remove]` (`config.manage`, kinds `rcon` and `b3db` only; `rcon` only while the server is stopped; `b3db` resets the database check).
- `…/b3/database` (GET/POST, `/remove`, `/test`, `config.manage`), `…/b3/database/migrate` (refused), `…/b3/admin/*` (reads `diagnostics.read`, writes `server.manage`).

### Plan deviations (rulings)

- The password and RCON routes mirror the local API exactly: no `POST /rcon/say` (say stays a phone action), `GET /rcon` needs `server.manage`.
- Remote credential routes were added; the plan had no way to enter the RCON and B3 database passwords of a remote server.
- The password file is deleted after the core reports it read it, not right after the identity check (the check can pass before the core reads its `+exec` files).
- The remote admin service has no command list (that list is read from the local B3 config, not the server's).
- The phone actions moved into `lib/gateway-actions.mjs`; the 4.18.19, 4.18.15 and 4.18.23 gates now look for the moved code and check the same properties.
- No real-backend test of a remote RCON command or kick: the test SSH server has no SFTP, so nothing can be installed. Routes are tested on express, services with the real RCON service, vault, SSH client and a loopback server against the fake core.

### Checks

- Tests: new `remote-session-pool`, `remote-rcon-client`, `remote-subjects`, `remote-rcon-routes`, `remote-rcon-service`, `remote-b3-routes`, `remote-b3-service`, `remote-monitor`, `gateway-actions`; extended `ssh-transport`, `remote-commands`, `remote-instance-runtime`, `remote-hosts`, `remote-linux-http`, `monitor` and the console, player, B3 and credential UI tests. Found on the way: ssh2 generates an unparsable test key about 3 times in 1000 (fixed before this block in the test helper).
- Gate: `scripts/verify-4.18.24-remote-rcon-gate.mjs` (11 source checks, then the remote RCON/B3 test files).
- Native: `scripts/verify-4.18.23-remote-linux-native.mjs` now also checks RCON over SSH (serverinfo hostname, wrong password refused), that the password file is gone and that the password is not in the core's command line. **Not run yet.**
- RESULTS_PLACEHOLDER
