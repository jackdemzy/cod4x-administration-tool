# Security audit 4.18.26 (Roadmap Block 20)

Design, threat model (attackers A1 to A7) and severity scale: [`docs/superpowers/specs/2026-11-11-security-audit-design.md`](superpowers/specs/2026-11-11-security-audit-design.md). Plan: [`docs/superpowers/plans/2026-11-11-security-audit.md`](superpowers/plans/2026-11-11-security-audit.md).

Each area was read by its own independent reviewer. Every finding was then confirmed by a test that reproduced it, or rejected with a reason. Critical, High and Medium findings are fixed; Low findings are tracked as GitHub issues, one per area (#40 to #45). `scripts/verify-4.18.26-security-gate.mjs` reads this file: it fails while an area is not reviewed or a Critical, High or Medium finding is open, and it re-runs every regression test named below.

## Area 1 – Local runtime

Reviewed: yes

Reviewer: independent, read-only (2026-11-11). Two High findings, both reproduced by a failing test and fixed; the Medium candidate (A1-3) was regraded to Low because the core start already refuses root and archives come only from SHA-256-pinned sources; five more Low findings tracked as issues. Decision by the owner (2026-11-11): only an administrator may bring code; the operator still starts, stops and configures.

Checked without a finding: Verified-Core gate on every start path (hash of the selected executable against the pinned manifest); Linux core without setuid/setgid and not a symlink; Linux core start refused as root; process identity on Linux (uid, gid, birth time, `fs_homepath`, `net_port`) before any signal; `fs_basepath`/`fs_homepath` overrides refused (now also for `+SET`, `+seta`, `+sets`); path traversal in installer targets (`assertSafeChildPath` for zip and tar entries); artifact SHA-256 pins and `redirect: "error"` downloads; runtime output redaction and bounded logs; core child environment.

## Area 2 – Secrets

Reviewed: yes

Reviewer: independent, read-only (2026-11-11). One High and one Medium finding, both reproduced by a failing test and fixed; three Low findings tracked as issues (a fourth was the same as A5-6).

Checked without a finding: master token (vault form check, only ids and codes in audit and API, hash only for verification); RCON password (packet buffer wiped after sending, remote only over stdin, blocked commands audited by name only, responses filtered); B3 database password (vault check, `b3.xml` 0600 with `wx`, B3 command line holds only the config path, reduced environment, redacted for the UI); SSH key (vault subject, passed to ssh2 as a buffer, no temp file or `ssh` binary, request body fields deleted after the route, fixed error codes); Discord webhook (0600 file, masked in API and audit, no redirects); VAPID private key (only in `alerts.json` 0600); TOTP secrets (`users.json` 0600, never audited, recovery codes as scrypt hashes); session tokens (memory only, list shows ids); vault crypto (scrypt N=2^17 r=8 p=1, 32-byte salt, AES-256-GCM with a random 96-bit nonce per seal, AAD binds version and KDF, plaintext only after `final()`, buffers wiped, directory 0700, files 0600 with `wx`, owner/mode/symlink/nlink checks); secrets in error messages; remote output redaction and limits; environment and temp files.

## Area 3 – B3

Reviewed: yes

Reviewer: independent, read-only (2026-11-11), checked against the eBc-B3 source. Two High and three Medium findings, all reproduced by a failing test and fixed; three Low findings tracked as issues. Following the owner's decision for area 1, choosing the Python interpreter or the B3 folder and trusting changed plugin code now need admin.

Checked without a finding: Python process isolation (`shell: false`, `-E -B`, minimal environment, fresh temporary `cwd` for probe and helper, root refused on Linux, PID identity before any signal, secrets to the helper only over stdin); database credentials (password bound to host, port and user; DSN only in `b3.xml` 0600; redacted for the UI and in log lines; bound parameters; only audited SQL with pinned hashes); config injection into `b3.xml` and `plugin_auth.ini` (XML escaping, `g_log` pattern, character rules for `!auth` and database passwords, plugin name pattern); plugin files (every file directly in its folder, symlinks refused, NUL/UTF-8/size checks, custom code behind `b3.plugins.code`); CSRF on B3 routes (global Origin guard); permissions of the other B3 routes; secrets in errors and the audit; `!auth` redaction in logs.

## Area 4 – Remote Linux

Reviewed: yes

Reviewer: independent, read-only (2026-11-11). Two Medium findings (denial of service by a compromised host), both reproduced by a failing test and fixed; five Low findings tracked as issues. The inherited missing Recover button has no security effect: a blocked state refuses start, stop and switch, and `POST /api/remote-instances/:id/recover` exists.

Checked without a finding: shell injection (every command builder quotes or uses fixed patterns, RCON password and Dockerfile over stdin); path traversal on the host (`assertRemotePosixPath`, homes derived from ids); symlinks and hard links on the host (`lstat`, `nlink`, dev/ino, `wx` uploads); host key pinning and first contact (no login before the pin, pin never overwritten, vault binds it to `createdAt`); a compromised host reaching code or secrets on CONTROL (no local `child_process` with remote data, strict parsers, `exec` bounded and timed, private key never leaves CONTROL); isolation between hosts and instances; remote output only after redaction and limits; secrets in errors; Docker hardening (`--read-only`, `--cap-drop ALL`, `no-new-privileges`, pinned image digest, label checks); Docker confirmation per host; route permissions; root refused (`validRemoteUser`, uid 0); ownership and modes on the host; local core import; RCON over SSH.

## Area 5 – Remote access and admin API

Reviewed: yes

Reviewer: independent, read-only (2026-11-11). Four Medium findings, all reproduced by a failing test and fixed; four Low findings tracked as issues.

Checked without a finding: gateway authentication (dummy hash for unknown users, `disabled` and `remoteAccess` checked, TOTP required for admin/operator and for everyone in proxy mode); TOTP (RFC 6238, ±1 step, replay refused, constant-time compare, recovery codes only as scrypt hashes and never valid for actions); gateway sessions (random token kept only as SHA-256, new token per login, cookie `HttpOnly; Secure; SameSite=Strict; Path=/remote`, idle and absolute expiry, revocation on every narrowing change); local sessions (32-byte random token, header only); CSRF on the gateway (same-origin or matching Origin plus JSON on every POST, no state-changing GET); CSRF on 8787 for every route that needs the bearer token; authorisation of every route in `installer-server.mjs`, `lib/remote-linux-routes.mjs`, `REMOTE_LINUX_BINDINGS` and `lib/b3-plugin-routes.mjs`; what the gateway exposes to the phone (fixed route list, 2 kB body limit, fixed error codes, actions behind `server.manage`, second factor and both switches); gateway listener (plain HTTP only on loopback, TLS 1.2+, Tailscale headers only from loopback and never in proxy mode); `lib/remote-app.jsx` (no raw HTML sinks, no token in storage).

## Area 6 – Electron and dependencies

Reviewed: yes

Reviewer: independent, read-only (2026-11-11). One Medium finding, reproduced by a failing test and fixed; four Low findings tracked as issues. `npm audit --omit=dev`: 0 vulnerabilities.

Checked without a finding: renderer isolation (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity` and `webviewTag` at their safe defaults, no `<webview>` or `<iframe>`); preload surface (five fixed channels, no raw `ipcRenderer`); protocol and file handling (`loadFile` of the built page, no custom protocol, no `openPath`); no auto-updater and no runtime download in the app; backend spawn (fixed script, token through the environment and removed from it by the backend); production dependencies (`npm audit --omit=dev`).

## Findings

| ID | Title | Attacker | Grade | Status | Evidence |
|----|-------|----------|-------|--------|----------|
| A1-1 | An operator (`server.manage`) could make CONTROL run code of their choice: any executable as core (config, adopt, new instance, clone), plugins from any folder, free start arguments such as `+loadPlugin` | A2 | High | fixed | `test/security-runtime-code.test.mjs` |
| A1-2 | A manifest file next to the core counted as proof of a verified core, and a Linux core or its folder could be writable by other users (swap after the hash check); group write is accepted only for the user's private group (umask 002) | A4 | High | fixed | `test/security-runtime-code.test.mjs` |
| A1-3 | CONTROL itself is not refused as root/administrator; tar extraction as root keeps owners and setuid bits | A4 | Low | issue #40 |  |
| A1-4 | Windows legacy runtime checks the PID without its creation time before stopping | A4 | Low | issue #40 |  |
| A1-5 | Linux stop: race between the identity check and the signal (PID reuse) | A4 | Low | issue #40 |  |
| A1-6 | Zip extraction follows symlinks already in the target and has no size limit | A5 | Low | issue #40 |  |
| A1-7 | Artifact downloads allow `http:` (the SHA-256 pin still protects the content) and mod archives may overwrite core files in the target | A5 | Low | issue #40 |  |
| A2-1 | RCON password and master token in the local core's command line, readable by every local user on Linux (`/proc/<pid>/cmdline`) | A4 | High | fixed | `test/security-local-launch-secrets.test.mjs` |
| A2-2 | Instance homes 0755 and the B3 game log 0644: typed `!auth` passwords readable by local users who can reach the data folder | A4 | Medium | fixed | `test/security-instance-permissions.test.mjs` |
| A2-3 | `audit.ndjson` is created 0644 and only then set to 0600; the audit folder is created without a mode | A4 | Low | issue #41 |  |
| A2-4 | An unlocked vault stays unlocked until someone locks it (no idle lock) | A4 | Low | issue #41 |  |
| A2-5 | Vault backups `backup-<uuid>.json` are never pruned | A4 | Low | issue #41 |  |
| A3-1 | An operator (`config.manage`) chose the Python interpreter and the B3 folder, which CONTROL runs and hands the RCON and database passwords | A2 | High | fixed | `test/security-b3.test.mjs` |
| A3-2 | A plugin setting (chat log, status file, ban list) could point B3 at any file, e.g. a shell start file that then receives player chat (also through ConfigParser `%(option)s` interpolation, found by `/security-review`, and through an XML entity, found by the final review) | A2 | High | fixed | `test/security-b3.test.mjs` |
| A3-3 | An operator could trust plugin code that differs from the catalog | A2 | Medium | fixed | `test/security-b3.test.mjs` |
| A3-4 | The B3 log showed full player IPs and GUIDs to read-only roles | A2 | Medium | fixed | `test/security-b3.test.mjs` |
| A3-5 | Python and the B3 folders could be writable by other local users (code runs as the CONTROL user with the RCON and database passwords) | A4 | Medium | fixed | `test/security-b3.test.mjs` |
| A3-6 | Plugin XML may contain a DOCTYPE with an internal subset (entity expansion can hang B3) | A2 | Low | fixed | `test/security-b3.test.mjs` |
| A3-7 | With the `pluginmanager` plugin, a B3 admin can load modules in game that CONTROL never hashed | A2 | Low | issue #42 |  |
| A3-8 | `POST /api/instances/:id/b3/integration/auth-password` is not covered by the credential guard (`no-store`) | A2 | Low | issue #42 |  |
| A4-1 | A compromised host could exhaust CONTROL's memory with a directory listing that never ends (SFTP `readdir` without a limit) | A6 | Medium | fixed | `test/security-remote-host.test.mjs` |
| A4-2 | SFTP requests had no timeout: a host that never answers held the remote overview for every host, leaked sessions and kept the instance busy | A6 | Medium | fixed | `test/security-remote-host.test.mjs` |
| A4-3 | `status()`, `statusAll()` and `health()` write the remote state outside the lock; `health()` ignores the busy flag | A2 | Low | issue #43 |  |
| A4-4 | The remote root is not checked for owner or group/world write access | A6 | Low | issue #43 |  |
| A4-5 | `hostname` and `map` from the host's getinfo reply reach the UI without a length limit or control-character filter | A6 | Low | issue #43 |  |
| A4-6 | The SSH session pool keeps a logged-in session up to 60 s after the vault is locked or the key removed | A4 | Low | issue #43 |  |
| A4-7 | Docker mounts are made by the daemon as root (parent traversal checks do not apply) and the container has no CPU limit | A2 | Low | issue #43 |  |
| A5-1 | A hostile web page could create the first administrator before setup (CORS `*`, no Origin check on `/api/auth/init`) | A3 | Medium | fixed | `test/security-admin-api.test.mjs` |
| A5-2 | A hostile web page could lock the local login and learn whether a user is disabled | A3 | Medium | fixed | `test/security-admin-api.test.mjs` |
| A5-3 | Login brake bypass: X-Forwarded-For from a local caller at the gateway, rotating 127.x source addresses on 8787 | A4 | Medium | fixed | `test/remote.test.mjs`, `test/security-admin-api.test.mjs` |
| A5-4 | A disabled user kept local admin API sessions for up to 12 hours | A2 | Medium | fixed | `test/security-admin-api.test.mjs` |
| A5-5 | Read-only roles (`audit.read`) can rotate the audit log and write test entries; rotated files never match the retention pattern | A2 | Low | issue #44 |  |
| A5-6 | `/api/remote-instances/:id/credentials` is not covered by the credential guard (local-only, `no-store`, fixed JSON parse error) | A2 | Low | issue #44 |  |
| A5-7 | Failed step-up codes on the gateway are not throttled | A2 | Low | issue #44 |  |
| A5-8 | The `secrets.manage` permission is shown but no route requires it; vault and credential routes use `config.manage` | A2 | Low | issue #44 |  |
| A6-1 | A link opened a new Electron window that could browse anywhere; the desktop header (A5-1) went with requests from any window or frame, so a hostile page there passed the backend's Origin check (and the IPC handlers did not check the sender) | A3 | Medium | fixed | `test/security-electron.test.mjs` |
| A6-2 | No Content-Security-Policy in `index.html` | A3 | Low | issue #45 |  |
| A6-3 | No permission request handler: Electron grants web permissions by default | A3 | Low | issue #45 |  |
| A6-4 | `remembered-login.json` is written with the default file mode; on Linux without a keyring safeStorage falls back to weak protection | A4 | Low | issue #45 |  |
| A6-5 | `docs/SECURITY-ADVISORIES.md` does not list the production dependency `ssh2` | A5 | Low | issue #45 |  |

## Rejected findings

- **Area 5, login throttle eviction at 10 000 entries:** an attacker would need more than 10 000 distinct client keys; after A5-3 all loopback callers share one key and the gateway adds a per-user brake. No path for A1 to A7.
- **Area 5, order of checks in `PATCH /api/users/:username`:** the route is admin-only (`user.manage`); the order changes no outcome for any other role.
- **Final review, Host header:** a DNS-rebound page can make same-origin GET requests without an Origin header. Every such route that returns or changes anything needs the bearer token, which the page cannot obtain; only the unauthenticated health and catalogue routes answer. No Host allowlist was added.
- **Final review, dev origins `localhost:5173`:** a local process on port 5173 gets a CORS grant, but every sensitive route still needs the bearer token. Kept for the development workflow.

## Native checks

- **A2-1, launch file:** start a local instance with RCON password and master token on Windows and on Linux with the real CoD4x core. The console must show `execing launch-<id>.cfg`, RCON must work, the master server must accept the token, `main/` must hold no `launch-*.cfg` afterwards, and on Linux `cat /proc/<pid>/cmdline` must show neither secret. If the core does not print `execing` within 15 seconds, CONTROL deletes the file anyway and RCON stays without a password for that run.

- **A3-5, Windows:** the writability check for Python and the B3 folders covers POSIX only. On Windows, install Python 2.7 and B3 in a folder only administrators can write to (not directly under `C:\`, where Authenticated Users may modify new subfolders), and check with `icacls` that no group other than Administrators, SYSTEM and the CONTROL user has write access.

- **A6-1, desktop app:** on Windows, click "GitHub Release ↗" in the Update Manager: it must open in the system browser, not in a CONTROL window. The otpauth link and other links must not navigate the main window away. Login, RCON console and saving a config must still work (every request of the app page must carry the desktop header; requests without a frame lose it).

- **A5-1, desktop app:** start the Electron app on Windows, create the administrator on a fresh data folder, log in, open the RCON console and save a config. Every request must succeed; the backend now refuses `Origin: null` without the per-launch `X-COD4X-Desktop` header that `electron-main.cjs` adds. The cloud tests cover the backend side only.
