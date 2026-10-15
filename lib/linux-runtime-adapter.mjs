import path from 'node:path';
import fs from 'node:fs/promises';

const blocked = message => Object.assign(new Error(message), { code: 'INSTANCE_PROCESS_IDENTITY_BLOCKED' });

export function assertLinuxInstanceOwnership(info, { homePath, port, createdAt, uid, gid }) {
  if (!Array.isArray(info.argv) || !info.createdAt || info.uid !== uid || info.gid !== gid) throw blocked('Linux process user/group or birth identity mismatch.');
  const values = new Map();
  for (let index = 1; index < info.argv.length; index++) {
    if (info.argv[index].toLowerCase() !== '+set') continue;
    const key = String(info.argv[index + 1] || '').toLowerCase();
    if (['fs_homepath', 'net_port'].includes(key)) {
      if (values.has(key) || !info.argv[index + 2]) throw blocked('Ambiguous Linux instance arguments.');
      values.set(key, info.argv[index + 2]);
    }
    index += 2;
  }
  if (!values.get('fs_homepath') || path.posix.resolve(values.get('fs_homepath')) !== path.posix.resolve(homePath) || values.get('net_port') !== String(port) || (createdAt && info.createdAt !== createdAt)) throw blocked('Linux instance home, port or birth mismatch.');
}

export function createLinuxRuntimeAdapter({ filesystem = fs, hostProcess = process } = {}) {
  const assertHost = () => {
    if (hostProcess.platform !== 'linux' || typeof hostProcess.getuid !== 'function') throw Object.assign(new Error('Linux runtime requires a Linux host.'), { code: 'RUNTIME_PLATFORM_NOT_SUPPORTED' });
    if (hostProcess.getuid() === 0 || hostProcess.geteuid() === 0) throw Object.assign(new Error('Dedicated runtime must not run as root.'), { code: 'RUNTIME_ROOT_BLOCKED' });
  };
  async function readBounded(file, maximum) {
    const handle = await filesystem.open(file, 'r');
    try {
      const buffer = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maximum) throw new Error('Linux process metadata exceeds limit.');
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  }
  const birth = text => {
    const end = text.lastIndexOf(')');
    const fields = text.slice(end + 2).trim().split(/\s+/);
    if (end < 0 || !/^\d+$/.test(fields[19] || '')) throw new Error('Malformed Linux process birth metadata.');
    return { ticks: fields[19], zombie: fields[0] === 'Z' };
  };
  async function inspectProcess(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { alive: null, error: 'Invalid Linux PID.' };
    const root = `/proc/${pid}`;
    const zombieStatus = async () => {
      // A dead leader can still have live threads holding sockets. Wait for all
      // threads before classifying the group as gone; never signal by this result.
      const tasks = await filesystem.readdir(`${root}/task`);
      if (!tasks.length) throw new Error('Linux thread inspection returned no result.');
      return tasks.length === 1 ? { alive: false } : { alive: true, exiting: true };
    };
    try {
      const first = birth((await readBounded(`${root}/stat`, 8192)).toString('utf8'));
      if (first.zombie) return await zombieStatus();
      const bootId = (await readBounded('/proc/sys/kernel/random/boot_id', 128)).toString('utf8').trim();
      if (!/^[a-f0-9-]{36}$/.test(bootId)) throw new Error('Invalid Linux boot identity.');
      const executablePath = await filesystem.readlink(`${root}/exe`);
      const argv = (await readBounded(`${root}/cmdline`, 65536)).toString('utf8').split('\0');
      if (argv.at(-1) === '') argv.pop();
      const status = (await readBounded(`${root}/status`, 65536)).toString('utf8');
      const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
      const gids = /^Gid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
      if (!uids || !gids || !uids.slice(1).every(value => value === uids[1]) || !gids.slice(1).every(value => value === gids[1])) throw new Error('Ambiguous Linux credentials.');
      const last = birth((await readBounded(`${root}/stat`, 8192)).toString('utf8'));
      if (last.ticks !== first.ticks) throw new Error('Linux PID changed during inspection.');
      if (last.zombie) return await zombieStatus();
      return { alive: true, executable: path.posix.basename(executablePath), executablePath, argv, uid: Number(uids[1]), gid: Number(gids[1]), createdAt: `${bootId}:${first.ticks}` };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') {
        try {
          await filesystem.stat(root);
          const current = birth((await readBounded(`${root}/stat`, 8192)).toString('utf8'));
          if (current.zombie) return await zombieStatus();
        } catch (missing) {
          if (missing.code === 'ENOENT' || missing.code === 'ESRCH') return { alive: false };
        }
      }
      return { alive: null, error: error.message, errorCode: error.code || null };
    }
  }
  async function validateExecutable(executablePath) {
    assertHost();
    const stat = await filesystem.lstat(executablePath);
    if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111) || stat.mode & 0o6000) throw Object.assign(new Error('Linux Core must be a regular executable without setuid/setgid.'), { code: 'RUNTIME_EXECUTABLE_BLOCKED' });
    await filesystem.access(executablePath, 1);
  }
  async function outputPaths(homePath, runId) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId)) throw new Error('Invalid Linux output run identity.');
    const directory = path.join(homePath, 'logs');
    for (const file of [homePath, directory]) {
      const stat = await filesystem.lstat(file);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await filesystem.realpath(file) !== path.resolve(file) || stat.uid !== hostProcess.getuid() || (stat.mode & 0o022)) throw new Error('Linux output directory is not exclusively owned.');
    }
    return ['stdout', 'stderr'].map(stream => path.join(directory, `runtime-${runId}-${stream}.log`));
  }
  async function prepareOutput(homePath, runId) {
    assertHost();
    await filesystem.mkdir(path.join(homePath, 'logs'), { recursive: true, mode: 0o700 });
    const paths = await outputPaths(homePath, runId);
    const handles = [];
    try {
      for (const file of paths) handles.push(await filesystem.open(file, 'ax', 0o600));
      return handles;
    } catch (error) { await Promise.all(handles.map(handle => handle.close())); throw error; }
  }
  async function readOutput(homePath, runId, limit) {
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1024 * 1024) throw new Error('Invalid Linux output limit.');
    const paths = await outputPaths(homePath, runId);
    const output = {};
    for (const [index, stream] of ['stdout', 'stderr'].entries()) {
      let handle;
      try {
        const before = await filesystem.lstat(paths[index]);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== hostProcess.getuid()) throw new Error('Linux output file is not exclusively owned.');
        handle = await filesystem.open(paths[index], 'r');
        const opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Linux output file changed during inspection.');
        const start = Math.max(0, opened.size - limit);
        const buffer = Buffer.alloc(Math.min(opened.size, limit));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        const after = await filesystem.lstat(paths[index]);
        if (after.dev !== before.dev || after.ino !== before.ino) throw new Error('Linux output file was replaced.');
        const encoded = Buffer.from(buffer.subarray(0, bytesRead).toString('utf8'), 'utf8');
        const tail = encoded.subarray(-limit);
        let offset = 0;
        while (offset < tail.length && (tail[offset] & 0xc0) === 0x80) offset++;
        output[stream] = tail.subarray(offset).toString('utf8');
        output[`${stream}Truncated`] = opened.size > limit;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        output[stream] = ''; output[`${stream}Truncated`] = false;
      } finally { await handle?.close(); }
    }
    return output;
  }
  async function signal(pid, expected, signalName) {
    assertHost();
    if (!['SIGTERM', 'SIGKILL'].includes(signalName)) throw new Error('Unsupported runtime signal.');
    if (!expected.createdAt) throw blocked('Saved Linux process birth identity is required before signaling.');
    const info = await inspectProcess(pid);
    if (info.alive === false) return false;
    if (info.alive !== true || info.executable !== 'cod4x18_dedrun' || info.executablePath !== expected.executablePath) throw blocked('Linux executable identity mismatch.');
    assertLinuxInstanceOwnership(info, { ...expected, uid: hostProcess.getuid(), gid: hostProcess.getgid() });
    hostProcess.kill(pid, signalName);
    return true;
  }
  return { assertHost, inspectProcess, validateExecutable, prepareOutput, readOutput, signal };
}
