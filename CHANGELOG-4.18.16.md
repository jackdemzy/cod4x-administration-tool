# COD4X CONTROL 4.18.16

## Remote Access (Roadmap Block 24b)

Monitoring from browser and phone. Plan: Block 24 document, section "Teil 24b – Feinplan" (approved by Rafiki on 2026-11-05). Setup guide: `docs/REMOTE-ACCESS.md`.

### Implementation

- `lib/remote-gateway.mjs`: a second Express listener, off by default and separate from the admin API. It serves the web app at `/remote/` and a fixed whitelist:
  - `GET /remote/api/info`, `POST /remote/api/login`, `POST /remote/api/logout`, `GET /remote/api/me`;
  - the three monitoring routes of 24a.
  - Vault, installer, config, RCON, plugin and user routes do not exist there. There is no CORS.
- Binding:
  - Plain HTTP only on a loopback address. Any other address needs a certificate and key (`REMOTE_TLS_REQUIRED`).
  - In Tailscale mode the gateway listens on `127.0.0.1:8788`, and `tailscale serve --bg --https=443 127.0.0.1:8788` provides HTTPS inside the tailnet. Forwarded headers (`X-Forwarded-For`, `Tailscale-User-Login`) count only from a loopback peer.
- Session (`lib/remote-sessions.mjs`):
  - Cookie with `HttpOnly; Secure; SameSite=Strict; Path=/remote`, 30 min idle, 12 h absolute, separate from the bearer tokens of the local UI.
  - Only the SHA-256 of each token is kept. Sessions can be listed and revoked.
- Writes must be same-origin (`Sec-Fetch-Site` or `Origin` = host) and JSON, at most 2 kB.
- Response headers: CSP `default-src 'self'` with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin`, `no-store` for the API.
- Login brake (`lib/login-throttle.mjs`): 10 failures per client and user within 15 min lock that pair for 15 min. It applies to the remote and the local login, each with its own counter, so failed remote logins never lock the local login of the same user.
- Second factor (`lib/totp.mjs`):
  - TOTP per RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step) with `node:crypto` only, checked against the test vectors of RFC 6238 Appendix B. A used step is refused (no replay).
  - 10 recovery codes, each usable once, stored as scrypt hashes.
  - Each user sets it up themselves (`/api/auth/totp/setup|confirm|disable`). An admin can reset it (`PATCH /api/users/:name {totpReset:true}`).
  - It is required remotely for admin and operator. Without a second factor, outage console lines stay hidden remotely.
  - The secret is stored in `users.json` (0600) and not in the vault, so a locked vault does not lock remote logins out.
- Users:
  - `remoteAccess` per user, off by default.
  - Disabling the user, removing remote access, a new password or a TOTP reset ends that user's remote sessions at once.
- API (admin, `user.manage`): `GET /api/remote`, `POST /api/remote/settings`, `POST /api/remote/sessions/:id/revoke`, `POST /api/remote/sessions/revoke-all`. Settings live in `config/remote.json`.
- Web app (`remote.html`, `lib/remote-app.jsx`, built to `dist/remote/` by `npm run build`):
  - Login with optional code, then the 24a monitoring view.
  - Installable as a PWA. The service worker caches the app shell only, never API answers.
  - The footer on every page links the source code (AGPL-3.0 §13), also before login.
- Admin UI:
  - "Fernzugriff" below the monitoring view: own second factor, gateway on/off, mode, port, Tailscale command, active remote sessions.
  - "Benutzer & Rollen" gains a "Fern" toggle and "2FA zurücksetzen".
- `COD4X_REMOTE=off` keeps the gateway off. `COD4X_SOURCE_URL` overrides the source link.
- Audit: `remote.gateway.started|failed|configured`, `remote.login`, `remote.login.failed|locked|recovery_code`, `remote.logout`, `remote.session.revoked`, `auth.totp.enabled|disabled`, `auth.login_locked`.

### Fix

The auth routes called `audit({ level, event, details })`, but `audit` expects `(level, event, details)`. Login, logout and init entries were therefore recorded with the event name `[object Object]`. `audit` now accepts both forms.

### Tests

- `test/remote.test.mjs`: TOTP vectors, replay, recovery codes, brake, sessions, binding rules, gateway login/cookie/headers/CSRF/whitelist.
- `test/remote-http.test.mjs`: real backend covering settings, per-user access, enrolment, recovery code, revocation and the local brake.
- `test/remote-ui.test.mjs`: SSR of the web app and the admin panel.
- Gate: `scripts/verify-4.18.16-remote-gate.mjs`.
- Phone check with Playwright (390 × 844): login, monitoring, cookie flags (HttpOnly / Secure / Strict, not readable by JavaScript), service worker registered, no CSP violations, no horizontal scroll.

### Open

A native test with Tailscale on a real phone. Not in this block: alerts and Caddy (24c), actions with step-up (24d), QR code for the TOTP setup.
