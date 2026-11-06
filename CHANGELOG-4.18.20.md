# COD4X CONTROL 4.18.20

## B3 <-> CoD4x integration (Roadmap Block 16)

Design: `docs/superpowers/specs/2026-11-06-b3-cod4x-integration-design.md`. Plan: `docs/superpowers/plans/2026-11-06-b3-cod4x-integration.md`. B3 plugin management (the 2026-10-20 addendum) follows as Block 16b.

### Sources checked

- `CoD4x_Server/plugins/cod4x_b3hide/b3hide.c` (last change d7dc9da, 2020-05-25).
  - Dvars `b3Prefix` (only the first character counts), `b3Hide`, `b3HideLvl`, and the command `client_checkin <slot> <level>`.
  - It replaces `status` with its own legacy format: names cut to 15 bytes, ping 0 instead of CNCT/ZMBI.
- eBc-B3 `b3/extplugins/auth.py` (pinned 9096624).
  - It sends `client_checkin <cid> <maxLevel>` on `EVT_CLIENT_AUTH`.
  - Optional `[passwords]` per level demote an admin to `reg` until `!auth <password>`.
- Binaries: the official CoD4x 21.2 release packages. `b3hide.so` SHA-256 `f277087c…918a30`, `b3hide.dll` `51fadd9a…8969bb`. CONTROL names these hashes but never approves a file on its own.

### Implementation

- `lib/b3-integration.mjs`: one pure plan, `planB3Integration`.
  - Inputs: switch, prefix (only B3's own command prefix `!`, because CONTROL does not rewrite `plugin_admin.ini`), level (B3 group 1/2/20/40/60/80/100), b3hide state, auth plugin present, RCON / `!auth` presence and vault lock.
  - It returns the b3hide dvars, the auth entry, named blockers and warnings, and a fingerprint of the non-secret values.
  - Also `restartHints` and the health row `integrationRow`.
  - Browser-safe constants live in `lib/b3-integration-constants.mjs`, and the texts (German/English) in `lib/b3-integration-messages.mjs`.
- Settings: `b3Integration` on the instance record.
  - `configureB3Integration` needs a stopped server and B3. It enables or disables the registered b3hide record and writes the plan dvars.
  - While the switch is on, the b3hide fields in the plugin manager are locked (`B3_INTEGRATION_CONTROLLED`).
- Vault: new kind `b3auth`, a JSON map of level to password. It is changed only through `setB3AuthPassword`.
  - Rule: 4-64 printable ASCII characters, no spaces and none of `" ; \ < > & %` (Python 2.7's ConfigParser would not return a `%` value intact).
  - `instanceStatus` lists levels only.
- Server launch:
  - The plan is computed before the plugin gate. A `B3HIDE_*` blocker stops the start before anything is spawned.
  - With the switch on, b3hide is loaded with the plan dvars, whatever its record says.
  - The launch fingerprint and vault hash are recorded.
- B3 start:
  - Inside the vault scope, `b3.xml` gets `rcon_password`, and with the switch on also the `auth` plugin entry. `plugin_auth.ini` gets `[commands] auth: 0`, the default messages and the set passwords for levels at or above the hide level.
  - Both files are written atomically with mode 0600. Both are restored, or removed, on a vault lock or a failed start.
  - A SQLite instance with the switch off and a locked vault still starts as before, without RCON.
- `lib/rcon-status.mjs`:
  - The b3hide format is selected by the run's plugin state, because the text alone looks like the core's `sv_legacyguidmode` output. It returns `limits`.
  - The kick check compares a long name by the part that survived the cut (`nameMatches`). Real players are still matched by playerid.
- API:
  - `GET /api/instances/:id/b3/integration` (diagnostics.read; the vault hash only with config.manage).
  - `POST /api/instances/:id/b3/integration` and `POST …/b3/integration/auth-password` (config.manage).
  - Audit events `b3.integration.configured`, `b3.auth.password.set` and `b3.auth.password.cleared`, carrying the level only.
  - There is no gateway route.
- B3 dashboard: a "b3hide/auth connected" row (OFF / BLOCKED / NOT_CONNECTED / OK). The B3 log parser recognises auth's `registered CLIENT_AUTH event`.
- UI:
  - The B3 manager gets the section "CoD4x connection": the switch, prefix, level with B3 group names, write-only `!auth` password fields per level, a requirement list, blockers and restart hints.
  - The plugin manager shows "matches the CoD4x 21.2 release" for the known hashes.
  - The online list says when b3hide limits the status.

### Review before the PR (superpowers:requesting-code-review)

Fixed with regression tests (`test/b3-integration-review.test.mjs`, `test/instance-credential-service.test.mjs`):

- **Typed `!auth` passwords.** B3 logs chat lines at VERBOSE (`Queueing event EVT_CLIENT_SAY : !auth …`), and the game log and `qconsole.log` carry chat too.
  - Every CONTROL log view now redacts `<prefix>auth <value>` (`redactAuthCommands`), both in the runtime/B3/RCON output redaction and in the console log view.
  - The game server's and B3's own files on disk still contain what players type. That is inherent to `auth.py` and a known residual risk.
- **Prefix.** B3's command prefix comes from `plugin_admin.ini` (`command_prefix = !`), which CONTROL does not change. Another b3hide prefix would hide nothing B3 executes and would leave `!auth` in public chat, so the prefix is fixed to `!`.
- **`%` in passwords** is now rejected instead of doubled: Python 2.7's ConfigParser only interpolates values containing `%(` and returns `%%` unchanged.
- **Passwords below the hide level** are not written (warning `B3_AUTH_LEVEL_BELOW_HIDE`; those UI rows are disabled), because b3hide would show them in chat.
- **Restart hints.**
  - The server has its own fingerprint over the b3hide values only, so an `!auth` change asks for a B3 restart, never a server restart.
  - Credentials compare by a per-instance digest (record ids and change times, never values) instead of the global vault hash.

- **Config hashes (CodeQL `js/insufficient-password-hash`).** The B3 start/restart response returned an unsalted SHA-256 of `b3.xml`, which holds the RCON and database passwords, so a short password could be guessed offline.
  - It now returns `config.fingerprint`, a hash of the non-secret inputs only (paths, port, game log, template version, and whether MySQL, RCON and auth are set). It does not match the file hash and is not meant for change detection.
  - `plugin_auth.ini` gets its own `authFingerprint` the same way (`test/b3-config-integration.test.mjs`).

### PR review (Codex)

- **B3 command prefix.** The B3 source check reads `settings/command_prefix` from `b3/conf/plugin_admin.ini`. Any prefix other than `!`, or a file that cannot be read, blocks the integration (`B3_COMMAND_PREFIX_MISMATCH`), because b3hide would then not hide `!auth`.
- **Name-only kicks of truncated b3hide rows** are refused (`RCON_KICK_TARGET_AMBIGUOUS`). A name cut to 15 bytes does not identify the player, so these rows can only be kicked by player ID.
- **Plugin limit.** The switch validates the plugin records (`PLUGIN_LIMIT`) before anything is saved, so a refused switch never leaves `hideCommands` on.
- **Integration changes and B3 starts exclude each other.** A change fails with `B3_INTEGRATION_BUSY` while a start is in flight, and a start fails while a change is being saved.
- **Runtime state in the dashboard.** The B3 dashboard shows the b3hide/auth state (`dashboard.integration`) with its reason, for example `B3HIDE_NOT_LOADED`. While it is not connected, it warns not to type `!auth` passwords.

- **Other B3 prefixes.** B3 also runs commands with its loud, big and private prefixes (`@`, `&`, `/` in `plugin_admin.ini`). b3hide only hides `!`, so a public `@auth <password>` is visible in chat. The core and B3 cannot prevent this without patching b3hide, so CONTROL limits it instead:
  - the generated `auth_message` says "only with !, never @ & /";
  - while the switch is on, the integration panel explains the risk (`B3_OTHER_PREFIXES_VISIBLE`);
  - the B3 log parser detects a public auth command with another prefix (B3 VERBOSE "Queueing event EVT_CLIENT_SAY/TEAM_SAY"), keeping only the fact and never the value. The dashboard then raises `B3_AUTH_PASSWORD_EXPOSED` and asks to change the `!auth` passwords.

The deferred minor findings are listed in the PR description.

### Checks

- Gate: `scripts/verify-4.18.20-b3-integration-gate.mjs` (13 checks).
- Native gate: `scripts/verify-4.18.20-b3-integration-native.mjs` in WSL passed 13/13. It ran against the real CoD4x 21.2 core with the release `b3hide.so`, eBc-B3 9096624 and two bots:
  - the release hash matched;
  - the core loaded b3hide;
  - the dvars arrived as CONTROL's `#`, `1`, `40`;
  - `status` came in the b3hide format and listed both bots;
  - B3 started with the generated config and reached HEALTHY, reading the log with the cod4x parser, connected over RCON with the vault password, and the auth plugin started;
  - `client_checkin` is b3hide's command: a valid call was accepted and a malformed one printed its usage;
  - a verified slot kick worked in the b3hide format;
  - no RCON or `!auth` password appeared in the B3 logs, the output or the audit.
  - B3 writes VERBOSE lines at `log_level 9`, which the `B3_AUTH_PASSWORD_EXPOSED` detection needs. The "Queueing event EVT_CLIENT_SAY" line itself needs a real client: bots never become B3 clients, because the cod4x parser matches `b3status` rows by IP. The line shape comes from `b3/parser.py` queueEvent and is covered by `test/b3-manager.test.mjs`.
- Tests:
  - new: `test/b3-integration.test.mjs`, `test/server-instance-store-b3integration.test.mjs`, `test/b3-config-integration.test.mjs`, `test/server-instance-manager-b3integration.test.mjs`, `test/b3-integration-http.test.mjs`, `test/instance-b3-integration.test.mjs`;
  - extended: `test/instance-credential-service.test.mjs`, `test/instance-b3-service.test.mjs`, `test/rcon-status.test.mjs`, `test/instance-rcon-kick.test.mjs`, `test/b3-manager.test.mjs`, `test/instance-plugin-manager.test.mjs`, `test/instance-online-players.test.mjs`.

### Open

- An admin's `!command` being invisible to other players needs a real game client; bots cannot chat. It is a manual check.
- eBc-B3 did not check in the bots by itself (bots raise no `EVT_CLIENT_AUTH`), so a real client's automatic check-in is part of the same manual check.
