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

const freePort = async () => {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  return port;
};

// Security audit 4.18.26, Low findings on an isolated backend:
// A5-5 rotation and test entries need user.manage, rotated files fall under retention;
// A2-3 the audit folder is 0700 and the file 0600 from the start;
// A5-8 no permission is offered that no route requires.
test('audit log: rights, retention and file modes on the real backend', { timeout: 90000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-audit-http-'));
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
    const response = await fetch(`${url}${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
    return { status: response.status, json: await response.json().catch(() => null), headers: response.headers };
  };
  const password = `${crypto.randomBytes(16).toString('hex')}Aa9!`;
  const admin = (await call(null, '/api/auth/init', { username: 'auditAdmin', password })).json.token;
  assert.equal((await call(admin, '/api/users', { username: 'reader', password, role: 'auditor' })).status, 201);
  const auditor = (await call(null, '/api/auth/login', { username: 'reader', password })).json.token;

  // A5-5: reading stays with audit.read, writing to the log needs user.manage.
  assert.equal((await call(auditor, '/api/audit')).status, 200);
  assert.equal((await call(auditor, '/api/audit/test', {})).status, 403);
  assert.equal((await call(auditor, '/api/audit/rotate', {})).status, 403);
  assert.equal((await call(admin, '/api/audit/test', {})).status, 200);

  const auditDir = path.join(root, 'data', 'config', 'audit');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(auditDir)).mode & 0o777, 0o700, 'audit folder 0700');
    assert.equal((await fs.stat(path.join(auditDir, 'audit.ndjson'))).mode & 0o777, 0o600, 'audit file 0600');
  }

  // Retention: the default policy keeps 7 rotated files.
  for (let i = 0; i < 9; i++) {
    const rotated = await call(admin, '/api/audit/rotate', {});
    assert.equal(rotated.status, 200, JSON.stringify(rotated.json));
    assert.equal(rotated.json.rotated, true);
    await delay(5);
  }
  const rotatedFiles = (await fs.readdir(auditDir)).filter(name => name !== 'audit.ndjson');
  assert.equal(rotatedFiles.length, 7, rotatedFiles.join(', '));

  // A5-8: secrets.manage is gone; no permission without a route.
  const roles = await call(admin, '/api/rbac/roles');
  assert.ok(!roles.json.permissions.some(permission => permission.id === 'secrets.manage'));
});
