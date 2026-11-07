import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRemoteFixture, sha256, alive, until } from './support/remote-fixture.mjs';
import { loopbackAvailable } from './support/loopback-transport.mjs';

const available = await loopbackAvailable();
const skip = available ? false : 'needs Linux, a non-root user, gcc and setsid';
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code, code);
const mode = async file => (await fs.stat(file)).mode & 0o777;
const config = (instance, extra = '') => `// edited\nset sv_hostname "${instance.name}"\nset net_port "${instance.port}"\nset g_log "logs/games_mp.log"\n${extra}`;

// ---- logs ----------------------------------------------------------------------------------------------
test('logs return the output of the current run, bounded, and nothing before the first start', { skip }, async t => {
  const f = await createRemoteFixture(t);
  await f.install('public-01');
  const before = f.connects.length;
  assert.deepEqual(await f.manager.logs('public-01'), { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, console: '', consoleTruncated: false });
  assert.equal(f.connects.length, before, 'no run yet, so no connection');
  const { runtime } = await f.manager.start('public-01');
  assert.ok(await until(async () => (await f.manager.logs('public-01')).stderr.includes('fixture stderr')));
  const logs = await f.manager.logs('public-01');
  assert.ok(logs.stdout.includes('fs_homepath') && logs.stdout.includes('+exec'));
  assert.deepEqual([logs.stdoutTruncated, logs.stderrTruncated], [false, false]);
  const small = await f.manager.logs('public-01', { limit: 16 });
  assert.ok(Buffer.byteLength(small.stdout) <= 16 && small.stdoutTruncated);
  // after the stop the last run stays readable
  await f.manager.stop('public-01');
  assert.ok((await f.manager.logs('public-01')).stderr.includes('fixture stderr'));
  assert.ok(runtime.runId);
});

test('logs reject a limit that is not a whole number between 1 and 1 MiB', { skip }, async t => {
  const f = await createRemoteFixture(t);
  await f.install('public-01'); await f.manager.start('public-01');
  for (const limit of [0, -1, 1.5, '10', 2 * 1024 * 1024, NaN]) await rejects(f.manager.logs('public-01', { limit }), 'REMOTE_ARGUMENT_INVALID');
});

test('the console log is bounded, valid text, and secrets are blacked out of every stream', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const instance = await f.install('public-01');
  const { runtime } = await f.manager.start('public-01');
  const consoleFile = `${instance.home}/main/qconsole.log`;
  await fs.writeFile(consoleFile, `start\nrcon_password hunter2 is set\nsv_authtoken ABCDEF\n!auth topsecret\nplayer said @auth other-secret\n${'x'.repeat(200_000)}\nEND`);
  await fs.appendFile(`${instance.home}/logs/runtime-${runtime.runId}-stdout.log`, 'g_password leaked-value\n');
  const logs = await f.manager.logs('public-01', { limit: 65536 });
  assert.ok(Buffer.byteLength(logs.console) <= 65536 && logs.consoleTruncated && logs.console.endsWith('END'));
  const small = await f.manager.logs('public-01', { limit: 1_048_576 });
  for (const secret of ['hunter2', 'ABCDEF', 'topsecret', 'other-secret']) assert.ok(!small.console.includes(secret), secret);
  assert.ok(small.console.includes('rcon_password [redacted]'));
  assert.ok(!logs.stdout.includes('leaked-value') && logs.stdout.includes('g_password [redacted]'));
  // binary data in the console log still comes out as a valid string
  await fs.writeFile(consoleFile, Buffer.from([0xff, 0xfe, 0x80, 0x61, 0xc3, 0x28, 0x62, 0x0a]));
  const binary = await f.manager.logs('public-01');
  assert.equal(Buffer.from(binary.console, 'utf8').toString('utf8'), binary.console);
  // a symlinked or hard-linked console file is not followed
  await fs.rm(consoleFile); await fs.writeFile(f.loopback.path('outside.log'), 'secret outside text'); await fs.symlink(f.loopback.path('outside.log'), consoleFile);
  assert.equal((await f.manager.logs('public-01')).console, '');
  await fs.rm(consoleFile); await fs.link(f.loopback.path('outside.log'), consoleFile);
  assert.equal((await f.manager.logs('public-01')).console, '');
});

// ---- config --------------------------------------------------------------------------------------------
test('readConfig returns the text with its hash, and refuses anything but a plain private file', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const instance = await f.install('public-01');
  const cfg = `${instance.home}/main/server.cfg`;
  const original = await fs.readFile(cfg);
  const read = await f.manager.readConfig('public-01');
  assert.deepEqual(read, { text: original.toString('utf8'), sha256: sha256(original), bytes: original.length });
  await fs.rm(cfg); await fs.symlink(f.loopback.path('game', 'main', 'pak0.iwd'), cfg);
  await rejects(f.manager.readConfig('public-01'), 'INSTANCE_CONFIG_INVALID');
  await fs.rm(cfg); await fs.writeFile(cfg, original); await fs.link(cfg, f.loopback.path('alias.cfg'));
  await rejects(f.manager.readConfig('public-01'), 'INSTANCE_CONFIG_INVALID');
  await fs.rm(f.loopback.path('alias.cfg')); await fs.rm(cfg);
  await rejects(f.manager.readConfig('public-01'), 'INSTANCE_CONFIG_INVALID');
});

test('writeConfig replaces the config atomically, keeps the old one as a backup and leaves no temporary file', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const instance = await f.install('public-01');
  const cfg = `${instance.home}/main/server.cfg`;
  const before = await f.manager.readConfig('public-01');
  const text = config(instance, 'set sv_maxclients "12"\n');
  const result = await f.manager.writeConfig('public-01', { text, expectedSha256: before.sha256 });
  assert.equal(await fs.readFile(cfg, 'utf8'), text);
  assert.equal(result.sha256, sha256(Buffer.from(text)));
  assert.equal(await mode(cfg), 0o600);
  assert.deepEqual((await fs.readdir(`${instance.home}/main`)).sort(), ['server.cfg']);
  const backups = await f.manager.listBackups('public-01');
  assert.deepEqual(backups.map(entry => entry.backupId), [result.backupId]);
  const kept = await fs.readFile(path.join(f.local, 'backups', 'public-01', result.backupId, 'server.cfg'), 'utf8');
  assert.equal(kept, before.text, 'the backup holds the config that was replaced');
  assert.ok(f.audits.some(entry => entry.event === 'remote.instance.config_written' && entry.instanceId === 'public-01'));
  assert.ok(!JSON.stringify(f.audits).includes('sv_maxclients'), 'no config text in the audit');
});

test('writeConfig refuses a stale hash, a config for another port, bad text and a running instance, and changes nothing', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const instance = await f.install('public-01'); const other = await f.install('public-02');
  const cfg = `${instance.home}/main/server.cfg`;
  const before = await f.manager.readConfig('public-01');
  const spec = text => ({ text, expectedSha256: before.sha256 });
  await rejects(f.manager.writeConfig('public-01', { text: config(instance), expectedSha256: sha256('something else') }), 'REMOTE_CONFIG_CONFLICT');
  await rejects(f.manager.writeConfig('public-01', spec(`set sv_hostname "x"\nset net_port "${other.port}"\n`)), 'INSTANCE_CONFIG_INVALID');
  await rejects(f.manager.writeConfig('public-01', spec('exec evil.cfg\n')), 'INSTANCE_CONFIG_INVALID');
  await rejects(f.manager.writeConfig('public-01', spec('set a "b"\u0000\n')), 'INSTANCE_CONFIG_INVALID');
  await rejects(f.manager.writeConfig('public-01', spec(`set a "${'x'.repeat(300_000)}"\n`)), 'INSTANCE_CONFIG_INVALID');
  await rejects(f.manager.writeConfig('public-01', spec(`set g_log "../../x.log"\n`)), 'INSTANCE_CONFIG_INVALID');
  for (const bad of [{ text: 5, expectedSha256: before.sha256 }, { text: config(instance), expectedSha256: 'xyz' }, { text: config(instance) }, null]) await rejects(f.manager.writeConfig('public-01', bad), 'REMOTE_ARGUMENT_INVALID');
  assert.deepEqual(await fs.readFile(cfg), Buffer.from(before.text));
  const { runtime } = await f.manager.start('public-01');
  await rejects(f.manager.writeConfig('public-01', spec(config(instance, 'set x "1"\n'))), 'REMOTE_INSTANCE_RUNNING');
  assert.deepEqual(await fs.readFile(cfg), Buffer.from(before.text));
  assert.equal((await f.manager.listBackups('public-01')).length, 0, 'a refused write makes no backup');
  assert.ok(alive(runtime.pid));
});

test('writeConfig can repair a config that is damaged (control characters), and needs a backup place and a state source', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const instance = await f.install('public-01');
  const cfg = `${instance.home}/main/server.cfg`;
  const damaged = Buffer.from('set a "b"\u0001\n');
  await fs.writeFile(cfg, damaged);
  await rejects(f.manager.readConfig('public-01'), 'INSTANCE_CONFIG_INVALID');
  const fixed = await f.manager.writeConfig('public-01', { text: config(instance), expectedSha256: sha256(damaged) });
  assert.equal(await fs.readFile(cfg, 'utf8'), config(instance));
  assert.deepEqual(await fs.readFile(path.join(f.local, 'backups', 'public-01', fixed.backupId, 'server.cfg')), damaged, 'the damaged file is kept in the backup');
  const none = await createRemoteFixture(t, { backups: false });
  const other = await none.install('public-01');
  await rejects(none.manager.writeConfig('public-01', { text: config(other), expectedSha256: sha256(await fs.readFile(`${other.home}/main/server.cfg`)) }), 'REMOTE_BACKUP_UNAVAILABLE');
  await rejects(none.manager.createBackup('public-01'), 'REMOTE_BACKUP_UNAVAILABLE');
});

// ---- backup and restore --------------------------------------------------------------------------------
test('a backup holds the config and the instance record with hashes, privately, and can be listed', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const instance = await f.install('public-01');
  const backup = await f.manager.createBackup('public-01');
  assert.match(backup.backupId, /^\d{8}T\d{6}Z-[a-f0-9]{8}$/);
  const directory = path.join(f.local, 'backups', 'public-01', backup.backupId);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['instance.json', 'manifest.json', 'server.cfg']);
  for (const name of ['', 'instance.json', 'manifest.json', 'server.cfg']) assert.equal((await mode(path.join(directory, name))) & 0o077, 0, name || 'directory');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files.map(file => file.name).sort(), ['instance.json', 'server.cfg']);
  for (const file of manifest.files) assert.equal(file.sha256, sha256(await fs.readFile(path.join(directory, file.name))));
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'instance.json'), 'utf8')).id, instance.id);
  const listed = await f.manager.listBackups('public-01');
  assert.deepEqual(listed.map(entry => entry.backupId), [backup.backupId]);
  assert.deepEqual(await f.manager.listBackups('public-02').catch(error => error.code), 'REMOTE_INSTANCE_NOT_FOUND');
  // a backup can be made while the server runs
  await f.manager.start('public-01');
  assert.match((await f.manager.createBackup('public-01')).backupId, /^\d{8}T/);
});

test('backup, change, restore brings the original bytes back; the restore keeps a safety backup of what it replaced', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const instance = await f.install('public-01');
  const cfg = `${instance.home}/main/server.cfg`;
  const original = await fs.readFile(cfg);
  const backup = await f.manager.createBackup('public-01');
  const changed = config(instance, 'set sv_maxclients "9"\n');
  await f.manager.writeConfig('public-01', { text: changed, expectedSha256: sha256(original) });
  const restored = await f.manager.restoreBackup('public-01', backup.backupId);
  assert.deepEqual(await fs.readFile(cfg), original);
  assert.equal(restored.sha256, sha256(original));
  assert.equal(await mode(cfg), 0o600);
  const safety = await fs.readFile(path.join(f.local, 'backups', 'public-01', restored.safetyBackupId, 'server.cfg'), 'utf8');
  assert.equal(safety, changed, 'the config that was replaced by the restore is kept');
  assert.ok((await f.manager.listBackups('public-01')).length >= 3);
  assert.ok(f.audits.some(entry => entry.event === 'remote.instance.restored'));
});

test('a restore with a damaged or tampered backup fails before anything is sent', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const instance = await f.install('public-01');
  const cfg = `${instance.home}/main/server.cfg`;
  const original = await fs.readFile(cfg);
  const backup = await f.manager.createBackup('public-01');
  const directory = path.join(f.local, 'backups', 'public-01', backup.backupId);
  const before = f.connects.length;
  await fs.appendFile(path.join(directory, 'server.cfg'), 'set tampered "1"\n');
  await rejects(f.manager.restoreBackup('public-01', backup.backupId), 'REMOTE_BACKUP_INVALID');
  await fs.writeFile(path.join(directory, 'server.cfg'), original);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  manifest.files[0].sha256 = 'f'.repeat(64);
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  await rejects(f.manager.restoreBackup('public-01', backup.backupId), 'REMOTE_BACKUP_INVALID');
  await fs.writeFile(path.join(directory, 'manifest.json'), '{ not json');
  await rejects(f.manager.restoreBackup('public-01', backup.backupId), 'REMOTE_BACKUP_INVALID');
  await fs.rm(path.join(directory, 'manifest.json'));
  await rejects(f.manager.restoreBackup('public-01', backup.backupId), 'REMOTE_BACKUP_INVALID');
  assert.equal(f.connects.length, before, 'nothing reached the network');
  assert.deepEqual(await fs.readFile(cfg), original);
});

test('restore refuses unknown or odd backup ids, a running instance, and a config for another port', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const instance = await f.install('public-01'); const other = await f.install('public-02');
  const cfg = `${instance.home}/main/server.cfg`;
  const original = await fs.readFile(cfg);
  const backup = await f.manager.createBackup('public-01');
  for (const id of ['../x', '20260101T000000Z', 'latest', '', 5, `${backup.backupId}/..`]) await rejects(f.manager.restoreBackup('public-01', id), 'REMOTE_ARGUMENT_INVALID');
  await rejects(f.manager.restoreBackup('public-01', '20260101T000000Z-aaaaaaaa'), 'REMOTE_BACKUP_NOT_FOUND');
  // a backup of another instance is not found under this one
  const foreign = await f.manager.createBackup('public-02');
  await rejects(f.manager.restoreBackup('public-01', foreign.backupId), 'REMOTE_BACKUP_NOT_FOUND');
  // a backup whose config belongs to another port is refused by the same rule as a write
  const wrong = path.join(f.local, 'backups', 'public-01', '20260102T000000Z-bbbbbbbb');
  await fs.mkdir(wrong, { recursive: true });
  const body = Buffer.from(`set sv_hostname "x"\nset net_port "${other.port}"\n`);
  const record = Buffer.from(JSON.stringify({ id: 'public-01' }));
  await fs.writeFile(path.join(wrong, 'server.cfg'), body); await fs.writeFile(path.join(wrong, 'instance.json'), record);
  await fs.writeFile(path.join(wrong, 'manifest.json'), JSON.stringify({ version: 1, instanceId: 'public-01', backupId: '20260102T000000Z-bbbbbbbb', createdAt: '2026-01-02T00:00:00.000Z', core: { version: '21.5', sha256: instance.core.sha256 },
    files: [{ name: 'server.cfg', sha256: sha256(body), bytes: body.length }, { name: 'instance.json', sha256: sha256(record), bytes: record.length }] }));
  await rejects(f.manager.restoreBackup('public-01', '20260102T000000Z-bbbbbbbb'), 'INSTANCE_CONFIG_INVALID');
  await f.manager.start('public-01');
  await rejects(f.manager.restoreBackup('public-01', backup.backupId), 'REMOTE_INSTANCE_RUNNING');
  assert.deepEqual(await fs.readFile(cfg), original);
});

test('listBackups marks a damaged backup and sorts the good ones newest first', { skip }, async t => {
  const f = await createRemoteFixture(t);
  await f.install('public-01');
  const first = await f.manager.createBackup('public-01');
  await new Promise(resolve => setTimeout(resolve, 1100));
  const second = await f.manager.createBackup('public-01');
  await fs.rm(path.join(f.local, 'backups', 'public-01', first.backupId, 'manifest.json'));
  const listed = await f.manager.listBackups('public-01');
  assert.deepEqual(listed.map(entry => [entry.backupId, Boolean(entry.invalid)]), [[second.backupId, false], [first.backupId, true]]);
});

test('every backup and restore step for one instance excludes another operation on it', { skip }, async t => {
  const f = await createRemoteFixture(t);
  await f.install('public-01');
  let release;
  f.control.gate = new Promise(resolve => { release = resolve; });
  const first = f.manager.createBackup('public-01');
  await new Promise(resolve => setTimeout(resolve, 30));
  await rejects(f.manager.start('public-01'), 'REMOTE_OPERATION_BUSY');
  release(); f.control.gate = null;
  await first;
  assert.ok(crypto.randomUUID());
});
