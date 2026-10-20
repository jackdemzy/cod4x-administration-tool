# COD4X CONTROL 4.18.14

## Live Kick (Roadmap Block 15b)

Design: `docs/superpowers/specs/2026-10-20-live-kick-design.md`. Plan: `docs/superpowers/plans/2026-10-20-live-kick.md`.

### Implementation

- `lib/rcon-status.mjs`: parser for CoD4x `status` (modern and legacy columns), matched from the right because names can contain spaces and colour codes; bots and `CNCT`/`PRIM`/`ZMBI` rows are recognised.
- `buildKickPacket` / `RconClient.kick`: the only kick CONTROL sends, `clientkick <slot> [reason]` with a 0-63 slot and a reason without `" ; % / \` (max 126). CoD4x (`src/sv_cmds.c`) resolves non-numeric handles as partial player names and knows `kick all`, so nothing but a slot is ever sent. The console allowlist is unchanged.
- `InstanceRconService.online()` (masked unless `config.manage`, steamid never returned), `findOnline()` (unique real playerids only; bots and unauthenticated players share `0`) and `kick()`: `status` right before the kick must still show the expected player (playerid and/or exact name), otherwise nothing is kicked (`RCON_KICK_TARGET_CHANGED`); afterwards the slot must be free or `ZMBI` (`RCON_KICK_NOT_CONFIRMED` otherwise). Audit `rcon.kick` carries the slot only.
- B3 administration: players and admins show whether they are online; Kick on online rows; "ban and kick" keeps the ban whatever happens to the kick.
- API: `GET /api/instances/:id/rcon/online` (diagnostics.read), `POST /api/instances/:id/rcon/kick` and `POST …/b3/admin/players/:clientId/kick` (server.manage); the ban route accepts `kick: true`.
- UI: "Online players (live kick)" section below the RCON console; Kick button and "kick the player now" option in the B3 administration.

### Native check

`scripts/verify-4.18.14-kick-native.mjs` passed 7/7 against the real CoD4x 21.2 Linux core with two bots (`developer 1`, `developer_script 1`, `scr_testclients 2`): both bots listed; a wrong playerid and a wrong name were refused without kicking; slot 1 was kicked and confirmed, only bot0 remained; an empty slot was refused; the console still blocked `clientkick 0`, `kick all` and `onlykick 0`; the audit carried slots only.
