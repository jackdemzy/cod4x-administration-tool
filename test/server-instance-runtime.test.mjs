import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ServerInstanceStore } from '../lib/server-instance-store.mjs';
import { ServerInstanceManager } from '../lib/server-instance-manager.mjs';
import { createRuntimeManager } from '../lib/runtime-manager.mjs';
import { mergeBaseGameState, resolveRuntimeLayout, selectRuntimeBaseGamePath } from '../lib/runtime-layout.mjs';
import { assertWindowsInstanceOwnership } from '../lib/windows-process-ownership.mjs';

// Real store/layout/runtime code; only OS process creation/query/termination and
// executable trust are controlled. NOT a native Dedicated lifecycle gate.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-parallel-runtime-'));
  let manager;
  t.after(async () => {
    if(manager)for(const pending of manager.runtimes.values())await (await pending).persistRuntimeState();
    await fs.rm(root, { recursive: true, force: true });
  });
  const basePath = path.join(root, 'game');
  const executablePath = path.join(root, 'core', 'cod4x18_dedrun.exe');
  await fs.mkdir(path.join(basePath, 'main'), { recursive: true });
  await fs.mkdir(path.join(basePath, 'zone'), { recursive: true });
  await fs.mkdir(path.dirname(executablePath));
  await fs.writeFile(path.join(basePath, 'main', 'pak0.iwd'), 'fixture');
  await fs.writeFile(path.join(basePath, 'zone', 'common.ff'), 'fixture');
  await fs.writeFile(executablePath, 'trusted only by this test double');
  const store = new ServerInstanceStore({ root: path.join(root, 'servers'), registryFile: path.join(root, 'instances.json'), checkPort: async () => {} });
  const children = new Map(), kills = [], events = [];
  let pid = 4500;
  manager = new ServerInstanceManager({ store, runtimeFactory: (instance, options) => createRuntimeManager({
    fs, path, crypto, process: { platform: 'win32', pid: process.pid, env: {} }, dataPath: (...parts) => path.join(root, ...parts),
    SERVER_CORE_DEFINITIONS: { windows: { executable: 'cod4x18_dedrun.exe' } }, serverCoreDefinition: () => ({ executable: 'cod4x18_dedrun.exe' }),
    normalizeServerPlatform: value => value, normalizeRuntimePath: value => value,
    resolveServerTarget: async target => ({ target: path.resolve(target), root, checks: [] }),
    resolveRuntimeExecutable: async ({ executablePath: value }) => value,
    verifiedRuntimeCoreStatus: async () => ({ verified: true, reasons: [] }),
    policyState: { security: { allowedCod4xVersions: ['21.5'] } },
    mergeBaseGameState, resolveRuntimeLayout, selectRuntimeBaseGamePath, assertWindowsInstanceOwnership,
    onRuntimeEvent: event => events.push(event),
    spawn: (executable, args, options) => {
      const child = new EventEmitter();
      Object.assign(child, { pid: ++pid, stdout: new EventEmitter(), stderr: new EventEmitter(), unref() {}, gone: false, executable, args, options, createdAt: `2026-10-01T12:00:${pid % 60}.0000000Z` });
      child.commandLine = [executable, ...args].map(value => `"${value}"`).join(' ');
      child.on('exit', () => { child.gone = true; });
      children.set(child.pid, child);
      queueMicrotask(() => { child.emit('spawn'); child.stdout.emit('data', Buffer.from(`output:${instance.id}`)); });
      return child;
    },
    execFileAsync: async (file, args) => {
      if (file === 'tasklist.exe') {
        const child = children.get(Number(args[1].split(' ').at(-1)));
        return { stdout: !child || child.gone ? 'INFO: No tasks are running' : `"cod4x18_dedrun.exe","${child.pid}","Console","1","1 K"` };
      }
      if (file === 'powershell.exe') {
        const child = children.get(Number(args.at(-1).match(/ProcessId = (\d+)/)[1]));
        return { stdout: JSON.stringify(!child || child.gone ? { found: false } : { found: true, executablePath: child.executable, commandLine: child.commandLine, createdAt: child.createdAt }) };
      }
      if (file === 'taskkill.exe') { const child = children.get(Number(args[1])); kills.push(child.pid); child.emit('exit', 0, null); return { stdout: '' }; }
      throw new Error(`Unexpected OS command ${file}`);
    },
  }, options) });
  await manager.load();
  const input = { name: 'Test', platform: 'windows', serverCore: { executablePath, version: '21.5' }, basePath };
  await manager.create({ ...input, id: 'public-01', port: 28960 });
  await manager.create({ ...input, id: 'public-02', port: 28961 });
  return { root, manager, children, kills, events };
}

test('instance startup refuses unknown and plaintext-secret CVARs before spawning', async t => {
  const { manager, children, kills } = await fixture(t);
  const instance = manager.store.get('public-01');
  const original = await fs.readFile(instance.configPath, 'utf8');
  for (const assignment of ['set unknown_unsafe_setting "1"\n', 'set rcon_password "Disposable-Secret-123!"\n']) {
    await fs.writeFile(instance.configPath, original + assignment);
    await assert.rejects(manager.launch(instance.id), { code: 'CONFIG_SCHEMA_INVALID' });
    assert.equal(children.size, 0, 'Rejected schema must never spawn a child');
  }
  await fs.writeFile(instance.configPath, original);
  const running = await manager.launch(instance.id);
  for (const assignment of ['set unknown_unsafe_setting "1"\n', 'set rcon_password "Disposable-Secret-123!"\n']) {
    await fs.writeFile(instance.configPath, original + assignment);
    await assert.rejects(manager.launch(instance.id, true), { code: 'CONFIG_SCHEMA_INVALID' });
    assert.equal(children.size, 1);
    assert.equal(kills.length, 0, 'Rejected restart must preserve the owned process');
    assert.equal((await manager.status(instance.id)).runtime.pid, running.pid);
  }
  await manager.stop(instance.id);
});

test('configuration changes and restores are blocked while the owned instance is running', async t => {
  const { manager } = await fixture(t);
  const before = await manager.configuration('public-01');
  const entries = before.entries.map(entry => entry.name === 'sv_hostname' ? { ...entry, value: 'Config changed' } : entry);
  await manager.launch('public-01');
  await assert.rejects(manager.changeConfiguration('public-01', { expectedSha256: before.sha256, entries }), { code: 'INSTANCE_RUNTIME_BUSY' });
  await assert.rejects(manager.changeConfiguration('public-01', { expectedSha256: before.sha256, backupId: 'invalid' }, true), { code: 'INSTANCE_RUNTIME_BUSY' });
  await assert.rejects(manager.changeCredential('public-01', 'rcon', { value: 'Disposable-123!', expectedSha256: '0'.repeat(64) }), { code: 'INSTANCE_RUNTIME_BUSY' });
  await assert.rejects(manager.changeCredential('public-01', 'master', { expectedSha256: '0'.repeat(64) }, true), { code: 'INSTANCE_RUNTIME_BUSY' });
  assert.equal((await manager.configuration('public-01')).sha256, before.sha256);
  await manager.stop('public-01');
  assert.equal((await manager.changeConfiguration('public-01', { expectedSha256: before.sha256, entries })).verified, true);
});

test('config activation tracks which fingerprint the running instance uses and flags external edits', async t => {
  const { manager } = await fixture(t);
  assert.equal((await manager.configuration('public-01')).activation.state, 'STOPPED');
  const before = await manager.configuration('public-01');
  await manager.launch('public-01');
  const active = await manager.configuration('public-01');
  assert.deepEqual([active.activation.state, active.activation.activeSha256], ['ACTIVE', before.sha256]);
  assert.equal((await manager.configuration('public-02')).activation.state, 'STOPPED', 'Sibling activation must stay independent');
  const instance = manager.store.get('public-01');
  await fs.writeFile(instance.configPath, (await fs.readFile(instance.configPath, 'utf8')).replace(/set sv_hostname "[^"]*"/, 'set sv_hostname "Edited outside CONTROL"'));
  const edited = await manager.configuration('public-01');
  assert.deepEqual([edited.activation.state, edited.activation.restartRequired], ['RESTART_REQUIRED', true]);
  await manager.launch('public-01', true);
  assert.equal((await manager.configuration('public-01')).activation.state, 'ACTIVE');
  await manager.stop('public-01');
  const stopped = await manager.configuration('public-01');
  assert.deepEqual([stopped.activation.state, stopped.activation.changedSinceLastStart], ['STOPPED', false]);
});

test('runtime events carry per-run identity and unexpected exit without raw arguments', async t => {
  const { manager, children, events } = await fixture(t);
  const state = await manager.launch('public-01');
  const started = events.find(event => event.event === 'runtime.started');
  assert.equal(started.instanceId, 'public-01');
  assert.equal(started.runId, state.runId);
  assert.equal(started.pid, state.pid);
  assert.equal(started.status, 'RUNNING');
  children.get(state.pid).emit('exit', 29, null);
  const exited = events.find(event => event.event === 'runtime.exited');
  assert.equal(exited.expected, false);
  assert.equal(exited.exitCode, 29);
  assert.equal(exited.pid, state.pid);
  assert.equal(exited.runId, state.runId);
  assert.equal(exited.status, 'FAILED');
  for (const event of events) {
    assert.equal(Object.hasOwn(event, 'args'), false);
    assert.equal(Object.hasOwn(event, 'error'), false);
    assert.equal(Object.hasOwn(event, 'output'), false);
  }
});

test('managed local instances bind IPv6 loopback as well as IPv4, using the owned port', async t => {
  const { manager, children } = await fixture(t);
  const state = await manager.launch('public-01');
  const args = children.get(state.pid).args;
  assert.equal(args[args.indexOf('net_ip6') + 1], '::1');
  assert.equal(args[args.indexOf('net_port6') + 1], String(manager.store.get('public-01').port));
  await manager.stop('public-01');
});

test('invalid config content prevents spawn and does not stop a running instance on restart', async t => {
  const { manager, children, kills } = await fixture(t);
  const instance = manager.store.get('public-01');
  const original = await fs.readFile(instance.configPath);
  for (const content of [Buffer.alloc(0), Buffer.from('   \n\t'), Buffer.from('set x "a"\0'), Buffer.from([0xff, 0xfe]), Buffer.alloc(256 * 1024 + 1, 65)]) {
    await fs.writeFile(instance.configPath, content);
    await assert.rejects(manager.launch('public-01'), { code: 'INSTANCE_CONFIG_INVALID' });
    assert.equal(children.size, 0);
  }
  await fs.writeFile(instance.configPath, original);
  const running = await manager.launch('public-01');
  await fs.writeFile(instance.configPath, '');
  await assert.rejects(manager.launch('public-01', true), { code: 'INSTANCE_CONFIG_INVALID' });
  assert.equal((await manager.status('public-01')).runtime.pid, running.pid);
  assert.deepEqual(kills, []);
  await manager.stop('public-01');
});

test('managed config rejects critical overrides and indirect commands before spawn', async t => {
  const { manager, children } = await fixture(t);
  const instance = manager.store.get('public-01');
  const invalid = ['set fs_homepath "C:/other"', 'set FS_BASEPATH "C:/other"', 'set net_port "28961"', 'set net_ip "0.0.0.0"', 'set dedicated "0"', 'exec other.cfg', 'vstr next', 'quit', '// comment only', 'set sv_hostname "ok";set fs_homepath "other"', 'set next "set fs_homepath other";vstr next', 'set sv_hostname "unfinished', '/* block */set fs_homepath other'];
  for (const text of invalid) {
    await fs.writeFile(instance.configPath, text);
    await assert.rejects(manager.launch(instance.id), { code: 'INSTANCE_CONFIG_INVALID' });
    assert.equal(children.size, 0);
  }
});

test('missing and hardlinked configuration prevent spawning', async t => {
  const { manager, children } = await fixture(t);
  const config = manager.store.get('public-01').configPath;
  await fs.unlink(config);
  await assert.rejects(manager.launch('public-01'));
  assert.equal(children.size, 0);
  const foreign = path.join(manager.store.get('public-02').homePath, 'foreign.cfg');
  await fs.writeFile(foreign, 'set sv_hostname "foreign"');
  await fs.link(foreign, config);
  await assert.rejects(manager.launch('public-01'), { code: 'INSTANCE_CONFIG_INVALID' });
  assert.equal(children.size, 0);
});

test('two concurrent instances use different homes/PIDs/ports/output and stop independently', async t => {
  const { manager, children, kills } = await fixture(t);
  const [a, b] = await Promise.all([manager.launch('public-01'), manager.launch('public-02')]);
  assert.equal(a.status, 'RUNNING'); assert.equal(b.status, 'RUNNING');
  assert.notEqual(a.pid, b.pid); assert.notEqual(a.filesystemHomePath, b.filesystemHomePath);
  assert.match(a.output.stdout, /public-01/); assert.doesNotMatch(a.output.stdout, /public-02/);
  for (const state of [a, b]) {
    const child = children.get(state.pid);
    assert.equal(child.options.cwd, path.dirname(state.executablePath));
    assert.equal(child.options.shell, false);
    assert.equal(child.args[child.args.indexOf('fs_homepath') + 1], state.filesystemHomePath);
  }
  await manager.stop('public-01');
  assert.deepEqual(kills, [a.pid]);
  assert.equal((await manager.status('public-02')).runtime.status, 'RUNNING');
  await manager.stop('public-02');
});

test('one crash cannot change sibling state or logs; sibling restart receives a new PID', async t => {
  const { manager, children } = await fixture(t);
  const [a, b] = await Promise.all([manager.launch('public-01'), manager.launch('public-02')]);
  children.get(a.pid).emit('exit', 29, null);
  assert.equal((await manager.status('public-01')).runtime.status, 'FAILED');
  assert.equal((await manager.status('public-02')).runtime.status, 'RUNNING');
  const restarted = await manager.launch('public-02', true);
  assert.notEqual(restarted.pid, b.pid);
  assert.equal(restarted.status, 'RUNNING');
  await manager.stop('public-02');
});

test('same Core path cannot authorize stopping a sibling home or reused PID', async t => {
  const { manager, children, kills } = await fixture(t);
  const [a, b] = await Promise.all([manager.launch('public-01'), manager.launch('public-02')]);
  const child = children.get(a.pid);
  const command = child.commandLine;
  child.commandLine = children.get(b.pid).commandLine;
  await assert.rejects(manager.stop('public-01'), { code: 'INSTANCE_PROCESS_IDENTITY_BLOCKED' });
  assert.deepEqual(kills, []);
  child.commandLine = command; child.createdAt = '2026-10-01T13:00:00Z';
  await assert.rejects(manager.stop('public-01'), { code: 'INSTANCE_PROCESS_IDENTITY_BLOCKED' });
  assert.deepEqual(kills, []);
  // Test doubles only: mark exited to allow fixture teardown, not native termination.
  child.emit('exit', 29, null); children.get(b.pid).emit('exit', 29, null);
});

test('running instance cannot be archived; stopped instance archive preserves sibling', async t => {
  const { manager } = await fixture(t);
  await manager.launch('public-01');
  await assert.rejects(manager.archive('public-01'), { code: 'INSTANCE_RUNTIME_BUSY' });
  await manager.stop('public-01');
  const result = await manager.archive('public-01');
  assert.equal(result.recoverable, true);
  assert.equal((await manager.status('public-02')).runtime.status, 'STOPPED');
});

test('corrupt runtime recovery cannot spawn a duplicate or overwrite the evidence', async t => {
  const { manager, children } = await fixture(t);
  const a = await manager.launch('public-01');
  const stateFile = path.join(manager.store.get('public-01').homePath, 'logs', 'runtime-state.json');
  await fs.writeFile(stateFile, '{broken');
  const recovered = new ServerInstanceManager({ store: manager.store, runtimeFactory: manager.runtimeFactory });
  await recovered.load();
  await assert.rejects(recovered.launch('public-01'), { code: 'RUNTIME_RECOVERY_BLOCKED' });
  await assert.rejects(recovered.archive('public-01'), { code: 'RUNTIME_RECOVERY_BLOCKED' });
  assert.equal(children.size, 1);
  assert.equal(await fs.readFile(stateFile, 'utf8'), '{broken');
  // Existing manager still owns its test child and may stop it safely.
  assert.equal(children.get(a.pid).gone, false);
  await manager.stop('public-01');
});

test('interrupted STARTING checkpoint without PID cannot be cleared by stop or relaunched', async t => {
  const { manager, children } = await fixture(t);
  const started = await manager.launch('public-01');
  const stateFile = path.join(manager.store.get('public-01').homePath, 'logs', 'runtime-state.json');
  const interrupted = JSON.stringify({ ...started, status: 'STARTING', pid: null, processCreatedAt: null });
  await fs.writeFile(stateFile, interrupted);
  const recovered = new ServerInstanceManager({ store: manager.store, runtimeFactory: manager.runtimeFactory });
  await recovered.load();
  await assert.rejects(recovered.stop('public-01'), { code: 'RUNTIME_RECOVERY_BLOCKED' });
  await assert.rejects(recovered.launch('public-01'), { code: 'RUNTIME_RECOVERY_BLOCKED' });
  await assert.rejects(recovered.archive('public-01'), { code: 'RUNTIME_RECOVERY_BLOCKED' });
  assert.equal(await fs.readFile(stateFile, 'utf8'), interrupted);
  assert.equal(children.size, 1);
  assert.equal(children.get(started.pid).gone, false);
  await manager.stop('public-01');
});
