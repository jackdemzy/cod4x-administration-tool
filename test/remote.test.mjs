import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { base32Decode, base32Encode, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, hotp, matchRecoveryCode, totp, totpUri, verifyTotp } from '../lib/totp.mjs';
import { LoginThrottle } from '../lib/login-throttle.mjs';
import { RemoteSessions } from '../lib/remote-sessions.mjs';
import { REMOTE_COOKIE, REMOTE_CSP, createRemoteGateway, isLoopbackAddress, listenRemoteGateway, remoteListenOptions } from '../lib/remote-gateway.mjs';

const clock = start => { let now = start; return { now: () => now, advance: ms => { now += ms; } }; };

test('TOTP matches the RFC 6238 SHA-1 test vectors', () => {
  const key = Buffer.from('12345678901234567890');
  for (const [seconds, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(hotp(key, Math.floor(seconds / 30), 8), expected, `T=${seconds}`);
  }
  assert.equal(base32Encode(key), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'), key);
  assert.throws(() => base32Decode('not base32!'), { code: 'TOTP_SECRET_INVALID' });
});

test('TOTP accepts one step of drift and refuses a replayed step', () => {
  const secret = generateTotpSecret(), now = Date.UTC(2026, 10, 5, 12);
  assert.equal(base32Decode(secret).length, 20);
  const step = verifyTotp(secret, totp(secret, now), { now });
  assert.equal(step, Math.floor(now / 30e3));
  assert.equal(verifyTotp(secret, totp(secret, now - 30e3), { now }), step - 1, 'previous step still valid');
  assert.equal(verifyTotp(secret, totp(secret, now - 90e3), { now }), null, 'older codes are refused');
  assert.equal(verifyTotp(secret, totp(secret, now), { now, lastStep: step }), null, 'a used step does not work twice');
  assert.equal(verifyTotp(secret, '12345', { now }), null);
  assert.match(totpUri({ secret, account: 'wolf' }), /^otpauth:\/\/totp\/COD4X%20CONTROL:wolf\?secret=[A-Z2-7]+&issuer=COD4X%20CONTROL&algorithm=SHA1&digits=6&period=30$/);
});

test('recovery codes are random, hashed and matched case-insensitively', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.ok(codes.every(code => /^[A-Z2-7]{5}-[A-Z2-7]{5}$/.test(code)));
  const hashes = codes.slice(0, 3).map(hashRecoveryCode);
  assert.ok(hashes.every(entry => !JSON.stringify(entry).includes(codes[0].replace('-', ''))));
  assert.equal(matchRecoveryCode(codes[1].toLowerCase().replace('-', ' '), hashes), 1);
  assert.equal(matchRecoveryCode(codes[5], hashes), -1);
  assert.equal(matchRecoveryCode('short', hashes), -1);
});

test('login throttle locks after 10 failures in 15 minutes and forgets after the lock', () => {
  const time = clock(0), throttle = new LoginThrottle({ now: time.now });
  const key = LoginThrottle.key('100.64.0.2', 'Wolf');
  assert.equal(key, LoginThrottle.key('100.64.0.2', ' wolf '));
  for (let i = 0; i < 9; i++) { assert.equal(throttle.fail(key), false); time.advance(1000); }
  assert.equal(throttle.check(key).locked, false);
  assert.equal(throttle.fail(key), true);
  assert.equal(throttle.check(key).locked, true);
  assert.equal(throttle.check(LoginThrottle.key('100.64.0.3', 'wolf')).locked, false, 'other clients are not locked');
  time.advance(15 * 60e3);
  assert.equal(throttle.check(key).locked, false);
  for (let i = 0; i < 9; i++) throttle.fail(key);
  time.advance(16 * 60e3);
  assert.equal(throttle.fail(key), false, 'failures outside the window do not count');
  throttle.succeed(key);
  assert.equal(throttle.size, 0);
  const bounded = new LoginThrottle({ maxEntries: 5 });
  for (let i = 0; i < 50; i++) bounded.fail(`client|${i}`);
  assert.equal(bounded.size, 5);
});

test('remote sessions keep only token hashes and expire idle and absolute', () => {
  const time = clock(0), sessions = new RemoteSessions({ now: time.now });
  const { token, session } = sessions.create({ username: 'wolf', role: 'viewer' });
  assert.ok(token.length >= 43);
  assert.ok(!JSON.stringify(sessions.list()).includes(token));
  time.advance(29 * 60e3); assert.ok(sessions.get(token));
  time.advance(31 * 60e3); assert.equal(sessions.get(token), null, 'idle timeout');
  const long = sessions.create({ username: 'wolf', role: 'viewer' });
  for (let i = 0; i < 25; i++) { time.advance(29 * 60e3); sessions.get(long.token); }
  assert.equal(sessions.get(long.token), null, 'absolute 12 h');
  const other = sessions.create({ username: 'Wolf', role: 'viewer' });
  assert.equal(sessions.revokeUser('wolf'), 1);
  assert.equal(sessions.get(other.token), null);
  const third = sessions.create({ username: 'a', role: 'viewer' });
  assert.equal(sessions.revoke(third.session.sessionId), true);
  assert.notEqual(session.sessionId, third.session.sessionId);
});

test('gateway binds plain HTTP only on loopback', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('100.64.0.1'), false);
  assert.deepEqual(remoteListenOptions({ host: '127.0.0.1', port: 8788 }), { host: '127.0.0.1', port: 8788, tls: null });
  assert.throws(() => remoteListenOptions({ host: '0.0.0.0', port: 8788 }), { code: 'REMOTE_TLS_REQUIRED' });
  assert.throws(() => remoteListenOptions({ host: '192.168.1.5', port: 8788 }), { code: 'REMOTE_TLS_REQUIRED' });
  assert.throws(() => remoteListenOptions({ host: 'localhost', port: 8788 }), { code: 'REMOTE_HOST_INVALID' });
  assert.throws(() => remoteListenOptions({ host: '127.0.0.1', port: 80 }), { code: 'REMOTE_PORT_INVALID' });
  assert.equal(remoteListenOptions({ host: '192.168.1.5', port: 8788, tls: { cert: 'c', key: 'k' } }).host, '192.168.1.5');
});

async function gateway(t, overrides = {}) {
  const now = Date.UTC(2026, 10, 5, 12);
  const secret = generateTotpSecret();
  const users = {
    viewer: { username: 'viewer', role: 'viewer', remoteAccess: true, totpEnabled: false },
    watcher: { username: 'watcher', role: 'monitor', remoteAccess: true, totpEnabled: true },
    admin: { username: 'admin', role: 'admin', remoteAccess: true, totpEnabled: false },
    local: { username: 'local', role: 'viewer', remoteAccess: false, totpEnabled: false },
  };
  const audits = [];
  const matrix = { admin: ['monitor.read', 'diagnostics.read'], viewer: ['monitor.read', 'diagnostics.read'], monitor: ['monitor.read'] };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-remote-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'remote.html'), '<!doctype html><title>remote</title>');
  const app = createRemoteGateway({
    login: async ({ username, password }) => password === 'correct-horse-battery' ? users[username] || null : null,
    verifySecondFactor: async (username, code) => ({ ok: verifyTotp(secret, code, { now: Date.now() }) !== null, method: 'totp' }),
    hasPermission: (role, permission) => (matrix[role] || []).includes(permission),
    monitor: { overview: async () => ({ instances: [{ id: 'a' }] }), history: async (id, range) => { if (range === '1y') throw Object.assign(new Error('x'), { code: 'MONITOR_RANGE_INVALID' }); return { range }; },
      events: async () => ({ events: [{ kind: 'down', cause: { kind: 'crash', console: ['secret line'] } }] }) },
    sessions: new RemoteSessions(), audit: (level, event, details) => audits.push({ level, event, ...details }), staticDir: dir, version: '4.18.16', sourceUrl: 'https://example.invalid/src',
    ...overrides,
  });
  const server = await listenRemoteGateway(app, { host: '127.0.0.1', port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
  return { base, post, audits, secret, now };
}

test('gateway login: password, remote access, second factor and cookie flags', async t => {
  const { base, post, audits, secret } = await gateway(t);
  const wrong = await post('/remote/api/login', { username: 'viewer', password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.equal((await post('/remote/api/login', { username: 'local', password: 'correct-horse-battery' })).status, 403);
  assert.equal((await (await post('/remote/api/login', { username: 'admin', password: 'correct-horse-battery' })).json()).code, 'REMOTE_TOTP_SETUP_REQUIRED');
  assert.equal((await (await post('/remote/api/login', { username: 'watcher', password: 'correct-horse-battery' })).json()).code, 'REMOTE_TOTP_REQUIRED');
  assert.equal((await post('/remote/api/login', { username: 'watcher', password: 'correct-horse-battery', code: '000000' })).status, 401);
  const ok = await post('/remote/api/login', { username: 'watcher', password: 'correct-horse-battery', code: totp(secret) });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, new RegExp(`^${REMOTE_COOKIE}=[A-Za-z0-9_-]{43}; Path=/remote; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$`));
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.headers.get('access-control-allow-origin'), null, 'no CORS');
  assert.equal(ok.headers.get('content-security-policy'), REMOTE_CSP);
  assert.equal(ok.headers.get('x-frame-options'), 'DENY');
  const token = cookie.split(';')[0];
  const me = await (await fetch(`${base}/remote/api/me`, { headers: { cookie: token } })).json();
  assert.deepEqual([me.user.username, me.mfa, me.version, me.sourceUrl], ['watcher', true, '4.18.16', 'https://example.invalid/src']);
  assert.ok(audits.some(entry => entry.event === 'remote.login' && entry.username === 'watcher' && entry.mfa === true));
  assert.ok(!JSON.stringify(audits).includes('correct-horse-battery'));
  await post('/remote/api/logout', {}, { cookie: token });
  assert.equal((await fetch(`${base}/remote/api/me`, { headers: { cookie: token } })).status, 401);
});

test('gateway refuses cross-site writes, non-JSON bodies and locks after 10 failures', async t => {
  const { base, post } = await gateway(t);
  assert.equal((await post('/remote/api/login', { username: 'viewer', password: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${base}/remote/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403, 'no Origin, no Sec-Fetch-Site');
  assert.equal((await post('/remote/api/login', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await fetch(`${base}/remote/api/login`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: base }, body: 'username=a' })).status, 415);
  assert.equal((await fetch(`${base}/remote/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{' })).status, 400);
  for (let i = 0; i < 10; i++) await post('/remote/api/login', { username: 'viewer', password: 'wrong' });
  const locked = await post('/remote/api/login', { username: 'viewer', password: 'correct-horse-battery' });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 800);
});

test('gateway serves only the whitelist; console lines need diagnostics.read and a second factor', async t => {
  const { base, post } = await gateway(t);
  const login = await post('/remote/api/login', { username: 'viewer', password: 'correct-horse-battery' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = route => fetch(base + route, { headers: { cookie } });
  assert.equal((await (await get('/remote/api/monitor/overview')).json()).monitor.instances.length, 1);
  assert.equal((await get('/remote/api/monitor/instances/a/history?range=1y')).status, 400);
  const events = await (await get('/remote/api/monitor/instances/a/events')).json();
  assert.deepEqual(events.events[0].cause.console, [], 'viewer without TOTP sees no console lines');
  for (const route of ['/api/auth/login', '/api/vault/status', '/remote/api/../api/diagnostics', '/remote/api/instances', '/remote/api/rcon/command']) assert.equal((await get(route)).status, 404, route);
  assert.equal((await fetch(`${base}/remote/api/monitor/overview`)).status, 401);
  const page = await fetch(`${base}/remote/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-security-policy'), REMOTE_CSP);
  assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).headers.get('location'), '/remote/');
});

// Security audit 4.18.26, finding A5-3: a local caller can set X-Forwarded-For on
// every attempt; the per-user brake must still stop unlimited password guessing.
test('gateway brake per user holds when X-Forwarded-For changes on every attempt (A5-3)', async t => {
  const { post } = await gateway(t);
  let last;
  for (let i = 0; i < 31; i++) last = await post('/remote/api/login', { username: 'viewer', password: 'wrong' }, { 'x-forwarded-for': `203.0.113.${i + 1}` });
  assert.equal(last.status, 429, 'locked after the per-user limit');
  const right = await post('/remote/api/login', { username: 'viewer', password: 'correct-horse-battery' }, { 'x-forwarded-for': '198.51.100.7' });
  assert.equal(right.status, 429, 'a fresh client address does not lift the per-user lock');
  const other = await post('/remote/api/login', { username: 'admin', password: 'wrong' }, { 'x-forwarded-for': '198.51.100.8' });
  assert.equal(other.status, 401, 'other users are not affected');
});
