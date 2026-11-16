import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CredentialVaultStorage } from '../lib/credential-vault-storage.mjs';
import { isCredentialPath } from '../lib/credential-request.mjs';
import { RELEASE_FUSES, fuseFindings } from '../scripts/release-lib.mjs';

// Issue #67: the three Low findings of audit 4.18.31 (A6-8 Electron fuses, A2-7 vault passphrase
// change, A4-8 game log rotation on remote and Docker homes).
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('A6-8: the release build sets the Electron fuses; RunAsNode is off', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.build.electronFuses, {
    runAsNode: false, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true,
  });
  assert.notEqual(pkg.build.disableAsarIntegrity, true, 'electron-builder embeds the asar hash into the Windows exe');
  assert.equal(RELEASE_FUSES.length, 6);
});

test('A6-8: release-verify reads the fuse wire of the packaged executable', () => {
  const on = 49, off = 48;
  assert.deepEqual(fuseFindings({ version: '1', 0: off, 1: on, 2: off, 3: off, 4: on, 5: on, 6: off, 7: on }), []);
  // the stock Electron binary (all defaults) fails on every security fuse
  const stock = fuseFindings({ version: '1', 0: on, 1: off, 2: on, 3: on, 4: off, 5: off, 6: off, 7: on });
  assert.equal(stock.length, 6);
  assert.match(stock[0], /RunAsNode should be off \(wire 49\)/);
  assert.deepEqual(fuseFindings(null), ['fuse wire version 1 not found']);
  assert.match(read('scripts/release-verify.mjs'), /fuseFindings\(await createRequire\(import\.meta\.url\)\('@electron\/fuses'\)\.getCurrentFuseWire\(appExe\)\)/);
});

test('A6-8: the backend runs in a utility process, not as electron + ELECTRON_RUN_AS_NODE', () => {
  const main = read('electron-main.cjs');
  assert.match(main, /server=utilityProcess\.fork\(serverPath,\[\],\{env,/);
  assert.match(main, /delete env\.ELECTRON_RUN_AS_NODE;/);
  assert.doesNotMatch(main, /ELECTRON_RUN_AS_NODE:'1'/);
  assert.doesNotMatch(main, /require\('child_process'\)/);
  // the release installer gate starts the packaged backend this way
  assert.match(main, /const BACKEND_ONLY=process\.argv\.includes\('--cod4x-backend-only'\);/);
  assert.match(read('test/installer-linux.test.mjs'), /args: \['--cod4x-backend-only', '--no-sandbox', '--ozone-platform=headless'\]/);
  assert.match(read('test/installer-windows.test.mjs'), /args: \['--cod4x-backend-only'\]/);
  assert.doesNotMatch(read('test/installer-linux.test.mjs') + read('test/installer-windows.test.mjs'), /ELECTRON_RUN_AS_NODE: '1'/);
});

const oldPass = 'Old disposable vault passphrase!';
const newPass = 'New disposable vault passphrase!';
async function vaultFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-rekey-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = new CredentialVaultStorage(root);
  await vault.initialize(Buffer.from('first-secret'), oldPass);
  await vault.unlock(oldPass);
  return { root, vault, dir: path.join(root, 'credential-vault') };
}
const backups = async dir => (await fs.readdir(dir)).filter(name => name.startsWith('backup-'));

test('A2-7: a new passphrase re-encrypts the vault and deletes every backup under the old key', async t => {
  const { root, vault, dir } = await vaultFixture(t);
  // a removed secret survives in the backup of the change that removed it
  const removed = await vault.update(Buffer.from('second-secret'), (await vault.snapshot()).sha256);
  await vault.update(Buffer.from('third-secret'), removed.sha256);
  assert.equal((await backups(dir)).length, 2);
  const before = await fs.readFile(path.join(dir, 'vault.json'), 'utf8');
  const result = await vault.changePassphrase(oldPass, newPass, (await vault.snapshot()).sha256);
  assert.equal(result.changed, true);
  assert.equal(result.verified, true);
  assert.equal(result.backupsRemoved, 3, 'the two old backups and the copy made before the change');
  assert.deepEqual(await backups(dir), []);
  assert.equal((await fs.readdir(dir)).filter(name => name.startsWith('.vault-')).length, 0, 'no temporary file left');
  const after = await fs.readFile(path.join(dir, 'vault.json'), 'utf8');
  assert.notEqual(JSON.parse(after).salt, JSON.parse(before).salt, 'new salt, new key');
  assert.ok(!after.includes(newPass) && !after.includes('third-secret'));
  // still unlocked, and further changes use the new key
  assert.deepEqual(vault.readUnlocked(), Buffer.from('third-secret'));
  await vault.update(Buffer.from('fourth-secret'), result.sha256);
  vault.lock();
  const restarted = new CredentialVaultStorage(root);
  await assert.rejects(restarted.unlock(oldPass), { code: 'VAULT_UNLOCK_FAILED' });
  await restarted.unlock(newPass);
  assert.deepEqual(restarted.readUnlocked(), Buffer.from('fourth-secret'));
  restarted.lock();
});

test('A2-7: a wrong current passphrase, the same passphrase, a stale hash or a locked vault change nothing', async t => {
  const { vault, dir } = await vaultFixture(t);
  await vault.update(Buffer.from('second-secret'), (await vault.snapshot()).sha256);
  const file = path.join(dir, 'vault.json');
  const before = await fs.readFile(file, 'utf8');
  const { sha256 } = await vault.snapshot();
  await assert.rejects(vault.changePassphrase('Wrong disposable passphrase!', newPass, sha256), { code: 'VAULT_UNLOCK_FAILED' });
  await assert.rejects(vault.changePassphrase(oldPass, oldPass, sha256), { code: 'VAULT_PASSPHRASE_UNCHANGED' });
  await assert.rejects(vault.changePassphrase(oldPass, 'short', sha256), { code: 'VAULT_PASSPHRASE_INVALID' });
  await assert.rejects(vault.changePassphrase(oldPass, newPass, '0'.repeat(64)), { code: 'VAULT_CONFLICT' });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal((await backups(dir)).length, 1, 'the backups stay when nothing changed');
  assert.equal(vault.locked, false, 'a refused change does not lock');
  vault.lock();
  await assert.rejects(vault.changePassphrase(oldPass, newPass, sha256), { code: 'VAULT_LOCKED' });
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('A2-7: the passphrase route needs both passphrases and the hash, and is a guarded credential route', { timeout: 60000 }, async t => {
  assert.equal(isCredentialPath('/api/credentials/vault/passphrase'), true);
  const { backend, password } = await import('./support/security-backend.mjs');
  const { call } = await backend(t);
  const admin = (await call('/api/auth/init', { body: { username: 'owner', password: password() } })).json.token;
  assert.equal((await call('/api/credentials/vault/initialize', { token: admin, body: { passphrase: oldPass } })).status, 201);
  assert.equal((await call('/api/credentials/vault/unlock', { token: admin, body: { passphrase: oldPass } })).status, 200);
  const sha256 = (await call('/api/credentials/vault', { token: admin })).json.vault.sha256;
  const refused = await call('/api/credentials/vault/passphrase', { token: admin, body: { passphrase: oldPass, newPassphrase: newPass } });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, 'CREDENTIAL_INVALID');
  const wrong = await call('/api/credentials/vault/passphrase', { token: admin, body: { passphrase: 'Wrong disposable passphrase!', newPassphrase: newPass, expectedSha256: sha256 } });
  assert.equal(wrong.json.code, 'VAULT_UNLOCK_FAILED');
  const changed = await call('/api/credentials/vault/passphrase', { token: admin, body: { passphrase: oldPass, newPassphrase: newPass, expectedSha256: sha256 } });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  assert.equal(changed.headers.get('cache-control'), 'no-store');
  assert.equal(changed.json.vault.locked, false);
  assert.notEqual(changed.json.vault.sha256, sha256);
  assert.equal(JSON.stringify(changed.json).includes(newPass), false);
  assert.equal((await call('/api/credentials/vault/lock', { token: admin, body: {} })).status, 200);
  assert.equal((await call('/api/credentials/vault/unlock', { token: admin, body: { passphrase: oldPass } })).json.code, 'VAULT_UNLOCK_FAILED');
  assert.equal((await call('/api/credentials/vault/unlock', { token: admin, body: { passphrase: newPass } })).status, 200);
});

test('A2-7: the credential editor offers the passphrase change while the vault is unlocked', () => {
  const editor = read('lib/instance-credential-editor.jsx');
  assert.match(editor, /await call\('\/api\/credentials\/vault\/passphrase', \{ passphrase: value, newPassphrase: newValue, expectedSha256: credentials\.sha256 \}\);/);
  assert.match(editor, /kind === 'rekey' \? newValue === rekeyRepeat\.current\?\.value/, 'the new passphrase is asked twice');
  assert.match(editor, /for \(const input of \[rekeyCurrent, rekeyNew, rekeyRepeat\]\) if \(input\.current\) input\.current\.value = '';/, 'fields are cleared like the others');
  assert.match(editor, /\{unlocked && <details/);
  assert.match(editor, /'VAULT_PASSPHRASE_UNCHANGED'\]\.includes\(code\)/);
});

import { capGameLogs, rotateGameLogs } from '../lib/game-log-rotation.mjs';
import { gameLogsCommand } from '../lib/remote-commands.mjs';
import { dockerCapLogsCommand } from '../lib/docker-commands.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const TOKEN = '12345678-1234-4234-8234-123456789abc';

async function home(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-logcap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'main', 'logs'), { recursive: true });
  return root;
}

test('A4-8: a running local server: a log above the limit is copied to .1 and emptied in place', async t => {
  const root = await home(t), main = path.join(root, 'main');
  await fs.writeFile(path.join(main, 'qconsole.log'), 'x'.repeat(4096));
  await fs.writeFile(path.join(main, 'logs', 'games_mp.log'), 'small');
  // the core keeps its handle open for appending
  const core = await fs.open(path.join(main, 'qconsole.log'), 'a');
  t.after(() => core.close());
  assert.deepEqual(await capGameLogs(main, { limit: 1024 }), ['qconsole.log']);
  await core.write('after the cap\n');
  assert.equal(await fs.readFile(path.join(main, 'qconsole.log'), 'utf8'), 'after the cap\n', 'the core writes on at the new end');
  assert.equal((await fs.stat(path.join(main, 'qconsole.log.1'))).size, 4096);
  assert.equal(await fs.readFile(path.join(main, 'logs', 'games_mp.log'), 'utf8'), 'small');
  assert.deepEqual((await fs.readdir(main)).filter(name => name.includes('.cap-')), []);
  assert.deepEqual(await capGameLogs(main, { limit: 1024 }), [], 'below the limit nothing happens');
});

test('A4-8: the local cap never follows a link', { skip: process.platform === 'win32' ? 'symlinks need privileges on Windows' : false }, async t => {
  const root = await home(t), main = path.join(root, 'main');
  const outside = path.join(root, 'outside.txt');
  await fs.writeFile(outside, 'y'.repeat(4096));
  await fs.symlink(outside, path.join(main, 'qconsole.log'));
  assert.deepEqual(await capGameLogs(main, { limit: 1024 }), []);
  assert.equal((await fs.stat(outside)).size, 4096);
  assert.equal(await fs.stat(path.join(main, 'qconsole.log.1')).catch(() => null), null);
  assert.deepEqual(await rotateGameLogs(main, { limit: 1024 }), []);
});

test('A4-8: remote and Docker commands: fixed script, checked values, container cap runs inside the container', () => {
  const native = gameLogsCommand('/srv/cod4/a1', 64 * 1024 * 1024, TOKEN);
  assert.match(native, /^sh -c '[\s\S]+' sh '\/srv\/cod4\/a1\/main' 67108864 12345678-1234-4234-8234-123456789abc$/);
  assert.match(gameLogsCommand('/srv/cod4/a1', 64 * 1024 * 1024, 'start'), / 67108864 start$/);
  for (const bad of [['relative/home', 2048, TOKEN], ['/srv/x', 10, TOKEN], ['/srv/x', 2048, 'x; rm -rf /'], ['/srv/x', '2048', TOKEN]]) assert.throws(() => gameLogsCommand(...bad), { code: /REMOTE_(ARGUMENT|PATH)_INVALID/ });
  const docker = dockerCapLogsCommand('a'.repeat(64), 64 * 1024 * 1024, TOKEN);
  assert.match(docker, /^docker exec a{64} sh -c '[\s\S]+' sh \/cod4\/home\/main 67108864 /);
  assert.throws(() => dockerCapLogsCommand('a'.repeat(64), 2048, 'start'), { code: 'REMOTE_ARGUMENT_INVALID' });
  assert.throws(() => dockerCapLogsCommand('abc', 2048, TOKEN), { code: 'REMOTE_ARGUMENT_INVALID' });
  // before each remote start (native and container); while running from the cap timer
  assert.match(read('lib/remote-instance-manager.mjs'), /await session\.exec\(gameLogsCommand\(instance\.home, GAME_LOG_LIMIT_BYTES, 'start'\), \{ timeoutMs: 15_000 \}\);[^\n]*\n    if \(isDocker\(instance\)\) return this\.#launchContainer/);
  const server = read('installer-server.mjs');
  assert.match(server, /setInterval\(\(\) => \{ void capRunningGameLogs\(\); \}, GAME_LOG_CAP_INTERVAL_MS\)\.unref\(\);/);
  assert.match(server, /await remoteMonitor\.capLogs\(instance\);/);
  assert.match(server, /standard\?\.status === "RUNNING" && standard\.filesystemHomePath/);
});

test('A4-8: the remote script under sh: cap while running, rename at start, links untouched', { skip: process.platform === 'win32' ? 'POSIX sh' : false }, async t => {
  const root = await home(t), main = path.join(root, 'main');
  const sh = command => run('/bin/sh', ['-c', command]);
  await fs.writeFile(path.join(main, 'qconsole.log'), 'x'.repeat(4096));
  const core = await fs.open(path.join(main, 'qconsole.log'), 'a');
  t.after(() => core.close());
  await sh(gameLogsCommand(root, 1024, TOKEN));
  await core.write('after');
  assert.equal(await fs.readFile(path.join(main, 'qconsole.log'), 'utf8'), 'after');
  assert.equal((await fs.stat(path.join(main, 'qconsole.log.1'))).size, 4096);
  // a link in the home is never followed, in either mode
  const secret = path.join(root, 'secret');
  await fs.writeFile(secret, 's'.repeat(4096));
  await fs.rm(path.join(main, 'qconsole.log'));
  await fs.symlink(secret, path.join(main, 'qconsole.log'));
  await sh(gameLogsCommand(root, 1024, '12345678-1234-4234-8234-123456789abd'));
  await sh(gameLogsCommand(root, 1024, 'start'));
  assert.equal((await fs.stat(secret)).size, 4096);
  assert.equal((await fs.lstat(path.join(main, 'qconsole.log'))).isSymbolicLink(), true);
  // a linked logs directory is skipped
  await fs.rm(path.join(main, 'logs'), { recursive: true });
  await fs.mkdir(path.join(root, 'other'));
  await fs.writeFile(path.join(root, 'other', 'games_mp.log'), 'g'.repeat(4096));
  await fs.symlink(path.join(root, 'other'), path.join(main, 'logs'));
  await sh(gameLogsCommand(root, 1024, 'start'));
  assert.equal((await fs.readdir(path.join(root, 'other'))).join(), 'games_mp.log');
  // start: a big log is renamed
  await fs.rm(path.join(main, 'qconsole.log'));
  await fs.writeFile(path.join(main, 'qconsole.log'), 'x'.repeat(2048));
  await sh(gameLogsCommand(root, 1024, 'start'));
  assert.equal(await fs.stat(path.join(main, 'qconsole.log')).catch(() => null), null);
  assert.equal((await fs.stat(path.join(main, 'qconsole.log.1'))).size, 2048);
  assert.deepEqual((await fs.readdir(main)).filter(name => name.includes('.cap-')), []);
});
