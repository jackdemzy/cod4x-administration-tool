# B3 <-> CoD4x integration (Roadmap Block 16, 4.18.20)

Status: design approved in conversation by Rafiki on 2026-11-06; this document is the written spec for review.

Block 16 connects B3 and the CoD4x core through the `b3hide` CoD4x plugin and the eBc-B3 `auth` plugin, and hands the RCON password from the vault to B3. B3 plugin management (the 2026-10-20 addendum) is split off into Block 16b (4.18.21) with its own spec.

## Goal and success criteria

After Block 16, CONTROL generates and validates the complete B3/CoD4x wiring:

- B3 gets the RCON password from the vault, so it can talk to the server.
- One switch, "Hide B3 commands", enables `b3hide` in the core and `auth` in B3 together, with the same prefix and level threshold on both sides.
- Optional `!auth` passwords per B3 level, kept in the vault.
- Every missing piece blocks the start with a precise reason; nothing restarts on its own.
- Gate: CoD4x -> b3hide -> B3 -> RCON/parser end to end, natively in WSL with bots.

## Source facts (checked, not assumed)

- `b3hide` source: `CoD4x_Server/plugins/cod4x_b3hide/b3hide.c`, last change d7dc9da (2020-05-25).
  - Dvars: `b3Prefix` (string, default `!`; only the first character is compared), `b3Hide` (bool, default 1), `b3HideLvl` (int 0-100, default 20).
  - Command `client_checkin <slot> <level>` (power 95) stores the level per slot; slots reset on connect and disconnect.
  - `OnMessageSent` hides a chat line whose first character (after an optional 0x15 team marker) is the prefix when the sender's level is `>= b3HideLvl`.
  - It removes the core's `status` command and registers its own (`Cmd_B3Status_f`), also as `b3status`. That output uses the legacy columns `num score ping guid name lastmsg address qport rate`, prints the playerid in the guid column, truncates names to 15 characters and prints ping 0 instead of `CNCT`/`ZMBI` for clients that are not active.
- Binaries: the official CoD4x 21.2 release packages (GitHub Actions build, 2022-05-01) contain `b3hide.so` (SHA-256 `f277087c8817c927ca28e96171c8a729ad319f3739cc360c8d3d74899b918a30`, ELF 32-bit i386) and `b3hide.dll` (SHA-256 `51fadd9ae0be0bb8855d37a56b53a04b289be775c9fdc38fe256e1f7cb8969bb`).
- eBc-B3 (pinned 9096624) `b3/extplugins/auth.py`:
  - On `EVT_CLIENT_AUTH` it writes `client_checkin <cid> <maxLevel>` over RCON.
  - If the client's level has an entry in the `[passwords]` section, the client is demoted to the `reg` group until `!auth <password>` matches.
  - Commands come from the `[commands]` section; messages from `[messages]` with defaults.
  - It is not enabled in the shipped `b3.xml` and ships no config file.
- `lib/b3-config.mjs` writes `b3.xml` with an empty `rcon_password` today; the MySQL DSN is already written inside a vault scope with mode 0600 (`InstanceB3Service.start`).

## Architecture

### `lib/b3-integration.mjs` (new, pure)

`planB3Integration({ instance, settings, pluginStates, b3Source, credentialsPresent })` returns:

```text
{
  enabled,                      // the "Hide B3 commands" switch
  b3hide: { b3Prefix, b3Hide, b3HideLvl } | null,
  auth: { enabled, passwordLevels: [20, 100, ...] },
  rcon: { required: boolean, present: boolean },
  warnings: [{ code }],
  blockers: [{ code, detail }],
  fingerprint                   // SHA-256 of the non-secret plan values
}
```

No file system, no network, no secret values: `credentialsPresent` only says whether `rcon` and which `b3auth` levels are set.

Blocker codes:

- `B3HIDE_MISSING`, `B3HIDE_NOT_APPROVED`, `B3HIDE_INTEGRITY_FAILED`, `B3HIDE_WRONG_PLATFORM`
- `RCON_PASSWORD_MISSING`
- `B3_AUTH_PLUGIN_MISSING` (no `b3/extplugins/auth.py` in the B3 source)
- `B3_PREFIX_INVALID` (exactly one character from `!@#$%&*.,:?=~-`)
- `B3_HIDE_LEVEL_INVALID` (one of the B3 group levels 1, 2, 20, 40, 60, 80, 100)

With the switch on, a missing RCON password is a blocker (`auth` needs RCON for `client_checkin`). With the switch off, B3 keeps today's behaviour:

- The RCON password is written when it is in the vault.
- Without it B3 still starts, with the warning `RCON_PASSWORD_MISSING` (not a blocker) shown in the B3 view.
- The plan then carries `rcon.required = false` and `auth.enabled = false`.

### Settings

- Stored on the instance record as `b3Integration: { hideCommands: false, prefix: '!', hideLevel: 20 }` (defaults shown), next to `plugins`. Changing them needs `config.manage` and a stopped server and B3 (same rule as plugin changes).
- When `hideCommands` is turned on, CONTROL enables the registered `b3hide` record in the plugin manager and writes its three dvars from the plan. The b3hide dvar fields in the plugin manager are read-only while the switch is on ("controlled by B3 integration").
- Turning the switch off disables the b3hide record again and removes `auth` from `b3.xml` on the next B3 start.

### Vault

- New credential kind `b3auth`: a JSON object `{ "<level>": "<password>" }` for the levels 1-100 that B3 knows.
- Password rule: 4-64 printable ASCII characters without spaces, `"`, `;`, `\`, `<`, `>`, `&` (`auth.py` compares the rest of the chat line; spaces would never match).
- Setting a password needs `config.manage` and an unlocked vault; the UI field is write-only and shows only "set".

### Server start (existing launch path)

- `pluginLaunchArguments` stays the gate for files and hashes.
- Before it, the launch computes the plan; any `B3HIDE_*` or prefix/level blocker stops the start before anything is spawned.
- The plan's dvars are passed after `+loadPlugin b3hide`, as today for plugin dvars.
- The existing plugin load detection (console messages, `pluginInfo`) confirms that b3hide loaded; a missing load message is reported as `B3HIDE_NOT_LOADED` in the instance status.
- The launch records the plan fingerprint and the vault document SHA-256 that were used.

### B3 start (existing vault scope)

Inside the one `withRuntimeCredentials` scope that already writes the MySQL DSN. SQLite instances get the same scope when the vault is unlocked. With the vault locked and the switch off, a SQLite instance starts as today, without the RCON password.

1. Fail `VAULT_LOCKED` on abort. Fail `RCON_PASSWORD_MISSING` without `credentials.rcon` only when the switch is on.
2. `renderB3Config` gets `rconPassword` and, when the switch is on, an `auth` plugin entry pointing to the absolute path of `b3/plugin_auth.ini`.
3. `renderAuthConfig` writes `b3/plugin_auth.ini`:
   - `[commands] auth: 0` (usable by everyone)
   - `[messages]` with the default English texts from `auth.py`
   - `[passwords]` only for levels that have a vault password
4. Both files are written atomically with mode 0600; on a vault lock or a failed start both previous files are restored (existing restore logic, extended to the second file).
5. B3 starts; the runtime records the plan fingerprint and vault SHA-256.

### "Restart needed"

- The B3 view compares the current plan fingerprint and vault document SHA-256 with the values recorded at the last server start and the last B3 start.
- On a difference it shows "Restart B3" and/or "Restart the server". The vault SHA-256 changes with any credential change, so the hint says "credentials changed since the start" instead of naming the RCON password.
- Nothing is restarted automatically.

### Status parser (`lib/rcon-status.mjs`)

- Detect the b3hide format: legacy header and no `steamid` column, as produced by `Cmd_B3Status_f`.
- Return `format: 'b3hide'` with `limits: { nameLength: 15, connectionState: false }`.
- Kick verification (4.18.14) in this format:
  - The playerid must match; a name check compares only the first 15 visible characters.
  - Confirmation means the playerid left the slot.
  - Ping-0 rows are not treated as connecting, because the format cannot say.
- `findOnline` (B3 online marking) uses playerid only in this format.
- The online list and the phone app show "b3hide active: status limited".

### Health and UI

- The B3 dashboard (Block 13) gets a row "b3hide/auth connected":
  - OK when the core reported b3hide loaded, B3 is running with the current fingerprint, and the B3 log shows the auth plugin started.
  - Otherwise the first failing reason.
- The B3 view gets a section "CoD4x connection":
  - The switch, the prefix, and the level threshold (select of B3 levels with names).
  - The `!auth` password fields per level, write-only with "set"/"remove".
  - A traffic light per requirement: b3hide present and approved, RCON password in the vault, auth plugin present, vault unlocked.
  - The restart hints.
- Next to an unapproved or approved b3hide file the plugin manager shows "matches the CoD4x 21.2 release" when the SHA-256 is one of the two known hashes. Approval is still the operator's.
- German and English texts for every new code.

## Security

- The RCON and `!auth` passwords exist on disk only in `b3/b3.xml` and `b3/plugin_auth.ini` (0600) of the instance. This is the same accepted residual risk as the DB password: B3 needs them in plain text.
- The config view redacts `rcon_password` (already) and the `[passwords]` values of `plugin_auth.ini`.
- Logs and runtime output never contain the values. Audit events:
  - `b3.integration.configured` (switch, prefix, level)
  - `b3.auth.password.set` and `b3.auth.password.cleared` (level only)
- The remote gateway gets no new route; nothing here can be changed from the phone.
- The prefix is a single character from a fixed set, so it cannot inject a second console command into the `+set` arguments.

## Error handling

Every blocker and failure has a stable code and a German/English message:

- the `B3HIDE_*` codes, `B3HIDE_NOT_LOADED`
- `RCON_PASSWORD_MISSING`, `VAULT_LOCKED`
- `B3_AUTH_PLUGIN_MISSING`, `B3_PREFIX_INVALID`, `B3_HIDE_LEVEL_INVALID`
- `B3_INTEGRATION_BUSY` (change while the server or B3 runs)

Start failures restore the previous config files.

## Testing

Unit and HTTP tests (run everywhere, CI included):

- **Plan:** every combination of switch, b3hide state, RCON present, `b3auth` levels, prefix and level rules, and the fingerprint's stability.
- **Rendering:** `b3.xml` with `rcon_password` and the auth entry, `plugin_auth.ini` content and escaping, mode 0600, restore of both files on a vault lock, redaction in the config view, no secrets in logs or audit.
- **Parser:** b3hide output rebuilt from `Cmd_B3Status_f` (15-character names, colour codes, bots, ping 0), kick and `findOnline` in this format.
- **API and RBAC:** `config.manage`, locked vault, busy server, "restart needed".
- **UI:** the "CoD4x connection" section, the read-only b3hide fields, the release-hash hint, all codes in German and English.

Native gate `scripts/verify-4.18.20-b3-integration-native.mjs` in WSL uses the real CoD4x 21.2 core, the release `b3hide.so`, eBc-B3 9096624, MariaDB, and bots. It checks:

1. The core loads b3hide; `b3Prefix`, `b3Hide` and `b3HideLvl` read back over RCON.
2. `status` returns the b3hide format and CONTROL's parser reads it.
3. B3 starts with the generated `b3.xml`, connects over RCON and reads players and the game log with the `cod4x` parser.
4. `auth` sends `client_checkin` and the core accepts it.
5. A verified slot kick still works in the b3hide format.
6. No password appears in output, logs or audit.

If b3hide does not load in the existing WSL test core (`~/core-21.2`, a different build than the release package), the gate uses the core from the 21.2 release package and says so.

Known gap, recorded as manual and open: bots cannot chat, so "an admin's `!command` is invisible to others" needs a real client (Rafiki's CoD4 client on Windows), for example together with the phone test of 4.18.16-4.18.19.

## Release

- Version 4.18.20 with the usual files (package.json, lock, build.ps1, BUILD_INFO.json, UI strings, README note, version/runtime checks).
- The gate script, `scripts/preflight-4.18.20.mjs` (includes all earlier gates), and CHANGELOG-4.18.20.md.
- The DEVELOPMENT_STATUS.md update, in English.
- Preflight on Windows and in WSL.
- Review with `superpowers:requesting-code-review`; important findings get fixed with regression tests before the PR.

## Out of scope

- B3 plugin management (Block 16b).
- Automatic restarts and background reconciliation.
- Any other CoD4x plugin from the release package (censor, warn, simplebanlist, ...).
- Changing the RCON console allowlist.
