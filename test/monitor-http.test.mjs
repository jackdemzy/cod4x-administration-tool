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

// Block 24a: the monitoring routes on an isolated backend (no instance, no core).
test('monitoring routes: monitor role reads status only, console lines need diagnostics.read', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-monitor-http-'));
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^COD4X_/i.test(key)));
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', COD4X_DATA_ROOT: path.join(root, 'data'), COD4X_INSTALL_ROOT: path.join(root, 'installations'), COD4X_RUNTIME_ROOT: root });
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
  const call = async (token, route, body) => {
    const response = await fetch(`${url}${route}`, { method: body ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
    return { status: response.status, json: await response.json(), cache: response.headers.get('cache-control') };
  };
  const password = `${crypto.randomBytes(16).toString('hex')}Aa9!`;
  const admin = (await call(null, '/api/auth/init', { username: 'monitorAdmin', password })).json.token;
  assert.equal((await call(null, '/api/monitor/overview')).status, 401);
  const overview = await call(admin, '/api/monitor/overview');
  assert.equal(overview.status, 200, JSON.stringify(overview.json));
  assert.deepEqual(overview.json.monitor.instances, []);
  assert.equal(overview.cache, 'no-store');
  assert.equal((await call(admin, '/api/users', { username: 'watcher', password, role: 'monitor' })).status, 201);
  const watcher = (await call(null, '/api/auth/login', { username: 'watcher', password })).json.token;
  assert.equal((await call(watcher, '/api/monitor/overview')).status, 200);
  for (const route of ['/api/diagnostics', '/api/instances', '/api/audit']) assert.equal((await call(watcher, route)).status, 403, route);
  assert.equal((await call(watcher, '/api/monitor/instances/nope/history')).status, 404);
  assert.equal((await call(admin, '/api/monitor/instances/nope/events?range=1y')).status, 404);
  const roles = (await call(admin, '/api/rbac/roles')).json.roles;
  assert.deepEqual(roles.find(role => role.id === 'monitor').permissions, ['monitor.read']);
  assert.ok((await call(admin, '/api/rbac/authorization')).json.ok);
});
