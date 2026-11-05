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
const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${'s'.repeat(68)}`;
const subscription = endpoint => ({ endpoint, keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } });

// Block 24c on an isolated backend: notification settings (config.manage, URL
// masked, 0600), per-user push subscription through the gateway, and the
// public reverse-proxy mode (TOTP for every role, 5 attempts).
test('notifications and reverse-proxy mode on the real backend', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-alerts-http-'));
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
  const remoteCall = async (route, body, cookie, headers = {}) => {
    const response = await fetch(`${remote}${route}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Origin: remote, ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
    return { status: response.status, json: await response.json().catch(() => null), cookie: response.headers.get('set-cookie')?.split(';')[0] || null };
  };
  const password = `${crypto.randomBytes(16).toString('hex')}Aa9!`;
  const admin = (await call(null, '/api/auth/init', { username: 'alertAdmin', password })).json.token;
  assert.equal((await call(admin, '/api/users', { username: 'phone', password, role: 'viewer' })).status, 201);
  assert.equal((await call(admin, '/api/users/phone', { remoteAccess: true }, 'PATCH')).status, 200);
  const viewer = (await call(null, '/api/auth/login', { username: 'phone', password })).json.token;

  // Settings need config.manage; the webhook URL is only ever returned masked.
  assert.equal((await call(viewer, '/api/alerts')).status, 403);
  const initial = await call(admin, '/api/alerts');
  assert.equal(initial.status, 200);
  assert.deepEqual([initial.json.alerts.rules.enabled, initial.json.alerts.discord.configured, initial.json.alerts.push.enabled], [false, false, true]);
  assert.equal((await call(admin, '/api/alerts/settings', { discordUrl: 'https://evil.example/api/webhooks/1/2' })).json.code, 'DISCORD_HOST_NOT_ALLOWED');
  assert.equal((await call(admin, '/api/alerts/settings', { rules: { repeatMinutes: 1 } })).json.field, 'repeatMinutes');
  const saved = await call(admin, '/api/alerts/settings', { rules: { enabled: true, diskFreeGb: 10 }, discordUrl: WEBHOOK });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.alerts.discord.url, 'https://discord.com/api/webhooks/1234…/••••ssss');
  assert.ok(!JSON.stringify(saved.json).includes('s'.repeat(20)));
  const file = path.join(root, 'data', 'config', 'alerts.json');
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify((await call(admin, '/api/alerts')).json).includes('privateKey'), 'the VAPID private key stays on disk');
  assert.equal((await call(admin, '/api/alerts/settings', { discordUrl: null })).json.alerts.discord.configured, false);
  const testAlert = await call(admin, '/api/alerts/test', {});
  assert.deepEqual(testAlert.json.result, { discord: null, push: { sent: 0, failed: 0 } });

  // Each remote user registers their own device through the gateway.
  assert.equal((await call(admin, '/api/remote/settings', { enabled: true, mode: 'tailscale', port: remotePort })).json.remote.running, true);
  const phone = await remoteCall('/remote/api/login', { username: 'phone', password });
  assert.equal(phone.status, 200, JSON.stringify(phone.json));
  assert.equal((await remoteCall('/remote/api/push/key')).status, 401);
  const key = await remoteCall('/remote/api/push/key', null, phone.cookie);
  assert.match(key.json.publicKey, /^B[A-Za-z0-9_-]{86}$/);
  assert.equal(key.json.mine, 0);
  assert.equal((await remoteCall('/remote/api/push/subscribe', { subscription: subscription('https://evil.example/x') }, phone.cookie)).json.code, 'PUSH_SERVICE_NOT_ALLOWED');
  assert.equal((await remoteCall('/remote/api/push/subscribe', { subscription: subscription('https://fcm.googleapis.com/fcm/send/a') }, phone.cookie, { Origin: 'https://evil.example' })).status, 403);
  const subscribed = await remoteCall('/remote/api/push/subscribe', { subscription: subscription('https://fcm.googleapis.com/fcm/send/a') }, phone.cookie);
  assert.deepEqual(subscribed.json, { ok: true, subscribed: true, renewed: false });
  assert.equal((await remoteCall('/remote/api/push/key', null, phone.cookie)).json.mine, 1);
  assert.deepEqual((await call(admin, '/api/alerts')).json.alerts.push.users, ['phone']);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(root, 'data', 'config', 'push-subscriptions.json'))).mode & 0o777, 0o600);
  assert.equal((await call(admin, '/api/users/phone', { remoteAccess: false }, 'PATCH')).status, 200);
  assert.equal((await call(admin, '/api/alerts')).json.alerts.push.subscriptions, 0, 'no remote access, no push');
  assert.equal((await call(admin, '/api/users/phone', { remoteAccess: true }, 'PATCH')).status, 200);

  // Public domain behind Caddy: gateway stays on loopback, TOTP for every role, 5 attempts.
  assert.equal((await call(admin, '/api/remote/settings', { mode: 'proxy' })).json.field, 'proxyDomain');
  assert.equal((await call(admin, '/api/remote/settings', { mode: 'proxy', proxyDomain: 'not a domain' })).json.field, 'proxyDomain');
  const before = await remoteCall('/remote/api/login', { username: 'phone', password });
  assert.equal(before.status, 200);
  const proxy = await call(admin, '/api/remote/settings', { mode: 'proxy', proxyDomain: 'Monitor.Example.org' });
  assert.equal(proxy.status, 200, JSON.stringify(proxy.json));
  assert.deepEqual(proxy.json.remote.address, { host: '127.0.0.1', port: remotePort });
  assert.ok(proxy.json.remote.caddyfile.startsWith('monitor.example.org {') && proxy.json.remote.caddyfile.includes(`reverse_proxy 127.0.0.1:${remotePort}`) && proxy.json.remote.caddyfile.includes('Strict-Transport-Security') && proxy.json.remote.caddyfile.includes('header_up -Tailscale-User-Login'));
  assert.equal((await remoteCall('/remote/api/me', null, before.cookie)).status, 401, 'changing the exposure ends remote sessions');
  assert.equal((await remoteCall('/remote/api/login', { username: 'phone', password })).json.code, 'REMOTE_TOTP_SETUP_REQUIRED', 'viewer needs TOTP behind a public proxy');
  for (let i = 0; i < 5; i++) assert.equal((await remoteCall('/remote/api/login', { username: 'phone', password: 'wrong-password-123' }, null, { 'X-Forwarded-For': '203.0.113.7' })).status, 401);
  assert.equal((await remoteCall('/remote/api/login', { username: 'phone', password }, null, { 'X-Forwarded-For': '203.0.113.7' })).status, 429, 'locked after 5 failures');
  assert.equal((await remoteCall('/remote/api/login', { username: 'phone', password }, null, { 'X-Forwarded-For': '203.0.113.8' })).json.code, 'REMOTE_TOTP_SETUP_REQUIRED', 'another client is not locked');
  const audit = JSON.stringify((await call(admin, '/api/audit')).json);
  for (const name of ['alert.configured', 'alert.push.subscribed', 'remote.login.locked']) assert.ok(audit.includes(name), name);
  assert.ok(!audit.includes('s'.repeat(20)) && !audit.includes(password), 'no webhook token or password in the audit');
});
