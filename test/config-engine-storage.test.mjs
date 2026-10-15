import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigEngineStorage } from '../lib/config-engine-storage.mjs';

async function fixture(action) {
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-config-'));
  const instance = { id: 'config-test', homePath, configPath: path.join(homePath, 'main', 'server.cfg'), port: 49232 };
  await fs.mkdir(path.dirname(instance.configPath));
  await fs.writeFile(instance.configPath, 'set sv_hostname "Original"\nset net_port "49232"\nset g_log "logs/games_mp.log"\n', { mode: 0o600 });
  try { await action(instance, new ConfigEngineStorage()); }
  finally { await fs.rm(homePath, { recursive: true, force: true }); }
}
test('backup listing persists across engine recreation and marks corrupt records without exposing content', () => fixture(async (instance, engine) => {
  assert.deepEqual(await engine.listBackups(instance), []);
  const before = await engine.read(instance);
  const entries = before.entries.map(x => x.name === 'sv_hostname' ? { ...x, value: 'Changed' } : x);
  const result = await engine.apply(instance, { expectedSha256: before.sha256, entries });
  const next = new ConfigEngineStorage();
  const records = await next.listBackups(instance);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, result.backupId);
  assert.equal(records[0].valid, true);
  assert.equal(records[0].sha256, before.sha256);
  assert.equal(Object.hasOwn(records[0], 'text'), false);
  const file = path.join(instance.homePath, 'config-backups', result.backupId + '.json');
  await fs.writeFile(file, 'corrupt-private-data');
  const invalid = await next.listBackups(instance);
  assert.equal(invalid[0].valid, false);
  assert.ok(!JSON.stringify(invalid).includes('private-data'));
  assert.equal(await fs.readFile(file, 'utf8'), 'corrupt-private-data');
  await assert.rejects(next.restore(instance, { backupId: result.backupId, expectedSha256: result.sha256 }), { code: 'CONFIG_BACKUP_INVALID' });
}));

test('restore can recover malformed current syntax while retaining a non-restorable safety copy', () => fixture(async (instance, engine) => {
  const before = await engine.read(instance);
  const entries = before.entries.map(x => x.name === 'sv_hostname' ? { ...x, value: 'Changed' } : x);
  const applied = await engine.apply(instance, { expectedSha256: before.sha256, entries });
  await fs.writeFile(instance.configPath, 'set sv_hostname "broken');
  const damaged = await engine.recoverySnapshot(instance);
  assert.equal(damaged.valid, false);
  assert.equal(Object.hasOwn(damaged, 'text'), false);
  const restored = await engine.restore(instance, { backupId: applied.backupId, expectedSha256: damaged.sha256 });
  assert.equal(restored.sha256, before.sha256);
  assert.equal(await fs.readFile(instance.configPath, 'utf8'), before.text);
  const safety = JSON.parse(await fs.readFile(path.join(instance.homePath, 'config-backups', restored.backupId + '.json'), 'utf8'));
  assert.equal(safety.text, 'set sv_hostname "broken');
  assert.equal(safety.restorable, false);
  assert.equal((await engine.listBackups(instance)).find(x => x.id === restored.backupId).valid, false);
  await assert.rejects(engine.restore(instance, { backupId: restored.backupId, expectedSha256: before.sha256 }), { code: 'CONFIG_BACKUP_INVALID' });
}));

test('preview validates and compares against the expected snapshot without writing files', () => fixture(async (instance, engine) => {
  const before = await engine.read(instance);
  const entries = before.entries.map(x => x.name === 'sv_hostname' ? { ...x, value: 'Previewed' } : x);
  const preview = await engine.preview(instance, { expectedSha256: before.sha256, entries });
  assert.equal(preview.valid, true);
  assert.equal(preview.sha256, before.sha256);
  assert.equal(preview.restartRequired, true);
  assert.deepEqual(preview.diff.map(x => [x.name, x.before, x.after]), [['sv_hostname', 'Original', 'Previewed']]);
  assert.equal((await engine.read(instance)).sha256, before.sha256);
  await assert.rejects(fs.stat(path.join(instance.homePath, 'config-backups')), { code: 'ENOENT' });
  await assert.rejects(engine.preview(instance, { expectedSha256: '0'.repeat(64), entries }), { code: 'CONFIG_CONFLICT' });
  await assert.rejects(engine.preview(instance, { expectedSha256: before.sha256, entries: [{command:'set',name:'net_port',value:'12345'}] }), { code: 'CONFIG_SCHEMA_INVALID' });
}));

test('real config transaction snapshots, backs up, applies, verifies and restores exact previous text', () => fixture(async (instance, engine) => {
  const before = await engine.read(instance);
  const changed = before.entries.map(entry => entry.name === 'sv_hostname' ? { ...entry, value: 'Changed' } : entry);
  const result = await engine.apply(instance, { expectedSha256: before.sha256, entries: changed });
  assert.equal(result.verified, true);
  assert.equal(result.restartRequired, true);
  assert.equal((await engine.read(instance)).entries.find(x => x.name === 'sv_hostname').value, 'Changed');
  const backed = JSON.parse(await fs.readFile(path.join(instance.homePath, 'config-backups', result.backupId + '.json'), 'utf8'));
  assert.equal(backed.sha256, before.sha256);
  assert.equal(backed.text, before.text);
  const restored = await engine.restore(instance, { backupId: result.backupId, expectedSha256: result.sha256 });
  assert.equal(restored.sha256, before.sha256);
  assert.equal(await fs.readFile(instance.configPath, 'utf8'), before.text);
}));
test('optimistic conflict and invalid schema leave original untouched without backup', () => fixture(async (instance, engine) => {
  const before = await engine.read(instance);
  await assert.rejects(engine.apply(instance, { expectedSha256: '0'.repeat(64), entries: before.entries }), { code: 'CONFIG_CONFLICT' });
  await assert.rejects(engine.apply(instance, { expectedSha256: before.sha256, entries: [{ command: 'set', name: 'unknown', value: '1' }] }), { code: 'CONFIG_SCHEMA_INVALID' });
  assert.equal(await fs.readFile(instance.configPath, 'utf8'), before.text);
  await assert.rejects(fs.stat(path.join(instance.homePath, 'config-backups')), { code: 'ENOENT' });
}));
test('corrupt or escaping backup never applies and no-op creates no backup', () => fixture(async (instance, engine) => {
  const before = await engine.read(instance);
  const noop = await engine.apply(instance, { expectedSha256: before.sha256, entries: before.entries });
  assert.equal(noop.changed, false);
  await assert.rejects(engine.restore(instance, { backupId: '../server.cfg', expectedSha256: before.sha256 }), { code: 'CONFIG_BACKUP_INVALID' });
  const result = await engine.apply(instance, { expectedSha256: before.sha256, entries: before.entries.map(x => x.name === 'sv_hostname' ? { ...x, value: 'New' } : x) });
  const file = path.join(instance.homePath, 'config-backups', result.backupId + '.json');
  const backup = JSON.parse(await fs.readFile(file, 'utf8')); backup.text += 'set sv_hostname "tampered"\n'; await fs.writeFile(file, JSON.stringify(backup));
  await assert.rejects(engine.restore(instance, { backupId: result.backupId, expectedSha256: result.sha256 }), { code: 'CONFIG_BACKUP_INVALID' });
  assert.equal((await engine.read(instance)).sha256, result.sha256);
}));

test('failed backup cannot apply; a failed apply retains a readable safety snapshot', () => fixture(async (instance, engine) => {
  const before = await engine.read(instance);
  const entries = before.entries.map(x => x.name === 'sv_hostname' ? { ...x, value: 'New' } : x);
  await fs.writeFile(path.join(instance.homePath, 'config-backups'), 'not a directory');
  await assert.rejects(engine.apply(instance, { expectedSha256: before.sha256, entries }));
  assert.equal((await engine.read(instance)).sha256, before.sha256);
  await fs.unlink(path.join(instance.homePath, 'config-backups'));
  const replace = engine.replace.bind(engine);
  engine.replace = async () => { throw Object.assign(new Error('simulated rename I/O failure'), { code: 'EIO' }); };
  await assert.rejects(engine.apply(instance, { expectedSha256: before.sha256, entries }), { code: 'EIO' });
  const files = await fs.readdir(path.join(instance.homePath, 'config-backups'));
  assert.equal(files.length, 1);
  assert.equal((await engine.readBackup(instance, files[0].slice(0, -5))).text, before.text);
  assert.equal((await engine.read(instance)).sha256, before.sha256);
  engine.replace = replace;
}));

test('competing configuration operations and external edits are not overwritten', () => fixture(async (instance, engine) => {
  const before = await engine.read(instance), entries = before.entries.map(x => x.name === 'sv_hostname' ? { ...x, value: 'New' } : x);
  let ready, resume;
  const started = new Promise(resolve => { ready = resolve; });
  const waiting = new Promise(resolve => { resume = resolve; });
  const original = engine.createBackup.bind(engine);
  engine.createBackup = async (...args) => { const id = await original(...args); ready(); await waiting; return id; };
  const pending = engine.apply(instance, { expectedSha256: before.sha256, entries });
  await started;
  await assert.rejects(engine.apply(instance, { expectedSha256: before.sha256, entries }), { code: 'CONFIG_OPERATION_BUSY' });
  const external = before.text.replace('Original', 'External');
  await fs.writeFile(instance.configPath, external);
  resume();
  await assert.rejects(pending, { code: 'CONFIG_CONFLICT' });
  assert.equal(await fs.readFile(instance.configPath, 'utf8'), external);
}));

test('backup directory aliases and hardlinked backup files are rejected', () => fixture(async (instance, engine) => {
  const before = await engine.read(instance), entries = before.entries.map(x => x.name === 'sv_hostname' ? { ...x, value: 'New' } : x);
  const result = await engine.apply(instance, { expectedSha256: before.sha256, entries });
  const directory = path.join(instance.homePath, 'config-backups'), file = path.join(directory, result.backupId + '.json');
  await fs.link(file, path.join(instance.homePath, 'foreign-backup.json'));
  await assert.rejects(engine.readBackup(instance, result.backupId), { code: 'CONFIG_BACKUP_INVALID' });
  await fs.unlink(path.join(instance.homePath, 'foreign-backup.json'));
  const moved = path.join(instance.homePath, 'other-backups');
  await fs.rename(directory, moved);
  await fs.symlink(moved, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(engine.apply(instance, { expectedSha256: result.sha256, entries: before.entries }), { code: 'CONFIG_BACKUP_INVALID' });
  assert.equal((await engine.read(instance)).sha256, result.sha256);
}));
