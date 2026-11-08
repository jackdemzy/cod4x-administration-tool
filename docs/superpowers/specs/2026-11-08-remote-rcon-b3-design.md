# Remote RCON, B3 database, monitoring and phone actions for SSH servers (Block 18b) – Design

Date: 2026-11-08. Version target: 4.18.24. Builds on Block 18 (4.18.23, remote Linux over SSH).

## Problem

Block 18 manages CoD4x servers on Linux machines over SSH (install, update, start, stop, restart, logs, health, config, backup, restore) but blocks RCON, the console, B3, monitoring and the phone gateway for them (`REMOTE_RCON_UNSUPPORTED`, `REMOTE_B3_UNSUPPORTED`). An operator who runs servers on a VPS still needs a second tool for daily administration.

Model: cod4-monitor 1.0.0 (https://github.com/FloMtz2312/cod4-monitor, Florian Martinez, AGPL-3.0). It administers remote servers through RCON and through B3's own database, and does not run B3 itself. Code adapted from it keeps its attribution header.

## Decisions (Rafiki, 2026-11-08)

1. **RCON path.** Over the existing SSH connection: one fixed command on the server (python3) sends the RCON packet to `127.0.0.1:<port>` and prints the reply datagrams. The packet, which contains the password, is written to the command's stdin and never appears in a command line. CONTROL sends no UDP itself; the server may keep its loopback binding.
2. **RCON password at start.** The remote core receives the password through a private file `main/rcon-<runId>.cfg` (mode 0600, written over SFTP, loaded with `+exec`), deleted as soon as the start is confirmed and swept on every later start, stop, recover and status check. The password is never a process argument.
3. **B3.** CONTROL does not start, stop or configure B3 on remote servers. B3 runs there as the operator set it up. CONTROL reads and writes B3's database: players, admins, groups, penalties, ban (optionally with an immediate kick through remote RCON), unban, lift a warning, set a group.
4. **B3 database access.** Directly over the network to MySQL/MariaDB (host, port, database, user, password) with the existing database helper. SQLite is not offered for remote servers (the file lies on another machine). Schema migration is not offered either (B3 owns the schema there): `REMOTE_B3_MIGRATE_UNSUPPORTED`.
5. **Monitoring and phone.** The monitoring dashboard lists remote servers (status through a `getstatus` probe run on the server over SSH). The phone gateway offers the same actions as for local servers (players, say, kick, restart) behind the existing step-up confirmation.

## Requirements

- The RCON password never appears in a remote command line, in `/proc/<pid>/cmdline` on the server, in audit entries, logs, state files or API results.
- Every command sent to a server is built in `lib/remote-commands.mjs`.
- The RCON command allowlist, kick reasons and say texts follow the existing local rules; nothing is allowed remotely that is not allowed locally.
- Remote and local instance ids share one pattern. Wherever both meet (credential vault, monitoring history, phone gateway) a remote id is written `rmt_<id>`; a local id can never contain `_`, so the two never collide.
- RCON replies are collected until 150 ms of silence, at most 1500 ms and 64 KiB, and parsed packet by packet.
- If python3 is missing on the server, RCON answers `REMOTE_RCON_TOOL_MISSING`; there is no bash fallback for packets that carry the password. The `getstatus` probe (no secret) may use bash `/dev/udp` or python3.
- Monitoring reuses one SSH connection per host (idle close after 60 s); an unreachable host marks its servers offline and never affects CONTROL itself.
- The B3 database helper has no TLS: the remote database form states in German and English that the password crosses the network in clear text unless a VPN/Tailscale tunnel is used. No silent fallback.
- Permissions mirror the local routes: RCON status `diagnostics.read`; commands, kick, say `server.manage`; B3 database settings `config.manage`; B3 admin reads `diagnostics.read`, writes `server.manage`.
- B3 runtime routes (start, stop, restart, logs, config, plugins, dependencies) keep answering `REMOTE_B3_UNSUPPORTED`.

## Out of scope

Running or installing B3 on the server, SQLite for remote B3, TLS for the database helper, direct UDP RCON from CONTROL, remote master-list verification.

## Review focus

1. python3 missing on the server.
2. A password file left behind after a crash or a lost connection during start.
3. SSH connection churn from monitoring every 15 s.
4. A local and a remote server with the same id at the same time.
5. Multi-packet or oversized RCON replies.
