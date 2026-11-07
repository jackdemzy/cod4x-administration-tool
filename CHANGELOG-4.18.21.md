# COD4X CONTROL 4.18.21

## B3 plugin management (Roadmap Block 16b)

Design: `docs/superpowers/specs/2026-11-06-b3-plugin-management-design.md`. Plan: `docs/superpowers/plans/2026-11-06-b3-plugin-management.md`. Builds on the B3 <-> CoD4x integration of 4.18.20.

### Sources checked

- eBc-B3 `b3/parser.py loadPlugins` and `b3/plugin.py` (pinned 9096624).
  - B3 imports a plugin `<name>` and looks up the class `'%sPlugin' % name.title()`; a plugin with a `path` is loaded from that directory.
  - `requiresConfigFile`, `requiresPlugins`, `requiresParsers` and the Python module imports decide whether a plugin can run.
- The 34 plugins shipped in `b3/plugins` and `b3/extplugins` at 9096624. `discordbot` is not offered; `callvote` needs the `iourt42` parser and is unavailable with `cod4x`.

### Implementation

- Catalog: `lib/b3-plugin-catalog.mjs`, generated once by `scripts/generate-b3-plugin-catalog.mjs` from a checkout at 9096624 (any other commit is refused).
  - Per plugin: location, file or package module, SHA-256 (`lib/b3-plugin-hash.mjs`), config template and its hash, required config file, required plugins and parsers, Python modules.
  - `admin` and `publist` are fixed, `auth` belongs to the Block 16 integration; none of the three is ever in the registry.
- Registry: the instance record gets `b3Plugins` (at most 32 entries, names `^[a-z][a-z0-9_]{1,31}$`, a custom name never shadows a shipped one) and `b3PluginsRevision`, which every change increases (`lib/b3-plugin-registry.mjs`).
- Files per instance: configs in `<home>/b3/plugins/<name>.ini|.xml`, custom code in `<home>/b3/extplugins/<name>.py`. Directories 0700, files 0600, atomic writes, names validated before any path is built, symlinks refused.
- Template and validation (`lib/b3-plugin-template.mjs`, `lib/b3-plugin-validate.mjs`):
  - the template is Python 2.7 with one command and imports only `b3`/`b3.plugin`;
  - INI follows Python 2.7 ConfigParser line rules, XML needs the `<configuration>` root, both report the failing line;
  - config and code are UTF-8, at most 256 KB, without NUL bytes; the code must define the class B3 looks up.
- Plugin service (`lib/instance-b3-plugin-service.mjs`): enable/disable, config read/save, approval of a differing hash, custom plugins from the template or as code, delete. Saves carry `expectedSha256`; a stale value returns `B3_PLUGIN_CONFLICT` and the file keeps the first save. All writes run under the instance's exclusive lock.
- B3 start: before any file is written, each enabled plugin is checked again. Blockers, each with its plugin: `B3_PLUGIN_MISSING`, `B3_PLUGIN_INTEGRITY_FAILED`, `B3_PLUGIN_NOT_APPROVED`, `B3_PLUGIN_DEPENDENCY_MISSING`, `B3_PLUGIN_REQUIRES_PLUGIN`, `B3_PLUGIN_CONFIG_MISSING`. A blocked start writes nothing and spawns nothing.
  - `b3.xml` lists `admin`, the enabled plugins in registry order, then `auth`; `config` only when a file exists, `path` only for custom plugins, values escaped.
  - The start records `b3PluginsRevision`; a later change gives the restart hint `PLUGINS_CHANGED`. There is no hash over config files, because they can hold tokens. Nothing restarts automatically.
- API (local only): `GET /api/instances/:id/b3/plugins` (diagnostics.read); enable/disable, config read/write and approval (config.manage); custom create, code read/write and delete (new permission `b3.plugins.code`, role `admin` only). No route in the phone gateway.
- Audit: `b3.plugin.enabled|disabled|config_saved|approved|custom_created|code_saved|deleted` with `instanceId`, `actor`, `name`, plus `sha256` for approvals and code. Never config or code content.
- UI (`lib/instance-b3-plugins.jsx`, in the B3 manager): plugin table with source, state, requirements and actions; approval with the full SHA-256, the module path and a "I checked this file and trust it" checkbox bound to that hash; config editor with line errors and conflict handling that keeps the draft; custom plugin editor with the warning that the code runs with the rights of the B3 process. German and English texts in `lib/b3-plugin-messages.mjs`.

### Review fixes during the block

- Template class names follow Python's `str.title()` (`my_plug2` -> `My_Plug2Plugin`), so B3 finds the class.
- A failed custom plugin creation leaves no orphan files.
- The trust checkbox is keyed by name and SHA-256, so a hash that changes after a refresh is never approved with one click.
- A config or code conflict keeps the typed text and offers to load the current version.
- Config errors report the right line; CORS allows PUT/DELETE for the plugin text routes; body errors on these routes are answered quietly with 400.

### Checks

- Gate: `scripts/verify-4.18.21-b3-plugins-gate.mjs` (14 checks): catalog shape, name rules, template validation, config/code validation, `b3.xml` order, each start blocker, a changed custom module, plan-before-write in the B3 start, the `PLUGINS_CHANGED` hint, `b3.plugins.code` admin-only, no gateway route, value-free audit, German and English texts.
- Native gate: `scripts/verify-4.18.21-b3-plugins-native.mjs` in WSL COD4X-Test passed 13/13 with real Python 2.7.18 and eBc-B3 9096624 (SQLite, no CoD4x server process):
  - `python2.7 -m py_compile` accepts the template code, and the class names match Python's `title()`;
  - `welcome` matches its catalog hash, B3 starts through `InstanceB3Service` and logs `Loading plugin #2 : welcome [...]` and `Plugin welcome (1.4 - ...) loaded`;
  - the template plugin `myplug` loads from the instance `extplugins` directory and its command registers (`AdminPlugin: command "myplug (None)" registered with cmd_myplug for level (1, 100)`);
  - after a line is appended to `myplug.py`, the next start is refused with `B3_PLUGIN_INTEGRITY_FAILED` (plugin `myplug`), writes no file and spawns no B3;
  - the config value `token = Native-Token-1` is not in `b3.log`, B3 stdout/stderr, `b3.xml` or the audit.
- Preflight `scripts/preflight-4.18.21.mjs` runs the new gate, the native check and the B3 plugin tests in addition to everything from 4.18.20.
- Tests: `test/b3-plugin-catalog.test.mjs`, `test/b3-plugin-registry.test.mjs`, `test/b3-plugin-template.test.mjs`, `test/b3-plugin-plan.test.mjs`, `test/instance-b3-plugin-service.test.mjs`, `test/b3-plugins-http.test.mjs`, `test/instance-b3-plugins.test.mjs`.

### Open

- Running a custom plugin's command in game needs a real game client; bots cannot chat. It is a manual check.
- The time between the hash check and the B3 spawn is a residual risk; only local administrators can write the plugin directories.
