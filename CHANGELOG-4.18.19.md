# COD4X CONTROL 4.18.19

## Remote Actions (Roadmap Block 24d)

Three actions from the phone app: a chat message to all players, kicking a listed player and restarting a server. Everything else stays read-only.

- **Off by default, two switches.** The gateway setting "Fernaktionen erlauben" and the user's own "Aktionen" switch in the user list. On top: the role needs `server.manage` (admin, operator) and the remote session must have been opened with the second factor. Taking the user switch away stops actions at once.
- **Step-up** (`lib/remote-actions.mjs`): a fresh 6-digit TOTP code opens a 5-minute window bound to the remote session; message and kick work inside it. A restart always needs its own code. Recovery codes never count (`totpOnly`), a code that was already used (also the login code) is refused. Logout ends the window.
- **Limits:** at most 10 actions per session in 5 minutes, one restart per server in 2 minutes. A restart that failed does not start the cooldown. `429` with `Retry-After`.
- **Message (`say`):** printable ASCII, 1–150 characters, no `"`, `;`, `%`, `/`, `\` or line break, so the line cannot carry a second console command. Sent as its own RCON packet (`buildSayPacket`) outside the console allowlist; a timeout without reply counts as sent. The text is public on the server anyway and goes into the audit (`rcon.say`).
- **Kick:** uses the verified slot + name kick from 4.18.14 (the slot is checked against the live status before and after). The player list on the phone shows slot, name, ping, score and bot flag only, no IPs or GUIDs.
- **Restart:** the same launch as in the admin tool, audit `instance.restart` with `actor: remote:<user>`. The phone shows how many players will be disconnected.
- **Public domain:** by choice also over the Caddy domain from 4.18.18. There every role already logs in with TOTP; the step-up applies as everywhere, and the audit marks the action with `proxy: true`.
- **Audit:** `remote.action.step_up`, `remote.action.step_up_failed`, `remote.action.say|kick|restart` with user, session, client, Tailscale user, instance and result. Kick and restart also raise an alert (Discord/push) when alerts are on.
- **Gateway whitelist:** six new routes (`GET /remote/api/actions`, `POST /remote/api/actions/step-up`, `GET /remote/api/instances/:id/players`, `POST …/say`, `…/kick`, `…/restart`). Still no free RCON, start, stop, configuration, vault or user management from the phone. The 4.18.16 gate lists exactly these writes.

### Checks

- Gate: `scripts/verify-4.18.19-actions-gate.mjs` (11 checks).
- Tests: `test/remote-actions.test.mjs` (say text and packet, guard, gateway with fake second factor and fake actions, proxy mode), `test/remote-actions-http.test.mjs` (real backend with real TOTP: switches, recovery code and replay refused, chain down to the instance lookup), `test/instance-rcon-kick.test.mjs` (say in the RCON service), `test/remote-ui.test.mjs` (actions panel).
- Still open: a real message, kick and restart on a running CoD4x server from a phone.
