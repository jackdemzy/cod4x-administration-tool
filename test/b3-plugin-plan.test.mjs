import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ServerInstanceStore } from '../lib/server-instance-store.mjs';
import { InstanceB3PluginService } from '../lib/instance-b3-plugin-service.mjs';
import { hashB3Module } from '../lib/b3-plugin-hash.mjs';

const ID = 'public-01';
// Shipped test modules: [name, location, module kind, requiresConfigFile, requiresPlugins, pythonModules]
const MODULES = [
  ['welcome', 'plugins', 'package', true, [], []],
  ['duel', 'plugins', 'package', false, [], []],
  ['discord', 'extplugins', 'file', false, [], ['requests']],
  ['geolocation', 'plugins', 'package', false, [], []],
  ['geowelcome', 'plugins', 'package', false, ['geolocation'], []],
];

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b3-plugin-plan-'));
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
  const instance = await store.create({ id: ID, name: 'Public 01', platform: 'windows', serverCore: { executablePath, version: '21.5' }, basePath, port: 28960 });
  const b3Path = path.join(root, 'ebc');
  const catalog = [];
  const modules = {};
  for (const [name, location, kind, requiresConfigFile, requiresPlugins, pythonModules] of MODULES) {
    const dir = path.join(b3Path, 'b3', location);
    const module = kind === 'file' ? path.join(dir, `${name}.py`) : path.join(dir, name);
    await fs.mkdir(kind === 'file' ? dir : module, { recursive: true });
    await fs.writeFile(kind === 'file' ? module : path.join(module, '__init__.py'), `class ${name}Plugin: pass\n`);
    modules[name] = module;
    catalog.push({ name, location, module: kind, sha256: (await hashB3Module(module)).sha256, configTemplate: null, configTemplateSha256: null, requiresConfigFile, requiresPlugins, requiresParsers: [], pythonModules });
  }
  const service = new InstanceB3PluginService({ store, environment: { read: async () => ({ pythonPath: null, b3Path }) }, catalog });
  const b3 = path.join(instance.homePath, 'b3');
  await fs.mkdir(path.join(b3, 'plugins'), { recursive: true });
  await fs.writeFile(path.join(b3, 'plugins', 'welcome.ini'), '[settings]\nmessage: hi\n');
  const shipped = (name, extra = {}) => ({ name, source: 'shipped', enabled: true, sha256: catalog.find(item => item.name === name).sha256, approvedAt: '2026-11-06T00:00:00.000Z', configType: null, ...extra });
  const dependencies = (requests = 'OK') => ({ environment: { b3Path }, results: [{ id: 'requests', status: requests }, { id: 'feedparser', status: 'OK' }, { id: 'paramiko', status: 'OK' }] });
  return { store, service, b3, b3Path, modules, catalog, shipped, dependencies };
}

test('plan lists enabled plugins in registry order with config and path', async t => {
  const { store, service, b3, shipped, dependencies } = await setup(t);
  const created = await service.createCustom(ID, { name: 'myplug', from: 'template' });
  assert.equal(created.name, 'myplug');
  const custom = store.get(ID).b3Plugins.find(item => item.name === 'myplug');
  await store.setB3Plugins(ID, [shipped('welcome', { configType: 'ini' }), shipped('duel', { enabled: false }), { ...custom, enabled: true }, shipped('geolocation')]);
  const result = await service.plan(ID, dependencies());
  assert.deepEqual(result.blockers, []);
  assert.equal(result.revision, store.get(ID).b3PluginsRevision);
  assert.deepEqual(result.plugins, [
    { name: 'welcome', source: 'shipped', configPath: path.join(b3, 'plugins', 'welcome.ini'), path: null },
    { name: 'myplug', source: 'custom', configPath: path.join(b3, 'plugins', 'myplug.ini'), path: path.join(b3, 'extplugins') },
    { name: 'geolocation', source: 'shipped', configPath: null, path: null },
  ]);
});

test('plan blockers carry the plugin name', async t => {
  const { store, service, b3, modules, shipped, dependencies } = await setup(t);
  await service.createCustom(ID, { name: 'gone', from: 'template' });
  const custom = { ...store.get(ID).b3Plugins.find(item => item.name === 'gone'), enabled: true };
  const codes = async (records, deps = dependencies()) => { await store.setB3Plugins(ID, records); return (await service.plan(ID, deps)).blockers; };

  await fs.rm(modules.duel, { recursive: true });
  assert.deepEqual(await codes([shipped('duel')]), [{ code: 'B3_PLUGIN_MISSING', plugin: 'duel' }]);
  await fs.rm(path.join(b3, 'extplugins', 'gone.py'));
  assert.deepEqual(await codes([custom]), [{ code: 'B3_PLUGIN_MISSING', plugin: 'gone' }]);

  await fs.appendFile(path.join(modules.geolocation, '__init__.py'), '# patched\n');
  assert.deepEqual(await codes([shipped('geolocation')]), [{ code: 'B3_PLUGIN_NOT_APPROVED', plugin: 'geolocation' }]);
  // An approved differing hash that changes again is an integrity failure.
  assert.deepEqual(await codes([shipped('geolocation', { sha256: 'e'.repeat(64) })]), [{ code: 'B3_PLUGIN_INTEGRITY_FAILED', plugin: 'geolocation' }]);

  assert.deepEqual(await codes([shipped('discord')], dependencies('MISSING')), [{ code: 'B3_PLUGIN_DEPENDENCY_MISSING', plugin: 'discord' }]);
  assert.deepEqual(await codes([shipped('discord')], dependencies('OK')), []);

  assert.deepEqual(await codes([shipped('geowelcome'), shipped('geolocation', { enabled: false })]), [{ code: 'B3_PLUGIN_REQUIRES_PLUGIN', plugin: 'geowelcome' }]);

  await fs.rm(path.join(b3, 'plugins', 'welcome.ini'));
  assert.deepEqual(await codes([shipped('welcome', { configType: 'ini' })]), [{ code: 'B3_PLUGIN_CONFIG_MISSING', plugin: 'welcome' }]);

  // Disabled plugins are never checked, however broken.
  assert.deepEqual(await codes([shipped('duel', { enabled: false }), { ...custom, enabled: false }, shipped('welcome', { enabled: false, configType: 'ini' }), shipped('discord', { enabled: false })], dependencies('MISSING')), []);
});

test('changed custom code is an integrity failure', async t => {
  const { store, service, b3, dependencies } = await setup(t);
  await service.createCustom(ID, { name: 'myplug', from: 'template' });
  await service.setEnabled(ID, 'myplug', true);
  await fs.appendFile(path.join(b3, 'extplugins', 'myplug.py'), '# edited outside CONTROL\n');
  assert.deepEqual((await service.plan(ID, dependencies())).blockers, [{ code: 'B3_PLUGIN_INTEGRITY_FAILED', plugin: 'myplug' }]);
  assert.equal(store.get(ID).b3Plugins.length, 1);
});
