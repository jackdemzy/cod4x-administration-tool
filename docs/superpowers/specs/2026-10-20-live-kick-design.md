# Live Kick (Roadmap Block 15b, 4.18.14) – Design

Status: approved on 2026-10-20. Branch `control-4.18.14`.

## Goal

An admin can remove a **connected** player immediately. The kick is available from three places:

- a list of online players;
- a B3 player row, when that player is online;
- the ban dialog, as "ban and kick".

The wrong player must never be hit. The general RCON console stays exactly as restricted as before.

Gate: **Live kick of a connected player via RCON PASS (slot verified, nothing else unblocked).**

## Decisions (user, 2026-10-20)

- Kick is offered in an "Online" view (RCON `status`) and on B3 player rows that are online. Online players are matched by B3 guid = CoD4x `playerid`.
- The ban dialog gets an option "kick the player now".
- The kick reason is optional free text: at most 126 characters, no `"` `;` `%` `/` `\`, no control characters. An empty reason means CoD4x's default text.

## Facts from CoD4x_Server (`src/sv_cmds.c`) and eBc-B3

- **Kick commands.** `clientkick` and `kick` resolve their argument in `SV_GetPlayerByHandleInternal`:
  - A string of digits is a slot. An empty slot with 1–2 digits is answered with "not on the server".
  - Any other string is matched against player names, including partial names.
  - `kick all` kicks everyone.
  - Therefore **CONTROL only ever sends a 1–2 digit slot (0–63)**, never a name and never `all`.
- **The reason** must not contain `"` `;` `%` `/` `\` and may be at most 126 characters (CoD4x usage text).
- **`status` (non-legacy) columns** are `num score ping playerid steamid name lastmsg address qport rate`.
  - `ping` is a number or `CNCT` / `PRIM` / `ZMBI`.
  - Names can contain spaces and colour codes and are followed by `^7`, so rows are parsed from the right.
  - Bots have the address `bot`.
- **eBc-B3's cod4x parser** uses `playerid` as the client guid and kicks with `clientkick %(cid)s`.
- **Bots for native tests.** The real core spawns bots only with `developer 1`, `developer_script 1` and `scr_testclients N` (verified on CoD4x build 1154, Linux).

## Components

### `lib/rcon-status.mjs` (pure)

`parseStatus(text)` returns `{ map, players: [...] }`. Each player row has:

| Field | Value |
|---|---|
| `slot` | number |
| `score` | number |
| `ping` | number, or `'CNCT'` / `'PRIM'` / `'ZMBI'` |
| `playerid` | string |
| `steamid` | string |
| `name` | colour codes removed, trailing `^7` dropped |
| `rawName` | the name as printed |
| `lastmsg` | number |
| `address` | string |
| `bot` | boolean |
| `qport`, `rate` | numbers |

Lines that are not player rows are ignored.

### `lib/rcon-protocol.mjs`

- New `buildKickPacket(password, slot, reason)`:
  - slot is an integer from 0 to 63, sent as decimal;
  - the reason follows the rule above;
  - the packet is `rcon <pw> clientkick <slot> <reason>`.
- `normalizeRconCommand` and `RCON_COMMANDS` are **unchanged**. The console keeps blocking `kick`, `clientkick`, `onlykick` and `kick all`.
- `RconClient.kick(password, slot, reason)` sends this packet and collects the reply.

### `InstanceRconService`

- `online(id, { full = false })` returns `{ map, players }` from `status`.
  - Without `full`, the address is masked like `maskIp` (bots stay `bot`) and the playerid like `maskGuid`.
  - Steamid is never returned.
- `kick(id, { slot, playerid, name, reason }, actor)` runs inside the existing per-service serializer and one vault scope:
  1. Run `status` and find `slot`. If it is not there: `RCON_KICK_NOT_ONLINE`.
  2. If the `playerid` differs, or a `name` is given and differs from the cleaned name: `RCON_KICK_TARGET_CHANGED`. In that case **no kick packet is sent**.
  3. Send `clientkick <slot> <reason>`.
  4. Run `status` again. If the slot is empty or holds a different playerid, the kick is confirmed. Otherwise: `RCON_KICK_NOT_CONFIRMED`.
  5. Audit `rcon.kick` with `{ instanceId, actor, slot, ok, code }`. Names, playerids, IPs and the reason are never audited.
- `findOnline(id, playerids)` returns a map from playerid to slot. It is used by the B3 admin service. Any failure returns `null`, meaning unknown.

### B3 admin (Block 15) integration

- `players()` and `admins()` add `online: { slot } | false | null` per row by matching B3 guid = playerid. `null` means unknown: the server is down or RCON is unavailable. This never fails the B3 view.
- `addBan(…, { kick: true })` first writes the ban, then kicks if the player is online. The result is `{ id, kick: 'kicked' | 'not_online' | <error code> }`. The ban stays even if the kick fails.
- A new admin action `kick(id, clientId, reason, actor)` resolves the B3 client's guid and slot, then calls `rcon.kick` with that slot and playerid.

### API

| Route | Permission |
|---|---|
| `GET /api/instances/:id/rcon/online` | `diagnostics.read` (masked; full with `config.manage`) |
| `POST /api/instances/:id/rcon/kick` `{ slot, playerid, name?, reason? }` | `server.manage` |
| `POST /api/instances/:id/b3/admin/players/:clientId/kick` `{ reason? }` | `server.manage` |
| existing `POST …/players/:clientId/ban` accepts `kick: true` | `server.manage` |

### UI

- **"Online players" section below the RCON console.** It lists slot, name, ping, masked id and address. Each row has a Kick button with an optional reason field. It works without B3.
- **B3 Administration:** a Kick button on online player rows, and a "Kick the player now" checkbox in the ban dialog.

## Failure cases

| Case | Code |
|---|---|
| Slot empty | `RCON_KICK_NOT_ONLINE` |
| Slot now holds another player | `RCON_KICK_TARGET_CHANGED` |
| Invalid slot or reason | `RCON_KICK_INVALID` |
| Player still there after the kick | `RCON_KICK_NOT_CONFIRMED` |
| Server down / auth / vault | existing `RCON_SERVER_NOT_RUNNING`, `RCON_AUTH_FAILED`, `RCON_NOT_CONFIGURED`, `VAULT_LOCKED` |
| B3 player not online | `RCON_KICK_NOT_ONLINE` (or `kick: 'not_online'` for ban and kick) |

## Testing

All tests are written first and must fail first (TDD).

- **Pure tests:**
  - The status parser against the real bot output as a fixture, plus names with spaces and colour codes, a `CNCT` row, and the legacy header.
  - `buildKickPacket` rejects slot 64, `00x`, `all`, names and forbidden characters.
  - The console allowlist still rejects `clientkick 0`, `kick all` and `onlykick 1`.
- **Service, with a fake RCON client:**
  - A target change sends no kick.
  - Not confirmed is reported.
  - Not online is reported.
  - Audit contains no name or reason.
  - The online list is masked.
- **B3 admin:** online marking via guid; ban and kick; unknown online state when RCON fails; the kick action.
- **API:** permissions. **UI:** render tests.
- **Gate:** `scripts/verify-4.18.14-kick-gate.mjs`, behaviour-based.
  - A fake client records that only `clientkick <slot> …` is sent.
  - The console still blocks kick commands.
  - Routes and permissions.
- **Native:** `scripts/verify-4.18.14-kick-native.mjs` runs against the real CoD4x core in WSL with 2 bots:
  1. The online list shows 2 bots.
  2. A kick with the wrong playerid gives TARGET_CHANGED, and the bot stays.
  3. Kicking slot 1 leaves only bot 0.
  4. Kicking an empty slot gives NOT_ONLINE.
  5. The console rejects `clientkick 0` and `kick all`.

## Out of scope

- Kick all.
- Kicks by name.
- Temporary bans via CoD4x's own ban list (B3 handles bans).

## Completion

- Version 4.18.14.
- CHANGELOG.
- DEVELOPMENT_STATUS.
- Review with superpowers:requesting-code-review before the PR.
