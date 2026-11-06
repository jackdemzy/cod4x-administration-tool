import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validB3PluginName, normalizeB3PluginRecords } from '../lib/b3-plugin-registry.mjs';
import { ServerInstanceStore } from '../lib/server-instance-store.mjs';

const HASH = 'a'.repeat(64);
const record = (over = {}) => ({ name: 'my_plug', source: 'custom', enabled: true, sha256: HASH, approvedAt: '2026-11-06T10:00:00.000Z', configType: 'ini', ...over });

test('names', () => {
  assert.equal(validB3PluginName('welcome'), 'welcome');
  assert.equal(validB3PluginName('my_plug'), 'my_plug');
  for (const bad of ['../x', 'X', 'a.b', 'a', '9a', 'a'.repeat(33), 5, undefined]) assert.throws(() => validB3PluginName(bad), { code: 'B3_PLUGIN_NAME_INVALID' }, String(bad));
  assert.throws(() => validB3PluginName('admin'), { code: 'B3_PLUGIN_FIXED' });
});

test('records', () => {
  assert.deepEqual(normalizeB3PluginRecords(undefined), []);
  assert.deepEqual(normalizeB3PluginRecords([record({ configType: undefined })]), [record({ configType: null })]);
  assert.throws(() => normalizeB3PluginRecords([record({ sha256: 'xyz' })]), { code: 'B3_PLUGIN_REGISTRY_INVALID' });
  assert.throws(() => normalizeB3PluginRecords([record({ sha256: 'A'.repeat(64) })]), { code: 'B3_PLUGIN_REGISTRY_INVALID' });
  assert.throws(() => normalizeB3PluginRecords([record({ source: 'other' })]), { code: 'B3_PLUGIN_REGISTRY_INVALID' });
  assert.throws(() => normalizeB3PluginRecords([record({ configType: 'json' })]), { code: 'B3_PLUGIN_REGISTRY_INVALID' });
  assert.throws(() => normalizeB3PluginRecords([record({ enabled: 'yes' })]), { code: 'B3_PLUGIN_REGISTRY_INVALID' });
  assert.throws(() => normalizeB3PluginRecords([record({ name: 'welcome', source: 'custom' })]), { code: 'B3_PLUGIN_NAME_INVALID' });
  assert.equal(normalizeB3PluginRecords([record({ name: 'welcome', source: 'shipped' })])[0].name, 'welcome');
  assert.throws(() => normalizeB3PluginRecords([record(), record()]), { code: 'B3_PLUGIN_NAME_INVALID' });
  assert.throws(() => normalizeB3PluginRecords([record({ name: 'admin' })]), { code: 'B3_PLUGIN_FIXED' });
  const many = Array.from({ length: 33 }, (_, i) => record({ name: `plug_${i}` }));
  assert.throws(() => normalizeB3PluginRecords(many), { code: 'B3_PLUGIN_LIMIT' });
  assert.equal(normalizeB3PluginRecords(many.slice(0, 32)).length, 32);
});

test('store round-trip', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-b3plugins-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const basePath = path.join(root, 'game');
  const executablePath = path.join(root, 'core', 'cod4x18_dedrun.exe');
  await fs.mkdir(path.join(basePath, 'main'), { recursive: true });
  await fs.mkdir(path.join(basePath, 'zone'), { recursive: true });
  await fs.mkdir(path.dirname(executablePath));
  await fs.writeFile(path.join(basePath, 'main', 'pak0.iwd'), 'fixture');
  await fs.writeFile(path.join(basePath, 'zone', 'common.ff'), 'fixture');
  await fs.writeFile(executablePath, 'fixture');
  const options = { root: path.join(root, 'servers'), registryFile: path.join(root, 'instances.json'), checkPort: async () => {} };
  const store = new ServerInstanceStore(options);
  await store.load();
  const created = await store.create({ id: 'public-01', name: 'Public 01', platform: 'windows', serverCore: { executablePath, version: '21.5' }, basePath, port: 28960 });
  assert.deepEqual(created.b3Plugins, []);
  assert.equal(created.b3PluginsRevision, 0);
  const one = await store.setB3Plugins('public-01', [record()]);
  assert.equal(one.b3PluginsRevision, 1);
  const two = await store.setB3Plugins('public-01', [record()]);
  assert.equal(two.b3PluginsRevision, 2);
  await assert.rejects(store.setB3Plugins('public-01', [record({ sha256: 'x' })]), { code: 'B3_PLUGIN_REGISTRY_INVALID' });
  assert.equal(store.get('public-01').b3PluginsRevision, 2);
  const loaded = new ServerInstanceStore(options);
  await loaded.load();
  assert.deepEqual(loaded.get('public-01').b3Plugins, [record()]);
  assert.equal(loaded.get('public-01').b3PluginsRevision, 2);
  const clone = await loaded.clone('public-01', { id: 'public-02', name: 'Public 02', port: 28961 });
  assert.deepEqual(clone.b3Plugins, []);
  assert.equal(clone.b3PluginsRevision, 0);
  // legacy record without the fields
  const raw = JSON.parse(await fs.readFile(options.registryFile, 'utf8'));
  for (const item of raw.instances) { delete item.b3Plugins; delete item.b3PluginsRevision; }
  await fs.writeFile(options.registryFile, JSON.stringify(raw));
  const legacy = new ServerInstanceStore(options);
  await legacy.load();
  assert.deepEqual(legacy.get('public-01').b3Plugins, []);
  assert.equal(legacy.get('public-01').b3PluginsRevision, 0);
});
