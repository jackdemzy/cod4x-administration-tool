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

## Debug phase (app started and played through)

The desktop page (built `dist/`, loaded as file:// with the per-launch header, as Electron does) was driven against the real backend on Linux as a non-root user: all 12 menu items in English and German, core adopt, server create, vault, RCON (`status`, `map`, blocked `quit`), start / stop / restart, online players, master, plugins, B3 status and blocked B3 start, restore points, production backup (create, consistency, lifecycle, verify, restore), backend restart. Found and fixed:

- **Blank app after leaving Tools (crash).** The GSC assistant's effect returned `scrollIntoView(...)`, which is a Promise in current Chromium; React called it as cleanup (`destroy_ is not a function`) and unmounted the whole app. The effect now returns nothing. Every page is wrapped in an error boundary: an error shows a message in that page, the menu stays usable.
- **Session loss left the app polling with 401.** After a backend restart or an expired session every panel showed "Authentication required" and kept polling. A 401 on a request that carried the session token now drops the token and shows the login screen with a note.
- **Audit log flooded by polling.** An open Runtime page wrote about one audit entry per second (`rbac.permission.checked` and `instance.operation` for reads), pushing real events out of the bounded log (500) and growing `audit.ndjson`. The polled reads (`/api/runtime/status`, `/api/runtime/preflight`, `/api/instances`, `/api/instances/:id/rcon`) audit denials only, and successful instance reads are no longer audited as operations. Changes and refusals are audited as before.
- **Second app start.** There was no single-instance lock: a second start ran a second backend that failed on port 8787 ("exited with code 1") while its window talked to the first backend with the wrong per-launch secret, and the login page then showed the setup form for a new administrator. Now a second start focuses the first window; the login page treats a refused or broken status answer as an error with "Try again"; the app never talks to a backend that is not its own; the backend's output goes to `<userData>/logs/backend.log` (kept below 2 MB) instead of nowhere; the desktop dialogs are in English.
- **Vault passphrase.** A new vault asks for the passphrase twice (it cannot be recovered) and is unlocked right after it is created; the status loads when the section is opened.
- **Language.** Permission descriptions on the Audit page in English and German (the backend sends German only), "Registry consistency", the remember-login reason follows a later language switch, base game placeholder without doubled backslashes and with a Linux example, "Console log" instead of "Windows console log" (also shown for Linux servers).
- **Docker tests in the Linux release job (sometimes red).** Tests against the real Docker daemon (`remote-docker-real`, `remote-docker-gate`) ran in parallel under `node --test` on the same daemon. They now run one at a time through a lock in the temp folder (`test/support/docker-fixture.mjs`). A refused `docker run` keeps Docker's reason (end of stderr, at most 2 KB, secrets blacked out) on `REMOTE_START_FAILED`; the API returns it as `output` and the Remote Linux page shows it. The getinfo wait of the scripted container test is 15 s instead of 5 s.

Found, not changed:

- `/api/runtime/preflight` answers HTTP 400 for a core that is not configured yet; the Runtime page asks every 2.5 s, so the browser console shows an error each time. The page handles it; changing the status code would change the API. (Fixed later, see "Runtime page without a core" below.)
- Backend error texts are mostly German (e.g. "cod4x18_dedrun wurde am ausgewählten Server-Core-Pfad nicht gefunden.", rate-limit message); a blocked B3 start shows only the code `B3_DEPENDENCIES_BLOCKED`.
- The single-instance lock and the backend log file were checked in the source only: the Electron binary is not installed in the cloud container.

## Review findings on #64

- Wrong password when turning off the second factor no longer logs you out: the backend marks a missing session with `code: "AUTH_REQUIRED"`, and only that 401 ends the session in the UI (`PASSWORD_INVALID` keeps it).
- `backend.log` stays capped while the backend runs: its output goes through a pipe into `lib/capped-log.cjs`, which moves the file to `backend.log.1` before it would pass 2 MB (before, the size was checked only at start).
- Real-Docker test lock: a stale lock is taken over under an exclusively created `<lock>.takeover` file, which re-checks the owner, so two workers can no longer both remove it and run Docker at once.

## Review findings on #65 and the red Windows checks

- The Windows preflight and release jobs failed on the new lock test (`mkdir` EPERM on a directory Windows was still deleting). The real-Docker test lock is now a kernel lock (`flock`, util-linux) held by a helper process until its stdin closes; a killed test process releases it at once, so no PID file, takeover marker or stale-lock cleanup is left that could race (Codex findings on #65). The lock tests run on Linux only, like real Docker.
- `lib/capped-log.cjs`: when the rotation cannot move `backend.log` (no rights, `backend.log.1` held open on Windows), the log starts over instead of growing past the limit.

## CodeQL path alerts on #66 (lib/server-instance-store.mjs)

- Two high `js/path-injection` alerts appeared because two lines got English texts. Traced: every path there is the managed root plus a server ID limited to `^[a-z][a-z0-9-]{0,47}$` (no reserved Windows names); home, config and save paths are always derived from it, a registry or restore record with other paths is refused, and `validatePaths` checks the real path against the root. A new test (hostile IDs such as `../outside`, `/etc`, `a\..\..\outside`, a tampered registry, a foreign restore record) passes with the old and the new code: the alerts were false positives.
- Still hardened: `noLink` and the config check resolve the path and require it under the managed root right before the file system call.

## English backend texts, alerts and build output

- Backend error texts (login, users, profiles, preflight/diagnostics checks, runtime, instance store, config validator, B3 plugin list) are English. Texts that already come in German and English pairs (B3 messages, overview guide, monitor hints, credential warnings) are unchanged.
- Alerts (Discord and push): titles and bodies in English (`is down`, `Downtime`, disk space with a decimal point); the cause hint now uses the English line.
- RCON command descriptions, `build.ps1` output, docker gate and E2E failure test names in English.
- The B3 database restore confirmation phrase is now `RESET B3 DATABASE`.

## Not changed

- The phone web app (`/remote/`, `lib/remote-app.jsx`) is still German only.
- Backend error texts that the server sends as free text are shown as they come (now in English, also in the German UI).
- `.github/workflows/release.yml` still lists `scripts/preflight-4.18.30.mjs` in its path filter (left alone to avoid a conflict with the open code-signing PR #59).

## Tests

- `test/debug-phase-4.18.31.test.mjs` (new, also in the preflight): no effect returns an expression value, error boundary in English and German, 401 ends the session (not for a failed login), polled reads write no audit entries against the real backend (fails without the fix), vault passphrase twice, permission texts in both languages, Electron single instance and log file, Docker refusal text bounded and redacted, real-Docker lock.

- `test/pidfd-signal.test.mjs` (new): the pidfd helper against the real kernel, including a pidfd held across the exit of its process (ESRCH, no signal to the PID).
- `test/linux-runtime-adapter.test.mjs`: pidfd opened before the identity check, closed after a refused check, fallback reported, own child signalled through its handle.
- `test/elevation-check.test.mjs` (new): root and Windows administrator detection.

- `test/ui-language.test.mjs` (new): English default and stored choice, every menu item described in both languages, overview and Remote Linux rendered in both languages, no inline layout styles left on the Remote Linux page.
- `scripts/preflight-4.18.31.mjs` runs it together with `test/remote-hosts.test.mjs`.
- `test/review-4.18.31.test.mjs` (new, also in the preflight): capped log rotation (also when the move fails), real-Docker lock: one holder among 20 waiters, timeout, released when the holder is killed.

## Issue #67 and #21 (Low findings A2-7, A4-8, A6-8; Dependabot alert #90)

- **A6-8 Electron fuses:** the release build sets RunAsNode, `NODE_OPTIONS` and `--inspect` off, cookie encryption, embedded asar integrity (checked by Electron on Windows) and only-app.asar on. The backend runs in an Electron utility process instead of `electron + ELECTRON_RUN_AS_NODE`. `--cod4x-backend-only` runs only the packaged backend (release installer gate, needs `--no-sandbox --ozone-platform=headless` on a Linux machine without a display). `scripts/release-verify.mjs` checks the fuse wire of the packaged executable.
- **A2-7 vault passphrase change:** `POST /api/credentials/vault/passphrase` (`passphrase`, `newPassphrase`, `expectedSha256`) re-encrypts the vault under a new salt and key after proving the current passphrase, and deletes every vault backup sealed with the old key. The credential editor offers it while the vault is unlocked.
- **A4-8 game logs:** logs above 64 MiB are renamed to `.1` before each remote start (SSH and Docker). While any server runs (local instances, the standard server, remote servers) a log above the limit is copied to `.1` and emptied every 5 minutes; a container's logs are capped inside the container. `COD4X_LOG_CAP=off` turns the timer off.
- **#21 minimatch:** npm `overrides` lift the build-time `minimatch` of `app-builder-lib` and `@electron/universal` to 11.0.8 (GHSA-g3hv-75wg-m249). `npm audit`: 0 vulnerabilities.
- Tests: `test/issue-67.test.mjs` (new).

## Phone web app (/remote/) in English

- The mobile monitor (`lib/remote-app.jsx`: login, push toggle, actions, error messages) is English by default; German stays selectable with an EN/DE switch on the login page and in the header. The choice is stored in `localStorage` (`cod4x.ui.lang`, `lib/remote-lang.mjs`); the login session still lives only in the HttpOnly cookie.
- Every error code has a [German, English] pair; times follow the chosen language. `remote.html` and the web app manifest are English (`lang="en"`).
- Gateway, push alerts and logs were already English.
- Tests: `test/remote-ui.test.mjs` renders the app in both languages and checks that no German text is left outside the pairs; the 4.18.16 remote gate checks the English source link.

## Runtime page without a core

- `GET /api/runtime/preflight` answers HTTP 200 when no dedicated core is installed or selected yet (file missing, not a file, wrong name, relative path). The answer carries `ok: false`, `coreInstalled: false`, `executablePath: null` and a `core` object with `verified: false`, `corePresent: false` and the reason in `core.reasons`; the BaseGame check is reported as well. Before, the route answered 400 and the Runtime page, which polls every 2.5 s, logged a browser console error on each poll. Bad input (unsupported platform, unsafe server path) still answers 400.
- The Runtime page now shows the backend's reason (e.g. "cod4x18_dedrun was not found at the selected server core path.") under NOT VERIFIED instead of the generic "Verified core check failed.", and shows the BaseGame state while no core is set.
- Tests: `test/runtime-preflight-no-core.test.mjs` (new).
