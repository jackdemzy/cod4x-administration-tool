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
// Block 24d on the real backend: the switches, a real TOTP step-up (no
// recovery code, no replay) and the whole chain down to the instance lookup.
test('remote actions on the real backend: switches, TOTP step-up and audit', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-actions-http-'));
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
  const admin = (await call(null, '/api/auth/init', { username: 'actionAdmin', password })).json.token;
  assert.equal((await call(admin, '/api/remote/settings', { actions: 'yes' })).json.field, 'actions');
  const started = await call(admin, '/api/remote/settings', { enabled: true, mode: 'tailscale', port: remotePort });
  assert.equal(started.json.remote.running, true, JSON.stringify(started.json));
  assert.equal(started.json.remote.settings.actions, false, 'remote actions are off by default');
  assert.equal((await call(admin, '/api/users/actionAdmin', { remoteAccess: true, remoteActions: 'yes' }, 'PATCH')).status, 400);
  assert.equal((await call(admin, '/api/users/actionAdmin', { remoteAccess: true }, 'PATCH')).json.user.remoteActions, false);
  const setup = await call(admin, '/api/auth/totp/setup', {});
  // Codes for three consecutive steps (the verifier accepts one step either side);
  // start early in a step so the run does not cross a boundary.
  if (Date.now() % 30e3 > 25e3) await delay(30e3 - (Date.now() % 30e3) + 200);
  const t0 = Date.now();
  const confirmed = await call(admin, '/api/auth/totp/confirm', { code: totp(setup.json.secret, t0 - 30e3) });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  const login = await remoteCall('/remote/api/login', { username: 'actionAdmin', password, code: totp(setup.json.secret, t0) });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const cookie = login.cookie;

  // Gateway switch and user switch are both needed.
  assert.equal((await remoteCall('/remote/api/actions', null, cookie)).json.allowed, false);
  assert.equal((await call(admin, '/api/remote/settings', { actions: true })).status, 200);
  assert.equal((await remoteCall('/remote/api/actions', null, cookie)).json.allowed, false, 'the user switch is still off');
  assert.equal((await call(admin, '/api/users/actionAdmin', { remoteActions: true }, 'PATCH')).json.user.remoteActions, true);
  assert.equal((await remoteCall('/remote/api/actions', null, cookie)).json.allowed, true);

  assert.equal((await remoteCall('/remote/api/instances/none/say', { text: 'hi' }, cookie)).json.code, 'REMOTE_STEP_UP_REQUIRED');
  assert.equal((await remoteCall('/remote/api/actions/step-up', { code: confirmed.json.recoveryCodes[0] }, cookie)).json.code, 'REMOTE_STEP_UP_INVALID', 'recovery codes never authorise an action');
  assert.equal((await remoteCall('/remote/api/actions/step-up', { code: totp(setup.json.secret, t0) }, cookie)).json.code, 'REMOTE_STEP_UP_INVALID', 'the login code cannot be replayed');
  assert.equal((await remoteCall('/remote/api/instances/none/restart', {}, cookie)).json.code, 'REMOTE_STEP_UP_REQUIRED', 'restart needs its own code');
  // A fresh code with the restart also opens the window for say and kick.
  assert.equal((await remoteCall('/remote/api/instances/none/restart', { code: totp(setup.json.secret, t0 + 30e3) }, cookie)).status, 404);
  assert.ok((await remoteCall('/remote/api/actions', null, cookie)).json.stepUpUntil > Date.now());
  assert.deepEqual([(await remoteCall('/remote/api/instances/none/say', { text: 'hi' }, cookie)).status, (await remoteCall('/remote/api/instances/none/kick', { slot: 1, name: 'x' }, cookie)).status, (await remoteCall('/remote/api/instances/none/players', null, cookie)).status], [404, 404, 404]);
  assert.equal((await remoteCall('/remote/api/instances/none/restart', { code: totp(setup.json.secret, t0 + 30e3) }, cookie)).json.code, 'REMOTE_STEP_UP_INVALID', 'each code works once');

  // Taking the user switch away stops actions at once.
  assert.equal((await call(admin, '/api/users/actionAdmin', { remoteActions: false }, 'PATCH')).status, 200);
  assert.equal((await remoteCall('/remote/api/instances/none/say', { text: 'hi' }, cookie)).json.code, 'REMOTE_ACTIONS_DISABLED');
  const audit = JSON.stringify((await call(admin, '/api/audit')).json);
  for (const name of ['remote.action.step_up_failed', 'remote.action.say', 'remote.action.restart']) assert.ok(audit.includes(name), name);
  assert.ok(!audit.includes(password) && !audit.includes(setup.json.secret));
});
