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

const FAKE_CORE_SOURCE = `#include <stdio.h>
#include <unistd.h>
int main(int argc, char **argv) {
  for (int i = 0; i < argc; i++) printf("%s\\n", argv[i]);
  fflush(stdout);
  fprintf(stderr, "fixture stderr\\n");
  for (;;) usleep(100000);
  return 0;
}
`;

// A real native process that prints its arguments, one per line, and then waits.
export async function buildFakeCore(directory, name = 'cod4x18_dedrun') {
  await fs.mkdir(directory, { recursive: true });
  const source = path.join(directory, `${name}.c`);
  const executable = path.join(directory, name);
  await fs.writeFile(source, FAKE_CORE_SOURCE);
  await run('gcc', [source, '-o', executable]);
  await fs.rm(source);
  await fs.chmod(executable, 0o755);
  return executable;
}

export async function createLoopbackServer() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-loopback-')));
  const calls = [];
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
    close() {},
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
