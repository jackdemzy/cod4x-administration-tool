# B3 In-Game Administration (Roadmap Block 15, 4.18.13) – Design

Status: approved in sections on 2026-10-20. Branch `control-4.18.13`.

## Goal

CONTROL presents B3's administration data clearly and offers a small set of management actions on B3's own data model, without re-implementing B3. B3 stays responsible for in-game administration; CONTROL is the management layer.

Gate: **Player / admin / ban data can be reliably displayed and managed via B3.**

## Decisions (user, 2026-10-20)

| Topic | Decision |
|---|---|
| Scope | Display of Players, Admins, Bans, Warnings, Kicks, TempBans, Permanent Bans and Commands, plus management through B3's database. |
| Actions | Lift a ban, add a ban (Ban / TempBan) by player, set a player's admin group, lift a warning. No live kick here; it follows as Block 15b. No bulk actions. |
| Detail view | Aliases and IP history (`aliases`, `ipaliases`), read-only. |
| Data source | Only instances whose B3 database is MySQL and "B3 Ready" (Block 14 helper). SQLite instances show a pointer to the database wizard. |
| Permissions | All views with `diagnostics.read`, with IPs and GUIDs masked; full values with `config.manage`; all actions with `server.manage`. |
| Commands | Read-only list with minimum levels from `b3/conf/plugin_admin.ini` of the configured eBc-B3 source. |

Assumptions:

- The player list can be large, so lists are searched and paged on the server.
- Success means an admin can see without game access who is banned, warned or an admin, and can lift or add bans, lift warnings and set groups. B3 applies the changes itself.

## Constraints from eBc-B3 (pinned commit 9096624)

- **Bans are read fresh at every authentication.**
  - `Client.auth()` checks `numBans`, which is computed by `storage.getClientPenalties(type=('Ban','TempBan'))`.
  - That query filters `inactive = 0 AND (time_expire = -1 OR time_expire > now)`.
  - Therefore a ban added or lifted in the database takes effect on the player's next connect. A connected player is not kicked.
- **B3 keeps connected clients in memory.** `storage.setClient()` writes all fields, including `group_bits`, back on save. A group change from outside would be overwritten for a connected player. Therefore **setting a group requires B3 to be stopped** (`B3_RUNNING` otherwise).
- **Warnings** use the same `penalties` table (`type = 'Warning'`, with `time_expire`). B3's warn plugin counts active warnings, so lifting one (`inactive = 1`) is consistent with B3. Creating or editing warnings stays in B3 (`!warn`, `!warnclear`).
- **Groups** (`groups`): `id` is the bit value used in `clients.group_bits`. The defaults are 0 Guest, 1 User, 2 Regular, 8 Moderator (level 20), 16 Admin (40), 32 Full Admin (60), 64 Senior Admin (80) and 128 Super Admin (100).
- **Commands:** `plugin_admin.ini` section `[commands]` lists `name[-alias] = level`, for example `ban-b = 40` and `putgroup-pg = 80`. The file is 6.8 KB in the pinned source.

## Components

### `lib/b3-admin.mjs` (pure, no I/O)

- **Query catalog.** Every read or write is a named operation with a fixed parameter schema; anything unknown or out of range throws `B3_ADMIN_INPUT_INVALID`.

  | Operation | Parameters |
  |---|---|
  | `players` | `search` (≤ 32 chars), `limit` (1–100, default 50), `offset` (≥ 0) |
  | `admins` | none |
  | `player` | `clientId` (positive integer) — aliases and IP history |
  | `penalties` | `type` (Ban / TempBan / Permanent / Kick / Warning / any), `status` (active / expired / lifted / any), `limit`, `offset` |
  | `groups` | none |
  | `unban` | `clientId` |
  | `addBan` | `clientId`, `kind` (Ban / TempBan), `durationMinutes` (TempBan: 1–525600), `reason` (1–255 printable chars, no control characters) |
  | `setGroup` | `clientId`, `groupId` |
  | `liftWarning` | `penaltyId` |

- **`penaltyStatus(row, now)`** returns `active`, `expired` or `lifted`:
  - `inactive = 1` gives `lifted`.
  - `time_expire = -1`, or `time_expire > now`, gives `active`.
  - Otherwise the result is `expired`.
  - Display types: a `Ban` is shown as "Permanent", a `TempBan` with its expiry.
- **`groupFor(groupBits, groups)`**: the group with the highest level whose bit is set in `group_bits`. This is B3's `maxLevel` logic.
- **Masking for callers without `config.manage`:**
  - IPv4 `a.b.c.d` becomes `a.b.c.x`; anything else becomes `x`.
  - A GUID keeps only its last 4 characters, as `…A1B2`.
  - Applied on the server before the response.
- **`parseAdminCommands(iniText, groups)`** reads the `[commands]` section and returns `{ command, alias, level, group }` per line. `group` is the lowest-level group that reaches the level.

### Helper extension (`lib/b3-database-helper.mjs`)

- New operation `query`: `{ name, params }`. The SQL text for each name lives **only in the Python helper** (a fixed dict). It is executed with bound parameters, `cur.execute(sql, params)`. Node never sends SQL text.
- Write queries run their statements in order and return affected row counts. Reads return rows as lists of column values with a fixed column order per query.
- Same launch, stdin-only secrets, short vault scope (`#helperCall`) and output bounds as in Block 14. The 1 MiB output cap is respected by the paging limits.
- Query details:
  - **`addBan`:**
    - Inserts into `penalties` with `type` Ban or TempBan, `client_id`, `admin_id = 0` and `keyword = 'control'`.
    - Duration fields follow B3: Ban uses `duration = 0` and `time_expire = -1`; TempBan uses `duration` in minutes and `time_expire = now + minutes*60`.
    - Also sets `reason`, `inactive = 0`, `time_add` and `time_edit`.
  - **`unban`:** `UPDATE penalties SET inactive = 1, time_edit = now WHERE client_id = %s AND type IN ('Ban','TempBan') AND inactive = 0`.
  - **`liftWarning`:** the same update by `id`, limited to `type = 'Warning' AND inactive = 0`.
  - **`setGroup`:** `UPDATE clients SET group_bits = %s, time_edit = now WHERE id = %s`.
  - **Existence checks:** every write first checks that the client, group or penalty exists. A missing one returns a distinct error: `B3_ADMIN_CLIENT_NOT_FOUND`, `B3_ADMIN_GROUP_NOT_FOUND` or `B3_ADMIN_PENALTY_NOT_FOUND`.

### `lib/instance-b3-admin-service.mjs`

- Uses `InstanceB3DatabaseService`. Every operation requires `read(id).ready === true`, otherwise it fails with `B3_DATABASE_NOT_READY`. It calls the helper through the database service, which owns the password binding and the vault scope; the database service exposes an internal `query(id, name, params)` for this purpose.
- `setGroup` refuses while B3 runs (`b3IsRunning`) with `B3_RUNNING`, and runs inside the database start guard so B3 cannot start meanwhile.
- `commands(id)` reads `plugin_admin.ini` from the configured eBc-B3 path. The file must be a regular, non-symlink file of at most 64 KiB. It is never executed.
- Audit events never contain IP, GUID, name or reason text:
  - `b3.admin.ban_added` with `{ instanceId, actor, clientId, kind, durationMinutes }`
  - `b3.admin.unbanned` with `{ instanceId, actor, clientId, count }`
  - `b3.admin.warning_lifted` with `{ instanceId, actor, penaltyId }`
  - `b3.admin.group_changed` with `{ instanceId, actor, clientId, groupKeyword }`

### API

| Route | Permission |
|---|---|
| `GET /api/instances/:id/b3/admin/players?search=&offset=` | `diagnostics.read` (masked without `config.manage`) |
| `GET …/b3/admin/players/:clientId` (aliases, IP history) | `diagnostics.read` (masked) |
| `GET …/b3/admin/admins` | `diagnostics.read` (masked) |
| `GET …/b3/admin/penalties?type=&status=&offset=` | `diagnostics.read` (masked) |
| `GET …/b3/admin/groups`, `GET …/b3/admin/commands` | `diagnostics.read` |
| `POST …/b3/admin/players/:clientId/ban`, `…/unban`, `…/group` | `server.manage` |
| `POST …/b3/admin/penalties/:penaltyId/lift` (warnings) | `server.manage` |

### UI (section "B3 Administration" below the B3 manager)

- Without MySQL B3 Ready: only a hint pointing to the database wizard.
- Tabs:
  - **Players:** search and paging; name, GUID, IP, group, connections, last seen. A detail view shows aliases and IP history.
  - **Admins.**
  - **Penalties:** type and status filters; player, type, reason, since, until, status.
  - **Commands:** command, alias, minimum level, group.
- Actions, shown only with `server.manage`:
  - **Ban / TempBan dialog:** duration in minutes, hours or days, plus a reason. The dialog notes that the ban takes effect on the next connect and that a connected player is not kicked.
  - **Lift ban.**
  - **Lift warning.**
  - **Set group:** disabled with an explanation while B3 runs.
- Messages for every error code live in `lib/b3-admin-messages.mjs`, in German and English.

## Failure cases

| Case | Code |
|---|---|
| No MySQL / not B3 Ready | `B3_DATABASE_NOT_READY` |
| Database errors | Block 14 codes (`DB_UNREACHABLE`, `DB_AUTH_FAILED`, …) |
| Unknown player / group / penalty | `B3_ADMIN_CLIENT_NOT_FOUND` / `B3_ADMIN_GROUP_NOT_FOUND` / `B3_ADMIN_PENALTY_NOT_FOUND` |
| Invalid parameters (type, status, duration, reason, paging) | `B3_ADMIN_INPUT_INVALID` |
| Set group while B3 runs | `B3_RUNNING` |
| Vault locked or busy | `VAULT_LOCKED` / `VAULT_OPERATION_BUSY` |
| Commands file missing or unsafe | `B3_ADMIN_COMMANDS_UNAVAILABLE` |

## Testing

All tests are written first and must fail before the code exists (TDD).

- **Pure unit tests:**
  - query catalog validation
  - status at the boundary `time_expire == now`
  - masking (IPv4, invalid IP, short GUID)
  - `groupFor` with multiple bits
  - `parseAdminCommands` on the real `plugin_admin.ini` as a fixture: `ban-b` → (ban, b, 40, Admin) and `putgroup-pg` → (putgroup, pg, 80, Senior Admin)
- **Helper:**
  - `query` accepts only known names.
  - Parameters are passed bound: a Python 2.7 test against a fake connection that records SQL text and params separately.
  - Node never sends SQL.
- **Service, with a fake database service:**
  - not ready → `B3_DATABASE_NOT_READY`
  - masking by permission
  - unknown client, group or penalty
  - `setGroup` while B3 runs, and `setGroup` inside the start guard
  - action audit carries no IP, GUID, name or reason
- **API:**
  - a viewer gets masked lists and 403 on all actions
  - an admin gets full values
- **UI render tests:**
  - not-ready hint
  - masked values
  - actions hidden without `server.manage`
  - set group disabled while B3 runs
  - the ban dialog note
- **Gate:** `scripts/verify-4.18.13-b3-admin-gate.mjs` checks behavior: query whitelist and parameter binding through the real runner with a fake spawn, masking without `config.manage`, and routes and permissions. `scripts/preflight-4.18.13.mjs` includes all earlier gates.
- **Native:** `scripts/verify-4.18.13-b3-admin-native.mjs` runs against the WSL test database `b3_control_test`:
  1. Migrate.
  2. Seed a client the way B3 stores it.
  3. Add a TempBan; B3's own storage (`getClientPenalties` through eBc-B3 Python) sees it as active.
  4. Lift the ban; B3 sees no ban.
  5. Lift a warning.
  6. Set a group with B3 stopped; B3 loads the client with the new level.
  7. Read aliases and IP history.
  8. The commands list comes from the real `plugin_admin.ini`.

## Out of scope

- Live kick (Block 15b, next).
- Bulk actions.
- Creating or editing warnings.
- B3 plugin management (planned with/after Block 16).

## Completion

- Version bump to 4.18.13.
- CHANGELOG.
- DEVELOPMENT_STATUS.
- Roadmap addenda for Block 15b (live kick) and B3 plugin management (Block 16).
- Review with superpowers:requesting-code-review before the PR.
