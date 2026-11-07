import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { InstanceCredentialService } from '../lib/instance-credential-service.mjs';

const passphrase = 'Disposable remote vault passphrase!';
const SUBJECT = 'ssh_lab-1';
const key = () => ssh2.utils.generateKeyPairSync('ed25519').private;
const secret = (privateKey, extra = {}) => JSON.stringify({ privateKey, ...extra });
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code, code);

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-remote-vault-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resolveInstance = id => {
    if (!['server-a', SUBJECT, 'ssh_lab-2'].includes(id)) throw Object.assign(new Error('Missing test subject'), { code: 'INSTANCE_NOT_FOUND' });
    return { id, homePath: path.join(root, 'servers', id), createdAt: '2026-10-04T10:00:00.000Z' };
  };
  const service = new InstanceCredentialService({ dataRoot: root, resolveInstance, ...options });
  await service.initialize(passphrase); await service.unlock(passphrase);
  const set = async (id, kind, value) => service.set(id, kind, { value, expectedSha256: (await service.status()).sha256 });
  return { service, set };
}

test('ssh is accepted only for ssh_ subjects, and only ssh is accepted for them', async t => {
  const { service, set } = await fixture(t);
  await set(SUBJECT, 'ssh', secret(key()));
  assert.equal((await service.instanceStatus(SUBJECT)).ssh.configured, true);
  await rejects(set('server-a', 'ssh', secret(key())), 'CREDENTIAL_INVALID');
  for (const kind of ['rcon', 'master', 'join', 'b3db', 'b3auth']) await rejects(set(SUBJECT, kind, 'Some-Value-123!'), 'CREDENTIAL_INVALID');
  // a normal instance keeps exactly its old status shape
  assert.deepEqual(Object.keys(await service.instanceStatus('server-a')).sort(), ['b3auth', 'b3db', 'digest', 'initialized', 'join', 'locked', 'master', 'rcon', 'sha256']);
  assert.deepEqual(Object.keys(await service.instanceStatus(SUBJECT)).sort(), ['digest', 'initialized', 'locked', 'sha256', 'ssh']);
});

test('ssh values are validated: key header, size, extra fields, passphrase characters', async t => {
  const { set } = await fixture(t);
  const good = key();
  const header = '-----BEGIN OPENSSH PRIVATE KEY-----\n', footer = '\n-----END OPENSSH PRIVATE KEY-----\n';
  const bad = [
    'not json', '[]', 'null', secret(5), secret('just text'), secret('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n'),
    secret(`${header}${'A'.repeat(16400)}${footer}`),
    secret(good, { extra: 'x' }), secret(good, { passphrase: 5 }), secret(good, { passphrase: '' }), secret(good, { passphrase: 'a\nb' }),
    secret(good, { passphrase: 'x'.repeat(257) }), JSON.stringify({ passphrase: 'abc' }),
  ];
  for (const value of bad) await rejects(set(SUBJECT, 'ssh', value), 'CREDENTIAL_INVALID');
  await set(SUBJECT, 'ssh', secret(good, { passphrase: 'a perfectly fine passphrase' }));
  // PEM variants are accepted too
  await set('ssh_lab-2', 'ssh', secret('-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123456789ABCDEF\n\nQUJD\n-----END RSA PRIVATE KEY-----\n'));
});

test('the ssh secret is returned as separate buffers only inside a runtime scope and wiped afterwards', async t => {
  const { service, set } = await fixture(t);
  const pem = key();
  await set(SUBJECT, 'ssh', secret(pem, { passphrase: 'phrase for the key' }));
  await set('ssh_lab-2', 'ssh', secret(key()));
  let seen;
  const result = await service.withRuntimeCredentials(SUBJECT, async (credentials, signal) => {
    seen = credentials;
    assert.equal(signal.aborted, false);
    assert.deepEqual(Object.keys(credentials).sort(), ['passphrase', 'privateKey']);
    assert.equal(credentials.privateKey.toString(), pem);
    assert.equal(credentials.passphrase.toString(), 'phrase for the key');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.ok(seen.privateKey.every(byte => byte === 0) && seen.passphrase.every(byte => byte === 0), 'both buffers are wiped');
  // without a stored passphrase the field is null; another host never sees this key
  await service.withRuntimeCredentials('ssh_lab-2', async credentials => { assert.equal(credentials.passphrase, null); assert.notEqual(credentials.privateKey.toString(), pem); });
  // a host with nothing stored has null for both
  await service.remove('ssh_lab-2', 'ssh', { expectedSha256: (await service.status()).sha256 });
  await service.withRuntimeCredentials('ssh_lab-2', async credentials => assert.deepEqual([credentials.privateKey, credentials.passphrase], [null, null]));
});

test('there is no generic read of an ssh secret, and no value in the status', async t => {
  const { service, set } = await fixture(t);
  const pem = key();
  await set(SUBJECT, 'ssh', secret(pem, { passphrase: 'phrase for the key' }));
  await rejects(service.resolve(SUBJECT, 'ssh'), 'CREDENTIAL_INVALID');
  const text = JSON.stringify(await service.instanceStatus(SUBJECT));
  assert.ok(!text.includes('BEGIN') && !text.includes('phrase for the key') && !text.includes(pem.slice(40, 80)));
});

test('subject ids: ssh_ plus a host id; nothing else with an underscore', async t => {
  const { set } = await fixture(t);
  for (const id of ['ssh_', 'ssh_Lab', 'ssh_lab_1', 'ssh_1lab', 'x_lab', `ssh_${'a'.repeat(41)}`]) await rejects(set(id, 'ssh', secret(key())), 'CREDENTIAL_INVALID');
});

test('a change to the ssh key is a change of the subject digest, and removal works', async t => {
  const { service, set } = await fixture(t);
  await set(SUBJECT, 'ssh', secret(key()));
  const before = (await service.instanceStatus(SUBJECT)).digest;
  await set(SUBJECT, 'ssh', secret(key()));
  const after = (await service.instanceStatus(SUBJECT)).digest;
  assert.notEqual(before, after);
  await service.remove(SUBJECT, 'ssh', { expectedSha256: (await service.status()).sha256 });
  assert.equal((await service.instanceStatus(SUBJECT)).ssh.configured, false);
});
