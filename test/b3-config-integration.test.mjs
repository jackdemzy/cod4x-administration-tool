import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { b3Paths, renderB3Config, renderAuthConfig, prepareB3Runtime } from '../lib/b3-config.mjs';
import { redactB3Config, redactB3PluginAuth } from '../lib/b3-manager.mjs';

async function home(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-b3-config-integration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { id: 'b3i', port: 28960, homePath: root };
}
const mode = async file => (await fs.stat(file)).mode & 0o777;

test('b3.xml carries the escaped rcon password and the auth entry only when asked', () => {
  const paths = b3Paths({ homePath: '/srv/b3i' });
  const withAuth = renderB3Config({ instance: { port: 28960 }, paths, gameLog: '/srv/b3i/main/games_mp.log', rconPassword: 's3cr&t', authConfigPath: paths.authConfig });
  assert.match(withAuth, /<set name="rcon_password">s3cr&amp;t<\/set>/);
  assert.ok(withAuth.includes(`<plugin name="auth" config="${paths.authConfig.replace(/&/g, '&amp;')}"/>`));
  assert.ok(withAuth.indexOf('name="admin"') < withAuth.indexOf('name="auth"'));
  const plain = renderB3Config({ instance: { port: 28960 }, paths, gameLog: '/srv/b3i/main/games_mp.log' });
  assert.match(plain, /<set name="rcon_password"><\/set>/);
  assert.ok(!plain.includes('name="auth"'));
  assert.equal(paths.authConfig, path.join('/srv/b3i', 'b3', 'plugin_auth.ini'));
});

test('plugin_auth.ini has the auth command, the default messages and passwords only when set', () => {
  const ini = renderAuthConfig({ passwords: { 100: 'hunter22', 20: 'mod-pass' } });
  assert.match(ini, /^\[commands\]\nauth: 0$/m);
  assert.match(ini, /^auth_message: \^7Please authenticate yourself with \^1!auth <password>$/m);
  assert.match(ini, /^no_password: \^1Missing password!\^7 Usage: !auth <password>$/m);
  assert.match(ini, /^\[passwords\]\n20: mod-pass\n100: hunter22$/m);
  assert.ok(!renderAuthConfig({ passwords: {} }).includes('[passwords]'));
});

test('prepareB3Runtime writes both files 0600 and removes a stale auth config', async t => {
  const instance = await home(t);
  const prepared = await prepareB3Runtime(instance, 'games_mp.log', { rconPassword: 'Rcon-Pass-1', auth: { passwords: { 100: 'hunter22' } } });
  assert.match(await fs.readFile(prepared.config, 'utf8'), /Rcon-Pass-1/);
  assert.match(await fs.readFile(prepared.authConfig, 'utf8'), /100: hunter22/);
  assert.match(prepared.authFingerprint, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') {
    assert.equal(await mode(prepared.config), 0o600);
    assert.equal(await mode(prepared.authConfig), 0o600);
  }
  const again = await prepareB3Runtime(instance, 'games_mp.log', { rconPassword: 'Rcon-Pass-1', auth: null });
  await assert.rejects(fs.stat(again.authConfig), { code: 'ENOENT' });
  assert.equal(again.authFingerprint, null);
});

test('the config views redact the rcon password and the auth passwords', () => {
  const xml = renderB3Config({ instance: { port: 1 }, paths: b3Paths({ homePath: '/x' }), gameLog: '/x/main/g.log', rconPassword: 'Rcon-Pass-1' });
  assert.ok(!redactB3Config(xml).includes('Rcon-Pass-1'));
  const shown = redactB3PluginAuth(renderAuthConfig({ passwords: { 100: 'hunter22' } }));
  assert.ok(!shown.includes('hunter22'));
  assert.match(shown, /^100: \[redacted\]$/m);
  assert.match(shown, /^auth: 0$/m);
});

test('CodeQL: the returned fingerprints never derive from a password (non-secret inputs only)', async t => {
  const instance = await home(t);
  const one = await prepareB3Runtime(instance, 'games_mp.log', { rconPassword: 'Rcon-Pass-1', auth: { passwords: { 100: 'hunter22' } } });
  const two = await prepareB3Runtime(instance, 'games_mp.log', { rconPassword: 'Rcon-Pass-2', auth: { passwords: { 100: 'other-pass' } } });
  assert.match(one.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(one.sha256, undefined, 'no value claims to be a content hash of b3.xml');
  assert.equal(one.fingerprint, two.fingerprint, 'b3.xml fingerprint does not follow the RCON password');
  assert.equal(one.authFingerprint, two.authFingerprint, 'plugin_auth.ini fingerprint does not follow the !auth password');
  assert.notEqual(one.fingerprint, one.authFingerprint, 'each file has its own fingerprint');
  const withoutAuth = await prepareB3Runtime(instance, 'games_mp.log', { rconPassword: 'Rcon-Pass-1', auth: null });
  assert.notEqual(withoutAuth.fingerprint, one.fingerprint, 'the auth entry still changes the b3.xml fingerprint');
  const withoutRcon = await prepareB3Runtime(instance, 'games_mp.log', { auth: { passwords: { 100: 'hunter22' } } });
  assert.equal(withoutRcon.authFingerprint, one.authFingerprint, 'plugin_auth.ini fingerprint does not follow b3.xml-only inputs');
  const dsn = password => prepareB3Runtime(instance, 'games_mp.log', { databaseDsn: `mysql://b3:${password}@127.0.0.1:3306/b3`, rconPassword: 'Rcon-Pass-1' });
  const mysql = await dsn('db-pass-1');
  assert.equal(mysql.fingerprint, (await dsn('db-pass-2')).fingerprint, 'b3.xml fingerprint does not follow the database password');
  assert.notEqual(mysql.fingerprint, withoutAuth.fingerprint, 'MySQL instead of SQLite changes the b3.xml fingerprint');
});
