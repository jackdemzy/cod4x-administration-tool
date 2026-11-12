import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ServerInstanceStore } from '../lib/server-instance-store.mjs';
import { RestorePointStore } from '../lib/restore-points.mjs';
import { collectInstanceParts, restoreInstanceParts, pointBringsCode, PARTS_BY_ACTION } from '../lib/instance-restore-points.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-irp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const basePath = path.join(root, 'game'), executablePath = path.join(root, 'core', 'cod4x18_dedrun');
  await fs.mkdir(path.join(basePath, 'main'), { recursive: true });
  await fs.mkdir(path.join(basePath, 'zone'), { recursive: true });
  await fs.mkdir(path.dirname(executablePath));
  await fs.writeFile(path.join(basePath, 'main', 'pak0.iwd'), 'fixture');
  await fs.writeFile(path.join(basePath, 'zone', 'common.ff'), 'fixture');
  await fs.writeFile(executablePath, 'core');
  const store = new ServerInstanceStore({ root: path.join(root, 'servers'), registryFile: path.join(root, 'instances.json'), checkPort: async () => {} });
  await store.load();
  const instance = await store.create({ id: 'alpha', name: 'Alpha', platform: 'linux', serverCore: { executablePath, version: '21.5' }, basePath, port: 28960 });
  const home = instance.homePath;
  await fs.mkdir(path.join(home, 'b3', 'plugins'), { recursive: true });
  await fs.mkdir(path.join(home, 'b3', 'extplugins'), { recursive: true });
  await fs.writeFile(path.join(home, 'plugins', 'alpha.so'), Buffer.alloc(200, 1));
  await fs.writeFile(path.join(home, 'b3', 'database.json'), '{"host":"db"}');
  await fs.writeFile(path.join(home, 'b3', 'b3.xml'), '<secret password="hunter2"/>');
  await fs.writeFile(path.join(home, 'b3', 'plugin_auth.ini'), 'password=hunter2');
  await fs.writeFile(path.join(home, 'b3', 'plugins', 'plugin_admin.ini'), '[a]\n');
  await fs.writeFile(path.join(home, 'b3', 'extplugins', 'mine.py'), 'print(1)\n');
  await fs.writeFile(path.join(home, 'b3', 'b3.db'), 'sqlite');
  const points = new RestorePointStore({ root: path.join(root, 'points') });
  return { root, store, instance, home, points };
}
async function snapshot(home) {
  const result = {};
  for (const relative of ['main/server.cfg', 'plugins', 'b3/database.json', 'b3/plugins', 'b3/extplugins', 'b3/b3.db']) {
    const file = path.join(home, ...relative.split('/'));
    const stats = await fs.lstat(file).catch(() => null);
    if (!stats) continue;
    if (stats.isDirectory()) for (const name of (await fs.readdir(file)).filter(name => !name.startsWith('.')).sort()) result[`${relative}/${name}`] = (await fs.readFile(path.join(file, name))).toString('hex');
    else result[relative] = (await fs.readFile(file)).toString('hex');
  }
  return result;
}
async function capture(points, instance, parts) {
  const { pointId } = await points.capture('local:alpha', { action: 'manual', ...(await collectInstanceParts(instance, parts)) });
  return points.read('local:alpha', pointId);
}

test('collect never includes b3.xml, plugin_auth.ini or a secret', async t => {
  const { instance } = await fixture(t);
  const { entries, data, refs } = await collectInstanceParts(instance, PARTS_BY_ACTION.manual);
  const names = entries.map(entry => entry.name).sort();
  assert.deepEqual(names, ['b3/b3.db', 'b3/database.json', 'b3/extplugins/mine.py', 'b3/plugins/plugin_admin.ini', 'main/server.cfg', 'plugins/alpha.so']);
  assert.equal(entries.some(entry => entry.bytes.includes('hunter2')), false);
  assert.equal(data.record.id, 'alpha');
  assert.match(refs.core.sha256, /^[0-9a-f]{64}$/);
});

test('round trip of every manual part is byte-identical and extra files go to .removed', async t => {
  const { store, instance, home, points } = await fixture(t);
  const before = await snapshot(home);
  const point = await capture(points, instance, PARTS_BY_ACTION.manual);
  await fs.writeFile(path.join(home, 'plugins', 'beta.so'), Buffer.alloc(200, 2));
  await fs.writeFile(path.join(home, 'plugins', 'alpha.so'), Buffer.alloc(200, 9));
  await fs.writeFile(path.join(home, 'b3', 'extplugins', 'evil.py'), 'import os\n');
  await fs.unlink(path.join(home, 'b3', 'plugins', 'plugin_admin.ini'));
  await fs.writeFile(instance.configPath, 'set sv_hostname "changed"\n');
  await store.setPlugins('alpha', [{ name: 'beta', platform: 'linux', sha256: 'b'.repeat(64), bytes: 200, enabled: true, approvedAt: new Date().toISOString(), source: 'installed', config: {} }]);
  const result = await restoreInstanceParts(instance, point, PARTS_BY_ACTION.manual, { store });
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(await snapshot(home), before);
  assert.deepEqual(store.get('alpha').plugins, []);
  assert.equal((await fs.readdir(path.join(home, 'plugins', '.removed'))).some(name => name.startsWith('beta.so.')), true);
  assert.equal((await fs.readdir(path.join(home, 'b3', 'extplugins', '.removed'))).some(name => name.startsWith('evil.py.')), true);
  assert.equal(await fs.readFile(path.join(home, 'b3', 'b3.xml'), 'utf8'), '<secret password="hunter2"/>');
});

test('a crafted name in the point is refused before any write', async t => {
  const { store, instance, home, points } = await fixture(t);
  const point = await capture(points, instance, ['plugins']);
  const forged = { manifest: { ...point.manifest, files: [...point.manifest.files, { part: 'plugins', name: 'main/server.cfg', bytes: 1, sha256: 'a'.repeat(64) }] }, file: point.file };
  await fs.writeFile(path.join(home, 'plugins', 'beta.so'), Buffer.alloc(200, 2));
  await assert.rejects(restoreInstanceParts(instance, forged, ['plugins'], { store }), { code: 'RESTORE_POINT_INVALID' });
  assert.equal((await fs.readFile(path.join(home, 'plugins', 'beta.so'))).length, 200);
  const other = { manifest: { ...point.manifest, data: { record: { ...instance, id: 'beta' } }, parts: [...point.manifest.parts, 'record'] }, file: point.file };
  await assert.rejects(restoreInstanceParts(instance, other, ['record'], { store }), { code: 'RESTORE_POINT_INVALID' });
});

test('a linked plugin directory is refused', { skip: process.platform === 'win32' }, async t => {
  const { root, store, instance, home, points } = await fixture(t);
  const point = await capture(points, instance, ['plugins']);
  await fs.rename(path.join(home, 'plugins'), path.join(root, 'elsewhere'));
  await fs.symlink(path.join(root, 'elsewhere'), path.join(home, 'plugins'));
  await assert.rejects(restoreInstanceParts(instance, point, ['plugins'], { store }), { code: 'RESTORE_POINT_INVALID' });
});

test('pointBringsCode: plugins, core and B3 custom code need server.code, configs do not', async t => {
  const { instance, points } = await fixture(t);
  const point = await capture(points, instance, PARTS_BY_ACTION.manual);
  assert.equal(pointBringsCode(point.manifest, ['config', 'record']), false);
  assert.equal(pointBringsCode(point.manifest, ['plugins']), true);
  assert.equal(pointBringsCode(point.manifest, ['core']), true);
  assert.equal(pointBringsCode(point.manifest, ['b3files']), true);
  const configOnly = { ...point.manifest, files: point.manifest.files.filter(entry => !entry.name.startsWith('b3/extplugins/')) };
  assert.equal(pointBringsCode(configOnly, ['b3files']), false);
});
