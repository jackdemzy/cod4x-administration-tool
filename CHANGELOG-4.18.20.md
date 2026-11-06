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
  - Inputs: switch, prefix (one of `!@#$%&*.,:?=~-`), level (B3 group 1/2/20/40/60/80/100), b3hide state, auth plugin present, RCON / `!auth` presence and vault lock.
  - It returns the b3hide dvars, the auth entry, named blockers and warnings, and a fingerprint of the non-secret values.
  - Also `restartHints` and the health row `integrationRow`.
  - Browser-safe constants live in `lib/b3-integration-constants.mjs`, and the texts (German/English) in `lib/b3-integration-messages.mjs`.
- Settings: `b3Integration` on the instance record.
  - `configureB3Integration` needs a stopped server and B3. It enables or disables the registered b3hide record and writes the plan dvars.
  - While the switch is on, the b3hide fields in the plugin manager are locked (`B3_INTEGRATION_CONTROLLED`).
- Vault: new kind `b3auth`, a JSON map of level to password. It is changed only through `setB3AuthPassword`.
  - Rule: 4-64 printable ASCII characters, no spaces and none of `" ; \ < > &`.
  - `instanceStatus` lists levels only.
- Server launch:
  - The plan is computed before the plugin gate. A `B3HIDE_*` blocker stops the start before anything is spawned.
  - With the switch on, b3hide is loaded with the plan dvars, whatever its record says.
  - The launch fingerprint and vault hash are recorded.
- B3 start:
  - Inside the vault scope, `b3.xml` gets `rcon_password`, and with the switch on also the `auth` plugin entry. `plugin_auth.ini` gets `[commands] auth: 0`, the default messages and the set passwords (`%` doubled for B3's interpolating ConfigParser).
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

### Checks

- Gate: `scripts/verify-4.18.20-b3-integration-gate.mjs` (13 checks).
- Native gate: `scripts/verify-4.18.20-b3-integration-native.mjs` in WSL passed 12/12. It ran against the real CoD4x 21.2 core with the release `b3hide.so`, eBc-B3 9096624 and two bots:
  - the release hash matched;
  - the core loaded b3hide;
  - the dvars arrived as CONTROL's `#`, `1`, `40`;
  - `status` came in the b3hide format and listed both bots;
  - B3 started with the generated config and reached HEALTHY, reading the log with the cod4x parser, connected over RCON with the vault password, and the auth plugin started;
  - `client_checkin` is b3hide's command: a valid call was accepted and a malformed one printed its usage;
  - a verified slot kick worked in the b3hide format;
  - no RCON or `!auth` password appeared in the B3 logs, the output or the audit.
- Tests:
  - new: `test/b3-integration.test.mjs`, `test/server-instance-store-b3integration.test.mjs`, `test/b3-config-integration.test.mjs`, `test/server-instance-manager-b3integration.test.mjs`, `test/b3-integration-http.test.mjs`, `test/instance-b3-integration.test.mjs`;
  - extended: `test/instance-credential-service.test.mjs`, `test/instance-b3-service.test.mjs`, `test/rcon-status.test.mjs`, `test/instance-rcon-kick.test.mjs`, `test/b3-manager.test.mjs`, `test/instance-plugin-manager.test.mjs`, `test/instance-online-players.test.mjs`.

### Open

- An admin's `!command` being invisible to other players needs a real game client; bots cannot chat. It is a manual check.
- eBc-B3 did not check in the bots by itself (bots raise no `EVT_CLIENT_AUTH`), so a real client's automatic check-in is part of the same manual check.
