import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRemoteFixture, alive, until } from './support/remote-fixture.mjs';
import { loopbackAvailable } from './support/loopback-transport.mjs';
import { startFakeCod4xServer } from './support/fake-cod4x-udp.mjs';

const available = await loopbackAvailable();
const skip = available ? false : 'needs Linux, a non-root user, gcc and setsid';
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code, code);
const cmdline = async pid => (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').slice(0, -1);
const managedArguments = (instance, { ipv4 = '127.0.0.1', ipv6 = '::1' } = {}) => [
  instance.core.path, '+set', 'dedicated', '2', '+set', 'fs_basepath', instance.basePath, '+set', 'fs_homepath', instance.home,
  '+set', 'net_port', String(instance.port), '+set', 'net_ip', ipv4, '+set', 'net_port6', String(instance.port), '+set', 'net_ip6', ipv6,
  '+exec', 'server.cfg', '+set', 'logfile', '2', '+map', 'mp_backlot',
];

test('start runs the core with the managed arguments and no secret argument, and reports RUNNING', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const instance = await f.install('public-01');
  const result = await f.manager.start('public-01');
  assert.equal(result.runtime.status, 'RUNNING');
  const { pid, runId } = result.runtime;
  assert.ok(alive(pid));
  assert.match(runId, /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.deepEqual(await cmdline(pid), managedArguments(instance));
  assert.ok(!(await cmdline(pid)).some(argument => /rcon_password|sv_authtoken|password|token/i.test(argument)));
  const saved = await f.state.read('public-01');
  assert.deepEqual([saved.status, saved.pid, saved.runId, saved.recoveryBlocked], ['RUNNING', pid, runId, false]);
  assert.match(saved.createdAt, /^[a-f0-9-]{36}:\d+$/);
  assert.ok(f.audits.some(entry => entry.event === 'remote.instance.started' && entry.instanceId === 'public-01'));
  assert.equal(f.closes.length, f.connects.length, 'every connection was closed');
});

test('a public network uses the public bind addresses', { skip }, async t => {
  const f = await createRemoteFixture(t);
  await f.install('public-01');
  const instance = await f.instances.setNetwork('public-01', { scope: 'PUBLIC', publicAddress: null });
  const { runtime } = await f.manager.start('public-01');
  assert.deepEqual(await cmdline(runtime.pid), managedArguments(instance, { ipv4: '0.0.0.0', ipv6: '::' }));
});

test('start refuses a bad server.cfg before any process exists: another instance port, symlink, hard link, too large, missing', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const one = await f.install('public-01'); const two = await f.install('public-02');
  const cfg = one.home + '/main/server.cfg';
  const original = await fs.readFile(cfg, 'utf8');
  const cases = [
    () => fs.writeFile(cfg, `set sv_hostname "x"\nset net_port "${two.port}"\n`),
    async () => { await fs.writeFile(cfg, original); await fs.rm(cfg); await fs.symlink(two.home + '/main/server.cfg', cfg); },
    async () => { await fs.rm(cfg); await fs.writeFile(cfg, original); await fs.link(cfg, one.home + '/main/alias.cfg'); },
    async () => { await fs.rm(one.home + '/main/alias.cfg'); await fs.writeFile(cfg, `set sv_hostname "${'x'.repeat(300_000)}"\n`); },
    async () => { await fs.rm(cfg); },
  ];
  for (const breakIt of cases) {
    await breakIt();
    await rejects(f.manager.start('public-01'), 'INSTANCE_CONFIG_INVALID');
    assert.equal(await f.state.read('public-01'), null, 'no state was written, so nothing was started');
    await fs.rm(cfg, { force: true }); await fs.writeFile(cfg, original);
  }
  assert.equal((await f.manager.start('public-01')).runtime.status, 'RUNNING', 'a good config starts');
});

test('start refuses a changed core and a damaged base game, and never starts a process', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const instance = await f.install('public-01');
  await fs.appendFile(instance.core.path, 'tampered');
  await rejects(f.manager.start('public-01'), 'REMOTE_CORE_CHANGED');
  assert.equal(await f.state.read('public-01'), null);
  await fs.writeFile(instance.core.path, await fs.readFile(f.corePath), { mode: 0o755 });
  await fs.rm(f.loopback.path('game', 'zone'), { recursive: true });
  await assert.rejects(f.manager.start('public-01'), error => error.code === 'REMOTE_BASEGAME_INVALID' && error.reasons[0].code === 'REMOTE_BASEGAME_ZONE_MISSING');
  assert.equal(await f.state.read('public-01'), null);
});

test('a second start while running is refused and does not spawn another process', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const instance = await f.install('public-01');
  const { runtime } = await f.manager.start('public-01');
  await rejects(f.manager.start('public-01'), 'REMOTE_ALREADY_RUNNING');
  assert.equal((await f.manager.status('public-01')).runtime.pid, runtime.pid);
  const processes = (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name));
  let cores = 0;
  for (const name of processes) { try { if ((await fs.readlink(`/proc/${name}/exe`)) === instance.core.path) cores++; } catch { /* gone */ } }
  assert.equal(cores, 1);
});

test('status after an external kill shows FAILED, after a stop through CONTROL STOPPED; a stopped state needs no connection', { skip }, async t => {
  const f = await createRemoteFixture(t);
  await f.install('public-01');
  const { runtime } = await f.manager.start('public-01');
  process.kill(runtime.pid, 'SIGKILL');
  assert.ok(await until(() => !alive(runtime.pid)));
  const failed = await f.manager.status('public-01');
  assert.deepEqual([failed.runtime.status, failed.runtime.exitReason, failed.runtime.pid], ['FAILED', 'PROCESS_GONE', null]);
  assert.equal(failed.runtime.runId, runtime.runId, 'the last run stays known, so its logs can be read');
  const before = f.connects.length;
  assert.equal((await f.manager.status('public-01')).runtime.status, 'FAILED');
  assert.equal(f.connects.length, before, 'no connection for an inactive state');
  const restarted = await f.manager.start('public-01');
  assert.notEqual(restarted.runtime.pid, runtime.pid);
  const stopped = await f.manager.stop('public-01');
  assert.deepEqual([stopped.runtime.status, stopped.runtime.pid, stopped.runtime.exitReason], ['STOPPED', null, null]);
  assert.ok(!alive(restarted.runtime.pid));
});

test('stop ends only this instance core; a sibling on the same host keeps running', { skip }, async t => {
  const f = await createRemoteFixture(t);
  await f.install('public-01'); await f.install('public-02');
  const one = (await f.manager.start('public-01')).runtime, two = (await f.manager.start('public-02')).runtime;
  await f.manager.stop('public-01');
  assert.ok(!alive(one.pid));
  assert.ok(alive(two.pid));
  assert.equal((await f.manager.status('public-02')).runtime.status, 'RUNNING');
  assert.ok(f.loopback.session.calls.includes(`kill -s TERM ${one.pid}`));
  assert.ok(!f.loopback.session.calls.some(command => command.includes(`kill -s TERM ${two.pid}`)));
});

test('stop escalates to KILL for a core that ignores TERM', { skip }, async t => {
  const f = await createRemoteFixture(t, { ignoreTerm: true });
  await f.install('public-01');
  const { runtime } = await f.manager.start('public-01');
  const stopped = await f.manager.stop('public-01');
  assert.equal(stopped.runtime.status, 'STOPPED');
  assert.ok(!alive(runtime.pid));
  const calls = f.loopback.session.calls;
  assert.ok(calls.indexOf(`kill -s TERM ${runtime.pid}`) >= 0 && calls.indexOf(`kill -s KILL ${runtime.pid}`) > calls.indexOf(`kill -s TERM ${runtime.pid}`));
});

test('a process that is not ours (reused pid) is never signalled', { skip }, async t => {
  const f = await createRemoteFixture(t);
  await f.install('public-01');
  const stranger = spawn('sleep', ['60'], { stdio: 'ignore' });
  t.after(() => stranger.kill('SIGKILL'));
  await f.state.write('public-01', { status: 'RUNNING', runId: '0123abcd-0123-0123-0123-0123456789ab', pid: stranger.pid, createdAt: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:1', startedAt: new Date().toISOString(), recoveryBlocked: false, exitReason: null });
  const stopped = await f.manager.stop('public-01');
  assert.equal(stopped.runtime.status, 'STOPPED');
  assert.ok(alive(stranger.pid), 'the other program was not touched');
  assert.ok(!f.loopback.session.calls.some(command => command.startsWith('kill ')));
});

test('a lost connection during start leaves STARTING with recoveryBlocked, a retry spawns nothing, and recover adopts the core', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const instance = await f.install('public-01');
  const real = f.control.session;
  f.control.session = Object.create(real);
  f.control.session.exec = async (command, options) => {
    const result = await real.exec(command, options);
    if (command.startsWith('setsid ')) throw Object.assign(new Error('REMOTE_CONNECT_FAILED'), { code: 'REMOTE_CONNECT_FAILED' });
    return result;
  };
  await rejects(f.manager.start('public-01'), 'REMOTE_RECOVERY_BLOCKED');
  const saved = await f.state.read('public-01');
  assert.deepEqual([saved.status, saved.pid, saved.recoveryBlocked], ['STARTING', null, true]);
  f.control.session = real;
  await rejects(f.manager.start('public-01'), 'REMOTE_RECOVERY_BLOCKED');
  const running = async () => { let found = []; for (const name of await fs.readdir('/proc')) { if (!/^\d+$/.test(name)) continue; try { if ((await fs.readlink(`/proc/${name}/exe`)) === instance.core.path) found.push(Number(name)); } catch { /* gone */ } } return found; };
  const strays = await running();
  assert.equal(strays.length, 1, 'the core of the lost start is running, and only that one');
  const recovered = await f.manager.recover('public-01');
  assert.deepEqual([recovered.runtime.status, recovered.runtime.pid, recovered.runtime.recoveryBlocked], ['RUNNING', strays[0], false]);
  assert.equal((await f.manager.stop('public-01')).runtime.status, 'STOPPED');
  assert.ok(!alive(strays[0]));
});

test('recover finds nothing when the start never happened, and a start works again afterwards', { skip }, async t => {
  const f = await createRemoteFixture(t);
  await f.install('public-01');
  const real = f.control.session;
  f.control.session = Object.create(real);
  f.control.session.exec = async (command, options) => {
    if (command.startsWith('setsid ')) throw Object.assign(new Error('REMOTE_CONNECT_FAILED'), { code: 'REMOTE_CONNECT_FAILED' });
    return real.exec(command, options);
  };
  await rejects(f.manager.start('public-01'), 'REMOTE_RECOVERY_BLOCKED');
  f.control.session = real;
  const recovered = await f.manager.recover('public-01');
  assert.deepEqual([recovered.runtime.status, recovered.runtime.recoveryBlocked], ['STOPPED', false]);
  assert.equal((await f.manager.start('public-01')).runtime.status, 'RUNNING');
  await rejects(f.manager.recover('public-01'), 'REMOTE_NOTHING_TO_RECOVER');
});

test('a start that cannot create its output files fails cleanly without a process or a block', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const instance = await f.install('public-01');
  await fs.chmod(`${instance.home}/logs`, 0o500);
  await rejects(f.manager.start('public-01'), 'REMOTE_START_FAILED');
  await fs.chmod(`${instance.home}/logs`, 0o700);
  const saved = await f.state.read('public-01');
  assert.deepEqual([saved.status, saved.pid, saved.recoveryBlocked, saved.exitReason], ['FAILED', null, false, 'START_FAILED']);
  assert.equal((await f.manager.start('public-01')).runtime.status, 'RUNNING');
});

test('restart keeps the port and gets a new pid and run id; restart of a stopped instance is a start', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const instance = await f.install('public-01');
  const first = (await f.manager.start('public-01')).runtime;
  const second = (await f.manager.restart('public-01')).runtime;
  assert.notEqual(second.pid, first.pid); assert.notEqual(second.runId, first.runId);
  assert.ok(!alive(first.pid) && alive(second.pid));
  assert.ok((await cmdline(second.pid)).includes(String(instance.port)));
  await f.manager.stop('public-01');
  assert.equal((await f.manager.restart('public-01')).runtime.status, 'RUNNING');
});

test('health: process, and the getinfo answer from the server itself', { skip }, async t => {
  const fake = await startFakeCod4xServer({ hostname: 'Remote One', mapname: 'mp_crash' });
  t.after(() => fake.close());
  const f = await createRemoteFixture(t);
  await f.install('public-01', { port: fake.port });
  assert.deepEqual(await f.manager.health('public-01'), { process: 'GONE', getinfo: 'SKIPPED' });
  await f.manager.start('public-01');
  const health = await f.manager.health('public-01');
  assert.deepEqual([health.process, health.getinfo, health.hostname, health.map], ['ALIVE', 'OK', 'Remote One', 'mp_crash']);
  fake.state.silent = true;
  assert.deepEqual((await f.manager.health('public-01')).getinfo, 'NO_ANSWER');
  const real = f.control.session;
  f.control.session = Object.create(real);
  f.control.session.exec = (command, options) => (command.startsWith('if command -v bash') ? Promise.resolve({ code: 3, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false }) : real.exec(command, options));
  assert.deepEqual((await f.manager.health('public-01')).getinfo, 'NO_TOOL');
});

test('three instances on one host start in parallel and stop independently', { skip }, async t => {
  const f = await createRemoteFixture(t);
  for (const id of ['public-01', 'public-02', 'public-03']) await f.install(id);
  const started = await Promise.all(['public-01', 'public-02', 'public-03'].map(id => f.manager.start(id)));
  assert.deepEqual(started.map(entry => entry.runtime.status), ['RUNNING', 'RUNNING', 'RUNNING']);
  assert.equal(new Set(started.map(entry => entry.runtime.pid)).size, 3);
  for (const entry of started) assert.deepEqual((await cmdline(entry.runtime.pid)).slice(0, 1), [entry.instance.core.path]);
  await f.manager.stop('public-02');
  assert.deepEqual([alive(started[0].runtime.pid), alive(started[1].runtime.pid), alive(started[2].runtime.pid)], [true, false, true]);
  await Promise.all([f.manager.stop('public-01'), f.manager.stop('public-03')]);
  assert.ok(started.every(entry => !alive(entry.runtime.pid)));
});

test('statusAll uses one connection per host for all active instances', { skip }, async t => {
  const f = await createRemoteFixture(t);
  for (const id of ['public-01', 'public-02', 'public-03']) await f.install(id);
  await Promise.all(['public-01', 'public-02', 'public-03'].map(id => f.manager.start(id)));
  const before = f.connects.length;
  const all = await f.manager.statusAll();
  assert.equal(f.connects.length - before, 1);
  assert.deepEqual(all.map(entry => [entry.instance.id, entry.runtime.status]), [['public-01', 'RUNNING'], ['public-02', 'RUNNING'], ['public-03', 'RUNNING']]);
});

test('a damaged state file blocks every operation that depends on it', { skip }, async t => {
  const f = await createRemoteFixture(t);
  await f.install('public-01');
  await fs.mkdir(f.state.root + '/public-01', { recursive: true });
  await fs.writeFile(f.state.file('public-01'), '{ not json');
  const before = f.connects.length;
  for (const operation of ['start', 'stop', 'status', 'restart', 'health', 'recover']) await rejects(f.manager[operation]('public-01'), 'REMOTE_STATE_INVALID');
  assert.equal(f.connects.length, before);
  assert.equal(await fs.readFile(f.state.file('public-01'), 'utf8'), '{ not json');
});

test('two operations on one instance at the same moment: the second is busy', { skip }, async t => {
  const f = await createRemoteFixture(t);
  await f.install('public-01');
  let release;
  f.control.gate = new Promise(resolve => { release = resolve; });
  const first = f.manager.start('public-01');
  await new Promise(resolve => setTimeout(resolve, 30));
  await rejects(f.manager.stop('public-01'), 'REMOTE_OPERATION_BUSY');
  await rejects(f.manager.start('public-01'), 'REMOTE_OPERATION_BUSY');
  release(); f.control.gate = null;
  assert.equal((await first).runtime.status, 'RUNNING');
});

test('the state file holds the fixed fields only: no arguments, paths, host or secrets', { skip }, async t => {
  const f = await createRemoteFixture(t);
  const instance = await f.install('public-01');
  await f.manager.start('public-01');
  const text = await fs.readFile(f.state.file('public-01'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(text).state).sort(), ['createdAt', 'exitReason', 'pid', 'recoveryBlocked', 'runId', 'startedAt', 'status', 'updatedAt']);
  for (const forbidden of ['+set', instance.home, instance.basePath, 'example.org', 'password', 'token']) assert.ok(!text.includes(forbidden), forbidden);
});
