import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const freePort = async () => {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  return port;
};
const freeUdpPort = async () => {
  const socket = dgram.createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '0.0.0.0', resolve));
  const value = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return value;
};

// Block 16 on an isolated backend: settings and !auth passwords need
// config.manage, a locked vault refuses passwords, and no password ever
// appears in a response, the audit or a log file.
test('B3 integration API on the real backend', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-b3i-http-'));
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^COD4X_/i.test(key)));
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', COD4X_DATA_ROOT: path.join(root, 'data'), COD4X_INSTALL_ROOT: path.join(root, 'installations'), COD4X_RUNTIME_ROOT: root, COD4X_MONITOR: 'off' });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../installer-server.mjs', import.meta.url))], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8000); });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { child.kill(); await closed; await fs.rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80 && child.exitCode === null; attempt++) {
    try { if ((await fetch(`${url}/api/auth/status`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, `backend did not become ready: ${diagnostics}`);
  const call = async (token, route, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`${url}${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json() };
  };
  const password = `${crypto.randomBytes(16).toString('hex')}Aa9!`;
  const admin = (await call(null, '/api/auth/init', { username: 'b3iAdmin', password })).json.token;
  assert.equal((await call(admin, '/api/users', { username: 'watch', password, role: 'viewer' })).status, 201);
  const viewer = (await call(null, '/api/auth/login', { username: 'watch', password })).json.token;

  const platform = process.platform === 'win32' ? 'windows' : 'linux';
  const baseGame = path.join(root, 'game'), core = path.join(root, 'core', platform === 'windows' ? 'cod4x18_dedrun.exe' : 'cod4x18_dedrun');
  for (const dir of ['main', 'zone']) await fs.mkdir(path.join(baseGame, dir), { recursive: true });
  await fs.writeFile(path.join(baseGame, 'main', 'iw_00.iwd'), 'fixture');
  await fs.writeFile(path.join(baseGame, 'zone', 'common_mp.ff'), 'fixture');
  await fs.mkdir(path.dirname(core)); await fs.writeFile(core, 'NOT EXECUTED');
  const created = await call(admin, '/api/instances', { id: 'b3i-01', name: 'B3I 01', platform, serverCore: { executablePath: core, version: '21.2' }, basePath: baseGame, port: await freeUdpPort() });
  assert.equal(created.status, 201, created.json.error);

  // Reads: diagnostics.read; writes: config.manage.
  const view = await call(viewer, '/api/instances/b3i-01/b3/integration');
  assert.equal(view.status, 200, view.json.error);
  assert.deepEqual(view.json.integration.settings, { hideCommands: false, prefix: '!', hideLevel: 20 });
  assert.deepEqual(view.json.integration.restart, { server: null, b3: null });
  assert.equal((await call(viewer, '/api/instances/b3i-01/b3/integration', { hideCommands: true, prefix: '!', hideLevel: 20 })).status, 403);
  assert.equal((await call(viewer, '/api/instances/b3i-01/b3/integration/auth-password', { level: 100, value: 'hunter22', expectedSha256: null })).status, 403);
  assert.equal((await call(admin, '/api/instances/b3i-01/b3/integration', { hideCommands: true, prefix: '!', hideLevel: 20, extra: 1 })).status, 400);
  const saved = await call(admin, '/api/instances/b3i-01/b3/integration', { hideCommands: true, prefix: '!', hideLevel: 40 });
  assert.equal(saved.status, 200, saved.json.error);
  assert.deepEqual(saved.json.integration.plan.blockers.map(entry => entry.code), ['B3HIDE_MISSING', 'VAULT_LOCKED', 'B3_AUTH_PLUGIN_MISSING']);

  // Passwords: vault must be unlocked; only levels come back.
  const locked = await call(admin, '/api/instances/b3i-01/b3/integration/auth-password', { level: 100, value: 'hunter22', expectedSha256: null });
  assert.equal(locked.json.code, 'VAULT_LOCKED');
  const passphrase = 'Disposable b3 integration passphrase!';
  assert.equal((await call(admin, '/api/credentials/vault/initialize', { passphrase })).status, 201);
  assert.equal((await call(admin, '/api/credentials/vault/unlock', { passphrase })).status, 200);
  const sha256 = (await call(admin, '/api/credentials/vault')).json.vault.sha256;
  const invalid = await call(admin, '/api/instances/b3i-01/b3/integration/auth-password', { level: 100, value: 'a b c d', expectedSha256: sha256 });
  assert.equal(invalid.json.code, 'B3_AUTH_PASSWORD_INVALID');
  const set = await call(admin, '/api/instances/b3i-01/b3/integration/auth-password', { level: 100, value: 'hunter22', expectedSha256: sha256 });
  assert.equal(set.status, 200, set.json.error);
  assert.deepEqual((await call(admin, '/api/instances/b3i-01/b3/integration')).json.integration.authLevels, [100]);

  const events = (await call(admin, '/api/audit?limit=500')).json.events;
  assert.ok(events.some(entry => entry.event === 'b3.integration.configured' && entry.details.prefix === '!' && entry.details.hideLevel === 40));
  assert.ok(events.some(entry => entry.event === 'b3.auth.password.set' && entry.details.level === 100));
  const everything = JSON.stringify(events) + JSON.stringify(set.json) + diagnostics;
  assert.ok(!everything.includes('hunter22'), 'no !auth password in audit, responses or output');
  for (const file of await fs.readdir(path.join(root, 'data'), { recursive: true })) {
    const full = path.join(root, 'data', file);
    if (!(await fs.stat(full)).isFile() || /vault/i.test(file)) continue;
    assert.ok(!(await fs.readFile(full, 'latin1')).includes('hunter22'), file);
  }
});
