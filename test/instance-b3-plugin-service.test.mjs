import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ServerInstanceStore } from '../lib/server-instance-store.mjs';
import { InstanceB3PluginService } from '../lib/instance-b3-plugin-service.mjs';
import { hashB3Module } from '../lib/b3-plugin-hash.mjs';
import { normalizedHash } from '../lib/b3-dependencies.mjs';

const TEMPLATE = '[settings]\nmessage: hi\n';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b3-plugin-svc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const basePath = path.join(root, 'game');
  const executablePath = path.join(root, 'core', 'cod4x18_dedrun.exe');
  await fs.mkdir(path.join(basePath, 'main'), { recursive: true });
  await fs.mkdir(path.join(basePath, 'zone'), { recursive: true });
  await fs.mkdir(path.dirname(executablePath));
  await fs.writeFile(path.join(basePath, 'main', 'pak0.iwd'), 'fixture');
  await fs.writeFile(path.join(basePath, 'zone', 'common.ff'), 'fixture');
  await fs.writeFile(executablePath, 'fixture');
  const store = new ServerInstanceStore({ root: path.join(root, 'servers'), registryFile: path.join(root, 'instances.json'), checkPort: async () => {} });
  await store.load();
  const instance = await store.create({ id: 'public-01', name: 'Public 01', platform: 'windows', serverCore: { executablePath, version: '21.5' }, basePath, port: 28960 });
  const b3Path = path.join(root, 'ebc');
  await fs.mkdir(path.join(b3Path, 'b3', 'plugins', 'welcome'), { recursive: true });
  await fs.mkdir(path.join(b3Path, 'b3', 'conf'), { recursive: true });
  await fs.writeFile(path.join(b3Path, 'b3', 'plugins', 'welcome', '__init__.py'), 'class WelcomePlugin: pass\n');
  await fs.writeFile(path.join(b3Path, 'b3', 'conf', 'plugin_welcome.ini'), TEMPLATE);
  const moduleDir = path.join(b3Path, 'b3', 'plugins', 'welcome');
  const catalog = [
    { name: 'welcome', location: 'plugins', module: 'package', sha256: (await hashB3Module(moduleDir)).sha256, configTemplate: 'b3/conf/plugin_welcome.ini', configTemplateSha256: normalizedHash(Buffer.from(TEMPLATE)), requiresConfigFile: true, requiresPlugins: [], requiresParsers: [], pythonModules: [] },
    { name: 'callvote', location: 'plugins', module: 'package', sha256: 'c'.repeat(64), configTemplate: null, configTemplateSha256: null, requiresConfigFile: true, requiresPlugins: [], requiresParsers: ['iourt42'], pythonModules: [] },
  ];
  const service = new InstanceB3PluginService({ store, environment: { read: async () => ({ pythonPath: null, b3Path }) }, catalog });
  const b3 = path.join(instance.homePath, 'b3');
  return { root, store, service, b3, b3Path, moduleDir, catalog };
}

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const row = async (service, name) => (await service.list('public-01')).plugins.find(item => item.name === name);

test('enable copies the template once and lists ENABLED', async t => {
  const { service, b3 } = await setup(t);
  const enabled = await service.setEnabled('public-01', 'welcome', true);
  assert.equal(enabled.state, 'ENABLED');
  assert.equal(enabled.configType, 'ini');
  const file = path.join(b3, 'plugins', 'welcome.ini');
  assert.equal(await fs.readFile(file, 'utf8'), TEMPLATE);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.writeFile(file, '[settings]\nmessage: edited\n');
  await service.setEnabled('public-01', 'welcome', false);
  assert.equal((await row(service, 'welcome')).state, 'DISABLED');
  await service.setEnabled('public-01', 'welcome', true);
  assert.equal(await fs.readFile(file, 'utf8'), '[settings]\nmessage: edited\n');
});

test('list order, unavailable rows and error codes', async t => {
  const { service } = await setup(t);
  const { plugins, revision } = await service.list('public-01');
  assert.deepEqual(plugins.map(item => item.name), ['welcome', 'callvote', 'admin', 'publist', 'auth']);
  assert.equal(plugins[1].state, 'UNAVAILABLE');
  assert.ok(plugins[1].reason);
  assert.equal(plugins[2].state, 'UNAVAILABLE');
  assert.equal(revision, 0);
  await assert.rejects(service.setEnabled('public-01', 'callvote', true), { code: 'B3_PLUGIN_FIXED' });
  await assert.rejects(service.setEnabled('public-01', 'admin', true), { code: 'B3_PLUGIN_FIXED' });
  await assert.rejects(service.setEnabled('public-01', 'nonesuch', true), { code: 'B3_PLUGIN_UNKNOWN' });
});

test('differing shipped module is NOT_APPROVED until approved', async t => {
  const { service, moduleDir } = await setup(t);
  await fs.writeFile(path.join(moduleDir, '__init__.py'), 'class WelcomePlugin: pass\n# patched\n');
  const enabled = await service.setEnabled('public-01', 'welcome', true);
  assert.equal(enabled.state, 'NOT_APPROVED');
  await assert.rejects(service.approve('public-01', 'welcome', 'f'.repeat(64)), { code: 'B3_PLUGIN_CONFLICT' });
  const current = (await hashB3Module(moduleDir)).sha256;
  const approved = await service.approve('public-01', 'welcome', current);
  assert.equal(approved.state, 'ENABLED');
  await fs.writeFile(path.join(moduleDir, '__init__.py'), '# changed again\n');
  assert.equal((await row(service, 'welcome')).state, 'INTEGRITY_MISMATCH');
  await fs.rm(moduleDir, { recursive: true });
  assert.equal((await row(service, 'welcome')).state, 'MISSING');
});

test('stale expectedSha256 is a conflict', async t => {
  const { service, b3 } = await setup(t);
  await service.setEnabled('public-01', 'welcome', true);
  const { sha256, text } = await service.readConfig('public-01', 'welcome');
  assert.equal(text, TEMPLATE);
  const results = await Promise.allSettled([
    service.saveConfig('public-01', 'welcome', { text: '[a]\nb: 1\n', expectedSha256: sha256 }),
    service.saveConfig('public-01', 'welcome', { text: '[a]\nb: 2\n', expectedSha256: sha256 }),
  ]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'B3_PLUGIN_CONFLICT');
  assert.equal(await fs.readFile(path.join(b3, 'plugins', 'welcome.ini'), 'utf8'), '[a]\nb: 1\n');
});

test('invalid config is rejected with a line', async t => {
  const { service, b3 } = await setup(t);
  await service.setEnabled('public-01', 'welcome', true);
  const { sha256 } = await service.readConfig('public-01', 'welcome');
  await assert.rejects(service.saveConfig('public-01', 'welcome', { text: '[a]\nthis is not valid\n', expectedSha256: sha256 }), { code: 'B3_PLUGIN_CONFIG_INVALID', line: 2 });
  assert.equal(await fs.readFile(path.join(b3, 'plugins', 'welcome.ini'), 'utf8'), TEMPLATE);
});

test('custom from template, edit, delete', async t => {
  const { service, store, b3 } = await setup(t);
  const created = await service.createCustom('public-01', { name: 'myplug', from: 'template' });
  assert.equal(created.source, 'custom');
  const codeFile = path.join(b3, 'extplugins', 'myplug.py');
  assert.ok((await fs.stat(codeFile)).isFile());
  assert.ok((await fs.stat(path.join(b3, 'plugins', 'myplug.ini'))).isFile());
  const { code, sha256 } = await service.readCode('public-01', 'myplug');
  const saved = await service.saveCode('public-01', 'myplug', { code: `${code}\n# edit\n`, expectedSha256: sha256 });
  const record = store.get('public-01').b3Plugins.find(item => item.name === 'myplug');
  assert.equal(record.sha256, saved.sha256);
  assert.equal(saved.sha256, (await hashB3Module(codeFile)).sha256);
  await assert.rejects(service.saveCode('public-01', 'myplug', { code, expectedSha256: sha256 }), { code: 'B3_PLUGIN_CONFLICT' });
  assert.equal((await service.setEnabled('public-01', 'myplug', true)).state, 'ENABLED');
  await service.deleteCustom('public-01', 'myplug');
  await assert.rejects(fs.stat(codeFile), { code: 'ENOENT' });
  assert.ok((await fs.stat(path.join(b3, 'plugins', 'myplug.ini.bak'))).isFile());
  assert.equal(store.get('public-01').b3Plugins.length, 0);
});

test('name validation for custom plugins', async t => {
  const { service } = await setup(t);
  await assert.rejects(service.createCustom('public-01', { name: 'welcome', from: 'template' }), { code: 'B3_PLUGIN_NAME_INVALID' });
  await assert.rejects(service.createCustom('public-01', { name: 'admin', from: 'template' }), { code: 'B3_PLUGIN_FIXED' });
  await assert.rejects(service.createCustom('public-01', { name: '../x', from: 'template' }), { code: 'B3_PLUGIN_NAME_INVALID' });
  await assert.rejects(service.createCustom('public-01', { name: 'bad_code', code: 'print 1' }), { code: 'B3_PLUGIN_CODE_INVALID' });
  await service.createCustom('public-01', { name: 'dup', from: 'template' });
  await assert.rejects(service.createCustom('public-01', { name: 'dup', from: 'template' }), { code: 'B3_PLUGIN_CONFLICT' });
});

test('symlinked plugins directory is rejected before any write', async t => {
  const { service, b3, root } = await setup(t);
  const target = path.join(root, 'elsewhere');
  await fs.mkdir(target);
  await fs.mkdir(b3, { recursive: true });
  try { await fs.symlink(target, path.join(b3, 'plugins'), 'junction'); } catch { t.skip('symlink not available'); return; }
  await assert.rejects(service.setEnabled('public-01', 'welcome', true), { code: 'B3_DIRECTORY_INVALID' });
  assert.deepEqual(await fs.readdir(target), []);
});

test('revision increases on every write and not on reads', async t => {
  const { service, store } = await setup(t);
  await service.list('public-01');
  assert.equal(store.get('public-01').b3PluginsRevision, 0);
  await service.setEnabled('public-01', 'welcome', true);
  assert.equal(store.get('public-01').b3PluginsRevision, 1);
  await service.readConfig('public-01', 'welcome');
  await service.list('public-01');
  assert.equal(store.get('public-01').b3PluginsRevision, 1);
  const { sha256, text } = await service.readConfig('public-01', 'welcome');
  await service.saveConfig('public-01', 'welcome', { text, expectedSha256: sha256 });
  assert.equal(store.get('public-01').b3PluginsRevision, 2);
  assert.equal(sha256, sha(TEMPLATE));
});

test('missing b3Path makes shipped rows MISSING but customs work', async t => {
  const { store, catalog } = await setup(t);
  const service = new InstanceB3PluginService({ store, environment: { read: async () => ({ b3Path: null }) }, catalog });
  assert.equal((await row(service, 'welcome')).state, 'MISSING');
  await assert.rejects(service.setEnabled('public-01', 'welcome', true), { code: 'B3_PLUGIN_MISSING' });
  await service.createCustom('public-01', { name: 'myplug', from: 'template' });
  assert.equal((await service.setEnabled('public-01', 'myplug', true)).state, 'ENABLED');
});
