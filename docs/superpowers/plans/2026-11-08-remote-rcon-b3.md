# Remote RCON, B3 database, monitoring and phone actions for SSH servers (Block 18b, 4.18.24) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Context

Block 18 (4.18.23, merged in #32/#34/#35) manages CoD4x servers on Linux machines over SSH, but blocks RCON, console, B3, monitoring and the phone gateway for them (`REMOTE_RCON_UNSUPPORTED`, `REMOTE_B3_UNSUPPORTED`). This block closes that gap. Model: cod4-monitor 1.0.0 (FloMtz2312, AGPL-3.0), which manages remote servers by RCON and by B3's database instead of running B3 itself.

**Goal:** Remote servers get the RCON console, online players with kick/say, B3 administration through B3's own database, a place in the monitoring dashboard, and phone actions (players, say, kick, restart).

**Architecture:** RCON runs on the server through one fixed SSH command (python3 sends the packet to `127.0.0.1:port` and prints the reply); the packet, which carries the password, travels over stdin, never in a command line. The existing transport-independent pieces (`rcon-protocol`, `InstanceRconService`, `InstanceB3DatabaseService`, `InstanceB3AdminService`, `MonitorCollector`) are reused as second instances wired to remote adapters. B3 itself runs on the server, set up by the operator; CONTROL only talks to its MySQL/MariaDB database over the network with the existing helper.

**Tech Stack:** Node ≥ 22.12 ESM, `ssh2` (existing), `node:test`, React panels; Python 3 on the remote server for RCON; the local B3 interpreter and driver for the database helper (as today).

**Spec:** `docs/superpowers/specs/2026-11-08-remote-rcon-b3-design.md` (Task 0 writes it from the decisions below).

## Decisions (Rafiki, 2026-11-08)

1. RCON path: over SSH, one fixed command on the server, packet over stdin. No direct UDP from CONTROL, the server may stay on loopback.
2. RCON password reaches the remote core through a private file (mode 0600) loaded with `+exec`, deleted once the start is confirmed. Never an argument.
3. B3: CONTROL does not start B3 on remote servers. It reads and writes B3's database (players, admins, groups, penalties, ban/kick/unban, lift warning, set group), like cod4-monitor.
4. B3 database access: directly over the network to MySQL/MariaDB (host, port, user, password), with the existing database helper. No SQLite for remote (the file is on another machine).
5. Monitoring shows remote servers; the phone gateway gets full actions for them (players, say, kick, restart) behind the existing step-up confirmation.

## Global Constraints

- Version 4.18.24; every `*-4.18.23-*` and older gate stays in the preflight chain.
- The RCON password never appears in a remote command line, in `/proc/<pid>/cmdline` on the server, in audit, logs, state files or API results.
- All remote commands are built in `lib/remote-commands.mjs` (the 4.18.23 gate enforces this and keeps passing).
- Remote ids and local ids share one pattern (`^[a-z][a-z0-9-]{0,47}$`); wherever both meet (vault, monitoring, phone gateway) a remote id is written `rmt_<id>`. A local id can never contain `_`.
- RCON command allowlist, kick reason and say text rules are the existing ones (`normalizeRconCommand`, `lib/kick-reason.mjs`); nothing new is allowed remotely that is not allowed locally.
- `b3/start|stop|restart|logs|config|plugins|dependencies` stay `REMOTE_B3_UNSUPPORTED`; `b3/database/migrate` for a remote server answers `REMOTE_B3_MIGRATE_UNSUPPORTED` (B3 owns the schema there).
- The B3 database helper has no TLS today: the panel states that the password crosses the network in clear text unless the operator uses a VPN/Tailscale or a database on loopback reached through it. No silent fallback.
- Permissions: same as the local routes they mirror (RCON read `diagnostics.read`, commands/kick/say `server.manage`, B3 database `config.manage`, B3 admin reads `diagnostics.read`, B3 admin writes `server.manage`).

## Review Focus

1. python3 missing on the server: RCON answers `REMOTE_RCON_TOOL_MISSING` (no bash fallback for packets that carry the password), the panel says what to install. → Task 2 test.
2. A crash or lost connection between writing the password file and confirming the start leaves `main/rcon-<runId>.cfg` behind: the next start, stop, recover and status sweep remove every `rcon-*.cfg` in `main/`. → Task 5 test.
3. Monitoring polls every 15 s: without reuse that is one SSH login per remote server per poll. A session pool keeps one connection per host open while it is used (idle close 60 s). → Task 1 and Task 8 tests (connect count).
4. A local server `alpha` and a remote server `alpha` at the same time: vault, monitoring history and phone actions keep them apart (`alpha` vs `rmt_alpha`). → Task 4 and Task 9 tests.
5. Multi-packet or oversized RCON replies (`status` with 64 players): collected until 150 ms of silence, capped at 64 KiB, parsed packet by packet like the UDP client. → Task 3 test.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/ssh-transport.mjs` (modify) | `exec(command, { stdin })`: write a Buffer to the channel, then end it. |
| `lib/remote-session-pool.mjs` (new) | One reusable SSH session per host, idle close, closed on error. |
| `lib/remote-commands.mjs` (modify) | `rconExchangeCommand(port)`, `getstatusProbeCommand(port)`, `removeRconFilesCommand(home)`. |
| `lib/remote-rcon-client.mjs` (new) | Same five methods as `RconClient`, over the pool and `rconExchangeCommand`. |
| `lib/remote-subjects.mjs` (new) | `rmt_` subject helpers, shadow store (local data dir per remote instance), prefixed credential adapter. |
| `lib/remote-instance-manager.mjs` (modify) | Password file at launch, cleanup, provisioning callback, use the pool. |
| `lib/remote-linux-routes.mjs` (modify) | RCON, B3 database and B3 admin routes for remote ids; narrower unsupported handler. |
| `lib/remote-monitor.mjs` (new) | `runtimeFor`, `probe`, `readConsole` for remote instances for `MonitorCollector`. |
| `lib/monitor-collector.mjs` (modify) | `probe(port, instance)` (second argument); local wiring unchanged. |
| `installer-server.mjs` (modify) | Wiring: pool, remote RCON/B3 services, monitor listing, gateway dispatch. |
| `lib/instance-rcon-console.jsx`, `lib/instance-online-players.jsx`, `lib/instance-b3-admin.jsx`, `lib/instance-b3-database.jsx` (modify) | Optional `basePath` prop (default `/api/instances/${id}`). |
| `lib/remote-hosts.jsx` (modify) | Embeds console, players, B3 database and B3 admin per remote instance; replaces the "not available" notice. |

---

### Task 0: Spec and plan files

**Files:** Create `docs/superpowers/specs/2026-11-08-remote-rcon-b3-design.md`, `docs/superpowers/plans/2026-11-08-remote-rcon-b3.md`.

- [ ] **Step 1:** `git fetch origin main && git checkout -B ccr-a7aa8618-qxaaf9 origin/main`.
- [ ] **Step 2:** Write the spec from Context, Decisions, Global Constraints and Review Focus (cod4-monitor attribution and the cleartext-database warning included); copy this plan unchanged to `docs/superpowers/plans/`.
- [ ] **Step 3:** Commit `docs: spec and plan for remote RCON and B3 (Block 18b)`.

### Task 1: stdin for SSH exec and a session pool

**Files:** Modify `lib/ssh-transport.mjs`; create `lib/remote-session-pool.mjs`; tests `test/ssh-transport.test.mjs` (extend), `test/remote-session-pool.test.mjs`.

**Interfaces:**
- Produces: `session.exec(command, { timeoutMs, maxBytes, stdin?: Buffer })`; `class RemoteSessionPool { constructor({ connect: hostId => Promise<{session, uid, gid}>, idleMs = 60_000 }); async use(hostId, action: ({session, uid, gid}) => Promise<T>): Promise<T>; closeAll(): void }`. A failing action with a transport code (`REMOTE_CONNECT_FAILED`, `REMOTE_TIMEOUT`, `REMOTE_HOST_KEY_*`, `REMOTE_AUTH_FAILED`) drops the pooled session; other errors keep it. Concurrent `use` calls for one host share one connect.

- [ ] **Step 1: Failing tests:** `exec passes stdin to the remote command and ends it` (in-process ssh2 server echoes stdin length); `exec without stdin behaves as before`; pool: `two uses within idleMs connect once`, `idle session is closed after idleMs`, `a transport error drops the session and the next use reconnects`, `concurrent uses share one connect`, `closeAll closes every session`.
- [ ] **Step 2:** Run `node --test test/ssh-transport.test.mjs test/remote-session-pool.test.mjs`: FAIL.
- [ ] **Step 3:** Implement (`stream.end(stdin)` right after the channel opens; pool keyed by host id with a timer per entry, `unref()`).
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(remote): stdin for ssh exec and a session pool`.

### Task 2: RCON and getstatus commands

**Files:** Modify `lib/remote-commands.mjs`; test `test/remote-commands.test.mjs` (extend).

**Interfaces:**
- Produces: `rconExchangeCommand(port: number): string` — python3 only; reads one packet (≤ 1400 bytes) from stdin, sends it to `127.0.0.1:port`, collects datagrams until 150 ms of silence, 1500 ms total or 65536 bytes, writes them to stdout each prefixed by a 4-byte big-endian length; exit 3 with empty stdout when python3 is missing, exit 4 on no reply. `getstatusProbeCommand(port: number): string` — like `getinfoProbeCommand` with `getstatus` (bash `/dev/udp` or python3). `removeRconFilesCommand(home: string): string` — removes `main/rcon-*.cfg` under `home` only (`find <home>/main -maxdepth 1 -name 'rcon-*.cfg' -type f -delete`). `parseRconFrames(stdout: Buffer): Buffer[]`.

- [ ] **Step 1: Failing tests** (loopback with a local UDP responder, Linux only): `rconExchangeCommand sends the stdin packet and returns every reply datagram`, `the password from stdin never appears in the command string`, `no python3 on PATH gives exit 3` (run with a PATH that has `sh` and no `python3`), `silence ends collection after about 150 ms`, `replies are capped at 65536 bytes`, `getstatusProbeCommand returns the status reply`, `removeRconFilesCommand deletes rcon-*.cfg in main and nothing else`, `hostile home paths are quoted`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement; the python script is a fixed string constant like `PYTHON_PROBE`.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(remote): rcon exchange and getstatus commands`.

### Task 3: Remote RCON client

**Files:** Create `lib/remote-rcon-client.mjs`; test `test/remote-rcon-client.test.mjs`.

**Interfaces:**
- Consumes: Task 1 pool, Task 2 commands, `lib/rcon-protocol.mjs` builders and `parsePacket`/`classifyRconResponse`.
- Produces: `class RemoteRconClient { constructor({ pool, hostId, port, timeoutMs = 4000 }); probe(); queryStatus(); execute(password: Buffer, command); say(password, text); kick(password, slot, reason) }` with the same results and error codes as `RconClient`, plus `REMOTE_RCON_TOOL_MISSING` (exit 3) and `RCON_TIMEOUT` (exit 4). The packet Buffer is wiped (`fill(0)`) after `exec` returns. `createRemoteRconClientFactory({ pool, instances: RemoteInstanceStore })` returns a `clientFactory` for `InstanceRconService` that ignores `host` and uses the instance's `hostId` and `port`.

- [ ] **Step 1: Failing tests** (fake pool whose session runs the Task 2 command against a local UDP responder): `execute returns the same text as RconClient for a single packet`, `a status reply split over three datagrams is joined`, `Bad rcon is RCON_AUTH_FAILED`, `exit 3 is REMOTE_RCON_TOOL_MISSING`, `the packet buffer is zero after execute`, `kick and say build the same packets as the UDP client`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(remote): rcon client over ssh`.

### Task 4: Vault subjects and shadow store for remote instances

**Files:** Create `lib/remote-subjects.mjs`; modify `installer-server.mjs` (credential `resolveInstance`); test `test/remote-subjects.test.mjs`.

**Interfaces:**
- Produces: `REMOTE_PREFIX = 'rmt_'`; `remoteSubject(id)`, `isRemoteSubject(value)`, `remoteIdOf(subject)`; `createShadowStore({ instances: RemoteInstanceStore, dataRoot })` → `{ get(id) → { id, homePath: <dataRoot>/remote-data/<id> (created 0700 on first use), createdAt, port, hostId }, list() }`; `prefixedCredentials(credentialService)` → the credential service API (`instanceStatus`, `set`, `remove`, `withRuntimeCredentials`) with the first argument rewritten to `rmt_<id>`. The credential `resolveInstance` resolves `rmt_<id>` through the shadow store (as `ssh_<hostId>` already does).

- [ ] **Step 1: Failing tests:** `rmt_ subjects resolve to the shadow home, ssh_ and local ids unchanged`, `a local id alpha and a remote id alpha get separate vault entries`, `a removed and re-added remote instance does not inherit the old credentials` (createdAt in the key), `the shadow home is created with mode 0700`, `prefixedCredentials forwards every method with the prefix`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement and wire.
- [ ] **Step 4:** Run with `test/remote-credentials.test.mjs`, `test/instance-credential-service.test.mjs`: PASS.
- [ ] **Step 5:** Commit `feat(remote): vault subjects and shadow store for remote instances`.

### Task 5: RCON password at remote launch

**Files:** Modify `lib/remote-instance-manager.mjs`; test `test/remote-instance-runtime.test.mjs` (extend).

**Interfaces:**
- Consumes: Task 4 `prefixedCredentials`, Task 2 `removeRconFilesCommand`, `checkPassword` from `lib/rcon-protocol.mjs`.
- Produces: constructor options `credentials` (prefixed adapter, optional) and `onProvisioned(id, runId, { rcon: boolean })`. Launch: inside `credentials.withRuntimeCredentials(id, …)` write `main/rcon-<runId>.cfg` (`set rcon_password "<pw>"\n`, mode 0600, `writeFileExclusive`) and add `+exec rcon-<runId>.cfg` before `+exec server.cfg`; after the identity check confirms the core (or on any failure path) run `removeRconFilesCommand(home)`; `stop`, `recover` and a `status` that finds the process gone also run it. No password or vault locked: start without the file, `onProvisioned(..., { rcon: false })`.

- [ ] **Step 1: Failing tests** (loopback fake core prints its argv and the files it sees): `start with a stored password writes the file, passes +exec and removes the file after RUNNING`, `the password is not in the core's argv or in the start command`, `a lost connection after writing the file leaves it, the next status/stop removes it`, `locked vault starts without the file and reports rcon false`, `the file has mode 0600 while it exists`, `onProvisioned gets the runId of this start`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run with all `test/remote-instance-*.test.mjs`: PASS.
- [ ] **Step 5:** Commit `feat(remote): rcon password through a private exec file`.

### Task 6: Remote RCON service, routes and console UI

**Files:** Modify `installer-server.mjs`, `lib/remote-linux-routes.mjs`, `lib/instance-rcon-console.jsx`, `lib/instance-online-players.jsx`, `lib/remote-hosts.jsx`; tests `test/remote-linux-http.test.mjs` (extend), `test/remote-hosts.test.mjs` (extend), `test/instance-rcon-console.test.mjs` (extend).

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces: a second `InstanceRconService` (`remoteRconService`) with `resolveInstance: shadowStore.get`, `runtimeFor: id => ({ state, reconcileRuntimeState })` over `remoteInstanceManager.status(id)`, `credentialService: prefixedCredentials(...)`, `clientFactory: createRemoteRconClientFactory(...)`; routes under `/api/remote-instances/:id/rcon` with the local shapes: `GET /rcon` (`diagnostics.read`), `POST /rcon/connect`, `POST /rcon/command`, `GET /rcon/online`, `POST /rcon/kick`, `POST /rcon/say` (`server.manage`), all in `REMOTE_LINUX_BINDINGS`. The unsupported regex keeps only the B3 runtime paths. `basePath` prop on both components (default `/api/instances/${instance.id}`).

- [ ] **Step 1: Failing tests:** HTTP (real backend, in-process ssh2 server whose exec runs the RCON command against a local UDP responder): `viewer reads rcon status, cannot send a command`, `operator runs status and gets the reply`, `a blocked command is RCON_COMMAND_BLOCKED`, `kick confirms the slot`, `audit carries no password`; UI: `console and players use basePath when given`, `remote panel shows the console for a running remote instance and no 'RCON not available' notice`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement and wire (`onProvisioned` → `remoteRconService.recordProvisioning`).
- [ ] **Step 4:** Run with `test/instance-rcon-service.test.mjs`, `test/remote-linux-http.test.mjs`: PASS.
- [ ] **Step 5:** Commit `feat(remote): rcon console, players, kick and say for remote servers`.

### Task 7: B3 administration through B3's database

**Files:** Modify `installer-server.mjs`, `lib/remote-linux-routes.mjs`, `lib/instance-b3-admin.jsx`, `lib/instance-b3-database.jsx`, `lib/remote-hosts.jsx`; tests `test/remote-b3-http.test.mjs` (new), `test/remote-hosts.test.mjs` (extend).

**Interfaces:**
- Consumes: Task 4 shadow store and prefixed credentials, Task 6 `remoteRconService`.
- Produces: `remoteB3DatabaseService = new InstanceB3DatabaseService({ store: shadowStore, credentials: prefixedCredentials(...), environment: b3EnvironmentForRuntime, b3IsRunning: async () => false })` and `remoteB3AdminService = new InstanceB3AdminService({ store: shadowStore, database: remoteB3DatabaseService, rcon: remoteRconService, b3IsRunning: async () => false, ... })`. Routes `/api/remote-instances/:id/b3/database` (GET/POST, `/remove`, `/test`) and `/b3/admin/*` mirroring `installer-server.mjs:2696–2713` with the same permissions; `/b3/database/migrate` → `REMOTE_B3_MIGRATE_UNSUPPORTED`. `basePath` and a `remote` flag on both components; with `remote` the database form hides SQLite and migration and shows the cleartext warning (German and English).

- [ ] **Step 1: Failing tests:** (fake helper as in the local B3 admin tests) `remote database settings save and test against a non-loopback host`, `penalties, admins and groups read through the helper with the remote settings`, `ban with kick sends the kick through remote RCON`, `migrate answers REMOTE_B3_MIGRATE_UNSUPPORTED`, `b3/start still answers REMOTE_B3_UNSUPPORTED`, `a remote and a local server with the same id keep separate database settings`, UI `remote database form shows the cleartext warning and no SQLite option`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement and wire.
- [ ] **Step 4:** Run with `test/instance-b3-admin-service.test.mjs`, `test/instance-b3-database-service.test.mjs`: PASS.
- [ ] **Step 5:** Commit `feat(remote): B3 administration through the B3 database`.

### Task 8: Monitoring for remote servers

**Files:** Create `lib/remote-monitor.mjs`; modify `lib/monitor-collector.mjs`, `installer-server.mjs`; tests `test/remote-monitor.test.mjs`, `test/monitor.test.mjs` (extend).

**Interfaces:**
- Consumes: Task 1 pool, Task 2 `getstatusProbeCommand`, `parseStatusResponse`.
- Produces: `MonitorCollector` calls `probe(instance.port, instance)` (local probe ignores the second argument). `createRemoteMonitor({ pool, instances, manager })` → `{ listInstances() → [{ ...instance, id: 'rmt_<id>', name, port, remote: true }], runtimeFor(rmtId), probe(port, instance), readConsole(instance) }` (console tail via the manager's bounded tail). The collector's `listInstances` concatenates local and remote.

- [ ] **Step 1: Failing tests:** `remote instances appear with rmt_ ids`, `one poll of three remote servers on one host makes one SSH connection` (pool connect count), `an unreachable host marks its servers offline after 45 s, not CONTROL itself`, `a local and a remote server named alpha keep separate history`, `crash cause reads the remote console tail`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement and wire.
- [ ] **Step 4:** Run with `test/monitor.test.mjs`, `test/monitor-http.test.mjs`: PASS.
- [ ] **Step 5:** Commit `feat(remote): remote servers in monitoring`.

### Task 9: Phone gateway actions for remote servers

**Files:** Modify `installer-server.mjs` (gateway action dispatch around 2849–2857, `monitorInstance`); test `test/remote-actions-http.test.mjs` (extend).

**Interfaces:**
- Consumes: Tasks 6 and 8.
- Produces: for ids starting with `rmt_`, `players`/`say`/`kick` go to `remoteRconService`, `restart` to `remoteInstanceManager.restart`; step-up, rate limit and audit unchanged; `REMOTE_ROUTES` in `lib/remote-gateway.mjs` unchanged (ids travel as parameters).

- [ ] **Step 1: Failing tests:** `phone lists remote servers`, `phone kick on rmt_ id needs step-up and reaches remote RCON`, `phone restart on rmt_ id restarts the remote server`, `rmt_ id of a removed server is INSTANCE_NOT_FOUND`, `local id alpha and rmt_alpha act on different servers`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run with `test/remote-actions.test.mjs`, `test/remote-http.test.mjs`: PASS.
- [ ] **Step 5:** Commit `feat(remote): phone actions for remote servers`.

### Task 10: Gates, version 4.18.24, checklist

**Files:** Create `scripts/verify-4.18.24-remote-rcon-gate.mjs`, `scripts/verify-4.18.24-version.mjs`, `scripts/verify-4.18.24-runtime.mjs`, `scripts/preflight-4.18.24.mjs`, `CHANGELOG-4.18.24.md`; modify `scripts/verify-4.18.23-remote-linux-native.mjs` (RCON steps), `package.json`, `package-lock.json`, `BUILD_INFO.json`, `build.ps1` (CRLF via `newline=''`), `cod4x-control-improved.jsx`, `README.md`, `DEVELOPMENT_STATUS.md`, `SECURITY.md`, roadmap marker, `docs/WSL-NATIVE-CHECKLIST.md`.

- [ ] **Step 1:** Gate: source checks (the password never reaches `startCoreCommand` args; `rconExchangeCommand` has no bash branch; every new remote route guarded and in `REMOTE_LINUX_BINDINGS`; `REMOTE_ROUTES` unchanged; cod4-monitor attribution kept), then the remote test files (summary in `# pass` and `ℹ pass` form, Linux requires 0 skipped).
- [ ] **Step 2:** Native check extension: after Start, `status` over RCON returns the hostname; the password file is gone; `/proc/<pid>/cmdline` on the server has no `rcon_password`; kick of a bot or an empty slot answers as locally.
- [ ] **Step 3:** Version bump as in 4.18.23; checklist gains the remote RCON and B3 database items (B3 with a real MySQL reachable from the control PC).
- [ ] **Step 4:** Run preflight and the full suite as a non-root user with `umask 022`; record real numbers; mark native items "not run".
- [ ] **Step 5:** Commit `4.18.24: remote RCON, B3 database, monitoring and phone actions (Block 18b)`, push, draft PR, subscribe.

---

## Verification (whole plan)

`node scripts/preflight-4.18.24.mjs` and `node --test "test/*.test.mjs"` as a non-root user with `umask 022`; CI green on Ubuntu and Windows (Node 22 and 24) and CodeQL without new alerts. Manual on WSL (checklist): native remote check with RCON (real sshd, real core, python3 on the server) and B3 administration against a real MySQL.
