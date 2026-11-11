# Changelog 4.18.26 – Security audit (Roadmap Block 20)

Six areas (local runtime, secrets, B3, remote Linux, remote access and admin API, Electron and dependencies) were each read by an independent reviewer. Every finding was reproduced by a test that failed before the fix. Full report: `docs/SECURITY-AUDIT-4.18.26.md`. Design and plan: `docs/superpowers/specs/2026-11-11-security-audit-design.md`, `docs/superpowers/plans/2026-11-11-security-audit.md`.

## Fixed (High)

- **A1-1** An operator could make CONTROL run code of their choice: any executable as core, plugins from any folder, free start arguments such as `+loadPlugin`.
- **A1-2** A manifest file next to the core counted as proof of a verified core; a Linux core or its folder could be writable by other users.
- **A2-1** The RCON password and the master token were in the local core's command line, readable by every local user on Linux. They now reach the core through a private launch file read with `+exec` and deleted right after.
- **A3-1** An operator chose the Python interpreter and the B3 folder, which CONTROL runs with the RCON and database passwords.
- **A3-2** A B3 plugin setting (chat log, status file, ban list) could point B3 at any file, for example a shell start file that then receives player chat.

## Fixed (Medium)

- **A2-2** Instance homes were 0755 and the B3 game log 0644 (typed `!auth` passwords readable by local users); homes are now 0700 and tightened on start, the game log 0600.
- **A3-3** An operator could trust plugin code that differs from the catalog.
- **A3-4** The B3 log showed full player IPs and GUIDs to read-only roles.
- **A3-5** Python and the B3 folders may no longer be writable by other users (POSIX; Windows is a native check).
- **A4-1** A compromised SSH host could exhaust CONTROL's memory with a directory listing that never ends.
- **A4-2** SFTP requests had no timeout; a silent host held the remote overview for every host.
- **A5-1** A hostile web page could create the first administrator before setup (CORS `*`, no Origin check).
- **A5-2** A hostile web page could lock the local login and learn whether a user is disabled.
- **A5-3** The login brake could be bypassed with X-Forwarded-For at the gateway or rotating 127.x addresses on 8787.
- **A5-4** A disabled user kept local admin API sessions for up to 12 hours.
- **A6-1** A link opened an Electron window that could browse anywhere, and the desktop header went with requests from any window or frame.

## What administrators notice

- **New admin-only permission `server.code` ("Server-Programmcode").** Only an administrator may choose or adopt a server core (`/api/runtime/config`, `/api/runtime/adopt`), create an instance (it picks a core), clone with another core, install or approve CoD4x plugins, start or restart the legacy runtime with an executable path or extra arguments, and set the B3 Python interpreter and B3 folder. Approving a changed shipped B3 plugin needs `b3.plugins.code` (admin). Operators still start, stop, restart, configure and clone with the same core; buttons for the moved actions answer 403 for them (the B3 approve button is hidden).
- **Cores verified only by `cod4x-control-manifest.json`** (a file next to the core) are no longer verified. An administrator adopts such a core once again; the registry in the data folder is the only proof.
- **Linux cores and B3/Python folders** that other users can write to (world write, group write by a group other than the user's own private group, or owned by another non-root user) are refused with `RUNTIME_EXECUTABLE_BLOCKED` or `B3_PATH_WRITABLE_BY_OTHERS`.
- **B3 plugin settings** with an absolute path, a drive, a UNC path, `~`, `@home`, a `..` segment, or an INI `%(option)s` reference to another option are refused (`B3_PLUGIN_CONFIG_INVALID`, reason `PATH_OUTSIDE_B3`); plugin XML may no longer contain a `<!DOCTYPE>` (also fixes A3-6). Use `@conf/…` for files B3 writes.
- **B3 log for read-only roles** shows IPs as `a.b.c.x` and GUIDs as `…abcd`.
- **Local backend** refuses requests from foreign web pages (`ORIGIN_REFUSED`); the desktop app identifies itself with a per-launch header. Scripts without an Origin and the vite dev server keep working.
- **Desktop app**: links open in the system browser (https only); the window never navigates away from the app.
- **Remote hosts**: an SFTP request without an answer fails after 15 s (uploads 60 s) with `REMOTE_TIMEOUT`; a listing with more than 65 536 entries fails with `REMOTE_LISTING_TOO_LARGE`.

## Not fixed (Low, tracked)

23 Low findings (A3-6 was fixed along with A3-2), one GitHub issue per area: #40 (local runtime), #41 (secrets), #42 (B3), #43 (remote Linux), #44 (remote access and admin API), #45 (Electron and dependencies).

## Checks

- `node scripts/preflight-4.18.26.mjs` with the new security audit gate (`scripts/verify-4.18.26-security-gate.mjs`: every area reviewed, no open Critical/High/Medium finding, every fixed finding's test re-run, `npm audit --omit=dev` clean).
- Native checks still open (see the report and `docs/WSL-NATIVE-CHECKLIST.md`): launch file with the real core on Windows and Linux (A2-1), desktop app login and links on Windows (A5-1, A6-1), Windows folder permissions for Python and B3 (A3-5).
