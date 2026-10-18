import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { B3Runtime, b3LaunchArguments, identityMatches } from '../lib/b3-runtime.mjs';
import { b3Paths, renderB3Config, prepareB3Runtime, gameLogPath } from '../lib/b3-config.mjs';
import { createFakeB3Processes } from './support/fake-b3-process.mjs';

// Lifecycle logic against a process-table double. The real Python 2.7 / eBc-B3
// run is scripts/verify-4.18.10-b3-native.mjs (Linux/WSL).
async function fixture(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-b3-runtime-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const fake = createFakeB3Processes();
  const paths = b3Paths({ homePath: home });
  await fs.mkdir(paths.directory, { recursive: true });
  const events = [];
  const make = () => new B3Runtime({ instanceId: 'b3-test', platform: 'linux', stateFile: path.join(home, 'logs', 'b3-runtime-state.json'), paths,
    spawn: fake.spawn, inspect: fake.inspect, kill: fake.kill, getuid: () => 1000, onEvent: event => events.push(event), startupGraceMs: 40, stopTimeoutMs: 200, pollMs: 5, ...options });
  const runtime = make(); await runtime.load();
  const launch = { pythonPath: '/opt/py/python2.7', b3Path: path.join(home, 'ebc-b3'), configPath: paths.config };
  return { home, fake, paths, events, make, runtime, launch };
}
const until = async (predicate, ms = 1000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 5))) if (await predicate()) return true; return false; };

test('start spawns python2.7 -B -E b3_run.py --config detached without shell, -r or PYTHON env', async t => {
  const { runtime, fake, launch, events } = await fixture(t);
  const state = await runtime.start(launch);
  assert.equal(state.status, 'RUNNING');
  const [call] = fake.spawned;
  assert.deepEqual(call.args, ['-B', '-E', path.join(launch.b3Path, 'b3_run.py'), '--config', launch.configPath]);
  assert.ok(!call.args.includes('-r') && !call.args.includes('--restart'), 'CONTROL owns restarts, not B3');
  assert.deepEqual([call.file, call.options.detached, call.options.shell, call.options.cwd], [launch.pythonPath, true, false, launch.b3Path]);
  assert.ok(!Object.keys(call.options.env).some(key => /^PYTHON/.test(key)));
  assert.ok(events.some(event => event.event === 'b3.started'));
  assert.ok(!(await runtime.outputTail()).includes('should-not-leak'), 'output is redacted');
  await assert.rejects(runtime.start(launch), { code: 'B3_ALREADY_RUNNING' });
  await runtime.stop();
});

test('early exit (B3 critical 220) is a failed start, a later exit is a crash', async t => {
  const { runtime, fake, launch, events } = await fixture(t);
  fake.behaviour.exitDuringStartup = 220;
  await assert.rejects(runtime.start(launch), error => error.code === 'B3_START_FAILED' && error.exitCode === 220);
  assert.equal(runtime.state.status, 'FAILED');
  fake.behaviour.exitDuringStartup = null;
  const state = await runtime.start(launch);
  fake.crash(state.pid, 1);
  assert.ok(await until(() => runtime.state.status === 'CRASHED'));
  assert.equal(runtime.state.exitCode, 1);
  assert.deepEqual(events.filter(event => /failed|crashed/.test(event.event)).map(event => event.event), ['b3.start.failed', 'b3.crashed']);
});

test('stop is graceful, forces only a verified PID and never signals a reused PID', async t => {
  const { runtime, fake, launch } = await fixture(t);
  let state = await runtime.start(launch);
  assert.equal((await runtime.stop()).status, 'STOPPED');
  assert.equal((await fake.inspect(state.pid)).alive, false);
  fake.behaviour.ignoreTerm = true;
  state = await runtime.start(launch);
  assert.equal((await runtime.stop()).status, 'STOPPED', 'SIGKILL fallback after the graceful timeout');
  fake.behaviour.ignoreTerm = false;
  state = await runtime.start(launch);
  fake.reuse(state.pid);
  const kills = [];
  const original = runtime.kill; runtime.kill = (pid, signal) => { kills.push(signal); return original(pid, signal); };
  await assert.rejects(runtime.stop(), { code: 'B3_IDENTITY_MISMATCH' });
  assert.deepEqual(kills, [], 'no signal for a PID that is not this B3 run');
});

test('backend restart: persisted run is adopted when identity matches, LOST when gone', async t => {
  const { runtime, fake, launch, make, events } = await fixture(t);
  const state = await runtime.start(launch);
  runtime.release();
  const adopted = make(); await adopted.load();
  assert.deepEqual([adopted.snapshot().status, adopted.snapshot().pid], ['RUNNING', state.pid]);
  adopted.release();
  fake.vanish(state.pid);
  const after = make(); await after.load();
  assert.equal(after.snapshot().status, 'LOST');
  assert.ok(events.some(event => event.event === 'b3.lost'));
});

test('root execution is blocked on Linux and identity rules are strict', async t => {
  const { runtime, launch, fake } = await fixture(t, { getuid: () => 0 });
  await assert.rejects(runtime.start(launch), { code: 'B3_ROOT_BLOCKED' });
  assert.equal(fake.spawned.length, 0);
  const expected = { argv: ['/py', '-B', '-E', '/b3/b3_run.py', '--config', '/c.xml'], startTime: 's1' };
  assert.equal(identityMatches({ alive: true, argv: expected.argv, uid: 1000, startTime: 's1' }, expected, 'linux', 1000), true);
  assert.equal(identityMatches({ alive: true, argv: expected.argv, uid: 1001, startTime: 's1' }, expected, 'linux', 1000), false);
  assert.equal(identityMatches({ alive: true, argv: expected.argv, uid: 1000, startTime: 's2' }, expected, 'linux', 1000), false);
  assert.equal(identityMatches({ alive: true, commandLine: '"C:\\Py27\\python.exe" -B -E "C:\\b3\\b3_run.py" --config "C:\\c.xml"', startTime: 's1' }, { argv: ['C:\\Py27\\python.exe', '-B', '-E', 'C:\\b3\\b3_run.py', '--config', 'C:\\c.xml'], startTime: 's1' }, 'windows'), true);
  assert.deepEqual(b3LaunchArguments({ b3Path: '/b3', configPath: '/c.xml' }).slice(0, 2), ['-B', '-E']);
});

test('health separates process state, B3 readiness, errors and RCON reachability', async t => {
  const { runtime, launch, paths } = await fixture(t);
  assert.equal((await runtime.health()).status, 'DOWN');
  await runtime.start(launch);
  await fs.writeFile(paths.logFile, 'x INFO "Start reading game events"\n');
  assert.deepEqual((({ status, ready, rcon }) => [status, ready, rcon])(await runtime.health()), ['HEALTHY', true, 'NO_RECENT_ERRORS']);
  await fs.appendFile(paths.logFile, 'x ERROR "RCON: too many tries: aborting (\'status\')"\n');
  const unreachable = await runtime.health();
  assert.deepEqual([unreachable.status, unreachable.rcon], ['HEALTHY', 'UNREACHABLE'], 'missing server does not degrade the B3 process');
  await fs.appendFile(paths.logFile, 'Traceback (most recent call last):\n  File "b3/parser.py"\n');
  assert.equal((await runtime.health()).status, 'DEGRADED');
  await runtime.stop();
});

test('minimal B3 config: cod4x parser, SQLite, instance game log, no autodoc, no credentials; game log never truncated', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-b3-config-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const instance = { id: 'cfg', homePath: home, port: 28965 };
  assert.throws(() => gameLogPath(instance, '../escape.log'), { code: 'B3_GAME_LOG_NOT_CONFIGURED' });
  assert.throws(() => gameLogPath(instance, undefined), { code: 'B3_GAME_LOG_NOT_CONFIGURED' });
  await fs.mkdir(path.join(home, 'main', 'logs'), { recursive: true });
  await fs.writeFile(path.join(home, 'main', 'logs', 'games_mp.log'), 'existing line\n');
  const prepared = await prepareB3Runtime(instance, 'logs/games_mp.log');
  assert.equal(await fs.readFile(prepared.gameLog, 'utf8'), 'existing line\n');
  const xml = await fs.readFile(prepared.config, 'utf8');
  for (const expected of ['<set name="parser">cod4x</set>', '<set name="database">sqlite://', '<set name="port">28965</set>', '<set name="rcon_password"></set>', '<plugin name="admin"']) assert.ok(xml.includes(expected), expected);
  assert.ok(!xml.includes('name="autodoc"'));
  assert.ok(xml.includes(prepared.gameLog.replace(/&/g, '&amp;')));
  assert.match(renderB3Config({ instance: { port: 1 }, paths: b3Paths({ homePath: '/a&b' }), gameLog: '/a&b/main/logs/g.log' }), /\/a&amp;b\/main/);
});
