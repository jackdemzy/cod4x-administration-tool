import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import express from 'express';
import { LoginThrottle } from './login-throttle.mjs';
import { RemoteActionGuard } from './remote-actions.mjs';

// Block 24b: remote gateway for browser and phone. A second, separate listener
// that serves the mobile web app and a fixed whitelist of read-only routes. The
// full admin API (vault, installer, config, RCON, plugins) is not reachable
// through it and keeps listening on loopback only. Without TLS the gateway only
// binds a loopback address; in Tailscale mode `tailscale serve` terminates HTTPS
// and forwards to it.
export const REMOTE_DEFAULT_PORT = 8788;
export const REMOTE_COOKIE = 'cod4x_remote';
export const REMOTE_MFA_ROLES = Object.freeze(['admin', 'operator']);
// Block 24c: behind a public reverse proxy (Caddy) every role needs a second
// factor and the login brake locks after 5 failures instead of 10.
export const REMOTE_PROXY_MAX_FAILURES = 5;
// Security audit 4.18.26 (A5-3): the client address behind a local proxy comes from
// X-Forwarded-For, which a local caller can set freely. A second brake per user name,
// independent of the client, caps password guessing for every remote client together.
export const REMOTE_USER_MAX_FAILURES = 30;
export const REMOTE_ROUTES = Object.freeze(['GET /remote/api/info', 'POST /remote/api/login', 'POST /remote/api/logout', 'GET /remote/api/me', 'GET /remote/api/monitor/overview', 'GET /remote/api/monitor/instances/:id/history', 'GET /remote/api/monitor/instances/:id/events', 'GET /remote/api/push/key', 'POST /remote/api/push/subscribe', 'POST /remote/api/push/unsubscribe',
  // Block 24d: actions with step-up (server.manage, second factor, switched on per gateway and user).
  'GET /remote/api/actions', 'POST /remote/api/actions/step-up', 'GET /remote/api/instances/:id/players', 'POST /remote/api/instances/:id/say', 'POST /remote/api/instances/:id/kick', 'POST /remote/api/instances/:id/restart']);
// The writes: logging in and out, a user's own push subscription, the step-up
// and the three server actions. Nothing else (no free RCON, no config, no vault).
export const REMOTE_WRITE_ROUTES = Object.freeze(['POST /remote/api/login', 'POST /remote/api/logout', 'POST /remote/api/push/subscribe', 'POST /remote/api/push/unsubscribe', 'POST /remote/api/actions/step-up', 'POST /remote/api/instances/:id/say', 'POST /remote/api/instances/:id/kick', 'POST /remote/api/instances/:id/restart']);
export const REMOTE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function isLoopbackAddress(address) {
  const value = String(address || '').replace(/^::ffff:/, '');
  return net.isIPv4(value) ? value.startsWith('127.') : value === '::1';
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

const securityHeaders = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', REMOTE_CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
};

// Who is asking. Forwarded headers count only when the direct peer is local
// (tailscale serve or a reverse proxy on the same machine); Tailscale strips
// spoofed identity headers before it forwards. Behind a public proxy anyone can
// send a Tailscale header, so it is ignored there.
function clientOf(req, { proxy = false } = {}) {
  const peer = req.socket.remoteAddress || '';
  const local = isLoopbackAddress(peer);
  const forwarded = local ? String(req.get('x-forwarded-for') || '').split(',')[0].trim() : '';
  const tailscaleUser = local && !proxy ? req.get('tailscale-user-login') || null : null;
  return { client: forwarded || (tailscaleUser ? `tailscale:${tailscaleUser}` : '') || peer || 'unknown', local, tailscaleUser };
}

// A write must come from the app's own page: Sec-Fetch-Site same-origin, or an
// Origin whose host is the host the browser addressed. Neither present = refused.
export function sameOrigin(req) {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = req.get('origin');
  if (!origin) return false;
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  const local = isLoopbackAddress(req.socket.remoteAddress);
  return [req.get('host'), local ? req.get('x-forwarded-host') : null].filter(Boolean).some(value => value.toLowerCase() === host.toLowerCase());
}

export function createRemoteGateway({ login, verifySecondFactor, hasPermission, monitor, sessions, throttle = new LoginThrottle(), proxyThrottle = new LoginThrottle({ maxFailures: REMOTE_PROXY_MAX_FAILURES }), userThrottle = new LoginThrottle({ maxFailures: REMOTE_USER_MAX_FAILURES }), policy = () => ({ proxy: false }), push = null, actions = null, actionGuard = new RemoteActionGuard(), audit = () => {}, staticDir = null, version = '', sourceUrl = '', mfaRoles = REMOTE_MFA_ROLES }) {
  if (typeof login !== 'function' || typeof verifySecondFactor !== 'function' || typeof hasPermission !== 'function' || !monitor || !sessions) fail('REMOTE_GATEWAY_INVALID');
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('strict routing', true); // /remote and /remote/ are different routes (redirect)
  app.use(securityHeaders);
  const api = express.Router();
  api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    if (!sameOrigin(req)) return res.status(403).json({ ok: false, code: 'REMOTE_ORIGIN_REFUSED' });
    if (!req.is('application/json')) return res.status(415).json({ ok: false, code: 'REMOTE_JSON_REQUIRED' });
    next();
  });
  api.use(express.json({ limit: '2kb', strict: true }));
  const setCookie = (res, token, maxAgeSeconds) => res.setHeader('Set-Cookie', `${REMOTE_COOKIE}=${token}; Path=/remote; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`);
  const session = req => sessions.get(readCookie(req.headers.cookie, REMOTE_COOKIE));
  const requireSession = (permission) => (req, res, next) => {
    const current = session(req);
    if (!current) return res.status(401).json({ ok: false, code: 'REMOTE_LOGIN_REQUIRED' });
    if (permission && !hasPermission(current.role, permission)) return res.status(403).json({ ok: false, code: 'REMOTE_PERMISSION_DENIED' });
    req.remote = current; next();
  };

  // Public: version and the AGPL-3.0 §13 source link, shown on the login page too.
  api.get('/info', (_req, res) => res.json({ ok: true, version, sourceUrl, license: 'AGPL-3.0-or-later' }));
  api.post('/login', async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().slice(0, 64) : '';
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 256) : '';
    const code = typeof req.body?.code === 'string' ? req.body.code.slice(0, 32) : '';
    // Own key space: failed remote logins never lock the local login of that user,
    // even when every remote request reaches us from the loopback proxy.
    const proxy = policy()?.proxy === true, brake = proxy ? proxyThrottle : throttle;
    const who = clientOf(req, { proxy }), key = LoginThrottle.key(`remote:${who.client}`, username);
    const details = { username, client: who.client, tailscaleUser: who.tailscaleUser, ...(proxy ? { proxy: true } : {}) };
    const userKey = LoginThrottle.key('remote-user', username);
    const own = brake.check(key), shared = userThrottle.check(userKey);
    const lock = own.retryAfterMs >= shared.retryAfterMs ? own : shared;
    if (lock.locked) {
      res.setHeader('Retry-After', String(Math.ceil(lock.retryAfterMs / 1000)));
      audit('warn', 'remote.login.locked', details);
      return res.status(429).json({ ok: false, code: 'REMOTE_LOGIN_LOCKED', retryAfterMs: lock.retryAfterMs });
    }
    const refuse = (status, codeName, { count = true, level = 'warn' } = {}) => {
      const locked = count ? [brake.fail(key), userThrottle.fail(userKey)].some(Boolean) : false;
      audit(level, locked ? 'remote.login.locked' : 'remote.login.failed', { ...details, reason: codeName });
      return res.status(status).json({ ok: false, code: codeName });
    };
    let user;
    try { user = username && password ? await login({ username, password }) : null; } catch { user = null; }
    if (!user) return refuse(401, 'REMOTE_LOGIN_INVALID');
    if (user.remoteAccess !== true) return refuse(403, 'REMOTE_ACCESS_DENIED', { count: false });
    if (!user.totpEnabled && (proxy || mfaRoles.includes(user.role))) return refuse(403, 'REMOTE_TOTP_SETUP_REQUIRED', { count: false });
    let mfa = false;
    if (user.totpEnabled) {
      if (!code) return res.status(401).json({ ok: false, code: 'REMOTE_TOTP_REQUIRED' });
      const second = await verifySecondFactor(user.username, code).catch(() => ({ ok: false }));
      if (!second?.ok) return refuse(401, 'REMOTE_TOTP_INVALID');
      mfa = true;
      if (second.method === 'recovery') audit('warn', 'remote.login.recovery_code', { ...details, username: user.username, remaining: second.remaining ?? null });
    }
    brake.succeed(key); userThrottle.succeed(userKey);
    const created = sessions.create({ username: user.username, role: user.role, mfa, client: who.client, tailscaleUser: who.tailscaleUser });
    setCookie(res, created.token, Math.floor((created.session.absoluteExpiresAt - created.session.createdAt) / 1000));
    audit('info', 'remote.login', { ...details, username: user.username, sessionId: created.session.sessionId, mfa });
    res.json({ ok: true, user: { username: user.username, role: user.role }, mfa, expiresAt: created.session.expiresAt });
  });
  api.post('/logout', (req, res) => {
    const token = readCookie(req.headers.cookie, REMOTE_COOKIE);
    const current = sessions.get(token);
    sessions.destroy(token);
    if (current) actionGuard.revoke(current.sessionId);
    setCookie(res, '', 0);
    if (current) audit('info', 'remote.logout', { username: current.username, sessionId: current.sessionId });
    res.json({ ok: true });
  });
  api.get('/me', requireSession(null), (req, res) => {
    res.json({ ok: true, user: { username: req.remote.username, role: req.remote.role }, mfa: req.remote.mfa, expiresAt: req.remote.expiresAt, monitor: hasPermission(req.remote.role, 'monitor.read'), version, sourceUrl });
  });
  const monitorRoute = action => async (req, res) => {
    try { res.json({ ok: true, ...(await action(req)) }); }
    catch (error) { const code = error.code || 'MONITOR_FAILED'; res.status(code === 'INSTANCE_NOT_FOUND' ? 404 : code === 'MONITOR_RANGE_INVALID' ? 400 : 500).json({ ok: false, code }); }
  };
  const monitorRead = requireSession('monitor.read');
  api.get('/monitor/overview', monitorRead, monitorRoute(async () => ({ monitor: await monitor.overview() })));
  api.get('/monitor/instances/:id/history', monitorRead, monitorRoute(async req => ({ history: await monitor.history(req.params.id, String(req.query.range || '24h')) })));
  // Console lines of an outage need diagnostics.read and a second factor remotely.
  api.get('/monitor/instances/:id/events', monitorRead, monitorRoute(async req => {
    const result = await monitor.events(req.params.id, String(req.query.range || '7d'));
    const consoleAllowed = req.remote.mfa && hasPermission(req.remote.role, 'diagnostics.read');
    return { ...result, events: (result.events || []).map(event => event.cause && !consoleAllowed ? { ...event, cause: { ...event.cause, console: [] } } : event) };
  }));
  // Block 24c: each remote user registers their own device for push alerts.
  const pushRoute = action => async (req, res) => {
    if (!push) return res.status(503).json({ ok: false, code: 'PUSH_UNAVAILABLE' });
    try { res.json({ ok: true, ...(await action(req)) }); }
    catch (error) { const code = /^PUSH_/.test(error.code || '') ? error.code : 'PUSH_FAILED'; res.status(code === 'PUSH_FAILED' ? 500 : 400).json({ ok: false, code }); }
  };
  api.get('/push/key', monitorRead, pushRoute(async req => ({ publicKey: push.publicKey(), enabled: push.enabled(), mine: push.count(req.remote.username) })));
  api.post('/push/subscribe', monitorRead, pushRoute(async req => {
    const result = await push.subscribe(req.remote.username, req.body?.subscription);
    return { subscribed: true, renewed: result.renewed };
  }));
  api.post('/push/unsubscribe', monitorRead, pushRoute(async req => ({ removed: (await push.unsubscribe(req.remote.username, typeof req.body?.endpoint === 'string' ? req.body.endpoint : '')).removed })));
  // Block 24d: say, kick and restart from the phone. Needs server.manage, a
  // session opened with the second factor, the gateway switch and the user's
  // own switch; then a fresh TOTP code (step-up). Also over the public proxy
  // (Rafiki's choice), where every role already logs in with TOTP.
  const actionsAllowed = remote => Boolean(actions && remote.mfa && hasPermission(remote.role, 'server.manage') && actions.allowed(remote.username));
  const requireActions = (req, res, next) => {
    if (!actionsAllowed(req.remote)) return res.status(403).json({ ok: false, code: 'REMOTE_ACTIONS_DISABLED' });
    next();
  };
  // A code in the request opens (or renews) the step-up window. TOTP only.
  const stepUp = async (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code.replace(/\s/g, '') : '';
    if (!code) return false;
    if (!/^\d{6}$/.test(code)) { res.status(401).json({ ok: false, code: 'REMOTE_STEP_UP_INVALID' }); return null; }
    const result = await verifySecondFactor(req.remote.username, code, { totpOnly: true }).catch(() => ({ ok: false }));
    if (!result?.ok) { audit('warn', 'remote.action.step_up_failed', { username: req.remote.username, sessionId: req.remote.sessionId, client: req.remote.client }); res.status(401).json({ ok: false, code: 'REMOTE_STEP_UP_INVALID' }); return null; }
    actionGuard.grant(req.remote.sessionId);
    return true;
  };
  const actionRoute = (kind, run) => async (req, res) => {
    const id = String(req.params.id || '');
    const details = { username: req.remote.username, sessionId: req.remote.sessionId, client: req.remote.client, tailscaleUser: req.remote.tailscaleUser, instanceId: id, ...(policy()?.proxy === true ? { proxy: true } : {}) };
    try {
      const fresh = await stepUp(req, res);
      if (fresh === null) return;
      actionGuard.check(req.remote.sessionId, kind, id, { freshCode: fresh });
      actionGuard.record(req.remote.sessionId, kind, id);
      const result = await run(req, id);
      audit('warn', `remote.action.${kind}`, { ...details, ok: true });
      void Promise.resolve(actions.notify?.(kind, { ...details, ...result })).catch(() => {});
      res.json({ ok: true, ...result, stepUpUntil: actionGuard.stepUpUntil(req.remote.sessionId) });
    } catch (error) {
      const code = /^(REMOTE|RCON|RUNTIME|INSTANCE|VAULT|CREDENTIAL)_[A-Z_]+$/.test(error.code || '') ? error.code : 'REMOTE_ACTION_FAILED';
      if (!/^REMOTE_(STEP_UP_REQUIRED|ACTION_LIMIT|RESTART_COOLDOWN)$/.test(code)) actionGuard.failed(kind, id);
      audit('warn', `remote.action.${kind}`, { ...details, ok: false, code });
      const status = code === 'REMOTE_STEP_UP_REQUIRED' ? 401 : code === 'REMOTE_ACTION_LIMIT' || code === 'REMOTE_RESTART_COOLDOWN' ? 429 : code === 'INSTANCE_NOT_FOUND' ? 404 : code === 'REMOTE_ACTION_FAILED' ? 500 : 409;
      if (error.retryAfterMs) res.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
      res.status(status).json({ ok: false, code, retryAfterMs: error.retryAfterMs ?? null });
    }
  };
  api.get('/actions', requireSession('monitor.read'), (req, res) => res.json({ ok: true, allowed: actionsAllowed(req.remote), stepUpUntil: actionGuard.stepUpUntil(req.remote.sessionId), kinds: ['say', 'kick', 'restart'] }));
  api.post('/actions/step-up', requireSession('server.manage'), requireActions, async (req, res) => {
    const fresh = await stepUp(req, res);
    if (fresh === null) return;
    if (!fresh) return res.status(400).json({ ok: false, code: 'REMOTE_STEP_UP_INVALID' });
    audit('info', 'remote.action.step_up', { username: req.remote.username, sessionId: req.remote.sessionId, client: req.remote.client });
    res.json({ ok: true, stepUpUntil: actionGuard.stepUpUntil(req.remote.sessionId) });
  });
  api.get('/instances/:id/players', requireSession('server.manage'), requireActions, async (req, res) => {
    try { res.json({ ok: true, ...(await actions.players(String(req.params.id))) }); }
    catch (error) { const code = /^(RCON|INSTANCE|VAULT|CREDENTIAL)_[A-Z_]+$/.test(error.code || '') ? error.code : 'REMOTE_ACTION_FAILED'; res.status(code === 'INSTANCE_NOT_FOUND' ? 404 : 409).json({ ok: false, code }); }
  });
  api.post('/instances/:id/say', requireSession('server.manage'), requireActions, actionRoute('say', (req, id) => actions.say(id, req.body?.text, req.remote.username)));
  api.post('/instances/:id/kick', requireSession('server.manage'), requireActions, actionRoute('kick', (req, id) => actions.kick(id, { slot: req.body?.slot, name: req.body?.name, reason: req.body?.reason ?? '' }, req.remote.username)));
  api.post('/instances/:id/restart', requireSession('server.manage'), requireActions, actionRoute('restart', (req, id) => actions.restart(id, req.remote.username)));
  api.use((req, res) => res.status(404).json({ ok: false, code: 'REMOTE_ROUTE_UNKNOWN' }));
  // Malformed JSON and the like: a fixed answer, never a stack trace.
  api.use((error, req, res, _next) => res.status(error.status === 413 ? 413 : 400).json({ ok: false, code: error.status === 413 ? 'REMOTE_BODY_TOO_LARGE' : 'REMOTE_BAD_REQUEST' }));
  app.use('/remote/api', api);

  const page = staticDir ? path.join(staticDir, 'remote.html') : null;
  app.get('/', (_req, res) => res.redirect(302, '/remote/'));
  app.get('/remote', (_req, res) => res.redirect(302, '/remote/'));
  app.get('/remote/', (_req, res) => {
    if (!page || !fs.existsSync(page)) return res.status(503).type('text/plain').send('COD4X CONTROL remote app is not built (npm run build).');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(page);
  });
  if (staticDir) app.use('/remote', express.static(staticDir, { index: false, dotfiles: 'deny', redirect: false, setHeaders: (res, file) => res.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache') }));
  app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));
  return app;
}

// Plain HTTP only on loopback; any other address needs a certificate and key.
export function remoteListenOptions({ host = '127.0.0.1', port = REMOTE_DEFAULT_PORT, tls = null } = {}) {
  if (!net.isIP(String(host))) fail('REMOTE_HOST_INVALID');
  // 0 lets the OS pick a free port (tests); settings only accept 1024-65535.
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) fail('REMOTE_PORT_INVALID');
  if (!isLoopbackAddress(host) && !(tls?.cert && tls?.key)) fail('REMOTE_TLS_REQUIRED');
  return { host, port, tls: tls?.cert && tls?.key ? tls : null };
}

export function listenRemoteGateway(app, options) {
  const { host, port, tls } = remoteListenOptions(options);
  const server = tls ? https.createServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' }, app) : http.createServer(app);
  server.headersTimeout = 10e3; server.requestTimeout = 15e3;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server); });
  });
}

// Block 24c: Caddyfile for the reverse-proxy mode (docs/Caddyfile.example is
// this output for the placeholder domain and the default port). HSTS, only
// /remote is forwarded, Tailscale identity headers are stripped so nobody on
// the internet can claim one.
export function caddyfileTemplate(domain, port = REMOTE_DEFAULT_PORT) {
  return [
    `${domain || "monitor.example.org"} {`,
    "\tencode zstd gzip",
    "\theader {",
    "\t\tStrict-Transport-Security \"max-age=31536000; includeSubDomains\"",
    "\t\t-Server",
    "\t}",
    "\t# Only the remote app is forwarded; everything else goes to /remote/.",
    "\t@remote path /remote /remote/*",
    "\thandle @remote {",
    `\t\treverse_proxy 127.0.0.1:${port} {`,
    "\t\t\theader_up -Tailscale-User-Login",
    "\t\t\theader_up -Tailscale-User-Name",
    "\t\t\theader_up -Tailscale-User-Profile-Pic",
    "\t\t}",
    "\t}",
    "\thandle {",
    "\t\tredir * /remote/ 302",
    "\t}",
    "}",
    "",
  ].join("\n");
}
