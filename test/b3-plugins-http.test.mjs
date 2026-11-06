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
import { REMOTE_ROUTES, REMOTE_WRITE_ROUTES } from '../lib/remote-gateway.mjs';

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
const serverSource = () => fs.readFile(fileURLToPath(new URL('../installer-server.mjs', import.meta.url)), 'utf8');

test('no remote route for B3 plugins', () => {
  assert.ok(![...REMOTE_ROUTES, ...REMOTE_WRITE_ROUTES].some(route => route.includes('/b3/plugins')));
});

test('the B3 service receives the plugin service', async () => {
  assert.match(await serverSource(), /new InstanceB3Service\(\{[^}]*plugins: b3PluginService/);
});

// Block 16b on an isolated backend: reads need diagnostics.read, switches,
// configs and approvals config.manage, code b3.plugins.code (admin only); the
// audit carries names and hashes, never config or code content.
test('B3 plugins API on the real backend', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-b3p-http-'));
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^COD4X_/i.test(key)));
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', COD4X_DATA_ROOT: path.join(root, 'data'), COD4X_INSTALL_ROOT: path.join(root, 'installations'), COD4X_RUNTIME_ROOT: root, COD4X_MONITOR: 'off' });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../installer-server.mjs', import.meta.url))], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-200000); });
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
  const admin = (await call(null, '/api/auth/init', { username: 'b3pAdmin', password })).json.token;
  assert.equal((await call(admin, '/api/users', { username: 'watch', password, role: 'viewer' })).status, 201);
  assert.equal((await call(admin, '/api/users', { username: 'ops', password, role: 'operator' })).status, 201);
  const viewer = (await call(null, '/api/auth/login', { username: 'watch', password })).json.token;
  const operator = (await call(null, '/api/auth/login', { username: 'ops', password })).json.token;

  const platform = process.platform === 'win32' ? 'windows' : 'linux';
  const baseGame = path.join(root, 'game'), core = path.join(root, 'core', platform === 'windows' ? 'cod4x18_dedrun.exe' : 'cod4x18_dedrun');
  for (const dir of ['main', 'zone']) await fs.mkdir(path.join(baseGame, dir), { recursive: true });
  await fs.writeFile(path.join(baseGame, 'main', 'iw_00.iwd'), 'fixture');
  await fs.writeFile(path.join(baseGame, 'zone', 'common_mp.ff'), 'fixture');
  await fs.mkdir(path.dirname(core)); await fs.writeFile(core, 'NOT EXECUTED');
  const created = await call(admin, '/api/instances', { id: 'b3p-01', name: 'B3P 01', platform, serverCore: { executablePath: core, version: '21.2' }, basePath: baseGame, port: await freeUdpPort() });
  assert.equal(created.status, 201, created.json.error);
  // A local eBc-B3 source whose duel module differs from the catalog hash.
  const b3Path = path.join(root, 'ebc-b3');
  await fs.mkdir(path.join(b3Path, 'b3', 'plugins', 'duel'), { recursive: true });
  await fs.writeFile(path.join(b3Path, 'b3', 'plugins', 'duel', '__init__.py'), 'class DuelPlugin: pass\n');
  assert.equal((await call(admin, '/api/b3/environment', { b3Path })).status, 200);
  const base = '/api/instances/b3p-01/b3/plugins';

  // permissions: viewer reads only.
  const list = await call(viewer, base);
  assert.equal(list.status, 200, list.json.error);
  assert.ok(list.json.plugins.some(plugin => plugin.name === 'duel'));
  assert.equal(typeof list.json.revision, 'number');
  assert.equal(list.json.restart, null, 'no hint while B3 is stopped');
  assert.equal((await call(viewer, `${base}/duel/enable`, {})).status, 403);

  // permissions: operator switches, configures and approves, but writes no code.
  const enabled = await call(operator, `${base}/duel/enable`, {});
  assert.equal(enabled.status, 200, enabled.json.error);
  assert.equal(enabled.json.plugin.state, 'NOT_APPROVED');
  assert.equal((await call(operator, `${base}/duel/approve`, { sha256: enabled.json.plugin.sha256, extra: 1 })).json.code, 'B3_PLUGIN_CONFIG_INVALID');
  const approved = await call(operator, `${base}/duel/approve`, { sha256: enabled.json.plugin.sha256 });
  assert.equal(approved.status, 200, approved.json.error);
  assert.equal(approved.json.plugin.state, 'ENABLED');
  assert.equal((await call(operator, `${base}/custom`, { name: 'myplug', from: 'template' })).status, 403);

  // exact body keys on create.
  const extraCreate = await call(admin, `${base}/custom`, { name: 'myplug', from: 'template', code: 'x' });
  assert.deepEqual([extraCreate.status, extraCreate.json.code], [400, 'B3_PLUGIN_CODE_INVALID']);
  assert.equal((await call(admin, `${base}/custom`, { name: 'myplug', from: 'upload' })).json.code, 'B3_PLUGIN_CODE_INVALID');
  // permissions: admin creates custom code.
  const custom = await call(admin, `${base}/custom`, { name: 'myplug', from: 'template' });
  assert.equal(custom.status, 200, custom.json.error);
  assert.equal(custom.json.plugin.source, 'custom');
  // Larger than the general 64 KB JSON limit, within the 256 KB plugin limit.
  const uploadCode = `from b3.plugin import Plugin\n\nclass UploadedPlugin(Plugin):\n    pass\n# ${'x'.repeat(100000)}\n`;
  const uploaded = await call(admin, `${base}/custom`, { name: 'uploaded', code: uploadCode });
  assert.equal(uploaded.status, 200, uploaded.json.error);

  // config: read, exact keys, conflict, save.
  const config = await call(operator, `${base}/myplug/config`);
  assert.equal(config.status, 200, config.json.error);
  assert.equal(config.json.config.configType, 'ini');
  assert.equal((await call(viewer, `${base}/myplug/config`)).status, 403);
  const secretText = '[settings]\ntoken = SECRET-123\n';
  const extraConfig = await call(operator, `${base}/myplug/config`, { text: secretText, expectedSha256: config.json.config.sha256, extra: 1 }, 'PUT');
  assert.deepEqual([extraConfig.status, extraConfig.json.code], [400, 'B3_PLUGIN_CONFIG_INVALID']);
  const stale = await call(operator, `${base}/myplug/config`, { text: secretText, expectedSha256: '0'.repeat(64) }, 'PUT');
  assert.deepEqual([stale.status, stale.json.code], [409, 'B3_PLUGIN_CONFLICT']);
  const savedConfig = await call(operator, `${base}/myplug/config`, { text: secretText, expectedSha256: config.json.config.sha256 }, 'PUT');
  assert.equal(savedConfig.status, 200, savedConfig.json.error);
  assert.match(savedConfig.json.config.sha256, /^[0-9a-f]{64}$/);
  assert.equal((await call(operator, `${base}/myplug/enable`, {})).status, 200, 'operator switches custom plugins');
  // A syntax error reaches the client with its line number.
  const syntax = await call(operator, `${base}/myplug/config`, { text: '[settings]\nno separator here\n', expectedSha256: savedConfig.json.config.sha256 }, 'PUT');
  assert.deepEqual([syntax.status, syntax.json.code], [400, 'B3_PLUGIN_CONFIG_INVALID']);
  assert.ok(Number.isInteger(syntax.json.line), JSON.stringify(syntax.json));
  // Malformed JSON with a token: fixed code, no parser message, nothing logged.
  const malformed = async route => {
    const response = await fetch(`${url}${route}`, { method: 'PUT', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' }, body: '{"text": "token = SECRET-JSON-123' });
    return { status: response.status, raw: await response.text() };
  };
  for (const [route, code] of [[`${base}/myplug/config`, 'B3_PLUGIN_CONFIG_INVALID'], [`${base}/custom/myplug/code`, 'B3_PLUGIN_CODE_INVALID']]) {
    const result = await malformed(route);
    assert.equal(result.status, 400);
    assert.equal(JSON.parse(result.raw).code, code);
    assert.ok(!result.raw.includes('SECRET-JSON-123'));
  }
  // Electron renderer (Origin: null) preflights PUT and DELETE.
  const allowed = async route => (await fetch(`${url}${route}`, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type' } })).headers.get('access-control-allow-methods').split(',').map(value => value.trim());
  assert.ok((await allowed(`${base}/myplug/config`)).includes('PUT'));
  assert.ok((await allowed(`${base}/custom/myplug/code`)).includes('PUT'));
  assert.ok((await allowed(`${base}/custom/myplug`)).includes('DELETE'));
  assert.ok(!(await allowed(`${base}/myplug/enable`)).some(method => method === 'PUT' || method === 'DELETE'));
  assert.ok(!(await allowed('/api/instances/b3p-01/start')).includes('DELETE'));

  // code: b3.plugins.code only, exact keys, save.
  assert.equal((await call(operator, `${base}/custom/myplug/code`)).status, 403);
  const code = await call(admin, `${base}/custom/myplug/code`);
  assert.equal(code.status, 200, code.json.error);
  const newCode = `${code.json.code.code}\n# EDITED-CODE-MARKER\n`;
  const extraCode = await call(admin, `${base}/custom/myplug/code`, { code: newCode, expectedSha256: code.json.code.sha256, extra: 1 }, 'PUT');
  assert.deepEqual([extraCode.status, extraCode.json.code], [400, 'B3_PLUGIN_CODE_INVALID']);
  assert.equal((await call(operator, `${base}/custom/myplug/code`, { code: newCode, expectedSha256: code.json.code.sha256 }, 'PUT')).status, 403);
  const savedCode = await call(admin, `${base}/custom/myplug/code`, { code: newCode, expectedSha256: code.json.code.sha256 }, 'PUT');
  assert.equal(savedCode.status, 200, savedCode.json.error);
  assert.match(savedCode.json.code.sha256, /^[0-9a-f]{64}$/);

  // Rejected requests carrying a secret: error messages and audit never echo content.
  const badConfig = await call(operator, `${base}/myplug/config`, { text: ['token = SECRET-123', ''].join(String.fromCharCode(10)), expectedSha256: savedConfig.json.config.sha256 }, 'PUT');
  assert.deepEqual([badConfig.status, badConfig.json.code], [400, 'B3_PLUGIN_CONFIG_INVALID']);
  const badCode = await call(admin, `${base}/custom/myplug/code`, { code: 'SECRET-123' + String.fromCharCode(0), expectedSha256: savedCode.json.code.sha256 }, 'PUT');
  assert.deepEqual([badCode.status, badCode.json.code], [400, 'B3_PLUGIN_CODE_INVALID']);
  assert.ok(!JSON.stringify([badConfig.json, badCode.json]).includes('SECRET-123'), 'responses never echo the body');
  const blocked = (await call(admin, '/api/audit?limit=1000')).json.events.filter(entry => entry.event === 'instance.operation.blocked' && /b3\/plugins/.test(entry.details.route));
  assert.ok(blocked.some(entry => entry.details.code === 'B3_PLUGIN_CONFIG_INVALID') && blocked.some(entry => entry.details.code === 'B3_PLUGIN_CODE_INVALID'), 'rejections are audited');

  // delete and disable.
  assert.equal((await call(operator, `${base}/custom/uploaded`, undefined, 'DELETE')).status, 403);
  const deleted = await call(admin, `${base}/custom/uploaded`, undefined, 'DELETE');
  assert.equal(deleted.status, 200, deleted.json.error);
  assert.equal((await call(operator, `${base}/duel/disable`, {})).json.plugin.state, 'DISABLED');
  const after = await call(viewer, base);
  assert.ok(after.json.revision > list.json.revision);
  assert.ok(!after.json.plugins.some(plugin => plugin.name === 'uploaded'));
  // B3 is stopped: a plugin change never produces a false restart hint.
  assert.deepEqual((await call(viewer, '/api/instances/b3p-01/b3/integration')).json.integration.restart, { server: null, b3: null });

  // audit without content.
  const events = (await call(admin, '/api/audit?limit=1000')).json.events;
  const find = (event, name) => events.find(entry => entry.event === event && entry.details.name === name);
  for (const [event, name] of [['b3.plugin.enabled', 'duel'], ['b3.plugin.approved', 'duel'], ['b3.plugin.custom_created', 'myplug'], ['b3.plugin.config_saved', 'myplug'], ['b3.plugin.code_saved', 'myplug'], ['b3.plugin.deleted', 'uploaded'], ['b3.plugin.disabled', 'duel']]) {
    const entry = find(event, name);
    assert.ok(entry, `${event} ${name}`);
    assert.deepEqual([entry.details.instanceId, entry.details.actor], ['b3p-01', event === 'b3.plugin.custom_created' || event === 'b3.plugin.code_saved' || event === 'b3.plugin.deleted' ? 'b3pAdmin' : 'ops']);
  }
  assert.equal(find('b3.plugin.code_saved', 'myplug').details.sha256, savedCode.json.code.sha256);
  assert.equal(find('b3.plugin.approved', 'duel').details.sha256, enabled.json.plugin.sha256);
  assert.equal(find('b3.plugin.custom_created', 'myplug').details.sha256, custom.json.plugin.sha256);
  assert.equal(find('b3.plugin.config_saved', 'myplug').details.sha256, undefined, 'config hashes stay out of the audit');
  const everything = JSON.stringify(events) + diagnostics;
  for (const secret of ['SECRET-123', 'SECRET-JSON-123', 'EDITED-CODE-MARKER', 'class UploadedPlugin']) assert.ok(!everything.includes(secret), secret);
});
