import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { ServerInstanceStore } from '../lib/server-instance-store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-instance-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const basePath = path.join(root, 'game');
  const executablePath = path.join(root, 'core', 'cod4x18_dedrun.exe');
  await fs.mkdir(path.join(basePath, 'main'), { recursive: true });
  await fs.mkdir(path.join(basePath, 'zone'), { recursive: true });
  await fs.mkdir(path.dirname(executablePath));
  await fs.writeFile(path.join(basePath, 'main', 'pak0.iwd'), 'fixture');
  await fs.writeFile(path.join(basePath, 'zone', 'common.ff'), 'fixture');
  await fs.writeFile(executablePath, 'unverified fixture');
  const options = { root: path.join(root, 'servers'), registryFile: path.join(root, 'instances.json'), checkPort: async () => {} };
  const store = new ServerInstanceStore(options);
  await store.load();
  const input = { id: 'public-01', name: 'Public 01', platform: 'windows', serverCore: { executablePath, version: '21.5' }, basePath, port: 28960 };
  return { root, store, input, options };
}

test('creates two isolated persisted instances sharing only read-only assets/core', async t => {
  const { store, input, options } = await fixture(t);
  const [a, b] = await Promise.all([store.create(input), store.create({ ...input, id: 'public-02', port: 28961 })]);
  assert.notEqual(a.homePath, b.homePath);
  assert.equal(a.basePath, b.basePath);
  for (const instance of [a, b]) {
    for (const folder of ['main', 'zone', 'mods', 'plugins', 'usermaps', 'players', 'logs']) assert.ok((await fs.stat(path.join(instance.homePath, folder))).isDirectory());
    assert.match(await fs.readFile(instance.configPath, 'utf8'), new RegExp(`net_port "${instance.port}"`));
    await assert.rejects(fs.stat(path.join(instance.homePath, 'main', 'pak0.iwd')), { code: 'ENOENT' });
  }
  const loaded = new ServerInstanceStore(options);
  await loaded.load();
  assert.deepEqual(loaded.list(), store.list());
  const list = store.list(); list[0].name = 'mutated';
  assert.notEqual(store.get('public-01').name, 'mutated');
});

test('Linux Core filename is exact and case-sensitive even when configured on Windows', async t => {
  const { store, input } = await fixture(t);
  const linux = { ...input, platform: 'linux', serverCore: { ...input.serverCore, executablePath: path.join(path.dirname(input.serverCore.executablePath), 'cod4x18_dedrun') } };
  assert.equal(store.model(linux).platform, 'linux');
  await assert.rejects(store.create({ ...linux, serverCore: { ...linux.serverCore, executablePath: path.join(path.dirname(input.serverCore.executablePath), 'COD4X18_DEDRUN') } }), { code: 'INSTANCE_CORE_INVALID' });
});

test('Core 21.2 is additional and all existing version identities survive registry reload', async t => {
  const { store, input, options } = await fixture(t);
  const versions = ['21.2', '21.3', '21.4', '21.5'];
  for (const [index, version] of versions.entries()) {
    const instance = await store.create({ ...input, id: `version-${index}`, port: 29000 + index, serverCore: { ...input.serverCore, version } });
    assert.equal(instance.serverCore.version, version);
  }
  const loaded = new ServerInstanceStore(options);
  await loaded.load();
  assert.deepEqual(loaded.list().map(instance => instance.serverCore.version), versions);
  await assert.rejects(loaded.create({ ...input, id: 'unsupported', serverCore: { ...input.serverCore, version: '99.0' } }), { code: 'INSTANCE_CORE_VERSION_INVALID' });
});

test('duplicate IDs and ports are rejected even in concurrent creation', async t => {
  const { store, input } = await fixture(t);
  await store.create(input);
  await assert.rejects(store.create(input), { code: 'INSTANCE_ID_CONFLICT' });
  await assert.rejects(store.create({ ...input, id: 'public-02' }), { code: 'INSTANCE_PORT_CONFLICT' });
  assert.equal(store.list().length, 1);
});

test('rejects traversal, arbitrary homes, wrong core and invalid ports before creating directories', async t => {
  const { store, input, options } = await fixture(t);
  for (const body of [{ ...input, id: '../escape' }, { ...input, homePath: input.basePath }, { ...input, port: 0 }, { ...input, platform: 'macos' }, { ...input, serverCore: { ...input.serverCore, executablePath: path.join(path.dirname(input.serverCore.executablePath), 'iw3mp.exe') } }]) await assert.rejects(store.create(body));
  assert.equal(store.list().length, 0);
  await assert.rejects(fs.stat(path.join(options.root, input.id)), { code: 'ENOENT' });
});

test('clone gets new identity/home/port, while delete archives only that instance', async t => {
  const { store, input } = await fixture(t);
  const a = await store.create(input);
  const b = await store.clone(a.id, { id: 'public-02', name: 'Clone', port: 28961 });
  assert.notEqual(a.homePath, b.homePath);
  assert.equal(b.rcon.configured, false);
  const result = await store.archive(a.id);
  assert.ok((await fs.stat(result.archivedHomePath)).isDirectory());
  assert.ok((await fs.stat(b.homePath)).isDirectory());
  assert.ok((await fs.stat(a.basePath)).isDirectory());
  assert.equal(store.list().length, 1);
});

test('corrupt registries fail closed rather than being silently replaced', async t => {
  const { options } = await fixture(t);
  await fs.writeFile(options.registryFile, '{broken');
  const store = new ServerInstanceStore(options);
  await assert.rejects(store.load());
  await assert.rejects(store.create({}));
  assert.equal(await fs.readFile(options.registryFile, 'utf8'), '{broken');
});

test('UDP port occupied by another process is rejected', async t => {
  const { options, input } = await fixture(t);
  const socket = dgram.createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '0.0.0.0', resolve));
  t.after(() => new Promise(resolve => socket.close(resolve)));
  const { checkPort, ...realOptions } = options;
  const store = new ServerInstanceStore(realOptions);
  await store.load();
  await assert.rejects(store.create({ ...input, port: socket.address().port }), { code: 'INSTANCE_PORT_UNAVAILABLE' });
});

test('existing homes are never adopted or overwritten', async t => {
  const { store, input, options } = await fixture(t);
  const home = path.join(options.root, input.id);
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, 'user-owned.txt'), 'keep');
  await assert.rejects(store.create(input), { code: 'INSTANCE_HOME_EXISTS' });
  assert.equal(await fs.readFile(path.join(home, 'user-owned.txt'), 'utf8'), 'keep');
});

test('junction aliases into BaseGame are rejected without altering assets', async t => {
  const { root, input, options } = await fixture(t);
  const alias = path.join(root, 'alias');
  await fs.symlink(input.basePath, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const store = new ServerInstanceStore({ ...options, root: path.join(alias, 'servers') });
  await store.load();
  await assert.rejects(store.create(input), { code: 'INSTANCE_PATH_OVERLAP' });
  await assert.rejects(fs.stat(path.join(input.basePath, 'servers')), { code: 'ENOENT' });
});

test('post-creation junctions cannot redirect archive or runtime paths', async t => {
  const { store, input } = await fixture(t);
  const instance = await store.create(input);
  const logs = path.join(instance.homePath, 'logs');
  await fs.rmdir(logs);
  await fs.symlink(input.basePath, logs, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.validatePaths(instance), { code: 'INSTANCE_PATH_ALIAS_BLOCKED' });
  await assert.rejects(store.archive(instance.id), { code: 'INSTANCE_PATH_ALIAS_BLOCKED' });
  assert.ok((await fs.stat(input.basePath)).isDirectory());
});

test('registry write failure leaves a recoverable directory and no phantom instance', async t => {
  const { store, input, options } = await fixture(t);
  store.persist = async () => { throw Object.assign(new Error('Simulated registry write denial'), { code: 'EACCES' }); };
  await assert.rejects(store.create(input), { code: 'EACCES' });
  assert.equal(store.list().length, 0);
  await assert.rejects(fs.stat(path.join(options.root, input.id)), { code: 'ENOENT' });
  assert.equal((await fs.readdir(path.join(options.root, '.recovery'))).length, 1);
});

test('join policy survives reload, cannot be injected on create and is not cloned', async t => {
  const { store, input, options } = await fixture(t);
  const instance = await store.create({ ...input, credentialPolicy: { join: 'required' } });
  assert.deepEqual(instance.credentialPolicy, { join: 'none', rcon: 'none' });
  await store.setJoinRequirement(instance, 'required');
  const loaded = new ServerInstanceStore(options);
  await loaded.load();
  assert.deepEqual(loaded.get(instance.id).credentialPolicy, { join: 'required', rcon: 'none' });
  const cloned = await loaded.clone(instance.id, { id: 'public-02', port: 28961 });
  assert.deepEqual(cloned.credentialPolicy, { join: 'none', rcon: 'none' });
});

test('legacy join policy remains unclassified and malformed stored policy fails closed', async t => {
  const { store, input, options } = await fixture(t);
  await store.create(input);
  const raw = JSON.parse(await fs.readFile(options.registryFile, 'utf8'));
  delete raw.instances[0].credentialPolicy;
  await fs.writeFile(options.registryFile, JSON.stringify(raw));
  await store.load();
  assert.deepEqual(store.get(input.id).credentialPolicy, { join: 'unclassified', rcon: 'unclassified' });
  for (const policy of [null, {}, { join: 'optional' }, { join: 'none', value: 'forbidden' }]) {
    raw.instances[0].credentialPolicy = policy;
    await fs.writeFile(options.registryFile, JSON.stringify(raw));
    await assert.rejects(store.load(), { code: 'INSTANCE_CREDENTIAL_POLICY_INVALID' });
    assert.throws(() => store.list(), { code: 'INSTANCE_REGISTRY_UNAVAILABLE' });
  }
});

test('join policy publication requires matching instance birth/home and successful persistence', async t => {
  const { store, input, options } = await fixture(t);
  const instance = await store.create(input);
  const original = await fs.readFile(options.registryFile);
  for (const expected of [{ ...instance, createdAt: '2000-01-01T00:00:00.000Z' }, { ...instance, homePath: input.basePath }]) {
    await assert.rejects(store.setJoinRequirement(expected, 'required'), { code: 'INSTANCE_IDENTITY_CONFLICT' });
  }
  await assert.rejects(store.setJoinRequirement(instance, 'unclassified'), { code: 'INSTANCE_CREDENTIAL_POLICY_INVALID' });
  store.persist = async () => { throw Object.assign(new Error('Controlled registry write denial'), { code: 'EACCES' }); };
  await assert.rejects(store.setJoinRequirement(instance, 'required'), { code: 'EACCES' });
  assert.deepEqual(store.get(instance.id).credentialPolicy, { join: 'none', rcon: 'none' });
  assert.deepEqual(await fs.readFile(options.registryFile), original);
});

test('RCON policy persists independently, clones no credentials and migrates old Join-only metadata as unknown', async t => {
  const { store, input, options } = await fixture(t);
  const created = await store.create({ ...input, credentialPolicy: { join: 'required', rcon: 'required' } });
  assert.deepEqual(created.credentialPolicy, { join: 'none', rcon: 'none' });
  await store.setCredentialRequirement(created, 'rcon', 'required');
  const reloaded = new ServerInstanceStore(options); await reloaded.load();
  assert.deepEqual(reloaded.get(created.id).credentialPolicy, { join: 'none', rcon: 'required' });
  assert.deepEqual((await reloaded.clone(created.id, { id: 'public-02', port: 28961 })).credentialPolicy, { join: 'none', rcon: 'none' });
  const raw = JSON.parse(await fs.readFile(options.registryFile, 'utf8'));
  raw.instances[0].credentialPolicy = { join: 'none' };
  await fs.writeFile(options.registryFile, JSON.stringify(raw)); await store.load();
  assert.deepEqual(store.get(created.id).credentialPolicy, { join: 'none', rcon: 'unclassified' });
  for (const policy of [{ join: 'none', rcon: null }, { join: 'none', rcon: 'optional' }, { join: 'none', rcon: 'none', master: 'required' }]) {
    raw.instances[0].credentialPolicy = policy;
    await fs.writeFile(options.registryFile, JSON.stringify(raw));
    await assert.rejects(store.load(), { code: 'INSTANCE_CREDENTIAL_POLICY_INVALID' });
  }
});
