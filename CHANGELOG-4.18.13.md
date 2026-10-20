# COD4X CONTROL 4.18.13

## B3 In-Game Administration (Roadmap Block 15)

Design: `docs/superpowers/specs/2026-10-20-b3-admin-design.md`. Plan: `docs/superpowers/plans/2026-10-20-b3-admin.md`.

### Implementation

- `lib/b3-admin.mjs` (pure): query catalog with strict parameters, penalty status exactly like eBc-B3 (`inactive = 0 AND (time_expire = -1 OR time_expire > now)`), group resolution like B3's `maxLevel`, IP/GUID masking, `plugin_admin.ini` command parser.
- Helper `query` operation: the SQL for each catalog name lives only in the Python helper and runs with bound parameters; Node sends a name and params only. LIKE searches escape `%`, `_` and backslash. Writes check that the player, group or penalty exists first.
- `InstanceB3DatabaseService.query()`: catalog queries on a ready database through the Block 14 password binding and short vault scope; writes run under the instance lock.
- `lib/instance-b3-admin-service.mjs`: players, player detail (aliases, IP history), admins, penalties, groups, commands; actions add Ban/TempBan, lift bans, lift warnings and set a group. Setting a group refuses while B3 runs and runs inside the database start guard, because B3 writes the group of connected players back from memory. Audit events `b3.admin.ban_added|unbanned|warning_lifted|group_changed` carry ids only.
- API: `GET /api/instances/:id/b3/admin/{players,players/:clientId,admins,penalties,groups,commands}` (diagnostics.read, masked without config.manage); `POST …/players/:clientId/{ban,unban,group}` and `…/penalties/:penaltyId/lift` (server.manage).
- UI: "B3 Administration" panel with Players, Admins, Penalties and Commands tabs, player detail, ban dialog and group selection.

### Native check

`scripts/verify-4.18.13-b3-admin-native.mjs` passed 16/16 against the MariaDB test database `b3_control_test`. Every action was verified with eBc-B3's own `MysqlStorage`: an added TempBan counts for `getClientPenalties(('Ban','TempBan'))`, lifting it removes it, a lifted warning no longer counts, a set group is what `getClient()` loads; a ban id on the warning route and a ban for an unknown player are refused; a player named `Pct%_Name` is found exactly by `%_` (LIKE characters literal) and a masked search never matches GUIDs.

### Review before the PR (superpowers:requesting-code-review)

All important findings and several minor ones fixed with regression tests:

- Viewers can use the panel: readiness and B3 state come from the new `GET …/b3/admin/status` (diagnostics.read) instead of the config.manage-only database route.
- Masked callers search by name only (`playersByName`); a GUID substring search plus the total would have let them rebuild masked GUIDs.
- Penalties are paged in the UI with a total; every load refreshes readiness and B3 state; a Refresh button was added.
- Kicks are stored by B3 with `time_expire = -1` and are shown as events, never as active or expired.
- "Lift ban" reports when there was no active ban; a write that committed right before a vault lock is still audited (`outcome: committed_vault_locked`); ids up to the MySQL INT limit are accepted; the ban dialog only closes on success.

### Roadmap

- Block 15b (next): live kick of a connected player via RCON.
- B3 plugin management (templates/upload, enable/disable, trust and hash) with/after Block 16.
