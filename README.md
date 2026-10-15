## 4.18.3 Linux Runtime note

4.18.3 adds an unprivileged Linux adapter to the shared lifecycle API. Linux starts only `cod4x18_dedrun`, checks executable permissions and process ownership/birth identity, uses per-instance output files that survive backend restarts, and attempts SIGTERM before guarded SIGKILL. Each instance keeps its own `fs_homepath`; BaseGame remains separate and read-only. Managed local servers bind IPv4 and IPv6 to loopback.

Development source, not installer/release certification. Source preflight and real isolated Windows/Linux lifecycle gates are separate evidence. Run `npm run preflight`; Linux native tests require a non-root user and a C compiler. Full release packaging remains a later roadmap block.

### Block 6 development: Join protection and credential starts

Credential storage is not yet activation in the Dedicated Core. Until the private runtime handoff is integrated, instances requiring a Join password refuse start/restart with `CREDENTIAL_RUNTIME_NOT_READY`, before an existing process is stopped. Do not use real credentials for this unfinished integration.

The instance registry stores only a non-secret `credentialPolicy.join` (`none`, `required`, or legacy `unclassified`). New instances and clones start with `none`; clones do not inherit credentials. Existing registry entries without this field remain `unclassified`: initialize/unlock the credential vault for a one-time authoritative classification before starting them. An unavailable or locked vault cannot silently classify an old instance as public. A known-public instance can start locally with a locked vault; optional Master registration is not a local-start prerequisite.

Join updates deliberately fail closed across the registry/vault transaction boundary: mark `required` before storing the password, and clear it only after successful password removal. If a registry write fails after removal, retry removal with the latest vault snapshot to clear the conservative marker. A failed password write can likewise leave `required`; retry the change or explicitly remove it. Never edit the marker to bypass protection. External registry/vault replacement, crash durability and the real private runtime transfer require separate gates.

The internal Windows private-file channel now provisions a persistent, nonsecret read-only `main/q3config_server.cfg` guard before transferring a Join password. This prevents the tested Core's automatic archived-CVAR writer from leaving `g_password` in a normal configuration file; managed settings remain in schema-backed `server.cfg` instead of the Core-generated archive. An existing user archive, writable lookalike, unsafe ACL or hardlink blocks transfer without overwrite or automatic repair. The guard intentionally remains after the transfer/backend ends. Do not delete it to bypass a failure. This protects the known automatic archive target, not arbitrary privileged Core/plugin code or deliberate exports to other filenames. Normal Manager integration and backend-crash/recovery gates are still pending; the protected-start blockade remains in place.

The internal Windows lifecycle now also supports `outputPolicy: 'private'`: piped stdout/stderr bytes are discarded before decoding or persistence, and stream errors use a fixed diagnostic code. A persistent `consoleOutputPrivate` marker prevents status/list from opening historical qconsole.log, even after backend recreation or a later standard-output run. Invalid privacy checkpoints fail closed and hide console output during blocked recovery. This policy is a prerequisite, not yet automatic credential activation in the normal Manager start. It is not a general sanitizer for arbitrary arguments/history or a guarantee that the Core cannot write its own log files. No Linux private-output gate is claimed.

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
