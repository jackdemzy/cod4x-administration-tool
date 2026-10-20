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

`scripts/verify-4.18.13-b3-admin-native.mjs` passed 15/15 against the MariaDB test database `b3_control_test`. Every action was verified with eBc-B3's own `MysqlStorage`: an added TempBan counts for `getClientPenalties(('Ban','TempBan'))`, lifting it removes it, a lifted warning no longer counts, a set group is what `getClient()` loads; a ban id on the warning route and a ban for an unknown player are refused; LIKE/quote characters in the search are literal.

### Roadmap

- Block 15b (next): live kick of a connected player via RCON.
- B3 plugin management (templates/upload, enable/disable, trust and hash) with/after Block 16.
