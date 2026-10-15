import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRuntimeManager } from '../lib/runtime-manager.mjs';

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-persistence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'runtime-state.json');
  const runtime = createRuntimeManager({ path, fs: { ...fs, ...overrides }, crypto, process,
    SERVER_CORE_DEFINITIONS: { windows: { executable: 'cod4x18_dedrun.exe' }, linux: { executable: 'cod4x18_dedrun' } },
  }, { stateFile });
  return { root, stateFile, runtime };
}

test('write failure rejects, remains visible, and permits a later durable retry', async t => {
  let fail = true;
  const f = await fixture(t, { writeFile: async (...args) => {
    if (fail) throw Object.assign(new Error('injected disk failure'), { code: 'ENOSPC' });
    return fs.writeFile(...args);
  } });
  await assert.rejects(f.runtime.persistRuntimeState(), { code: 'RUNTIME_PERSISTENCE_FAILED' });
  assert.equal(f.runtime.state.persistenceError.causeCode, 'ENOSPC');
  fail = false;
  await f.runtime.persistRuntimeState();
  assert.equal(f.runtime.state.persistenceError, null);
  assert.equal(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).persistenceError, null);
});

test('failed rename preserves the previous checkpoint and removes its temporary file', async t => {
  let fail = false;
  const f = await fixture(t, { rename: async (...args) => {
    if (fail) throw Object.assign(new Error('injected rename denial'), { code: 'EACCES' });
    return fs.rename(...args);
  } });
  await f.runtime.persistRuntimeState();
  const before = await fs.readFile(f.stateFile, 'utf8');
  fail = true;
  f.runtime.state.lastError = 'new state';
  await assert.rejects(f.runtime.persistRuntimeState(), { code: 'RUNTIME_PERSISTENCE_FAILED' });
  assert.equal(await fs.readFile(f.stateFile, 'utf8'), before);
  assert.deepEqual(await fs.readdir(f.root), ['runtime-state.json']);
});

test('a burst coalesces into one pending snapshot and saves the latest state', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const f = await fixture(t, { writeFile: async (...args) => {
    writes++;
    if (writes === 1) await gate;
    return fs.writeFile(...args);
  } });
  const pending = [f.runtime.persistRuntimeState()];
  for (let i = 0; i < 2000; i++) {
    f.runtime.state.lastError = String(i);
    pending.push(f.runtime.persistRuntimeState());
  }
  release();
  await Promise.all(pending);
  assert.ok(writes <= 2, `unexpected write backlog: ${writes}`);
  assert.equal(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).lastError, '1999');
});
