# COD4X CONTROL 4.18.31 – UI language and overview

Base: 4.18.30 (release candidate, not tagged yet).

## Changes

- **English is the default UI language.** German stays selectable in the main menu (bottom of the sidebar, "EN · English" / "DE · Deutsch") and on the login screen. The choice is stored per computer in `localStorage` (`cod4x.ui.lang`) and sets `<html lang>`.
- **Fixed German-only texts translated** in the admin app: login and first-run screen, users and roles, sessions, production backups, security boundaries, anti-cheat download buttons, config validation messages, RCON and dvar reference descriptions, GSC quick prompts, remote-access error messages, mod preset names. Existing German texts are unchanged.
- **Overview page:** a step-by-step quick start and one card per menu item (Overview, Monitoring, Server Config, Mods, Security, Diagnostics, Runtime, Remote Linux, Audit, RCON Reference, Version Manager, Tools) that says what it is for; a click opens the page. The app now starts on the overview. Text in `lib/overview-guide.mjs`.
- **Remote Linux page** in the look of the other pages: cards per area (connection, hosts, servers, install), labelled field grid, themed buttons, notes, status and error boxes (`.remote-linux` in `src/styles.css`). Fields, texts and actions are unchanged.

## Security (issue #40, last Low findings of the 4.18.26 audit)

- **A1-5, Linux stop without a PID-reuse race.** A server CONTROL started itself is signalled through its own child handle: until Node has reaped it the PID stays reserved, and Node drops the handle in the same step as the reap. A server adopted after a CONTROL restart is signalled through a pidfd that a small python3 helper (`lib/pidfd-signal.mjs`, Python 3.9+, Linux 5.3+) opens *before* the identity check; if the process ends in between, the signal fails with ESRCH instead of hitting a new owner of the PID. Without python3 or pidfd support CONTROL keeps the previous check-then-kill and writes the audit entry `runtime.pidfd_unavailable` once. Remote Linux hosts still signal over SSH with the identity check right before (unchanged).
- **A1-3, Windows administrator warning.** CONTROL now also warns (console and audit entry `control.running_as_admin`) when it runs elevated on Windows (integrity level High or System in the process token, read with `whoami /groups`; no Windows service needed). Root on Linux was already reported since 4.18.29.
- Issue #21 (minimatch in electron-builder) stays open: electron-builder 26.18.0 is still the latest version and still requires minimatch ^10.2.5 (checked 2026-11-15).

## Not changed

- The phone web app (`/remote/`, `lib/remote-app.jsx`) is still German only.
- Backend error texts that the server sends as free text are shown as they come.
- `.github/workflows/release.yml` still lists `scripts/preflight-4.18.30.mjs` in its path filter (left alone to avoid a conflict with the open code-signing PR #59).

## Tests

- `test/pidfd-signal.test.mjs` (new): the pidfd helper against the real kernel, including a pidfd held across the exit of its process (ESRCH, no signal to the PID).
- `test/linux-runtime-adapter.test.mjs`: pidfd opened before the identity check, closed after a refused check, fallback reported, own child signalled through its handle.
- `test/elevation-check.test.mjs` (new): root and Windows administrator detection.

- `test/ui-language.test.mjs` (new): English default and stored choice, every menu item described in both languages, overview and Remote Linux rendered in both languages, no inline layout styles left on the Remote Linux page.
- `scripts/preflight-4.18.31.mjs` runs it together with `test/remote-hosts.test.mjs`.
