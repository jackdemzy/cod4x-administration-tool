# Security audit (Block 20, 4.18.26) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit every reachable part of CONTROL area by area with independent reviewers, fix every confirmed Critical, High and Medium finding test-first, document every Low, and close Block 20 with a gate that proves nothing blocking is open.

**Architecture:** The audit itself is driven by a machine-readable report (`docs/SECURITY-AUDIT-4.18.26.md`) whose findings table a small parser reads; the security gate fails while any blocking finding is open or any area is unreviewed, and re-runs every regression test the report names. Six area tasks each dispatch one fresh read-only reviewer, then the implementer confirms, fixes and records. Version 4.18.26 wires the gate into preflight at the end.

**Tech Stack:** Node ≥ 22 ESM, `node:test`, existing gate/preflight script pattern, Agent tool for reviewers (most capable model), `/security-review`, GitHub MCP for Low issues.

**Spec:** `docs/superpowers/specs/2026-11-11-security-audit-design.md`

## Global Constraints

- Version 4.18.26; preflight `scripts/preflight-4.18.26.mjs` keeps every earlier gate and adds the security gate.
- Node ≥ 22, ESM, `node:test`; tests run as a non-root user with `umask 022` (cloud: wrapper `/usr/local/bin/t '<cmd>'`; `npm run build` as repo owner).
- No new runtime dependency unless a fix cannot be written without one.
- Fixes keep existing behaviour visible to the admin unless the behaviour is the vulnerability; every such change is listed in the changelog.
- English on GitHub and in the repository; German for Rafiki.
- Critical, High and Medium are fixed in Block 20; Low is documented and opened as a GitHub issue.
- Neither the report nor the issues contain a secret or a working exploit against a live system; reproduction lives in the tests.
- No force push; after a merge, merge main into the branch.

## Review Focus

(For the audit tooling of Task 1; the spec's own review focus for the product goes verbatim into every reviewer brief.)

- A title cell that contains an escaped pipe `\|` or backticks must not shift the columns; the row still parses with the right grade and status.
- Grade or status written in another case (`high`, `Fixed`) must be read case-insensitively, and an unknown grade must fail the gate instead of being ignored.
- A finding marked `fixed` whose evidence names a test file that does not exist must fail the gate.
- A missing report file must fail the gate with a clear message, not crash with a stack trace.
- `npm audit` failing for lack of network must fail the gate and say it was the network, not report "no vulnerabilities".

---

### Task 1: Audit report format, parser and security gate

**Files:**
- Create: `scripts/security-audit-report.mjs`
- Create: `scripts/verify-4.18.26-security-gate.mjs`
- Create: `docs/SECURITY-AUDIT-4.18.26.md` (skeleton)
- Test: `test/security-audit-report.test.mjs`

**Interfaces:**
- Produces: `parseAuditReport(markdown: string) -> { areas: Array<{ number: 1..6, reviewed: boolean }>, findings: Array<{ id: string, title: string, attacker: string, grade: 'Critical'|'High'|'Medium'|'Low', status: 'fixed'|'rejected'|'open'|{ issue: number }, evidence: string[] }> }`; throws `Error` with `code = 'AUDIT_REPORT_INVALID'` on an unknown grade or status.
- Produces: `gateProblems(report, { exists: (path) => boolean }) -> string[]`; empty array means the report passes.
- Report format (exact): one `## Area <n> – <name>` heading per area 1..6, each followed by a line `Reviewed: yes` or `Reviewed: no`; one findings table with header `| ID | Title | Attacker | Grade | Status | Evidence |`; ID matches `A[1-6]-\d+`; status cell is `fixed`, `rejected`, `open` or `issue #<n>`; evidence lists test files in backticks.

- [ ] **Step 1: Write the failing tests** in `test/security-audit-report.test.mjs`:
  - `parses areas and findings` — a report with all six areas reviewed and rows `A1-1 High fixed \`test/a.test.mjs\``, `A2-1 Low issue #45`, `A3-1 Medium rejected` → 6 areas `reviewed: true`; three findings with those grades, statuses (`{ issue: 45 }` for the second) and evidence `['test/a.test.mjs']`.
  - `escaped pipe in title keeps the columns` — title `uses \| in shell` → grade and status still correct.
  - `grade and status are case-insensitive` — `high` / `Fixed` → `'High'` / `'fixed'`.
  - `unknown grade throws AUDIT_REPORT_INVALID` — grade `Severe`.
  - `gateProblems` cases, each asserting one problem string that names the finding or area: open Medium; open High; Low with `open` (needs an issue); fixed finding without evidence; fixed finding whose evidence file `exists()` returns false for; area 4 `Reviewed: no`; area 6 missing. And: a clean report → `[]`.

- [ ] **Step 2: Run** `t 'node --test test/security-audit-report.test.mjs'` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `parseAuditReport` and `gateProblems` in `scripts/security-audit-report.mjs` (split table cells on unescaped `|` only; trim; strip backticks from evidence).

- [ ] **Step 4: Run** the same command — Expected: PASS, all cases.

- [ ] **Step 5: Write** `scripts/verify-4.18.26-security-gate.mjs`: read `docs/SECURITY-AUDIT-4.18.26.md` (missing file → print `Security gate FAIL: report docs/SECURITY-AUDIT-4.18.26.md missing` and exit 1); print each `gateProblems` line and exit 1 if any; run `node --test` on the union of all `fixed` evidence files plus `test/security-audit-report.test.mjs`; run `npm audit --omit=dev --audit-level=high` and fail on non-zero exit, printing `npm audit failed (network?)` when its output has no JSON/advisory text; end with `Security audit gate PASS (<n> findings, <m> fixed)`.

- [ ] **Step 6: Write** the skeleton report: title, link to the spec, threat model and severity sections copied from the spec by reference (one line each: "see spec"), six area headings with `Reviewed: no`, the empty findings table, a section "Rejected findings" and a section "Native checks". Run `t 'node scripts/verify-4.18.26-security-gate.mjs'` — Expected: FAIL listing six unreviewed areas.

- [ ] **Step 7: Commit** `scripts/security-audit-report.mjs scripts/verify-4.18.26-security-gate.mjs docs/SECURITY-AUDIT-4.18.26.md test/security-audit-report.test.mjs` — message `4.18.26: security audit report format and gate (Block 20)`.

### Tasks 2–7: Area audits

One task per area, in this order (area numbers and files from the spec's "Areas" table): **Task 2 = Area 5 Remote access and admin API** (largest outside exposure first), **Task 3 = Area 2 Secrets**, **Task 4 = Area 1 Local runtime**, **Task 5 = Area 4 Remote Linux** (includes the inherited `status()` lock item and the missing Recover button, the latter for security impact only), **Task 6 = Area 3 B3**, **Task 7 = Area 6 Electron and dependencies** (includes `npm audit --omit=dev`). Each runs the same steps.

**Files:**
- Read-only for the reviewer: the area's files from the spec.
- Create: `.superpowers/sdd/2026-11-11-security-audit/area-<n>.md` (reviewer output, git-ignored)
- Modify: the files each confirmed finding needs; `docs/SECURITY-AUDIT-4.18.26.md`
- Test: one new test file per fixed finding or per fixed group in the same module, named `test/security-<area-slug>-<topic>.test.mjs`

**Interfaces:**
- Consumes: report format from Task 1.
- Produces: report rows `A<n>-<k>` and `Reviewed: yes` for the area; a list of Low findings for Task 8.

- [ ] **Step 1: Dispatch the reviewer** (Agent tool, `subagent_type: general-purpose`, `model: fable` (most capable available), foreground) with the fixed brief below, filling in `<n>`, the area name, its files and roadmap items. The reviewer may only read files and run read-only commands; it writes nothing but its answer. Save the answer verbatim to `area-<n>.md`.

  Brief (fixed copy):
  > You are an independent security reviewer for COD4X CONTROL (repo at the current directory), auditing **Area <n> – <name>** only. Read `docs/superpowers/specs/2026-11-11-security-audit-design.md` sections "Threat model", "Severity" and "Review focus" first; they are binding. Your files: <files>. Roadmap items to check: <items>. You may read any other file you need. Do not modify anything.
  > Standard (as /security-review): report only what an attacker A1–A7 from the spec can actually exploit, with a concrete path from the attacker's position to the effect. No style remarks. Hardening without an attack path may be listed separately as "Low candidates". Prefer few findings with high confidence; say how confident you are (high/medium).
  > For each finding give: `A<n>-<k>`, title, attacker, grade (Critical/High/Medium/Low per the spec), the path step by step, `file:line` of the flaw, and a test that would reproduce it (which function or route, which input, what wrong result). End with "Checked, nothing found:" listing each roadmap item and review-focus line you checked without a finding.

- [ ] **Step 2: Confirm each finding.** For each `A<n>-<k>`: re-grade by effect against the spec; write the reproducing test; run it with `t 'node --test <file>'` — Expected: FAIL showing the attack works. If it passes, or the path is wrong, mark the finding `rejected` with the reason. Findings that cannot be tested in the cloud (Windows ACLs, real desktop Electron) are confirmed by code argument and get a "Native checks" entry.

- [ ] **Step 3: Fix Critical, High and Medium.** Smallest change that removes the path; run the finding's test — Expected: PASS; then the full suite `t 'npm test > /tmp/claude-0/suite.log 2>&1; tail -15 /tmp/claude-0/suite.log'` — Expected: 0 fail. Any behaviour the admin sees that changes is noted for the changelog.

- [ ] **Step 4: Record** every finding in the report table (fixed with evidence test file; rejected with reason in "Rejected findings"; Low with status `open` until Task 8 opens the issue), set `Reviewed: yes`, and copy the reviewer's "Checked, nothing found" list under the area heading.

- [ ] **Step 5: Commit** the fixes, tests and report — message `4.18.26: security audit area <n> (<name>)` with one line per fixed finding id; push.

### Task 8: Low findings as GitHub issues

**Files:**
- Modify: `docs/SECURITY-AUDIT-4.18.26.md`

**Interfaces:**
- Consumes: Low rows with status `open` from Tasks 2–7.

- [ ] **Step 1: Open one GitHub issue per Low finding** (`mcp__github__issue_write`, English, title `Security audit 4.18.26: <finding title> (<id>)`, body: area, attacker, why Low, where, suggested fix; no secret, no exploit steps against a live system; footer per session rules).
- [ ] **Step 2: Set** each row's status to `issue #<number>`; run `t 'node scripts/verify-4.18.26-security-gate.mjs'` — Expected: `Security audit gate PASS`.
- [ ] **Step 3: Commit** `docs: link Low findings to issues (security audit 4.18.26)`; push.

### Task 9: Version 4.18.26 and preflight

**Files:**
- Create: `scripts/preflight-4.18.26.mjs` (copy of 4.18.25 with version checks updated, plus the security gate), `scripts/verify-4.18.26-runtime.mjs` (copy of 4.18.25 with version strings and block name `Security audit`), `CHANGELOG-4.18.26.md`
- Modify: `package.json` (version, `preflight` script), `package-lock.json` (version fields), `BUILD_INFO.json` (`version: "4.18.26"`, `validation: "preflight-4.18.26"`, `block: "Security audit"`), `cod4x-control-improved.jsx` (two version strings), `build.ps1`, `DEVELOPMENT_STATUS.md`, `COD4X-CONTROL-ROADMAP.md` (status line under Block 20), `README.md`, `SECURITY.md` (link to the report), `docs/WSL-NATIVE-CHECKLIST.md` (section for Block 20 native checks from the report)

- [ ] **Step 1: Bump** all files above; changelog lists every fixed finding by id and every admin-visible behaviour change.
- [ ] **Step 2: Run** `t 'npm run preflight > /tmp/claude-0/pre.log 2>&1; echo exit $?; tail -20 /tmp/claude-0/pre.log'` — Expected: `exit 0` and `Security audit gate PASS` in the output.
- [ ] **Step 3: Run** the full suite as in Task 2 Step 3 and `npm run build` as repo owner — Expected: 0 fail; build exit 0.
- [ ] **Step 4: Commit** `4.18.26: version, preflight with security gate, changelog (Roadmap Block 20)`; push.

### Task 10: Branch checks, report, pull request

**Files:**
- Modify: `docs/SECURITY-AUDIT-4.18.26.md`, any file a branch-check finding needs
- Create: `/mnt/project-files/block-20/sicherheitsaudit-block-20.md` (German summary for Rafiki)

- [ ] **Step 1: Run `/security-review`** over the branch (diff against `main`). Each finding goes through Task 2 Steps 2–4 with id `B-<k>`.
- [ ] **Step 2: Final whole-branch review**: one fresh reviewer (most capable model) with superpowers:requesting-code-review's code-reviewer brief, the spec, this plan and the report. Critical/Important findings: one fix pass, each RED→GREEN plus full suite; Minor: listed in the German summary.
- [ ] **Step 3: Re-run** preflight, suite and build — Expected: as in Task 9.
- [ ] **Step 4: Write** the German summary: per area what was checked, every finding with grade and status, behaviour changes, what was not run natively, open issues/PRs per CLAUDE.md.
- [ ] **Step 5: Open a draft PR** (English, repo PR template if any, body ending with the session attribution), subscribe to its activity, request `@codex review` and `@codex security review` as `SECURITY.md` requires; mark ready when CI is green.
