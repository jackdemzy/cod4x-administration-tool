import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRemoteMonitor } from '../lib/remote-monitor.mjs';
import { RemoteSessionPool } from '../lib/remote-session-pool.mjs';
import { createLoopbackServer, loopbackAvailable } from './support/loopback-transport.mjs';
import { startFakeCod4xServer } from './support/fake-cod4x-udp.mjs';

const skip = (await loopbackAvailable()) ? false : 'needs Linux and a non-root user';

async function setup(t, { statuses = {} } = {}) {
  const loopback = await createLoopbackServer();
  const fakes = await Promise.all([1, 2, 3].map(index => startFakeCod4xServer({ hostname: `Remote ${index}`, statusPlayers: [{ score: index, ping: 30, name: `P${index}` }] })));
  t.after(async () => { for (const fake of fakes) fake.close(); await loopback.cleanup(); });
  const records = fakes.map((fake, index) => ({ id: `srv-${index + 1}`, name: `Server ${index + 1}`, hostId: 'lab-1', port: fake.port, home: loopback.path(`srv-${index + 1}`) }));
  const instances = { list: () => records.map(record => ({ ...record })), get: id => { const record = records.find(entry => entry.id === id); if (!record) throw Object.assign(new Error('x'), { code: 'REMOTE_INSTANCE_NOT_FOUND' }); return { ...record }; } };
  const connects = [];
  const pool = new RemoteSessionPool({ connect: async hostId => { connects.push(hostId); return { session: { ...loopback.session, exec: loopback.session.exec, close() {} }, uid: process.getuid(), gid: process.getgid() }; } });
  t.after(() => pool.closeAll());
  const manager = { savedRuntime: async id => instances.get(id) && statuses[id] || { status: 'RUNNING', pid: 100, runId: `run-${id}`, startedAt: '2026-11-08T10:00:00.000Z' } };
  return { loopback, fakes, records, connects, monitor: createRemoteMonitor({ pool, instances, manager }) };
}

test('remote instances are listed with rmt_ ids and their own port', { skip }, async t => {
  const { monitor, records } = await setup(t);
  const listed = await monitor.listInstances();
  assert.deepEqual(listed.map(entry => [entry.id, entry.name, entry.port, entry.remote]), records.map(record => [`rmt_${record.id}`, record.name, record.port, true]));
  assert.ok(listed.every(entry => entry.homePath === undefined), 'no local home: the host sample is for this PC only');
});

test('one poll of three remote servers on one host uses one SSH connection, and the runtime needs none', { skip }, async t => {
  const { monitor, connects } = await setup(t);
  const listed = await monitor.listInstances();
  const runtimes = await Promise.all(listed.map(async entry => { const runtime = await monitor.runtimeFor(entry.id); await runtime.reconcileRuntimeState(); return runtime.state; }));
  assert.deepEqual(connects, [], 'the saved state is read without a connection');
  assert.ok(runtimes.every(state => state.status === 'RUNNING'));
  const replies = await Promise.all(listed.map(entry => monitor.probe(entry.port, entry)));
  assert.deepEqual(replies.map(reply => [reply.reachable, reply.hostname, reply.players.length]), [[true, 'Remote 1', 1], [true, 'Remote 2', 1], [true, 'Remote 3', 1]]);
  assert.ok(replies.every(reply => Number.isFinite(reply.latencyMs)));
  await Promise.all(listed.map(entry => monitor.probe(entry.port, entry)));
  assert.deepEqual(connects, ['lab-1'], 'the next poll reuses the session');
});

test('a silent server is not reachable; an unknown rmt_ id is refused', { skip }, async t => {
  const { monitor, fakes } = await setup(t);
  fakes[1].state.silent = true;
  const listed = await monitor.listInstances();
  await assert.rejects(monitor.probe(listed[1].port, listed[1]));
  await assert.rejects(monitor.runtimeFor('rmt_nope').then(runtime => runtime.reconcileRuntimeState()), { code: 'REMOTE_INSTANCE_NOT_FOUND' });
  await assert.rejects(monitor.runtimeFor('alpha'), { code: 'REMOTE_INSTANCE_INVALID' });
});

test('the crash cause reads the end of the remote console, bounded and without secrets', { skip }, async t => {
  const { monitor, records } = await setup(t);
  await fs.mkdir(`${records[0].home}/main`, { recursive: true });
  await fs.writeFile(`${records[0].home}/main/qconsole.log`, `${'x'.repeat(200_000)}\nset rcon_password "Secret-Pw-1"\nERROR: Hunk_Alloc failed\n`);
  const listed = await monitor.listInstances();
  const log = await monitor.readConsole(undefined, listed[0]);
  assert.match(log.text, /Hunk_Alloc failed/);
  assert.ok(log.text.length <= 65536 + 1024);
  assert.ok(!log.text.includes('Secret-Pw-1'));
  assert.deepEqual(await monitor.readConsole(undefined, listed[1]), { text: '' }, 'a missing console log is empty text');
});
