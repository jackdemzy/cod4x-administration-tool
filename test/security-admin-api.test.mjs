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

// Security audit 4.18.26, area 5 (admin API on 127.0.0.1:8787): findings A5-1 to A5-4.
const DESKTOP_TOKEN = crypto.randomBytes(32).toString('hex');
const EVIL = 'https://evil.example';

const freePort = async () => {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  return port;
};

async function backend(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-security-api-'));
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^COD4X_/i.test(key)));
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', COD4X_DATA_ROOT: path.join(root, 'data'), COD4X_INSTALL_ROOT: path.join(root, 'installations'), COD4X_RUNTIME_ROOT: root, COD4X_MONITOR: 'off', COD4X_DESKTOP_CLIENT_TOKEN: DESKTOP_TOKEN });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../installer-server.mjs', import.meta.url))], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8000); });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { child.kill(); await closed; await fs.rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80 && child.exitCode === null; attempt++) {
    try { if ((await fetch(`${url}/api/installer/health`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, `backend did not become ready: ${diagnostics}`);
  const call = async (route, { body, method = body ? 'POST' : 'GET', token, headers = {} } = {}) => {
    const response = await fetch(`${url}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    return { status: response.status, headers: response.headers, json: await response.json().catch(() => null) };
  };
  return { url, port, call };
}

const password = () => `${crypto.randomBytes(12).toString('hex')}Aa9!`;

test('A5-1: a hostile page cannot create the first administrator', { timeout: 60000 }, async t => {
  const { call } = await backend(t);
  const refused = await call('/api/auth/init', { body: { username: 'evil', password: password() }, headers: { Origin: EVIL } });
  assert.equal(refused.status, 403, 'foreign Origin refused');
  assert.equal(refused.json?.token, undefined);
  assert.notEqual(refused.headers.get('access-control-allow-origin'), '*');
  const sandboxed = await call('/api/auth/init', { body: { username: 'evil', password: password() }, headers: { Origin: 'null' } });
  assert.equal(sandboxed.status, 403, 'Origin null without the desktop client header is a sandboxed foreign page');
  const preflight = await call('/api/auth/init', { method: 'OPTIONS', headers: { Origin: EVIL, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null, 'no CORS grant for a foreign page');
  assert.equal((await call('/api/auth/status')).json.initialized, false, 'still not initialised');
  const desktop = await call('/api/auth/init', { body: { username: 'owner', password: password() }, headers: { Origin: 'null', 'X-COD4X-Desktop': DESKTOP_TOKEN } });
  assert.equal(desktop.status, 201, 'the desktop app (file:// page plus its header) may initialise');
  assert.equal(desktop.headers.get('access-control-allow-origin'), 'null');
});

test('A5-1: requests without Origin (scripts, tests) and from the dev server keep working', { timeout: 60000 }, async t => {
  const { call } = await backend(t);
  const secret = password();
  assert.equal((await call('/api/auth/init', { body: { username: 'owner', password: secret } })).status, 201);
  const dev = await call('/api/auth/login', { body: { username: 'owner', password: secret }, headers: { Origin: 'http://localhost:5173' } });
  assert.equal(dev.status, 200);
  assert.equal(dev.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const wrongToken = await call('/api/auth/login', { body: { username: 'owner', password: secret }, headers: { Origin: 'null', 'X-COD4X-Desktop': 'x'.repeat(64) } });
  assert.equal(wrongToken.status, 403);
});

test('A5-2: failed logins from a hostile page neither count nor lock, and the reply does not reveal a disabled user', { timeout: 60000 }, async t => {
  const { call } = await backend(t);
  const secret = password();
  const admin = (await call('/api/auth/init', { body: { username: 'owner', password: secret } })).json.token;
  for (let i = 0; i < 12; i++) assert.equal((await call('/api/auth/login', { body: { username: 'owner', password: 'wrong-password-1' }, headers: { Origin: EVIL } })).status, 403);
  assert.equal((await call('/api/auth/login', { body: { username: 'owner', password: secret } })).status, 200, 'the real admin is not locked out');
  assert.equal((await call('/api/users', { body: { username: 'former', password: password(), role: 'viewer' }, token: admin })).status, 201);
  assert.equal((await call('/api/users/former', { method: 'PATCH', body: { disabled: true }, token: admin })).status, 200);
  const probe = await call('/api/auth/login', { body: { username: 'former', password: 'not-the-password' } });
  const unknown = await call('/api/auth/login', { body: { username: 'nobody', password: 'not-the-password' } });
  assert.equal(probe.status, 401);
  assert.equal(probe.json.error, unknown.json.error, 'a wrong password for a disabled user looks like any failed login');
});

test('A5-3: changing the loopback source address does not lift the local login brake', { timeout: 60000, skip: process.platform !== 'linux' && 'only Linux routes all of 127.0.0.0/8 to loopback' }, async t => {
  const { port, call } = await backend(t);
  const secret = password();
  assert.equal((await call('/api/auth/init', { body: { username: 'owner', password: secret } })).status, 201);
  const loginFrom = (localAddress, pass) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: 'owner', password: pass });
    const socket = net.connect({ host: '127.0.0.1', port, localAddress }, () => {
      socket.end(`POST /api/auth/login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
    let reply = '';
    socket.on('data', chunk => { reply += chunk; });
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1])));
    socket.on('error', reject);
  });
  for (let i = 2; i < 12; i++) await loginFrom(`127.0.0.${i}`, 'wrong-password-1');
  assert.equal(await loginFrom('127.0.0.20', secret), 429, 'ten failures from rotating loopback addresses lock the user');
});

test('A5-4: disabling a user ends that user\'s local sessions at once', { timeout: 60000 }, async t => {
  const { call } = await backend(t);
  const admin = (await call('/api/auth/init', { body: { username: 'owner', password: password() } })).json.token;
  const secret = password();
  assert.equal((await call('/api/users', { body: { username: 'operator1', password: secret, role: 'operator' }, token: admin })).status, 201);
  const operator = (await call('/api/auth/login', { body: { username: 'operator1', password: secret } })).json.token;
  assert.equal((await call('/api/instances', { token: operator })).status, 200);
  assert.equal((await call('/api/users/operator1', { method: 'PATCH', body: { disabled: true }, token: admin })).status, 200);
  assert.equal((await call('/api/instances', { token: operator })).status, 401, 'the disabled user\'s token no longer works');
});

test('A5-1: origin policy decisions', async () => {
  const { localOriginDecision } = await import('../lib/local-origin-policy.mjs');
  const desktopToken = 'a'.repeat(64);
  const own = ['http://127.0.0.1:8787'];
  const decide = (origin, extra = {}) => localOriginDecision({ origin, desktopToken, ownOrigins: own, ...extra });
  assert.deepEqual(decide(undefined), { allowed: true, allowOrigin: null });
  assert.deepEqual(decide('http://127.0.0.1:8787'), { allowed: true, allowOrigin: 'http://127.0.0.1:8787' });
  assert.deepEqual(decide('http://evil.example:8787'), { allowed: false, allowOrigin: null }, 'DNS rebinding keeps the attacker host in Origin');
  assert.deepEqual(decide('null'), { allowed: false, allowOrigin: null });
  assert.deepEqual(decide('null', { desktopHeader: desktopToken }), { allowed: true, allowOrigin: 'null' });
  assert.deepEqual(decide('null', { preflight: true }), { allowed: true, allowOrigin: 'null' }, 'the preflight cannot carry the header; the request itself is checked');
  assert.deepEqual(decide('null', { desktopHeader: desktopToken, desktopToken: '' }), { allowed: false, allowOrigin: null }, 'no secret configured: standalone backend refuses file:// pages');
});

test('A5-1: the desktop app sends its per-launch secret only to the local backend', async () => {
  const main = await fs.readFile(new URL('../electron-main.cjs', import.meta.url), 'utf8');
  assert.match(main, /DESKTOP_CLIENT_TOKEN=crypto\.randomBytes\(32\)\.toString\('hex'\)/);
  assert.match(main, /COD4X_DESKTOP_CLIENT_TOKEN:DESKTOP_CLIENT_TOKEN/);
  assert.match(main, /onBeforeSendHeaders\(\{urls:\[`http:\/\/\$\{HOST\}:\$\{PORT\}\/\*`\]\}/);
});
