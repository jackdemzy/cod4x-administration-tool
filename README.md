[cod4x-control-features.md](https://github.com/user-attachments/files/34454888/cod4x-control-features.md)
<img width="2800" height="1800" alt="admin-start" src="https://github.com/user-attachments/assets/6e96a099-ad43-4db0-8950-f600e1f0a4cf" /># COD4X CONTROL – Features

Version 4.18.19 · development source, not a release

- Desktop app for Windows and Linux<img width="2800" height="1800" alt="admin-start" src="https://github.com/user-attachments/assets/c74c6ae1-e86b-4524-92e8-53b1a2fac89b" />
<img width="2800" height="2742" alt="admin-monitoring" src="https://github.com/user-attachments/assets/9abcd216-7c2e-4969-b333-ee2812899904" />

- Install, configure, run and monitor CoD4x dedicated servers
- Backend local only (`127.0.0.1:8787`); optional remote gateway

## Servers

- **Version Manager**
  - CoD4x **server**: latest official release 21.2 (May 2022)
  - CoD4x **client**: latest release 21.8 (players only, not needed for the server)
  - Server profiles 21.3–21.5 selectable, but not official server releases
  - SHA-256 verified downloads
- **Promod builds and rulesets**
  - FPSChallenge.eu: FPS Promod 2.85 (plus 2.86, 3.00, 3.02 if configured)
  - eBc Promod (live-server ruleset)
  - Promod LIVE 2.20 / V2, or a custom build
  - Bot Warfare
- **Update check**
  - compares with the latest official server and client releases on GitHub
  - shows version, date and link
  - installs nothing automatically
  - FPSChallenge anti-cheat: optional auto-update setting
- **Instances**
  - own home folder, port, settings
  - base game separate, read-only
  - clone an instance
- **Runtime**
  - start / stop / restart
  - process verification, crash detection
- **Network**
  - local only by default
  - public only after explicit confirmation

## Configuration

- **Config Engine**
  - `server.cfg` from validated input
  - preview → diff → backup → apply → verify
  - every change restorable
- **Plugins**
  - load only with an approved hash
  - changed plugin blocks the start
- **Mods**: mod, anti-cheat, Bot Warfare

## Security

- **Vault**: encrypted RCON password, master token, B3 DB password
- **Roles**: admin, operator, viewer, monitor
- **Login**: lockout after repeated failures
- **2FA**: authenticator app (TOTP) plus recovery codes
- **Audit log**: user and result, never secrets

## RCON & Players

- Live console with a safe command set
- Live kick by slot, checked before and after

## Master Server

- Master token in the vault
- Registration status
- Listing check against the official server list

## B3 (Big Brother Bot)

- Start / stop / monitor per server
- Health checks, logs, root cause first
- MySQL/MariaDB setup with verified backup
- Players, admins, bans, warnings

## Monitoring & Remote

- **Monitoring**
  - status, map, players, latency, host load
  - outages with cause
  - 30-day history
  - no RCON password needed
- **Remote access**
  - phone and browser
  - off by default
  - Tailscale (recommended), LAN, or public domain via Caddy
- **Alerts**
  - server down / back up, low disk space
  - Discord and phone push
  - repeat brake
- **Remote actions**
  - chat message, kick, restart
  - fresh authenticator code per action

## Development

- 381 tests plus one gate per roadmap block (`npm run preflight`)
- CI on Windows and Linux
- License: AGPL-3.0-or-later

<img width="2800" height="2742" alt="admin-monitoring" src="https://github.com/user-attachments/assets/eef0c659-ad99-4b85-82c7-2eb1f800137b" />
## 4.18.19 Remote Actions note

4.18.19 implements roadmap Block 24d: from the phone app an admin or operator can send a chat message to all players, kick a listed player and restart a server. Off by default (gateway switch and a per-user switch); every action needs a fresh code from the authenticator app (a 5-minute window for message and kick, its own code for each restart, never a recovery code), with limits and a full audit. Works over Tailscale, LAN and the public Caddy domain. Setup: `docs/REMOTE-ACCESS.md`. Development source, not a release.

## 4.18.18 Alerts note

4.18.18 implements roadmap Block 24c: alerts when a server goes down or comes back, on low disk space and optionally when B3 stops or a player threshold is reached. Channels are a Discord webhook and Web Push to the phone app (RFC 8291/8292, no extra package); a repeat brake keeps it quiet. Optional mode for a public domain behind Caddy with a second factor for every role. Setup: `docs/REMOTE-ACCESS.md`. Development source, not a release.

## 4.18.17 Runtime Update note

4.18.17 moves to supported runtimes: Electron 45 (Electron 42 left support on 2026-10-20; the backend and the remote gateway run on Electron's own Node, now 24.22) and Node.js 22.12+ for building (Node 20 left support on 2026-04-30; recommended: 24 LTS). The remembered login uses Electron's asynchronous safeStorage API. Development source, not a release.

## 4.18.16 Remote Access note

4.18.16 implements roadmap Block 24b: the monitoring can be opened from a browser or a phone. A separate gateway (off by default) serves a mobile web app and only read-only monitoring routes; the admin API stays on loopback. The recommended mode is Tailscale: the gateway listens on 127.0.0.1 and `tailscale serve` adds HTTPS inside your own tailnet, without opening a port. Remote access is granted per user. Logins use a cookie session, a login brake (also for the local login) and, for admin and operator, a second factor (TOTP, RFC 6238) with recovery codes. Every page links the source code (AGPL-3.0). Setup: `docs/REMOTE-ACCESS.md`. Development source, not a release.

## 4.18.15 Monitoring note

4.18.15 implements roadmap Block 24a: read-only monitoring of all instances. Every 15 s CONTROL asks each running server with the unauthenticated CoD4x `getstatus` query (no RCON password) and records state, map, players and latency for 30 days. A server that stops answering is declared down after 45 s, so a map change is not an outage; a crash is reported at once, with the probable cause from the end of `qconsole.log`. The Monitoring tab shows server cards, host load, history (24h/7d/30d), availability and outages. The new role `monitor` can read monitoring and nothing else. The getstatus parser and crash diagnosis are adapted from cod4-monitor (AGPL-3.0, Florian Martinez). Remote access from browser and phone follows in Block 24b. Development source, not a release.

## 4.18.14 Live Kick note

4.18.14 implements roadmap Block 15b: a connected player can be kicked immediately. CONTROL lists the players from RCON `status` (addresses and ids masked unless `config.manage`) and offers Kick there, on B3 player rows that are online (B3 guid = CoD4x playerid) and as "ban and kick". Because CoD4x resolves kick handles as slots or partial names and also knows `kick all`, CONTROL only sends `clientkick <slot> [reason]` with a 0-63 slot through a separate, verified path: right before the kick the slot must still hold the expected player, and afterwards it must be free. The RCON console allowlist is unchanged. Native check against the real CoD4x 21.2 core with bots passed. Development source, not a release.

## 4.18.13 B3 In-Game Administration note

4.18.13 implements roadmap Block 15: per instance, CONTROL shows B3's players (search, paging, aliases and IP history), admins, penalties (Ban, TempBan, Permanent, Kick, Warning with active / expired / lifted status computed like B3) and the admin command list with minimum levels from `plugin_admin.ini`. Actions work on B3's own data model, so B3 stays the authority: add a Ban or TempBan and lift bans (applied by B3 on the next connect), lift warnings, and set a player's group (only with B3 stopped, because B3 writes the group of connected players back). All queries are named and parameter-bound inside the Python helper; viewers see masked IPs and GUIDs, full values need `config.manage`, actions need `server.manage`. Requires a MySQL database in state B3 Ready (Block 14). Live kick follows as Block 15b. Development source, not a release.

## 4.18.12 B3 Database note

4.18.12 implements roadmap Block 14: a per-instance B3 database wizard for MySQL/MariaDB with the flow test connection → schema check → backup → migration → B3 Ready. The schema is classified against the audited eBc-B3 `b3/sql/mysql/b3.sql` as EMPTY, PARTIAL, COMPLETE or OUTDATED. Before any change to a non-empty database CONTROL writes an SQL backup (structure + data, mode 0600) and verifies it (hash, header, per-table row counts); an unverifiable backup aborts the migration before any SQL runs. The core schema migration only creates missing tables; outdated schemas are blocked (no automatic `ALTER`). The eBc promod statistics schema (`b3-update-ebc.sql`, drops `player_core` and `prestige_log`) runs only as an explicit opt-in with the confirmation phrase `DROP player_core AND prestige_log`. Once the instance is B3 Ready, `b3.xml` uses the MySQL DSN.

Database access runs through a fixed helper started with the configured B3 interpreter and PyMySQL (`shell: false`, `-E`); the password is stored in the credential vault (kind `b3db`), reaches the helper only on stdin and never appears in logs, audit events or API responses. Failure cases are reported distinctly (`DB_UNREACHABLE`, `DB_AUTH_FAILED`, `DB_ACCESS_DENIED`, `DB_NOT_FOUND`, `SCHEMA_PARTIAL`, `SCHEMA_OUTDATED`, `BACKUP_FAILED`, `MIGRATION_FAILED`). Development source, not a release.

## 4.18.11 B3 Manager note

4.18.11 implements roadmap Block 13: a B3 manager dashboard per instance with status, version (eBc/B3 1.10.10 @ 9096624), parser, database and RCON, health checks for Python, B3, MySQL, parser, RCON and CoD4X, Start/Stop/Restart and redacted Logs and Config views. The diagnosis separates Python missing/incompatible, B3 missing/incompatible, dependency missing, CoD4X offline, database offline, parser offline and RCON offline and names the root cause first (a stopped server explains a failing RCON). Evidence comes from the dependency check, the B3 process, the instance server state and B3's own log (classified on the raw text, only codes are returned).

Native check in WSL with a real CoD4x 21.2 Linux core and real eBc-B3 passed. It also showed that B3's must-have `publist` plugin reports servers to bigbrotherbot.net unless `public_ip` is `127.0.0.1`, so CONTROL always writes `127.0.0.1` there. MySQL (Block 14) and the RCON password for B3 (Block 16) are still open. Development source, not a release.

## 4.18.10 B3 Runtime note

4.18.10 implements roadmap Block 12. Each instance can run eBc-B3 as its own process (`python2.7 -B -E b3_run.py --config <home>/b3/b3.xml`, detached, `shell:false`, without B3's own `-r` restart mode). CONTROL starts, stops and restarts it, verifies the PID (on Linux via `/proc` argv, owner and start time), detects crashes and lost processes, re-identifies a running B3 after a backend restart and reports health from B3's own log (ready marker, errors, RCON reachability). B3 and the CoD4x server never depend on each other: a B3 crash leaves the server running, a server stop or restart leaves B3 running. B3 only starts when the Block 11 dependency check is satisfied.

The first real start showed that the newest eBc-B3 commit `d44c05e` cannot start (NameError in `b3/config.py`); CONTROL therefore pins `9096624` and blocks `d44c05e` by hash. The native check `scripts/verify-4.18.10-b3-native.mjs` passed in WSL with Python 2.7.18 (SQLite, no CoD4x server). MySQL and the RCON password follow in Blocks 14/16. Development source, not a release.

## 4.18.9 eBc-B3 Audit note

4.18.9 implements roadmap Block 11. `docs/EBC-B3-AUDIT.md` documents a static audit of https://github.com/kristiandz/ebc-b3 at commit `d44c05e` (B3 1.10.10) including the dependency matrix. Key results: eBc-B3 runs only on Python 2.7; it needs python-dateutil and a MySQL driver (PyMySQL first); the shipped `b3.xml` uses the `cod4` parser and empty server settings; b3hide is driven by the `auth` ext plugin; `b3-update-ebc.sql` (eBc promod statistics) contains `DROP TABLE` and is never run automatically; the CoD4x 21.x `status` format against the `cod4x` parser can only be confirmed natively. CONTROL now stores the Python and B3 paths, probes the interpreter with a fixed isolated import check and inspects the B3 files statically. B3 itself is not started yet (Block 12).

Development source, not a release.

## 4.18.8 Plugin Manager note

4.18.8 implements roadmap Block 10. CONTROL discovers CoD4x plugins in each instance's `plugins/` folder (`.dll` on Windows, `.so` on Linux, as loaded by `loadPlugin` in `src/plugin_handler.c`), shows their SHA-256 and only trusts a file after the operator approves its hash or installs it from a local file. Enabled plugins are passed as `+loadPlugin <name>` (plus validated plugin dvars) before `server.cfg`; a changed or missing enabled plugin blocks the start before anything is spawned. Enable/disable, configuration, install and removal (archived, never deleted) require a stopped server and are audited. The runtime load state comes from the core's console messages, the version from the allowlisted RCON command `pluginInfo`. `b3hide` is catalogued with its dvars; B3 itself follows in Blocks 11-16.

No real plugin binary was loaded by a native core. Development source, not a release.

## 4.18.7 Master List Verification note

4.18.7 implements roadmap Block 9. Each instance stays bound to loopback by default; public binding (`net_ip 0.0.0.0`, `net_ip6 ::`) must be enabled explicitly per instance with a confirmation, only while stopped, and is never cloned. On request, CONTROL fetches the official list behind https://cod4master.cod4x.ovh/ (`serverstatus.json`) and checks whether the running instance is actually listed, by configured public address or by server identity on the instance port. It reports Registration / Heartbeat / Listed / Last seen (`HEARTBEAT_OK`, `HEARTBEAT_LOST`) and diagnoses not listed, wrong port, ambiguous, unreachable master and offline server. The local server never depends on the result.

Public binding also exposes RCON on the same UDP port. Real listing of a native core has not been tested. Development source, not a release.

## 4.18.6 Master Server note

4.18.6 adds the optional CoD4x master token (roadmap Block 8). A token stored in the credential vault is passed briefly to the Dedicated Core as `+set sv_authtoken` on the next start; without a token, or with a locked vault, the server starts and runs locally as before. The master state per run (`NOT_CONFIGURED`, `TOKEN_CONFIGURED`, `REGISTERING`, `REGISTERED`, `REGISTRATION_FAILED`, `UNKNOWN`) is derived from the exact console messages in CoD4x_Server `src/sv_main.c` and reported with fixed diagnosis codes, never log text or the token.

Important limit, verified in `SV_SendHeartbeatThread`: CoD4x sends no master heartbeat from 127.x addresses. Managed instances bind to loopback, so they report `LOOPBACK_BINDING` and cannot be listed. A public binding and the actual listing check (`HEARTBEAT_OK`/`HEARTBEAT_LOST`) belong to Block 9. Development source, not a release.

## 4.18.5 RCON note

4.18.5 implements per-instance RCON (roadmap Block 7) against `127.0.0.1:<instance.port>`, following the wire format of the official CoD4x_Server source (`src/sv_main.c`): `0xFFFFFFFF rcon <password> <command>`, multi-packet `print` responses, `Bad rcon` with a 100 ms deny rate limit, and `getinfo`/`infoResponse` as unauthenticated health probe. Only controlled commands are accepted: `status`, `serverinfo`, `systeminfo`, `map_rotate` and `map <mapname>`; everything else is rejected before the vault or the network is touched.

The RCON password is read only inside `InstanceCredentialService.withRuntimeCredentials` and handed to the Dedicated Core on start as `+set rcon_password` (the official startup mechanism, `Com_StartupVariable`). Values containing `+` are refused because CoD4x splits its command line at `+`. Secret CVARs are redacted from runtime history, persisted runtime state, process info and captured output. A locked vault starts the server without RCON instead of blocking it. Audit events `rcon.login`, `rcon.command` and `rcon.failure` carry instance, actor, normalized command and fixed codes, never the password. The instance view gains an integrated server console (live qconsole.log/runtime output, command history, Enter to send, filter, copy, clear, auto-scroll, warn/error highlighting, reconnect status, log export).

Gate "Live Output + RCON Command + Response + Reconnect + Audit" passes against a UDP test double of the core (`scripts/verify-4.18.5-rcon-gate.mjs`). RCON against a real `cod4x18_dedrun` is still open, as are Linux/WSL gates for this block. Known limitation: as a process argument the password is visible to local process inspection (Windows `Win32_Process.CommandLine`, Linux `/proc/<pid>/cmdline`). Development source, not a release.

## 4.18.4 Config Engine note

4.18.4 completes the schema-based Server Configuration Engine (roadmap Block 6). All ten configuration areas are declared: Identity, Network, Gameplay, Maps, Security and B3 logging are schema-managed; RCON and Master secrets stay in the credential vault; Mods and Plugins are explicitly not yet managed and remain rejected. Every change runs Preview -> Diff -> Backup -> Apply -> Verify, can be restored byte-identically and is audited as `config.change.applied` / `config.change.restored` with fingerprints and setting names only, never values. Each start records which configuration fingerprint the run uses, so CONTROL reports `ACTIVE`, `RESTART_REQUIRED`, `UNKNOWN` or `STOPPED`.

A vault self-lock (for example a conflict detected by a concurrent reader) now immediately aborts and wipes any active runtime credential scope. Credentials are still not passed to the Dedicated Core; that remains part of Blocks 7/8. Development source, not a release.

## 4.18.3 Linux Runtime note

4.18.3 adds an unprivileged Linux adapter to the shared lifecycle API. Linux starts only `cod4x18_dedrun`, checks executable permissions and process ownership/birth identity, uses per-instance output files that survive backend restarts, and attempts SIGTERM before guarded SIGKILL. Each instance keeps its own `fs_homepath`; BaseGame remains separate and read-only. Managed local servers bind IPv4 and IPv6 to loopback.

Development source, not installer/release certification. Source preflight and real isolated Windows/Linux lifecycle gates are separate evidence. Run `npm run preflight`; Linux native tests require a non-root user and a C compiler. Full release packaging remains a later roadmap block.

## 4.18.2 Windows Runtime note

4.18.2 adds bounded stdout/stderr capture, post-spawn PID and executable-path verification, and a controlled Windows stop path that requires the process to disappear before `STOPPED` is recorded. Windows exclusively starts `cod4x18_dedrun.exe`; `iw3mp.exe` remains a client/BaseGame executable, never a Dedicated Server. The configured server directory remains the per-instance `fs_homepath`.

## 4.18.1 Runtime note

4.18.1 fixes the Dedicated-Core verification path contract, persists the selected CoD4x runtime version, binds discovered cores to their platform, and adds runtime regression checks.

## 4.18.0 Runtime note

CoD4X CONTROL 4.18.0 introduces an explicit Dedicated Server Core model. The Windows server core is `cod4x18_dedrun.exe`; the Linux server core is `cod4x18_dedrun`. The client executable `iw3mp.exe` is not accepted as a Dedicated Server Core. CoD4X `fs_basepath`/`fs_homepath` remain separated for server data and game assets.

# COD4X CONTROL 3.0.2 RC1 — Windows Desktop Build

A native Electron desktop shell around the COD4X CONTROL React UI and the local installer API.

## Included

- CoD4x profiles 21.2–21.5
- FPS Promod profiles
- FPSChallenge.eu FPSAC profile
- CoD4x anti-cheat settings profile
- RusCOD anti-cheat profile
- Bot Warfare
- release availability endpoint
- SHA-256 verification where a digest is published/configured
- path-traversal protection
- dry-run installation
- local-only backend binding (`127.0.0.1`)
- Windows NSIS installer configuration
- desktop + Start Menu shortcuts
- optional installation directory
- clean uninstall with application data removal

## Build on Windows

Requirements: Node.js 22.12+ (recommended: 24 LTS) and network access to npm/GitHub/FPSChallenge.eu where required.

Double-click `build.cmd` or run:

```powershell
npm install
npm run dist:win
```

Output:

```text
dist-installer/COD4X-CONTROL-Setup-3.0.2-x64.exe
```

## Important

The build does not embed or invent game binaries. Release artifacts are resolved from configured/trusted sources and verified where SHA-256 is available. The FPSChallenge and RusCOD anti-cheat profiles refuse unverified third-party binaries by default.


## IW4MAdmin / RaidMax integration — 2.3.0

The former generic "RAID Server Admin Tool" adapter is replaced by the verified
**IW4MAdmin (RaidMax)** integration.

GitHub:
https://github.com/RaidMax/IW4M-Admin

COD4X CONTROL exposes IW4MAdmin as a first-class server administration profile
and records the CoD4x parser selection. It does not bundle or modify the
third-party IW4MAdmin binaries. Endpoint validation is configuration-only and
does not transmit API keys.

Capabilities intended for the integration include RCON/server administration,
player management, bans, plugins, logs and the IW4MAdmin web administration
layer. Exact runtime capabilities remain those provided by the installed
IW4MAdmin release.


## 2.4.0 — Control Center modules

Added a modular server dashboard, live-console UI, player-manager shell,
provider registry, safe RCON command validation, and backup/recovery API.

The RCON validation endpoint deliberately uses an allowlist and does not execute
arbitrary commands. Backup operations copy only selected server directories/files.
IW4MAdmin remains a third-party application and is referenced as the verified
RaidMax integration:
https://github.com/RaidMax/IW4M-Admin


## 2.5.0 — eBc Promod Server Provider

Added a first-class eBc Promod provider.

Verified GitHub sources:
- eBc Promod: https://github.com/kristiandz/ebc-pm
- CoD4x Server: https://github.com/callofduty4x/CoD4x_Server
- Promod source: https://github.com/cod4mw/promod

The eBc repository states that its code is ready for live CoD4/CoD4X servers
and lists the required server/mod assets. COD4X CONTROL therefore treats eBc
Promod as a server-profile/provider with compatibility metadata and an install
manifest. It does not silently download or redistribute third-party binaries.


## 2.6.0 — Server lifecycle

Added server preflight validation and backup/recovery controls. Validation is
deliberately conservative: filesystem checks are real, while RCON connectivity
is marked MANUAL until a configured server endpoint is available. No fake
online state or fake RCON result is generated.


## 2.7.0 — FPSChallenge provider

FPSChallenge is now a first-class server/profile selection.

Important: the current GitHub search did not produce a verified official
FPSChallenge repository. The provider therefore points to the public
FPSChallenge website and is explicitly marked `external-source`; no fabricated
GitHub URL is used.

Verified GitHub sources for adjacent components:
- CoD4x Server: https://github.com/callofduty4x/CoD4x_Server
- Promod: https://github.com/cod4mw/promod
- eBc Promod: https://github.com/kristiandz/ebc-pm


## 2.8.0 — FPSChallenge Download Manager

FPSChallenge is now backed by the official download-server directory:
https://dl.fpschallenge.eu/cod4/mods/

The application can query the directory listing at runtime and populate the
available FPS Promod versions/variants instead of hard-coding the version list.
Current indexed examples include fps_promod_284, 285, 285_bots, 286, 300 and
302. The catalog records the exact directory URL for each discovered version.

No assumption is made that every listed version is compatible with every CoD4x
release; compatibility remains a separate validation step.


## 2.9.0 — Compatibility Matrix

Added a compatibility-check layer for CoD4x 21.2–21.5, Promod providers and
FPSChallenge selections.

Important: the official CoD4x GitHub release page currently verifies a 21.2
release, while the requested 21.3–21.5 entries were not independently verified
there in this build pass. They therefore remain selectable but are reported as
runtime-test/unknown rather than falsely marked compatible.

eBc Promod's repository explicitly states CoD4/CoD4X live-server readiness.
FPSChallenge versions are sourced dynamically from its official download server.


## 3.0.0 — UI + FPSChallenge AC + RCON

The UI is now split into focused tabs instead of presenting every module at
once. The palette is intentionally light and restrained.

Added:
- FPSChallenge Anti-Cheat selector
- dynamic FPSAC version catalog from dl.fpschallenge.eu/anticheat/
- FPSAC download routing
- server-side UDP RCON execution
- RCON command allowlist
- RCON password is not written to logs


## 3.0.1 — RC1 technical fixes

- Fixed undefined Anti-Cheat state references in the React UI.
- Fixed missing I18N separators that prevented parsing.
- Added the missing Vite/React entry point and Windows packaging scripts.
- Added FPS Promod 2.86/3.00/3.02 configuration slots.
- Installer artifacts now retain an extension so ZIP/TAR extraction works.
- Installer manifest records the selected anti-cheat profile safely.
- Added release/anti-cheat catalog endpoints without inventing download URLs.
- FPSAC download routing requires an operator-configured verified URL.


## 3.0.2 — RC1 audit fixes

- Added the missing `/api/fpschallenge/catalog` endpoint used by the Version Manager.
- Normalized release availability objects so the UI and backend use the same `available` field.
- Installer logs no longer echo configured artifact URLs.
- Windows build script uses `npm install` because this source package does not ship a package-lock.json.
- No third-party game or anti-cheat binaries are embedded in the source archive.


## One-command Windows build

On Windows, install Node.js 22.12 or newer (recommended: 24 LTS), then double-click `build.cmd`. The script checks the source, installs npm dependencies, runs the Vite production build, creates the Electron NSIS installer, and verifies that the expected EXE exists.

Equivalent PowerShell command:

```powershell
.\build.ps1
```

The generated installer is expected at `dist-installer\COD4X-CONTROL-Setup-3.0.2-x64.exe`.


## FIX8
CFG-Eingaben, `fs_game` und RCON-Port werden zentral validiert; Steuerzeichen und unsichere relative/absolute Mod-Pfade werden abgefangen.

## Lizenz

COD4X CONTROL ist freie Software unter der [GNU Affero General Public License, Version 3 oder später](LICENSE) (SPDX `AGPL-3.0-or-later`). Copyright © 2026 jackdemzy.

Kurz gefasst: Nutzen, Ändern und Weitergeben ist erlaubt, solange geänderte Versionen unter derselben Lizenz mit Quellcode weitergegeben werden. Wer eine geänderte Version über ein Netzwerk für andere bereitstellt (zum Beispiel einen Fernzugriff per Browser), muss diesen Nutzern den Quellcode anbieten (§ 13). Verbindlich ist allein der Lizenztext in `LICENSE`.

Die npm-Abhängigkeiten stehen unter eigenen, mit der AGPL vereinbaren Lizenzen (MIT, ISC, BSD-3-Clause, BlueOak-1.0.0). CoD4X, eBc-B3, Mods und Spieldaten werden nicht mitgeliefert und behalten ihre eigenen Lizenzen.
