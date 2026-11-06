# B3 <-> CoD4x Integration (Block 16) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CONTROL hands the RCON password to B3 and wires `b3hide` (core) and `auth` (B3) together behind one switch, with optional `!auth` passwords from the vault. Every gap blocks the start with a precise code.

**Architecture:**
- A pure plan function (`planB3Integration`) decides everything once.
- The server launch passes the plan's b3hide dvars through the existing plugin path. The B3 start writes `b3.xml` (RCON password, auth entry) and `plugin_auth.ini` inside the existing vault scope.
- The status parser learns the b3hide `status` format, which the run's plugin state selects.
- API, health row and UI sit on top.

**Tech Stack:** Node >= 22.12 ESM with `node:test`, Express 5, React 19. The native gate uses the CoD4x 21.2 Linux core, the release `b3hide.so`, eBc-B3 9096624 with Python 2.7 and MariaDB in WSL `COD4X-Test`.

**Spec:** `docs/superpowers/specs/2026-11-06-b3-cod4x-integration-design.md`

## Global Constraints

- **Version and branch:** 4.18.20 on `control-4.18.20`. All repo text is in English; UI strings are German and English.
- **Settings:**
  - Stored on the instance record as `b3Integration: { hideCommands: false, prefix: '!', hideLevel: 20 }`.
  - Prefix: exactly one character from `!@#$%&*.,:?=~-`.
  - Hide level: one of `1, 2, 20, 40, 60, 80, 100`.
- **b3hide dvars:**
  - `b3Prefix` = prefix, `b3Hide` = `'1'`, `b3HideLvl` = String(hideLevel), passed after `+loadPlugin b3hide`.
  - Known release hashes: `b3hide.so` `f277087c8817c927ca28e96171c8a729ad319f3739cc360c8d3d74899b918a30`, `b3hide.dll` `51fadd9ae0be0bb8855d37a56b53a04b289be775c9fdc38fe256e1f7cb8969bb`. They are only a hint: approval stays manual.
- **Vault kind `b3auth`:**
  - JSON `{ "<level>": "<password>" }`, levels as above.
  - Password: `^[\x21-\x7e]{4,64}$` and none of `"`, `;`, `\`, `<`, `>`, `&`.
- **RCON:** a blocker only when `hideCommands` is on. Otherwise a missing password is the warning `RCON_PASSWORD_MISSING`, and B3 starts as today.
- **Files:** `b3/b3.xml` and `b3/plugin_auth.ini` are written atomically with mode 0600. On a failed start or vault lock both previous contents are restored.
- **Codes:**
  - `B3HIDE_MISSING`, `B3HIDE_NOT_APPROVED`, `B3HIDE_INTEGRITY_FAILED`, `B3HIDE_WRONG_PLATFORM`, `B3HIDE_NOT_LOADED`
  - `RCON_PASSWORD_MISSING`, `VAULT_LOCKED`
  - `B3_AUTH_PLUGIN_MISSING`, `B3_PREFIX_INVALID`, `B3_HIDE_LEVEL_INVALID`
  - `B3_INTEGRATION_BUSY`, `B3_INTEGRATION_CONTROLLED`, `B3_AUTH_PASSWORD_INVALID`
  - Each has a German and an English message.
- **Audit:** `b3.integration.configured` `{ instanceId, actor, hideCommands, prefix, hideLevel }`; `b3.auth.password.set` and `b3.auth.password.cleared` `{ instanceId, actor, level }`. Never a password.
- **Permissions:** reads need `diagnostics.read`; changes need `config.manage`. No gateway route.
- **Tests:** every new test file is registered in `scripts/preflight-4.18.20.mjs`.

## Review Focus

1. **Vault locks between writing and starting:** the B3 start must leave no password-bearing file behind. Task 4 tests that both files are restored, `b3.xml` and `plugin_auth.ini`, including the case where `plugin_auth.ini` did not exist before (it is removed).
2. **Switch on while b3hide is approved but its file changed afterwards:** the launch must block with `B3HIDE_INTEGRITY_FAILED` and spawn nothing. Task 5.
3. **Operator edits b3hide dvars in the plugin manager while the switch is on:** refused with `B3_INTEGRATION_CONTROLLED`. Turning the switch off unlocks them again. Task 5.
4. **b3hide status with a 15-character truncated colour name and a bot:** the parser must not shift columns. A ping-0 human row must not be treated as connecting. Task 6.
5. **`!auth` passwords containing XML or INI metacharacters:** they are rejected at input (`B3_AUTH_PASSWORD_INVALID`) and never reach a file or audit entry. Tasks 2 and 3.

---

### Task 1: Integration plan

**Files:**
- Create `lib/b3-integration.mjs` and `lib/b3-integration-messages.mjs` (de/en messages for every code above).
- Test: `test/b3-integration.test.mjs`.

**Produces:**
- `B3_HIDE_LEVELS = [1, 2, 20, 40, 60, 80, 100]`, `B3_PREFIX_CHARS = '!@#$%&*.,:?=~-'`.
- `KNOWN_B3HIDE_HASHES = { linux: 'f277…', windows: '51fa…' }` (full values from Global Constraints).
- `normalizeB3Integration(input) -> { hideCommands, prefix, hideLevel }`. Missing fields take the defaults. Invalid values throw `B3_PREFIX_INVALID` / `B3_HIDE_LEVEL_INVALID`.
- `planB3Integration({ settings, b3hideState, authPluginPresent, credentialsPresent: { rcon: boolean, b3authLevels: number[] } }) -> plan`. `b3hideState` is the plugin-manager state string for b3hide (`ENABLED`, `DISABLED`, `NOT_APPROVED`, `INTEGRITY_MISMATCH`, `MISSING`, `WRONG_PLATFORM`, or `null` when there is no record or file).
- The plan is `{ enabled, b3hide: { b3Prefix, b3Hide: '1', b3HideLvl } | null, auth: { enabled, passwordLevels }, rcon: { required, present }, blockers: [{ code }], warnings: [{ code }], fingerprint }`.
- `b3IntegrationMessage(code, lang)`.

- [ ] Write the failing tests:
  - With the switch off: `b3hide` null, `auth.enabled` false, no blockers. A missing RCON password gives `warnings` `[{ code: 'RCON_PASSWORD_MISSING' }]`.
  - With the switch on and b3hide `ENABLED` or `DISABLED`, RCON present and auth present: no blockers, dvars `{ b3Prefix: '!', b3Hide: '1', b3HideLvl: '20' }`. `DISABLED` is fine because the switch enables it.
  - Switch on, one blocker each:
    - b3hide state `null` gives `B3HIDE_MISSING`; `NOT_APPROVED`, `INTEGRITY_MISMATCH`, `WRONG_PLATFORM` give the matching `B3HIDE_*` codes;
    - RCON missing gives `RCON_PASSWORD_MISSING`;
    - `authPluginPresent: false` gives `B3_AUTH_PLUGIN_MISSING`.
  - `passwordLevels` equals the sorted `b3authLevels` that are in `B3_HIDE_LEVELS`.
  - `normalizeB3Integration` rejects prefixes `'!!'`, `''`, `'a'`, `' '` and `'"'`, and levels `0`, `21`, `'20'` and `101`.
  - The fingerprint is a 64-hex SHA-256. It is equal for equal inputs and changes when the prefix, the level or the switch changes. It never depends on secret values (the inputs carry none).
  - Every code in the constraint list has a non-empty `de` and `en` message.
- [ ] Run `node --test test/b3-integration.test.mjs`. Expected: FAIL (module missing).
- [ ] Implement both files. The fingerprint is SHA-256 over `JSON.stringify([enabled, b3hide, auth, rcon.required])`.
- [ ] Run the tests. Expected: PASS.
- [ ] Commit: `feat(b3-integration): integration plan`.

### Task 2: Settings store and `b3auth` vault kind

**Files:**
- Modify `lib/server-instance-store.mjs` (`setB3Integration`, default and normalization on load) and `lib/instance-credential-service.mjs` (kind `b3auth`, `setB3AuthPassword`).
- Tests: `test/server-instance-store-b3integration.test.mjs` (new) and `test/instance-credential-service.test.mjs`.

**Consumes:** `normalizeB3Integration` and `B3_HIDE_LEVELS` (Task 1).

**Produces:**
- `store.setB3Integration(id, settings) -> instance`. It uses the same exclusive/persist pattern as `setPlugins`. Records without the field read back with the defaults.
- `credentialService.setB3AuthPassword(id, { level, value, expectedSha256 }) -> { level, set: boolean }`. A `value` of `null` clears the level; it fails `VAULT_LOCKED` or `B3_AUTH_PASSWORD_INVALID`.
- `withRuntimeCredentials` now also yields `credentials.b3auth` as an object (empty when unset).
- `instanceStatus(id)` reports `b3auth: { levels: number[] }` and never values.

- [ ] Write the failing tests:
  - The store round-trips `{ hideCommands: true, prefix: '#', hideLevel: 40 }` across a reload, a legacy record gets the defaults, and an invalid prefix is rejected.
  - In the vault:
    - setting level 100 then level 20 lists `[20, 100]`, and clearing 100 lists `[20]`;
    - values `'abc'`, 65 characters, `'a b c d'`, `'pa"ss'`, `'pa;ss'`, `'pa\ss'`, `'<pass>'` and `'pa&ss'`, and level 21, all give `B3_AUTH_PASSWORD_INVALID`;
    - a locked vault gives `VAULT_LOCKED`;
    - `withRuntimeCredentials` yields `b3auth` `{ '20': '…' }`;
    - `instanceStatus` contains no password string.
- [ ] Run both test files. Expected: FAIL.
- [ ] Implement. `b3auth` is excluded from the generic `changeCredential` path, which rejects it with `CREDENTIAL_INVALID`.
- [ ] Run the tests. Expected: PASS.
- [ ] Commit: `feat(b3-integration): settings store and b3auth vault kind`.

### Task 3: Config rendering

**Files:**
- Modify `lib/b3-config.mjs` and `lib/b3-manager.mjs` (`redactB3Config` for the ini).
- Test: `test/b3-config-integration.test.mjs` (new).

**Consumes:** the plan from Task 1.

**Produces:**
- `renderB3Config({ instance, paths, gameLog, databaseDsn = null, rconPassword = '', authConfigPath = null })`. With `authConfigPath` it adds `<plugin name="auth" config="<path>"/>` after the admin plugin.
- `b3Paths(instance).authConfig` = `<home>/b3/plugin_auth.ini`.
- `renderAuthConfig({ passwords }) -> string`:
  - `[commands]` with `auth: 0`;
  - `[messages]` with `auth_message`, `auth_done`, `already_done`, `bad_auth`, `no_password`, using the default texts from eBc-B3 `auth.py`;
  - `[passwords]` with `<level>: <password>` for each entry; the section is omitted when there are none.
- `prepareB3Runtime(instance, gLog, { databaseDsn, rconPassword, auth })`, where `auth` is `{ passwords } | null`. It writes `b3.xml` and, when `auth` is set, `plugin_auth.ini`; it removes a stale `plugin_auth.ini` when `auth` is null. Both are written atomically (0600). It returns `{ ...paths, gameLog, sha256, authSha256 }`.
- `redactB3PluginAuth(text)` replaces every value in `[passwords]` with `[redacted]`.

- [ ] Write the failing tests:
  - `b3.xml` contains `<set name="rcon_password">s3cr&amp;t</set>` for the password `s3cr&t`, and the auth entry with the absolute path. Without `authConfigPath` there is no auth entry.
  - The ini has `auth: 0` and `100: hunter22`. The `[passwords]` section is absent without passwords.
  - On POSIX both files have mode `0o600` (skip the mode check on Windows).
  - `prepareB3Runtime` with `auth: null` deletes an existing `plugin_auth.ini`.
  - `redactB3Config` hides `rcon_password`, and `redactB3PluginAuth` hides `100: hunter22` but keeps `auth: 0`.
- [ ] Run `node --test test/b3-config-integration.test.mjs`. Expected: FAIL.
- [ ] Implement. Update the file comment in `b3-config.mjs`, which still says the vault transfer "is Block 16".
- [ ] Run the tests and `node --test test/b3-runtime.test.mjs test/b3-manager.test.mjs`. Expected: PASS.
- [ ] Commit: `feat(b3-integration): render rcon password and auth config`.

### Task 4: B3 start

**Files:**
- Modify `lib/instance-b3-service.mjs` (constructor option `integration`: `{ plan(id) }`) and `installer-server.mjs` (wiring only).
- Test: `test/instance-b3-service.test.mjs`.

**Consumes:** Task 1 plan, Task 2 `credentials.rcon` and `credentials.b3auth`, Task 3 `prepareB3Runtime`.

**Produces:**
- `start(id, restart)`:
  - Computes the plan and fails with the first blocker before any write.
  - With the vault unlocked, it always writes inside `withRuntimeCredentials`: `rconPassword` = `credentials.rcon || ''`, `auth` = `{ passwords: <b3auth limited to plan.auth.passwordLevels> }` when `plan.auth.enabled`. On abort it fails `VAULT_LOCKED`.
  - With the vault locked: a SQLite instance with the switch off starts as today without RCON, and everything else fails `VAULT_LOCKED`.
  - The restore covers both files, and a previously absent `plugin_auth.ini` is deleted on restore.
- `startedWith(id) -> { fingerprint, vaultSha256, at } | null`, kept in memory.
- `config(id)` additionally returns `authConfig: { exists, text }`, redacted with `redactB3PluginAuth`.

- [ ] Write the failing tests:
  - With the switch on, RCON set and level 100 set, `b3.xml` holds the RCON password, the ini holds `100:`, and `startedWith` records the plan fingerprint.
  - With the switch on and no RCON, the start fails with `RCON_PASSWORD_MISSING` and nothing is written.
  - A SQLite instance with the switch off and a locked vault starts with an empty `rcon_password`.
  - When the vault aborts after the write, B3 is stopped, `b3.xml` is restored, and an ini that did not exist before is gone.
  - `config()` shows `[redacted]` for the ini password.
- [ ] Run `node --test test/instance-b3-service.test.mjs`. Expected: FAIL.
- [ ] Implement. `installer-server.mjs` builds `integration.plan(id)` from the instance's `b3Integration`, the b3hide state from `describePlugins`, `authPluginPresent` from the B3 dependency source check, and the presence flags from `credentialService.instanceStatus`.
- [ ] Run the tests. Expected: PASS.
- [ ] Commit: `feat(b3-integration): vault-scoped B3 start with rcon and auth`.

### Task 5: Settings changes and server launch

**Files:**
- Modify `lib/server-instance-manager.mjs` (`b3Integration`, `configureB3Integration`, the `configurePlugin` lock, the launch gate) and `lib/plugin-manager.mjs` (export `B3HIDE` record helpers if needed).
- Test: `test/server-instance-manager-b3integration.test.mjs` (new).

**Consumes:** Tasks 1 and 2, and the `b3Service.isRunning(id)` callback.

**Produces:**
- `manager.b3Integration(id) -> { settings, plan, launchedWith, knownHash: boolean }`. `knownHash` is true when the b3hide file's SHA-256 equals the release hash for its platform.
- `manager.configureB3Integration(id, input, actor)`:
  - It requires a stopped server and a stopped B3, otherwise `B3_INTEGRATION_BUSY`.
  - It saves the settings. With `hideCommands` on it sets the registered b3hide record `enabled: true` and its config to the plan dvars; turning it off sets `enabled: false` and keeps the config.
  - It emits audit `b3.integration.configured`.
- `configurePlugin(id, 'b3hide', …)` fails `B3_INTEGRATION_CONTROLLED` while `hideCommands` is on.
- The launch computes the plan before `pluginLaunchArguments`. A `B3HIDE_*`, prefix or level blocker throws before spawn, and RCON is not checked here. After a successful spawn it records `launchedWith(id) = { fingerprint, vaultSha256, at }`.
- `plugins(id)` maps a running instance with b3hide enabled but load `FAILED`/missing to `B3HIDE_NOT_LOADED` in the B3 integration status.

- [ ] Write the failing tests:
  - With b3hide approved and the switch turned on, the record is enabled with config `{ b3Prefix: '!', b3Hide: '1', b3HideLvl: '20' }`, and the audit event has no password field.
  - Changing settings while the server runs gives `B3_INTEGRATION_BUSY`.
  - `configurePlugin('b3hide')` with the switch on gives `B3_INTEGRATION_CONTROLLED`; after switching off it is allowed.
  - The b3hide file is modified after approval and the launch gives `B3HIDE_INTEGRITY_FAILED` with no spawn (spawn stub not called).
  - The launch args contain `+loadPlugin b3hide +set b3Prefix ! +set b3Hide 1 +set b3HideLvl 20`.
  - `knownHash` is true for a file whose content hash is stubbed to the release hash.
- [ ] Run the test file. Expected: FAIL.
- [ ] Implement.
- [ ] Run the tests and `node --test test/plugin-manager.test.mjs test/instance-plugin-manager.test.mjs`. Expected: PASS.
- [ ] Commit: `feat(b3-integration): settings, plugin lock and launch gate`.

### Task 6: b3hide status format

**Files:**
- Modify `lib/rcon-status.mjs` and `lib/instance-rcon-service.mjs` (`online`, `findOnline`, `kick`).
- Tests: `test/rcon-status.test.mjs` and `test/instance-rcon-kick.test.mjs`.
- Fixture: `test/fixtures/cod4x-status-b3hide.txt`, rebuilt from `Cmd_B3Status_f`:
  - a `map:` line, the header `num score ping guid                             name            lastmsg address               qport rate`, and the separator;
  - bot rows (`bot` address, ping 0), and a human with a 15-byte truncated name `^1VeryLongName^7` followed by `^7` padding.

**Produces:**
- `parseStatus(text, { format = 'core' } = {})`. With `format: 'b3hide'` it returns `format: 'b3hide'`, `limits: { nameLength: 15, connectionState: false }`, and players whose `ping` is always numeric and whose `playerid` comes from the guid column.
- The RCON service reads the run's b3hide state through a constructor option `statusFormat(id) -> 'core' | 'b3hide'`. It is `'b3hide'` when b3hide is enabled in the instance's current run.
  - `kick` in b3hide format: the playerid must match; the name compares `cleanName(rawName)` from status with the expected name cut the same way (first 15 bytes of the raw name, then cleaned). Confirmation means the playerid left the slot.
  - `findOnline` uses playerid only.
  - `online()` adds `limits` to its response.

- [ ] Write the failing tests:
  - The fixture parses into bots with numeric ping 0 and the human with the name `VeryLongName` and the correct address and qport.
  - The same text with `format: 'core'` still behaves as before (regression of the existing tests).
  - A kick in b3hide format with a matching playerid sends `clientkick`; a mismatching playerid sends nothing (`RCON_KICK_TARGET_CHANGED`).
  - `online()` returns `limits.connectionState === false`.
- [ ] Run both test files. Expected: FAIL.
- [ ] Implement.
- [ ] Run the tests and the remote actions tests, `node --test test/remote-actions.test.mjs test/remote-actions-http.test.mjs`. Expected: PASS.
- [ ] Commit: `feat(b3-integration): b3hide status format for online list and kick`.

### Task 7: API, health and restart hints

**Files:**
- Modify `installer-server.mjs`, `lib/b3-manager.mjs` (`buildB3Dashboard` row `integration`) and `lib/b3-integration.mjs` (`restartHints`).
- Tests: `test/b3-integration-http.test.mjs` (new) and `test/b3-manager.test.mjs`.

**Consumes:** Tasks 1, 2, 4 and 5.

**Produces:**
- `GET /api/instances/:id/b3/integration` (`diagnostics.read`) returns `{ settings, plan, restart, knownHash, authLevels }`. `authLevels` lists only the levels that are set.
- `POST /api/instances/:id/b3/integration` (`config.manage`) with body `{ hideCommands, prefix, hideLevel }` and exactly these keys.
- `POST /api/instances/:id/b3/integration/auth-password` (`config.manage`) with body `{ level, value, expectedSha256 }`, where `value` is a string or `null`. It audits `b3.auth.password.set` / `…cleared` with the level only.
- `restartHints({ plan, vaultSha256, launchedWith, startedWith }) -> { server: null | 'SETTINGS_CHANGED' | 'CREDENTIALS_CHANGED', b3: same }`. `null` means up to date or unknown (no record).
- The dashboard row `integration` is `{ status: 'OK' | 'OFF' | 'BLOCKED' | 'NOT_CONNECTED', code }`. `OK` needs b3hide loaded, B3 running with the current fingerprint, and the B3 log line showing the auth plugin started.

- [ ] Write the failing tests (real backend as in `test/alerts-http.test.mjs`):
  - Rights:
    - a viewer can GET, but POST gives 403;
    - an operator without `config.manage` gets 403 on both POSTs.
  - Settings:
    - an unknown body key gives 400;
    - a valid POST returns the new plan, and the audit log contains `b3.integration.configured`.
  - Passwords:
    - a password POST with a locked vault gives the `VAULT_LOCKED` code;
    - with an unlocked vault it gives `authLevels: [100]`;
    - the response, audit and log files never contain the password.
  - `restartHints`:
    - a changed fingerprint gives `SETTINGS_CHANGED`;
    - a changed vault SHA gives `CREDENTIALS_CHANGED`;
    - no record gives `null`.
  - The dashboard reports `OFF` with the switch off and `BLOCKED` with the first blocker code.
- [ ] Run both test files. Expected: FAIL.
- [ ] Implement.
- [ ] Run the tests. Expected: PASS.
- [ ] Commit: `feat(b3-integration): API, health row and restart hints`.

### Task 8: UI

**Files:**
- Create `lib/instance-b3-integration.jsx`.
- Modify `lib/instance-b3-runtime.jsx` (mount the section), `lib/instance-plugin-manager.jsx` (read-only b3hide dvars plus the release-hash hint) and `lib/instance-online-players.jsx` (limits hint).
- Tests: `test/instance-b3-integration.test.mjs` (new), `test/instance-plugin-manager.test.mjs` and `test/instance-b3-runtime.test.mjs`.

**Consumes:** the Task 7 API shapes and `b3IntegrationMessage`.

**Produces:**
- `InstanceB3Integration({ data, canManage, lang, onSave, onSetPassword })`. A pure render like the existing components, tested with the same esbuild renderer.
  - It shows the "Hide B3 commands" switch, a prefix input with `maxLength={1}`, and a level select labelled with B3 group names (1 User, 2 Regular, 20 Moderator, 40 Admin, 60 Full admin, 80 Senior admin, 100 Super admin).
  - Each level gets a password row with a write-only `type="password"` input, "set"/"not set", and a remove button.
  - A traffic light shows each requirement and its message, and the restart hints appear when present.
  - Without `canManage` all controls are disabled.
- In the plugin manager, b3hide dvar inputs are disabled with "Controlled by B3 integration" while `hideCommands` is on. The text "Matches the CoD4x 21.2 release" appears when `knownHash`.
- The online list shows "b3hide active: status limited (names cut to 15 characters, no connection state)" when `limits.connectionState === false`.

- [ ] Write the failing tests:
  - the render contains no password value even when the props contain one;
  - the inputs are disabled without `canManage`;
  - each blocker shows its German and English message;
  - the restart hint text is shown;
  - the plugin manager disables the b3hide inputs and shows the release hint;
  - the online list shows the limits hint.
- [ ] Run the three test files. Expected: FAIL.
- [ ] Implement, including the data loading in the existing B3 view (`GET …/b3/integration`).
- [ ] Run the tests and `npm run build`. Expected: PASS, build ok.
- [ ] Commit: `feat(b3-integration): UI`.

### Task 9: Gates, native check, preflight, version 4.18.20

**Files:**
- Create:
  - `scripts/verify-4.18.20-b3-integration-gate.mjs` (source-level, runs everywhere);
  - `scripts/verify-4.18.20-b3-integration-native.mjs` (WSL);
  - `scripts/preflight-4.18.20.mjs`, `scripts/verify-4.18.20-version.mjs` and `scripts/verify-4.18.20-runtime.mjs`, copied from the 4.18.19 ones and bumped;
  - `CHANGELOG-4.18.20.md`.
- Modify `package.json`, `package-lock.json` (lines 3 and 9), `build.ps1`, `BUILD_INFO.json`, the UI version strings, the README note and `DEVELOPMENT_STATUS.md`.

**Native gate** (skips with a clear message when there is no core, release `b3hide.so` or test database):
- The release `b3hide.so` path comes from `COD4X_B3HIDE_SO`, by default `/mnt/c/Users/r4f1k1/cod4x-b3/b3hide-21.2-release/b3hide.so`. Its SHA-256 must equal the release hash, otherwise the gate fails.
- The core comes from `~/core-21.2`. If b3hide does not load there, the gate retries with the core from `COD4X_RELEASE_CORE` (extracted from `cod4x_server-linux_21.2.zip`) and prints which core passed.
- Checks:
  1. The console shows b3hide loaded, and RCON `b3Prefix`, `b3Hide`, `b3HideLvl` read back `!`, `1`, `20`.
  2. RCON `status` parses with `format: 'b3hide'` and lists the 2 bots (`scr_testclients 2`).
  3. B3 is started through `InstanceB3Service` with the generated `b3.xml` (MySQL test database). The B3 log shows the RCON connection, the cod4x parser and the auth plugin started.
  4. RCON `client_checkin 0 100` is accepted (the console prints no usage error). The B3 log shows auth's `Checked in client` for a connecting bot if B3 authenticates bots; otherwise the gate records this sub-check as not applicable.
  5. A verified kick of slot 1 by playerid succeeds and confirms in b3hide format.
  6. The captured output, the B3 logs and the audit file contain neither the RCON nor the `!auth` test password.

- [ ] Write the source gate. It checks the wiring strings: the launch calls `planB3Integration`, `prepareB3Runtime` gets `rconPassword`, the routes are registered with the right permissions, and there is no gateway route containing `b3/integration`. Then run it. Expected: PASS.
- [ ] Bump the version files and run `node scripts/verify-4.18.20-version.mjs`. Expected: PASS.
- [ ] Run `npm run preflight` on Windows. Expected: exit 0, 0 FAIL.
- [ ] Run the native gate and the preflight in WSL with Node 24 (`PATH=$HOME/tools/node-v24.21.0-linux-x64/bin:$PATH`). Expected: exit 0, native check PASS. Record the counts.
- [ ] Write `CHANGELOG-4.18.20.md` and the `DEVELOPMENT_STATUS.md` entry in English. Include the manual open item: hidden chat needs a real client.
- [ ] Commit: `4.18.20: B3 <-> CoD4x integration (Roadmap Block 16)`.
- [ ] Review the branch diff against `origin/main` with `superpowers:requesting-code-review`, fix Critical/Important findings with regression tests, re-run both preflights, then push and open the PR.
