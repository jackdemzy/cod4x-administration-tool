import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Test double for a remote server: the "remote" paths are real paths below a temp
// directory and every command runs locally with `sh -c`, exactly as the SSH server
// would run it for an exec request. Linux only. The session has the shape of
// lib/ssh-transport.mjs RemoteSession.
const run = promisify(execFile);

const fakeCoreSource = ignoreTerm => `#include <stdio.h>
#include <signal.h>
#include <unistd.h>
int main(int argc, char **argv) {
  ${ignoreTerm ? 'signal(SIGTERM, SIG_IGN);' : ''}
  for (int i = 0; i < argc; i++) printf("%s\\n", argv[i]);
  fflush(stdout);
  fprintf(stderr, "fixture stderr\\n");
  for (;;) usleep(100000);
  return 0;
}
`;

// A real native process that prints its arguments, one per line, and then waits.
// With ignoreTerm it ignores SIGTERM, so only SIGKILL stops it.
export async function buildFakeCore(directory, name = 'cod4x18_dedrun', { ignoreTerm = false } = {}) {
  await fs.mkdir(directory, { recursive: true });
  const source = path.join(directory, `${name}.c`);
  const executable = path.join(directory, name);
  await fs.writeFile(source, fakeCoreSource(ignoreTerm));
  await run('gcc', [source, '-o', executable]);
  await fs.rm(source);
  await fs.chmod(executable, 0o755);
  return executable;
}

// An emulation of the ssh2 SFTP client (SFTPWrapper) over node:fs, with the quirks of the real one that
// matter here: handles are Buffers, read() refuses a null position, readdir() includes "." and "..",
// errors carry a numeric status code (2 no such file, 3 permission denied, 4 failure) and Stats has
// no nlink, dev or ino.
export function createSftpEmulation() {
  const handles = new Map();
  let nextHandle = 1;
  const failure = error => {
    const code = error.code === 'ENOENT' ? 2 : (error.code === 'EACCES' || error.code === 'EPERM') ? 3 : 4;
    return Object.assign(new Error(code === 2 ? 'No such file' : code === 3 ? 'Permission denied' : 'Failure'), { code });
  };
  const call = (promise, cb, project = () => []) => { promise.then(value => cb(undefined, ...project(value)), error => cb(failure(error))); };
  const stats = value => ({
    mode: value.mode, uid: value.uid, gid: value.gid, size: value.size, atime: Math.floor(value.atimeMs / 1000), mtime: Math.floor(value.mtimeMs / 1000),
    isFile: () => value.isFile(), isDirectory: () => value.isDirectory(), isSymbolicLink: () => value.isSymbolicLink(),
  });
  const handleOf = handle => {
    const entry = Buffer.isBuffer(handle) ? handles.get(handle.readUInt32BE(0)) : undefined;
    if (!entry) throw new Error('unknown handle');
    return entry;
  };
  return {
    open(file, flags, attrs, cb) {
      if (typeof attrs === 'function') { cb = attrs; attrs = undefined; }
      call(fs.open(file, flags, attrs?.mode), cb, fileHandle => {
        const id = nextHandle++, handle = Buffer.alloc(4); handle.writeUInt32BE(id);
        handles.set(id, fileHandle);
        return [handle];
      });
    },
    close(handle, cb) {
      const id = handle.readUInt32BE(0), fileHandle = handles.get(id);
      handles.delete(id);
      call(fileHandle.close(), cb);
    },
    read(handle, buffer, offset, length, position, cb) {
      if (position === null) throw new Error('null position currently unsupported');
      call(handleOf(handle).read(buffer, offset, length, position), cb, ({ bytesRead }) => [bytesRead, buffer, position]);
    },
    write(handle, buffer, offset, length, position, cb) {
      call(handleOf(handle).write(buffer, offset, length, position), cb);
    },
    fstat(handle, cb) { call(handleOf(handle).stat(), cb, value => [stats(value)]); },
    lstat(file, cb) { call(fs.lstat(file), cb, value => [stats(value)]); },
    stat(file, cb) { call(fs.stat(file), cb, value => [stats(value)]); },
    // like a real server: "." and ".." are listed, and every entry carries lstat-style attributes
    readdir(where, opts, cb) {
      if (typeof opts === 'function') cb = opts;
      const list = async () => {
        const names = await fs.readdir(where);
        const entries = [];
        // like a real server, an entry that disappears while the listing is built (a process leaving /proc) is skipped
        for (const filename of ['.', '..', ...names]) {
          try { entries.push({ filename, longname: filename, attrs: stats(await fs.lstat(`${where}/${filename}`)) }); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return entries;
      };
      call(list(), cb, entries => [entries]);
    },
    readlink(file, cb) { call(fs.readlink(file), cb, target => [target]); },
    realpath(file, cb) { call(fs.realpath(file), cb, resolved => [resolved]); },
    rename(from, to, cb) { call(fs.rename(from, to), cb); },
    unlink(file, cb) { call(fs.unlink(file), cb); },
    rmdir(file, cb) { call(fs.rmdir(file), cb); },
    mkdir(file, attrs, cb) {
      if (typeof attrs === 'function') { cb = attrs; attrs = undefined; }
      call(fs.mkdir(file, attrs?.mode), cb);
    },
    chmod(file, mode, cb) { call(fs.chmod(file, mode), cb); },
    async closeAll() { for (const fileHandle of handles.values()) await fileHandle.close().catch(() => {}); handles.clear(); },
  };
}

export async function createLoopbackServer() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-loopback-')));
  const calls = [];
  let emulation = null;
  const session = {
    hostKeySha256: 'loopback',
    calls,
    exec(command, { timeoutMs = 30_000, maxBytes = 256 * 1024 } = {}) {
      if (typeof command !== 'string' || !command || command.includes('\u0000')) throw Object.assign(new Error('REMOTE_ARGUMENT_INVALID'), { code: 'REMOTE_ARGUMENT_INVALID' });
      calls.push(command);
      return new Promise((resolve, reject) => {
        const child = spawn('sh', ['-c', command], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: root, LANG: 'C' } });
        const stdout = [], stderr = [];
        let kept = 0, truncated = false, finished = false;
        const finish = (settle, value) => { if (finished) return; finished = true; clearTimeout(timer); settle(value); };
        const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, Object.assign(new Error('REMOTE_TIMEOUT'), { code: 'REMOTE_TIMEOUT' })); }, timeoutMs);
        const collect = target => chunk => {
          const room = maxBytes - kept;
          if (room <= 0) return;
          const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
          kept += part.length; target.push(Buffer.from(part));
          if (part.length < chunk.length) truncated = true;
        };
        child.stdout.on('data', collect(stdout));
        child.stderr.on('data', collect(stderr));
        child.on('error', () => finish(reject, Object.assign(new Error('REMOTE_CONNECT_FAILED'), { code: 'REMOTE_CONNECT_FAILED' })));
        // like an SSH exec channel: done when the shell has exited and nobody holds the output pipes
        child.on('close', (code, signal) => finish(resolve, { code: typeof code === 'number' ? code : -1, signal: signal || null, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), truncated }));
      });
    },
    sftp: async () => { emulation ??= createSftpEmulation(); return emulation; },
    close() { emulation?.closeAll(); },
  };
  // Safety net: stop every process whose executable lives below the temp root.
  async function killStrays() {
    for (const name of await fs.readdir('/proc').catch(() => [])) {
      if (!/^\d+$/.test(name)) continue;
      try { if ((await fs.readlink(`/proc/${name}/exe`)).startsWith(root)) process.kill(Number(name), 'SIGKILL'); } catch { /* gone or not ours */ }
    }
  }
  return {
    root, session,
    path: (...parts) => path.join(root, ...parts),
    async cleanup() { await killStrays(); await fs.rm(root, { recursive: true, force: true }); },
  };
}

export const loopbackAvailable = async () => {
  if (process.platform !== 'linux' || process.getuid() === 0) return false;
  try { await run('gcc', ['--version']); await run('setsid', ['--version']); return true; } catch { return false; }
};
