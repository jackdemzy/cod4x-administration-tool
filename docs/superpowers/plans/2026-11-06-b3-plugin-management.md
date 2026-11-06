# B3 Plugin Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-instance management of eBc-B3 plugins (shipped and custom) with hash trust, config editing, a code editor, audit, and start blockers.

**Architecture:**
- A static hash catalog of the shipped plugins (eBc-B3 9096624) and a per-instance registry (`b3Plugins`, `b3PluginsRevision`) in the instance store.
- A new `InstanceB3PluginService` owns files, CRUD and the start plan.
- `renderB3Config` writes the enabled plugins into `b3.xml`, and `InstanceB3Service.start` treats plugin problems as blockers before any file is written, like the Block 16 integration plan.

**Tech Stack:** Node.js ESM (Node 18+ in WSL, 24 on Windows), `node:test`, Express routes in `installer-server.mjs`, React JSX rendered with esbuild SSR in tests, Python 2.7 + eBc-B3 9096624 for the native gate.

**Spec:** `docs/superpowers/specs/2026-11-06-b3-plugin-management-design.md`

## Global Constraints

- eBc-B3 commit pinned to `90966246ab1953ceeca5e8b62c714851a120b28a` (`B3_SOURCE.commit` in `lib/b3-dependencies.mjs`).
- Plugin name: `^[a-z][a-z0-9_]{1,31}$`.
  - Fixed names `admin`, `publist`, `auth` are never in the registry.
  - `callvote` is unavailable (`requiresParsers = ['iourt42']`).
- Registry at most 32 entries. Config and code at most 256 KB each, UTF-8, no NUL bytes.
- Files: `<home>/b3/plugins/<name>.ini|.xml` (config), `<home>/b3/extplugins/<name>.py` (custom code). Directories 0700, files 0600, atomic writes.
- Permission `b3.plugins.code`: role `admin` only. Code routes need it; enable/disable/config/approve need `config.manage`; `GET /b3/plugins` needs `diagnostics.read`.
- No route in `lib/remote-gateway.mjs`.
- Audit events:
  - names `b3.plugin.enabled|disabled|config_saved|approved|custom_created|code_saved|deleted`;
  - fields `{ instanceId, actor, name }`, plus `sha256` for approved/custom_created/code_saved;
  - never content.
- Blocker codes (exact): `B3_PLUGIN_MISSING`, `B3_PLUGIN_INTEGRITY_FAILED`, `B3_PLUGIN_NOT_APPROVED`, `B3_PLUGIN_DEPENDENCY_MISSING`, `B3_PLUGIN_REQUIRES_PLUGIN`, `B3_PLUGIN_CONFIG_MISSING`.
- Request codes (exact): `B3_PLUGIN_CONFIG_INVALID`, `B3_PLUGIN_CODE_INVALID`, `B3_PLUGIN_CONFLICT`, `B3_PLUGIN_NAME_INVALID`, `B3_PLUGIN_FIXED`, `B3_PLUGIN_UNKNOWN`, `B3_PLUGIN_LIMIT`.
- Restart hint value: `PLUGINS_CHANGED`.
- Commits, code comments and docs in English. Version `4.18.21`.

## Review Focus

1. A custom `.py` edited outside CONTROL after approval must block the next B3 start with `B3_PLUGIN_INTEGRITY_FAILED`. It must not load silently (Task 5, test `changed custom code blocks the start and writes nothing`).
2. Two editors saving the same config or code with an old `expectedSha256` → the second gets `B3_PLUGIN_CONFLICT` and the file keeps the first save (Task 4, test `stale expectedSha256 is a conflict`).
3. A plugin config holding a token must never appear in audit lines, logs, the dashboard or HTML rendered for a viewer (Task 6 audit test, Task 7 SSR test).
4. Path tricks in names (`../x`, `X`, `a.b`, `con`, 33 characters) and a symlink in place of `<home>/b3/plugins` are rejected before any write (Task 2 name test, Task 4 symlink test).
5. Deleting a custom plugin that another enabled plugin requires, or disabling `geolocation` while `geowelcome` is enabled, blocks the start with `B3_PLUGIN_REQUIRES_PLUGIN`. It must not crash B3 (Task 5).

---

### Task 1: Module hashing and the shipped plugin catalog

**Files:**
- Create: `lib/b3-plugin-hash.mjs`, `lib/b3-plugin-catalog.mjs`, `scripts/generate-b3-plugin-catalog.mjs`
- Test: `test/b3-plugin-catalog.test.mjs`

**Interfaces:**
- Produces:
  - `hashB3Module(absPath: string): Promise<{ ok: true, sha256: string, kind: 'file'|'package' } | { ok: false, code: 'MISSING'|'INVALID' }>`.
  - `B3_PLUGIN_CATALOG: ReadonlyArray<{ name, location: 'plugins'|'extplugins', module: 'file'|'package', sha256, configTemplate: string|null, configTemplateSha256: string|null, requiresConfigFile: boolean, requiresPlugins: string[], requiresParsers: string[], pythonModules: string[] }>`.
  - `catalogEntry(name): entry|null`, `B3_FIXED_PLUGINS = ['admin','publist','auth']`, `isAvailable(entry): boolean` (false when `requiresParsers` is non-empty and lacks `cod4x`).
  - `modulePath(b3Path, entry): string` (`<b3Path>/b3/<location>/<name>` + `.py` for files).

- [ ] **Step 1: Write failing tests**
  - `hashes a file module with CRLF normalized`: `x.py` with `a\r\nb\n` and `a\nb\n` give the same `sha256`, and `kind: 'file'`.
  - `hashes a package over sorted relative paths and skips .pyc and __pycache__`: a package with `__init__.py`, `sub/m.py` and `__init__.pyc`. Adding `__pycache__/x.pyc` leaves the hash unchanged; editing `sub/m.py` changes it.
  - `rejects symlinks and files over 4 MB`: `{ ok: false, code: 'INVALID' }` (symlink case skipped on Windows when creation fails).
  - `missing module`: `{ ok: false, code: 'MISSING' }`.
  - `catalog shape`:
    - no entry for `admin`, `publist`, `auth`;
    - `callvote` present with `isAvailable === false`;
    - `geowelcome.requiresPlugins` deep-equals `['geolocation']`;
    - `duel.requiresConfigFile === false`;
    - `discord.pythonModules` includes `requests`.
  - `catalog matches the real source` (skip unless `B3_SOURCE` env var, or else `C:\Users\r4f1k1\cod4x-b3\ebc-b3` / `~/ebc-b3`, exists): for every entry, `hashB3Module(modulePath(...)).sha256 === entry.sha256`.
- [ ] **Step 2: Run** `node --test test/b3-plugin-catalog.test.mjs`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement `hashB3Module` in `lib/b3-plugin-hash.mjs`.**
  - A file hashes its bytes with CRLF → LF (reuse `normalizedHash` from `lib/b3-dependencies.mjs`).
  - A package is the SHA-256 of the lines `relpath + '\0' + normalizedHash(file) + '\n'`, sorted by relpath with forward slashes. Skip `*.pyc`, `*.pyo` and `__pycache__/`.
  - Use `lstat`: a symlink or a file over `4 * 1024 * 1024` bytes makes the result `INVALID`.
- [ ] **Step 4: Implement `scripts/generate-b3-plugin-catalog.mjs <b3Path>`.**
  - Refuse unless `git -C <b3Path> rev-parse HEAD` equals the pinned commit.
  - For each module in `b3/plugins` and `b3/extplugins` (skip `__init__.py`, `conf`), read these by regex from the module source: `requiresConfigFile = False`, `requiresPlugins = [...]`, `requiresParsers = [...]`, and imports of `requests|feedparser|paramiko`.
  - Find the config template: `b3/conf/plugin_<name>.(ini|xml)`, else `b3/extplugins/conf/(plugin_)?<name>.(ini|xml)`, else null.
  - Write `lib/b3-plugin-catalog.mjs` with a header comment naming the commit.
- [ ] **Step 5: Run the generator** against the local source (`C:\Users\r4f1k1\cod4x-b3\ebc-b3`). Check by hand that `geowelcome`, `countryfilter`, `callvote`, `duel`, `discord` match the spec's source facts.
- [ ] **Step 6: Run** `node --test test/b3-plugin-catalog.test.mjs`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(b3-plugins): module hashing and shipped plugin catalog`.

### Task 2: Registry in the instance store

**Files:**
- Create: `lib/b3-plugin-registry.mjs`
- Modify: `lib/server-instance-store.mjs` (record creation line 88, new setter after `setB3Integration` ~line 173)
- Test: `test/b3-plugin-registry.test.mjs`

**Interfaces:**
- Consumes: `catalogEntry`, `B3_FIXED_PLUGINS`, `isAvailable` (Task 1).
- Produces:
  - `validB3PluginName(name): string` (throws `B3_PLUGIN_NAME_INVALID`; fixed → `B3_PLUGIN_FIXED`);
  - `normalizeB3PluginRecords(records): Record[]` (throws `B3_PLUGIN_LIMIT` over 32; a custom name equal to a catalog name → `B3_PLUGIN_NAME_INVALID`; a duplicate → `B3_PLUGIN_NAME_INVALID`);
  - `store.setB3Plugins(id, records): Promise<instance>`, which bumps `b3PluginsRevision` by 1;
  - a record is `{ name, source, enabled, sha256, approvedAt, configType }`;
  - a new instance has `b3Plugins: []`, `b3PluginsRevision: 0`, and a legacy record without the fields reads as the same.

- [ ] **Step 1: Write failing tests**
  - `names`: accepts `welcome`, `my_plug`. Rejects `../x`, `X`, `a.b`, `a`, `9a` and a 33-character name with `B3_PLUGIN_NAME_INVALID`, and `admin` with `B3_PLUGIN_FIXED`.
  - `records`:
    - rejects a bad `sha256` (not 64 hex), `source` other than shipped/custom, `configType` other than ini/xml/null;
    - rejects a custom `welcome`;
    - rejects 33 records with `B3_PLUGIN_LIMIT`.
  - `store round-trip`: `setB3Plugins` persists across a new `ServerInstanceStore` load; revision goes 0 → 1 → 2; a legacy JSON record without the fields loads as `[]`/`0`.
- [ ] **Step 2: Run** `node --test test/b3-plugin-registry.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the registry module and the store setter, mirroring `setB3Integration` (exclusive + persist + copy).
- [ ] **Step 4: Run** the tests plus `test/server-instance-store*.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(b3-plugins): per-instance plugin registry`.

### Task 3: Template, config validators and messages

**Files:**
- Create: `lib/b3-plugin-template.mjs`, `lib/b3-plugin-validate.mjs`, `lib/b3-plugin-messages.mjs`
- Test: `test/b3-plugin-template.test.mjs`

**Interfaces:**
- Produces:
  - `renderB3PluginTemplate(name): { code: string, config: string }`;
  - `validateB3PluginIni(text): { ok: true } | { ok: false, line: number }`;
  - `validateB3PluginXml(text): { ok: true } | { ok: false, line: number }`;
  - `validateB3PluginCode(name, code): void` (throws `B3_PLUGIN_CODE_INVALID`);
  - `checkB3PluginText(text): void` (throws `B3_PLUGIN_CONFIG_INVALID` over 256 KB, on NUL or on invalid UTF-8; used for code with code `B3_PLUGIN_CODE_INVALID`, via a parameter);
  - `B3_PLUGIN_MESSAGES` (`{ CODE: [de, en] }` for every blocker and request code plus `PLUGINS_CHANGED`) and `b3PluginMessage(code, lang)`.

- [ ] **Step 1: Write failing tests**
  - `template`:
    - `code` contains `class MyplugPlugin(b3.plugin.Plugin)`, `def onStartup(self)` and `def cmd_myplug(self, data, client, cmd=None)`;
    - only imports `b3` and `b3.plugin`;
    - `config` contains `[commands]`, `myplug: 1`, `[settings]`;
    - `validateB3PluginCode('myplug', code)` passes and `validateB3PluginIni(config).ok` is true.
  - `ini`:
    - ok: sections, `k = v`, `k: v`, `;`/`#` comments, indented continuation lines;
    - `{ ok:false, line: 1 }` for an option before any section;
    - `{ ok:false, line: 3 }` for `[broken` on line 3.
  - `xml`:
    - ok: `<configuration><settings name="a"><set name="b">1</set></settings></configuration>` with declaration and comments;
    - fails with the line number: unclosed tag, mismatched tag, root other than `configuration`, unquoted attribute.
  - `code`: rejects code without `class MyplugPlugin`, code with `\0`, and code over 256 KB.
  - `messages`: every code from the Global Constraints has two non-empty strings.
- [ ] **Step 2: Run** `node --test test/b3-plugin-template.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - INI follows Python 2.7 `ConfigParser` line rules: blank, comment (`;`/`#`/`rem`), section `^\[[^\]]+\]`, continuation `^\s+\S` after an option, option `^[^:=\s][^:=]*[:=]`.
  - XML is a small tokenizer with a tag stack: comments, PI, `<!DOCTYPE`, CDATA, quoted attributes, the root must be `configuration`. No new dependency.
  - The template's Python is 2.7 syntax.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(b3-plugins): template, config validation and messages`.

### Task 4: Plugin service (files and operations)

**Files:**
- Create: `lib/instance-b3-plugin-service.mjs`
- Test: `test/instance-b3-plugin-service.test.mjs` (use `test/support/b3-instance-fixture.mjs` for store/instances; build a fake B3 source dir with `b3/plugins/welcome/__init__.py`, `b3/conf/plugin_welcome.ini`, and a catalog override)

**Interfaces:**
- Consumes: Tasks 1–3, `safeDirectory`, `b3Paths` (`lib/b3-config.mjs`).
- Produces `class InstanceB3PluginService({ store, environment, catalog = B3_PLUGIN_CATALOG, exclusive })` with:
  - `list(id): Promise<{ plugins: Row[], revision }>`. A Row is `{ name, source, enabled, state: 'ENABLED'|'DISABLED'|'NOT_APPROVED'|'INTEGRITY_MISMATCH'|'MISSING'|'UNAVAILABLE', sha256, expectedSha256, configType, requires: { plugins, pythonModules }, reason }`. The catalog is listed first, then customs, then fixed rows as `UNAVAILABLE`.
  - `setEnabled(id, name, enabled): Promise<Row>`. The first enable of a shipped plugin copies the template after checking `configTemplateSha256`; a shipped module whose hash differs from the catalog is stored with `sha256` = catalog value and shows as `NOT_APPROVED`.
  - `readConfig(id, name): Promise<{ text, sha256, configType }>` and `saveConfig(id, name, { text, expectedSha256 }): Promise<{ sha256 }>`.
  - `approve(id, name, sha256): Promise<Row>`. Shipped only; the body hash must equal the current module hash, else `B3_PLUGIN_CONFLICT`.
  - `createCustom(id, { name, from: 'template' } | { name, code }): Promise<Row>`, `readCode(id, name)`, `saveCode(id, name, { code, expectedSha256 })`, `deleteCustom(id, name)`.
  - Every write runs inside `exclusive(id, fn)` and ends with `store.setB3Plugins` (revision +1).

- [ ] **Step 1: Write failing tests**
  - `enable copies the template once and lists ENABLED`: the file exists with 0600 (non-Windows); a second enable after a config edit does not overwrite it.
  - `differing shipped module is NOT_APPROVED until approved`: change the fake module so `approve` with a stale hash → `B3_PLUGIN_CONFLICT`; `approve` with the current hash → `ENABLED`.
  - `stale expectedSha256 is a conflict`: two `saveConfig` calls with the same base hash; the second rejects with `B3_PLUGIN_CONFLICT`, and the file holds the first text.
  - `invalid config is rejected with a line`: `{ code: 'B3_PLUGIN_CONFIG_INVALID', line: 2 }` and the file is unchanged.
  - `custom from template, edit, delete`:
    - create gives `<home>/b3/extplugins/myplug.py` and `<home>/b3/plugins/myplug.ini`;
    - `saveCode` updates the registry `sha256` to the new file hash;
    - `deleteCustom` removes the `.py` and the record and leaves `myplug.ini.bak`.
  - `custom name shadowing a shipped plugin is rejected` (`welcome` → `B3_PLUGIN_NAME_INVALID`); unknown names → `B3_PLUGIN_UNKNOWN`; fixed → `B3_PLUGIN_FIXED`.
  - `symlinked plugins directory is rejected before any write` (skip if symlink creation fails): `<home>/b3/plugins` as a symlink → `B3_DIRECTORY_INVALID`, and no file is created in the target.
  - `revision increases on every write and not on reads`.
- [ ] **Step 2: Run** `node --test test/instance-b3-plugin-service.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Hashes of config and code: `sha256` over the exact bytes (no normalization), used only for `expectedSha256`.
  - The service never imports or runs Python.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(b3-plugins): plugin service for files, approval and custom code`.

### Task 5: Start plan, `b3.xml` and restart hint

**Files:**
- Modify: `lib/b3-config.mjs` (`renderB3Config`, `prepareB3Runtime` take `plugins`), `lib/instance-b3-service.mjs` (`#start`, `#startedWith`), `lib/b3-integration.mjs` (`restartHints`)
- Modify: `lib/instance-b3-plugin-service.mjs` (add `plan`)
- Test: `test/b3-plugin-plan.test.mjs`, extend `test/b3-config-integration.test.mjs`, `test/instance-b3-service.test.mjs`, `test/b3-integration.test.mjs`

**Interfaces:**
- Consumes: Task 4 service, the dependency check result (`results` rows with ids `requests`, `feedparser`, `paramiko`).
- Produces:
  - `pluginService.plan(id, dependencies): Promise<{ blockers: [{ code, plugin }], plugins: [{ name, source, configPath: string|null, path: string|null }], revision }>`. `path` is `<home>/b3/extplugins` for custom plugins, otherwise null.
  - `renderB3Config({ ..., plugins = [] })` and `prepareB3Runtime(instance, gLog, { ..., plugins = [] })`.
  - `InstanceB3Service` accepts `plugins` (the service). `startedWith` includes `pluginsRevision`.
  - `restartHints({ ..., pluginsRevision = null })` returns `b3: 'PLUGINS_CHANGED'` when `startedWith.pluginsRevision !== pluginsRevision` and no other b3 hint applies.

- [ ] **Step 1: Write failing tests**
  - `b3.xml order and attributes`:
    - order `admin`, then `welcome` (`config="<home>/b3/plugins/welcome.ini"`, no `path`), then custom `myplug` (`config=…` and `path="<home>/b3/extplugins"`), then `auth`;
    - `duel` without config has no `config` attribute;
    - values are XML-escaped.
  - `plan blockers`, each with `plugin` set:
    - `B3_PLUGIN_MISSING` (shipped module missing in the source; custom `.py` deleted);
    - `B3_PLUGIN_NOT_APPROVED`;
    - `B3_PLUGIN_DEPENDENCY_MISSING` (`discord` with the `requests` row MISSING);
    - `B3_PLUGIN_REQUIRES_PLUGIN` (`geowelcome` enabled, `geolocation` disabled);
    - `B3_PLUGIN_CONFIG_MISSING` (welcome config deleted);
    - disabled plugins are never checked.
  - `changed custom code blocks the start and writes nothing`: edit `myplug.py` after approval → `b3Service.start` rejects with `B3_PLUGIN_INTEGRITY_FAILED`; `b3.xml` and `plugin_auth.ini` are unchanged (same check style as the Block 16 blocker test in `test/instance-b3-service.test.mjs`).
  - `start writes the enabled plugins and records the revision`: `b3.xml` contains `name="welcome"`; `startedWith(id).pluginsRevision` equals the registry revision.
  - `restart hint`: `restartHints` gives `PLUGINS_CHANGED` for revision 3 vs started 2, and null when equal.
- [ ] **Step 2: Run** these test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `plan` hashes each enabled module (`hashB3Module`) and compares it with the registry `sha256`.
  - In `#start`, call `this.plugins.plan(id, dependencies)` right after the integration plan. On blockers: `fail(blockers[0].code, { blockers })` before any write.
  - Pass `plan.plugins` to every `prepareB3Runtime` call (both the vault and the non-vault path) and record `pluginsRevision` in `#startedWith`.
- [ ] **Step 4: Run** the whole suite: `node --test "test/*.test.mjs"`. Expected: PASS, no regressions.
- [ ] **Step 5: Commit** `feat(b3-plugins): start blockers, b3.xml plugins and restart hint`.

### Task 6: API, permission and audit

**Files:**
- Modify: `installer-server.mjs` (RBAC lists ~line 246–268, `RBAC_ENDPOINT_BINDINGS` ~line 303, service wiring after line 2384, routes after the Block 16 routes ~line 2593; `b3IntegrationView` passes `pluginsRevision` to `restartHints`)
- Test: `test/b3-plugins-http.test.mjs` (same harness as `test/b3-integration-http.test.mjs`)

**Interfaces:**
- Consumes: Task 4/5 service methods.
- Produces the routes from the spec's API table. Bodies are checked for exact key sets:
  - `{ text, expectedSha256 }`, `{ sha256 }`, `{ name, from }` with `from === 'template'`, `{ name, code }`, `{ code, expectedSha256 }`.
  - Other keys → `B3_PLUGIN_CONFIG_INVALID` / `B3_PLUGIN_CODE_INVALID`.
  - Responses `{ plugin }`, `{ plugins, revision, restart }`, `{ config }`, `{ code }`.
- New `RBAC_PERMISSIONS` entry `{ id: "b3.plugins.code", label: "B3-Plugin-Code", description: "Eigene B3-Plugins anlegen, hochladen und bearbeiten." }`. `admin` gets it through `RBAC_PERMISSION_IDS`; no other role.
- A binding `{ area: "b3-plugin-code", permission: "b3.plugins.code", routes: [the four custom routes] }`.

- [ ] **Step 1: Write failing tests**
  - `permissions`:
    - viewer: `GET` 200, `POST enable` 403;
    - operator: enable/config/approve 200, `POST /b3/plugins/custom` 403;
    - admin: custom 200.
  - `audit without content`:
    - after `saveConfig` with text `token = SECRET-123` and `saveCode`, the audit lines contain `b3.plugin.config_saved` and `b3.plugin.code_saved` with `name`, and `code_saved` has `sha256`;
    - no audit line contains `SECRET-123` or the code text.
  - `exact body keys`: an extra key → 400 with the code.
  - `no remote route`: `REMOTE_ROUTES` (from `lib/remote-gateway.mjs`) contains no path with `/b3/plugins`.
  - `integration view restart hint`: after a plugin change while B3 runs, `restart.b3 === 'PLUGINS_CHANGED'`.
- [ ] **Step 2: Run** `node --test test/b3-plugins-http.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the routes with `instanceRoute`, `requirePermission`, and the `audit` calls with the event names and fields from the Global Constraints.
- [ ] **Step 4: Run** the test plus `test/b3-integration-http.test.mjs` and the RBAC tests (`grep -l RBAC test/*.mjs`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(b3-plugins): API, b3.plugins.code permission and audit`.

### Task 7: UI

**Files:**
- Create: `lib/instance-b3-plugins.jsx`
- Modify: `lib/instance-b3-runtime.jsx` (render `<InstanceB3Plugins>` after `<InstanceB3Integration>`)
- Test: `test/instance-b3-plugins.test.mjs` (esbuild SSR renderer like `test/instance-b3-integration.test.mjs`)

**Interfaces:**
- Consumes: the Task 6 responses and `b3PluginMessage` (Task 3).
- Produces:
  - `InstanceB3Plugins({ instance, request, de })` (fetches) and the pure `B3PluginsPanel({ data, permissions: { manage, code }, de, busy, on... })` (rendered in tests).
  - The fixed warning copy:
    - de: `Dieser Code läuft mit den Rechten des B3-Prozesses.`
    - en: `This code runs with the rights of the B3 process.`
  - Approval checkbox text:
    - de: `Ich habe diese Datei geprüft und vertraue ihr`
    - en: `I checked this file and trust it`

- [ ] **Step 1: Write failing tests**
  - `table`: rows for a shipped ENABLED, a NOT_APPROVED (full 64-character hash visible), a custom, and a fixed `admin` with its reason; state texts come from `b3PluginMessage` or a state map (no raw codes as the only text).
  - `code area only with permission`: with `code: false` there is no "Neues Plugin aus Vorlage" and no warning text. With `code: true` both are shown.
  - `no config text without manage`: data carrying `configText: 'token = SECRET-123'` with `manage: false` renders no `SECRET-123`.
  - `restart hint`: `restart: 'PLUGINS_CHANGED'` renders the message.
- [ ] **Step 2: Run** `node --test test/instance-b3-plugins.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Follow `lib/instance-b3-integration.jsx` patterns (`useState`, `request`, error `role="alert"`).
  - The code editor is a `<textarea spellCheck={false} style={{ fontFamily: 'monospace' }}>`; `.py` upload uses `<input type="file" accept=".py">` read as text.
- [ ] **Step 4: Run** the test and `npx vite build`. Expected: PASS / build ok.
- [ ] **Step 5: Commit** `feat(b3-plugins): UI`.

### Task 8: Gates, native test and release 4.18.21

**Files:**
- Create: `scripts/verify-4.18.21-b3-plugins-gate.mjs`, `scripts/verify-4.18.21-b3-plugins-native.mjs`, `scripts/preflight-4.18.21.mjs` (copy of `preflight-4.18.20.mjs` plus the new gate), `scripts/verify-4.18.21-version.mjs`, `scripts/verify-4.18.21-runtime.mjs`, `CHANGELOG-4.18.21.md`
- Modify: `package.json` (`version`, `scripts.preflight`), `package-lock.json` (lines 3 and 9), `build.ps1`, `BUILD_INFO.json`, UI version strings, `README.md` note, `DEVELOPMENT_STATUS.md`

**Interfaces:**
- Consumes everything above.

- [ ] **Step 1: Gate script** (pure, no B3), about 12 checks:
  - catalog shape;
  - name rules;
  - template validates;
  - `b3.xml` order;
  - each blocker code;
  - `PLUGINS_CHANGED` hint;
  - `b3.plugins.code` admin-only;
  - no remote route;
  - audit fields.
  Output `PASS <name>` lines and `4.18.21 B3 plugins gate PASS`.
- [ ] **Step 2: Native script** (Linux only, `SKIP` otherwise; same env and fixture style as `scripts/verify-4.18.20-b3-integration-native.mjs`, SQLite, no CoD4x server needed beyond a game log file). Checks:
  - `python2.7 -m py_compile` on the template code;
  - B3 starts with `welcome` enabled and logs it as loaded (`Loading plugin` / `Plugin welcome (` lines in `b3.log`);
  - the custom template plugin loads and its command registers (admin plugin log line `command "myplug`);
  - after appending a line to `myplug.py`, `start` rejects with `B3_PLUGIN_INTEGRITY_FAILED`;
  - a config value `token = Native-Token-1` never appears in `b3.log` stdout/stderr or the audit.
  Run in WSL: `wsl.exe -d COD4X-Test -u cod4xtest -- bash -s` with the repo at `/mnt/c/...`.
- [ ] **Step 3: Version bump** to `4.18.21` everywhere listed, version/runtime verify scripts following the 4.18.20 ones, `CHANGELOG-4.18.21.md`, `DEVELOPMENT_STATUS.md`.
- [ ] **Step 4: Run** `node --test "test/*.test.mjs"`, `node scripts/verify-4.18.21-b3-plugins-gate.mjs`, `node scripts/preflight-4.18.21.mjs` (retry once on the known CIM flake), `npx vite build`, and the native script in WSL. Expected: all PASS; record the native count in the changelog.
- [ ] **Step 5: Commit** `4.18.21: B3 plugin management (Roadmap Block 16b)`, then run `/superpowers:requesting-code-review` before the PR.
