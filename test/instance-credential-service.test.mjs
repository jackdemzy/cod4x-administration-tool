import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InstanceCredentialService } from '../lib/instance-credential-service.mjs';

const passphrase = 'Disposable service passphrase!';

test('runtime credential scope isolates one instance and wipes supplied buffers on completion', () => fixture(async service => {
  await service.initialize(passphrase); await service.unlock(passphrase);
  let snapshot = await service.status();
  snapshot = await service.set('server-a', 'rcon', { value: 'Scoped-Rcon-123!', expectedSha256: snapshot.sha256 });
  snapshot = await service.set('server-a', 'join', { value: 'Scoped-Join-123!', expectedSha256: snapshot.sha256 });
  await service.set('server-b', 'master', { value: 'A'.repeat(32), expectedSha256: snapshot.sha256 });
  let supplied;
  assert.equal(await service.withRuntimeCredentials('server-a', async (credentials, signal) => {
    supplied = credentials;
    assert.equal(signal.aborted, false);
    assert.equal(credentials.rcon.toString(), 'Scoped-Rcon-123!');
    assert.equal(credentials.join.toString(), 'Scoped-Join-123!');
    assert.equal(credentials.master, null);
    return 'completed';
  }), 'completed');
  assert.ok(supplied.rcon.every(value => value === 0));
  assert.ok(supplied.join.every(value => value === 0));
  service.lock();
}));

test('lock aborts an active runtime credential scope and wipes it before returning', () => fixture(async service => {
  await service.initialize(passphrase); await service.unlock(passphrase);
  await service.set('server-a', 'join', { value: 'Scoped-Join-123!', expectedSha256: (await service.status()).sha256 });
  await assert.rejects(service.withRuntimeCredentials('server-a', async (credentials, signal) => {
    signal.addEventListener('abort', () => assert.ok(credentials.join.every(value => value === 0)), { once: true });
    service.lock();
    assert.equal(signal.aborted, true);
    assert.ok(credentials.join.every(value => value === 0));
    return 'must-not-succeed';
  }), { code: 'VAULT_LOCKED' });
  await assert.rejects(service.withRuntimeCredentials('server-a', () => assert.fail('Locked scope must not call consumer')), { code: 'VAULT_LOCKED' });
}));

test('runtime scope wipes buffers on consumer failure and refuses concurrent vault mutations', () => fixture(async service => {
  await service.initialize(passphrase); await service.unlock(passphrase);
  const current = await service.set('server-a', 'rcon', { value: 'Scoped-Rcon-123!', expectedSha256: (await service.status()).sha256 });
  let supplied;
  await assert.rejects(service.withRuntimeCredentials('server-a', async credentials => {
    supplied = credentials.rcon;
    await assert.rejects(service.remove('server-a', 'rcon', { expectedSha256: current.sha256 }), { code: 'VAULT_OPERATION_BUSY' });
    throw Object.assign(new Error('CONTROLLED_CONSUMER_FAILURE'), { code: 'CONTROLLED_CONSUMER_FAILURE' });
  }), { code: 'CONTROLLED_CONSUMER_FAILURE' });
  assert.ok(supplied.every(value => value === 0));
  assert.equal((await service.instanceStatus('server-a')).rcon.configured, true);
  service.lock();
}));

test('runtime scope detects identity replacement during consumption and releases buffers', () => fixture(async (service, root, resolveInstance, births) => {
  await service.initialize(passphrase); await service.unlock(passphrase);
  await service.set('server-a', 'rcon', { value: 'Scoped-Rcon-123!', expectedSha256: (await service.status()).sha256 });
  let supplied;
  await assert.rejects(service.withRuntimeCredentials('server-a', async credentials => {
    supplied = credentials.rcon;
    births.set('server-a', '2026-10-15T10:00:00.000Z');
  }), { code: 'VAULT_CONFLICT' });
  assert.ok(supplied.every(value => value === 0));
  service.lock();
}));

test('runtime scope rejects an externally replaced vault before reporting successful transfer', () => fixture(async (service, root) => {
  await service.initialize(passphrase); await service.unlock(passphrase);
  await service.set('server-a', 'rcon', { value: 'Scoped-Rcon-123!', expectedSha256: (await service.status()).sha256 });
  let supplied;
  const file = path.join(root, 'credential-vault', 'vault.json');
  await assert.rejects(service.withRuntimeCredentials('server-a', async credentials => {
    supplied = credentials.rcon;
    // Valid envelope bytes with a changed file snapshot must still conflict.
    await fs.appendFile(file, '\n');
  }), { code: 'VAULT_CONFLICT' });
  assert.ok(supplied.every(value => value === 0));
  assert.equal((await service.status()).locked, true);
}));
test('conflict self-lock from a concurrent reader aborts and wipes the active runtime scope immediately', () => fixture(async (service, root) => {
  await service.initialize(passphrase); await service.unlock(passphrase);
  await service.set('server-a', 'rcon', { value: 'Scoped-Rcon-123!', expectedSha256: (await service.status()).sha256 });
  const file = path.join(root, 'credential-vault', 'vault.json');
  let supplied, abortedBeforeReturn = false, wipedBeforeReturn = false;
  await assert.rejects(service.withRuntimeCredentials('server-a', async (credentials, signal) => {
    supplied = credentials.rcon;
    await fs.appendFile(file, '\n');
    // A metadata reader outside the exclusive scope detects the replaced vault.
    await assert.rejects(service.instanceStatus('server-a'), { code: 'VAULT_CONFLICT' });
    abortedBeforeReturn = signal.aborted;
    wipedBeforeReturn = credentials.rcon.every(value => value === 0);
    return 'must-not-succeed';
  }), { code: 'VAULT_LOCKED' });
  assert.equal(abortedBeforeReturn, true);
  assert.equal(wipedBeforeReturn, true);
  assert.ok(supplied.every(value => value === 0));
  assert.equal((await service.status()).locked, true);
}));

async function fixture(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-credential-service-'));
  const births = new Map([['server-a', '2026-10-04T10:00:00.000Z'], ['server-b', '2026-10-04T10:00:01.000Z']]);
  const resolveInstance = id => {
    if (!['server-a', 'server-b'].includes(id)) throw Object.assign(new Error('Missing test instance'), { code: 'INSTANCE_NOT_FOUND' });
    return { id, homePath: path.join(root, 'servers', id), createdAt: births.get(id) };
  };
  try { await action(new InstanceCredentialService({ dataRoot: root, resolveInstance }), root, resolveInstance, births); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('credential service isolates instances and returns only metadata, survives encrypted restart and removal', () => fixture(async (service, root, resolveInstance) => {
  assert.deepEqual(await service.status(), { initialized: false, locked: true, sha256: null });
  await service.initialize(passphrase);
  assert.equal((await service.instanceStatus('server-a')).rcon.configured, null);
  await service.unlock(passphrase);
  const before = await service.status();
  const secret = 'Disposable-Rcon-123!';
  const applied = await service.set('server-a', 'rcon', { value: secret, expectedSha256: before.sha256 });
  assert.equal(applied.verified, true);
  const metadata = await service.instanceStatus('server-a');
  assert.equal(metadata.rcon.configured, true);
  assert.equal(metadata.master.configured, false);
  assert.ok(!JSON.stringify(metadata).includes(secret));
  assert.equal((await service.instanceStatus('server-b')).rcon.configured, false);
  const resolved = await service.resolve('server-a', 'rcon');
  assert.equal(resolved.toString(), secret); resolved.fill(0);
  await assert.rejects(service.resolve('server-b', 'rcon'), { code: 'CREDENTIAL_NOT_CONFIGURED' });
  const stored = await fs.readFile(path.join(root, 'credential-vault', 'vault.json'), 'utf8');
  assert.ok(!stored.includes(secret));
  const restarted = new InstanceCredentialService({ dataRoot: root, resolveInstance });
  assert.equal((await restarted.status()).locked, true);
  await assert.rejects(restarted.resolve('server-a', 'rcon'), { code: 'VAULT_LOCKED' });
  await restarted.unlock(passphrase);
  assert.equal((await restarted.instanceStatus('server-a')).rcon.referenceId, metadata.rcon.referenceId);
  const removed = await restarted.remove('server-a', 'rcon', { expectedSha256: applied.sha256 });
  assert.equal(removed.verified, true);
  assert.equal((await restarted.instanceStatus('server-a')).rcon.configured, false);
  restarted.lock(); service.lock();
}));

test('recreated instance with a reused display ID cannot inherit archived credentials', () => fixture(async (service, root, resolveInstance, births) => {
  await service.initialize(passphrase); await service.unlock(passphrase);
  const before = await service.status();
  await service.set('server-a', 'rcon', { value: 'Archived-Secret-123!', expectedSha256: before.sha256 });
  births.set('server-a', '2026-10-04T11:00:00.000Z');
  assert.equal((await service.instanceStatus('server-a')).rcon.configured, false);
  await assert.rejects(service.resolve('server-a', 'rcon'), { code: 'CREDENTIAL_NOT_CONFIGURED' });
  service.lock();
}));

test('credential mutations reject unsupported kinds, invalid values, unknown instances and stale snapshots', () => fixture(async service => {
  await service.initialize(passphrase); await service.unlock(passphrase);
  const before = await service.status();
  for (const [kind, value] of [['unknown', 'private-value'], ['rcon', 'short'], ['rcon', 'secret;quit'], ['master', 'not-a-32-character-token']]) {
    await assert.rejects(service.set('server-a', kind, { value, expectedSha256: before.sha256 }), error => {
      assert.equal(error.code, 'CREDENTIAL_INVALID'); assert.ok(!error.message.includes(value)); return true;
    });
  }
  await assert.rejects(service.set('missing', 'rcon', { value: 'Disposable-123!', expectedSha256: before.sha256 }), { code: 'INSTANCE_NOT_FOUND' });
  const applied = await service.set('server-a', 'rcon', { value: 'Disposable-123!', expectedSha256: before.sha256 });
  await assert.rejects(service.set('server-b', 'rcon', { value: 'Disposable-456!', expectedSha256: before.sha256 }), { code: 'VAULT_CONFLICT' });
  assert.equal((await service.status()).sha256, applied.sha256);
  assert.equal((await service.instanceStatus('server-b')).rcon.configured, false);
  service.lock();
}));

test('b3db accepts a DB password and rejects @', () => fixture(async service => {
  await service.initialize(passphrase); await service.unlock(passphrase);
  let snapshot = await service.status();
  for (const value of ['pass@word1', 'pass word1', 'short']) {
    await assert.rejects(service.set('server-a', 'b3db', { value, expectedSha256: snapshot.sha256 }), error => {
      assert.equal(error.code, 'CREDENTIAL_INVALID'); assert.ok(!error.message.includes(value)); return true;
    });
  }
  snapshot = await service.set('server-a', 'b3db', { value: 'Db-Pass:/x+1', expectedSha256: snapshot.sha256 });
  const status = await service.instanceStatus('server-a');
  assert.equal(status.b3db.configured, true);
  assert.ok(!JSON.stringify(status).includes('Db-Pass'));
  service.lock();
}));

test('b3db is returned in the runtime credential scope and wiped afterwards', () => fixture(async service => {
  await service.initialize(passphrase); await service.unlock(passphrase);
  await service.set('server-a', 'b3db', { value: 'Db-Pass-123!', expectedSha256: (await service.status()).sha256 });
  let supplied;
  await service.withRuntimeCredentials('server-a', async credentials => { supplied = credentials; assert.equal(credentials.b3db.toString(), 'Db-Pass-123!'); });
  assert.ok(supplied.b3db.every(value => value === 0));
  await service.withRuntimeCredentials('server-b', async credentials => assert.equal(credentials.b3db, null));
  service.lock();
}));

test('decoding an existing vault without b3db still works', () => fixture(async (service, root, resolveInstance) => {
  await service.initialize(passphrase); await service.unlock(passphrase);
  await service.set('server-a', 'rcon', { value: 'Old-Rcon-123!', expectedSha256: (await service.status()).sha256 });
  const restarted = new InstanceCredentialService({ dataRoot: root, resolveInstance });
  await restarted.unlock(passphrase);
  const status = await restarted.instanceStatus('server-a');
  assert.deepEqual([status.rcon.configured, status.b3db.configured], [true, false]);
  restarted.lock(); service.lock();
}));
