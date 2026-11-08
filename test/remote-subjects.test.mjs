import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REMOTE_PREFIX, remoteSubject, isRemoteSubject, remoteIdOf, createShadowStore, remoteSubjectResolver, prefixedCredentials } from '../lib/remote-subjects.mjs';
import { InstanceCredentialService } from '../lib/instance-credential-service.mjs';

const passphrase = 'Disposable remote subject passphrase!';
const code = fn => { try { fn(); return null; } catch (error) { return error.code || 'THROWN'; } };

function remoteInstances() {
  const records = new Map([['alpha', { id: 'alpha', hostId: 'lab-1', port: 28960, createdAt: '2026-11-08T10:00:00.000Z' }]]);
  return {
    records,
    get(id) { const value = records.get(id); if (!value) throw Object.assign(new Error('x'), { code: 'REMOTE_INSTANCE_NOT_FOUND' }); return { ...value }; },
    list() { return [...records.values()].map(value => ({ ...value })); },
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-remote-subjects-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const instances = remoteInstances();
  const shadow = createShadowStore({ instances, dataRoot: root });
  const resolveRemote = remoteSubjectResolver(shadow);
  const local = { id: 'alpha', homePath: path.join(root, 'local', 'alpha'), createdAt: '2026-11-08T09:00:00.000Z' };
  const service = new InstanceCredentialService({ dataRoot: root, resolveInstance: id => (isRemoteSubject(id) ? resolveRemote(id) : id === 'alpha' ? local : (() => { throw Object.assign(new Error('x'), { code: 'INSTANCE_NOT_FOUND' }); })()) });
  await service.initialize(passphrase); await service.unlock(passphrase);
  const remote = prefixedCredentials(service);
  return { root, instances, shadow, service, remote };
}

test('subject helpers write and read rmt_<id> and refuse anything else', () => {
  assert.equal(REMOTE_PREFIX, 'rmt_');
  assert.equal(remoteSubject('alpha'), 'rmt_alpha');
  assert.equal(isRemoteSubject('rmt_alpha'), true);
  for (const value of ['alpha', 'ssh_lab-1', 'rmt_', 'rmt_Alpha', 'rmt_a b', 42, null]) assert.equal(isRemoteSubject(value), false, String(value));
  assert.equal(remoteIdOf('rmt_alpha'), 'alpha');
  assert.equal(code(() => remoteIdOf('alpha')), 'REMOTE_INSTANCE_INVALID');
  assert.equal(code(() => remoteSubject('Bad Id')), 'REMOTE_INSTANCE_INVALID');
});

test('the shadow store gives each remote instance a private local home and lists them', async t => {
  const { root, shadow } = await fixture(t);
  const entry = shadow.get('alpha');
  assert.deepEqual(entry, { id: 'alpha', homePath: path.join(root, 'remote-data', 'alpha'), createdAt: '2026-11-08T10:00:00.000Z', port: 28960, hostId: 'lab-1' });
  if (process.platform !== 'win32') assert.equal((await fs.stat(entry.homePath)).mode & 0o777, 0o700);
  assert.deepEqual(shadow.list().map(value => value.id), ['alpha']);
  assert.equal(code(() => shadow.get('nope')), 'REMOTE_INSTANCE_NOT_FOUND');
  assert.equal(code(() => shadow.get('../x')), 'REMOTE_INSTANCE_INVALID');
});

test('rmt_ subjects resolve to the shadow home under their own id', async t => {
  const { root, shadow } = await fixture(t);
  const resolve = remoteSubjectResolver(shadow);
  assert.deepEqual(resolve('rmt_alpha'), { id: 'rmt_alpha', homePath: path.join(root, 'remote-data', 'alpha'), createdAt: '2026-11-08T10:00:00.000Z' });
  assert.equal(code(() => resolve('alpha')), 'INSTANCE_NOT_FOUND');
});

test('a local id alpha and a remote id alpha keep separate vault entries', async t => {
  const { service, remote } = await fixture(t);
  const sha = async () => (await service.status()).sha256;
  await service.set('alpha', 'rcon', { value: 'LocalPassword1', expectedSha256: await sha() });
  await remote.set('alpha', 'rcon', { value: 'RemotePassword1', expectedSha256: await sha() });
  const localValue = await service.withRuntimeCredentials('alpha', credentials => credentials.rcon.toString());
  const remoteValue = await remote.withRuntimeCredentials('alpha', credentials => credentials.rcon.toString());
  assert.deepEqual([localValue, remoteValue], ['LocalPassword1', 'RemotePassword1']);
  assert.equal((await remote.instanceStatus('alpha')).rcon.configured, true);
  await remote.remove('alpha', 'rcon', { expectedSha256: await sha() });
  assert.equal((await remote.instanceStatus('alpha')).rcon.configured, false);
  assert.equal((await service.instanceStatus('alpha')).rcon.configured, true, 'the local entry is untouched');
});

test('a removed and re-added remote instance does not inherit the old credentials', async t => {
  const { service, remote, instances } = await fixture(t);
  await remote.set('alpha', 'rcon', { value: 'RemotePassword1', expectedSha256: (await service.status()).sha256 });
  instances.records.set('alpha', { ...instances.records.get('alpha'), createdAt: '2026-11-08T11:00:00.000Z' });
  assert.equal((await remote.instanceStatus('alpha')).rcon.configured, false);
});

test('prefixedCredentials passes vault-wide calls through unchanged', async t => {
  const calls = [];
  const fake = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); return name; } });
  const remote = prefixedCredentials(fake);
  for (const name of ['instanceStatus', 'set', 'remove', 'withRuntimeCredentials', 'resolve', 'setB3AuthPassword']) remote[name]('alpha', 'x');
  remote.status(); remote.lock();
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['instanceStatus', 'rmt_alpha'], ['set', 'rmt_alpha'], ['remove', 'rmt_alpha'], ['withRuntimeCredentials', 'rmt_alpha'], ['resolve', 'rmt_alpha'], ['setB3AuthPassword', 'rmt_alpha'], ['status'], ['lock']]);
});
