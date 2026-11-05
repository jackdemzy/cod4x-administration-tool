import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { totp } from '../lib/totp.mjs';

const freePort = async () => {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  return port;
};

// Block 24b: remote gateway on an isolated backend: settings, per-user access,
// TOTP enrolment, recovery code, revocation and the shared login brake.
test('remote gateway: settings, remote access, TOTP enrolment, recovery code and revocation', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-remote-http-'));
  const port = await freePort(), remotePort = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^COD4X_/i.test(key)));
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', COD4X_DATA_ROOT: path.join(root, 'data'), COD4X_INSTALL_ROOT: path.join(root, 'installations'), COD4X_RUNTIME_ROOT: root, COD4X_MONITOR: 'off' });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../installer-server.mjs', import.meta.url))], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8000); });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { child.kill(); await closed; await fs.rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`, remote = `http://127.0.0.1:${remotePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80 && child.exitCode === null; attempt++) {
    try { if ((await fetch(`${url}/api/auth/status`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, `backend did not become ready: ${diagnostics}`);
  const call = async (token, route, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`${url}${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
    return { status: response.status, json: await response.json() };
  };
  const remoteCall = async (route, body, cookie) => {
    const response = await fetch(`${remote}${route}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Origin: remote, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
    return { status: response.status, json: await response.json().catch(() => null), cookie: response.headers.get('set-cookie')?.split(';')[0] || null };
  };
  const password = `${crypto.randomBytes(16).toString('hex')}Aa9!`;
  const admin = (await call(null, '/api/auth/init', { username: 'remoteAdmin', password })).json.token;
  const initial = await call(admin, '/api/remote');
  assert.equal(initial.status, 200);
  assert.deepEqual([initial.json.remote.settings.enabled, initial.json.remote.running, initial.json.remote.settings.mode], [false, false, 'tailscale']);

  // Settings are validated: the admin API port, LAN without certificate, bad types.
  for (const body of [{ enabled: true, port }, { enabled: true, mode: 'lan', lanHost: '192.168.1.5', port: remotePort }, { enabled: 'yes' }, { port: 80 }]) assert.equal((await call(admin, '/api/remote/settings', body)).status, 400, JSON.stringify(body));
  const enabled = await call(admin, '/api/remote/settings', { enabled: true, mode: 'tailscale', port: remotePort });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.json));
  assert.equal(enabled.json.remote.running, true, JSON.stringify(enabled.json.remote));
  assert.deepEqual(enabled.json.remote.address, { host: '127.0.0.1', port: remotePort });
  assert.equal(enabled.json.remote.tailscaleCommand, `tailscale serve --bg --https=443 127.0.0.1:${remotePort}`);

  // The gateway serves no admin route.
  for (const route of ['/api/auth/login', '/api/users', '/api/remote', '/remote/api/users']) assert.equal((await fetch(`${remote}${route}`)).status, 404, route);

  // Remote access is per user and off by default.
  assert.equal((await call(admin, '/api/users', { username: 'phone', password, role: 'viewer' })).status, 201);
  assert.equal((await remoteCall('/remote/api/login', { username: 'phone', password })).json.code, 'REMOTE_ACCESS_DENIED');
  assert.equal((await call(admin, '/api/users/phone', { remoteAccess: true }, 'PATCH')).status, 200);
  const phone = await remoteCall('/remote/api/login', { username: 'phone', password });
  assert.equal(phone.status, 200, JSON.stringify(phone.json));
  assert.equal((await remoteCall('/remote/api/monitor/overview', null, phone.cookie)).status, 200);
  assert.equal((await call(admin, '/api/remote')).json.remote.sessions.length, 1);

  // admin/operator need a second factor remotely.
  assert.equal((await call(admin, '/api/users/remoteAdmin', { remoteAccess: true, role: 'admin' }, 'PATCH')).status, 200);
  assert.equal((await remoteCall('/remote/api/login', { username: 'remoteAdmin', password })).json.code, 'REMOTE_TOTP_SETUP_REQUIRED');
  const setup = await call(admin, '/api/auth/totp/setup', {});
  assert.equal(setup.status, 200);
  assert.match(setup.json.uri, /^otpauth:\/\/totp\/COD4X%20CONTROL:remoteAdmin\?secret=/);
  assert.equal((await call(admin, '/api/auth/totp/confirm', { code: '000000' })).status, 400);
  const confirmed = await call(admin, '/api/auth/totp/confirm', { code: totp(setup.json.secret, Date.now() - 30e3) });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  assert.equal(confirmed.json.recoveryCodes.length, 10);
  assert.equal((await call(admin, '/api/auth/totp/setup', {})).status, 409);
  const stored = await fs.readFile(path.join(root, 'data', 'config', 'users.json'), 'utf8');
  assert.ok(!stored.includes(confirmed.json.recoveryCodes[0]) && !stored.includes(confirmed.json.recoveryCodes[0].replace('-', '')), 'recovery codes are stored as hashes only');
  assert.equal((await remoteCall('/remote/api/login', { username: 'remoteAdmin', password })).json.code, 'REMOTE_TOTP_REQUIRED');
  const code = totp(setup.json.secret);
  const adminRemote = await remoteCall('/remote/api/login', { username: 'remoteAdmin', password, code });
  assert.equal(adminRemote.status, 200, JSON.stringify(adminRemote.json));
  assert.equal(adminRemote.json.mfa, true);
  assert.equal((await remoteCall('/remote/api/login', { username: 'remoteAdmin', password, code })).json.code, 'REMOTE_TOTP_INVALID', 'a used code does not work twice');
  const recovery = await remoteCall('/remote/api/login', { username: 'remoteAdmin', password, code: confirmed.json.recoveryCodes[0] });
  assert.equal(recovery.status, 200);
  assert.equal((await remoteCall('/remote/api/login', { username: 'remoteAdmin', password, code: confirmed.json.recoveryCodes[0] })).json.code, 'REMOTE_TOTP_INVALID', 'a recovery code works once');
  assert.equal((await call(admin, '/api/auth/me')).json.user.recoveryRemaining, 9);

  // Narrowing access ends remote sessions at once.
  assert.equal((await call(admin, '/api/users/phone', { remoteAccess: false }, 'PATCH')).status, 200);
  assert.equal((await remoteCall('/remote/api/me', null, phone.cookie)).status, 401);
  const listed = (await call(admin, '/api/remote')).json.remote.sessions;
  assert.ok(listed.every(session => session.username === 'remoteAdmin' && session.mfa));
  assert.equal((await call(admin, `/api/remote/sessions/${listed[0].sessionId}/revoke`, {})).json.revoked, true);
  assert.equal((await call(admin, '/api/auth/totp/disable', { password: 'wrong' })).status, 401);
  assert.equal((await call(admin, '/api/auth/totp/disable', { password })).status, 200);
  assert.equal((await remoteCall('/remote/api/me', null, recovery.cookie)).status, 401, 'disabling TOTP ends remote sessions');

  // The login brake also guards the local login; remote failures do not lock it.
  assert.equal((await call(admin, '/api/users', { username: 'brake', password, role: 'viewer' })).status, 201);
  for (let i = 0; i < 10; i++) await remoteCall('/remote/api/login', { username: 'brake', password: 'wrong-password-123' });
  assert.equal((await remoteCall('/remote/api/login', { username: 'brake', password })).status, 429, 'remote pair locked');
  assert.equal((await call(null, '/api/auth/login', { username: 'brake', password })).status, 200, 'local login of the same user still works');
  for (let i = 0; i < 10; i++) assert.equal((await call(null, '/api/auth/login', { username: 'brake', password: 'wrong-password-123' })).status, 401);
  assert.equal((await call(null, '/api/auth/login', { username: 'brake', password })).status, 429);

  // Turning the gateway off closes the port and drops all remote sessions.
  const off = await call(admin, '/api/remote/settings', { enabled: false });
  assert.equal(off.json.remote.running, false);
  await assert.rejects(fetch(`${remote}/remote/api/me`, { signal: AbortSignal.timeout(2000) }));
  const audit = (await call(admin, '/api/audit')).json;
  const events = JSON.stringify(audit);
  for (const name of ['remote.gateway.started', 'remote.login', 'auth.totp.enabled', 'remote.login.recovery_code', 'auth.login_locked']) assert.ok(events.includes(name), name);
  assert.ok(!events.includes(password) && !events.includes(setup.json.secret), 'no password or TOTP secret in the audit');
});
