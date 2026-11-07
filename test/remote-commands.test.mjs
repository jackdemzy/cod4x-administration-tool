import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  probeCommand, parseProbe, makeDirectoriesCommand, startCoreCommand, parsePid, signalCommand,
  getinfoProbeCommand, diskFreeCommand, parseDiskFree, statCommand, parseStat, recoverHomeCommand,
} from '../lib/remote-commands.mjs';
import { createLoopbackServer, buildFakeCore, loopbackAvailable } from './support/loopback-transport.mjs';
import { startFakeCod4xServer } from './support/fake-cod4x-udp.mjs';

const available = await loopbackAvailable();
const skip = available ? false : 'needs Linux, a non-root user, gcc and setsid';
const code = fn => { try { fn(); return null; } catch (error) { return error.code || 'THROWN'; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (predicate, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 20))) if (await predicate()) return true; return false; };

async function server(t) {
  const loopback = await createLoopbackServer();
  t.after(() => loopback.cleanup());
  return loopback;
}

test('parseProbe accepts Linux x86_64 and rejects everything else', () => {
  assert.deepEqual(parseProbe(Buffer.from('Linux x86_64\n1000\n1001\n')), { os: 'Linux', arch: 'x86_64', uid: 1000, gid: 1001 });
  assert.equal(code(() => parseProbe(Buffer.from('Linux aarch64\n1000\n1000\n'))), 'REMOTE_PLATFORM_UNSUPPORTED');
  assert.equal(code(() => parseProbe(Buffer.from('FreeBSD amd64\n1000\n1000\n'))), 'REMOTE_PLATFORM_UNSUPPORTED');
  for (const bad of ['', 'Linux x86_64\n', 'Linux x86_64\nx\n1\n', 'Linux x86_64\n-1\n1\n', 'Linux x86_64\n1\n1\nextra\n', 'Linux\n1\n1\n']) {
    assert.equal(code(() => parseProbe(Buffer.from(bad))), 'REMOTE_PROBE_INVALID', JSON.stringify(bad));
  }
});

test('parsePid and parseDiskFree read exactly what the commands print', () => {
  assert.equal(parsePid(Buffer.from('4242\n')), 4242);
  for (const bad of ['', '\n', 'abc\n', '0\n', '1\n', '12 34\n', '-5\n', '99999999999\n', '4242\nextra\n']) assert.equal(code(() => parsePid(Buffer.from(bad))), 'REMOTE_START_FAILED', JSON.stringify(bad));
  assert.equal(parseDiskFree(Buffer.from('/dev/sda1 1000000 400000 600000 40% /srv\n')), 600000);
  for (const bad of ['', 'garbage', '/dev/sda1 a b c d e\n']) assert.equal(code(() => parseDiskFree(Buffer.from(bad))), 'REMOTE_DISKFREE_INVALID');
});

test('signalCommand takes only a safe pid and TERM or KILL', () => {
  assert.equal(signalCommand(1234, 'TERM'), 'kill -s TERM 1234');
  assert.equal(signalCommand(1234, 'KILL'), 'kill -s KILL 1234');
  for (const pid of [0, 1, -1, 1.5, NaN, Infinity, '12', null, undefined, 4194305, 2 ** 40]) assert.equal(code(() => signalCommand(pid, 'TERM')), 'REMOTE_ARGUMENT_INVALID', String(pid));
  for (const name of ['HUP', 'term', '9', 'TERM; id', '', undefined]) assert.equal(code(() => signalCommand(1234, name)), 'REMOTE_ARGUMENT_INVALID', String(name));
});

test('builders refuse relative paths, traversal and bad names before building anything', () => {
  assert.equal(code(() => makeDirectoriesCommand('srv/home', ['main'])), 'REMOTE_PATH_INVALID');
  assert.equal(code(() => makeDirectoriesCommand('/srv/../home', ['main'])), 'REMOTE_PATH_INVALID');
  for (const name of ['', '..', 'a/b', 'A', 'a b', 'a;b', '-x']) assert.equal(code(() => makeDirectoriesCommand('/srv/home', [name])), 'REMOTE_ARGUMENT_INVALID', name);
  const base = { core: '/srv/h/core/cod4x18_dedrun', cwd: '/srv/base', args: ['+set', 'dedicated', '2'], stdoutFile: '/srv/h/logs/o.log', stderrFile: '/srv/h/logs/e.log' };
  assert.equal(code(() => startCoreCommand({ ...base, core: 'cod4x18_dedrun' })), 'REMOTE_PATH_INVALID');
  assert.equal(code(() => startCoreCommand({ ...base, cwd: '/srv/../x' })), 'REMOTE_PATH_INVALID');
  assert.equal(code(() => startCoreCommand({ ...base, stdoutFile: '/srv/h/logs/../o.log' })), 'REMOTE_PATH_INVALID');
  assert.equal(code(() => startCoreCommand({ ...base, args: ['ok', 5] })), 'REMOTE_ARGUMENT_INVALID');
  assert.equal(code(() => startCoreCommand({ ...base, args: ['a\u0000b'] })), 'REMOTE_ARGUMENT_INVALID');
  assert.equal(code(() => startCoreCommand({ ...base, args: 'not-a-list' })), 'REMOTE_ARGUMENT_INVALID');
  assert.equal(code(() => getinfoProbeCommand(0)), 'REMOTE_ARGUMENT_INVALID');
  assert.equal(code(() => getinfoProbeCommand(70000)), 'REMOTE_ARGUMENT_INVALID');
  assert.equal(code(() => getinfoProbeCommand('28960; id')), 'REMOTE_ARGUMENT_INVALID');
  assert.equal(code(() => diskFreeCommand('relative')), 'REMOTE_PATH_INVALID');
});

test('probeCommand prints the platform and the numeric user and group of the login', { skip }, async t => {
  const { session } = await server(t);
  const result = await session.exec(probeCommand());
  assert.equal(result.code, 0);
  const lines = result.stdout.toString().trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], `${process.platform === 'linux' ? 'Linux' : '?'} ${(await import('node:os')).default.machine()}`);
  assert.deepEqual([lines[1], lines[2]], [String(process.getuid()), String(process.getgid())]);
});

test('makeDirectoriesCommand creates a private home with its folders, with hostile characters in the path inert', { skip }, async t => {
  const loopback = await server(t);
  // a stray command would run in the temp root and leave this file
  const marker = loopback.path('MARKER');
  const home = loopback.path(`it's $(touch MARKER) ; \`touch MARKER\` & "x"`);
  const result = await loopback.session.exec(makeDirectoriesCommand(home, ['main', 'zone', 'logs']));
  assert.equal(result.code, 0, result.stderr.toString());
  for (const name of ['', 'main', 'zone', 'logs']) assert.ok((await fs.stat(`${home}/${name}`)).isDirectory(), name);
  assert.equal((await fs.stat(home)).mode & 0o777, 0o700);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'no injected command ran');
  // an existing home is never adopted
  const again = await loopback.session.exec(makeDirectoriesCommand(home, ['main']));
  assert.notEqual(again.code, 0);
});

test('startCoreCommand runs a detached core, prints its own pid, passes every argument literally and writes the output files', { skip }, async t => {
  const loopback = await server(t);
  const core = await buildFakeCore(loopback.path('core'));
  await fs.mkdir(loopback.path('home', 'logs'), { recursive: true });
  const marker = loopback.path('MARKER');
  const args = ['+set', 'sv_hostname', `a b 'c' "d" $(touch MARKER) ;touch MARKER`, '+set', 'x', '$HOME', '*'];
  const stdoutFile = loopback.path('home', 'logs', 'out.log'), stderrFile = loopback.path('home', 'logs', 'err.log');
  const result = await loopback.session.exec(startCoreCommand({ core, cwd: loopback.root, args, stdoutFile, stderrFile }));
  assert.equal(result.code, 0, result.stderr.toString());
  const pid = parsePid(result.stdout);
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  assert.ok(alive(pid), 'the printed pid is a live process');
  assert.equal(await fs.readlink(`/proc/${pid}/exe`), core, 'the pid is the core itself, not a wrapper');
  assert.deepEqual((await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').slice(0, -1), [core, ...args]);
  assert.ok(await until(async () => (await fs.readFile(stdoutFile, 'utf8')).includes('\n')), 'output reaches the stdout file');
  assert.deepEqual((await fs.readFile(stdoutFile, 'utf8')).split('\n').slice(0, -1), [core, ...args], 'every argument arrived unchanged');
  assert.ok(await until(async () => (await fs.readFile(stderrFile, 'utf8')).includes('fixture stderr')));
  assert.equal((await fs.stat(stdoutFile)).mode & 0o077, 0, 'output files are private');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  // own session: not a process group of the shell that started it
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  assert.equal(Number(fields[3]), pid, 'the core leads its own session');
});

test('startCoreCommand never reuses an output file and prints no pid when it cannot start', { skip }, async t => {
  const loopback = await server(t);
  const core = await buildFakeCore(loopback.path('core'));
  await fs.mkdir(loopback.path('home', 'logs'), { recursive: true });
  const stdoutFile = loopback.path('home', 'logs', 'out.log'), stderrFile = loopback.path('home', 'logs', 'err.log');
  await fs.writeFile(stdoutFile, 'earlier run');
  const result = await loopback.session.exec(startCoreCommand({ core, cwd: loopback.root, args: [], stdoutFile, stderrFile }));
  // the start runs in the background, so the exit status says nothing; no pid and a message do
  assert.equal(result.stdout.toString(), '');
  assert.equal(code(() => parsePid(result.stdout)), 'REMOTE_START_FAILED');
  assert.notEqual(result.stderr.toString(), '');
  assert.equal(await fs.readFile(stdoutFile, 'utf8'), 'earlier run');
  // a missing core: still no pid
  const missing = await loopback.session.exec(startCoreCommand({ core: loopback.path('core', 'nope'), cwd: loopback.root, args: [], stdoutFile: loopback.path('home', 'logs', 'o2.log'), stderrFile: loopback.path('home', 'logs', 'e2.log') }));
  assert.equal(code(() => parsePid(missing.stdout)), 'REMOTE_START_FAILED');
});

test('signalCommand stops the started core', { skip }, async t => {
  const loopback = await server(t);
  const core = await buildFakeCore(loopback.path('core'));
  await fs.mkdir(loopback.path('home', 'logs'), { recursive: true });
  const started = await loopback.session.exec(startCoreCommand({ core, cwd: loopback.root, args: [], stdoutFile: loopback.path('home', 'logs', 'o.log'), stderrFile: loopback.path('home', 'logs', 'e.log') }));
  const pid = parsePid(started.stdout);
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  const stopped = await loopback.session.exec(signalCommand(pid, 'TERM'));
  assert.equal(stopped.code, 0);
  assert.ok(await until(() => !alive(pid)), 'the core ended');
});

test('getinfoProbeCommand returns the answer of a listening server and nothing for a silent port', { skip }, async t => {
  const loopback = await server(t);
  const fake = await startFakeCod4xServer({ hostname: 'Probe Gate', mapname: 'mp_crash' });
  t.after(() => fake.close());
  const answer = await loopback.session.exec(getinfoProbeCommand(fake.port));
  assert.match(answer.stdout.toString('latin1'), /infoResponse[\s\S]*Probe Gate[\s\S]*mp_crash/);
  assert.deepEqual([...answer.stdout.subarray(0, 4)], [255, 255, 255, 255]);
  const silent = await startFakeCod4xServer({ silent: true });
  t.after(() => silent.close());
  const none = await loopback.session.exec(getinfoProbeCommand(silent.port), { timeoutMs: 8000 });
  assert.equal(none.stdout.length, 0);
});

test('diskFreeCommand reports free kibibytes for a path', { skip }, async t => {
  const loopback = await server(t);
  const result = await loopback.session.exec(diskFreeCommand(loopback.root));
  assert.equal(result.code, 0, result.stderr.toString());
  assert.ok(parseDiskFree(result.stdout) > 0);
});

test('parseStat reads exactly what statCommand prints and refuses anything else', () => {
  assert.deepEqual(parseStat(Buffer.from('81a4 1000 1001 42 2 2049 777\n')), { mode: 0o100644, uid: 1000, gid: 1001, size: 42, nlink: 2, dev: 2049, ino: 777 });
  for (const bad of ['', 'garbage', '81a4 1000 1001 42 2 2049\n', '81a4 x 1001 42 2 2049 7\n', 'zz 1 1 1 1 1 1\n', '81a4 1 1 1 1 1 1\nextra\n']) assert.equal(code(() => parseStat(Buffer.from(bad))), 'REMOTE_STAT_INVALID', JSON.stringify(bad));
  assert.equal(code(() => statCommand('relative')), 'REMOTE_PATH_INVALID');
  assert.equal(code(() => statCommand('/srv/../x')), 'REMOTE_PATH_INVALID');
  assert.match(statCommand('/srv/x'), /^LC_ALL=C stat -c /);
  assert.match(statCommand('/srv/x', { follow: true }), /^LC_ALL=C stat -L -c /);
});

test('statCommand reports link count, device, inode and the type, with or without following a symlink', { skip }, async t => {
  const loopback = await server(t);
  const file = loopback.path('file'), hard = loopback.path('hard'), link = loopback.path('link');
  await fs.writeFile(file, 'hello', { mode: 0o640 });
  const before = parseStat((await loopback.session.exec(statCommand(file))).stdout);
  assert.deepEqual([before.mode & 0o170000, before.mode & 0o777, before.size, before.nlink, before.uid], [0o100000, 0o640, 5, 1, process.getuid()]);
  await fs.link(file, hard); await fs.symlink(file, link);
  const after = parseStat((await loopback.session.exec(statCommand(file))).stdout);
  assert.equal(after.nlink, 2);
  assert.deepEqual([after.dev, after.ino], [before.dev, before.ino]);
  assert.equal(parseStat((await loopback.session.exec(statCommand(link))).stdout).mode & 0o170000, 0o120000, 'not following: a symlink');
  assert.equal(parseStat((await loopback.session.exec(statCommand(link, { follow: true }))).stdout).mode & 0o170000, 0o100000, 'following: the target');
  assert.equal(parseStat((await loopback.session.exec(statCommand(loopback.root))).stdout).mode & 0o170000, 0o040000);
  const missing = await loopback.session.exec(statCommand(loopback.path('nope')));
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr.toString(), /No such file or directory/, 'messages are in C locale');
});

test('recoverHomeCommand moves a half-installed home into a private .recovery folder and refuses odd arguments', { skip }, async t => {
  const loopback = await server(t);
  const home = loopback.path('inst-1');
  await fs.mkdir(`${home}/core`, { recursive: true }); await fs.writeFile(`${home}/core/partial`, 'x');
  const result = await loopback.session.exec(recoverHomeCommand(loopback.root, home, 'abcdef12-0000'));
  assert.equal(result.code, 0, result.stderr.toString());
  await assert.rejects(fs.stat(home), { code: 'ENOENT' });
  assert.equal(await fs.readFile(loopback.path('.recovery', 'inst-1-abcdef12-0000', 'core', 'partial'), 'utf8'), 'x');
  assert.equal((await fs.stat(loopback.path('.recovery'))).mode & 0o777, 0o700);
  // an existing target is never replaced
  await fs.mkdir(home);
  const again = await loopback.session.exec(recoverHomeCommand(loopback.root, home, 'abcdef12-0000'));
  assert.notEqual(again.code, 0);
  assert.ok((await fs.stat(home)).isDirectory(), 'the new directory is untouched');
});

test('recoverHomeCommand takes only a home directly below the root and a plain token', () => {
  assert.match(recoverHomeCommand('/srv/cod4x', '/srv/cod4x/inst-1', 'abcdef12-0000'), /^mkdir -p -m 0700 -- '\/srv\/cod4x\/\.recovery' && \[ ! -e /);
  for (const home of ['/srv/cod4x', '/srv/cod4x/a/b', '/srv/other/inst-1', '/srv/cod4x/Inst', '/srv/cod4x/../x']) assert.ok(['REMOTE_PATH_INVALID', 'REMOTE_ARGUMENT_INVALID'].includes(code(() => recoverHomeCommand('/srv/cod4x', home, 'abcdef12-0000'))), home);
  for (const token of ['', 'short', 'ABCDEFGH', 'abc def 12', 'a;b;c;d;e;f', "x'y'z'w'v'u", 'a'.repeat(65), 5, undefined]) assert.equal(code(() => recoverHomeCommand('/srv/cod4x', '/srv/cod4x/inst-1', token)), 'REMOTE_ARGUMENT_INVALID', String(token));
});
