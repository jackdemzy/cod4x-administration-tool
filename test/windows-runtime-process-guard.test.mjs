import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// Execute the production Runtime Manager; replace only OS/file I/O.
// This is an audit harness, not proof of a native CoD4X lifecycle.
const source = fs.readFileSync(new URL('../lib/runtime-manager.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const RUNTIME_STATE_FILE =');
const end = source.indexOf('// Runtime manager API', start);
assert.ok(start >= 0 && end > start, 'Runtime Manager extraction boundary missing');
function harness({ queryFails = false, imagePath = 'C:\\core\\cod4x18_dedrun.exe', reuseBeforeForce = false, lifecycle = false, earlyExit = false, verified = true } = {}) {
  const commands = [];
  const children = [];
  let terminated = false;
  let firstStop = false;
  const context = vm.createContext({
    stateFile: null, seedState: {}, fixedConfiguration: null, ownership: null, dependencies: {},
    path: { ...path.win32, win32: path.win32 }, crypto, Buffer, console, setTimeout, process: { platform: 'win32', pid: 123, env: {} },
    SERVER_CORE_DEFINITIONS: { windows: { executable: 'cod4x18_dedrun.exe' } },
    dataPath: (...parts) => path.join('C:\\isolated-audit', ...parts),
    fs: { mkdir: async () => {}, writeFile: async () => {}, rename: async () => {}, stat: async () => ({ isDirectory: () => true }) },
    serverCoreDefinition: () => ({ executable: 'cod4x18_dedrun.exe' }),
    normalizeServerPlatform: value => value,
    normalizeRuntimePath: value => value,
    resolveServerTarget: async () => ({ target: 'C:\\isolated-audit\\server', root: 'C:\\isolated-audit', checks: [] }),
    resolveRuntimeExecutable: async () => 'C:\\core\\cod4x18_dedrun.exe',
    verifiedRuntimeCoreStatus: async () => ({ verified, reasons: [] }),
    selectRuntimeBaseGamePath: (value, state) => value || state.baseGamePath || '',
    resolveRuntimeLayout: async () => { commands.push({ file: 'layout' }); return { coreWorkingDirectory: 'C:\\core', filesystemBasePath: 'C:\\game', filesystemHomePath: 'C:\\isolated-audit\\server' }; },
    policyState: { security: { allowedCod4xVersions: ['21.5'] } },
    spawn: (executable, args, options) => {
      const child = new EventEmitter();
      child.launch = { executable, args, options };
      child.pid = 456;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.unref = () => {};
      children.push(child);
      queueMicrotask(() => {
        child.emit('spawn');
        child.stdout.emit('data', Buffer.from('early stdout\n'));
        child.stderr.emit('data', Buffer.from('early stderr\n'));
        if (earlyExit) child.emit('exit', 29, null);
      });
      return child;
    },
    execFileAsync: async (file, args) => {
      commands.push({ file, args });
      if (file === 'tasklist.exe') {
        if (queryFails) throw new Error('Access denied during process inspection');
        return { stdout: terminated ? 'INFO: No tasks are running' : '"cod4x18_dedrun.exe","456","Console","1","1 K"' };
      }
      if (file === 'powershell.exe') return { stdout: JSON.stringify(terminated ? { found: false } : { found: true, executablePath: reuseBeforeForce && firstStop ? 'C:\\other\\cod4x18_dedrun.exe' : imagePath }) };
      if (file === 'taskkill.exe') {
        firstStop = true;
        if (!reuseBeforeForce || args.includes('/F')) terminated = true;
        return { stdout: '' };
      }
      throw new Error(`Unexpected OS command: ${file}`);
    },
  });
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext(`runtimeState.status='RUNNING';runtimeState.pid=456;runtimeState.executablePath='C:\\\\core\\\\cod4x18_dedrun.exe';`, context);
  if (lifecycle) vm.runInContext('runtimeState.status="STOPPED";runtimeState.pid=null;', context);
  return { context, commands, children, evaluate: (code) => vm.runInContext(code, context) };
}

test('state write failure before spawn rejects without creating a child', async () => {
  const h = harness({ lifecycle: true });
  h.context.fs.writeFile = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  await assert.rejects(h.evaluate('startRuntime({relative:"server"})'), { code: 'RUNTIME_PERSISTENCE_FAILED' });
  assert.equal(h.children.length, 0);
  assert.equal(h.evaluate('runtimeState.status'), 'FAILED');
});

test('post-spawn write failure rejects but retains running PID and prevents duplicate start', async () => {
  const h = harness({ lifecycle: true });
  h.context.fs.writeFile = async () => { if (h.children.length) throw new Error('disk full after spawn'); };
  await assert.rejects(h.evaluate('startRuntime({relative:"server"})'), { code: 'RUNTIME_PERSISTENCE_FAILED' });
  assert.equal(h.evaluate('runtimeState.status'), 'RUNNING');
  assert.equal(h.evaluate('runtimeState.pid'), 456);
  await assert.rejects(h.evaluate('startRuntime({relative:"server"})'), /already running/);
  assert.equal(h.children.length, 1);
});

test('stop write failure rejects while preserving the actually stopped state', async () => {
  const h = harness();
  h.context.fs.writeFile = async () => { throw new Error('disk full after stop'); };
  await assert.rejects(h.evaluate('stopRuntime()'), { code: 'RUNTIME_PERSISTENCE_FAILED' });
  assert.equal(h.evaluate('runtimeState.status'), 'STOPPED');
  assert.equal(h.evaluate('runtimeState.pid'), null);
});

test('restart cannot launch a replacement when stopped state cannot be saved', async () => {
  const h = harness();
  h.context.fs.writeFile = async () => { throw new Error('disk full during restart'); };
  await assert.rejects(h.evaluate('restartRuntime({relative:"server"})'), { code: 'RUNTIME_PERSISTENCE_FAILED' });
  assert.equal(h.children.length, 0);
  assert.equal(h.evaluate('runtimeState.status'), 'STOPPED');
  assert.equal(h.evaluate('runtimeState.pid'), null);
});

test('start retains stdout and stderr emitted immediately after spawn', async () => {
  const h = harness({ lifecycle: true });
  const state = await h.evaluate('startRuntime({relative:"server"})');
  assert.match(state.output.stdout, /early stdout/);
  assert.match(state.output.stderr, /early stderr/);
});

test('private output mode drops early and later bytes and sanitizes stream errors before persistence', async () => {
  const h = harness({ lifecycle: true });
  const persisted = [];
  h.context.fs.writeFile = async (_file, bytes) => { persisted.push(String(bytes)); };
  const state = await h.evaluate('startRuntime({relative:"server",outputPolicy:"private"})');
  const secret = 'Disposable-stream-secret-123!';
  h.children[0].stdout.emit('data', Buffer.from(secret.slice(0, 10)));
  h.children[0].stdout.emit('data', Buffer.from(secret.slice(10)));
  h.children[0].stderr.emit('data', Buffer.from(secret));
  h.children[0].stderr.emit('error', new Error(secret));
  await h.evaluate('persistRuntimeState()');
  assert.equal(state.outputPolicy, 'private');
  assert.equal(state.consoleOutputPrivate, true);
  assert.equal(state.output.stdout, ''); assert.equal(state.output.stderr, '');
  assert.ok(!JSON.stringify(state).includes(secret));
  assert.ok(!persisted.join('').includes(secret));
  assert.ok(!persisted.join('').includes('early stdout'));
  assert.ok(!persisted.join('').includes('early stderr'));
  assert.equal(state.history.find(event => event.event === 'runtime.output.error').error, 'RUNTIME_PRIVATE_OUTPUT_ERROR');
});

test('unknown output mode is refused before spawning', async () => {
  const h = harness({ lifecycle: true });
  await assert.rejects(h.evaluate('startRuntime({relative:"server",outputPolicy:null})'), { code: 'RUNTIME_OUTPUT_POLICY_INVALID' });
  await assert.rejects(h.evaluate('startRuntime({relative:"server",outputPolicy:"typo"})'), { code: 'RUNTIME_OUTPUT_POLICY_INVALID' });
  assert.equal(h.children.length, 0);
  await assert.rejects(h.evaluate('startRuntime({relative:"server",platform:"linux",outputPolicy:"private"})'), { code: 'RUNTIME_PRIVATE_OUTPUT_UNSUPPORTED' });
  assert.equal(h.children.length, 0);
  await h.evaluate('startRuntime({relative:"server"})');
  await assert.rejects(h.evaluate('restartRuntime({relative:"server",outputPolicy:null})'), { code: 'RUNTIME_OUTPUT_POLICY_INVALID' });
  await assert.rejects(h.evaluate('restartRuntime({relative:"server",outputPolicy:"typo"})'), { code: 'RUNTIME_OUTPUT_POLICY_INVALID' });
  assert.equal(h.commands.some(command => command.file === 'taskkill.exe'), false);
});

test('unverified core is rejected before layout creates a server home', async () => {
  const h = harness({ lifecycle: true, verified: false });
  await assert.rejects(h.evaluate('startRuntime({relative:"server"})'), /Verified-Core gate/);
  assert.equal(h.commands.some(command => command.file === 'layout'), false);
  assert.equal(h.children.length, 0);
});

test('launch separates dedicated executable, core cwd, BaseGame and server home', async () => {
  const h = harness({ lifecycle: true });
  await h.evaluate('startRuntime({relative:"server"})');
  const { executable, args, options } = h.children[0].launch;
  assert.equal(executable, 'C:\\core\\cod4x18_dedrun.exe');
  assert.equal(options.cwd, 'C:\\core');
  assert.equal(args[args.indexOf('fs_basepath') + 1], 'C:\\game');
  assert.equal(args[args.indexOf('fs_homepath') + 1], 'C:\\isolated-audit\\server');
  assert.equal(options.shell, false);
});

test('failed stop does not classify a later unexpected exit as expected', async () => {
  const h = harness({ lifecycle: true });
  await h.evaluate('startRuntime({relative:"server"})');
  h.context.execFileAsync = async file => {
    if (file === 'tasklist.exe') return { stdout: '"cod4x18_dedrun.exe","456","Console","1","1 K"' };
    if (file === 'powershell.exe') return { stdout: JSON.stringify({ executablePath: 'C:\\core\\cod4x18_dedrun.exe' }) };
    if (file === 'taskkill.exe') throw new Error('Stop denied');
    throw new Error('Unexpected command');
  };
  h.evaluate('waitForWindowsProcess=async()=>({ok:false})');
  await assert.rejects(h.evaluate('stopRuntime()'), /Stop denied/);
  h.children[0].emit('exit', 29, null);
  assert.equal(h.evaluate('runtimeState.status'), 'FAILED');
});

test('early crash rejects start and preserves the exit code', async () => {
  const h = harness({ lifecycle: true, earlyExit: true });
  await assert.rejects(h.evaluate('startRuntime({relative:"server"})'), /exited/i);
  assert.equal(h.evaluate('runtimeState.status'), 'FAILED');
  assert.equal(h.evaluate('runtimeState.exitCode'), 29);
  assert.equal(h.evaluate('runtimeChild'), null);
});

test('concurrent starts spawn only one child', async () => {
  const h = harness({ lifecycle: true });
  const results = await Promise.allSettled([
    h.evaluate('startRuntime({relative:"server"})'),
    h.evaluate('startRuntime({relative:"server"})'),
  ]);
  assert.equal(h.children.length, 1);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});

test('configuration changes are refused while a lifecycle operation is pending', async () => {
  const h = harness({ lifecycle: true });
  const pending = h.evaluate('startRuntime({relative:"server"})');
  await assert.rejects(h.evaluate('withRuntimeConfiguration(async()=>true)'), /Stop the runtime/);
  await pending;
  await assert.rejects(h.evaluate('withRuntimeConfiguration(async()=>true)'), /Stop the runtime/);
});

test('unexpected zero-code exit is still a runtime failure', async () => {
  const h = harness({ lifecycle: true });
  await h.evaluate('startRuntime({relative:"server"})');
  h.children[0].emit('exit', 0, null);
  assert.equal(h.evaluate('runtimeState.status'), 'FAILED');
  assert.equal(h.evaluate('runtimeState.exitCode'), 0);
});

test('late output from an old child cannot pollute a new run', async () => {
  const h = harness({ lifecycle: true });
  await h.evaluate('startRuntime({relative:"server"})');
  const old = h.children[0];
  old.emit('exit', 29, null);
  await h.evaluate('startRuntime({relative:"server"})');
  old.stdout.emit('data', Buffer.from('obsolete output'));
  assert.doesNotMatch(h.evaluate('runtimeState.output.stdout'), /obsolete output/);
});

test('control: expected PID at expected path can stop', async () => {
  const h = harness();
  const state = await h.evaluate('stopRuntime()');
  assert.equal(state.status, 'STOPPED');
  assert.equal(state.pid, null);
});

test('inspection failure must not become confirmed process absence', async () => {
  const h = harness({ queryFails: true });
  const info = await h.evaluate('windowsProcessInfo(456)');
  assert.notEqual(info.alive, false, 'Inspection failure was reported as confirmed process absence');
});

test('stop preserves PID and state when process inspection fails', async () => {
  const h = harness({ queryFails: true });
  await assert.rejects(h.evaluate('stopRuntime()'), /inspection failed/i);
  assert.equal(h.evaluate('runtimeState.pid'), 456);
  assert.equal(h.evaluate('runtimeState.status'), 'RUNNING');
  assert.equal(h.commands.some(command => command.file === 'taskkill.exe'), false);
});

test('stop must refuse a same-name process at a different executable path', async () => {
  const h = harness({ imagePath: 'C:\\other\\cod4x18_dedrun.exe' });
  let rejected = false;
  try { await h.evaluate('stopRuntime()'); } catch { rejected = true; }
  assert.equal(h.commands.some(command => command.file === 'taskkill.exe'), false,
    'Stop issued taskkill against a same-name executable at an unexpected path');
  assert.equal(rejected, true, 'Stop must reject identity mismatch');
});

test('forced fallback must recheck identity after the graceful wait', async () => {
  const h = harness({ reuseBeforeForce: true });
  // Shorten only the audit timeout; production control flow is unchanged.
  h.context.setTimeout = callback => { callback(); return 0; };
  let rejected = false;
  try { await h.evaluate('stopRuntime()'); } catch { rejected = true; }
  assert.equal(h.commands.some(command => command.file === 'taskkill.exe' && command.args.includes('/F')), false,
    'Forced stop issued despite the PID changing executable path during the wait');
  assert.equal(rejected, true, 'A changed process identity must be rejected');
});

test('control: runtime output stays bounded for ASCII output', () => {
  const h = harness();
  h.context.chunk = Buffer.alloc(100_000, 65);
  h.evaluate('appendRuntimeOutput("stdout",chunk)');
  const output = h.evaluate('runtimeState.output');
  assert.ok(Buffer.byteLength(output.stdout) <= 64 * 1024);
  assert.equal(output.stdoutTruncated, true);
});
