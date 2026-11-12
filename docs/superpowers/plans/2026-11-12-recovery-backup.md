# Recovery and backup (Block 21, 4.18.27) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every critical change to a local instance, a remote instance or the standard server captures a restore point first, verifies the result and rolls back by itself on failure; the operator can list, check, create and restore points.

**Architecture:** One storage module (`lib/restore-points.mjs`) writes, reads and verifies points and keeps the per-subject recovery mark. One flow helper (`lib/restore-guard.mjs`) runs capture → change → verify → rollback. Adapters per subject decide which files belong to which part and how to put them back: `lib/instance-restore-points.mjs` (local instance), the existing backup code of `lib/remote-instance-manager.mjs` (remote) and `lib/archive-install.mjs` (installer). Existing services call the guard inside the locks they already hold.

**Tech Stack:** Node ≥ 22.12 ESM, `node:test`, React panels, existing `adm-zip`/`tar`. No new npm dependency.

**Spec:** `docs/superpowers/specs/2026-11-12-recovery-backup-design.md` (approved 2026-11-12)

## Global Constraints

- No secret in a point, manifest, audit entry or API result: never capture the vault, `b3/b3.xml`, `b3/plugin_auth.ini`, a DSN or an RCON password.
- New error codes only: `RESTORE_POINT_FAILED`, `RESTORE_POINT_INVALID`, `RESTORE_POINT_NOT_FOUND`, `RESTORE_POINT_TOO_LARGE`, `RESTORE_POINT_CONFIRMATION_REQUIRED`, `RESTORE_POINT_CODE_PERMISSION`, `RECOVERY_REQUIRED`, `INSTANCE_CORE_INVALID` (existing), `INSTANCE_CORE_UNCHANGED`. Existing codes stay unchanged.
- Limits: 256 MiB (268435456 bytes) per point; 20 automatic and 10 manual points per subject; a point named in the recovery mark is never pruned.
- Subjects: `local:<id>`, `remote:<id>` (id as `validId` of the stores), `default-runtime`. On disk the directory is the subject with `:` replaced by `_`. Point IDs: `YYYYMMDDTHHMMSSZ-<8 hex>` (same shape as remote `BACKUP_ID`).
- Storage: `<data>/restore-points/<subjectDir>/<pointId>/manifest.json` + `files/<part>/<name>`; directories 0700, files 0600; written into `<subjectDir>/.tmp-<uuid>` and renamed.
- B3 database confirmation text, exact: `B3-DATENBANK ZURÜCKSETZEN`.
- Permissions: list/integrity/manual point `config.manage`; restore `config.manage`, plus `server.code` when the point restores `plugins`, `core`, `files` or `b3files` entries under `extplugins/`; local core change `server.code`; remote core rollback `update.execute`.
- A change whose verify passes behaves as before: existing tests are only extended, never edited to pass.
- Version 4.18.27; the 4.18.26 gates stay in the preflight chain. Tests run as a non-root user with `umask 022`.

## Review Focus

1. A manifest names `../x`, an absolute path, a part that does not exist for the subject, or a file whose bytes no longer match: read and restore refuse with `RESTORE_POINT_INVALID` and write nothing. Tests in Task 1 and Task 3.
2. A newly installed plugin or a new B3 custom plugin exists when a point taken before it is restored: the extra file is moved to `.removed` (CoD4x) or `extplugins/.removed` (B3), not left active and not deleted. Test in Task 3.
3. The change throws half-way (after writing some files): rollback leaves every captured part byte-identical to the state before. Tests in Tasks 4, 6, 7, 8.
4. A start (`launch`, B3 start, remote start) while the subject carries `RECOVERY_REQUIRED` is refused; a successful restore clears it. Tests in Tasks 4 and 8.
5. Point capture fails (disk full simulated by a throwing writer, size above the limit): the change does not run and the state is untouched. Test in Task 2.
6. Restore without `includeB3Database` or with a wrong confirmation never calls the database helper. Test in Task 6.

---

## File structure

| File | Responsibility |
|---|---|
| `lib/restore-points.mjs` (new) | `RestorePointStore`: write, list, read+verify, prune, recovery mark. Pure filesystem, no knowledge of instances. |
| `lib/restore-guard.mjs` (new) | `guardedChange()` flow and the error shape. |
| `lib/instance-restore-points.mjs` (new) | Local instance parts: collect files, put them back, record handling. |
| `lib/archive-install.mjs` (new) | `listArchiveEntries`, `extractArchive` (moved from `installer-server.mjs`), `installArtifacts` with restore point. |
| `lib/server-instance-store.mjs` | `replaceRecord(id, record)`, `setCore(id, serverCore)`. |
| `lib/server-instance-manager.mjs` | Guard config/plugin changes, `changeCore`, restore-point API, recovery block in `launch`. |
| `lib/instance-b3-plugin-service.mjs`, `lib/instance-b3-database-service.mjs`, `lib/instance-b3-service.mjs` | Guard B3 plugin changes and migration; database restore; recovery block on B3 start. |
| `lib/remote-instance-manager.mjs`, `lib/remote-linux-routes.mjs` | `action`/`core` in backup manifests, `rollbackCore`, recovery mark. |
| `installer-server.mjs` | Wiring, routes, installer guard. |
| `lib/restore-points-panel.jsx` (new), `lib/remote-hosts.jsx`, `cod4x-control-improved.jsx` | UI. |
| `scripts/verify-4.18.27-recovery-gate.mjs`, `scripts/preflight-4.18.27.mjs`, version files | Gate and release bookkeeping. |

---

### Task 1: Restore point storage

**Files:** Create `lib/restore-points.mjs`; Test `test/restore-points.test.mjs`

**Interfaces (produces):**
- `class RestorePointStore({ root, now = () => new Date(), maxBytes = 268435456, maxAutomatic = 20, maxManual = 10 })`
- `validSubject(subject) -> string` (throws `RESTORE_POINT_INVALID`)
- `capture(subject, { action, actor = null, manual = false, entries, data = {}, refs = {} }) -> Promise<{ pointId, manifest }>`; `entries: Array<{ part, name, bytes: Buffer }>`, `name` relative with `/` separators; `data`: JSON per part (e.g. `record`); `refs`: JSON per part referring to external files (`b3mysql`, `config` backup ID, `core`). Manifest: `{ version: 1, subject, pointId, action, actor, manual, createdAt, parts: string[], files: [{ part, name, bytes, sha256 }], data, refs, totalBytes }`.
- `list(subject) -> Promise<Array<{ pointId, action, manual, createdAt, parts, totalBytes, valid }>>` newest first; an unreadable point is listed `valid: false` without content.
- `read(subject, pointId) -> Promise<{ manifest, file(part, name) -> Buffer }>`: re-hashes every file before returning; applies the checks of `config-engine-storage.mjs` `readBackup` (no link, `nlink === 1`, owner and mode on Linux, size) to the directory and every file.
- `markRecovery(subject, pointId)`, `clearRecovery(subject)`, `recovery(subject) -> { pointId, markedAt } | null` stored in `<subjectDir>/recovery.json`.
- Pruning runs at the end of `capture`: oldest automatic beyond 20, oldest manual beyond 10, never the point in `recovery.json`.

- [ ] **Step 1: Write the failing tests** — `capture then read returns identical bytes and manifest hashes`; `list is newest first and marks a tampered file valid:false`; `read refuses a manifest entry named ../escape, /abs, a\\..\\b and an unknown part with RESTORE_POINT_INVALID`; `capture above maxBytes throws RESTORE_POINT_TOO_LARGE and leaves no directory`; `a capture that throws mid-write leaves no point and no .tmp directory`; `pruning keeps 20 automatic and 10 manual and never the recovery point`; `subjects local:a, remote:a, default-runtime map to distinct directories; local:../x is refused`; on Linux: `group-writable point directory is refused`.
- [ ] **Step 2:** `node --test test/restore-points.test.mjs` → FAIL (module missing).
- [ ] **Step 3:** Implement. Point ID like remote `#saveBackup`; manifest written last inside the temp dir, then one `rename`.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** Commit `4.18.27: restore point storage (Block 21)`.

### Task 2: Guarded change flow

**Files:** Create `lib/restore-guard.mjs`; Test `test/restore-guard.test.mjs`

**Interfaces (produces):**
- `guardedChange({ store, subject, action, actor, capture, change, verify, rollback, audit = () => {} }) -> Promise<{ result, restorePointId }>`
  - `capture() -> Promise<{ entries, data, refs }>`; `change() -> Promise<result>`; `verify(result) -> Promise<void>` (throws on failure); `rollback(point) -> Promise<void>` where `point` is the value of `store.read`.
  - Order: `store.recovery(subject)` set → throw `RECOVERY_REQUIRED`; capture + `store.capture` (any error → `RESTORE_POINT_FAILED`, change not called); `change`; `verify`; on error from change or verify: `rollback(await store.read(...))`, then rethrow the original error with `rolledBack: true, restorePointId`; if rollback throws: `store.markRecovery`, rethrow original error with `rolledBack: false, restorePointId, recoveryRequired: true`.
  - Audit events: `restore_point.created`, `change.verified`, `change.rolled_back`, `change.rollback_failed` with `{ subject, action, restorePointId, code }` only.

- [ ] **Step 1: Tests** — `verify pass returns result and point id, rollback not called`; `change throws → rollback called with the captured point, error carries rolledBack:true and the original code`; `verify throws → same`; `rollback throws → recovery marked, error carries recoveryRequired:true`; `capture throws → change never called, code RESTORE_POINT_FAILED`; `recovery mark present → RECOVERY_REQUIRED, capture never called`.
- [ ] **Step 2–4:** Fail, implement, pass.
- [ ] **Step 5:** Commit.

### Task 3: Local instance parts

**Files:** Create `lib/instance-restore-points.mjs`; Modify `lib/server-instance-store.mjs`; Test `test/instance-restore-points.test.mjs`, extend `test/server-instance-store.test.mjs`

**Interfaces:**
- Consumes: `RestorePointStore` (Task 1), `b3Paths` (`lib/b3-config.mjs`), `pluginExtension`/`discoverPlugins` (`lib/plugin-manager.mjs`).
- Produces:
  - `PARTS_BY_ACTION = { 'config.change': ['record','config'], 'plugin.change': ['record','plugins'], 'b3.plugin.change': ['record','b3files'], 'b3.migration': ['record','b3files'], 'core.change': ['record','core'], manual: ['record','config','plugins','b3files','b3sqlite','core'] }`
  - `collectInstanceParts(instance, parts) -> Promise<{ entries, data, refs }>`: `record` → `data.record = instance`; `config` → `main/server.cfg`; `plugins` → each platform plugin file of `plugins/` (not `.removed/`, not dot files); `b3files` → `b3/database.json`, `b3/plugins/*`, `b3/extplugins/*` (regular files only, no subdirectories, never `b3.xml`/`plugin_auth.ini`); `b3sqlite` → `b3/b3.db` if present; `core` → `refs.core = { executablePath, version, sha256 }`.
  - `restoreInstanceParts(instance, point, parts, { store }) -> Promise<{ restored: string[], skipped: string[] }>`: files written via temp file + rename into the directory the part owns; the target is `path.join(partDir, name)` and must satisfy `contains(partDir, target)` with `path.relative` (as `server-instance-store.mjs`); files in a part directory that are not in the point are moved to `<partDir>/.removed/<name>.<timestamp>`; `record` → `store.replaceRecord(instance.id, point.manifest.data.record)`.
  - `ServerInstanceStore.replaceRecord(id, record)`: `record.id === id` and `record.homePath === current.homePath` else `INSTANCE_RECORD_INVALID`; normalizes plugins, b3Plugins, network, b3Integration as `create`; bumps `b3PluginsRevision` to `max(current, record) + 1`.
  - `ServerInstanceStore.setCore(id, { executablePath, version })`: same checks as `definition` for `serverCore`, then `validatePaths`.

- [ ] **Step 1: Tests** — `collect never includes b3.xml or plugin_auth.ini`; `restore after a plugin was added moves the new file to .removed and restores the old bytes`; `restore with a crafted name ../../main/server.cfg in part plugins is refused before any write`; `replaceRecord refuses another homePath`; `round trip of every manual part is byte-identical`; `setCore refuses a file named other than the platform core`.
- [ ] **Step 2–4:** Fail, implement, pass.
- [ ] **Step 5:** Commit.

### Task 4: Local instance manager integration and local core change

**Files:** Modify `lib/server-instance-manager.mjs`; Test `test/server-instance-restore.test.mjs` (new)

**Interfaces:**
- Constructor gains `restorePoints = null` (a `RestorePointStore`) and `audit = () => {}`. Without a store everything behaves as today.
- `#guard(id, action, { change, verify, actor })` wraps Task 2 with `capture = () => collectInstanceParts(instance, PARTS_BY_ACTION[action])` and `rollback = point => restoreInstanceParts(...)`; used inside the existing `exclusive` blocks:
  - `changeConfiguration` (apply and restore): action `config.change`; verify = existing result `verified` plus `configEngine.read(instance).sha256 === result.sha256`. The config backup ID goes into `refs.config`.
  - `#stoppedPluginChange(id, action)` gets an action label `plugin.change`; verify = `describePlugins` shows no `INTEGRITY_MISMATCH`/`MISSING` for enabled records.
- `changeCore(id, { executablePath, version }, actor)`: `server.code` route; instance and B3 stopped; `INSTANCE_CORE_UNCHANGED` if both equal; action `core.change`; change = `store.setCore`; verify = `store.validatePaths` and version in `policyState.security.allowedCod4xVersions` (passed in as `allowedCoreVersions` constructor option).
- `restorePoints(id)`, `createRestorePoint(id, actor)`, `restorePointIntegrity(id, pointId)`, `restoreRestorePoint(id, pointId, { includeB3Database, confirmation }, auth)`: restore requires stopped instance and B3; captures a safety point (`manual: false`, action `restore.safety`) first; checks code permission as in Global Constraints (`auth.can('server.code')`, else `RESTORE_POINT_CODE_PERMISSION`); b3mysql delegated to Task 6; on success `clearRecovery`.
- `launch` and `InstanceB3Service.start` (via a `recoveryCheck(id)` option) throw `RECOVERY_REQUIRED` when `restorePoints.recovery('local:'+id)` is set.
- `createRestorePoint(id, actor, { includeB3Database })`: with `includeB3Database: true` and a ready MySQL setup, the dump is written by `InstanceB3DatabaseService.dumpForPoint(id)` (Task 6) and referenced as `refs.b3mysql`.

- [ ] **Step 1: Tests** — `config change with failing verify (stub engine) is rolled back byte-identical`; `plugin install whose verify fails removes the new plugin and restores the records`; `core change to a missing file is refused and record unchanged`; `core change verify failure rolls back to old path`; `launch refused with RECOVERY_REQUIRED after a failed rollback; manual restore clears it`; `restore of a point with plugins by an operator without server.code fails with RESTORE_POINT_CODE_PERMISSION`; `restore while running → INSTANCE_RUNTIME_BUSY`.
- [ ] **Step 2–4:** Fail, implement, pass. Re-run `test/server-instance-*.test.mjs` unchanged → PASS.
- [ ] **Step 5:** Commit.

### Task 5: B3 plugin changes

**Files:** Modify `lib/instance-b3-plugin-service.mjs`; Test extend `test/instance-b3-plugin-service.test.mjs`

**Interfaces:** Constructor gains `guard = null`, a function `(id, action, { change, verify }) => Promise<result>` provided by `ServerInstanceManager.guardFor()` (Task 4 exposes `guardFor(id, action)` publicly). `setEnabled`, `saveConfig`, `approve`, `createCustom`, `saveCode`, `deleteCustom` run their body through `guard(id, 'b3.plugin.change', ...)` inside `run(id, ...)`; verify = `this.plan(id)` has no blocker naming the changed plugin.

- [ ] **Step 1: Tests** — `saveCode whose verify fails restores the old code and record`; `createCustom rolled back leaves no active extplugin file`; `without guard behaviour is unchanged` (existing tests stay green).
- [ ] **Step 2–4:** Fail, implement, pass.
- [ ] **Step 5:** Commit.

### Task 6: B3 migration rollback and database restore

**Files:** Modify `lib/instance-b3-database-service.mjs`, `lib/b3-database-helper.mjs`; Test extend `test/instance-b3-database-service.test.mjs`, `test/b3-database-helper.test.mjs`

**Interfaces:**
- `migrate(id, options)` runs through `guard(id, 'b3.migration', ...)`; the dump written today becomes `refs.b3mysql = { path, sha256, tables }`; verify = the existing ready check.
- `restoreDump(id, { path, sha256, tables }) -> Promise<{ statements, dropped }>`: `verifyBackup` first; statements = dump lines after the header, one SQL statement per line, sent with the existing `apply` op in batches of at most 512 KiB; then drops every table named in the audited `CORE_SQL`/`EBC_SQL` (via `statementTable`) that is not in `tables` and exists now (probe). Only files under `<home>/b3/backups/` are accepted.
- `dumpForPoint(id) -> Promise<{ path, sha256, tables }>`: the existing backup call of `migrate`, under the database lock, for a manual point.
- Automatic rollback of a failed migration calls `restoreDump` when a dump exists, otherwise only the drop step.
- Manual restore (Task 4) calls `restoreDump` only when `includeB3Database === true && confirmation === 'B3-DATENBANK ZURÜCKSETZEN'`, else `RESTORE_POINT_CONFIRMATION_REQUIRED` when `includeB3Database` is true with another text; with `includeB3Database` false the part is reported in `skipped`.

- [ ] **Step 1: Tests** (fake helper) — `failed migration replays the dump and drops created tables`; `dump with a changed byte is refused before any apply call`; `dump path outside b3/backups is refused`; `manual restore without confirmation never calls the helper`; `batches never exceed 512 KiB`.
- [ ] **Step 2–4:** Fail, implement, pass.
- [ ] **Step 5:** Commit.

### Task 7: Server update (installer) with restore point

**Files:** Create `lib/archive-install.mjs`; Modify `installer-server.mjs` (`extractArchive`, `installArtifact`, `/api/installer`); Test `test/archive-install.test.mjs`

**Interfaces:**
- `listArchiveEntries(file) -> Promise<Array<{ name, directory, sha256 | null }>>` for zip, tar, tar.gz, single file; names checked with the existing `assertSafeChildPath` rule (moved here and re-exported to `installer-server.mjs`).
- `extractArchive(file, destination)` (moved unchanged).
- `installArtifacts({ artifacts: string[], target, store, actor, audit }) -> Promise<{ restorePointId, files: number }>`: artifacts are already downloaded and SHA-256-checked; capture = existing target files that any entry would overwrite (`part: 'files'`) + `refs.files.created` = entries that do not exist yet + `data.record` = runtime state passed in; change = extract all; verify = every non-directory entry's file hash equals the entry hash; rollback = write back captured files, remove created files and then empty directories created by the change. Subject `default-runtime`.
- `/api/runtime/config` runs through `guardedChange` with subject `default-runtime`, action `core.change`, `data.record` = runtime state; verify = executable exists and BaseGame valid (existing checks); rollback = previous runtime state persisted again.
- `/api/installer` (non dry-run) downloads and verifies all artifacts first, then calls `installArtifacts`; the response adds `restorePointId`.

- [ ] **Step 1: Tests** — `zip overwriting two files and creating one rolls back byte-identical when verify fails`; `tar.gz same`; `entry ../evil is refused before any write`; `success writes the files and returns a restore point id`.
- [ ] **Step 2–4:** Fail, implement, pass. Re-run tests that cover the installer (`grep -l "api/installer" test/`) → PASS.
- [ ] **Step 5:** Commit.

### Task 8: Remote instances

**Files:** Modify `lib/remote-instance-manager.mjs`, `lib/remote-linux-routes.mjs`; Test extend `test/remote-instance-files.test.mjs`, `test/remote-linux-http.test.mjs`

**Interfaces:**
- `#saveBackup(instance, configBuffer, action = 'config.change')`: manifest gains `action` and `core: { version, sha256, previousSha256 | null }`; `#verifiedBackup` accepts manifests with and without these fields.
- `updateCore` saves a backup with action `core.update` before the upload, records `previousSha256` = hash of the kept `.previous`; when the existing in-place rollback fails, `restorePoints.markRecovery('remote:'+id, backupId)`.
- `rollbackCore(id) -> Promise<{ core }>`: instance stopped; `.previous` must exist and its SHA-256 must equal the newest `core.update` backup's `core.previousSha256` (else `REMOTE_BACKUP_INVALID`); swap via rename, `validateExecutable`, `instances.setCore(id, backup core)`; on success `clearRecovery`.
- `start`/`restart` refuse with `RECOVERY_REQUIRED` while the mark is set. `listBackups` entries add `action`.
- Route `POST /api/remote-instances/:id/core/rollback` with `update.execute`, added to the route/permission table at the end of the file.

- [ ] **Step 1: Tests** (fake transport) — `rollbackCore restores the previous core and version`; `rollbackCore refuses a .previous whose hash differs`; `failed in-place rollback marks RECOVERY_REQUIRED and start is refused`; `old manifests without action still list and restore`.
- [ ] **Step 2–4:** Fail, implement, pass.
- [ ] **Step 5:** Commit.

### Task 9: Routes, wiring and UI

**Files:** Modify `installer-server.mjs`, `lib/remote-hosts.jsx`, `cod4x-control-improved.jsx`; Create `lib/restore-points-panel.jsx`; Test `test/restore-points-http.test.mjs`

**Interfaces:**
- `const restorePointStore = new RestorePointStore({ root: dataPath("data", "restore-points") })`, passed to `ServerInstanceManager`, `InstanceB3DatabaseService`, `RemoteInstanceManager`, and the installer.
- Routes (local subject id from `:id`; `default-runtime` under `/api/runtime/restore-points`): `GET /api/instances/:id/restore-points` (`config.manage`), `POST /api/instances/:id/restore-points` (`config.manage`), `GET /api/instances/:id/restore-points/:pointId/integrity` (`config.manage`), `POST /api/instances/:id/restore-points/:pointId/restore` (`config.manage`, code check inside), `POST /api/instances/:id/core` (`server.code`), same four for `/api/runtime/restore-points` (restore needs `server.code`). Bodies checked with exact key sets as `b3PluginBody`.
- Panel `RestorePointsPanel({ subjectLabel, api })`: list (time, action, parts, size, valid), buttons "Punkt anlegen", "Prüfen", "Wiederherstellen" with B3 checkbox and confirmation field shown only for points with `b3mysql`; banner for `RECOVERY_REQUIRED`. Local instance view: panel + "Core wechseln" form. Remote panel: action column, "Core zurücksetzen" button, "Recover" button calling the existing `/recover` route. Standard server: panel under the installer.
- Security gate route list (`scripts/verify-4.18.26-security-gate.mjs` reads routes) stays green: every new route has a permission.

- [ ] **Step 1: Tests** (HTTP, as `test/runtime-http-integration.test.mjs`) — `operator without server.code gets 403 on /core and RESTORE_POINT_CODE_PERMISSION on a plugin restore`; `unknown body keys are refused`; `restore response never contains file contents`.
- [ ] **Step 2–4:** Fail, implement, pass. `npm run build` (as repo owner) → exit 0.
- [ ] **Step 5:** Commit.

### Task 10: Gate, version 4.18.27, docs

**Files:** Create `scripts/verify-4.18.27-recovery-gate.mjs`, `scripts/preflight-4.18.27.mjs`, `scripts/verify-4.18.27-runtime.mjs`, `scripts/verify-4.18.27-version.mjs`, `CHANGELOG-4.18.27.md`; Modify `package.json`, `package-lock.json`, `BUILD_INFO.json`, `DEVELOPMENT_STATUS.md`, `README.md`, `build.ps1`, `cod4x-control-improved.jsx` (version string), `COD4X-CONTROL-ROADMAP.md`, `docs/WSL-NATIVE-CHECKLIST.md`

- Gate: for config change, plugin install, B3 migration (fake helper), server update (zip fixture), local core change and remote core update (fake transport): inject a verify failure, assert `rolledBack: true` and byte-identical parts; then a manual restore with and without the B3 confirmation; then the `RECOVERY_REQUIRED` path. Prints `Block 21 recovery gate PASS` and exits 0, else non-zero.
- Preflight 4.18.27 = preflight 4.18.26 chain + the new gate; the 4.18.26 runtime/version scripts stay in the chain via their 4.18.27 successors as in earlier blocks.
- Native checklist section: real core, config change + plugin install rolled back, server starts afterwards; B3 migration restore against real MySQL; Windows plugin DLL restore with the server stopped.

- [ ] **Step 1:** Write the gate; run it → FAIL before wiring, PASS after Tasks 1–9.
- [ ] **Step 2:** Version bump; `npm run preflight` → exit 0; full `node --test` as non-root with `umask 022` → 0 FAIL.
- [ ] **Step 3:** Commit `4.18.27: recovery and backup (Roadmap Block 21)`.
