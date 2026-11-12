import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RestorePointStore, validSubject, subjectDirectory } from '../lib/restore-points.mjs';

async function fixture(action, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-rp-'));
  let tick = Date.parse('2026-11-12T00:00:00.000Z');
  const store = new RestorePointStore({ root, now: () => new Date(tick += 1000), ...options });
  try { await action(store, root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const entries = [
  { part: 'config', name: 'main/server.cfg', bytes: Buffer.from('set sv_hostname "A"\n') },
  { part: 'plugins', name: 'plugins/a.so', bytes: Buffer.from([0, 1, 2, 3]) },
];

test('capture then read returns identical bytes and manifest hashes', () => fixture(async store => {
  const { pointId, manifest } = await store.capture('local:alpha', { action: 'config.change', actor: 'admin', entries, data: { record: { id: 'alpha' } }, refs: { core: { version: '21.5' } } });
  assert.match(pointId, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  assert.deepEqual(manifest.parts, ['config', 'core', 'plugins', 'record']);
  const point = await store.read('local:alpha', pointId);
  assert.deepEqual(point.manifest, manifest);
  assert.deepEqual(point.file('config', 'main/server.cfg'), entries[0].bytes);
  assert.deepEqual(point.file('plugins', 'plugins/a.so'), entries[1].bytes);
  assert.deepEqual(point.manifest.data.record, { id: 'alpha' });
  assert.equal(point.manifest.totalBytes, entries[0].bytes.length + entries[1].bytes.length);
  assert.throws(() => point.file('plugins', 'plugins/missing.so'), { code: 'RESTORE_POINT_INVALID' });
}));

test('list is newest first and marks a tampered file valid:false without content', () => fixture(async (store, root) => {
  const first = await store.capture('local:alpha', { action: 'config.change', entries });
  const second = await store.capture('local:alpha', { action: 'plugin.change', entries });
  await fs.writeFile(path.join(root, 'local_alpha', first.pointId, 'files', 'config', 'main', 'server.cfg'), 'tampered', { mode: 0o600 });
  const list = await store.list('local:alpha');
  assert.deepEqual(list.map(item => item.pointId), [second.pointId, first.pointId]);
  assert.equal(list[0].valid, true);
  assert.equal(list[0].action, 'plugin.change');
  assert.equal(list[1].valid, false);
  assert.equal(Object.hasOwn(list[1], 'files'), false);
  await assert.rejects(store.read('local:alpha', first.pointId), { code: 'RESTORE_POINT_INVALID' });
  assert.deepEqual(await store.list('local:other'), []);
}));

test('read refuses unsafe manifest names and unknown parts', () => fixture(async (store, root) => {
  for (const name of ['../escape', '/abs', 'a\\..\\b', 'a/../../b', '', 'x\u0000y']) {
    await assert.rejects(store.capture('local:alpha', { action: 'manual', entries: [{ part: 'config', name, bytes: Buffer.from('x') }] }), { code: 'RESTORE_POINT_INVALID' }, name);
  }
  await assert.rejects(store.capture('local:alpha', { action: 'manual', entries: [{ part: 'secrets', name: 'a', bytes: Buffer.from('x') }] }), { code: 'RESTORE_POINT_INVALID' });
  const { pointId } = await store.capture('local:alpha', { action: 'manual', entries });
  const file = path.join(root, 'local_alpha', pointId, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const bad of [{ ...manifest.files[0], name: '../../x' }, { ...manifest.files[0], part: 'vault' }]) {
    await fs.writeFile(file, JSON.stringify({ ...manifest, files: [bad, manifest.files[1]] }), { mode: 0o600 });
    await assert.rejects(store.read('local:alpha', pointId), { code: 'RESTORE_POINT_INVALID' });
  }
  await assert.rejects(store.read('local:alpha', '../x'), { code: 'RESTORE_POINT_INVALID' });
  await assert.rejects(store.read('local:alpha', '20261112T000000Z-deadbeef'), { code: 'RESTORE_POINT_NOT_FOUND' });
}));

test('capture above maxBytes throws RESTORE_POINT_TOO_LARGE and leaves no directory', () => fixture(async (store, root) => {
  await assert.rejects(store.capture('local:alpha', { action: 'manual', entries: [{ part: 'b3sqlite', name: 'b3/b3.db', bytes: Buffer.alloc(11) }] }), { code: 'RESTORE_POINT_TOO_LARGE' });
  const names = await fs.readdir(path.join(root, 'local_alpha')).catch(() => []);
  assert.deepEqual(names, []);
}, { maxBytes: 10 }));

test('a capture that fails mid-write leaves no point and no temporary directory', () => fixture(async (store, root) => {
  let calls = 0;
  store.writeFile = async (...args) => { if (++calls === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return fs.writeFile(...args); };
  await assert.rejects(store.capture('local:alpha', { action: 'manual', entries }), { code: 'RESTORE_POINT_FAILED' });
  assert.deepEqual(await fs.readdir(path.join(root, 'local_alpha')), []);
}));

test('pruning keeps the newest automatic and manual points and never the recovery point', () => fixture(async store => {
  const automatic = [];
  automatic.push((await store.capture('local:alpha', { action: 'config.change', entries })).pointId);
  await store.markRecovery('local:alpha', automatic[0]);
  for (let index = 1; index < 4; index++) automatic.push((await store.capture('local:alpha', { action: 'config.change', entries })).pointId);
  const manual = [];
  for (let index = 0; index < 3; index++) manual.push((await store.capture('local:alpha', { action: 'manual', manual: true, entries })).pointId);
  const kept = (await store.list('local:alpha')).map(item => item.pointId).sort();
  assert.deepEqual(kept, [automatic[0], automatic[2], automatic[3], manual[1], manual[2]].sort());
  assert.equal((await store.recovery('local:alpha')).pointId, automatic[0]);
  await store.clearRecovery('local:alpha');
  assert.equal(await store.recovery('local:alpha'), null);
}, { maxAutomatic: 2, maxManual: 2 }));

test('subjects map to distinct safe directories', () => {
  assert.equal(subjectDirectory('local:a'), 'local_a');
  assert.equal(subjectDirectory('remote:a'), 'remote_a');
  assert.equal(subjectDirectory('default-runtime'), 'default-runtime');
  for (const bad of ['local:../x', 'local:', 'local:A', 'other:a', 'default-runtime:x', 'local:con', 42]) assert.throws(() => validSubject(bad), { code: 'RESTORE_POINT_INVALID' }, String(bad));
});

test('a group-writable point directory is refused', { skip: process.platform !== 'linux' }, () => fixture(async (store, root) => {
  const { pointId } = await store.capture('local:alpha', { action: 'manual', entries });
  await fs.chmod(path.join(root, 'local_alpha', pointId), 0o770);
  await assert.rejects(store.read('local:alpha', pointId), { code: 'RESTORE_POINT_INVALID' });
}));
