import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import express from 'express';
import { LoginThrottle } from './login-throttle.mjs';

// Block 24b: remote gateway for browser and phone. A second, separate listener
// that serves the mobile web app and a fixed whitelist of read-only routes. The
// full admin API (vault, installer, config, RCON, plugins) is not reachable
// through it and keeps listening on loopback only. Without TLS the gateway only
// binds a loopback address; in Tailscale mode `tailscale serve` terminates HTTPS
// and forwards to it.
export const REMOTE_DEFAULT_PORT = 8788;
export const REMOTE_COOKIE = 'cod4x_remote';
export const REMOTE_MFA_ROLES = Object.freeze(['admin', 'operator']);
export const REMOTE_ROUTES = Object.freeze(['GET /remote/api/info', 'POST /remote/api/login', 'POST /remote/api/logout', 'GET /remote/api/me', 'GET /remote/api/monitor/overview', 'GET /remote/api/monitor/instances/:id/history', 'GET /remote/api/monitor/instances/:id/events']);
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
// spoofed identity headers before it forwards.
function clientOf(req) {
  const peer = req.socket.remoteAddress || '';
  const local = isLoopbackAddress(peer);
  const forwarded = local ? String(req.get('x-forwarded-for') || '').split(',')[0].trim() : '';
  const tailscaleUser = local ? req.get('tailscale-user-login') || null : null;
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

export function createRemoteGateway({ login, verifySecondFactor, hasPermission, monitor, sessions, throttle = new LoginThrottle(), audit = () => {}, staticDir = null, version = '', sourceUrl = '', mfaRoles = REMOTE_MFA_ROLES }) {
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
    const who = clientOf(req), key = LoginThrottle.key(`remote:${who.client}`, username);
    const details = { username, client: who.client, tailscaleUser: who.tailscaleUser };
    const lock = throttle.check(key);
    if (lock.locked) {
      res.setHeader('Retry-After', String(Math.ceil(lock.retryAfterMs / 1000)));
      audit('warn', 'remote.login.locked', details);
      return res.status(429).json({ ok: false, code: 'REMOTE_LOGIN_LOCKED', retryAfterMs: lock.retryAfterMs });
    }
    const refuse = (status, codeName, { count = true, level = 'warn' } = {}) => {
      const locked = count ? throttle.fail(key) : false;
      audit(level, locked ? 'remote.login.locked' : 'remote.login.failed', { ...details, reason: codeName });
      return res.status(status).json({ ok: false, code: codeName });
    };
    let user;
    try { user = username && password ? await login({ username, password }) : null; } catch { user = null; }
    if (!user) return refuse(401, 'REMOTE_LOGIN_INVALID');
    if (user.remoteAccess !== true) return refuse(403, 'REMOTE_ACCESS_DENIED', { count: false });
    if (!user.totpEnabled && mfaRoles.includes(user.role)) return refuse(403, 'REMOTE_TOTP_SETUP_REQUIRED', { count: false });
    let mfa = false;
    if (user.totpEnabled) {
      if (!code) return res.status(401).json({ ok: false, code: 'REMOTE_TOTP_REQUIRED' });
      const second = await verifySecondFactor(user.username, code).catch(() => ({ ok: false }));
      if (!second?.ok) return refuse(401, 'REMOTE_TOTP_INVALID');
      mfa = true;
      if (second.method === 'recovery') audit('warn', 'remote.login.recovery_code', { ...details, username: user.username, remaining: second.remaining ?? null });
    }
    throttle.succeed(key);
    const created = sessions.create({ username: user.username, role: user.role, mfa, client: who.client, tailscaleUser: who.tailscaleUser });
    setCookie(res, created.token, Math.floor((created.session.absoluteExpiresAt - created.session.createdAt) / 1000));
    audit('info', 'remote.login', { ...details, username: user.username, sessionId: created.session.sessionId, mfa });
    res.json({ ok: true, user: { username: user.username, role: user.role }, mfa, expiresAt: created.session.expiresAt });
  });
  api.post('/logout', (req, res) => {
    const token = readCookie(req.headers.cookie, REMOTE_COOKIE);
    const current = sessions.get(token);
    sessions.destroy(token);
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
