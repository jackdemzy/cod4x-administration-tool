# Security audit 4.18.26 (Roadmap Block 20)

Design, threat model (attackers A1 to A7) and severity scale: [`docs/superpowers/specs/2026-11-11-security-audit-design.md`](superpowers/specs/2026-11-11-security-audit-design.md). Plan: [`docs/superpowers/plans/2026-11-11-security-audit.md`](superpowers/plans/2026-11-11-security-audit.md).

Each area was read by its own independent reviewer. Every finding was then confirmed by a test that reproduced it, or rejected with a reason. Critical, High and Medium findings are fixed; Low findings are tracked as GitHub issues. `scripts/verify-4.18.26-security-gate.mjs` reads this file: it fails while an area is not reviewed or a Critical, High or Medium finding is open, and it re-runs every regression test named below.

## Area 1 – Local runtime

Reviewed: no

## Area 2 – Secrets

Reviewed: yes

Reviewer: independent, read-only (2026-11-11). One High and one Medium finding, both reproduced by a failing test and fixed; three Low findings tracked as issues (a fourth was the same as A5-6).

Checked without a finding: master token (vault form check, only ids and codes in audit and API, hash only for verification); RCON password (packet buffer wiped after sending, remote only over stdin, blocked commands audited by name only, responses filtered); B3 database password (vault check, `b3.xml` 0600 with `wx`, B3 command line holds only the config path, reduced environment, redacted for the UI); SSH key (vault subject, passed to ssh2 as a buffer, no temp file or `ssh` binary, request body fields deleted after the route, fixed error codes); Discord webhook (0600 file, masked in API and audit, no redirects); VAPID private key (only in `alerts.json` 0600); TOTP secrets (`users.json` 0600, never audited, recovery codes as scrypt hashes); session tokens (memory only, list shows ids); vault crypto (scrypt N=2^17 r=8 p=1, 32-byte salt, AES-256-GCM with a random 96-bit nonce per seal, AAD binds version and KDF, plaintext only after `final()`, buffers wiped, directory 0700, files 0600 with `wx`, owner/mode/symlink/nlink checks); secrets in error messages; remote output redaction and limits; environment and temp files.

## Area 3 – B3

Reviewed: no

## Area 4 – Remote Linux

Reviewed: no

## Area 5 – Remote access and admin API

Reviewed: yes

Reviewer: independent, read-only (2026-11-11). Four Medium findings, all reproduced by a failing test and fixed; four Low findings tracked as issues.

Checked without a finding: gateway authentication (dummy hash for unknown users, `disabled` and `remoteAccess` checked, TOTP required for admin/operator and for everyone in proxy mode); TOTP (RFC 6238, ±1 step, replay refused, constant-time compare, recovery codes only as scrypt hashes and never valid for actions); gateway sessions (random token kept only as SHA-256, new token per login, cookie `HttpOnly; Secure; SameSite=Strict; Path=/remote`, idle and absolute expiry, revocation on every narrowing change); local sessions (32-byte random token, header only); CSRF on the gateway (same-origin or matching Origin plus JSON on every POST, no state-changing GET); CSRF on 8787 for every route that needs the bearer token; authorisation of every route in `installer-server.mjs`, `lib/remote-linux-routes.mjs`, `REMOTE_LINUX_BINDINGS` and `lib/b3-plugin-routes.mjs`; what the gateway exposes to the phone (fixed route list, 2 kB body limit, fixed error codes, actions behind `server.manage`, second factor and both switches); gateway listener (plain HTTP only on loopback, TLS 1.2+, Tailscale headers only from loopback and never in proxy mode); `lib/remote-app.jsx` (no raw HTML sinks, no token in storage).

## Area 6 – Electron and dependencies

Reviewed: no

## Findings

| ID | Title | Attacker | Grade | Status | Evidence |
|----|-------|----------|-------|--------|----------|
| A2-1 | RCON password and master token in the local core's command line, readable by every local user on Linux (`/proc/<pid>/cmdline`) | A4 | High | fixed | `test/security-local-launch-secrets.test.mjs` |
| A2-2 | Instance homes 0755 and the B3 game log 0644: typed `!auth` passwords readable by local users who can reach the data folder | A4 | Medium | fixed | `test/security-instance-permissions.test.mjs` |
| A2-3 | `audit.ndjson` is created 0644 and only then set to 0600; the audit folder is created without a mode | A4 | Low | open |  |
| A2-4 | An unlocked vault stays unlocked until someone locks it (no idle lock) | A4 | Low | open |  |
| A2-5 | Vault backups `backup-<uuid>.json` are never pruned | A4 | Low | open |  |
| A5-1 | A hostile web page could create the first administrator before setup (CORS `*`, no Origin check on `/api/auth/init`) | A3 | Medium | fixed | `test/security-admin-api.test.mjs` |
| A5-2 | A hostile web page could lock the local login and learn whether a user is disabled | A3 | Medium | fixed | `test/security-admin-api.test.mjs` |
| A5-3 | Login brake bypass: X-Forwarded-For from a local caller at the gateway, rotating 127.x source addresses on 8787 | A4 | Medium | fixed | `test/remote.test.mjs`, `test/security-admin-api.test.mjs` |
| A5-4 | A disabled user kept local admin API sessions for up to 12 hours | A2 | Medium | fixed | `test/security-admin-api.test.mjs` |
| A5-5 | Read-only roles (`audit.read`) can rotate the audit log and write test entries; rotated files never match the retention pattern | A2 | Low | open |  |
| A5-6 | `/api/remote-instances/:id/credentials` is not covered by the credential guard (local-only, `no-store`, fixed JSON parse error) | A2 | Low | open |  |
| A5-7 | Failed step-up codes on the gateway are not throttled | A2 | Low | open |  |
| A5-8 | The `secrets.manage` permission is shown but no route requires it; vault and credential routes use `config.manage` | A2 | Low | open |  |

## Rejected findings

## Native checks

- **A2-1, launch file:** start a local instance with RCON password and master token on Windows and on Linux with the real CoD4x core. The console must show `execing launch-<id>.cfg`, RCON must work, the master server must accept the token, `main/` must hold no `launch-*.cfg` afterwards, and on Linux `cat /proc/<pid>/cmdline` must show neither secret. If the core does not print `execing` within 15 seconds, CONTROL deletes the file anyway and RCON stays without a password for that run.

- **A5-1, desktop app:** start the Electron app on Windows, create the administrator on a fresh data folder, log in, open the RCON console and save a config. Every request must succeed; the backend now refuses `Origin: null` without the per-launch `X-COD4X-Desktop` header that `electron-main.cjs` adds. The cloud tests cover the backend side only.
