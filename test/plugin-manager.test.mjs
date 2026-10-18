import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizePluginRecords, discoverPlugins, describePlugins, classifyPluginLog, parsePluginInfoVersion, pluginExtension, PLUGIN_CATALOG } from '../lib/plugin-manager.mjs';
import { createRconFixture } from './support/rcon-instance-fixture.mjs';

// Plugin files here are inert test bytes, never real libraries; nothing is loaded.
const pluginBytes = label => Buffer.from(`fake plugin ${label} `.padEnd(256, '#'));
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const approvedAt = '2026-10-18T10:00:00.000Z';

test('plugin registry records are validated, unique, platform bound and limited', () => {
  const record = { name: 'b3hide', platform: 'windows', sha256: 'a'.repeat(64), enabled: true, approvedAt, config: { b3Hide: 1, b3HideLvl: '40' } };
  assert.deepEqual(normalizePluginRecords([record], 'windows')[0].config, { b3Hide: '1', b3HideLvl: '40' });
  assert.deepEqual(normalizePluginRecords(undefined, 'linux'), []);
  for (const bad of [[{ ...record, name: '../x' }], [{ ...record, platform: 'linux' }], [{ ...record, sha256: 'x' }], [record, { ...record, name: 'B3HIDE' }]]) {
    assert.throws(() => normalizePluginRecords(bad, 'windows'), error => ['PLUGIN_REGISTRY_INVALID', 'PLUGIN_NAME_INVALID'].includes(error.code));
  }
  for (const config of [{ unknown: '1' }, { b3HideLvl: '101' }, { b3Prefix: '"; quit' }, { b3Hide: '2' }]) {
    assert.throws(() => normalizePluginRecords([{ ...record, config }], 'windows'), { code: 'PLUGIN_CONFIG_INVALID' });
  }
  const many = Array.from({ length: 16 }, (_, index) => ({ ...record, name: `p${index}`, config: {} }));
  assert.throws(() => normalizePluginRecords(many, 'windows'), { code: 'PLUGIN_LIMIT' }, 'CoD4x MAX_PLUGINS is 16 with one slot reserved');
  assert.deepEqual(Object.keys(PLUGIN_CATALOG.b3hide.config), ['b3Prefix', 'b3Hide', 'b3HideLvl']);
  assert.deepEqual([pluginExtension('windows'), pluginExtension('linux')], ['.dll', '.so']);
});

test('discovery hashes platform files and flags foreign, invalid, tiny and hardlinked files', async t => {
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-plugins-'));
  t.after(() => fs.rm(homePath, { recursive: true, force: true }));
  const directory = path.join(homePath, 'plugins');
  await fs.mkdir(directory);
  const good = pluginBytes('good');
  await fs.writeFile(path.join(directory, 'b3hide.dll'), good);
  await fs.writeFile(path.join(directory, 'linuxonly.so'), pluginBytes('linux'));
  await fs.writeFile(path.join(directory, 'bad-name.dll'), pluginBytes('bad'));
  await fs.writeFile(path.join(directory, 'tiny.dll'), 'x');
  await fs.writeFile(path.join(directory, 'linked.dll'), pluginBytes('linked'));
  await fs.link(path.join(directory, 'linked.dll'), path.join(homePath, 'outside.dll'));
  await fs.writeFile(path.join(directory, 'readme.txt'), 'ignored');
  const found = Object.fromEntries((await discoverPlugins({ homePath, platform: 'windows' })).map(entry => [entry.name, entry]));
  assert.equal(found.b3hide.sha256, sha(good));
  assert.equal(found.linuxonly.code, 'PLUGIN_WRONG_PLATFORM');
  assert.equal(found['bad-name'].code, 'PLUGIN_NAME_INVALID');
  assert.equal(found.tiny.code, 'PLUGIN_FILE_SIZE_INVALID');
  assert.equal(found.linked.code, 'PLUGIN_FILE_UNSAFE');
  assert.equal(found.readme, undefined);
  const states = Object.fromEntries(describePlugins([{ name: 'b3hide', sha256: 'b'.repeat(64), enabled: true, approvedAt, config: {} }, { name: 'gone', sha256: 'c'.repeat(64), enabled: false, approvedAt, config: {} }], Object.values(found)).map(entry => [entry.name, entry.state]));
  assert.deepEqual([states.b3hide, states.gone, states.linuxonly, states.tiny], ['INTEGRITY_MISMATCH', 'MISSING', 'WRONG_PLATFORM', 'INVALID']);
});

test('console and pluginInfo parsing use the exact plugin_handler.c messages', () => {
  const log = ['Plugin b3hide loaded successfully. Server is currently running 1 plugins.', 'No such file found: plugins/missing.dll. Can not load this plugin.',
    'plugins/broken.dll is not a plugin file or is corrupt or contains disallowed functions.', '^1Error: C:/srv/plugin.secure.tmp checksum missmatch! This plugin will not be loaded in securemode.',
    '^1Error: Failed to load the plugin C:/srv/plugin.native.tmp!'].join('\n');
  assert.deepEqual(classifyPluginLog(log), { b3hide: 'LOADED', missing: 'NOT_FOUND', broken: 'REJECTED_INVALID', secure: 'SECUREMODE_REJECTED', native: 'LOAD_FAILED' });
  assert.equal(parsePluginInfoVersion('\n^2Plugin name:^7\nb3hide\n\n^2Plugin version:^7\n1.2\n\n'), '1.2');
  assert.equal(parsePluginInfoVersion('Plugin "b3hide" is not loaded!\n'), null);
});

async function fixture(t) { const value = await createRconFixture(); t.after(value.cleanup); return value; }

test('discovery, approval, enable/disable and integrity gate the launch arguments', async t => {
  const { manager, children, create, store } = await fixture(t);
  await create('plug-a');
  const instance = store.get('plug-a');
  const file = path.join(instance.homePath, 'plugins', 'b3hide.dll'), bytes = pluginBytes('b3hide');
  await fs.writeFile(file, bytes);
  let listing = await manager.plugins('plug-a');
  assert.deepEqual([listing.plugins[0].state, listing.plugins[0].sha256], ['NOT_APPROVED', sha(bytes)]);
  await assert.rejects(manager.approvePlugin('plug-a', { name: 'b3hide', sha256: 'f'.repeat(64) }), { code: 'PLUGIN_INTEGRITY_FAILED' });
  await manager.approvePlugin('plug-a', { name: 'b3hide', sha256: sha(bytes) });
  assert.equal((await manager.plugins('plug-a')).plugins[0].state, 'DISABLED');
  const plain = await manager.launch('plug-a');
  assert.ok(!children.get(plain.pid).args.includes('+loadPlugin'), 'approved but disabled plugin is not loaded');
  await assert.rejects(manager.setPluginEnabled('plug-a', 'b3hide', true), { code: 'INSTANCE_RUNTIME_BUSY' });
  await manager.stop('plug-a');
  await manager.setPluginEnabled('plug-a', 'b3hide', true);
  await manager.configurePlugin('plug-a', 'b3hide', { b3Hide: '1', b3HideLvl: '40' });
  const state = await manager.launch('plug-a');
  const args = children.get(state.pid).args;
  const load = args.indexOf('+loadPlugin');
  assert.ok(load > 0 && args[load + 1] === 'b3hide' && load < args.indexOf('+exec'), 'loadPlugin before server.cfg');
  assert.deepEqual(args.slice(load + 2, load + 8), ['+set', 'b3Hide', '1', '+set', 'b3HideLvl', '40']);
  listing = await manager.plugins('plug-a');
  assert.deepEqual([listing.plugins[0].state, listing.plugins[0].load], ['ENABLED', 'LOADED']);
  await manager.stop('plug-a');
  // Tampering after approval blocks the start before anything is spawned.
  const spawned = children.size;
  await fs.writeFile(file, pluginBytes('tampered'));
  await assert.rejects(manager.launch('plug-a'), { code: 'PLUGIN_INTEGRITY_FAILED' });
  await fs.unlink(file);
  await assert.rejects(manager.launch('plug-a'), { code: 'PLUGIN_MISSING' });
  assert.equal(children.size, spawned);
  await manager.setPluginEnabled('plug-a', 'b3hide', false);
  assert.equal((await manager.launch('plug-a')).status, 'RUNNING', 'disabling a missing plugin restores startability');
});

test('install from a local file pins the hash, refuses overwrite, removal archives; clones start clean', async t => {
  const { manager, create, store, root } = await fixture(t);
  await create('plug-b');
  const source = path.join(root, 'b3hide.dll'), bytes = pluginBytes('install');
  await fs.writeFile(source, bytes);
  await assert.rejects(manager.installPlugin('plug-b', { sourcePath: 'relative/b3hide.dll' }), { code: 'PLUGIN_SOURCE_INVALID' });
  await fs.writeFile(path.join(root, 'b3hide.so'), bytes);
  await assert.rejects(manager.installPlugin('plug-b', { sourcePath: path.join(root, 'b3hide.so') }), { code: 'PLUGIN_WRONG_PLATFORM' });
  const installed = await manager.installPlugin('plug-b', { sourcePath: source });
  assert.equal(installed.sha256, sha(bytes));
  assert.deepEqual(await fs.readFile(path.join(store.get('plug-b').homePath, 'plugins', 'b3hide.dll')), bytes);
  assert.equal((await manager.plugins('plug-b')).plugins[0].state, 'DISABLED', 'installed plugins start disabled');
  await assert.rejects(manager.installPlugin('plug-b', { sourcePath: source }), { code: 'PLUGIN_EXISTS' });
  await manager.setPluginEnabled('plug-b', 'b3hide', true);
  const clone = await manager.clone('plug-b', { id: 'plug-c', port: store.get('plug-b').port + 1 });
  assert.deepEqual(clone.plugins, [], 'plugin approvals are never cloned');
  const removed = await manager.removePlugin('plug-b', 'b3hide');
  assert.match(removed.archived.archivedAs, /^b3hide\.dll\./);
  const home = store.get('plug-b').homePath;
  await assert.rejects(fs.stat(path.join(home, 'plugins', 'b3hide.dll')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(home, 'plugins', '.removed', removed.archived.archivedAs)), bytes, 'removal keeps a recoverable copy');
  assert.deepEqual(store.get('plug-b').plugins, []);
});

test('plugin version is read at runtime via allowlisted RCON pluginInfo only', async t => {
  const { manager, create, store, setRcon, auditEvents } = await fixture(t);
  await create('plug-d');
  const bytes = pluginBytes('version');
  await fs.writeFile(path.join(store.get('plug-d').homePath, 'plugins', 'b3hide.dll'), bytes);
  await manager.approvePlugin('plug-d', { name: 'b3hide', sha256: sha(bytes) });
  await manager.setPluginEnabled('plug-d', 'b3hide', true);
  await setRcon('plug-d', 'Plugin-Rcon-4188');
  await manager.launch('plug-d');
  const listing = await manager.readPluginVersions('plug-d', 'tester');
  assert.equal(listing.plugins[0].version, '1.0');
  assert.ok(auditEvents.some(entry => entry.event === 'rcon.command' && entry.details.command === 'pluginInfo b3hide'));
  await manager.launch('plug-d', true);
  assert.equal((await manager.plugins('plug-d')).plugins[0].version, null, 'versions are bound to the run they were read in');
});

test('a same-name file of the other platform neither blocks install nor the launch', async t => {
  const { manager, children, create, store, root } = await fixture(t);
  await create('plug-e');
  const plugins = path.join(store.get('plug-e').homePath, 'plugins');
  await fs.writeFile(path.join(plugins, 'b3hide.so'), pluginBytes('linux variant'));
  const source = path.join(root, 'b3hide.dll');
  await fs.writeFile(source, pluginBytes('windows variant'));
  await manager.installPlugin('plug-e', { sourcePath: source });
  await manager.setPluginEnabled('plug-e', 'b3hide', true);
  const listing = await manager.plugins('plug-e');
  assert.deepEqual(listing.plugins.map(plugin => plugin.state).sort(), ['ENABLED', 'WRONG_PLATFORM']);
  const state = await manager.launch('plug-e');
  assert.ok(children.get(state.pid).args.includes('+loadPlugin'));
});
