# Remote Linux over SSH (Roadmap Block 18, 4.18.23)

Status: design agreed in conversation with Rafiki on 2026-11-07; this document is the written spec. The implementation plan is `docs/superpowers/plans/2026-11-07-remote-linux-ssh.md`.

## Roadmap text (Block 18, copied)

> **Ziel:** Linux-Server können später von einem Windows-Control-PC aus verwaltet werden.
>
> **Architektur:** CONTROL -> SSH -> Linux Server
>
> **Funktionen:** Install, Update, Start, Stop, Restart, Logs, Health, Config, Backup, Restore
>
> **Sicherheitsanforderungen:**
> - SSH Credentials nicht im Klartext
> - Host-Key Verification
> - kein blindes Trust-on-first-use ohne Warnung
> - Command Injection verhindern
> - Remote Path Validation
>
> **Gate:** Remote Linux Install → Start → Stop → Logs PASS

The short roadmap adds: "Erst nach stabiler lokaler Windows- und Linux-Runtime."

## Decisions (Rafiki, 2026-11-07)

1. **Transport:** the `ssh2` library (pure JavaScript), not the system OpenSSH client. The private key comes from the credential vault into memory and is never written to a file. Checked against the `ssh2` documentation: `hostHash: 'sha256'` hands `hostVerifier` the key hash as a hex string, `hostVerifier` may answer asynchronously with `verify(true|false)`, and it runs before authentication.
2. **Model:** agentless. CONTROL uses SFTP and a fixed list of commands. Nothing is installed on the server.
3. **Health scope:** process identity (`/proc`) plus a `getinfo` probe run on the server itself. RCON console, kick, master status and B3 for remote instances are **not part of Block 18**; they are blocked with a named code (`REMOTE_RCON_UNSUPPORTED`, `REMOTE_B3_UNSUPPORTED`), not half supported. Reason: CoD4x RCON, `getinfo` and the master protocol are UDP, and SSH tunnels TCP only.
4. **BaseGame:** an existing path on the server, checked read-only. CONTROL uploads only the CoD4x Linux core and creates the instance directory. The core comes from a file on the CONTROL PC and is accepted only when its SHA-256 equals the value the operator confirms.

## Design

- **Reuse:** `createLinuxRuntimeAdapter` already takes `filesystem` and `hostProcess` as parameters. A remote `filesystem` (SFTP) and `hostProcess` (remote uid and gid, `kill` over a fixed command) give the same PID identity check, ownership check, bounded output and signal checks as the local Linux runtime. `validateManagedConfigText`, `normalizeNetwork` and `bindAddresses` are reused unchanged.
- **Separation:** remote servers have their own host store, instance store and manager. The local `ServerInstanceManager` is not changed, so local behavior cannot regress.
- **Host-key policy:** a host without a pinned key never receives credentials. The first contact only shows the SHA-256 fingerprint (hex and OpenSSH base64); the operator confirms that exact value. A key that differs from the pinned one is a hard stop (`REMOTE_HOST_KEY_CHANGED`). Changing a pinned key means removing and re-adding the host.
- **Credentials:** the SSH key is a vault record of the new kind `ssh`, valid only for the subject `host-<hostId>`. It is read inside a runtime credential scope and wiped afterwards. The connect user may not be `root`, and a remote uid of 0 is refused again at connect.
- **Command injection:** the only remote commands are built by `lib/remote-commands.mjs` from fixed words and values passed through `shellQuote`. No other module builds a remote command string. Inputs are validated before they reach a builder.
- **Remote paths:** absolute, normalized POSIX paths without `..`, control characters or `//`, and inside the instance root.
- **Not covered by Block 18:** remote RCON and B3, remote monitoring and the phone gateway, host-key rotation without re-adding, game data in backups (a backup holds `main/server.cfg` and the instance record).

## Global constraints

- Core file name is exactly `cod4x18_dedrun`; supported versions are 21.2, 21.3, 21.4, 21.5.
- Network default is loopback; public binding needs the same confirmation as local instances (`PUBLIC_EXPOSURE`).
- No secret in audit, logs, state files or API results. Error codes are `REMOTE_*` constants.
- Version 4.18.23; the 4.18.22 gates stay in the preflight chain.

## Review focus

1. The server key changes after pinning: connect stops before authentication, nothing is sent.
2. The SSH connection drops while a start is in flight: the state stays recoverable and a retry never spawns a second core.
3. Names with spaces, quotes, `;`, `$()`, backticks, newlines, `..` and non-ASCII in an instance ID, path, user or host are refused or inert.
4. Huge, binary or invalid UTF-8 log files give bounded, valid text.
5. A locked vault while connecting gives `VAULT_LOCKED`; there is no fallback prompt, agent or password.
6. A full disk or dropped connection during the core upload leaves no partial core, and a truncated file is caught by the hash check.

## Open risks (each has a test or the native gate)

- Reading `/proc/<pid>/*` through SFTP reports size 0; the plan has a probe test and a fallback to a bounded `head -c` command.
- Which shell construct gives the core's own PID (not a wrapper) is settled by the identity check and the native gate.
- `ssh2` is a new dependency (pure JavaScript, installed with `--ignore-scripts`).

## Gate

Remote Linux Install -> Start -> Stop -> Logs PASS. A fake-transport gate runs everywhere; the native gate needs a Linux host with `sshd`, a CoD4x core and a BaseGame and is run by Rafiki.
