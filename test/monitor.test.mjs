import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { diagnoseConsole, explainCause, lastConsoleLines } from '../lib/monitor-diagnose.mjs';
import { MonitorStore, monitorRange } from '../lib/monitor-store.mjs';
import { MonitorCollector } from '../lib/monitor-collector.mjs';
import { MonitorHost } from '../lib/monitor-host.mjs';

const tempDir = async t => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-monitor-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; };
const clock = start => { let now = start; return { now: () => now, advance: ms => { now += ms; } }; };

test('diagnose prefers an ERROR: line and recognises a clean shutdown', () => {
  assert.deepEqual(diagnoseConsole('loading mp_crash\nG_Spawn: no free entities\nERROR: Exceeded limit of 1000 \'xmodel\' assets\n----- Server Shutdown -----\n'), { reason: "ERROR: Exceeded limit of 1000 'xmodel' assets", clean: false });
  assert.deepEqual(diagnoseConsole('map_rotate\n==== ShutdownGame ====\n----- Server Shutdown -----\n'), { reason: null, clean: true });
  assert.deepEqual(diagnoseConsole('just running\n'), { reason: null, clean: false });
  assert.match(explainCause("ERROR: Exceeded limit of 1000 'xmodel' assets")[0], /Engine-Grenze/);
  assert.equal(explainCause('something odd'), null);
  assert.equal(lastConsoleLines(Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')).length, 40);
});

test('store keeps 24 h in memory, buckets history and reloads it from disk', async t => {
  const directory = await tempDir(t), time = clock(Date.UTC(2026, 10, 5, 12));
  const store = new MonitorStore({ directory, now: time.now });
  await store.load();
  for (let i = 0; i < 8; i++) { await store.append({ t: time.now(), id: 'a', s: 'RUNNING', up: i !== 3, ms: 10, p: i, max: 18, map: 'mp_crash' }); time.advance(15e3); }
  await store.append({ t: time.now(), id: 'b', s: 'STOPPED', up: false });
  await store.flush();
  const history = await store.history('a', '24h');
  assert.equal(history.polls, 8);
  assert.equal(history.availability, 7 / 8);
  assert.equal(history.points.reduce((max, point) => Math.max(max, point.players ?? 0), 0), 7);
  const reloaded = new MonitorStore({ directory, now: time.now });
  await reloaded.load();
  assert.equal((await reloaded.history('a', '24h')).polls, 8);
  assert.equal((await reloaded.history('a', '7d')).polls, 8, 'long ranges read the daily files');
  assert.throws(() => monitorRange('1y'), { code: 'MONITOR_RANGE_INVALID' });
});

test('store prunes daily files beyond the retention and skips torn lines', async t => {
  const directory = await tempDir(t), time = clock(Date.UTC(2026, 10, 5, 12));
  await fs.writeFile(path.join(directory, 'samples-2026-09-01.jsonl'), '{"t":1,"id":"a"}\n');
  await fs.writeFile(path.join(directory, 'samples-2026-11-05.jsonl'), `${JSON.stringify({ t: time.now() - 1000, id: 'a', up: true, p: 2 })}\n{"t":`);
  const store = new MonitorStore({ directory, retentionDays: 30, now: time.now });
  await store.load();
  assert.equal((await store.history('a')).polls, 1);
  assert.equal(await store.prune(), 1);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['samples-2026-11-05.jsonl']);
});

function fixture(t, { status = 'RUNNING', reply = { reachable: true, latencyMs: 4, hostname: 'Host', mapname: 'mp_crash', gametype: 'war', maxClients: 18, players: [{ name: 'Wolf', score: 1, ping: 40 }] } } = {}) {
  const time = clock(Date.UTC(2026, 10, 5, 12));
  const state = { status, pid: 1234, runId: 'run-1', startedAt: '2026-11-05T11:00:00.000Z' };
  const probe = { reply };
  const events = [];
  return (async () => {
    const store = new MonitorStore({ directory: await tempDir(t), now: time.now });
    await store.load();
    const collector = new MonitorCollector({
      listInstances: async () => [{ id: 'a', name: 'Alpha', port: 28960, homePath: '/srv/a' }],
      runtimeFor: async () => ({ state, reconcileRuntimeState: async () => {} }),
      probe: async () => { if (!probe.reply) throw Object.assign(new Error('RCON_TIMEOUT'), { code: 'RCON_TIMEOUT' }); return probe.reply; },
      readConsole: async () => ({ text: 'ERROR: Hunk_Alloc failed\n' }),
      store, now: time.now, onEvent: event => events.push(event),
    });
    return { time, state, probe, events, store, collector };
  })();
}

test('collector records live state without a password and tolerates a map change', async t => {
  const { time, probe, events, collector } = await fixture(t);
  await collector.tick();
  const live = collector.live('a');
  assert.deepEqual([live.up, live.map, live.players.length, live.latencyMs, live.name], [true, 'mp_crash', 1, 4, 'Alpha']);
  probe.reply = null;
  for (let i = 0; i < 2; i++) { time.advance(15e3); await collector.tick(); }
  assert.equal(events.length, 0, '30 s without an answer is still a map change');
  probe.reply = { reachable: true, latencyMs: 5, players: [] };
  time.advance(15e3); await collector.tick();
  assert.equal(events.length, 0);
});

test('collector declares an unresponsive server down after 45 s and back up later', async t => {
  const { time, probe, events, collector, store } = await fixture(t);
  await collector.tick();
  probe.reply = null;
  for (let i = 0; i < 4; i++) { time.advance(15e3); await collector.tick(); }
  assert.deepEqual(events.map(event => event.kind), ['down']);
  assert.equal(events[0].cause.kind, 'unresponsive');
  assert.match(events[0].cause.reason, /Hunk_Alloc/);
  assert.ok(events[0].cause.hint);
  probe.reply = { reachable: true, latencyMs: 5, players: [] };
  time.advance(15e3); await collector.tick();
  assert.deepEqual(events.map(event => event.kind), ['down', 'up']);
  assert.equal(events[1].downMs, 60e3);
  assert.deepEqual(store.events('a', '24h').map(event => event.kind), ['up', 'down']);
});

test('a crash is reported at once, a planned stop once and without follow-ups', async t => {
  const crash = await fixture(t);
  await crash.collector.tick();
  Object.assign(crash.state, { status: 'FAILED', pid: null, exitCode: 139 });
  crash.time.advance(15e3); await crash.collector.tick();
  assert.equal(crash.events[0].cause.kind, 'crash');
  assert.equal(crash.events[0].cause.exitCode, 139);
  const stop = await fixture(t);
  await stop.collector.tick();
  Object.assign(stop.state, { status: 'STOPPED', pid: null });
  for (let i = 0; i < 5; i++) { stop.time.advance(15e3); await stop.collector.tick(); }
  assert.deepEqual(stop.events.map(event => [event.kind, event.cause.kind]), [['down', 'stopped']]);
});

test('a server that was never up produces no outage', async t => {
  const { time, events, collector } = await fixture(t, { status: 'STOPPED' });
  for (let i = 0; i < 5; i++) { await collector.tick(); time.advance(15e3); }
  assert.equal(events.length, 0);
  assert.equal(collector.live('a').up, false);
});

test('host sample derives CPU share from deltas and reads free disk space', async () => {
  let idle = 100, user = 100;
  const fakeOs = { cpus: () => [{ times: { user, nice: 0, sys: 0, idle, irq: 0 } }], totalmem: () => 1000, freemem: () => 250, uptime: () => 42 };
  const host = new MonitorHost({ osModule: fakeOs, statfs: async () => ({ bavail: 10, bsize: 4096, blocks: 40 }) });
  assert.equal((await host.sample(['/srv'])).cpuPercent, null, 'no delta on the first sample');
  idle = 150; user = 200;
  const sample = await host.sample(['/srv', '/srv']);
  assert.equal(sample.memory.usedPercent, 75);
  assert.deepEqual(sample.disks, [{ path: '/srv', freeBytes: 40960, totalBytes: 163840 }]);
  assert.equal(sample.cpuPercent, 66.7);
});

test('Block 18b: probe and readConsole receive the instance, the host sample only local homes', async t => {
  const time = clock(Date.UTC(2026, 10, 8, 12));
  const store = new MonitorStore({ directory: await tempDir(t), now: time.now });
  await store.load();
  const probes = [], consoles = [], sampled = [];
  const state = { status: 'RUNNING', pid: 1, runId: 'r' };
  const collector = new MonitorCollector({
    listInstances: async () => [{ id: 'alpha', name: 'Local', port: 28960, homePath: '/srv/alpha' }, { id: 'rmt_alpha', name: 'Remote', port: 28960, remote: true }],
    runtimeFor: async () => ({ state, reconcileRuntimeState: async () => {} }),
    probe: async (port, instance) => { probes.push([port, instance.id]); return instance.remote ? { reachable: true, latencyMs: 9, players: [{ name: 'R', score: 0, ping: 1 }] } : { reachable: true, latencyMs: 2, players: [] }; },
    readConsole: async (homePath, instance) => { consoles.push(instance.id); return { text: '' }; },
    host: { sample: async homes => { sampled.push(homes); return {}; } },
    store, now: time.now,
  });
  await collector.tick();
  assert.deepEqual(probes.sort(), [[28960, 'alpha'], [28960, 'rmt_alpha']]);
  assert.deepEqual(sampled, [['/srv/alpha']]);
  assert.deepEqual([collector.live('alpha').players.length, collector.live('rmt_alpha').players.length], [0, 1], 'a local and a remote server with the same name stay apart');
  assert.deepEqual([store.history('alpha', '24h') !== null, store.history('rmt_alpha', '24h') !== null], [true, true]);
});
