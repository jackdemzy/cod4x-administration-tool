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

Requirements: Node.js 20+ and network access to npm/GitHub/FPSChallenge.eu where required.

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

On Windows, install Node.js 20 or newer, then double-click `build.cmd`. The script checks the source, installs npm dependencies, runs the Vite production build, creates the Electron NSIS installer, and verifies that the expected EXE exists.

Equivalent PowerShell command:

```powershell
.\build.ps1
```

The generated installer is expected at `dist-installer\COD4X-CONTROL-Setup-3.0.2-x64.exe`.


## FIX8
CFG-Eingaben, `fs_game` und RCON-Port werden zentral validiert; Steuerzeichen und unsichere relative/absolute Mod-Pfade werden abgefangen.
