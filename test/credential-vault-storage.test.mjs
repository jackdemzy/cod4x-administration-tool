import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CredentialVaultStorage } from '../lib/credential-vault-storage.mjs';

const password = 'Disposable storage test passphrase!';

test('unlocked update creates encrypted backup, verifies persisted content and restores without passphrase retention', () => fixture(async (root, vault) => {
  const original = Buffer.from('original-test-secret');
  const changed = Buffer.from('changed-test-secret');
  await vault.initialize(original, password);
  const before = await vault.snapshot();
  await assert.rejects(vault.update(changed, before.sha256), { code: 'VAULT_LOCKED' });
  await vault.unlock(password);
  const applied = await vault.update(changed, before.sha256);
  assert.equal(applied.verified, true);
  assert.notEqual(applied.sha256, before.sha256);
  assert.deepEqual(vault.readUnlocked(), changed);
  const backup = await fs.readFile(path.join(root, 'credential-vault', 'backup-' + applied.backupId + '.json'), 'utf8');
  assert.ok(!backup.includes(original.toString())); assert.ok(!backup.includes(password));
  const staleFile = await fs.readFile(path.join(root, 'credential-vault', 'vault.json'), 'utf8');
  await assert.rejects(vault.update(original, before.sha256), { code: 'VAULT_CONFLICT' });
  assert.equal(await fs.readFile(path.join(root, 'credential-vault', 'vault.json'), 'utf8'), staleFile);
  const restored = await vault.restore(applied.backupId, applied.sha256);
  assert.equal(restored.verified, true);
  assert.deepEqual(vault.readUnlocked(), original);
  vault.lock();
  const restarted = new CredentialVaultStorage(root);
  await restarted.unlock(password);
  assert.deepEqual(restarted.readUnlocked(), original);
  restarted.lock();
}));

test('external file changes invalidate the unlocked snapshot and cannot be overwritten', () => fixture(async (root, vault) => {
  await vault.initialize(Buffer.from('first-secret'), password);
  await vault.unlock(password);
  const before = await vault.snapshot();
  const second = new CredentialVaultStorage(root);
  await second.unlock(password);
  await second.update(Buffer.from('external-secret'), before.sha256);
  const external = await fs.readFile(path.join(root, 'credential-vault', 'vault.json'), 'utf8');
  await assert.rejects(vault.update(Buffer.from('stale-secret'), before.sha256), { code: 'VAULT_CONFLICT' });
  assert.equal(await fs.readFile(path.join(root, 'credential-vault', 'vault.json'), 'utf8'), external);
  vault.lock(); second.lock();
}));

test('invalid or corrupt restore and an existing operation lock do not mutate the current file', () => fixture(async (root, vault) => {
  await vault.initialize(Buffer.from('original-secret'), password);
  await vault.unlock(password);
  const before = await vault.snapshot();
  const applied = await vault.update(Buffer.from('new-secret'), before.sha256);
  const file = path.join(root, 'credential-vault', 'vault.json');
  const current = await fs.readFile(file, 'utf8');
  await assert.rejects(vault.restore('../vault', applied.sha256), { code: 'VAULT_FILE_INVALID' });
  await fs.writeFile(path.join(root, 'credential-vault', 'backup-' + applied.backupId + '.json'), '{"corrupt":"private-value"}', { mode: 0o600 });
  await assert.rejects(vault.restore(applied.backupId, applied.sha256), { code: 'VAULT_INVALID' });
  const lockFile = path.join(root, 'credential-vault', '.operation.lock');
  await fs.writeFile(lockFile, 'test-lock', { mode: 0o600 });
  await assert.rejects(vault.update(Buffer.from('another-secret'), applied.sha256), { code: 'VAULT_OPERATION_BUSY' });
  assert.equal(await fs.readFile(lockFile, 'utf8'), 'test-lock');
  assert.equal(await fs.readFile(file, 'utf8'), current);
  vault.lock();
}));
async function fixture(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-vault-'));
  try { await action(root, new CredentialVaultStorage(root)); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('persistent vault remains locked after recreation, never stores passphrase or plaintext', () => fixture(async (root, vault) => {
  const secret = Buffer.from('disposable-test-credential');
  await vault.initialize(secret, password);
  assert.equal(vault.locked, true);
  assert.throws(() => vault.readUnlocked(), { code: 'VAULT_LOCKED' });
  const file = await fs.readFile(path.join(root, 'credential-vault', 'vault.json'), 'utf8');
  assert.ok(!file.includes(password)); assert.ok(!file.includes(secret.toString()));
  await vault.unlock(password);
  assert.deepEqual(vault.readUnlocked(), secret);
  const copy = vault.readUnlocked(); copy.fill(0);
  assert.deepEqual(vault.readUnlocked(), secret);
  const restarted = new CredentialVaultStorage(root);
  assert.equal(restarted.locked, true);
  await assert.rejects(restarted.unlock('Wrong disposable password!'), { code: 'VAULT_UNLOCK_FAILED' });
  assert.equal(restarted.locked, true);
  await restarted.unlock(password);
  assert.deepEqual(restarted.readUnlocked(), secret);
  restarted.lock(); vault.lock();
  assert.throws(() => restarted.readUnlocked(), { code: 'VAULT_LOCKED' });
  await assert.rejects(vault.initialize(secret, password), { code: 'VAULT_EXISTS' });
  assert.equal(await fs.readFile(path.join(root, 'credential-vault', 'vault.json'), 'utf8'), file);
}));

test('unsafe hardlinked and corrupted files cannot unlock a vault', () => fixture(async (root, vault) => {
  await vault.initialize(Buffer.from('test-content'), password);
  const file = path.join(root, 'credential-vault', 'vault.json');
  const alias = path.join(root, 'alias.json');
  await fs.link(file, alias);
  await assert.rejects(vault.unlock(password), { code: 'VAULT_FILE_INVALID' });
  await fs.unlink(alias);
  await fs.writeFile(file, '{"private":"corrupted-secret"}', { mode: 0o600 });
  await assert.rejects(vault.unlock(password), { code: 'VAULT_INVALID' });
  assert.equal(vault.locked, true);
}));

test('lock during asynchronous unlock cancels publication and competing operations are rejected', () => fixture(async (root, vault) => {
  await vault.initialize(Buffer.from('test-content'), password);
  const operation = vault.unlock(password);
  await assert.rejects(vault.unlock(password), { code: 'VAULT_OPERATION_BUSY' });
  vault.lock();
  await assert.rejects(operation, { code: 'VAULT_LOCKED' });
  assert.equal(vault.locked, true);
  assert.throws(() => vault.readUnlocked(), { code: 'VAULT_LOCKED' });
}));

test('Linux rejects permissive vault directories and files', { skip: process.platform !== 'linux' }, () => fixture(async (root, vault) => {
  await vault.initialize(Buffer.from('test-content'), password);
  const directory = path.join(root, 'credential-vault');
  const file = path.join(directory, 'vault.json');
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.chmod(file, 0o644);
  await assert.rejects(vault.unlock(password), { code: 'VAULT_FILE_INVALID' });
  await fs.chmod(file, 0o600); await fs.chmod(directory, 0o755);
  await assert.rejects(vault.unlock(password), { code: 'VAULT_FILE_INVALID' });
}));
