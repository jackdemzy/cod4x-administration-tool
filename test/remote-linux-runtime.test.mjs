import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRemoteLinuxAdapter } from '../lib/remote-linux-runtime.mjs';
import { startCoreCommand, parsePid } from '../lib/remote-commands.mjs';
import { createLoopbackServer, buildFakeCore, loopbackAvailable } from './support/loopback-transport.mjs';

const available = await loopbackAvailable();
const skip = available ? false : 'needs Linux, a non-root user, gcc and setsid';
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (predicate, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 20))) if (await predicate()) return true; return false; };
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code, code);
const ids = () => ({ uid: process.getuid(), gid: process.getgid() });

async function fixture(t) {
  const loopback = await createLoopbackServer();
  t.after(() => loopback.cleanup());
  const core = await buildFakeCore(loopback.path('core'));
  const adapter = await createRemoteLinuxAdapter(loopback.session, ids());
  // starts a fake core the way the manager will: private home, logs folder, managed arguments
  async function start(name, port) {
    const home = loopback.path(name);
    await fs.mkdir(`${home}/logs`, { recursive: true, mode: 0o700 });
    await fs.chmod(home, 0o700);
    const runId = crypto.randomUUID();
    const { stdoutFile, stderrFile } = await adapter.prepareRemoteOutput(home, runId);
    const args = ['+set', 'fs_homepath', home, '+set', 'net_port', String(port)];
    const result = await loopback.session.exec(startCoreCommand({ core, cwd: loopback.root, args, stdoutFile, stderrFile }));
    const pid = parsePid(result.stdout);
    t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
    return { pid, home, port, runId, args };
  }
  return { loopback, core, adapter, start };
}

test('inspectProcess on a started core returns its identity, with POSIX values', { skip }, async t => {
  const { adapter, core, start } = await fixture(t);
  const run = await start('a', 28960);
  const info = await adapter.inspectProcess(run.pid);
  assert.equal(info.alive, true);
  assert.equal(info.executablePath, core);
  assert.equal(info.executable, 'cod4x18_dedrun');
  assert.deepEqual(info.argv, [core, ...run.args]);
  assert.deepEqual([info.uid, info.gid], [process.getuid(), process.getgid()]);
  assert.match(info.createdAt, /^[a-f0-9-]{36}:\d+$/);
});

test('inspectProcess: a process that is gone is not alive, an invalid pid is unknown', { skip }, async t => {
  const { adapter, start } = await fixture(t);
  const run = await start('a', 28960);
  process.kill(run.pid, 'SIGKILL');
  assert.ok(await until(async () => (await adapter.inspectProcess(run.pid)).alive === false), 'reported as gone');
  assert.equal((await adapter.inspectProcess(0)).alive, null);
  assert.equal((await adapter.inspectProcess(-4)).alive, null);
  assert.equal((await adapter.inspectProcess(4194000)).alive, false, 'a pid that never existed');
});

test('signal stops only the core that matches executable, home, port and birth', { skip }, async t => {
  const { adapter, core, loopback, start } = await fixture(t);
  const one = await start('one', 28960), two = await start('two', 28961);
  const expected = run => ({ homePath: run.home, port: run.port, executablePath: core, createdAt: null });
  const birth = async run => (await adapter.inspectProcess(run.pid)).createdAt;
  // wrong executable, wrong home, wrong port, wrong birth: all blocked, both cores keep running
  await rejects(adapter.signal(one.pid, { ...expected(one), createdAt: await birth(one), executablePath: '/bin/sleep' }, 'SIGTERM'), 'INSTANCE_PROCESS_IDENTITY_BLOCKED');
  await rejects(adapter.signal(one.pid, { ...expected(two), createdAt: await birth(one) }, 'SIGTERM'), 'INSTANCE_PROCESS_IDENTITY_BLOCKED');
  await rejects(adapter.signal(one.pid, { ...expected(one), port: 28961, createdAt: await birth(one) }, 'SIGTERM'), 'INSTANCE_PROCESS_IDENTITY_BLOCKED');
  await rejects(adapter.signal(one.pid, { ...expected(one), createdAt: 'other-boot:1' }, 'SIGTERM'), 'INSTANCE_PROCESS_IDENTITY_BLOCKED');
  await rejects(adapter.signal(one.pid, { ...expected(one), createdAt: null }, 'SIGTERM'), 'INSTANCE_PROCESS_IDENTITY_BLOCKED');
  assert.ok(alive(one.pid) && alive(two.pid));
  // the matching one is stopped, the kill is awaited, and it goes through the fixed command
  assert.equal(await adapter.signal(one.pid, { ...expected(one), createdAt: await birth(one) }, 'SIGTERM'), true);
  assert.ok(loopback.session.calls.includes(`kill -s TERM ${one.pid}`));
  assert.ok(await until(() => !alive(one.pid)), 'the core ended');
  assert.ok(alive(two.pid), 'the sibling core is untouched');
  assert.equal(await adapter.signal(one.pid, { ...expected(one), createdAt: 'x' }, 'SIGTERM'), false, 'already gone');
  await rejects(adapter.signal(two.pid, { ...expected(two), createdAt: await birth(two) }, 'SIGHUP'), undefined);
});

test('readOutput returns what the started core wrote, bounded', { skip }, async t => {
  const { adapter, start } = await fixture(t);
  const run = await start('a', 28960);
  assert.ok(await until(async () => (await adapter.readOutput(run.home, run.runId, 65536)).stderr.includes('fixture stderr')));
  const output = await adapter.readOutput(run.home, run.runId, 65536);
  assert.ok(output.stdout.includes('fs_homepath') && output.stdout.includes(run.home));
  assert.deepEqual([output.stdoutTruncated, output.stderrTruncated], [false, false]);
  const small = await adapter.readOutput(run.home, run.runId, 16);
  assert.ok(Buffer.byteLength(small.stdout) <= 16 && small.stdoutTruncated === true);
});

test('readOutput of a 3 MiB file and of invalid UTF-8 stays bounded and valid text', { skip }, async t => {
  const { adapter, loopback } = await fixture(t);
  const home = loopback.path('big');
  await fs.mkdir(`${home}/logs`, { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700);
  const runId = crypto.randomUUID();
  const { stdoutFile, stderrFile } = await adapter.prepareRemoteOutput(home, runId);
  await fs.writeFile(stdoutFile, Buffer.concat([Buffer.alloc(3 * 1024 * 1024, 0x61), Buffer.from('END')]), { mode: 0o600 });
  await fs.writeFile(stderrFile, Buffer.from([0xff, 0xfe, 0x80, 0x81, 0x61, 0xc3, 0x28, 0x62]), { mode: 0o600 });
  const output = await adapter.readOutput(home, runId, 65536);
  assert.ok(Buffer.byteLength(output.stdout) <= 65536 && output.stdout.endsWith('END') && output.stdoutTruncated === true);
  assert.equal(typeof output.stderr, 'string');
  assert.ok(!output.stderr.includes('\u0000'));
  assert.equal(Buffer.from(output.stderr, 'utf8').toString('utf8'), output.stderr, 'the text survives a UTF-8 round trip');
  await rejects(adapter.readOutput(home, runId, 0), undefined);
  await rejects(adapter.readOutput(home, runId, 2 * 1024 * 1024), undefined);
});

test('readOutput refuses a hard-linked output file and a symlinked one', { skip }, async t => {
  const { adapter, start, loopback } = await fixture(t);
  const run = await start('a', 28960);
  const stdout = `${run.home}/logs/runtime-${run.runId}-stdout.log`;
  await fs.link(stdout, loopback.path('alias'));
  await assert.rejects(adapter.readOutput(run.home, run.runId, 64), /exclusively owned/);
  await fs.rm(loopback.path('alias'));
  const target = loopback.path('target.log');
  await fs.writeFile(target, 'secret');
  await fs.rm(stdout); await fs.symlink(target, stdout);
  await assert.rejects(adapter.readOutput(run.home, run.runId, 64), /exclusively owned/);
});

test('prepareRemoteOutput checks the home and logs folder and the run id', { skip }, async t => {
  const { adapter, loopback } = await fixture(t);
  const home = loopback.path('h');
  await fs.mkdir(`${home}/logs`, { recursive: true, mode: 0o700 }); await fs.chmod(home, 0o700);
  const runId = crypto.randomUUID();
  const paths = await adapter.prepareRemoteOutput(home, runId);
  assert.deepEqual(paths, { stdoutFile: `${home}/logs/runtime-${runId}-stdout.log`, stderrFile: `${home}/logs/runtime-${runId}-stderr.log` });
  await assert.rejects(adapter.prepareRemoteOutput(home, 'not-a-run-id'), /run identity/);
  await rejects(adapter.prepareRemoteOutput('relative/home', runId), 'REMOTE_PATH_INVALID');
  await fs.chmod(`${home}/logs`, 0o770);
  await assert.rejects(adapter.prepareRemoteOutput(home, runId), /output/i);
  await fs.chmod(`${home}/logs`, 0o700);
  await fs.rm(`${home}/logs`, { recursive: true }); await fs.symlink(loopback.root, `${home}/logs`);
  await assert.rejects(adapter.prepareRemoteOutput(home, runId), /output/i);
  await assert.rejects(adapter.prepareRemoteOutput(loopback.path('missing'), runId));
  await rejects(adapter.prepareOutput(home, runId), 'REMOTE_UNSUPPORTED');
});

test('a root login is refused by every operation that acts', { skip }, async t => {
  const { loopback, core } = await fixture(t);
  const rootAdapter = await createRemoteLinuxAdapter(loopback.session, { uid: 0, gid: 0 });
  await rejects(rootAdapter.validateExecutable(core), 'RUNTIME_ROOT_BLOCKED');
  await rejects(rootAdapter.signal(1234, { homePath: '/x', port: 1, createdAt: 'a', executablePath: core }, 'SIGTERM'), 'RUNTIME_ROOT_BLOCKED');
  await rejects(rootAdapter.prepareRemoteOutput(loopback.root, crypto.randomUUID()), 'RUNTIME_ROOT_BLOCKED');
});

test('validateExecutable accepts a plain executable and refuses a symlink, a non-executable and a setuid file', { skip }, async t => {
  const { adapter, core, loopback } = await fixture(t);
  await adapter.validateExecutable(core);
  const link = loopback.path('link-core');
  await fs.symlink(core, link);
  await assert.rejects(adapter.validateExecutable(link), /regular executable/);
  const plain = loopback.path('plain'); await fs.writeFile(plain, 'x', { mode: 0o644 });
  await assert.rejects(adapter.validateExecutable(plain), /regular executable/);
  const suid = loopback.path('suid'); await fs.copyFile(core, suid); await fs.chmod(suid, 0o4755);
  await assert.rejects(adapter.validateExecutable(suid), /regular executable/);
  await assert.rejects(adapter.validateExecutable(loopback.path('nope')), error => error.code === 'ENOENT');
});

test('the remote file system: metadata, errors, directory listing, links and reading', { skip }, async t => {
  const { adapter, loopback } = await fixture(t);
  const files = adapter.filesystem;
  const file = loopback.path('f'), hard = loopback.path('hard'), link = loopback.path('lnk');
  await fs.writeFile(file, '0123456789', { mode: 0o640 });
  const first = await files.lstat(file);
  assert.deepEqual([first.isFile(), first.isDirectory(), first.isSymbolicLink(), first.size, first.nlink, first.uid, first.mode & 0o777], [true, false, false, 10, 1, process.getuid(), 0o640]);
  await fs.link(file, hard); await fs.symlink(file, link);
  const second = await files.lstat(file);
  assert.deepEqual([second.nlink, second.dev, second.ino], [2, first.dev, first.ino]);
  assert.equal((await files.lstat(link)).isSymbolicLink(), true);
  assert.equal((await files.stat(link)).isFile(), true);
  assert.equal((await files.lstat(loopback.root)).isDirectory(), true);
  assert.equal(await files.readlink(link), file);
  assert.equal(await files.realpath(link), file);
  // "." and ".." are not entries
  assert.deepEqual((await files.readdir(loopback.root)).sort(), ['core', 'f', 'hard', 'lnk']);
  // errors carry node-style codes
  await rejects(files.lstat(loopback.path('nope')), 'ENOENT');
  await rejects(files.readlink(loopback.path('nope')), 'ENOENT');
  await rejects(files.readdir(loopback.path('nope')), 'ENOENT');
  await rejects(files.open(loopback.path('nope'), 'r'), 'ENOENT');
  // access approximates access(2) from mode, owner and group
  await files.access(file, 0); await files.access(file, 4); await files.access(file, 2);
  await rejects(files.access(file, 1), 'EACCES');
  await files.access(loopback.path('core', 'cod4x18_dedrun'), 1);
  // reading: a null position continues where the last read ended, a number reads there, the end gives 0 bytes
  const handle = await files.open(file, 'r');
  const buffer = Buffer.alloc(4);
  assert.deepEqual([(await handle.read(buffer, 0, 4, null)).bytesRead, buffer.toString()], [4, '0123']);
  assert.deepEqual([(await handle.read(buffer, 0, 4, null)).bytesRead, buffer.toString()], [4, '4567']);
  assert.deepEqual([(await handle.read(buffer, 0, 4, 1)).bytesRead, buffer.toString()], [4, '1234']);
  assert.equal((await handle.read(buffer, 0, 4, null)).bytesRead, 2, 'continues after the last null-position read');
  assert.equal((await handle.read(buffer, 0, 4, null)).bytesRead, 0, 'end of file');
  assert.equal((await handle.stat()).size, 10);
  await handle.close(); await handle.close();
  // read-only here
  await rejects(files.open(file, 'w'), 'EINVAL');
  await rejects(files.open(file, 'a'), 'EINVAL');
});

test('files that report size 0 but have content (/proc) can be read through the SFTP layer', { skip }, async t => {
  const { adapter } = await fixture(t);
  const handle = await adapter.filesystem.open('/proc/self/stat', 'r');
  const buffer = Buffer.alloc(4096);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
  await handle.close();
  assert.ok(bytesRead > 20, `read ${bytesRead} bytes`);
  assert.match(buffer.subarray(0, bytesRead).toString(), /^\d+ \(.+\) [A-Z] /);
  assert.equal((await adapter.filesystem.stat('/proc/self/stat')).size, 0, 'procfs reports size 0, which is why reads never rely on the size');
});

test('the adapter is built with POSIX paths whatever the host is', async () => {
  const source = await fs.readFile(new URL('../lib/remote-linux-runtime.mjs', import.meta.url), 'utf8');
  assert.match(source, /pathApi: path\.posix/);
  assert.ok(!/\bpath\.(join|resolve)\(/.test(source), 'no host-specific path building in the remote runtime');
});
