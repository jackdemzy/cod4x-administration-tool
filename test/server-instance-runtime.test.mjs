import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ServerInstanceStore } from '../lib/server-instance-store.mjs';
import { ServerInstanceManager } from '../lib/server-instance-manager.mjs';
import { InstanceCredentialService } from '../lib/instance-credential-service.mjs';
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

const vaultPassphrase = 'Disposable policy test passphrase!';
test('private runtime output policy survives backend recreation and keeps console hidden after a later public run', async t => {
  const { root, manager, children } = await fixture(t);
  const instance = manager.store.get('public-01');
  const runtime = await manager.runtime(instance.id);
  const privateState = await runtime.startRuntime({ relative: instance.homePath, executablePath: instance.serverCore.executablePath, baseGamePath: instance.basePath, expectedCod4x: '21.5', platform: 'windows', outputPolicy: 'private', args: ['+set', 'net_port', String(instance.port)] });
  const secret = 'Disposable-private-console-123!';
  await fs.writeFile(path.join(instance.homePath, 'main/qconsole.log'), secret + '\n');
  children.get(privateState.pid).stdout.emit('data', Buffer.from(secret));
  await runtime.persistRuntimeState();
  const check = async manager => {
    const status = await manager.status(instance.id);
    assert.equal(status.consoleLog.status, 'suppressed');
    assert.equal(status.consoleLog.text, '');
    assert.ok(!JSON.stringify(status).includes(secret));
    assert.ok(!JSON.stringify(await manager.list()).includes(secret));
  };
  await check(manager);
  const recovered = new ServerInstanceManager({ store: manager.store, runtimeFactory: manager.runtimeFactory });
  await recovered.load();
  await check(recovered);
  assert.ok(!(await fs.readFile(path.join(instance.homePath, 'logs/runtime-state.json'), 'utf8')).includes(secret));
  await manager.stop(instance.id);
  await manager.launch(instance.id);
  assert.equal((await manager.status(instance.id)).runtime.outputPolicy, 'standard');
  assert.match((await manager.status(instance.id)).runtime.output.stdout, /output:public-01/);
  await check(manager); // Historical console stays private; do not unhide old bytes.
  await manager.stop(instance.id);
});

test('invalid privacy checkpoint blocks recovery without exposing its console through instance listing', async t => {
  const { manager } = await fixture(t);
  const instance = manager.store.get('public-01'), runtime = await manager.runtime(instance.id);
  const secret = 'Disposable-corrupt-checkpoint-console-123!';
  await fs.writeFile(path.join(instance.homePath, 'main/qconsole.log'), secret + '\n');
  const checkpoint = JSON.stringify({ ...runtime.state, outputPolicy: 'private', consoleOutputPrivate: 'corrupt' });
  const file = path.join(instance.homePath, 'logs/runtime-state.json');
  await fs.writeFile(file, checkpoint);
  const recovered = new ServerInstanceManager({ store: manager.store, runtimeFactory: manager.runtimeFactory });
  await recovered.load();
  const listed = await recovered.list();
  const result = listed.find(value => value.id === instance.id);
  assert.equal(result.runtime.recoveryBlocked, true);
  assert.equal(result.consoleLog.status, 'suppressed');
  assert.ok(!JSON.stringify(listed).includes(secret));
  assert.equal(await fs.readFile(file, 'utf8'), checkpoint);
});

async function credentialFixture(t) {
  const result = await fixture(t);
  const service = new InstanceCredentialService({ dataRoot: result.root, resolveInstance: id => result.manager.store.get(id) });
  result.manager.credentialService = service;
  t.after(() => service.lock());
  await service.initialize(vaultPassphrase);
  await service.unlock(vaultPassphrase);
  return { ...result, service };
}

function credentialDriver(manager, overrides = {}) {
  return {
    withConfig: async ({ credentials, signal }, consume) => {
      assert.ok(credentials.join === null || Buffer.isBuffer(credentials.join));
      assert.ok(Buffer.isBuffer(credentials.rcon));
      assert.equal(signal.aborted, false);
      return consume({ relativeConfig: 'control-test/run.cfg' });
    },
    waitReady: async ({ signal, joinRequired }) => {
      assert.equal(signal.aborted, false);
      assert.equal((await manager.status('public-01')).runtime.outputPolicy, 'private');
      return { rconAuthenticated: true, joinPasswordFlag: joinRequired, map: 'mp_backlot' };
    },
    ...overrides,
  };
}

test('credential startup coordinates private mode, readiness and vault scope before returning success', async t => {
  const { manager, service, children, kills } = await credentialFixture(t);
  const id = 'public-01', phases = [];
  const join = 'Disposable-Manager-Join-123!';
  await manager.changeCredential(id, 'join', { value: join, expectedSha256: (await service.status()).sha256 });
  let supplied;
  manager.credentialRuntime = credentialDriver(manager, {
    withConfig: async ({ credentials, signal }, consume) => {
      supplied = credentials;
      assert.equal(credentials.join.toString(), join);
      phases.push('prepared');
      try { return await consume({ relativeConfig: 'control-test/run.cfg' }); }
      finally { phases.push('removed'); }
    },
    waitReady: async () => { phases.push('ready'); return { rconAuthenticated: true, joinPasswordFlag: true, map: 'mp_backlot' }; },
  });
  const state = await manager.launch(id);
  assert.deepEqual(phases, ['prepared', 'ready', 'removed']);
  assert.equal(state.outputPolicy, 'private');
  assert.equal(state.credentialActivation.state, 'READY');
  assert.equal(state.credentialActivation.joinPasswordFlag, true);
  const child = children.get(state.pid);
  assert.ok(child.args.includes('control-test/run.cfg'));
  assert.ok(!child.args.join(' ').includes(join));
  assert.ok(supplied.join.every(byte => byte === 0));
  assert.ok(supplied.rcon.every(byte => byte === 0));
  service.lock();
  await assert.rejects(manager.launch(id, true), { code: 'VAULT_LOCKED' });
  assert.deepEqual(kills, []);
  assert.equal((await manager.status(id)).runtime.pid, state.pid);
  await manager.stop(id);
});

test('activation belongs only to its running run, never a later unprotected start or crashed process', async t => {
  const { manager, service, children } = await credentialFixture(t);
  const id = 'public-01';
  await manager.changeCredential(id, 'join', { value: 'Disposable-Manager-Join-123!', expectedSha256: (await service.status()).sha256 });
  manager.credentialRuntime = credentialDriver(manager);
  const protectedRun = await manager.launch(id);
  assert.equal(protectedRun.credentialActivation.runId, protectedRun.runId);
  await manager.stop(id);
  assert.notEqual((await manager.status(id)).runtime.credentialActivation.state, 'READY');
  await manager.changeCredential(id, 'join', { expectedSha256: (await service.status()).sha256 }, true);
  const publicRun = await manager.launch(id);
  assert.notEqual(publicRun.runId, protectedRun.runId);
  assert.equal(publicRun.credentialActivation.state, 'NOT_APPLIED');
  assert.equal(publicRun.credentialActivation.runId, publicRun.runId);
  await manager.stop(id);
  await manager.changeCredential(id, 'join', { value: 'Disposable-Manager-Join-123!', expectedSha256: (await service.status()).sha256 });
  const crashing = await manager.launch(id);
  children.get(crashing.pid).emit('exit', 17, null);
  const failed = (await manager.status(id)).runtime;
  assert.equal(failed.status, 'FAILED');
  assert.notEqual(failed.credentialActivation.state, 'READY');
  assert.equal(failed.credentialActivation.runId, crashing.runId);
});

test('a Core exit during final READY persistence cannot return startup success', async t => {
  const { manager, service, children } = await credentialFixture(t);
  const id = 'public-01';
  await manager.changeCredential(id, 'join', { value: 'Disposable-Manager-Join-123!', expectedSha256: (await service.status()).sha256 });
  manager.credentialRuntime = credentialDriver(manager);
  const runtime = await manager.runtime(id), persist = runtime.persistRuntimeState;
  runtime.persistRuntimeState = async () => {
    if (runtime.state.credentialActivation?.state === 'READY') children.get(runtime.state.pid).emit('exit', 17, null);
    return persist();
  };
  await assert.rejects(manager.launch(id), { code: 'CREDENTIAL_RUNTIME_PROCESS_LOST' });
  assert.notEqual((await manager.status(id)).runtime.credentialActivation.state, 'READY');
});

test('failed readiness stops only its new owned run and preserves a sibling', async t => {
  const { manager, service, children, kills } = await credentialFixture(t);
  const sibling = await manager.launch('public-02');
  await manager.changeCredential('public-01', 'join', { value: 'Disposable-Manager-Join-123!', expectedSha256: (await service.status()).sha256 });
  manager.credentialRuntime = credentialDriver(manager, { waitReady: async () => { throw Object.assign(new Error('Controlled readiness timeout'), { code: 'CREDENTIAL_RUNTIME_READINESS_TIMEOUT' }); } });
  await assert.rejects(manager.launch('public-01'), { code: 'CREDENTIAL_RUNTIME_READINESS_TIMEOUT' });
  const started = [...children.values()].find(child => child.pid !== sibling.pid);
  assert.ok(started.gone);
  assert.deepEqual(kills, [started.pid]);
  assert.equal((await manager.status('public-02')).runtime.pid, sibling.pid);
  await manager.stop('public-02');
});

test('vault abort during readiness stops the new run while failed preparation preserves the old run', async t => {
  const { manager, service, children, kills } = await credentialFixture(t);
  await manager.changeCredential('public-01', 'join', { value: 'Disposable-Manager-Join-123!', expectedSha256: (await service.status()).sha256 });
  manager.credentialRuntime = credentialDriver(manager, { waitReady: async ({ signal }) => { service.lock(); assert.equal(signal.aborted, true); throw Object.assign(new Error('Cancelled'), { code: 'CREDENTIAL_RUNTIME_ABORTED' }); } });
  await assert.rejects(manager.launch('public-01'), { code: 'CREDENTIAL_RUNTIME_ABORTED' });
  assert.equal(kills.length, 1);
  assert.ok(children.get(kills[0]).gone);
  await service.unlock(vaultPassphrase);
  manager.credentialRuntime = credentialDriver(manager);
  const running = await manager.launch('public-01');
  manager.credentialRuntime.withConfig = async () => { throw Object.assign(new Error('Controlled ACL denial'), { code: 'CREDENTIAL_RUNTIME_ACL_BLOCKED' }); };
  await assert.rejects(manager.launch('public-01', true), { code: 'CREDENTIAL_RUNTIME_ACL_BLOCKED' });
  assert.equal(kills.length, 1);
  assert.equal((await manager.status('public-01')).runtime.pid, running.pid);
  await manager.stop('public-01');
});

test('join changes persist protection before vault mutation; removal repairs a failed registry clear', async t => {
  const { manager, service, children } = await credentialFixture(t);
  const id = 'public-01', instance = manager.store.get(id);
  const savedSet = service.set.bind(service);
  service.set = async (...args) => {
    assert.equal(manager.store.get(id).credentialPolicy.join, 'required');
    throw Object.assign(new Error('Controlled vault write failure'), { code: 'EACCES' });
  };
  await assert.rejects(manager.changeCredential(id, 'join', { value: 'Policy-Join-123!', expectedSha256: (await service.status()).sha256 }), { code: 'EACCES' });
  assert.equal(manager.store.get(id).credentialPolicy.join, 'required');
  assert.equal((await service.instanceStatus(id)).join.configured, false);
  service.set = savedSet;
  await manager.changeCredential(id, 'join', { value: 'Policy-Join-123!', expectedSha256: (await service.status()).sha256 });
  service.lock();
  await assert.rejects(manager.launch(id), { code: 'CREDENTIAL_RUNTIME_NOT_READY' });
  assert.equal(children.size, 0);
  await service.unlock(vaultPassphrase);
  const persist = manager.store.persist.bind(manager.store);
  manager.store.persist = async () => { throw Object.assign(new Error('Controlled registry denial'), { code: 'EACCES' }); };
  await assert.rejects(manager.changeCredential(id, 'join', { expectedSha256: (await service.status()).sha256 }, true), { code: 'EACCES' });
  assert.equal((await service.instanceStatus(id)).join.configured, false);
  assert.equal(manager.store.get(id).credentialPolicy.join, 'required');
  manager.store.persist = persist;
  await manager.changeCredential(id, 'join', { expectedSha256: (await service.status()).sha256 }, true);
  assert.equal(manager.store.get(id).credentialPolicy.join, 'none');
  assert.equal(manager.store.get(id).createdAt, instance.createdAt);
  await manager.launch(id); await manager.stop(id);
});

test('invalid Join changes and failed policy persistence cannot write credentials', async t => {
  const { manager, service } = await credentialFixture(t);
  const id = 'public-01', sha256 = (await service.status()).sha256;
  for (const input of [{ value: 'bad', expectedSha256: sha256 }, { value: 'Policy-Join-123!', expectedSha256: 'bad' }, { value: 'Policy-Join-123!', expectedSha256: sha256, extra: true }]) {
    await assert.rejects(manager.changeCredential(id, 'join', input), { code: 'CREDENTIAL_INVALID' });
    assert.equal(manager.store.get(id).credentialPolicy.join, 'none');
  }
  manager.store.persist = async () => { throw Object.assign(new Error('Controlled registry denial'), { code: 'EACCES' }); };
  await assert.rejects(manager.changeCredential(id, 'join', { value: 'Policy-Join-123!', expectedSha256: sha256 }), { code: 'EACCES' });
  assert.equal((await service.status()).sha256, sha256);
  assert.equal((await service.instanceStatus(id)).join.configured, false);
});

test('RCON-only startup requires the vault, applies no Join secret and removal permits a locked public start', async t => {
  const { manager, service, children, kills } = await credentialFixture(t);
  const id = 'public-01', rcon = 'Disposable-Rcon-Only-123!';
  await manager.changeCredential(id, 'rcon', { value: rcon, expectedSha256: (await service.status()).sha256 });
  assert.equal(manager.store.get(id).credentialPolicy.rcon, 'required');
  let supplied;
  manager.credentialRuntime = credentialDriver(manager, { withConfig: async ({ credentials }, consume) => {
    supplied = credentials; assert.equal(credentials.join, null); assert.equal(credentials.rcon.toString(), rcon);
    return consume({ relativeConfig: 'control-test/run.cfg' });
  } });
  const running = await manager.launch(id);
  assert.equal(running.credentialActivation.state, 'READY'); assert.equal(running.credentialActivation.joinPasswordFlag, false);
  assert.equal(running.outputPolicy, 'private'); assert.ok(supplied.rcon.every(byte => byte === 0));
  assert.equal(children.get(running.pid).args.includes(rcon), false);
  service.lock();
  await assert.rejects(manager.launch(id, true), { code: 'VAULT_LOCKED' }); assert.deepEqual(kills, []);
  assert.equal((await manager.status(id)).runtime.pid, running.pid);
  await manager.stop(id); await service.unlock(vaultPassphrase);
  await manager.changeCredential(id, 'rcon', { expectedSha256: (await service.status()).sha256 }, true);
  assert.equal(manager.store.get(id).credentialPolicy.rcon, 'none'); service.lock();
  assert.equal((await manager.launch(id)).credentialActivation.state, 'NOT_APPLIED'); await manager.stop(id);
});

test('RCON requirement survives failed vault writes and failed policy removal until explicit retry', async t => {
  const { manager, service, children } = await credentialFixture(t);
  const id = 'public-01', savedSet = service.set.bind(service);
  service.set = async () => {
    assert.equal(manager.store.get(id).credentialPolicy.rcon, 'required');
    throw Object.assign(new Error('Controlled vault denial'), { code: 'EACCES' });
  };
  await assert.rejects(manager.changeCredential(id, 'rcon', { value: 'Disposable-Rcon-Only-123!', expectedSha256: (await service.status()).sha256 }), { code: 'EACCES' });
  assert.equal(manager.store.get(id).credentialPolicy.rcon, 'required');
  manager.credentialRuntime = credentialDriver(manager);
  await assert.rejects(manager.launch(id), { code: 'CREDENTIAL_NOT_CONFIGURED' }); assert.equal(children.size, 0);
  service.set = savedSet;
  await manager.changeCredential(id, 'rcon', { value: 'Disposable-Rcon-Only-123!', expectedSha256: (await service.status()).sha256 });
  const persist = manager.store.persist.bind(manager.store);
  manager.store.persist = async () => { throw Object.assign(new Error('Controlled registry denial'), { code: 'EACCES' }); };
  await assert.rejects(manager.changeCredential(id, 'rcon', { expectedSha256: (await service.status()).sha256 }, true), { code: 'EACCES' });
  assert.equal((await service.instanceStatus(id)).rcon.configured, false); assert.equal(manager.store.get(id).credentialPolicy.rcon, 'required');
  await assert.rejects(manager.launch(id), { code: 'CREDENTIAL_NOT_CONFIGURED' }); assert.equal(children.size, 0);
  manager.store.persist = persist;
  await manager.changeCredential(id, 'rcon', { expectedSha256: (await service.status()).sha256 }, true);
  assert.equal(manager.store.get(id).credentialPolicy.rcon, 'none');
});

test('legacy Join-only policy cannot silently omit an old RCON credential while locked', async t => {
  const { manager, service, children } = await credentialFixture(t);
  const id = 'public-01';
  await service.set(id, 'rcon', { value: 'Disposable-Legacy-Rcon-123!', expectedSha256: (await service.status()).sha256 });
  const raw = JSON.parse(await fs.readFile(manager.store.registryFile, 'utf8'));
  raw.instances[0].credentialPolicy = { join: 'none' };
  await fs.writeFile(manager.store.registryFile, JSON.stringify(raw)); await manager.store.load();
  assert.equal(manager.store.get(id).credentialPolicy.rcon, 'unclassified'); service.lock();
  await assert.rejects(manager.launch(id), { code: 'CREDENTIAL_POLICY_UNCLASSIFIED' }); assert.equal(children.size, 0);
  await service.unlock(vaultPassphrase); manager.credentialRuntime = credentialDriver(manager);
  const running = await manager.launch(id);
  assert.equal(running.credentialActivation.joinPasswordFlag, false); assert.equal(manager.store.get(id).credentialPolicy.rcon, 'required');
  await manager.stop(id);
});

test('optional Master credential never changes Join policy or blocks local start when locked', async t => {
  const { manager, service } = await credentialFixture(t);
  await manager.changeCredential('public-01', 'master', { value: 'A'.repeat(32), expectedSha256: (await service.status()).sha256 });
  service.lock();
  assert.equal(manager.store.get('public-01').credentialPolicy.join, 'none');
  const state = await manager.launch('public-01');
  assert.equal(state.status, 'RUNNING');
  await manager.stop('public-01');
});

test('legacy policy requires unlocked classification before restart can stop a process', async t => {
  const { manager, service, children, kills } = await credentialFixture(t);
  const id = 'public-01';
  const running = await manager.launch(id);
  const registry = manager.store.registryFile;
  const raw = JSON.parse(await fs.readFile(registry, 'utf8'));
  delete raw.instances[0].credentialPolicy;
  await fs.writeFile(registry, JSON.stringify(raw));
  await manager.store.load();
  service.lock();
  await assert.rejects(manager.launch(id, true), { code: 'CREDENTIAL_POLICY_UNCLASSIFIED' });
  assert.deepEqual(kills, []);
  assert.equal(children.get(running.pid).gone, false);
  await service.unlock(vaultPassphrase);
  await manager.launch(id, true);
  assert.equal(manager.store.get(id).credentialPolicy.join, 'none');
  assert.equal(kills.length, 1);
  await manager.stop(id);
});

test('legacy protected instance classifies required without starting an unprotected process', async t => {
  const { manager, service, children } = await credentialFixture(t);
  const id = 'public-01';
  // Represents a vault created by the earlier version, before policy metadata existed.
  await service.set(id, 'join', { value: 'Legacy-Join-123!', expectedSha256: (await service.status()).sha256 });
  const raw = JSON.parse(await fs.readFile(manager.store.registryFile, 'utf8'));
  delete raw.instances[0].credentialPolicy;
  await fs.writeFile(manager.store.registryFile, JSON.stringify(raw));
  await manager.store.load();
  await assert.rejects(manager.launch(id), { code: 'CREDENTIAL_RUNTIME_NOT_READY' });
  assert.equal(manager.store.get(id).credentialPolicy.join, 'required');
  assert.equal(children.size, 0);
});

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
