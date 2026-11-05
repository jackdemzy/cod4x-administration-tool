# COD4X CONTROL 4.18.18

## Alerts (Roadmap Block 24c)

A message on the phone when a server goes down or comes back. Off by default; switched on under Monitoring → Benachrichtigungen (needs `config.manage`).

- **Rules** (`lib/monitor-alerts.mjs`):
  - Outage with cause (crash or no answer) and "back up" with the outage duration. The debounce comes from 24a: no answer counts after 45 s, a crash at once.
  - Low disk space (threshold in GB, default 5; reported once while low, 10 % hysteresis).
  - Optional: B3 stopped while the server runs (only after B3 was seen running). Optional: player threshold, fires when crossed.
  - Planned stops are silent unless switched on.
  - Repeat brake: the same alert at most once per 30 min (5–1440 configurable), the all-clear exactly once and only for an alert that went out. An outage inside the brake is sent when the brake ends if the server is still down, so a long outage is never hidden.
- **Discord webhook** (`lib/discord-webhook.mjs`): only `https://discord.com/api/webhooks/…` or `discordapp.com`, no query, no port, no redirects, 5 s timeout. A `429` with a short `Retry-After`/`retry_after` (≤ 10 s) is retried once. Mentions are switched off, so a server name like `@everyone` pings nobody. The URL works like a password: it is stored in a 0600 file (so alerts also go out while the vault is locked) and only ever shown masked; the audit never contains it.
- **Web Push** (`lib/web-push.mjs`) to the phone app from 24b, without an extra package:
  - Encryption per RFC 8291 (aes128gcm, RFC 8188), sender identification per RFC 8292 (VAPID, ES256). The encryption reproduces the RFC 8291 Appendix A example byte for byte.
  - Push services are limited to the ones the big browsers use (FCM, Mozilla, Apple, Windows), so a remote user cannot make the tool send requests to arbitrary hosts.
  - Each remote user registers their own device in the app ("Push aktivieren"), at most 5 devices per user. Losing remote access (or a disabled account) removes the user's devices; `404/410` from the push service removes a subscription.
  - The message carries server name, state and cause only, never console lines. iPhone: iOS 16.4 or later, app added to the home screen.
- **Settings:** channels, thresholds and "Testalarm senden" in one section. Audit events `alert.configured`, `alert.sent`, `alert.failed`, `alert.push.subscribed`, without URL.
- **Public domain with Caddy (optional):** new gateway mode "Öffentliche Domain hinter Caddy". The gateway stays on 127.0.0.1; Caddy on the same machine terminates HTTPS with Let's Encrypt. The Caddyfile (`docs/Caddyfile.example`, shown in the app with your domain) sets HSTS, only forwards `/remote` and strips Tailscale identity headers. In this mode every role needs a second factor, the login brake locks after 5 failures instead of 10, and Tailscale headers are ignored. Changing the mode ends all remote sessions. Tailscale remains the recommendation.
- **Gateway whitelist:** three new routes, `GET /remote/api/push/key`, `POST /remote/api/push/subscribe`, `POST /remote/api/push/unsubscribe` (session with `monitor.read`, same-origin). The 4.18.16 gate now allows exactly these writes besides login and logout.
- No e-mail, so no SMTP credentials in the tool.

### Checks

- Gate: `scripts/verify-4.18.18-alerts-gate.mjs` (14 checks).
- Tests: `test/alerts.test.mjs` (RFC vectors, VAPID signature, rules and brake, Discord against a fake HTTP server, notifier files and eligibility), `test/alerts-http.test.mjs` (real backend: settings, masking, push subscription through the gateway, proxy mode), `test/remote-ui.test.mjs`.
- Push sign-up checked with Playwright in Chromium on a phone viewport. Headless Chromium has no push service, so the subscription itself was stubbed; the app, the server key, the stored subscription and switching off were real.
- Still open: a real push on a phone, a real Discord channel, and Caddy with Let's Encrypt on a public domain.
