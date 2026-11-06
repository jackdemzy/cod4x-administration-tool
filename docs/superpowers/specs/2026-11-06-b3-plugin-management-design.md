# B3 plugin management (Roadmap Block 16b, 4.18.21)

Status: design approved in conversation by Rafiki on 2026-11-06; this document is the written spec for review.

Block 16b lets an operator manage eBc-B3 plugins per server instance: enable and disable the plugins shipped with eBc-B3, edit their configuration, and add custom plugins by upload or from a template with an in-app code editor. Every plugin that B3 loads is pinned by SHA-256, every change is audited, and nothing restarts on its own.

## Goal and success criteria

- Per instance, the shipped eBc-B3 plugins can be enabled and disabled, and their configuration edited.
- Custom plugins (one `.py` file each) can be uploaded or created from a template, then edited in CONTROL.
- B3 only starts when every enabled plugin matches its trusted hash, its requirements are met and its configuration exists. Otherwise the start is blocked with a precise reason.
- Changes take effect on the next B3 start; the dashboard says "Restart B3: plugins changed" until then.
- Native gate in WSL with real Python 2.7 and eBc-B3 9096624:
  - a shipped plugin (`welcome`) loads;
  - a custom plugin created from the template loads and registers its command;
  - a later change to the custom `.py` blocks the start.

## Decisions (Rafiki, 2026-11-06)

1. Scope: shipped plugins and custom plugins.
2. Plugin configuration lives per instance (`<home>/b3/plugins/`); the shared eBc-B3 source is never written.
3. Custom plugins live per instance (`<home>/b3/extplugins/`) and are approved per instance by SHA-256, like the CoD4x plugin manager.
4. Custom plugins are single `.py` files (plus an optional `.ini`/`.xml` config); no ZIP packages.
5. "From template" creates a runnable skeleton, and CONTROL has a code editor for custom plugins.
6. Shipped plugins are trusted through a hash catalog for commit 9096624. A module whose hash differs needs an explicit approval.
7. Writing code (create, upload, edit, delete) needs the new permission `b3.plugins.code`, granted to the role `admin` only, and is never reachable through the remote/phone gateway. Enable, disable, configure and approve use `config.manage`.
8. Changes are allowed while B3 runs; they take effect on the next start (restart hint).
9. Approach 1: a per-instance registry, `b3.xml` generated from it, checks as blockers in the existing B3 start plan.

## Source facts (eBc-B3 9096624, checked)

- `b3/parser.py loadPlugins`:
  - Reads `<plugin name config path disabled>` from `b3.xml` (`b3/config.py get_plugins`).
  - `pluginImport(name, path)` loads a module from `path` when the attribute is given (`imp.find_module(name, [path])`). Otherwise it loads from `b3/plugins`, then from the external plugin directory. A module is either `<name>.py` or a package `<name>/__init__.py`.
  - The class must be `<Name>Plugin` (`name.title()`).
  - `admin` is mandatory (critical exit without it), and `publist` is always loaded.
- `b3/plugin.py` class attributes:
  - `requiresConfigFile` (default `True`);
  - `requiresParsers`, `requiresPlugins`, `requiresStorage`, `requiresVersion`, `loadAfterPlugins`.
  - B3 itself sorts plugins by these attributes.
- Shipped plugins:
  - 30 in `b3/plugins`;
  - 9 in `b3/extplugins`: `auth.py`, `autoreg.py`, `discord.py`, `discordban.py`, packages `discordbot`, `mute`, `namechangers`, `reportplayer`, and `conf/`.
  - Default configs are in `b3/conf/plugin_<name>.ini|xml` and `b3/extplugins/conf/`.
- Attributes in 9096624:
  - `requiresConfigFile = False`: `duel`, `ftpytail`, `geolocation`, `httpytail`, `publist`, `sftpytail`, `xlrstats`, `mute`.
  - `requiresPlugins`: `countryfilter` and `geowelcome` need `geolocation`.
  - `requiresParsers = ['iourt42']`: `callvote` (not usable with the cod4x parser).
  - No plugin sets `requiresStorage`.
- Python module needs: `adv` and `geolocation` import `feedparser`/`requests`, `discord.py` imports `requests`, and `sftpytail` needs `paramiko` (see `B3_DEPENDENCY_MATRIX`).
- CONTROL today: `lib/b3-config.mjs renderB3Config` writes only `admin` (and `auth` when the Block 16 integration is on), with `external_dir @b3/extplugins`.

## Architecture

### Catalog: `lib/b3-plugin-catalog.mjs` (new, static)

One entry per shipped plugin of 9096624:

```text
{ name, location: 'plugins' | 'extplugins', module: 'file' | 'package',
  sha256,                      // over all module files, see hashing below
  configTemplate: 'b3/conf/plugin_welcome.ini' | null, configTemplateSha256,
  requiresConfigFile, requiresPlugins: [], requiresParsers: [], pythonModules: [] }
```

- Generated once by `scripts/generate-b3-plugin-catalog.mjs` from a local eBc-B3 checkout at 9096624, and checked in as code. The script refuses any other commit.
- Not offered: `admin` and `publist` (fixed); `auth` (owned by the Block 16 integration); `callvote` (`requiresParsers` excludes cod4x). They appear as fixed or unavailable rows in the UI with the reason.
- Hashing (`hashB3Module`):
  - a file module hashes its bytes with CRLF normalized to LF;
  - a package hashes the sorted list of `relative path NUL sha256(file)` lines for every regular file under the package directory;
  - `.pyc`, `.pyo` and `__pycache__` are skipped (B3 writes them on import).
  - Symlinks and files above 4 MB make the module invalid.

### Registry: instance record field `b3Plugins`

```text
b3Plugins: [{ name, source: 'shipped' | 'custom', enabled, sha256, approvedAt, configType: 'ini' | 'xml' | null }]
b3PluginsRevision: integer        // +1 on every plugin change
```

- `name` matches `^[a-z][a-z0-9_]{1,31}$`.
- Fixed names (`admin`, `publist`, `auth`) are rejected. A custom name must not equal a shipped plugin name.
- `sha256`:
  - shipped: the catalog hash, or the approved differing hash;
  - custom: the approved hash of `<name>.py`.
- At most 32 entries. The store setter `setB3Plugins` validates like `setPlugins` and keeps legacy records (field missing) as `[]`.

### Files per instance

```text
<home>/b3/plugins/<name>.ini|.xml    plugin configuration (shipped and custom)
<home>/b3/extplugins/<name>.py       custom plugin code
```

- Directories are created 0700 and checked with `safeDirectory`.
- Files are written atomically with mode 0600 (`writePrivate`).
- A path is always built from a validated name; no symlinks.
- Enabling a shipped plugin for the first time copies its config template from the eBc-B3 source after checking `configTemplateSha256`. Without a template, no file is created.
- A custom plugin from the template gets `<name>.py` and `<name>.ini`.

### Template (custom plugin skeleton)

`renderB3PluginTemplate(name)`:

- `<name>.py` with:
  - `class <Name>Plugin(b3.plugin.Plugin)`;
  - `requiresConfigFile = True`;
  - `onStartup` that gets the admin plugin and registers one example command `!<name>` (level 1) from the `[commands]` section;
  - `cmd_<name>` that answers the caller;
  - a short header comment saying it runs with B3's rights.
- `<name>.ini` with `[commands]` (`<name>: 1`) and `[settings]` (`message: Hello from <name>`).
- Python 2.7 syntax, no imports beyond `b3` and `b3.plugin`.

### B3 start (existing plan in `InstanceB3Service.start`)

`planB3Plugins({ instance, catalog, b3Source, dependencies })` is pure apart from reading and hashing the module and config files. It runs before any file is written, after the Block 16 integration plan.

For each enabled plugin it checks:

| Check | Blocker |
|---|---|
| shipped module missing in the source, or custom `<name>.py` missing | `B3_PLUGIN_MISSING` |
| module hash differs from the registry `sha256` | `B3_PLUGIN_INTEGRITY_FAILED` |
| shipped plugin with a differing catalog hash and no approval | `B3_PLUGIN_NOT_APPROVED` |
| a `pythonModules` entry missing in the dependency check | `B3_PLUGIN_DEPENDENCY_MISSING` |
| a `requiresPlugins` entry not enabled (and not fixed) | `B3_PLUGIN_REQUIRES_PLUGIN` |
| `requiresConfigFile` and no config file | `B3_PLUGIN_CONFIG_MISSING` |

- Each blocker carries `{ code, plugin }`.
- The hashes are computed right before the spawn. The window between check and spawn is a residual risk: only local admins can write these directories.

`renderB3Config` gets `plugins`. Order: `admin`, then the enabled registry plugins in stored order, then `auth`.

```text
shipped: <plugin name="welcome" config="<home>/b3/plugins/welcome.ini"/>
custom:  <plugin name="myplug" config="<home>/b3/plugins/myplug.ini" path="<home>/b3/extplugins"/>
```

A plugin without a config file gets no `config` attribute. All attribute values go through `escapeXml`.

### "Restart needed"

- `startedWith` (B3 service) also records `b3PluginsRevision`.
- `restartHints` reports `b3: 'PLUGINS_CHANGED'` when the current revision differs.
- No hash over config files: they can hold tokens (for example a Discord webhook).

### API (`installer-server.mjs`, local only)

All routes are under `/api/instances/:id/b3/plugins`. None is added to the remote gateway, and the gate checks that.

| Route | Permission | Purpose |
|---|---|---|
| `GET /b3/plugins` | `diagnostics.read` | catalog rows plus registry plus state per plugin, plus restart hint |
| `POST /b3/plugins/:name/enable`, `/disable` | `config.manage` | switch; first enable copies the config template |
| `GET /b3/plugins/:name/config` | `config.manage` | config text and its `sha256` |
| `PUT /b3/plugins/:name/config` | `config.manage` | save `{ text, expectedSha256 }` |
| `POST /b3/plugins/:name/approve` | `config.manage` | approve `{ sha256 }` of a shipped module that differs from the catalog |
| `POST /b3/plugins/custom` | `b3.plugins.code` | `{ name, from: 'template' }` or `{ name, code }` |
| `GET /b3/plugins/custom/:name/code` | `b3.plugins.code` | code text and `sha256` |
| `PUT /b3/plugins/custom/:name/code` | `b3.plugins.code` | save `{ code, expectedSha256 }`; saving approves the new hash |
| `DELETE /b3/plugins/custom/:name` | `b3.plugins.code` | remove the code file and the registry entry; the config moves to `<name>.<ext>.bak` |

States: `ENABLED`, `DISABLED`, `NOT_APPROVED`, `INTEGRITY_MISMATCH`, `MISSING`, `UNAVAILABLE` (fixed, owned by the integration, or wrong parser).

Validation:

- **Config text:**
  - at most 256 KB, UTF-8, no NUL bytes;
  - `.ini` must parse as Python 2.7 ConfigParser input (sections, `key = value` / `key: value`, comments);
  - `.xml` must be well-formed XML with a `<configuration>` root.
  - Errors return `B3_PLUGIN_CONFIG_INVALID` with a line number.
- **Code:**
  - at most 256 KB, UTF-8, no NUL bytes;
  - must contain `class <Name>Plugin`, otherwise `B3_PLUGIN_CODE_INVALID`;
  - CONTROL never runs or imports it.
- **Conflict:** a stale `expectedSha256` returns `B3_PLUGIN_CONFLICT`.
- All writes run under the instance's exclusive lock, so two saves cannot interleave.

Permission `b3.plugins.code`:

- added to `RBAC_PERMISSIONS`;
- in the `RBAC_MATRIX` only for `admin`;
- listed in the route permission catalog.

### UI (`lib/instance-b3-plugins.jsx`, new; shown in the B3 manager)

- **Table:** name, source (shipped/custom), state in plain text, requirements, actions.
  - Fixed plugins show greyed out with the reason.
  - Missing requirements show as a warning, and the switch stays usable.
- **Approval:** shows the full SHA-256 and the path, a checkbox "I checked this file and trust it", and a button.
- **Config:** a text area with save. A conflict shows "File changed meanwhile – reload". A syntax error shows its line.
- **Custom plugins** (only with `b3.plugins.code`):
  - "New plugin from template" (name input) and ".py upload";
  - a monospace text area as the code editor (no new dependency), under the fixed warning "This code runs with the rights of the B3 process";
  - saving shows the new SHA-256.
- The restart hint "Restart B3: plugins changed" sits with the existing hints. Start blockers show in the existing B3 error list with `b3PluginMessage(code)`.
- German and English texts are in `lib/b3-plugin-messages.mjs`.

## Security

- Code execution: custom plugin code runs as the B3 process user. It is gated by `b3.plugins.code` (admin only), local only, audited with its SHA-256, and re-verified before every start.
- Shipped plugins: hash catalog for 9096624. A differing module needs an approval of the shown hash.
- Plugin config files can contain tokens:
  - stored with mode 0600;
  - shown only to `config.manage`, never through the remote gateway;
  - never logged, never in the audit, never hashed for hints.
- Path safety: names are validated, and paths are built only from names. The write directories are checked against symlinks.
- Audit events:
  - `b3.plugin.enabled`, `.disabled`, `.config_saved`, `.approved`, `.custom_created`, `.code_saved`, `.deleted`;
  - fields `{ instanceId, actor, name }`, plus `sha256` for approvals and code;
  - never config or code content.

## Error handling

- Every blocker returns its code and plugin name. The start writes no file when blocked (same guarantee as the Block 16 plan).
- A missing eBc-B3 source makes shipped plugins `MISSING`; custom plugins are unaffected.
- Codes: `B3_PLUGIN_MISSING`, `B3_PLUGIN_INTEGRITY_FAILED`, `B3_PLUGIN_NOT_APPROVED`, `B3_PLUGIN_DEPENDENCY_MISSING`, `B3_PLUGIN_REQUIRES_PLUGIN`, `B3_PLUGIN_CONFIG_MISSING`, `B3_PLUGIN_CONFIG_INVALID`, `B3_PLUGIN_CODE_INVALID`, `B3_PLUGIN_CONFLICT`, `B3_PLUGIN_NAME_INVALID`, `B3_PLUGIN_FIXED`, `B3_PLUGIN_UNKNOWN`, `B3_PLUGIN_LIMIT`.

## Testing

- **Catalog:**
  - hashing of file and package modules (CRLF, skipped `.pyc`, symlink rejection);
  - the generator refuses another commit;
  - against the real local source when present (otherwise skipped), every catalog hash matches.
- **Registry/store:** validation, persistence across reload, legacy records, fixed and shadowing names, limit.
- **`renderB3Config`:** order, `config`/`path` attributes, escaping, plugins without config.
- **Start plan:**
  - every blocker;
  - no files written when blocked;
  - an enabled custom plugin whose file was changed after approval blocks;
  - the restart hint via `b3PluginsRevision`.
- **Template:** valid Python 2.7 syntax (checked in the native gate with `python2.7 -m py_compile`) and the class name.
- **API:**
  - permissions: viewer reads only, operator without code routes, admin with code routes;
  - no remote gateway route;
  - `expectedSha256` conflicts, size and syntax limits;
  - audit without content.
- **UI (SSR):**
  - table and state texts;
  - the code area only with permission;
  - the warning text;
  - no config text in the HTML without permission.
- **Gate:** `scripts/verify-4.18.21-b3-plugins-gate.mjs`, included in `scripts/preflight-4.18.21.mjs`, which keeps all earlier gates.
- **Native (WSL):** `scripts/verify-4.18.21-b3-plugins-native.mjs`. It covers:
  - `welcome` enabled and loaded (B3 log "Loading plugin" / plugin started);
  - a template plugin loaded and its command registered (admin plugin log);
  - a changed `.py` blocks with `B3_PLUGIN_INTEGRITY_FAILED`;
  - no token from a plugin config in the B3 output or the audit.

## Release

- Version 4.18.21: `package.json`/`package-lock.json`, `build.ps1`, `BUILD_INFO.json`, UI strings, README note, `verify-4.18.21-version`/`-runtime`.
- `CHANGELOG-4.18.21.md` and `DEVELOPMENT_STATUS.md`.
- Review before the PR (`/superpowers:requesting-code-review`), findings fixed with regression tests. Commits and PR in English.

## Out of scope

- Runtime switching through B3's `pluginmanager` plugin (no restart). That plugin itself can be enabled like any other.
- ZIP or package uploads for custom plugins.
- Syntax highlighting or linting in the code editor.
- A global plugin library shared between instances.
- Editing the shared eBc-B3 source or `plugin_admin.ini`.
