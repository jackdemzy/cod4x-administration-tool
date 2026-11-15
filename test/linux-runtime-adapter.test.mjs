import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLinuxInstanceOwnership, createLinuxRuntimeAdapter } from '../lib/linux-runtime-adapter.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const expected = { homePath: '/srv/instance-a', port: 28960, createdAt: 'boot:123', uid: 1000, gid: 1000 };
const info = { argv: ['/core/cod4x18_dedrun', '+set', 'fs_homepath', '/srv/instance-a', '+set', 'net_port', '28960'], createdAt: 'boot:123', uid: 1000, gid: 1000 };
test('Linux ownership accepts exact home port user group and birth', () => assertLinuxInstanceOwnership(info, expected));
test('Linux ownership rejects case changes duplicate overrides and PID reuse', () => {
  for (const changed of [{ ...info, argv: info.argv.map(value => value === '/srv/instance-a' ? '/srv/Instance-a' : value) }, { ...info, argv: [...info.argv, '+set', 'net_port', '28960'] }, { ...info, createdAt: 'boot:124' }, { ...info, uid: 0 }, { ...info, gid: 0 }]) assert.throws(() => assertLinuxInstanceOwnership(changed, expected), { code: 'INSTANCE_PROCESS_IDENTITY_BLOCKED' });
});
test('Linux adapter refuses root and non-Linux host', () => {
  assert.throws(() => createLinuxRuntimeAdapter({ hostProcess: { platform: 'linux', getuid: () => 0, geteuid: () => 0 } }).assertHost(), { code: 'RUNTIME_ROOT_BLOCKED' });
  assert.throws(() => createLinuxRuntimeAdapter({ hostProcess: { platform: 'win32' } }).assertHost(), { code: 'RUNTIME_PLATFORM_NOT_SUPPORTED' });
});
test('a zombie group leader with surviving threads is not confirmed process absence', async () => {
  const stat = `42 (cod4x18_dedrun) Z ${Array(18).fill('0').join(' ')} 123 0`;
  const filesystem = {
    async open() { let sent = false; return { async read(buffer) { if (sent) return { bytesRead: 0 }; sent = true; return { bytesRead: buffer.write(stat) }; }, async close() {} }; },
    async readdir() { return ['42', '43']; },
  };
  const result = await createLinuxRuntimeAdapter({ filesystem }).inspectProcess(42);
  assert.notEqual(result.alive, false);
});
test('native Linux procfs inspection returns actual executable argv credentials and stable birth', { skip: process.platform !== 'linux' }, async () => {
  const adapter = createLinuxRuntimeAdapter();
  adapter.assertHost();
  const first = await adapter.inspectProcess(process.pid);
  assert.equal(first.alive, true, first.error);
  assert.equal(first.executablePath, await fs.realpath(process.execPath));
  assert.equal(first.uid, process.getuid());
  assert.equal(first.gid, process.getgid());
  assert.equal(first.argv[0], process.execPath);
  assert.match(first.createdAt, /^[a-f0-9-]{36}:\d+$/);
  assert.equal((await adapter.inspectProcess(process.pid)).createdAt, first.createdAt);
  assert.equal((await adapter.inspectProcess(-1)).alive, null);
});
test('native Linux executable validation rejects missing bit, symlink and setuid', { skip: process.platform !== 'linux' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-adapter-'));
  const file = path.join(directory, 'cod4x18_dedrun');
  const link = path.join(directory, 'alias');
  const adapter = createLinuxRuntimeAdapter();
  try {
    await fs.writeFile(file, 'isolated executable-permission fixture');
    await fs.chmod(file, 0o600);
    await assert.rejects(adapter.validateExecutable(file), { code: 'RUNTIME_EXECUTABLE_BLOCKED' });
    await fs.chmod(file, 0o700);
    await adapter.validateExecutable(file);
    await fs.symlink(file, link);
    await assert.rejects(adapter.validateExecutable(link), { code: 'RUNTIME_EXECUTABLE_BLOCKED' });
    await fs.chmod(file, 0o4700);
    await assert.rejects(adapter.validateExecutable(file), { code: 'RUNTIME_EXECUTABLE_BLOCKED' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('native Linux output is run-owned, bounded even for invalid UTF8, and rejects aliases', { skip: process.platform !== 'linux' }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-output-'));
  const adapter = createLinuxRuntimeAdapter();
  const runId = crypto.randomUUID();
  try {
    const handles = await adapter.prepareOutput(home, runId);
    await handles[0].write(Buffer.alloc(300, 255));
    await handles[1].write('fixture stderr');
    await Promise.all(handles.map(handle => handle.close()));
    const output = await adapter.readOutput(home, runId, 16);
    assert.ok(Buffer.byteLength(output.stdout, 'utf8') <= 16);
    assert.equal(output.stdoutTruncated, true);
    assert.equal(output.stderr, 'fixture stderr');
    await assert.rejects(adapter.prepareOutput(home, runId), { code: 'EEXIST' });
    const stdout = path.join(home, 'logs', `runtime-${runId}-stdout.log`);
    await fs.link(stdout, path.join(home, 'foreign-alias'));
    await assert.rejects(adapter.readOutput(home, runId, 16), /exclusively owned/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

// Block 18: the adapter also serves remote servers whose paths are POSIX while this program may run on Windows.
test('output paths are built with the path API passed in, not the host default', async () => {
  const seen = [];
  const stat = { isDirectory: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o40700 };
  const filesystem = { lstat: async file => { seen.push(['lstat', file]); return stat; }, realpath: async file => { seen.push(['realpath', file]); return file; } };
  const pathApi = { join: (...parts) => parts.join('|'), resolve: value => value };
  const adapter = createLinuxRuntimeAdapter({ filesystem, hostProcess: { platform: 'linux', getuid: () => 1000, geteuid: () => 1000, getgid: () => 1000 }, pathApi });
  const runId = '0123abcd-0123-0123-0123-0123456789ab';
  assert.deepEqual(await adapter.outputPaths('/srv/home', runId), [`/srv/home|logs|runtime-${runId}-stdout.log`, `/srv/home|logs|runtime-${runId}-stderr.log`]);
  assert.deepEqual(seen.filter(([call]) => call === 'lstat').map(([, file]) => file), ['/srv/home', '/srv/home|logs']);
});

test('signal waits for an asynchronous kill before it reports success', async () => {
  const order = [];
  const info = { alive: true, executable: 'cod4x18_dedrun', executablePath: '/core/cod4x18_dedrun', argv: ['/core/cod4x18_dedrun', '+set', 'fs_homepath', '/srv/a', '+set', 'net_port', '28960'], uid: 1000, gid: 1000, createdAt: 'boot:1' };
  const filesystem = {
    readdir: async () => [], stat: async () => ({}), readlink: async () => info.executablePath,
    open: async file => ({
      cursor: 0,
      close: async () => {},
      read: async function read(buffer, offset, length) {
        const text = file.endsWith('/stat') ? `1 (cod4x18_dedrun) S ${'0 '.repeat(18)}1 0\n`
          : file.endsWith('/status') ? 'Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n'
          : file.endsWith('/cmdline') ? `${info.argv.join('\0')}\0` : 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n';
        const bytesRead = Buffer.from(text).copy(buffer, offset, this.cursor, this.cursor + length);
        this.cursor += bytesRead; // 0 at the end, like a real file
        return { bytesRead };
      },
    }),
  };
  let killed = false;
  const hostProcess = { platform: 'linux', getuid: () => 1000, geteuid: () => 1000, getgid: () => 1000, kill: async () => { await new Promise(resolve => setTimeout(resolve, 30)); killed = true; order.push('kill done'); } };
  const adapter = createLinuxRuntimeAdapter({ filesystem, hostProcess });
  const live = await adapter.inspectProcess(4321);
  assert.equal(live.alive, true);
  const result = await adapter.signal(4321, { homePath: '/srv/a', port: 28960, createdAt: live.createdAt, executablePath: info.executablePath }, 'SIGTERM');
  order.push('signal returned');
  assert.equal(result, true);
  assert.equal(killed, true);
  assert.deepEqual(order, ['kill done', 'signal returned']);
});

// Security audit 4.18.26 (A1-5): no PID-reuse race between the identity check and the signal.
function fakeProcessHost({ argv = ['/core/cod4x18_dedrun', '+set', 'fs_homepath', '/srv/a', '+set', 'net_port', '28960'], order = [] } = {}) {
  const filesystem = {
    readdir: async () => [], stat: async () => ({}), readlink: async () => '/core/cod4x18_dedrun',
    open: async file => {
      if (file.endsWith('/stat') && order.at(-1) !== 'inspect') order.push('inspect'); // one inspection reads stat twice
      return {
        cursor: 0, close: async () => {},
        read: async function read(buffer, offset, length) {
          const text = file.endsWith('/stat') ? `1 (cod4x18_dedrun) S ${'0 '.repeat(18)}1 0\n`
            : file.endsWith('/status') ? 'Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n'
            : file.endsWith('/cmdline') ? `${argv.join('\0')}\0` : 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n';
          const bytesRead = Buffer.from(text).copy(buffer, offset, this.cursor, this.cursor + length);
          this.cursor += bytesRead;
          return { bytesRead };
        },
      };
    },
  };
  const hostProcess = { platform: 'linux', getuid: () => 1000, geteuid: () => 1000, getgid: () => 1000, kill: async (pid, signalName) => { order.push(`kill ${signalName}`); } };
  return { filesystem, hostProcess, order };
}
const target = createdAt => ({ homePath: '/srv/a', port: 28960, createdAt, executablePath: '/core/cod4x18_dedrun' });

test('A1-5: an adopted process is signalled through a pidfd opened before the identity check', async () => {
  const host = fakeProcessHost();
  let closed = 0;
  const pidfd = async pid => { host.order.push(`pidfd ${pid}`); return { state: 'ready', send: async signalName => { host.order.push(`pidfd ${signalName}`); return true; }, close: () => { closed++; } }; };
  const adapter = createLinuxRuntimeAdapter({ ...host, pidfd });
  const live = await adapter.inspectProcess(4321);
  host.order.length = 0;
  assert.equal(await adapter.signal(4321, target(live.createdAt), 'SIGTERM'), true);
  assert.deepEqual(host.order, ['pidfd 4321', 'inspect', 'pidfd SIGTERM'], 'pidfd first, then the check, never a plain kill');
  assert.equal(closed, 0);
});

test('A1-5: a pidfd whose process is gone or fails the check sends nothing', async () => {
  const host = fakeProcessHost();
  const gone = createLinuxRuntimeAdapter({ ...host, pidfd: async () => ({ state: 'gone' }) });
  assert.equal(await gone.signal(4321, target('x'), 'SIGTERM'), false);
  assert.deepEqual(host.order, [], 'no inspection and no kill when the PID is already gone');

  const other = fakeProcessHost({ argv: ['/core/cod4x18_dedrun', '+set', 'fs_homepath', '/srv/b', '+set', 'net_port', '28960'] });
  let closed = 0, sent = 0;
  const adapter = createLinuxRuntimeAdapter({ ...other, pidfd: async () => ({ state: 'ready', send: async () => { sent++; return true; }, close: () => { closed++; } }) });
  const live = await adapter.inspectProcess(4321);
  await assert.rejects(adapter.signal(4321, target(live.createdAt), 'SIGKILL'), { code: 'INSTANCE_PROCESS_IDENTITY_BLOCKED' });
  assert.equal(sent, 0);
  assert.equal(closed, 1, 'the pidfd helper is closed after a refused check');
  assert.equal(other.order.some(entry => entry.startsWith('kill')), false);
});

test('A1-5: without pidfd support the check-then-kill fallback is used and reported', async () => {
  const host = fakeProcessHost();
  const reasons = [];
  const adapter = createLinuxRuntimeAdapter({ ...host, pidfd: async () => ({ state: 'unsupported', reason: 'ENOENT' }), onPidfdFallback: reason => reasons.push(reason) });
  const live = await adapter.inspectProcess(4321);
  host.order.length = 0;
  assert.equal(await adapter.signal(4321, target(live.createdAt), 'SIGTERM'), true);
  assert.deepEqual(host.order, ['inspect', 'kill SIGTERM']);
  assert.deepEqual(reasons, ['ENOENT']);
});

test('A1-5: a child CONTROL spawned itself is signalled through its own handle', async () => {
  const host = fakeProcessHost();
  let opened = 0;
  const adapter = createLinuxRuntimeAdapter({ ...host, pidfd: async () => { opened++; return { state: 'gone' }; } });
  const live = await adapter.inspectProcess(4321);
  host.order.length = 0;
  const signals = [];
  const child = { pid: 4321, exitCode: null, signalCode: null, kill: signalName => { signals.push(signalName); return true; } };
  assert.equal(await adapter.signal(4321, target(live.createdAt), 'SIGTERM', { child }), true);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(opened, 0, 'no pidfd for the own child');
  assert.deepEqual(host.order, ['inspect'], 'the identity is still checked, the plain kill is not used');
  // reaped meanwhile: Node's handle is gone, so kill returns false and nothing else is hit
  assert.equal(await adapter.signal(4321, target(live.createdAt), 'SIGKILL', { child: { ...child, kill: () => false } }), false);
  // a child of another PID or one that already exited is not trusted
  assert.equal(await adapter.signal(4321, target(live.createdAt), 'SIGTERM', { child: { ...child, exitCode: 0 } }), false);
  assert.equal(opened, 1);
});
