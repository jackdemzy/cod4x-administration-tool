# Security audit (Roadmap Block 20, 4.18.26)

Status: **draft, waiting for Rafiki's review.** The decisions below were made by Rafiki on 2026-11-11. The implementation plan will be `docs/superpowers/plans/2026-11-11-security-audit.md` and is written only after this spec is approved.

## Roadmap text (Block 20, copied)

> **Ziel:** Vor Release wird die gesamte Anwendung sicherheitstechnisch geprüft.
>
> **Runtime:** Path Traversal, Arbitrary Executable, Shell Injection, PID Spoofing, Process Ownership, Symlinks, Permissions
>
> **Secrets:** Master Token, RCON Password, DB Password, SSH Credentials
>
> **B3:** Python Process Isolation, DB Credentials, Plugin Trust, Config Injection
>
> **Linux:** Root Execution verhindern, File Permissions, Executable Ownership
>
> **Gate:** Security Audit ohne High/Critical Findings

## Intended outcome

Before the release blocks (21 to 23), every part of CONTROL that an attacker can reach has been read by an independent reviewer against a written threat model. Every confirmed High, Critical and Medium finding is fixed and pinned by a test that reproduced it first. Every confirmed Low finding and every rejected finding is written down with its reason. The result is one audit report that Rafiki can read without the code.

## Decisions (Rafiki, 2026-11-11)

1. **Independent reviewers per area.** Each area below is audited by a fresh reviewer (subagent, most capable model) that has not seen the rest of the audit. The reviewer only reads; the implementer confirms each finding and fixes it.
2. **Tools: Superpowers and /security-review.** The Superpowers flow (spec, plan, TDD, verification) governs the block. `/security-review` reviews only the branch diff, so its standard (exploitable findings with high confidence, false positives filtered) is the standard for every area reviewer, and the command itself runs over the finished branch before the pull request.
3. **Scope beyond the roadmap list.** The remote gateway with the phone app, the admin API on `127.0.0.1:8787`, the Electron app, and remote Linux over SSH with Docker are audited too, since `SECURITY.md` lists them in scope. The two items inherited from Block 18 are on the list: `status()` writes remote state without the lock; the remote panel has no Recover button (the second one is checked for security impact only).
4. **Severity handling.** Critical, High and Medium are fixed in Block 20. Low is documented in the report and opened as a GitHub issue.

## Threat model

Attackers the audit considers:

- **A1 network attacker** in front of the remote gateway, not logged in.
- **A2 logged-in user with a lower role** (any RBAC role below the one a route needs), over the gateway or the admin API.
- **A3 hostile web page** in the admin's browser, reaching `127.0.0.1:8787` (CSRF, DNS rebinding, cross-origin reads).
- **A4 another local user** on the same Windows or Linux machine, without admin rights.
- **A5 hostile content**: a B3 plugin, a mod, a map, a config file or an archive that CONTROL reads, installs or starts.
- **A6 compromised SSH host**: output, files and timing under the host's control.
- **A7 hostile network peer**: forged RCON replies, master server answers, Discord or push endpoints.

Out of scope, as in `SECURITY.md`: an attacker with full control of the machine CONTROL runs on (admin/root, or the CONTROL user itself), and bugs inside CoD4x, B3 and other third-party software.

## Severity

- **Critical:** A1 or A3 executes code, reads a secret or takes over an admin session.
- **High:** A2 gains a permission it lacks, executes code or reads a secret; A4 reads a secret or controls a process CONTROL runs; A5 or A6 executes code on the CONTROL machine.
- **Medium:** an attack that needs an unusual precondition, or whose result is limited: denial of service of CONTROL or a game server, leak of non-secret private data (player IPs, GUIDs), integrity loss of a config or a file inside the instance, a secret in a place only the CONTROL user can read but that should not hold it.
- **Low:** defence in depth with no shown attack path, or an attack whose effect the attacker already had.

A reviewer's grade is advice. The implementer re-grades by effect against this list and records why.

## Areas

| # | Area | Main files | Roadmap items |
|---|------|-----------|---------------|
| 1 | Local runtime | `runtime-manager.mjs`, `linux-runtime-adapter.mjs`, `windows-process-ownership.mjs`, `runtime-layout.mjs`, `server-instance-*.mjs`, `base-game-manager.mjs`, `plugin-manager.mjs`, `config-engine*.mjs`, `config-activation.mjs`, `instance-config-validator.mjs` | Path traversal, arbitrary executable, shell injection, PID spoofing, process ownership, symlinks, permissions, root execution, file permissions, executable ownership |
| 2 | Secrets | `credential-vault-*.mjs`, `instance-credential-service.mjs`, `instance-master-service.mjs`, `runtime-secret-redaction.mjs`, `rcon-*.mjs`, `alert-notifier.mjs`, `discord-webhook.mjs`, `web-push.mjs`, audit and log writers in `installer-server.mjs` | Master token, RCON password, DB password, SSH credentials |
| 3 | B3 | `b3-*.mjs`, `instance-b3-*.mjs` | Python process isolation, DB credentials, plugin trust, config injection |
| 4 | Remote Linux | `ssh-transport.mjs`, `remote-*.mjs` (except the gateway), `docker-*.mjs` | Shell injection, path traversal, symlinks, ownership on the host |
| 5 | Remote access and admin API | `remote-gateway.mjs`, `totp.mjs`, `login-throttle.mjs`, `gateway-actions.mjs`, `remote-actions.mjs`, `remote-sessions.mjs`, auth, RBAC, sessions and routes in `installer-server.mjs`, `remote-app.jsx` | Authentication, authorisation, CSRF, DNS rebinding, session handling |
| 6 | Electron and dependencies | `electron-main.cjs`, `electron-preload.cjs`, `package.json`, `package-lock.json`, `docs/SECURITY-ADVISORIES.md` | Renderer isolation, navigation, IPC; `npm audit --omit=dev` |

Files a reviewer needs beyond its list may be read; findings belong to the area whose code must change.

## Process

1. **Brief.** Each reviewer gets this spec's threat model and severity list, its area row, the roadmap items, and the /security-review standard: report only what an attacker in the threat model can exploit, with a concrete path; no style, no theoretical hardening without a path (those may be listed as Low candidates).
2. **Report.** Each finding: id (`A<area>-<n>`), title, attacker (A1 to A7), grade, path from attacker to effect, `file:line`, and a suggested test. Reviewers write to `.superpowers/sdd/2026-11-11-security-audit/area-<n>.md` (git-ignored).
3. **Confirmation.** The implementer checks each finding against the code. Confirmed means a failing test reproduces it, or, where a test cannot (for example a Windows ACL in the Linux cloud), a written argument from the code plus an entry for the native checklist. A rejected finding gets its reason in the report.
4. **Fix.** Critical, High and Medium: RED test, fix, GREEN, full suite. Low: report entry and a GitHub issue (English, no secrets).
5. **Gate script** `scripts/verify-4.18.26-security-gate.mjs` runs every regression test from step 4 and `npm audit --omit=dev --audit-level=high`, and fails if any confirmed Critical, High or Medium finding in the report is not marked fixed.
6. **Branch checks.** `/security-review` over the branch diff, then one fresh whole-branch reviewer as in earlier blocks; their findings are handled by the same rules.
7. **Report** `docs/SECURITY-AUDIT-4.18.26.md` (English, in the repo) with every finding, its grade, status (fixed / Low with issue / rejected) and evidence, and a German summary for Rafiki in `/mnt/project-files/block-20/`. Neither contains a secret or a working exploit against a live system; reproduction lives in the tests.

## Global constraints

- Version 4.18.26; preflight `scripts/preflight-4.18.26.mjs` keeps every earlier gate and adds the security gate.
- Node ≥ 22, ESM, `node:test`; tests run as a non-root user with `umask 022`.
- No new runtime dependency unless a fix cannot be written without one.
- Fixes keep existing behaviour visible to the admin unless the behaviour is the vulnerability; every such change is listed in the changelog.
- English on GitHub and in the repository; German for Rafiki.

## Review focus

- A3 against `127.0.0.1:8787`: a request without a matching Origin/Host or without the session token must not change anything.
- A2 on every route: the permission each route requires matches what it does, including routes added in Blocks 15 to 19.
- A5 paths: archive entries, plugin names and config values that contain `..`, absolute paths, symlinks or NUL.
- A6 output: remote output reaches logs, the UI and the audit only after redaction and length limits.
- Secrets in errors: an error message or audit entry never carries a password, token or key, including on failure paths.

## Gate

- Every area reviewed by its own reviewer, every finding confirmed or rejected with a reason.
- No confirmed Critical, High or Medium finding open; each fixed one has a test that failed before the fix.
- `npm run preflight` (4.18.26, with the security gate) passes; full suite passes as non-root; `npm run build` passes; CI green.
- `/security-review` over the branch and the final reviewer leave no open Critical, High or Medium finding.

What the gate does not prove: Windows ACL behaviour, a real sshd and core, and Electron on a desktop are checked in the cloud only by tests and code reading. Findings that need a native check go to `docs/WSL-NATIVE-CHECKLIST.md`.
