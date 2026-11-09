import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RemoteHostStore } from '../lib/remote-host-store.mjs';
import { RemoteInstanceStore } from '../lib/remote-instance-store.mjs';

const SHA = 'c'.repeat(64);
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code, code);
const input = overrides => ({
  id: 'public-01', name: 'Public 01', hostId: 'lab-1', port: 28960, remoteRoot: '/srv/cod4x', basePath: '/srv/game',
  core: { version: '21.5', sha256: SHA }, ...overrides,
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-remote-instances-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hostFile = path.join(root, 'hosts.json'), file = path.join(root, 'config', 'remote-instances.json');
  let instances;
  const hosts = new RemoteHostStore({ file: hostFile, inUse: id => instances.hasInstancesFor(id) });
  await hosts.load();
  for (const id of ['lab-1', 'lab-2']) await hosts.create({ id, label: id, host: `${id}.example.org`, port: 22, username: 'cod4x' });
  instances = new RemoteInstanceStore({ file, hosts });
  await instances.load();
  return {
    root, hosts, instances, file,
    reopen: async () => { const next = new RemoteInstanceStore({ file, hosts }); await next.load(); return next; },
  };
}

test('creates an instance with a derived home and core path, on loopback, and hands out copies', async t => {
  const { instances } = await fixture(t);
  const created = await instances.create(input());
  assert.equal(created.home, '/srv/cod4x/public-01');
  assert.deepEqual(created.core, { path: '/srv/cod4x/public-01/core/cod4x18_dedrun', version: '21.5', sha256: SHA });
  assert.deepEqual(created.network, { scope: 'LOOPBACK', publicAddress: null });
  assert.match(created.createdAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(instances.list().map(entry => entry.id), ['public-01']);
  instances.list()[0].port = 1; instances.get('public-01').core.version = '21.2';
  assert.equal(instances.get('public-01').port, 28960);
  assert.equal(instances.get('public-01').core.version, '21.5');
  assert.deepEqual(instances.listByHost('lab-1').map(entry => entry.id), ['public-01']);
  assert.deepEqual(instances.listByHost('lab-2'), []);
  await rejects(Promise.resolve().then(() => instances.get('nope')), 'REMOTE_INSTANCE_NOT_FOUND');
});

test('refuses invalid input and unknown fields before anything is stored', async t => {
  const { instances } = await fixture(t);
  const bad = [
    { id: 'Bad Id' }, { id: '' }, { id: 'a'.repeat(49) }, { name: '' }, { name: 'x'.repeat(81) }, { name: 'a"b' }, { name: 'a\nb' },
    { port: 1023 }, { port: 65536 }, { port: 28960.5 }, { port: '28960' },
    { remoteRoot: 'srv/cod4x' }, { remoteRoot: '/srv/../x' }, { remoteRoot: '/srv//x' }, { remoteRoot: '/' }, { basePath: 'game' }, { basePath: '/srv/game/..' },
    { core: { version: '20.0', sha256: SHA } }, { core: { version: '21.5', sha256: 'z'.repeat(64) } }, { core: { version: '21.5' } }, { core: { version: '21.5', sha256: SHA, path: '/bin/sh' } },
    { network: { scope: 'PUBLIC', publicAddress: null } }, { extra: 1 }, { home: '/etc' },
  ];
  for (const overrides of bad) await rejects(instances.create(input(overrides)), 'REMOTE_INSTANCE_INVALID');
  assert.equal(instances.list().length, 0);
  await rejects(instances.create(input({ hostId: 'missing' })), 'REMOTE_HOST_NOT_FOUND');
  await rejects(instances.create(input({ hostId: 5 })), 'REMOTE_INSTANCE_INVALID');
});

test('ids are unique; a port is unique per host, not across hosts, also under concurrent creates', async t => {
  const { instances } = await fixture(t);
  await instances.create(input());
  await rejects(instances.create(input({ hostId: 'lab-2', port: 28999 })), 'REMOTE_INSTANCE_EXISTS');
  await rejects(instances.create(input({ id: 'public-02' })), 'REMOTE_PORT_CONFLICT');
  await instances.create(input({ id: 'public-02', hostId: 'lab-2' }));
  const outcomes = await Promise.allSettled([instances.create(input({ id: 'x-1', port: 28970 })), instances.create(input({ id: 'x-2', port: 28970 }))]);
  assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'REMOTE_PORT_CONFLICT');
});

test('the home and the base game never overlap, and homes on one host never nest', async t => {
  const { instances } = await fixture(t);
  await rejects(instances.create(input({ id: 'game', remoteRoot: '/srv', basePath: '/srv/game' })), 'REMOTE_PATH_OVERLAP');
  await rejects(instances.create(input({ basePath: '/srv/cod4x/public-01' })), 'REMOTE_PATH_OVERLAP');
  await rejects(instances.create(input({ basePath: '/srv/cod4x/public-01/game' })), 'REMOTE_PATH_OVERLAP');
  await rejects(instances.create(input({ basePath: '/srv' })), 'REMOTE_PATH_OVERLAP', 'the base game may not contain the home');
  await instances.create(input({ basePath: '/srv/game' }));
  // a second instance whose home would lie inside the first one's home
  await rejects(instances.create(input({ id: 'inner', port: 28961, remoteRoot: '/srv/cod4x/public-01' })), 'REMOTE_PATH_OVERLAP');
  // on another host the same paths are fine
  await instances.create(input({ id: 'other', hostId: 'lab-2', remoteRoot: '/srv/cod4x/public-01' }));
  assert.equal(instances.list().length, 2);
});

test('persists across a reload; the file is private; a corrupt or orphaned file fails closed', async t => {
  const { instances, reopen, file, root, hosts } = await fixture(t);
  await instances.create(input());
  const again = await reopen();
  assert.deepEqual(again.list(), instances.list());
  if (process.platform === 'linux') assert.equal((await fs.stat(file)).mode & 0o077, 0);
  assert.ok(!(await fs.readdir(path.dirname(file))).some(name => name.includes('.tmp-')));
  const good = JSON.parse(await fs.readFile(file, 'utf8'));
  const variants = [
    '{ not json', JSON.stringify({ version: 2, instances: [] }), JSON.stringify({ version: 1, instances: 'x' }),
    JSON.stringify({ version: 1, instances: [{ ...good.instances[0], home: '/etc/passwd' }] }),
    JSON.stringify({ version: 1, instances: [{ ...good.instances[0], hostId: 'gone' }] }),
    JSON.stringify({ version: 1, instances: [good.instances[0], good.instances[0]] }),
    JSON.stringify({ version: 1, instances: [{ ...good.instances[0], core: { ...good.instances[0].core, path: '/bin/sh' } }] }),
  ];
  for (const text of variants) {
    await fs.writeFile(file, text);
    const broken = new RemoteInstanceStore({ file, hosts });
    await rejects(broken.load(), 'REMOTE_INSTANCE_STORE_INVALID');
    await rejects(broken.create(input({ id: 'later', port: 28980 })), 'REMOTE_INSTANCE_STORE_INVALID');
    assert.equal(await fs.readFile(file, 'utf8'), text, 'the file is not replaced');
  }
  assert.ok(root);
});

test('setNetwork, setCore and remove change only what they name', async t => {
  const { instances } = await fixture(t);
  await instances.create(input());
  const changed = await instances.setNetwork('public-01', { scope: 'PUBLIC', publicAddress: '203.0.113.7' });
  assert.deepEqual(changed.network, { scope: 'PUBLIC', publicAddress: '203.0.113.7' });
  await rejects(instances.setNetwork('public-01', { scope: 'WORLD' }), 'REMOTE_INSTANCE_INVALID');
  const recored = await instances.setCore('public-01', { version: '21.4', sha256: 'd'.repeat(64) });
  assert.deepEqual(recored.core, { path: '/srv/cod4x/public-01/core/cod4x18_dedrun', version: '21.4', sha256: 'd'.repeat(64) });
  assert.equal(recored.port, 28960);
  await rejects(instances.setCore('public-01', { version: '9.9', sha256: SHA }), 'REMOTE_INSTANCE_INVALID');
  await rejects(instances.setNetwork('missing', { scope: 'LOOPBACK' }), 'REMOTE_INSTANCE_NOT_FOUND');
  await instances.remove('public-01');
  assert.equal(instances.list().length, 0);
  await rejects(instances.remove('public-01'), 'REMOTE_INSTANCE_NOT_FOUND');
});

test('a host with instances cannot be removed from the host store, and can once the instances are gone', async t => {
  const { instances, hosts } = await fixture(t);
  await instances.create(input());
  assert.equal(instances.hasInstancesFor('lab-1'), true);
  assert.equal(instances.hasInstancesFor('lab-2'), false);
  await rejects(hosts.remove('lab-1'), 'REMOTE_HOST_IN_USE');
  await hosts.remove('lab-2');
  await instances.remove('public-01');
  await hosts.remove('lab-1');
  assert.equal(hosts.list().length, 0);
});

// ---- Block 19: deployment ------------------------------------------------------------------------------
test('deployment defaults to native, accepts docker, and an instance list without the field loads as native', async t => {
  const { instances, file, reopen } = await fixture(t);
  assert.equal((await instances.create(input())).deployment, 'native');
  assert.equal((await instances.create(input({ id: 'public-02', port: 28961, deployment: 'docker' }))).deployment, 'docker');
  await rejects(instances.create(input({ id: 'public-03', port: 28962, deployment: 'podman' })), 'REMOTE_INSTANCE_INVALID');
  await rejects(instances.create(input({ id: 'public-03', port: 28962, deployment: null })), 'REMOTE_INSTANCE_INVALID');
  // a file written by 4.18.24 has no deployment key
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const instance of raw.instances) delete instance.deployment;
  await fs.writeFile(file, JSON.stringify(raw));
  assert.deepEqual((await reopen()).list().map(instance => instance.deployment), ['native', 'native']);
  raw.instances[0].deployment = 'podman';
  await fs.writeFile(file, JSON.stringify(raw));
  await rejects(reopen(), 'REMOTE_INSTANCE_STORE_INVALID');
});

test('a docker instance needs mount-safe host paths; a native one does not', async t => {
  const { instances } = await fixture(t);
  await rejects(instances.create(input({ remoteRoot: '/srv/a,b', deployment: 'docker' })), 'REMOTE_DOCKER_PATH_UNSUPPORTED');
  await rejects(instances.create(input({ basePath: '/srv/ga"me', deployment: 'docker' })), 'REMOTE_DOCKER_PATH_UNSUPPORTED');
  const native = await instances.create(input({ remoteRoot: '/srv/a,b' }));
  assert.equal(native.deployment, 'native');
  await rejects(instances.setDeployment('public-01', 'docker'), 'REMOTE_DOCKER_PATH_UNSUPPORTED');
  assert.equal(instances.get('public-01').deployment, 'native');
});

test('setDeployment changes only the deployment and survives a reload', async t => {
  const { instances, reopen } = await fixture(t);
  const created = await instances.create(input());
  const switched = await instances.setDeployment('public-01', 'docker');
  assert.deepEqual(switched, { ...created, deployment: 'docker' });
  assert.equal((await reopen()).get('public-01').deployment, 'docker');
  assert.equal((await instances.setDeployment('public-01', 'native')).deployment, 'native');
  for (const bad of ['podman', undefined, null, '']) await rejects(instances.setDeployment('public-01', bad), 'REMOTE_INSTANCE_INVALID');
  await rejects(instances.setDeployment('nope', 'docker'), 'REMOTE_INSTANCE_NOT_FOUND');
});
