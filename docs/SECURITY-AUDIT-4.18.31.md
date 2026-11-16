# Security audit 4.18.31 (full debug and security check)

Second full audit after [`SECURITY-AUDIT-4.18.26.md`](SECURITY-AUDIT-4.18.26.md), on main `c971335` (4.18.31). Same threat model (attackers A1 to A7) and severity scale as the 4.18.26 design: [`docs/superpowers/specs/2026-11-11-security-audit-design.md`](superpowers/specs/2026-11-11-security-audit-design.md).

Method: three independent, read-only reviewers covered the HTTP surface (every route, authentication, sessions, Origin/CSRF, gateway, frontend sinks), the file system and process side (paths, archives, downloads, core and B3 starts, SSH, Docker, RCON, restore points) and secrets, Electron, CI and supply chain. Each first checked that the 4.18.26 fixes still hold; none had regressed. Every finding below was traced end to end in the code and, where cheap, reproduced; each fixed finding has a regression test. A fourth pass played the whole app through in English and German against the real backend (see "Debug pass"). `scripts/verify-4.18.26-security-gate.mjs` reads this file too: it fails while an area is not reviewed or a Critical, High or Medium finding is open, and re-runs every regression test named below.

## Area 1 – Local runtime

Reviewed: yes

One High finding (A1-8, also reaching remote and Docker starts) and two Low findings, all fixed. Root cause of A1-8 and A1-9, checked against the CoD4x source (`Com_ParseCommandLine`): the core joins its argv with spaces and splits the result at every `+`, without quote handling; every piece runs as a startup command. RCON passwords already refused `+`, path values did not. `lib/core-launch-args.mjs` now checks the final argument list of every core start (local, SSH, Docker): a `+` may only open a bare command token. Choosing a server or BaseGame folder other than the stored one now needs `server.code`.

Checked without a finding: Verified-Core gate, process identity before signals, artifact pins, archive extraction (zip-slip, links, size caps, setuid), `shell: false` everywhere with absolute interpreters and reduced environments.

## Area 2 – Secrets

Reviewed: yes

Two Low findings fixed, one Low finding tracked in issue #67 (needs a new feature). Vault crypto, file modes, launch secrets file and request scrubbing are unchanged and still correct.

## Area 3 – B3

Reviewed: yes

One Low finding fixed (A3-9). Database helper (bound parameters, pinned SQL), `b3.xml` escaping and plugin file checks hold.

## Area 4 – Remote Linux

Reviewed: yes

The remote part of A1-8 (`basePath`/`remoteRoot` with `+`) is fixed in `assertRemotePosixPath`, `startCoreCommand` and `runContainerCommand`. One Low finding (A4-8, log rotation on remote homes) was tracked in issue #67 and is fixed: rotation before each remote start, and a cap while running (native on the host, a container inside the container). Shell quoting, host key pinning, SFTP limits and Docker hardening hold.

## Area 5 – Remote access and admin API

Reviewed: yes

One Medium and five Low findings, all fixed. Every route still has an authorization check matching its binding; the Origin guard, sessions, TOTP and the gateway CSRF check hold.

## Area 6 – Electron and dependencies

Reviewed: yes

One Medium and two Low findings fixed (A6-8 from issue #67: Electron fuses, the backend runs in a utility process). `npm audit --omit=dev`: 0 vulnerabilities. `npm audit` with dev dependencies: 0 vulnerabilities since npm `overrides` lift the build-time `minimatch` of `electron-builder` 26.18.0 to 11.0.8 (issue #21, GHSA-g3hv-75wg-m249; electron-builder itself still asks for `^10.2.5`); a Linux package built with it starts and passes the fuse check.

## Findings

| ID | Title | Attacker | Grade | Status | Evidence |
|----|-------|----------|-------|--------|----------|
| A1-8 | An operator could inject core commands through a `+` in a BaseGame path (clone with `basePath`, needs only `server.manage`), a remote `basePath`/`remoteRoot` or the runtime path, e.g. `/srv/b+loadPlugin evil`, and so load a native plugin without `server.code` | A2 | High | fixed | `test/audit-4.18.31.test.mjs` |
| A1-9 | The `fs_basepath`/`fs_homepath` override check matched only the exact token `+set`; `"+set fs_homepath /x"` in one argument got past it (admin only) | A2 | Low | fixed | `test/audit-4.18.31.test.mjs` |
| A1-10 | `main/qconsole.log` and `main/logs/games_mp.log` of local instances grow without limit (chat spam fills the disk); now rotated above 64 MiB before each start of an instance and of the standard server, and (issue #67) copied to `.1` and emptied every 5 minutes while the server runs | A1 | Low | fixed | `test/audit-4.18.31.test.mjs`, `test/issue-67.test.mjs` |
| A2-6 | No final error handler on 8787: a malformed JSON body (login, init, users, alert settings with the Discord webhook) was printed by Express's default handler into `backend.log`, and callers got an HTML stack trace with install paths | A4 | Low | fixed | `test/audit-4.18.31.test.mjs` |
| A2-7 | The vault passphrase cannot be changed; backups keep removed secrets under the same key. Now `POST /api/credentials/vault/passphrase` (current passphrase required) re-encrypts the vault under a new salt and deletes every backup sealed with the old key | A4 | Low | fixed | `test/issue-67.test.mjs` |
| A2-8 | A crash between creating and deleting `credential-vault/.operation.lock` blocked every later vault change for good; the lock now names its owner's PID and a dead owner's lock is taken over | A4 | Low | fixed | `test/audit-4.18.31.test.mjs` |
| A3-9 | B3 module hashes ignore `.pyc`/`.pyo`, which Python 2.7 runs in place of a matching `.py`; compiled files are now removed from the B3 tree before every start | A5 | Low | fixed | `test/audit-4.18.31.test.mjs` |
| A4-8 | Game logs on remote (SSH) and Docker homes are not rotated. Now renamed above 64 MiB before each remote start and capped while running (a container's logs inside the container, so a planted link never reaches the host) | A1 | Low | fixed | `test/issue-67.test.mjs` |
| A5-9 | A viewer could make CONTROL probe any path through `GET /api/runtime/preflight` (on Windows a UNC path hands the account's NTLM hash to another host; on Linux it shows whether any path exists and lists `main/*.iwd`) | A2 | Medium | fixed | `test/audit-4.18.31.test.mjs` |
| A5-10 | The credential guard (local only, `no-store`, fixed parse error) could be bypassed by letter case (`/API/Credentials/...`), because Express routes ignore case | A2 | Low | fixed | `test/audit-4.18.31.test.mjs` |
| A5-11 | Behind Tailscale or Caddy the gateway write limit was one bucket for all clients (one client could block every phone), and failed logins of strangers locked the step-up of a logged-in user | A1 | Low | fixed | `test/audit-4.18.31.test.mjs` |
| A5-12 | Behind the public proxy the remote login confirmed a correct password of an account without remote access or TOTP (distinct, uncounted answer) | A1 | Low | fixed | `test/alerts-http.test.mjs` |
| A5-13 | The FPSAC download was not SHA-256 pinned and passed the upstream `Content-Type`; its RBAC binding said POST; the UI link carried no bearer token (always 401) | A5 | Low | fixed | `test/audit-4.18.31.test.mjs` |
| A5-14 | The legacy `POST /api/rcon/execute` accepted line breaks and control bytes in the command (a second command after an allowed first word) | A2 | Low | fixed | `test/audit-4.18.31.test.mjs` |
| A6-6 | The desktop app trusted any HTTP 200 on 127.0.0.1:8787 as its backend; a local user who took the port first received the saved admin login. The backend also kept running after a failed listen | A4 | Medium | fixed | `test/audit-4.18.31.test.mjs` |
| A6-7 | CI actions, including the SignPath action that receives the signing token, were pinned by mutable tags; now pinned to commit SHAs, Dependabot updates the pins | A5 | Low | fixed | `test/release-signing.test.mjs` |
| A6-8 | No Electron fuses; the backend needs `ELECTRON_RUN_AS_NODE`, and without asar integrity a changed `app.asar` runs under a valid signature. Now the backend runs in a utility process, RunAsNode, `NODE_OPTIONS` and `--inspect` are off, asar integrity (Windows) and only-app.asar are on; `release-verify` checks the fuse wire | A4 | Low | fixed | `test/issue-67.test.mjs` |

## Rejected findings

- **Area 5, per-user remote login lock (30 failures per 15 minutes):** anyone who knows a user name can keep that user's remote login locked. Kept on purpose: it is the brake against distributed password guessing (A5-3). The local login is not affected, and the step-up of a logged-in user now has its own brake (A5-11).
- **Area 5, missing `nosniff`/CSP headers on 8787 and `error.message` with paths for authenticated roles:** 8787 answers JSON only, the renderer has its own CSP, and only signed-in users see the messages. Defence in depth only.
- **Area 5, remote TOTP guessing after a password leak:** capped at 30 tries per 15 minutes per user, about 0.9 % per day for a ±1-step code. Accepted.
- **Area 1, downloads without a size cap / adm-zip inflating an entry fully:** every artifact URL is admin-pinned with a SHA-256; at most a denial of service against one's own configuration.
- **Area 2, audit log without a hash chain; `appendOnly` is a label only:** whoever can change the file already runs as the CONTROL user. No current call writes a secret into it.
- **Area 6, unsigned AppImage, `workflow_dispatch` can sign any branch, `npm ci` runs install scripts, uninstall deletes the data folder:** known and documented (SignPath policy restricts what is signed; `deleteAppDataOnUninstall` is the intended clean uninstall).
- **Area 6, crash diagnosis matched player chat:** a chat line such as "fatal error lol" became the crash reason in alerts. Not a security issue (no mention spam: `allowed_mentions` is empty); fixed anyway in `lib/monitor-diagnose.mjs` and tested in `test/audit-4.18.31.test.mjs`.

## Debug pass

The app was played through against the real backend in English and German, as admin and as operator, with a fake core: first run, login, TOTP, all menus, server lifecycle (create, start, restart, stop, clone, archive), config editor, RCON console, vault, backups, restore points, users, B3 panels, remote hosts, remote gateway and the mobile `/remote/` page at 390 px. No page crashed, no React error, no endless polling. Regression tests: `test/debug-pass-4.18.31.test.mjs` and `test/monitor.test.mjs`.

| ID | Fault | Fix |
|----|-------|-----|
| B1 | Unlocking the vault in the instance credential editor ended with "VAULT_LOCKED": the unlock fell into the save branch | unlock ends after the unlock call |
| B2 | A cleanly stopped server stayed "Not answering" in the monitor until the backend restarted | a planned stop clears the outage state |
| B3 | Diagnostics and the security check judged the client `iw3mp.exe` and a Windows default instead of the stored dedicated core | both use the stored runtime core, version and platform |
| B4 | A wrong unlock passphrase cleared the vault status and showed a raw code | status kept, clear message |
| B5 | German UI showed English text (login errors, server config, security, master list, B3 plugin source) | translated in the frontend; backend messages stay English by design |
| B6 | Raw codes without a message (remote hosts, B3 dependencies, restore points, RCON history, "PLANNED_BLOCK_14") | messages added; the MySQL rows now say they are checked per server |
| B7 | B3 requirements showed a tick for checks that only run with hiding switched on | shown as "–" with a note |
| B8 | Operators saw three audit panels that only said "Permission denied" | shown only to roles with `audit.read` |
| B9 | The first runtime preflight went out with platform `windows` before the stored state loaded (400 for a Linux core) | the stored runtime is read first |
| B10 | "UDP-Port" in English, RCON "transfer unknown" for a stopped server | fixed |

Left open (cosmetic, no fault in function): the instance card in Runtime uses browser-default controls; remote host errors appear at the top of the page, far from the form; fs_homepath is shown both absolute and relative in the legacy block; "Mods" and "Version Manager" open the same view; creating a B3 plugin from the template shows no success message; `UserAdministrationPanel` holds unused lifecycle helpers; the Runtime page logs a console error every 2.5 s while no core is installed (accepted in the 4.18.31 debug phase).

Not testable here: Windows, real Docker and SSH hosts, a real B3 with Python 2.7 and MySQL, kicking a live player, and the remote actions that need a running remote server.

## Native checks

- **A6-6, desktop app:** on Windows start CONTROL normally: the window must open as before. Then start a second program on 127.0.0.1:8787 first (for example `python -m http.server 8787 --bind 127.0.0.1`) and start CONTROL: it must show "The local backend could not be started" and never show the login page. Ending the backend process in the task manager must close the app with a message.
- **A1-8, Windows:** a server or BaseGame folder whose name contains `+` is now refused; rename such a folder if one exists.
- **A5-13:** with `FPSAC_URL` and `FPSAC_SHA256` set, "Download FPSAC 9.2.0" in the Anti-Cheat section must save the file.
