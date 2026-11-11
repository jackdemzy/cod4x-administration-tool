import path from 'node:path';
import { createLinuxRuntimeAdapter } from './linux-runtime-adapter.mjs';
import { signalCommand, statCommand, parseStat } from './remote-commands.mjs';
import { assertRemotePosixPath } from './remote-safety.mjs';

// Block 18: the Linux runtime adapter, pointed at a server over SSH. It gets a read-only,
// node:fs-shaped file system (SFTP for reading, one fixed `stat` command for the metadata
// SFTP does not carry) and a host process whose kill is a fixed remote command. The PID
// identity, ownership, output and signal checks are the ones of the local Linux runtime.
const S_IFMT = 0o170000;
const TYPES = { file: 0o100000, directory: 0o040000, symlink: 0o120000 };

export function fsError(code, message) {
  return Object.assign(new Error(`${code}: ${message || code}`), { code });
}

// ssh2 SFTP status codes: 2 no such file, 3 permission denied, everything else a failure.
export function sftpError(error) {
  const code = error?.code === 2 ? 'ENOENT' : error?.code === 3 ? 'EACCES' : 'EIO';
  return Object.assign(fsError(code, error?.message), { sftpStatus: error?.code });
}

// Security audit 4.18.26 (A4-2): a host that never answers an SFTP request must not hold a
// caller forever. On timeout the request fails with REMOTE_TIMEOUT and onTimeout runs (the
// session is closed, so nothing else waits on it either).
export const REMOTE_SFTP_TIMEOUT_MS = 15_000;
export function sftpRequest(sftp, method, args, { timeoutMs = REMOTE_SFTP_TIMEOUT_MS, onTimeout } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* already closed */ }
      settle(reject, fsError('REMOTE_TIMEOUT', `${method} timed out`));
    }, timeoutMs);
    try { sftp[method](...args, (error, value) => (error ? settle(reject, sftpError(error)) : settle(resolve, value))); }
    catch (error) { settle(reject, fsError('EINVAL', error.message)); }
  });
}

// Security audit 4.18.26 (A4-1): a listing is read page by page and cut off at a fixed
// number of entries; ssh2's readdir(<path>) would collect whatever the host sends.
export const REMOTE_LISTING_MAX_ENTRIES = 65_536;
export async function sftpList(request, directory, maxEntries = REMOTE_LISTING_MAX_ENTRIES) {
  const handle = await request('opendir', directory);
  const entries = [];
  // Raw entries and pages count before filtering, so a host answering with empty pages or
  // only "." and ".." cannot keep the loop going (PR #46 review).
  let raw = 0, pages = 0;
  try {
    for (;;) {
      let page;
      try { page = await request('readdir', handle); } catch (error) { if (error.sftpStatus === 1) break; throw error; }
      if (!Array.isArray(page)) break;
      pages += 1; raw += page.length;
      for (const entry of page) if (entry.filename !== '.' && entry.filename !== '..') entries.push(entry);
      if (raw > maxEntries + 2 || pages > maxEntries + 2) throw fsError('REMOTE_LISTING_TOO_LARGE', `more than ${maxEntries} entries`);
    }
  } finally {
    await request('close', handle).catch(() => {});
  }
  return entries;
}

function execStatError(stderr) {
  const text = Buffer.from(stderr).toString('utf8');
  if (/No such file or directory/.test(text)) return fsError('ENOENT', 'no such file or directory');
  if (/Permission denied/.test(text)) return fsError('EACCES', 'permission denied');
  if (/Not a directory/.test(text)) return fsError('ENOTDIR', 'not a directory');
  return fsError('EIO', 'stat failed');
}

function statsFrom(parsed) {
  const type = parsed.mode & S_IFMT;
  return { ...parsed, isFile: () => type === TYPES.file, isDirectory: () => type === TYPES.directory, isSymbolicLink: () => type === TYPES.symlink };
}

export function createRemoteFilesystem({ session, sftp, uid, gid, timeoutMs = REMOTE_SFTP_TIMEOUT_MS }) {
  const onTimeout = () => session?.close?.();
  const sftpCall = (method, ...args) => sftpRequest(sftp, method, args, { timeoutMs, onTimeout });
  async function fileStat(file, follow) {
    const result = await session.exec(statCommand(file, { follow }), { timeoutMs: 10_000 });
    if (result.code !== 0) throw execStatError(result.stderr);
    return statsFrom(parseStat(result.stdout));
  }
  return {
    lstat: file => fileStat(file, false),
    stat: file => fileStat(file, true),
    async readdir(directory) {
      return (await sftpList(sftpCall, directory)).map(entry => entry.filename);
    },
    // Names with the attributes the server lists along with them (lstat-style: a symlink is a symlink),
    // so a scan needs no command per file.
    async readdirAttrs(directory) {
      return (await sftpList(sftpCall, directory)).map(entry => ({
        name: entry.filename,
        ...statsFrom({ mode: entry.attrs.mode, uid: entry.attrs.uid, gid: entry.attrs.gid, size: entry.attrs.size }),
      }));
    },
    readlink: file => sftpCall('readlink', file),
    realpath: file => sftpCall('realpath', file),
    // access(2) approximated from mode, owner and primary group (supplementary groups are not known).
    async access(file, mode = 0) {
      const info = await fileStat(file, true);
      if (!mode) return;
      const bits = (info.uid === uid ? info.mode >> 6 : info.gid === gid ? info.mode >> 3 : info.mode) & 7;
      if ((bits & mode) !== mode) throw fsError('EACCES', 'permission denied');
    },
    async open(file, flags = 'r') {
      if (flags !== 'r') throw fsError('EINVAL', 'the remote file system is read-only here');
      const handle = await sftpCall('open', file, 'r');
      let cursor = 0, closed = false;
      return {
        // ssh2 refuses a null position, so the position after the last read is kept here.
        async read(buffer, offset, length, position) {
          const sequential = position === null || position === undefined;
          const bytesRead = await sftpCall('read', handle, buffer, offset, length, sequential ? cursor : position);
          if (sequential) cursor += bytesRead;
          return { bytesRead, buffer };
        },
        stat: () => fileStat(file, true),
        async close() { if (!closed) { closed = true; await sftpCall('close', handle); } },
      };
    },
  };
}

// -> the Linux runtime adapter plus `filesystem` and prepareRemoteOutput(home, runId).
// uid and gid are the ones of the login (connect() checked that uid is not 0).
export async function createRemoteLinuxAdapter(session, { uid, gid }) {
  const sftp = await session.sftp();
  const filesystem = createRemoteFilesystem({ session, sftp, uid, gid });
  const hostProcess = {
    platform: 'linux',
    getuid: () => uid,
    geteuid: () => uid,
    getgid: () => gid,
    // The adapter has checked the process identity just before. A process that vanished since
    // makes `kill` exit non-zero; that is not an error here.
    async kill(pid, signalName) { await session.exec(signalCommand(pid, signalName === 'SIGKILL' ? 'KILL' : 'TERM'), { timeoutMs: 10_000 }); },
  };
  const adapter = createLinuxRuntimeAdapter({ filesystem, hostProcess, pathApi: path.posix });
  return {
    ...adapter,
    filesystem,
    sftp,
    // The core's output files are created by the start command, not by this program.
    prepareOutput: async () => { throw fsError('REMOTE_UNSUPPORTED', 'use prepareRemoteOutput'); },
    async prepareRemoteOutput(home, runId) {
      assertRemotePosixPath(home);
      adapter.assertHost();
      const [stdoutFile, stderrFile] = await adapter.outputPaths(home, runId);
      return { stdoutFile, stderrFile };
    },
  };
}
