# COD4X CONTROL 4.18.23

## Remote Linux over SSH (Roadmap Block 18)

Design: `docs/superpowers/specs/2026-11-07-remote-linux-ssh-design.md`, plan: `docs/superpowers/plans/2026-11-07-remote-linux-ssh.md`. A Windows CONTROL PC manages Linux game servers: Install, Update, Start, Stop, Restart, Logs, Health, Config, Backup, Restore. Gate text: "Remote Linux Install -> Start -> Stop -> Logs PASS".

### Decisions

- Transport is the `ssh2` library (pure JavaScript, installed with `--ignore-scripts`), not the system OpenSSH client: the key comes from the vault into memory and never touches a file.
- Agentless: SFTP plus a fixed list of commands (`lib/remote-commands.mjs`). Nothing is installed on the server.
- Health is process identity (`/proc`) plus a `getinfo` probe run on the server. RCON, console, kick, master status, B3, monitoring and the phone gateway are **not** available for remote servers; the routes answer `REMOTE_RCON_UNSUPPORTED` / `REMOTE_B3_UNSUPPORTED`.
- The base game is an existing path on the server (read only). Only the CoD4x Linux core (`cod4x18_dedrun`, versions 21.2 to 21.5) and the instance directory are uploaded.

### Security

- **Host key.** `hostHash: sha256` and an asynchronous `hostVerifier` run before authentication. An unpinned host never receives a login (`REMOTE_HOST_KEY_UNVERIFIED`), a changed key stops the connection (`REMOTE_HOST_KEY_CHANGED`, zero authentication attempts). Pinning needs the exact SHA-256 value the operator confirmed (`REMOTE_HOST_KEY_MISMATCH` otherwise); re-pinning another value is refused, the host has to be removed and added again. The panel shows hex and OpenSSH form and a checkbox bound to that value.
- **Credentials.** Key login only: no password, no agent, no keyboard-interactive (a test greps the source). The key is a vault credential of kind `ssh` under the subject `ssh_<hostId>` and exists only inside a runtime scope, as Buffers that are wiped afterwards. Routes never return it; audit, state files and error bodies carry codes only.
- **No root.** A host user `root` is refused when the host is saved, and an `id -u` of 0 is refused again at every connect (`REMOTE_ROOT_BLOCKED`).
- **Injection.** Every command comes from `lib/remote-commands.mjs`, built from fixed words and `shellQuote`d values; remote paths pass `assertRemotePosixPath`. The gate fails when a command is sent that does not come from a builder.
- **Install safety.** Everything checkable is checked before the network is used; the core is uploaded under a temporary name and its remote SHA-256 is verified; a failed install moves the new home to `<root>/.recovery` and never deletes; an existing home is never adopted. Update keeps `cod4x18_dedrun.previous` and rolls back.
- **Process control.** State is stored locally per instance (`STOPPED/STARTING/RUNNING/STOPPING/FAILED`, `recoveryBlocked`) and reconciled against the process identity (`ALIVE/GONE/NOT_OURS/UNKNOWN`, boot-id and start-ticks). A start whose PID is unknown stays recoverable and a retry never spawns a second core. Stop is TERM, then KILL, and is reported only when the process is gone.

### Plan deviations

- The vault subject is `ssh_<hostId>` instead of `host-<id>` (local instance IDs can never contain `_`, so the two cannot collide).
- `RemoteHostService.connect` returns `{ session, uid, gid }`.
- Hash and truncation failures of the upload use `REMOTE_UPLOAD_FAILED`.
- An unexpectedly vanished process becomes `FAILED(PROCESS_GONE)`, not `STOPPED`.
- Restore restores `server.cfg`; `instance.json` in the backup is a reference.
- `POST /api/remote-instances` is the install; `changeNetwork` was added (refused while the server is active).
- Limitation: the core file is chosen on the CONTROL PC (must be named `cod4x18_dedrun`, SHA-256 confirmed by the operator); CONTROL does not verify it against a publisher signature.

### Checks

- Tests (16 files, 152 tests): safety, host store, transport (in-process ssh2 server), credentials, host service, commands, runtime adapter, instance store, file transfer, base game, install, state, runtime, files, HTTP on the real backend, and the panel.
- Gate: `scripts/verify-4.18.23-remote-linux-gate.mjs` (14 source and behavior checks, then the test files above; a deliberate non-builder command was checked to fail it).
- Native check: `scripts/verify-4.18.23-remote-linux-native.mjs` (real sshd, real core; skips without `REMOTE_TEST_*`, `COD4X_CORE`, `COD4X_BASEGAME`). **Not run yet.** Open risk it must settle: reading `/proc/<pid>/*` over real SFTP (only emulated so far; fallback idea: a bounded `head -c` command).
- Preflight `scripts/preflight-4.18.23.mjs` runs the new gate and native check in addition to everything from 4.18.22.
- Result in a Linux container as a non-root user: preflight exit 0, full suite 679 tests: 672 PASS / 0 FAIL / 7 SKIP. Windows and WSL runs are outstanding.

### CodeQL findings on the first remote PR

Seven high alerts were reported on the merged first PR (path expression in `lib/remote-instance-manager.mjs`, buffer size, one test regexp). Handled in this change: the log tail clamps its buffer against the fixed maximum, the backup check validates the backup ID and opens only the two fixed file names (never a name from the manifest), the test regexp is case-insensitive. Not changed: `corePath` is a path the operator picks on the CONTROL PC by design (absolute, file name `cod4x18_dedrun`, no symlink, size limit, SHA-256 confirmed by the operator, permission `install.execute`); it stays visible as a code-scanning alert and is documented above as a trust limitation.

### Not done

Remote RCON/console/B3/master/monitoring/phone gateway (UDP does not travel through SSH), status polling connects per call (one connection per host in a list), password login, agents, Windows servers as targets.
