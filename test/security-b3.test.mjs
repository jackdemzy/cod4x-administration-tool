import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backend, password } from './support/security-backend.mjs';
import { ServerInstanceStore } from '../lib/server-instance-store.mjs';
import { InstanceB3PluginService } from '../lib/instance-b3-plugin-service.mjs';
import { InstanceB3Service } from '../lib/instance-b3-service.mjs';
import { hashB3Module } from '../lib/b3-plugin-hash.mjs';
import { normalizedHash, B3Environment } from '../lib/b3-dependencies.mjs';

// Security audit 4.18.26, area 3 (B3).
// A3-1: an operator chose the Python interpreter and the B3 folder, which CONTROL runs.
// A3-2: a plugin setting could point B3's chat log or status file at any file (e.g. ~/.bashrc).
// A3-3: an operator could trust plugin code that differs from the catalog.
// A3-4: the B3 log showed full player IPs and GUIDs to read-only roles.
// A3-5: Python and the B3 folder could be writable by other local users.

test('A3-1 and A3-3: choosing Python/B3 and trusting changed plugin code need admin', { timeout: 60000 }, async t => {
  const { call } = await backend(t);
  const admin = (await call('/api/auth/init', { body: { username: 'owner', password: password() } })).json.token;
  const secret = password();
  assert.equal((await call('/api/users', { body: { username: 'operator1', password: secret, role: 'operator' }, token: admin })).status, 201);
  const operator = (await call('/api/auth/login', { body: { username: 'operator1', password: secret } })).json.token;
  const environment = await call('/api/b3/environment', { body: { pythonPath: '/tmp/x/python' }, token: operator });
  assert.equal(environment.status, 403);
  assert.equal(environment.json.permission, 'server.code');
  assert.notEqual((await call('/api/b3/environment', { body: { pythonPath: '/tmp/x/python' }, token: admin })).status, 403);
  const approve = await call('/api/instances/x/b3/plugins/welcome/approve', { body: { sha256: 'a'.repeat(64) }, token: operator });
  assert.equal(approve.status, 403);
  assert.equal(approve.json.permission, 'b3.plugins.code');
  assert.equal((await call('/api/b3/environment', { token: operator })).status, 200, 'the operator still sees the settings');
});

const TEMPLATE = '[file]\nlogfile: @conf/chatlog/chat.log\n';
async function pluginService(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-a32-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const basePath = path.join(root, 'game');
  const executablePath = path.join(root, 'core', 'cod4x18_dedrun.exe');
  for (const dir of [path.join(basePath, 'main'), path.join(basePath, 'zone'), path.dirname(executablePath)]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(basePath, 'main', 'pak0.iwd'), 'fixture');
  await fs.writeFile(path.join(basePath, 'zone', 'common.ff'), 'fixture');
  await fs.writeFile(executablePath, 'fixture');
  const store = new ServerInstanceStore({ root: path.join(root, 'servers'), registryFile: path.join(root, 'instances.json'), checkPort: async () => {} });
  await store.load();
  await store.create({ id: 'public-01', name: 'Public 01', platform: 'windows', serverCore: { executablePath, version: '21.5' }, basePath, port: 28960 });
  const b3Path = path.join(root, 'ebc');
  const moduleDir = path.join(b3Path, 'b3', 'plugins', 'chatlogger');
  await fs.mkdir(moduleDir, { recursive: true });
  await fs.mkdir(path.join(b3Path, 'b3', 'conf'), { recursive: true });
  await fs.writeFile(path.join(moduleDir, '__init__.py'), 'class ChatloggerPlugin: pass\n');
  await fs.writeFile(path.join(b3Path, 'b3', 'conf', 'plugin_chatlogger.ini'), TEMPLATE);
  const catalog = [{ name: 'chatlogger', location: 'plugins', module: 'package', sha256: (await hashB3Module(moduleDir)).sha256, configTemplate: 'b3/conf/plugin_chatlogger.ini', configTemplateSha256: normalizedHash(Buffer.from(TEMPLATE)), requiresConfigFile: true, requiresPlugins: [], requiresParsers: [], pythonModules: [] }];
  const service = new InstanceB3PluginService({ store, environment: { read: async () => ({ pythonPath: null, b3Path }) }, catalog });
  await service.setEnabled('public-01', 'chatlogger', true);
  return service;
}

test('A3-2: plugin settings cannot point B3 at files outside its folders', async t => {
  const service = await pluginService(t);
  for (const value of ['/home/control/.bashrc', '~/.bashrc', '@home/x', '@conf/../../../.bashrc', 'C:\\Users\\x\\Start Menu\\Programs\\Startup\\x.bat', '\\\\host\\share\\x.bat', 'logs/../../../x', '%(z)s/home/control/.bashrc']) {
    const { sha256 } = await service.readConfig('public-01', 'chatlogger');
    await assert.rejects(service.saveConfig('public-01', 'chatlogger', { text: `[general]\nsave_to_file: yes\n[file]\nlogfile: ${value}\nz:\n`, expectedSha256: sha256 }), { code: 'B3_PLUGIN_CONFIG_INVALID', line: 4 }, value);
  }
  const { sha256 } = await service.readConfig('public-01', 'chatlogger');
  await service.saveConfig('public-01', 'chatlogger', { text: '# ~/.ssh/known_hosts in a comment is fine\n[file]\nlogfile: @conf/chatlog/other.log\nmessage: Wait... /me waves %(name)s has %(num_bans)s bans\nurl: https://example.org/a\n', expectedSha256: sha256 });
  const xml = '<configuration><settings name="settings"><set name="output_file">/etc/passwd</set></settings></configuration>';
  assert.equal((await import('../lib/b3-plugin-validate.mjs')).unsafeB3PathLine(xml, 'xml'), 1);
});

test('A3-4: read-only roles get the B3 log with masked IPs and GUIDs', async () => {
  const text = 'in-sync 0123456789abcdef0123456789abcdef == 0123456789abcdef0123456789abcdef\nno-sync 203.0.113.77 <> 203.0.113.77\n';
  const runtime = { load: async () => {}, reconcile: async () => ({ running: false }), logs: async () => ({ b3Log: text, output: text }), health: async () => ({ status: 'DOWN', logTail: text }), outputTail: async () => text };
  const service = new InstanceB3Service({ store: { get: () => ({ platform: 'linux', homePath: '/tmp/none' }) }, environment: {}, runtimeFactory: () => runtime });
  const masked = JSON.stringify([await service.logs('a', { full: false }), await service.status('a', { full: false })]);
  assert.ok(!masked.includes('203.0.113.77') && !masked.includes('0123456789abcdef0123456789abcdef'), masked);
  assert.ok(masked.includes('203.0.113.x') && masked.includes('…cdef'));
  const full = JSON.stringify(await service.logs('a', { full: true }));
  assert.ok(full.includes('203.0.113.77'), 'config.manage keeps the full log');
});

test('A3-5: Python or a B3 folder writable by other users blocks B3', { skip: process.platform !== 'linux' && 'POSIX modes only' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-a35-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const python = path.join(root, 'py', 'python');
  await fs.mkdir(path.dirname(python));
  await fs.writeFile(python, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const b3Path = path.join(root, 'ebc');
  await fs.mkdir(path.join(b3Path, 'b3', 'plugins'), { recursive: true });
  const file = path.join(root, 'b3env.json');
  const environment = new B3Environment(file, { execFileAsync: async () => { throw Object.assign(new Error('probe should not run'), { code: 'B3_PYTHON_PROBE_FAILED' }); } });
  await environment.save({ pythonPath: python, b3Path });
  await fs.chmod(path.join(b3Path, 'b3'), 0o777);
  const blocked = await environment.check();
  assert.notEqual(blocked.overall, 'READY_FOR_RUNTIME_TEST');
  assert.ok(JSON.stringify(blocked).includes('B3_PATH_WRITABLE_BY_OTHERS'), JSON.stringify(blocked.blocking));
  await fs.chmod(path.join(b3Path, 'b3'), 0o755);
  await fs.chmod(path.dirname(python), 0o777);
  assert.ok(JSON.stringify(await environment.check()).includes('B3_PATH_WRITABLE_BY_OTHERS'));
  const { assertB3PathsPrivate } = await import('../lib/b3-dependencies.mjs');
  await assert.rejects(assertB3PathsPrivate({ pythonPath: python, b3Path }), { code: 'B3_PATH_WRITABLE_BY_OTHERS' });
  await fs.chmod(path.dirname(python), 0o755);
  await assertB3PathsPrivate({ pythonPath: python, b3Path });
});

test('A3-2 (final review): an XML entity cannot carry a path past the check', async () => {
  const { validateB3PluginXml, unsafeB3PathLine } = await import('../lib/b3-plugin-validate.mjs');
  const xml = '<!DOCTYPE configuration [<!ENTITY p "/home/ctl/.bashrc">]><configuration><settings name="s"><set name="file">&p;</set></settings></configuration>';
  assert.ok(!validateB3PluginXml(xml).ok || unsafeB3PathLine(xml, 'xml') > 0, 'refused');
  assert.equal(validateB3PluginXml('<!DOCTYPE configuration><configuration/>').ok, false, 'no DOCTYPE at all (A3-6)');
});

test('A3-2 (PR #46 review): a stored plugin config with an outside path blocks the B3 start', async t => {
  const service = await pluginService(t);
  assert.deepEqual((await service.plan('public-01')).blockers, []);
  const instance = service.instance('public-01');
  await fs.writeFile(service.configFile(instance, 'chatlogger', 'ini'), '[file]\nlogfile: /home/control/.bashrc\n');
  assert.deepEqual((await service.plan('public-01')).blockers, [{ code: 'B3_PLUGIN_CONFIG_INVALID', plugin: 'chatlogger' }]);
});

test('A2-2 (PR #46 review): a B3 start tightens an old home and game log', { skip: process.platform === 'win32' && 'POSIX modes only' }, async t => {
  const { prepareB3Runtime } = await import('../lib/b3-config.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-a22-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homePath = path.join(root, 'home');
  await fs.mkdir(path.join(homePath, 'main'), { recursive: true });
  await fs.chmod(homePath, 0o755);
  const log = path.join(homePath, 'main', 'games_mp.log');
  await fs.writeFile(log, '', { mode: 0o644 });
  await fs.chmod(log, 0o644);
  await prepareB3Runtime({ id: 'old', port: 28960, homePath }, 'games_mp.log');
  assert.equal((await fs.stat(homePath)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(log)).mode & 0o777, 0o600);
});

test('A3-5 (PR #46 review): Python import folders writable by others block the probe', { skip: process.platform !== 'linux' && 'POSIX modes only' }, async t => {
  const { assertB3PathsPrivate } = await import('../lib/b3-dependencies.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-a35py-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = path.join(root, 'env'), base = path.join(root, 'base');
  const python = path.join(env, 'bin', 'python');
  await fs.mkdir(path.dirname(python), { recursive: true });
  await fs.writeFile(python, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const sitePackages = path.join(env, 'lib', 'python2.7', 'site-packages');
  await fs.mkdir(sitePackages, { recursive: true });
  await fs.mkdir(path.join(base, 'lib', 'python2.7'), { recursive: true });
  await fs.writeFile(path.join(env, 'lib', 'python2.7', 'orig-prefix.txt'), base);
  await assertB3PathsPrivate({ pythonPath: python });
  await fs.chmod(sitePackages, 0o777);
  await assert.rejects(assertB3PathsPrivate({ pythonPath: python }), { code: 'B3_PATH_WRITABLE_BY_OTHERS' }, 'virtualenv site-packages');
  await fs.chmod(sitePackages, 0o755);
  await fs.chmod(path.join(base, 'lib', 'python2.7'), 0o777);
  await assert.rejects(assertB3PathsPrivate({ pythonPath: python }), { code: 'B3_PATH_WRITABLE_BY_OTHERS' }, 'base standard library');
});
