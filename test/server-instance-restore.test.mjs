import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ServerInstanceStore } from '../lib/server-instance-store.mjs';
import { ServerInstanceManager, B3_DATABASE_CONFIRMATION } from '../lib/server-instance-manager.mjs';
import { RestorePointStore } from '../lib/restore-points.mjs';

// Real store, config engine, plugin code and restore points; the runtime is a stopped stand-in.
async function fixture(t, { busy = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-sir-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const basePath = path.join(root, 'game'), executablePath = path.join(root, 'core', 'cod4x18_dedrun');
  await fs.mkdir(path.join(basePath, 'main'), { recursive: true });
  await fs.mkdir(path.join(basePath, 'zone'), { recursive: true });
  await fs.mkdir(path.dirname(executablePath));
  await fs.writeFile(path.join(basePath, 'main', 'pak0.iwd'), 'fixture');
  await fs.writeFile(path.join(basePath, 'zone', 'common.ff'), 'fixture');
  await fs.writeFile(executablePath, 'core one');
  const store = new ServerInstanceStore({ root: path.join(root, 'servers'), registryFile: path.join(root, 'instances.json'), checkPort: async () => {} });
  await store.load();
  const instance = await store.create({ id: 'alpha', name: 'Alpha', platform: 'linux', serverCore: { executablePath, version: '21.5' }, basePath, port: 28960 });
  const restorePoints = new RestorePointStore({ root: path.join(root, 'points') });
  const events = [];
  const runtime = { busy, state: { status: busy ? 'RUNNING' : 'STOPPED' }, async loadRuntimeState() {}, async reconcileRuntimeState() {}, async persistRuntimeState() {} };
  const manager = new ServerInstanceManager({ store, runtimeFactory: () => runtime, restorePoints, audit: (level, event, details) => events.push({ event, details }) });
  return { root, store, instance, manager, restorePoints, events, executablePath };
}
const files = async home => Object.fromEntries(await Promise.all(['main/server.cfg'].map(async name => [name, await fs.readFile(path.join(home, name), 'utf8')])));

test('a config change whose verify fails is rolled back byte-identical', async t => {
  const { manager, instance, events } = await fixture(t);
  const before = await files(instance.homePath);
  const current = await manager.configEngine.read(instance);
  const entries = current.entries.map(entry => entry.name === 'sv_hostname' ? { ...entry, value: 'Changed' } : entry);
  const realApply = manager.configEngine.apply.bind(manager.configEngine);
  manager.configEngine.apply = async (...args) => ({ ...(await realApply(...args)), verified: false });
  const error = await manager.changeConfiguration('alpha', { expectedSha256: current.sha256, entries }).catch(caught => caught);
  assert.equal(error.code, 'CONFIG_VERIFY_FAILED');
  assert.equal(error.rolledBack, true);
  assert.deepEqual(await files(instance.homePath), before);
  assert.ok(events.some(entry => entry.event === 'change.rolled_back'));
});

test('a config change that passes returns the restore point id', async t => {
  const { manager, instance } = await fixture(t);
  const current = await manager.configEngine.read(instance);
  const entries = current.entries.map(entry => entry.name === 'sv_hostname' ? { ...entry, value: 'Changed' } : entry);
  const result = await manager.changeConfiguration('alpha', { expectedSha256: current.sha256, entries });
  assert.equal(result.changed, true);
  assert.match(result.restorePointId, /Z-[0-9a-f]{8}$/);
  assert.equal((await manager.listRestorePoints('alpha')).points[0].action, 'config.change');
});

test('a plugin install whose verify fails removes the new plugin file and restores the records', async t => {
  const { root, manager, store, instance } = await fixture(t);
  const source = path.join(root, 'demo.so');
  await fs.writeFile(source, Buffer.alloc(300, 7));
  manager.verifyPlugins = async () => { throw Object.assign(new Error('PLUGIN_INTEGRITY_FAILED'), { code: 'PLUGIN_INTEGRITY_FAILED' }); };
  await assert.rejects(manager.installPlugin('alpha', { sourcePath: source }), { code: 'PLUGIN_INTEGRITY_FAILED', rolledBack: true });
  assert.deepEqual(store.get('alpha').plugins, []);
  assert.deepEqual((await fs.readdir(path.join(instance.homePath, 'plugins'))).filter(name => !name.startsWith('.')), []);
});

test('core change: refused for a wrong file, rolled back on a failed verify, applied otherwise', async t => {
  const { root, manager, store, executablePath } = await fixture(t);
  const other = path.join(root, 'core2', 'cod4x18_dedrun');
  await fs.mkdir(path.dirname(other));
  await fs.writeFile(other, 'core two');
  await assert.rejects(manager.changeCore('alpha', { executablePath: path.join(root, 'core2', 'evil'), version: '21.5' }), { code: 'INSTANCE_CORE_INVALID', rolledBack: true });
  await assert.rejects(manager.changeCore('alpha', { executablePath, version: '21.5' }), { code: 'INSTANCE_CORE_UNCHANGED' });
  await assert.rejects(manager.changeCore('alpha', { executablePath: other, version: '20.1' }), { code: 'INSTANCE_CORE_VERSION_INVALID' });
  await assert.rejects(manager.changeCore('alpha', { executablePath: other, version: '21.5', extra: 1 }), { code: 'INSTANCE_CORE_INVALID' });
  manager.allowedCoreVersions = ['21.5'];
  const realSet = store.setCore.bind(store);
  store.setCore = async (id, core) => realSet(id, { ...core, version: '21.4' }); // the saved version is not allowed -> verify fails
  await assert.rejects(manager.changeCore('alpha', { executablePath: other, version: '21.5' }), { code: 'INSTANCE_CORE_VERSION_INVALID', rolledBack: true });
  assert.equal(store.get('alpha').serverCore.executablePath, executablePath);
  store.setCore = realSet;
  const result = await manager.changeCore('alpha', { executablePath: other, version: '21.5' });
  assert.equal(result.serverCore.executablePath, other);
  assert.equal(result.previous.executablePath, executablePath);
});

test('a failed rollback blocks launch with RECOVERY_REQUIRED until a manual restore', async t => {
  const { manager, store, instance, restorePoints } = await fixture(t);
  const current = await manager.configEngine.read(instance);
  const realRead = restorePoints.read.bind(restorePoints);
  restorePoints.read = async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); };
  const entries = current.entries.map(entry => entry.name === 'sv_hostname' ? { ...entry, value: 'Changed' } : entry);
  const realApply = manager.configEngine.apply.bind(manager.configEngine);
  manager.configEngine.apply = async (...args) => { await realApply(...args); throw Object.assign(new Error('CONFIG_VERIFY_FAILED'), { code: 'CONFIG_VERIFY_FAILED' }); };
  const error = await manager.changeConfiguration('alpha', { expectedSha256: current.sha256, entries }).catch(caught => caught);
  assert.equal(error.recoveryRequired, true);
  await assert.rejects(manager.launch('alpha'), { code: 'RECOVERY_REQUIRED' });
  restorePoints.read = realRead;
  const restored = await manager.restoreRestorePoint('alpha', error.restorePointId, {}, { canCode: false });
  assert.deepEqual(restored.restored.sort(), ['config', 'record']);
  assert.equal(await restorePoints.recovery('local:alpha'), null);
  assert.match(await fs.readFile(instance.configPath, 'utf8'), /Alpha/);
});

test('manual restore: code parts need server.code, the B3 database needs the confirmation, a running server is refused', async t => {
  const { manager } = await fixture(t);
  const { pointId } = await manager.createRestorePoint('alpha', { actor: 'admin' });
  await assert.rejects(manager.restoreRestorePoint('alpha', pointId, {}, { canCode: false }), { code: 'RESTORE_POINT_CODE_PERMISSION' });
  await assert.rejects(manager.restoreRestorePoint('alpha', pointId, { includeB3Database: true, confirmation: 'ja' }, { canCode: true }), { code: 'RESTORE_POINT_CONFIRMATION_REQUIRED' });
  let dumped = false;
  manager.b3Database = { restoreDump: async () => { dumped = true; } };
  const result = await manager.restoreRestorePoint('alpha', pointId, {}, { canCode: true });
  assert.equal(dumped, false);
  assert.match(result.safetyPointId, /Z-[0-9a-f]{8}$/);
  assert.equal(B3_DATABASE_CONFIRMATION, 'B3-DATENBANK ZURÜCKSETZEN');
  const integrity = await manager.restorePointIntegrity('alpha', pointId);
  assert.equal(integrity.valid, true);
});

test('restore while the server runs is refused', async t => {
  const { manager, restorePoints } = await fixture(t, { busy: true });
  const { pointId } = await restorePoints.capture('local:alpha', { action: 'manual', manual: true, data: { record: { id: 'alpha' } } });
  await assert.rejects(manager.restoreRestorePoint('alpha', pointId, {}, { canCode: true }), { code: 'INSTANCE_RUNTIME_BUSY' });
});

test('a point with a B3 dump: without the confirmation the database is never touched, with it the dump is replayed', async t => {
  const { manager, restorePoints } = await fixture(t);
  const calls = [];
  manager.b3Database = { restoreDump: async (id, dump) => { calls.push({ id, dump }); }, dumpForPoint: async () => ({ path: '/x/b3-1.sql', sha256: 'a'.repeat(64), tables: { clients: 1 } }) };
  const { pointId } = await manager.createRestorePoint('alpha', { includeB3Database: true });
  assert.ok((await restorePoints.read('local:alpha', pointId)).manifest.parts.includes('b3mysql'));
  await assert.rejects(manager.restoreRestorePoint('alpha', pointId, { includeB3Database: true, confirmation: 'B3-Datenbank zurücksetzen' }, { canCode: true }), { code: 'RESTORE_POINT_CONFIRMATION_REQUIRED' });
  const without = await manager.restoreRestorePoint('alpha', pointId, {}, { canCode: true });
  assert.ok(without.skipped.includes('b3mysql'));
  assert.deepEqual(calls, []);
  const withDb = await manager.restoreRestorePoint('alpha', pointId, { includeB3Database: true, confirmation: B3_DATABASE_CONFIRMATION }, { canCode: true });
  assert.ok(withDb.restored.includes('b3mysql'));
  assert.deepEqual(calls.map(call => call.dump.path), ['/x/b3-1.sql']);
});

test('databasePoints: the migration point carries the dump reference and a failed rollback blocks launch', async t => {
  const { manager, restorePoints } = await fixture(t);
  const points = manager.databasePoints();
  const { pointId } = await points.capture('alpha', 'b3.migration', { refs: { b3mysql: { path: '/x/b3-1.sql', sha256: 'a'.repeat(64), tables: {} } } });
  const { manifest } = await restorePoints.read('local:alpha', pointId);
  assert.equal(manifest.action, 'b3.migration');
  assert.equal(manifest.refs.b3mysql.path, '/x/b3-1.sql');
  await points.assertNoRecovery('alpha');
  await points.markRecovery('alpha', pointId);
  await assert.rejects(points.assertNoRecovery('alpha'), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(manager.launch('alpha'), { code: 'RECOVERY_REQUIRED' });
});
