import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RemoteStateStore } from '../lib/remote-runtime-state.mjs';

const RUN = '0123abcd-0123-0123-0123-0123456789ab';
const state = overrides => ({
  status: 'RUNNING', runId: RUN, pid: 4242, createdAt: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:777',
  startedAt: '2026-11-07T10:00:00.000Z', recoveryBlocked: false, exitReason: null, ...overrides,
});
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code, code);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-remote-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: new RemoteStateStore({ root }), file: id => path.join(root, id, 'runtime-state.json') };
}

test('read gives null when nothing is stored; a written state comes back with an update time', async t => {
  const { store } = await fixture(t);
  assert.equal(await store.read('public-01'), null);
  const written = await store.write('public-01', state());
  assert.match(written.updatedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(await store.read('public-01'), written);
  assert.deepEqual(Object.keys(written).sort(), ['createdAt', 'exitReason', 'pid', 'recoveryBlocked', 'runId', 'startedAt', 'status', 'updatedAt']);
});

test('states are separate per instance, private on disk and written atomically', async t => {
  const { store, file, root } = await fixture(t);
  await store.write('public-01', state({ pid: 1001 })); await store.write('public-02', state({ pid: 1002 }));
  assert.equal((await store.read('public-01')).pid, 1001);
  assert.equal((await store.read('public-02')).pid, 1002);
  if (process.platform === 'linux') {
    assert.equal((await fs.stat(file('public-01'))).mode & 0o077, 0);
    assert.equal((await fs.stat(path.join(root, 'public-01'))).mode & 0o077, 0);
  }
  assert.ok(!(await fs.readdir(path.join(root, 'public-01'))).some(name => name.includes('.tmp-')));
});

test('the state never holds more than the fixed fields: no arguments, no paths, no secrets', async t => {
  const { store } = await fixture(t);
  await rejects(store.write('public-01', state({ args: ['+set', 'rcon_password', 'x'] })), 'REMOTE_STATE_INVALID');
  await rejects(store.write('public-01', state({ home: '/srv/x' })), 'REMOTE_STATE_INVALID');
  assert.equal(await store.read('public-01'), null);
});

test('invalid values are refused on write', async t => {
  const { store } = await fixture(t);
  for (const bad of [{ status: 'DONE' }, { status: undefined }, { runId: 'x' }, { pid: 1 }, { pid: 0 }, { pid: 1.5 }, { pid: '5' }, { pid: 5_000_000 },
    { createdAt: 5 }, { startedAt: 'yesterday' }, { recoveryBlocked: 'no' }, { exitReason: 'a'.repeat(70) }, { exitReason: 'lower case' }]) {
    await rejects(store.write('public-01', state(bad)), 'REMOTE_STATE_INVALID');
  }
  for (const id of ['', 'Bad Id', '../x', 'a/b', 5]) await rejects(store.write(id, state()), 'REMOTE_STATE_INVALID');
  await rejects(store.read('../x'), 'REMOTE_STATE_INVALID');
  // STOPPED and FAILED may have no process
  await store.write('public-01', state({ status: 'STOPPED', pid: null, runId: null, createdAt: null, startedAt: null }));
  await store.write('public-01', state({ status: 'FAILED', pid: null, exitReason: 'PROCESS_GONE' }));
});

test('a damaged state file fails closed on read and is not replaced', async t => {
  const { store, file } = await fixture(t);
  await store.write('public-01', state());
  for (const text of ['{ not json', JSON.stringify({ version: 2, state: state() }), JSON.stringify({ version: 1, state: { ...state(), status: 'BOGUS' } }), JSON.stringify({ version: 1 }), '']) {
    await fs.writeFile(file('public-01'), text);
    await rejects(store.read('public-01'), 'REMOTE_STATE_INVALID');
    assert.equal(await fs.readFile(file('public-01'), 'utf8'), text);
  }
});

test('clear removes the state and tolerates a missing one', async t => {
  const { store } = await fixture(t);
  await store.write('public-01', state());
  await store.clear('public-01');
  assert.equal(await store.read('public-01'), null);
  await store.clear('public-01');
});
