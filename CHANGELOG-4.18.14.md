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

`scripts/verify-4.18.14-kick-native.mjs` passed 8/8 against the real CoD4x 21.2 Linux core with two bots (`developer 1`, `developer_script 1`, `scr_testclients 2`): both bots listed; a wrong playerid and a wrong name were refused without kicking; slot 1 was kicked and confirmed, only bot0 remained; an empty slot was refused; the console still blocked `clientkick 0`, `kick all` and `onlykick 0`; eBc-B3's own cod4x parser reads the CoD4x playerid column as guid (basis of the B3 kick); the audit carried slots only.

### Review before the PR (superpowers:requesting-code-review)

Important findings fixed with regression tests:

- The B3 list views no longer query RCON on every load: `findOnline` is cached for 3 s with a short timeout and ignores connecting (CNCT) and dropped (ZMBI) clients.
- A kick that gets no RCON reply is still confirmed by `status`; check + kick share one short vault scope and each confirmation has its own (pauses happen outside the vault); a failure after the kick was sent is reported as `RCON_KICK_NOT_CONFIRMED`, and a `status` reply without the player table never counts as confirmation.
- The assumption B3 guid = CoD4x playerid is now proven natively with eBc-B3's own cod4x parser.

Minor fixes: typed kick reasons are cleared on reload (slots are reused), B3 kicks ask for confirmation, ban-and-kick shows the ban reason to the player when CoD4x can carry it, IPv6 addresses are masked per group, tests for non-string JSON fields. The kick reason rule lives in the browser-safe `lib/kick-reason.mjs`.
