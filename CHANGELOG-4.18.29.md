# Changelog 4.18.29 – Security Low findings and write rate limit

Fixes the Low findings of the 4.18.26 security audit (issues #40 to #45) and adds a rate limit to the admin API (issue #49). Every fixed finding is marked `fixed` with its regression test in `docs/SECURITY-AUDIT-4.18.26.md`, so the security gate of the preflight re-runs those tests.

## Area 1 – local runtime (#40)

- **A1-3:** tar archives are unpacked without their owners (`preserveOwner: false`); setuid, setgid and sticky bits are removed in the staging copy. CONTROL logs a warning and an audit entry (`control.running_as_root`) when it runs as root. Not done: detecting an elevated Windows process.
- **A1-4:** the Windows legacy runtime compares the saved process creation time before every stop and forced stop.
- **A1-5:** open. Node.js has no `pidfd_open`/`pidfd_send_signal`; closing the race needs a native helper. The identity check right before the signal stays.
- **A1-6:** size caps of 1 GiB per entry and 4 GiB in total for zip and tar (zip also checks the real size against the header). Links in the target were already refused since 4.18.27.
- **A1-7:** artifacts are downloaded over https only; an FPS or mod archive may not bring a `cod4x18_dedrun(.exe)` (`INSTALL_CORE_OVERWRITE`).

## Area 2 – secrets (#41)

- **A2-3:** the audit folder is created 0700 (an older one is tightened), `audit.ndjson` is created 0600.
- **A2-4:** optional idle lock for the vault: `COD4X_VAULT_IDLE_LOCK_MINUTES` (1 to 1440). Without it the vault stays unlocked until someone locks it, as before.
- **A2-5:** only the newest 20 vault backups are kept.

## Area 3 – B3 (#42)

- **A3-7:** the B3 plugin `pluginmanager` cannot be enabled any more, is listed as unavailable (`B3_PLUGIN_REFUSED`) and blocks the B3 start if an older registry still has it enabled.
- **A3-8:** `POST /api/instances/:id/b3/integration/auth-password` is local-only, `no-store` and answers a broken body with a fixed error (credential guard, `lib/credential-request.mjs`).

## Area 4 – remote Linux (#43)

- **A4-3:** `health()` skips an instance with a running operation; `status()`, `statusAll()` and `health()` write the state only if it is unchanged since they read it.
- **A4-4:** the instance root must belong to the SSH user and may not be group or world writable unless it has the sticky bit (`REMOTE_ROOT_UNSAFE`).
- **A4-5:** `hostname` and `map` from getinfo are cut to 64 characters without control characters.
- **A4-6:** a vault lock ends every pooled SSH session; setting or removing a host's SSH key ends that host's session.
- **A4-7:** Docker never mounts system folders (`/etc`, `/run`, `/proc`, `/sys`, `/dev`, `/boot`, `/root`, `/usr`, `/bin`, `/sbin`, `/lib*`, `/var/lib/docker`); the container gets `--cpus 2`.

## Area 5 – remote access and admin API (#44)

- **A5-5:** `POST /api/audit/test` and `POST /api/audit/rotate` need `user.manage`; rotated files now match the retention pattern, so only `maxRotated` files are kept.
- **A5-6:** `/api/remote-instances/:id/credentials` is covered by the credential guard.
- **A5-7:** failed step-up codes on the gateway count in the per-user brake; while locked: 429 `REMOTE_STEP_UP_LOCKED`.
- **A5-8:** the unused permission `secrets.manage` is removed.

## Area 6 – Electron and dependencies (#45)

- **A6-2:** the built desktop page carries a strict Content-Security-Policy (`lib/desktop-csp.mjs`, added by the Vite build only; the dev server needs inline scripts). Checked: `dist/index.html` rendered over `file://` in Chromium without a CSP violation.
- **A6-3:** permission request and check handlers refuse everything except clipboard writes of the app page in the main window.
- **A6-4:** `remembered-login.json` is written 0600 (folder 0700); on Linux with the safeStorage backend `basic_text` no login is remembered and an old one is removed.
- **A6-5:** `docs/SECURITY-ADVISORIES.md` lists `ssh2` and `express-rate-limit`.

## Issue #49 – rate limit

`express-rate-limit` 8.7.1 (new production dependency, pinned exactly) limits changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) under `/api` to 300 per minute and client by default (`COD4X_WRITE_RATE_LIMIT`, 1 to 10000). Reads stay free; the login keeps its own brake. Above the limit: 429 `RATE_LIMITED` with `Retry-After` and one audit entry per window. The remote gateway limits its changing requests (login, logout, push, step-up, actions) to 60 per minute and client (429 `REMOTE_RATE_LIMITED`).

## Native checks still open

- Electron on Windows: the app starts with the CSP, copy buttons work, no permission prompt appears (A6-2, A6-3).
- Linux desktop without a keyring: "remember login" is not offered (A6-4).
- Remote host with a real sshd: install into a root folder with mode 0775 is refused (A4-4); Docker start with `--cpus 2` (A4-7).
