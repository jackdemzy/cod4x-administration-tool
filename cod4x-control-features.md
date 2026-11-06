# COD4X CONTROL – Features

Version 4.18.19 · development source, not a release

- Desktop app for Windows and Linux
- Install, configure, run and monitor CoD4x dedicated servers
- Backend local only (`127.0.0.1:8787`); optional remote gateway

## Servers

- **Version Manager**
  - CoD4x **server**: latest official release 21.2 (May 2022)
  - CoD4x **client**: latest release 21.8 (players only, not needed for the server)
  - Server profiles 21.3–21.5 selectable, but not official server releases
  - SHA-256 verified downloads
- **Promod builds and rulesets**
  - FPSChallenge.eu: FPS Promod 2.85 (plus 2.86, 3.00, 3.02 if configured)
  - eBc Promod (live-server ruleset)
  - Promod LIVE 2.20 / V2, or a custom build
  - Bot Warfare
- **Update check**
  - compares with the latest official server and client releases on GitHub
  - shows version, date and link
  - installs nothing automatically
  - FPSChallenge anti-cheat: optional auto-update setting
- **Instances**
  - own home folder, port, settings
  - base game separate, read-only
  - clone an instance
- **Runtime**
  - start / stop / restart
  - process verification, crash detection
- **Network**
  - local only by default
  - public only after explicit confirmation

## Configuration

- **Config Engine**
  - `server.cfg` from validated input
  - preview → diff → backup → apply → verify
  - every change restorable
- **Plugins**
  - load only with an approved hash
  - changed plugin blocks the start
- **Mods**: mod, anti-cheat, Bot Warfare

## Security

- **Vault**: encrypted RCON password, master token, B3 DB password
- **Roles**: admin, operator, viewer, monitor
- **Login**: lockout after repeated failures
- **2FA**: authenticator app (TOTP) plus recovery codes
- **Audit log**: user and result, never secrets

## RCON & Players

- Live console with a safe command set
- Live kick by slot, checked before and after

## Master Server

- Master token in the vault
- Registration status
- Listing check against the official server list

## B3 (Big Brother Bot)

- Start / stop / monitor per server
- Health checks, logs, root cause first
- MySQL/MariaDB setup with verified backup
- Players, admins, bans, warnings

## Monitoring & Remote

- **Monitoring**
  - status, map, players, latency, host load
  - outages with cause
  - 30-day history
  - no RCON password needed
- **Remote access**
  - phone and browser
  - off by default
  - Tailscale (recommended), LAN, or public domain via Caddy
- **Alerts**
  - server down / back up, low disk space
  - Discord and phone push
  - repeat brake
- **Remote actions**
  - chat message, kick, restart
  - fresh authenticator code per action

## Development

- 381 tests plus one gate per roadmap block (`npm run preflight`)
- CI on Windows and Linux
- License: AGPL-3.0-or-later
