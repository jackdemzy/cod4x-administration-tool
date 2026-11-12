import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RestorePointStore } from '../lib/restore-points.mjs';
import { guardedChange } from '../lib/restore-guard.mjs';

async function fixture(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-guard-'));
  const events = [];
  try { await action(new RestorePointStore({ root }), (level, event, details) => events.push({ level, event, details }), events); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const captured = async () => ({ entries: [{ part: 'config', name: 'main/server.cfg', bytes: Buffer.from('old') }], data: {}, refs: {} });
const failing = code => async () => { throw Object.assign(new Error(code), { code }); };

test('a passing verify returns the result and point id without rollback', () => fixture(async (store, audit, events) => {
  let rolledBack = false;
  const outcome = await guardedChange({ store, subject: 'local:a', action: 'config.change', actor: 'admin', audit, capture: captured, change: async () => 'done', verify: async result => assert.equal(result, 'done'), rollback: async () => { rolledBack = true; } });
  assert.equal(outcome.result, 'done');
  assert.match(outcome.restorePointId, /Z-[0-9a-f]{8}$/);
  assert.equal(rolledBack, false);
  assert.deepEqual(events.map(entry => entry.event), ['restore_point.created', 'change.verified']);
  assert.deepEqual(Object.keys(events[0].details).sort(), ['action', 'restorePointId', 'subject']);
}));

for (const where of ['change', 'verify']) {
  test(`a failing ${where} rolls back from the captured point and keeps the original code`, () => fixture(async (store, audit, events) => {
    let seen = null;
    const error = await guardedChange({ store, subject: 'local:a', action: 'plugin.change', audit, capture: captured,
      change: where === 'change' ? failing('PLUGIN_INSTALL_VERIFY_FAILED') : async () => 'x',
      verify: where === 'verify' ? failing('PLUGIN_INTEGRITY_FAILED') : async () => {},
      rollback: async point => { seen = point.file('config', 'main/server.cfg').toString(); } }).catch(caught => caught);
    assert.equal(error.code, where === 'change' ? 'PLUGIN_INSTALL_VERIFY_FAILED' : 'PLUGIN_INTEGRITY_FAILED');
    assert.equal(error.rolledBack, true);
    assert.match(error.restorePointId, /Z-[0-9a-f]{8}$/);
    assert.equal(seen, 'old');
    assert.equal(events.at(-1).event, 'change.rolled_back');
    assert.equal(await store.recovery('local:a'), null);
  }));
}

test('a failing rollback marks the subject RECOVERY_REQUIRED and blocks the next change', () => fixture(async (store, audit, events) => {
  const error = await guardedChange({ store, subject: 'local:a', action: 'core.change', audit, capture: captured, change: failing('INSTANCE_CORE_INVALID'), verify: async () => {}, rollback: failing('EACCES') }).catch(caught => caught);
  assert.equal(error.code, 'INSTANCE_CORE_INVALID');
  assert.equal(error.rolledBack, false);
  assert.equal(error.recoveryRequired, true);
  assert.equal((await store.recovery('local:a')).pointId, error.restorePointId);
  assert.equal(events.at(-1).event, 'change.rollback_failed');
  let captureCalled = false;
  await assert.rejects(guardedChange({ store, subject: 'local:a', action: 'config.change', capture: async () => { captureCalled = true; return captured(); }, change: async () => {}, verify: async () => {}, rollback: async () => {} }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(captureCalled, false);
}));

test('a failing capture never runs the change', () => fixture(async store => {
  let changed = false;
  await assert.rejects(guardedChange({ store, subject: 'local:a', action: 'config.change', capture: failing('EIO'), change: async () => { changed = true; }, verify: async () => {}, rollback: async () => {} }), { code: 'RESTORE_POINT_FAILED' });
  await assert.rejects(guardedChange({ store, subject: 'local:a', action: 'config.change', capture: async () => ({ entries: [{ part: 'nope', name: 'x', bytes: Buffer.from('') }] }), change: async () => { changed = true; }, verify: async () => {}, rollback: async () => {} }), { code: 'RESTORE_POINT_FAILED' });
  assert.equal(changed, false);
}));
