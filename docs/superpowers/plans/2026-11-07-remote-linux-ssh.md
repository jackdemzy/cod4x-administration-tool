# Remote Linux over SSH (Roadmap Block 18, 4.18.23) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows CONTROL PC manages Linux game servers over SSH: Install, Update, Start, Stop, Restart, Logs, Health, Config, Backup, Restore. Gate: Remote Linux Install -> Start -> Stop -> Logs PASS.

**Architecture:** No agent on the server. CONTROL talks to the server through one `ssh2` session: fixed, quoted commands for process control and SFTP for files. The existing `createLinuxRuntimeAdapter` (PID identity, ownership, bounded output, signals) is reused by giving it a remote `filesystem` and `hostProcess`. Remote servers live in their own store and manager; the local `ServerInstanceManager` is not touched.

**Tech Stack:** Node >= 22.12 ES modules, `ssh2` ^1.17 (new, pure JS; checked against its docs: `hostHash: 'sha256'` + async `hostVerifier(hexHash, verify)` runs before authentication), `node:test`, React for the panel.

**Spec:** `docs/superpowers/specs/2026-11-07-remote-linux-ssh-design.md` (Task 0 writes it from the decisions below).

## Decisions (Rafiki, 2026-11-07)

1. Transport: `ssh2` library, not the system OpenSSH client (key comes from the vault into memory, never a file).
2. Model: agentless. SFTP + a fixed command list. Nothing installed on the server.
3. Scope of Health: process identity (`/proc`) plus a `getinfo` probe run on the server. RCON console, kick, master status and B3 for remote instances are **out of Block 18** and blocked with a named code, not half supported.
4. BaseGame: an existing path on the server, checked read-only. CONTROL uploads only the CoD4x Linux core and creates the instance directory.

## Global Constraints

- Gate text verbatim: "Remote Linux Install -> Start -> Stop -> Logs PASS".
- Security (roadmap): SSH credentials not in clear text; host-key verification; no blind trust on first use without a warning; command injection prevented; remote path validation.
- Host-key policy: first contact never authenticates and never sends credentials; it shows the SHA-256 fingerprint and needs an explicit confirmation of that exact value. A changed key after pinning is a hard stop (`REMOTE_HOST_KEY_CHANGED`), never auto-accepted.
- Core never runs as root: connect user `root` is refused when the host is saved; a remote `id -u` of 0 is refused again at connect.
- Network default is loopback, as for local instances; public binding reuses `lib/instance-network.mjs` (`normalizeNetwork`, `bindAddresses`, `networkChangeRequest`, confirmation `PUBLIC_EXPOSURE`).
- Linux core file name is exactly `cod4x18_dedrun`; supported versions `21.2`, `21.3`, `21.4`, `21.5`.
- No secrets in audit, logs, state files or API results. Error codes are `REMOTE_*` constants.
- Remote instances are not shown to the phone gateway (`lib/remote-gateway.mjs`).
- Version 4.18.23; old `*-4.18.22-*` scripts stay in the preflight chain.

## Review Focus

1. The server key changes after pinning (reinstall, or a man in the middle): connect stops before authentication, nothing is sent.
2. The SSH connection drops while a start is in flight (PID unknown): state stays recoverable and a retry never spawns a second core.
3. Names with spaces, quotes, `;`, `$()`, backticks, newlines, `..` and non-ASCII in an instance ID, path, user or host: refused or inert, never executed.
4. Log files that are huge, binary or invalid UTF-8: output is bounded and valid text.
5. Vault locked while connecting: `VAULT_LOCKED`, no fallback prompt, no agent, no password.
6. Disk full or dropped connection during the core upload: the partial file is removed and a hash check catches a truncated file.

## File Structure

| File | Responsibility |
|---|---|
| `lib/remote-safety.mjs` (new) | `shellQuote`, `assertRemotePosixPath`, id/host/user validators. Pure. |
| `lib/remote-host-store.mjs` (new) | Host registry JSON, host-key pinning. |
| `lib/ssh-transport.mjs` (new) | `ssh2` session: connect with host-key check, `exec`, `sftp`. |
| `lib/remote-host-service.mjs` (new) | Vault + store + transport: `connect`, `probeHostKey`, `trustHostKey`. |
| `lib/remote-commands.mjs` (new) | The only commands CONTROL runs on a server. |
| `lib/remote-linux-runtime.mjs` (new) | Remote `filesystem` and `hostProcess` for `createLinuxRuntimeAdapter`. |
| `lib/remote-instance-store.mjs` (new) | Remote instance records. |
| `lib/remote-instance-manager.mjs` (new) | Install, update, start/stop/restart, status, health, logs, config, backup, restore. |
| `lib/remote-hosts.jsx` (new) | UI panel. |
| `lib/linux-runtime-adapter.mjs` (modify) | `await hostProcess.kill(...)` (remote kill is async). |
| `lib/instance-credential-service.mjs` (modify) | New kind `ssh`, only for `host-<id>` subjects. |
| `installer-server.mjs` (modify) | Services wired, `/api/remote-hosts/**`, `/api/remote-instances/**`. |
| `test/support/loopback-transport.mjs` (new) | Test double: runs the allowlisted commands and file operations on a local temp "server" (Linux only). |

---

### Task 0: Branch, spec, plan files

**Files:** Create `docs/superpowers/specs/2026-11-07-remote-linux-ssh-design.md`, `docs/superpowers/plans/2026-11-07-remote-linux-ssh.md`.

- [ ] **Step 1:** `git fetch origin main && git checkout -B ccr-a7aa8618-qxaaf9 origin/main` (the old PRs are merged; new work starts from main).
- [ ] **Step 2:** Write the spec from "Decisions", "Global Constraints", "Review Focus" and the roadmap Block 18 text (copied verbatim); save this plan unchanged under `docs/superpowers/plans/`.
- [ ] **Step 3:** Commit `docs: spec and plan for Block 18 (remote Linux over SSH)`.

### Task 1: Safety primitives

**Files:** Create `lib/remote-safety.mjs`, `test/remote-safety.test.mjs`.

**Produces:** `shellQuote(value: string): string` (POSIX single quotes, `'` becomes `'\''`, rejects NUL and non-string); `assertRemotePosixPath(value: string, { under?: string }): string` (absolute, normalized, no `..`, no NUL or control characters, no `//`, max 1024, inside `under` when given, else `REMOTE_PATH_INVALID`); `validHostId` `^[a-z][a-z0-9-]{0,39}$`; `validRemoteInstanceId` `^[a-z][a-z0-9-]{0,47}$`; `validRemoteUser` `^[a-z_][a-z0-9_-]{0,31}$` and not `root`; `validHostName` (DNS name or IPv4/IPv6 literal, no spaces or leading `-`).

- [ ] **Step 1: Failing tests.** `shellQuote` round trip: for each of `a b`, `a'b`, `$(id)`, `` `id` ``, `a;b`, `a\nb`, `-rf`, the output run through `sh -c 'printf %s ' + quoted` (Linux only, skipped elsewhere) prints the input unchanged; `assertRemotePosixPath('/srv/../etc')`, `'srv/x'`, `'/a//b'`, `'/a\u0000'`, `'/a\nb'` throw `REMOTE_PATH_INVALID`; `'/srv/cod4x/a'` with `under: '/srv/cod4x'` passes, `'/srv/cod4x2/a'` does not; `validRemoteUser('root')` false.
- [ ] **Step 2:** Run `node --test test/remote-safety.test.mjs`: FAIL (module missing).
- [ ] **Step 3:** Implement the signatures above in `lib/remote-safety.mjs`.
- [ ] **Step 4:** Run the test: PASS.
- [ ] **Step 5:** Commit `feat(remote): safety primitives`.

### Task 2: Host registry and host-key pinning

**Files:** Create `lib/remote-host-store.mjs`, `test/remote-host-store.test.mjs`.

**Consumes:** Task 1 validators.
**Produces:** `class RemoteHostStore { constructor({ file, inUse = (hostId) => false }); load(): Promise<void>; list(): Host[]; get(id): Host; create({ id, label, host, port, username }): Promise<Host>; pinHostKey(id, sha256Hex: string): Promise<Host>; remove(id): Promise<void> }` where `Host = { id, label, host, port, username, hostKeySha256: string | null, createdAt }`. Codes: `REMOTE_HOST_EXISTS`, `REMOTE_HOST_NOT_FOUND`, `REMOTE_HOST_INVALID`, `REMOTE_HOST_STORE_INVALID`. File is atomic JSON (0600, temp + rename), version 1; a corrupt file fails closed like `ServerInstanceStore`. `pinHostKey` accepts only 64 lowercase hex characters; re-pinning a different value is refused (`REMOTE_HOST_KEY_CHANGED`), a host must be removed and re-added to change its key. `remove` throws `REMOTE_HOST_IN_USE` while `inUse(id)` is true (Task 7 passes a function that asks the remote instance store).

- [ ] **Step 1: Failing tests** named `creates and lists a host`, `refuses root, bad port, bad host name and duplicate id`, `pins a key once and refuses a different one`, `survives a restart`, `corrupt file fails closed and is not replaced`. Assertion for the file: `(await fs.stat(file)).mode & 0o077 === 0` on Linux.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement the class in `lib/remote-host-store.mjs`.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(remote): host registry with host-key pinning`.

### Task 3: SSH transport

**Files:** Modify `package.json`, `package-lock.json` (`ssh2` ^1.17, `npm install ssh2 --ignore-scripts`; check `npm view ssh2 version` first). Create `lib/ssh-transport.mjs`, `test/ssh-transport.test.mjs`.

**Consumes:** Task 2 `Host`.
**Produces:**
- `openSession({ host: Host, privateKey: Buffer, passphrase?: Buffer, readyTimeoutMs?: number }): Promise<RemoteSession>`; connect options `hostHash: 'sha256'`, `hostVerifier` compares the hex hash with `host.hostKeySha256`; algorithms left at the library defaults; no password, no agent, no keyboard-interactive.
- `probeHostKey(host: Host): Promise<{ sha256Hex: string, sha256Base64: string }>`: connects, records the presented hash, answers `verify(false)`; never authenticates.
- `RemoteSession = { hostKeySha256: string, exec(command: string, { timeoutMs?: number, maxBytes?: number }): Promise<{ code: number, stdout: Buffer, stderr: Buffer, truncated: boolean }>, sftp(): Promise<Sftp>, close(): void }`. `exec` bounds output (default 256 KiB) and time (default 30 s) and kills the channel on either limit.
- Errors with `code`: `REMOTE_HOST_KEY_UNVERIFIED` (host has no pinned key; carries `presentedSha256`), `REMOTE_HOST_KEY_CHANGED` (carries presented and pinned), `REMOTE_AUTH_FAILED`, `REMOTE_CONNECT_FAILED`, `REMOTE_TIMEOUT`.

- [ ] **Step 1: Failing tests** against an in-process `ssh2` `Server` (generated Ed25519 host key and client key; exec handler echoes). Names and assertions: `unpinned host: rejects with REMOTE_HOST_KEY_UNVERIFIED and the server never sees an auth attempt` (server records auth attempts, expects 0); `pinned host with matching key connects and runs exec`; `changed host key: REMOTE_HOST_KEY_CHANGED and zero auth attempts`; `wrong client key: REMOTE_AUTH_FAILED`; `probeHostKey returns the same hash as the pinned value and makes no auth attempt`; `exec output is bounded and flagged truncated`; `exec timeout kills the channel with REMOTE_TIMEOUT`; `sftp() on a server without an sftp subsystem rejects with REMOTE_SFTP_UNAVAILABLE`.
- [ ] **Step 2:** Run `node --test test/ssh-transport.test.mjs`: FAIL.
- [ ] **Step 3:** Implement `lib/ssh-transport.mjs` on `ssh2.Client`. `Sftp` is the raw `ssh2` SFTP object (`SFTPWrapper`); Task 6 builds the `node:fs`-like subset on top of it. The module keeps no module-level state and never copies the key or passphrase; the caller wipes its buffers.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(remote): ssh2 transport with host-key verification`.

### Task 4: SSH credentials in the vault and the host service

**Files:** Modify `lib/instance-credential-service.mjs`. Create `lib/remote-host-service.mjs`, `test/remote-host-service.test.mjs`, extend `test/instance-credential-service.test.mjs`.

**Consumes:** Task 2 store, Task 3 `openSession`, `probeHostKey`.
**Produces:**
- Credential kind `ssh` (value: JSON `{ "privateKey": string, "passphrase"?: string }`, validated: OpenSSH or PEM private key header, <= 16 KiB, passphrase printable <= 256). It is allowed only for subject ids `host-<hostId>` and no other kind is allowed for those ids. `instanceStatus` stays unchanged for normal instances.
- `class RemoteHostService { constructor({ store, credentials, openSession, probeHostKey, audit }); probeHostKey(hostId): Promise<{ sha256Hex, sha256Base64 }>; trustHostKey(hostId, expectedSha256Hex): Promise<Host>; connect(hostId): Promise<RemoteSession> }`. `trustHostKey` probes again and pins only if the presented hash equals `expectedSha256Hex` (else `REMOTE_HOST_KEY_MISMATCH`). `connect` reads the key inside `credentials.withRuntimeCredentials('host-' + hostId, ...)`, opens the session inside that scope and wipes the buffers after; a locked vault gives `VAULT_LOCKED`. After connect it runs the `id -u` probe (Task 5) and refuses uid 0 with `REMOTE_ROOT_BLOCKED`. Audit events `remote.host.created|key_probed|key_trusted|connect_failed` with host id and codes only.
- Wiring detail for `installer-server.mjs` (Task 11): the `resolveInstance` passed to the credential service resolves `host-<id>` to `{ id, homePath: <dataRoot>/ssh-hosts/<id>, createdAt }`.

- [ ] **Step 1: Failing tests:** vault: `ssh kind is accepted only for host- subjects`, `rejects a key without a private-key header, an oversize key and a passphrase with control characters`, `ssh secret is returned only inside a runtime scope and wiped afterwards`, `rcon is refused for a host- subject`. Service: `connect on a locked vault fails VAULT_LOCKED and opens no session`, `trustHostKey with a different expected hash pins nothing`, `trustHostKey with the probed hash pins it and a second connect succeeds`, `connect refuses uid 0`, `audit entries contain no key and no passphrase`.
- [ ] **Step 2:** Run both files: FAIL.
- [ ] **Step 3:** Implement the vault kind (add `ssh` to `KINDS` and `GENERIC_KINDS`, add the subject rule next to `#instance`) and `RemoteHostService`.
- [ ] **Step 4:** Run both files plus `test/multi-server-isolation.test.mjs`: PASS.
- [ ] **Step 5:** Commit `feat(remote): ssh credentials and host service`.

### Task 5: Command allowlist and loopback test double

**Files:** Create `lib/remote-commands.mjs`, `test/support/loopback-transport.mjs`, `test/remote-commands.test.mjs`.

**Consumes:** Task 1 `shellQuote`.
**Produces:** each builder returns a single command string made only of fixed words and `shellQuote`d values; nothing else in the codebase builds a remote command.
- `probeCommand(): string` prints `<uname -s> <uname -m>\n<uid>\n<gid>`.
- `makeDirectoriesCommand(home: string, names: string[]): string` (`mkdir -p -m 0700`).
- `startCoreCommand({ core, cwd, args, stdoutFile, stderrFile }): string` runs the core detached from the SSH channel (`setsid`, stdin from `/dev/null`, stdout and stderr redirected to the given files) and prints the PID of the core. Which shell construct yields the core's own PID (not a wrapper) is the implementer's choice; the identity check in Task 9 decides, and the native gate verifies it.
- `signalCommand(pid: number, signal: 'TERM' | 'KILL'): string` (`kill -s`), pid must be a positive safe integer.
- `getinfoProbeCommand(port: number): string` sends one UDP `getinfo` to `127.0.0.1:port` with a 1 s timeout using a tool present on a minimal server (`bash` `/dev/udp`, falling back to `python3`); prints the response or exits 3 (`no tool`).
- `diskFreeCommand(path: string): string`.
`LoopbackTransport` in `test/support`: an object with the `RemoteSession` shape that maps the `/srv/remote` prefix to a temp directory, runs the builder output with `sh -c` as the current non-root user, and offers `sftp()` over `node:fs` with the same path mapping. Linux only; tests skip elsewhere.

- [ ] **Step 1: Failing tests:** `every builder output survives hostile inputs` (instance paths containing `'`, `"`, `$(touch /tmp/x)`, newline, `;`; assert via `sh -n -c` that the string parses to exactly the expected word count and that `/tmp/x` is never created when run through the loopback), `signalCommand rejects 0, -1, 1.5 and a string`, `probeCommand output parses with parseProbe()` (add `parseProbe(stdout: Buffer): { os, arch, uid, gid }` here; rejects any other OS or arch than `Linux x86_64`), `startCoreCommand starts a fake core script and prints a PID that is alive` (fake core = a shell script that sleeps; Linux only).
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement the builders, `parseProbe` and the loopback double.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(remote): fixed command list and loopback test double`.

### Task 6: Remote runtime adapter

**Files:** Modify `lib/linux-runtime-adapter.mjs` (in `signal`: `await hostProcess.kill(pid, signalName)`; local `process.kill` returns synchronously so behavior is unchanged). Create `lib/remote-linux-runtime.mjs`, `test/remote-linux-runtime.test.mjs`.

**Consumes:** Task 3 `RemoteSession`/`Sftp`, Task 5 commands and `parseProbe`.
**Produces:** `createRemoteLinuxAdapter(session: RemoteSession, { uid, gid }): LinuxRuntimeAdapter` built from `createLinuxRuntimeAdapter({ filesystem, hostProcess })` where:
- `filesystem` is an SFTP-backed subset of `node:fs/promises`: `open(file, flags)` returning `{ read(buffer, offset, length, position), stat(), close() }` (a `null` position means "continue after the last read"), `lstat`, `stat`, `readdir`, `readlink`, `realpath`, `mkdir`, `access`; stats expose `isFile()`, `isDirectory()`, `isSymbolicLink()`, `mode`, `uid`, `gid`, `size`, `nlink`, `dev`, `ino`.
- `hostProcess = { platform: 'linux', getuid: () => uid, geteuid: () => uid, getgid: () => gid, kill: (pid, signal) => session.exec(signalCommand(pid, ...)) }`.
- Remote output files are created by the shell redirection of `startCoreCommand`, so `prepareOutput` is replaced by `prepareRemoteOutput(session, home, runId): { stdoutFile, stderrFile }` (creates both 0600 with `set -C`, i.e. exclusive, and validates `home/logs` ownership like `outputPaths`).
- Known risk, settled in this task by a probe test and again by the native gate: reading `/proc/<pid>/*` through SFTP (size reports 0). If the probe fails, the filesystem's `open` for paths under `/proc/` switches to `exec` with `head -c <limit> -- <path>` (path validated against `^/proc/[0-9]+/(stat|cmdline|status)$`).

- [ ] **Step 1: Failing tests** (loopback, Linux only): `inspectProcess on a started fake core returns identity with argv, uid and boot:ticks`; `signal refuses a PID whose executable path differs` (`INSTANCE_PROCESS_IDENTITY_BLOCKED`); `signal terminates only the matching core and awaits the remote kill`; `readOutput returns a bounded UTF-8 tail of a 3 MiB stdout file and of a file with invalid UTF-8`; `a root uid is refused by assertHost (RUNTIME_ROOT_BLOCKED)`; `reading /proc through the filesystem returns non-empty stat data`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement `createRemoteLinuxAdapter`, the SFTP filesystem subset and `prepareRemoteOutput`; make the one-word adapter change.
- [ ] **Step 4:** Run the new file and `test/linux-runtime-adapter.test.mjs`, `test/linux-runtime-lifecycle.test.mjs` (as non-root): PASS.
- [ ] **Step 5:** Commit `feat(remote): remote Linux runtime adapter`.

### Task 7: Remote instance store

**Files:** Create `lib/remote-instance-store.mjs`, `test/remote-instance-store.test.mjs`.

**Consumes:** Tasks 1 and 2, `lib/instance-network.mjs` `normalizeNetwork`.
**Produces:** `class RemoteInstanceStore { constructor({ file, hosts: RemoteHostStore }); load(); list(); get(id); create(input): Promise<RemoteInstance>; setNetwork(id, network); setCore(id, core); remove(id) }` with `RemoteInstance = { id, name, hostId, port, remoteRoot, home, basePath, core: { path, version, sha256 }, network, createdAt }`. Rules: `home = remoteRoot + '/' + id`; port 1024..65535 and unique **per host**; `remoteRoot`, `basePath` validated by `assertRemotePosixPath`; `home` must not equal or lie inside `basePath` and vice versa (same overlap rule as local); name rules as `ServerInstanceStore.model`. Codes: `REMOTE_INSTANCE_EXISTS`, `REMOTE_PORT_CONFLICT`, `REMOTE_PATH_OVERLAP`, `REMOTE_INSTANCE_INVALID`, `REMOTE_INSTANCE_NOT_FOUND`.

- [ ] **Step 1: Failing tests:** `same port on two hosts is fine, on one host conflicts (also under concurrent create)`, `home inside basePath and basePath inside home are refused`, `traversal in remoteRoot or basePath is refused`, `network defaults to LOOPBACK and PUBLIC needs the confirmation phrase`, `registry survives a reload`, `a host with instances cannot be removed from the host store (REMOTE_HOST_IN_USE)`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement the store (atomic JSON like the host store, per-store operation queue as in `ServerInstanceStore.exclusive`).
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(remote): remote instance store`.

### Task 8: Install and update

**Files:** Create `lib/remote-instance-manager.mjs` (class `RemoteInstanceManager`, first part), `lib/remote-basegame.mjs` (read-only BaseGame check over SFTP), `test/remote-instance-install.test.mjs`.

**Consumes:** Tasks 4 to 7.
**Produces:** `RemoteInstanceManager({ instances: RemoteInstanceStore, hosts: RemoteHostService, audit })` (Task 9 adds the `state: RemoteStateStore` option) with `install(input: { id, name, hostId, port, remoteRoot, basePath, corePath: string /* local file on the CONTROL PC */, coreVersion, expectedCoreSha256 }): Promise<RemoteInstance>` and `updateCore(id, { corePath, coreVersion, expectedCoreSha256 }): Promise<RemoteInstance>`. `assertRemoteBaseGame(sftp, basePath): Promise<{ iwdFiles: string[], zoneFiles: string[] }>` mirrors the local rules (read `lib/base-game-manager.mjs`: `main` has non-empty `.iwd` files, `zone` has non-empty files, bounded depth and entries) using only read operations. Install order, each step a named failure code: connect (host-key and uid checks) -> probe `Linux x86_64` (`REMOTE_PLATFORM_UNSUPPORTED`) -> base game valid (`REMOTE_BASEGAME_INVALID`, with `REMOTE_BASEGAME_MAIN_MISSING` / `REMOTE_BASEGAME_ZONE_MISSING` detail) -> local core file name is `cod4x18_dedrun` and SHA-256 equals `expectedCoreSha256` (`REMOTE_CORE_INVALID`) -> home absent (`REMOTE_HOME_EXISTS`, never adopt or overwrite) -> create `home` and `main zone mods plugins usermaps players logs` (0700) -> upload core to a temp name, `chmod 0755`, verify the remote SHA-256 by re-reading it over SFTP, rename into `home/core/cod4x18_dedrun` -> write the generated initial `main/server.cfg` (same text and rules as `ServerInstanceStore.create`, passes `validateManagedConfigText`) -> store the record. Any failure after directories exist moves the home to `<remoteRoot>/.recovery/<id>-<uuid>` like the local store. `updateCore` requires the instance to be stopped, keeps the old core as `cod4x18_dedrun.previous`, and rolls back on a failed hash check.

- [ ] **Step 1: Failing tests** (loopback): `install creates the layout, the core with mode 0755 and a valid server.cfg`, `wrong core file name`, `core hash mismatch uploads nothing`, `missing main directory`, `missing zone files`, `existing home is never adopted`, `port already used on that host`, `truncated upload (loopback fails after 10 KiB) leaves no partial core and no instance record`, `update while running is refused`, `update with a bad hash restores the previous core`, `install on a platform other than Linux x86_64 is refused`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement per the order above; stream the upload in chunks with a bounded number of in-flight writes.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(remote): install and update`.

### Task 9: Start, stop, restart, status, health

**Files:** Modify `lib/remote-instance-manager.mjs`; create `lib/remote-runtime-state.mjs` (`RemoteStateStore`, one JSON per instance under `<dataRoot>/remote/<id>/runtime-state.json`, 0600), `test/remote-instance-runtime.test.mjs`.

**Consumes:** Tasks 5 to 8; `lib/instance-config-validator.mjs` `validateManagedConfigText`; `lib/instance-network.mjs` `bindAddresses`.
**Produces:** `start(id)`, `stop(id)`, `restart(id)`, `status(id): { runtime: { status: 'STOPPED'|'STARTING'|'RUNNING'|'STOPPING'|'FAILED', pid, runId, startedAt, recoveryBlocked }, ... }`, `health(id): { process: 'ALIVE'|'GONE'|'UNKNOWN', getinfo: 'OK'|'NO_ANSWER'|'NO_TOOL'|'SKIPPED', hostname?, map?, players? }`. Start: per-instance operation lock (`REMOTE_OPERATION_BUSY`); validate the remote `server.cfg` (read via SFTP, `validateManagedConfigText` with `{ port, network }`); the same launch arguments as the local launch (`+set dedicated 2`, `fs_basepath`, `fs_homepath`, `net_port`, `net_ip`, `net_port6`, `net_ip6`, `+exec server.cfg`, `+set logfile 2`, `+map mp_backlot`) **without** `rcon_password` or `sv_authtoken`; write state `STARTING` with the run ID **before** spawning; run `startCoreCommand`; verify with `adapter.inspectProcess` that executable path, `fs_homepath` and `net_port` match (`assertLinuxInstanceOwnership`) before `RUNNING`; any doubt keeps `STARTING` with `recoveryBlocked`, and a later start refuses to spawn while a recoverable PID may exist. Stop: `adapter.signal(pid, ..., 'SIGTERM')`, wait up to 10 s polling `inspectProcess`, then `SIGKILL`, state `STOPPED` only when `alive === false`. `status` reconciles state against the process on every call. Errors: `REMOTE_RCON_UNSUPPORTED` and `REMOTE_B3_UNSUPPORTED` from a small `unsupported(id, feature)` guard used by the routes (Task 11).

- [ ] **Step 1: Failing tests** (loopback, fake core script): `start runs the core with the managed arguments and no secret arguments`, `start with a server.cfg that sets net_port to another instance is refused before any spawn`, `status after an external kill shows STOPPED (not RUNNING)`, `stop terminates only this instance's core; a sibling instance on the same host keeps running`, `connection lost during start: status is STARTING with recoveryBlocked and a second start does not spawn`, `restart keeps the port and gets a new PID and run ID`, `health reports ALIVE and getinfo SKIPPED when no tool is present`, `a core started as a different user is refused`, `three instances on one loopback host start in parallel and stop independently`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement the state store and the five operations.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(remote): start, stop, restart, status and health`.

### Task 10: Logs, config, backup, restore

**Files:** Modify `lib/remote-instance-manager.mjs`; create `test/remote-instance-files.test.mjs`.

**Consumes:** Tasks 6, 8, 9; `lib/runtime-secret-redaction.mjs` `redactRuntimeOutput`.
**Produces:**
- `logs(id, { limit = 65536 }): { stdout, stderr, stdoutTruncated, stderrTruncated, console: string }` from `adapter.readOutput` for the current run plus the tail of `main/qconsole.log` (bounded, valid UTF-8, redacted).
- `readConfig(id): { text, sha256, bytes }` and `writeConfig(id, { text, expectedSha256 }): { sha256, backupId }`: size limit 256 KiB, `validateManagedConfigText`, `expectedSha256` conflict check (`REMOTE_CONFIG_CONFLICT`), refused while the instance runs (`REMOTE_INSTANCE_RUNNING`), previous version kept as a backup first.
- `createBackup(id): { backupId, files: [{ name, sha256, bytes }] }` downloads `main/server.cfg` and the instance record into `<dataRoot>/remote-backups/<id>/<backupId>/` (0600, manifest with SHA-256); `listBackups(id)`; `restoreBackup(id, backupId)` verifies every hash, requires the instance to be stopped, validates the config again, uploads atomically (temp + rename). Scope is explicit: server.cfg and the record, not game data, logs or plugins.

- [ ] **Step 1: Failing tests:** `logs are bounded and valid UTF-8 for a 3 MiB and an invalid-UTF-8 file`, `logs redact a line containing rcon_password`, `config write with a stale hash conflicts and changes nothing`, `config with net_port of another instance is refused`, `config write while running is refused`, `backup then change then restore returns the original bytes`, `restore with a tampered backup file fails before any upload`, `restore while running is refused`, `a symlinked server.cfg on the server is refused`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(remote): logs, config, backup and restore`.

### Task 11: API, permissions, audit

**Files:** Modify `installer-server.mjs`, `lib/remote-gateway.mjs` (no change expected; a test pins that), create `test/remote-linux-http.test.mjs`.

**Consumes:** Tasks 4 to 10.
**Produces (all local-only, JSON, under `requirePermission`):** `GET/POST /api/remote-hosts` (`diagnostics.read` / `server.manage`), `POST /api/remote-hosts/:id/hostkey/probe` and `/hostkey/trust` (`server.manage`, body `{ expectedSha256 }`), `POST /api/remote-hosts/:id/credentials/ssh` and `.../remove` (`config.manage`, same `expectedSha256` vault protocol as the instance credential routes), `DELETE /api/remote-hosts/:id`; `GET/POST /api/remote-instances`, `GET /:id`, `POST /:id/install` (`install.execute`), `/update` (`update.execute`), `/start|stop|restart` (`server.manage`), `GET /:id/logs|health` (`diagnostics.read`), `GET/PUT /:id/config` and backup routes (`config.manage`). RCON, B3, plugin and master routes with a remote id answer 400 `REMOTE_RCON_UNSUPPORTED` / `REMOTE_B3_UNSUPPORTED`. Every operation audits `remote.instance.<operation>` with instance and host ids and the result code, never paths of keys, key material or log content. Add the new routes to the permission map (the `area` table near `installer-server.mjs:309`) so the existing permission-coverage check stays green.

- [ ] **Step 1: Failing tests:** `every new route is in the permission map and guarded`, `a viewer cannot call install/start/stop`, `no remote route is exposed through the phone gateway (REMOTE_ROUTES unchanged)`, `credentials routes never return the key`, `audit contains no key, passphrase or log text`, `RCON route for a remote id answers REMOTE_RCON_UNSUPPORTED`, `error bodies carry only the code`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Wire services and routes.
- [ ] **Step 4:** Run the new file plus `test/remote-http.test.mjs`, `test/runtime-http-integration.test.mjs` (as non-root): PASS.
- [ ] **Step 5:** Commit `feat(remote): API, permissions and audit`.

### Task 12: UI panel

**Files:** Create `lib/remote-hosts.jsx`, `test/remote-hosts.test.mjs`; modify `cod4x-control-improved.jsx` (new section "Remote Linux").

**Produces:** panel with host list and add form (no password field anywhere; one multi-line key field cleared after submit, same pattern as `instance-credential-editor.jsx`), host-key dialog that shows the SHA-256 in hex and in OpenSSH base64 form and a checkbox "I compared this fingerprint with the server" bound to the exact value (as the plugin approval does), remote instance list with Install/Start/Stop/Restart/Logs/Health/Config/Backup/Restore, German and English texts, visible "RCON and B3 are not available for remote servers yet".

- [ ] **Step 1: Failing tests** (render with esbuild like the other UI tests): `no password input and no key text is rendered`, `host-key dialog shows both fingerprint forms and the trust button stays disabled until the checkbox is set`, `a changed-key error renders a stop message and offers no trust button`, `RCON/B3 notice is present in German and English`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the new test and `test/instance-credential-editor.test.mjs`; `node -e` esbuild transform of `cod4x-control-improved.jsx`: PASS.
- [ ] **Step 5:** Commit `feat(remote): remote hosts panel`.

### Task 13: Gates and 4.18.23 housekeeping

**Files:** Create `scripts/verify-4.18.23-remote-linux-gate.mjs`, `scripts/verify-4.18.23-remote-linux-native.mjs`, `scripts/verify-4.18.23-version.mjs`, `scripts/verify-4.18.23-runtime.mjs`, `scripts/preflight-4.18.23.mjs`, `CHANGELOG-4.18.23.md`; modify `package.json`, `package-lock.json`, `BUILD_INFO.json`, `build.ps1` (keep CRLF; edit with `newline=''`), `cod4x-control-improved.jsx` (version strings), `README.md`, `DEVELOPMENT_STATUS.md`, `SECURITY.md` (remote section), `COD4X-CONTROL-ROADMAP*.md` marker.

- [ ] **Step 1:** Copy the 4.18.22 version, runtime and preflight scripts and bump (as done for 4.18.22); the gate reads the summary line in both TAP (`# pass N`) and spec (`ℹ pass N`) form.
- [ ] **Step 2:** Gate (`remote-linux-gate`, fake transport, runs everywhere): source wiring checks (ssh2 only imported in `lib/ssh-transport.mjs`; no `child_process` use in `lib/remote-*.mjs`; every remote command built by `lib/remote-commands.mjs`; all routes guarded; no gateway route), then `node --test` over the nine remote test files; requires the exact pass count.
- [ ] **Step 3:** Native gate (WSL or any Linux with `sshd`; skips cleanly without the env): env `REMOTE_TEST_HOST`, `REMOTE_TEST_USER`, `REMOTE_TEST_KEY`, `COD4X_CORE`, `COD4X_BASEGAME`. Steps and PASS lines: pin host key through the probe; Install; Start; the core answers on its port; Health shows `ALIVE` and getinfo `OK`; Logs contain output of this run; Stop; process gone; Restart; Backup, change config, Restore; deliberate errors (wrong core file, missing `main`, missing `zone`, port conflict, changed host key). Final line "Remote Linux Install -> Start -> Stop -> Logs PASS".
- [ ] **Step 4:** Run `node scripts/preflight-4.18.23.mjs` as a non-root user (root fails existing runtime tests by design) and the full suite; record real numbers in `DEVELOPMENT_STATUS.md` and the changelog, and mark the native gate "not run" until it was.
- [ ] **Step 5:** Commit `4.18.23: remote Linux over SSH (Roadmap Block 18)`, push, open a draft PR, subscribe, run `/code-review` on it.

### Task 14: Checklist file (after Block 18 is done)

**Files:** Create `docs/WSL-NATIVE-CHECKLIST.md`.

- [ ] **Step 1:** Write a Markdown checklist with checkboxes and a result column for Rafiki: prerequisites (WSL distro, non-root user, Node >= 22.12, `npm ci`, core and BaseGame paths, `sshd` for the remote gate, commands to generate a test key), then the runs: `scripts/verify-4.18.22-multi-server-native.mjs` (exact env and expected PASS lines for three cores), `scripts/verify-4.18.23-remote-linux-native.mjs` (expected PASS lines, the deliberate-error list), the full suite and `npm run preflight` with the numbers to record, what to paste back (the command output tail) and where to record results (`DEVELOPMENT_STATUS.md` lines to update). Include "what a failure means" per step and the manual items that remain open (phone test 4.18.16 to 4.18.19, hidden-chat check, custom B3 plugin command with a real client).
- [ ] **Step 2:** Commit `docs: WSL native test checklist`.

---

## Self-Review

- **Spec coverage:** Install/Update (T8), Start/Stop/Restart/Health (T9), Logs/Config/Backup/Restore (T10), credentials not in clear text (T4), host-key verification and no blind trust (T3, T4, T12), command injection (T1, T5), remote path validation (T1, T7), gate (T13), checklist request (T14). Roadmap items left out on purpose and stated: remote RCON, B3, master status, monitoring and phone gateway for remote instances.
- **Types:** `Host`, `RemoteSession`, `RemoteInstance`, `shellQuote`, `assertRemotePosixPath`, `parseProbe`, `createRemoteLinuxAdapter` are defined once and used with the same names in later tasks.
- **Largest risks (called out, each with a test or the native gate):** `/proc` over SFTP (T6 fallback to `head -c`), which shell construct yields the core's PID (T5/T9 identity check), `ssh2` as a new dependency (pure JS, install with `--ignore-scripts`, reviewed in the PR), root-run suite failures in this container (run as non-root).
- **Proportion:** 15 tasks for a feature that adds about 10 modules; bodies are not written out.

## Verification (whole plan)

`node scripts/preflight-4.18.23.mjs` and `node --test "test/*.test.mjs"` as a non-root user; CI on Ubuntu and Windows (Node 22 and 24) must be green; Windows CI runs the transport, store, safety and UI tests, the loopback tests skip there. The native remote gate and the 4.18.22 three-core gate stay manual and are tracked in `docs/WSL-NATIVE-CHECKLIST.md`.
