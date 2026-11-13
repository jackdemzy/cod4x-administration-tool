import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// Release review 4.18.30 (R-1 to R-3): the production backup (4.16.x) holds policy, profiles and the
// user accounts. Restoring it is a config.manage route, so an operator could roll back user accounts
// (roles, passwords, second factors, disabled flags), which only user.manage may change.
import { backend, password } from './support/security-backend.mjs';

async function setup(t) {
  const api = await backend(t);
  const { call } = api;
  const admin = (await call('/api/auth/init', { body: { username: 'owner', password: password() } })).json.token;
  const secret = password();
  assert.equal((await call('/api/users', { body: { username: 'helper', password: secret, role: 'admin' }, token: admin })).status, 201);
  return { ...api, admin, secret, usersFile: path.join(api.root, 'data', 'config', 'users.json') };
}
const roleOf = async (call, admin, username) => (await call('/api/users', { token: admin })).json.users.find(user => user.username === username)?.role;

test('R-1: an operator cannot roll back user accounts through a backup restore', { timeout: 60000 }, async t => {
  const { call, admin, secret, usersFile } = await setup(t);
  const backup = (await call('/api/backups/create', { body: { label: 'helper is admin' }, token: admin })).json.backup;
  assert.equal((await call('/api/users/helper', { method: 'PATCH', body: { role: 'operator' }, token: admin })).status, 200);
  const before = await fs.readFile(usersFile, 'utf8');
  const operator = (await call('/api/auth/login', { body: { username: 'helper', password: secret } })).json.token;
  const refused = await call(`/api/backups/${backup.id}/restore`, { body: {}, token: operator });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, 'BACKUP_RESTORE_USERS_FORBIDDEN');
  assert.equal(await fs.readFile(usersFile, 'utf8'), before, 'users.json is untouched');
  assert.equal(await roleOf(call, admin, 'helper'), 'operator');
});

test('R-1: an operator may restore a backup whose user accounts equal the current ones', { timeout: 60000 }, async t => {
  const { call, admin, secret } = await setup(t);
  assert.equal((await call('/api/users/helper', { method: 'PATCH', body: { role: 'operator' }, token: admin })).status, 200);
  const backup = (await call('/api/backups/create', { body: { label: 'current' }, token: admin })).json.backup;
  const operator = (await call('/api/auth/login', { body: { username: 'helper', password: secret } })).json.token;
  const restored = await call(`/api/backups/${backup.id}/restore`, { body: {}, token: operator });
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.equal((await call('/api/instances', { token: operator })).status, 200, 'unchanged accounts keep their sessions');
});

test('R-2: an administrator restore takes effect at once and ends the sessions of changed accounts', { timeout: 60000 }, async t => {
  const { call, admin, secret, usersFile } = await setup(t);
  const backup = (await call('/api/backups/create', { body: { label: 'helper is admin' }, token: admin })).json.backup;
  assert.equal((await call('/api/users/helper', { method: 'PATCH', body: { role: 'viewer' }, token: admin })).status, 200);
  const viewer = (await call('/api/auth/login', { body: { username: 'helper', password: secret } })).json.token;
  assert.equal((await call('/api/instances', { token: viewer })).status, 200);
  const restored = await call(`/api/backups/${backup.id}/restore`, { body: {}, token: admin });
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.equal(await roleOf(call, admin, 'helper'), 'admin', 'the restored accounts are active without a restart');
  assert.equal((await call('/api/instances', { token: viewer })).status, 401, 'a session of a changed account ends');
  assert.equal((await call('/api/instances', { token: admin })).status, 200, 'an unchanged account keeps its session');
  // R-3: users.json holds password hashes and TOTP secrets.
  if (process.platform !== 'win32') assert.equal((await fs.stat(usersFile)).mode & 0o777, 0o600);
});

test('R-1: a backup without an enabled administrator is not restored', { timeout: 60000 }, async t => {
  const { call, admin, root } = await setup(t);
  const backup = (await call('/api/backups/create', { body: { label: 'x' }, token: admin })).json.backup;
  // Rewrite the stored backup so that every account is disabled, with a matching hash in the registry.
  const crypto = await import('node:crypto');
  const registryFile = path.join(root, 'data', 'config', 'production-backups.json');
  const registry = JSON.parse(await fs.readFile(registryFile, 'utf8'));
  const meta = registry.backups.find(item => item.id === backup.id);
  const raw = JSON.parse(await fs.readFile(meta.file, 'utf8'));
  const users = JSON.parse(raw.payload.users);
  for (const user of users.users) user.disabled = true;
  raw.payload.users = JSON.stringify(users);
  raw.sha256 = meta.sha256 = crypto.createHash('sha256').update(JSON.stringify(raw.payload), 'utf8').digest('hex');
  await fs.writeFile(meta.file, JSON.stringify(raw));
  await fs.writeFile(registryFile, JSON.stringify(registry));
  const refused = await call(`/api/backups/${backup.id}/restore`, { body: {}, token: admin });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'BACKUP_RESTORE_NO_ADMIN');
  assert.equal((await call('/api/instances', { token: admin })).status, 200);
});

test('R-4: the release backend serves no test client page', { timeout: 60000 }, async t => {
  const { url } = await backend(t);
  const response = await fetch(`${url}/session-test`);
  assert.equal(response.status, 404);
});

test('R-5: workflows do not keep the GitHub token in the checkout', async () => {
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const text = await fs.readFile(file, 'utf8');
    const checkouts = text.split('uses: actions/checkout@').length - 1;
    assert.ok(checkouts > 0, file);
    assert.equal(text.split('persist-credentials: false').length - 1, checkouts, `${file}: every checkout sets persist-credentials: false`);
  }
});
