import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { RemoteHostStore } from '../lib/remote-host-store.mjs';
import { InstanceCredentialService } from '../lib/instance-credential-service.mjs';
import { RemoteHostService, sshSubjectResolver } from '../lib/remote-host-service.mjs';
import { generateTestKeyPair } from './support/ssh-keys.mjs';

const passphrase = 'Disposable remote host passphrase!';
const PINNED = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const PEM = generateTestKeyPair().private;
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code, code);

// Real host store and real vault; the SSH layer is replaced by recording fakes.
async function fixture(t, { probeOutput = 'Linux x86_64\n1000\n1000\n', withKey = true, openError = null, probed = { sha256Hex: PINNED, sha256Base64: 'x' } } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-remote-host-service-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new RemoteHostStore({ file: path.join(root, 'hosts.json') });
  await store.load();
  await store.create({ id: 'lab-1', label: 'Lab', host: 'lab.example.org', port: 22, username: 'cod4x' });
  const credentials = new InstanceCredentialService({ dataRoot: root, resolveInstance: sshSubjectResolver({ hosts: store, dataRoot: root }) });
  await credentials.initialize(passphrase); await credentials.unlock(passphrase);
  if (withKey) await credentials.set('ssh_lab-1', 'ssh', { value: JSON.stringify({ privateKey: PEM, passphrase: 'key phrase' }), expectedSha256: (await credentials.status()).sha256 });
  const audits = [], opened = [], sessions = [];
  const openSession = async options => {
    opened.push({ host: options.host, key: Buffer.from(options.privateKey).toString(), phrase: options.passphrase && Buffer.from(options.passphrase).toString(), keyBuffer: options.privateKey, phraseBuffer: options.passphrase });
    if (openError) throw Object.assign(new Error(openError), { code: openError });
    const session = { hostKeySha256: options.host.hostKeySha256, closed: 0, exec: async () => ({ code: 0, stdout: Buffer.from(probeOutput), stderr: Buffer.alloc(0), truncated: false }), close() { this.closed++; } };
    sessions.push(session);
    return session;
  };
  const probes = [];
  const probeHostKey = async host => { probes.push(host); return probed; };
  const service = new RemoteHostService({ store, credentials, openSession, probeHostKey, audit: (level, event, details) => audits.push({ level, event, ...details }) });
  return { service, store, credentials, audits, opened, sessions, probes };
}

test('connect on a locked vault fails with VAULT_LOCKED and opens no session', async t => {
  const { service, credentials, opened } = await fixture(t);
  await service.trustHostKey('lab-1', PINNED);
  credentials.lock();
  await rejects(service.connect('lab-1'), 'VAULT_LOCKED');
  assert.equal(opened.length, 0);
});

test('connect without a stored key fails with REMOTE_CREDENTIAL_MISSING and opens no session', async t => {
  const { service, opened } = await fixture(t, { withKey: false });
  await rejects(service.connect('lab-1'), 'REMOTE_CREDENTIAL_MISSING');
  assert.equal(opened.length, 0);
});

test('trustHostKey pins only the exact value it probed', async t => {
  const { service, store, probes, audits } = await fixture(t);
  await rejects(service.trustHostKey('lab-1', OTHER), 'REMOTE_HOST_KEY_MISMATCH');
  assert.equal(store.get('lab-1').hostKeySha256, null);
  for (const bad of ['', 'A'.repeat(64), 'short', null, 5]) await rejects(service.trustHostKey('lab-1', bad), 'REMOTE_HOST_INVALID');
  assert.equal(probes.length, 1, 'only the first call reached the network; invalid input never does');
  const host = await service.trustHostKey('lab-1', PINNED);
  assert.equal(host.hostKeySha256, PINNED);
  assert.deepEqual(audits.filter(entry => entry.event === 'remote.host.key_trusted').map(entry => entry.hostId), ['lab-1']);
  await rejects(service.trustHostKey('missing', PINNED), 'REMOTE_HOST_NOT_FOUND');
});

test('probeHostKey reports both notations and is audited', async t => {
  const { service, audits } = await fixture(t);
  assert.deepEqual(await service.probeHostKey('lab-1'), { sha256Hex: PINNED, sha256Base64: 'x' });
  assert.ok(audits.some(entry => entry.event === 'remote.host.key_probed' && entry.hostId === 'lab-1'));
});

test('connect hands the pinned host and the vault key to the transport and returns session, uid and gid', async t => {
  const { service, opened } = await fixture(t);
  await service.trustHostKey('lab-1', PINNED);
  const { session, uid, gid } = await service.connect('lab-1');
  assert.deepEqual([uid, gid], [1000, 1000]);
  assert.equal(session.hostKeySha256, PINNED);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].host.hostKeySha256, PINNED);
  assert.equal(opened[0].key, PEM);
  assert.equal(opened[0].phrase, 'key phrase');
  assert.ok(opened[0].keyBuffer.every(byte => byte === 0) && opened[0].phraseBuffer.every(byte => byte === 0), 'both buffers are wiped after the login');
});

test('an unpinned host is passed on unpinned, so the transport stops before any login', async t => {
  const { service, opened } = await fixture(t, { openError: 'REMOTE_HOST_KEY_UNVERIFIED' });
  await rejects(service.connect('lab-1'), 'REMOTE_HOST_KEY_UNVERIFIED');
  assert.equal(opened[0].host.hostKeySha256, null);
});

test('connect refuses a root login and an unsupported platform, and closes the session', async t => {
  const root = await fixture(t, { probeOutput: 'Linux x86_64\n0\n0\n' });
  await rejects(root.service.connect('lab-1'), 'REMOTE_ROOT_BLOCKED');
  assert.equal(root.sessions[0].closed, 1);
  const arm = await fixture(t, { probeOutput: 'Linux aarch64\n1000\n1000\n' });
  await rejects(arm.service.connect('lab-1'), 'REMOTE_PLATFORM_UNSUPPORTED');
  assert.equal(arm.sessions[0].closed, 1);
  const garbage = await fixture(t, { probeOutput: 'hello' });
  await rejects(garbage.service.connect('lab-1'), 'REMOTE_PROBE_INVALID');
  assert.equal(garbage.sessions[0].closed, 1);
});

test('a failing connect is audited with its code only; a changed host key passes through', async t => {
  const { service, audits } = await fixture(t, { openError: 'REMOTE_HOST_KEY_CHANGED' });
  await rejects(service.connect('lab-1'), 'REMOTE_HOST_KEY_CHANGED');
  const entry = audits.find(item => item.event === 'remote.host.connect_failed');
  assert.deepEqual([entry.hostId, entry.code], ['lab-1', 'REMOTE_HOST_KEY_CHANGED']);
});

test('audit entries never contain the key, the passphrase or key text', async t => {
  const { service, audits } = await fixture(t, { probeOutput: 'Linux x86_64\n0\n0\n' });
  await service.trustHostKey('lab-1', PINNED);
  await service.connect('lab-1').catch(() => {});
  const text = JSON.stringify(audits);
  assert.ok(!text.includes('BEGIN') && !text.includes('key phrase') && !text.includes(PEM.slice(40, 80)));
  assert.ok(audits.length >= 2);
});

test('createHost and removeHost are audited; the subject resolver knows only existing hosts', async t => {
  const { service, store, audits } = await fixture(t);
  const created = await service.createHost({ id: 'lab-2', label: 'Second', host: 'two.example.org', port: 2222, username: 'cod4x' });
  assert.equal(created.id, 'lab-2');
  assert.ok(audits.some(entry => entry.event === 'remote.host.created' && entry.hostId === 'lab-2'));
  const resolve = sshSubjectResolver({ hosts: store, dataRoot: '/data' });
  assert.deepEqual(resolve('ssh_lab-2'), { id: 'ssh_lab-2', homePath: path.join(path.resolve('/data'), 'ssh-hosts', 'lab-2'), createdAt: store.get('lab-2').createdAt });
  assert.throws(() => resolve('ssh_nope'), error => error.code === 'REMOTE_HOST_NOT_FOUND');
  assert.throws(() => resolve('server-a'), error => error.code === 'INSTANCE_NOT_FOUND');
  await service.removeHost('lab-2');
  assert.throws(() => resolve('ssh_lab-2'), error => error.code === 'REMOTE_HOST_NOT_FOUND');
  assert.ok(audits.some(entry => entry.event === 'remote.host.removed' && entry.hostId === 'lab-2'));
});
