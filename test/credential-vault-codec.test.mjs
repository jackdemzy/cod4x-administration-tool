import test from 'node:test';
import assert from 'node:assert/strict';
import { sealVault, openVault, openVaultSession } from '../lib/credential-vault-codec.mjs';

const passphrase = 'Disposable test passphrase only!';
const content = Buffer.from('disposable-rcon-credential');

test('unlocked session encrypts updates without a retained passphrase and destroys its key on lock', async () => {
  const original = await sealVault(content, passphrase);
  const session = await openVaultSession(original, passphrase);
  const next = session.seal(Buffer.from('changed-test-credential'));
  assert.equal(next.salt, original.salt);
  assert.notEqual(next.nonce, original.nonce);
  assert.deepEqual(session.open(next), Buffer.from('changed-test-credential'));
  assert.deepEqual(await openVault(next, passphrase), Buffer.from('changed-test-credential'));
  assert.equal(JSON.stringify(session), '{}');
  session.destroy(); session.destroy();
  assert.throws(() => session.open(next), { code: 'VAULT_LOCKED' });
  assert.throws(() => session.seal(content), { code: 'VAULT_LOCKED' });
});

test('vault envelope hides plaintext and requires the separate passphrase after recreation', async () => {
  const sealed = await sealVault(content, passphrase);
  assert.ok(!JSON.stringify(sealed).includes(content.toString()));
  assert.ok(!JSON.stringify(sealed).includes(passphrase));
  assert.deepEqual(await openVault(JSON.parse(JSON.stringify(sealed)), passphrase), content);
  await assert.rejects(openVault(sealed, 'Wrong disposable passphrase!'), { code: 'VAULT_UNLOCK_FAILED' });
});

test('vault uses fresh salt and nonce and rejects changed authenticated ciphertext', async () => {
  const first = await sealVault(content, passphrase);
  const second = await sealVault(content, passphrase);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
  const bytes = Buffer.from(first.ciphertext, 'base64');
  bytes[0] ^= 1;
  await assert.rejects(openVault({ ...first, ciphertext: bytes.toString('base64') }, passphrase), { code: 'VAULT_UNLOCK_FAILED' });
  await assert.rejects(openVault({ ...first, version: 2 }, passphrase), { code: 'VAULT_INVALID' });
  await assert.rejects(openVault({ ...first, salt: 'bad' }, passphrase), { code: 'VAULT_INVALID' });
});

test('vault rejects empty or excessive inputs without exposing their contents', async () => {
  await assert.rejects(sealVault(content, ''), { code: 'VAULT_PASSPHRASE_INVALID' });
  await assert.rejects(sealVault(Buffer.alloc(65537), passphrase), { code: 'VAULT_INVALID' });
  await assert.rejects(openVault({ version: 1, ciphertext: 'private-invalid-value' }, passphrase), error => {
    assert.equal(error.code, 'VAULT_INVALID');
    assert.ok(!error.message.includes('private-invalid-value'));
    return true;
  });
});
