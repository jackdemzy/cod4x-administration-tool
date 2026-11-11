import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteFilesystem } from '../lib/remote-linux-runtime.mjs';
import { createRemoteFiles } from '../lib/remote-files.mjs';

// Security audit 4.18.26, area 4 (remote Linux), attacker A6 (a compromised SSH host).
// A4-1: a directory listing from the host had no limit; a host that never ends it filled
// CONTROL's memory. A4-2: SFTP requests had no timeout; a host that never answers held the
// remote overview for every host and the instance's busy flag forever.
const session = () => ({ closed: 0, close() { this.closed++; }, exec: async () => ({ code: 0, stdout: '', stderr: '' }) });

test('A4-1: a listing that never ends is cut off with a fixed code', async () => {
  let handed = 0;
  const sftp = {
    opendir: (directory, cb) => cb(undefined, Buffer.from('dir')),
    readdir(where, opts, cb) {
      if (typeof opts === 'function') cb = opts;
      if (!Buffer.isBuffer(where)) { handed = Infinity; return cb(new Error('a string path makes ssh2 collect without limit')); }
      handed += 1000;
      cb(undefined, Array.from({ length: 1000 }, (_, i) => ({ filename: `p${handed + i}`, longname: '', attrs: { mode: 0o040755, uid: 0, gid: 0, size: 0 } })));
    },
    close: (handle, cb) => cb(),
  };
  const filesystem = createRemoteFilesystem({ session: session(), sftp, uid: 1000, gid: 1000 });
  await assert.rejects(filesystem.readdir('/proc/1/task'), { code: 'REMOTE_LISTING_TOO_LARGE' });
  await assert.rejects(filesystem.readdirAttrs('/srv/base'), { code: 'REMOTE_LISTING_TOO_LARGE' });
  assert.ok(handed < 200_000, `stopped early (read ${handed} entries)`);
});

test('A4-1: a normal listing still arrives complete, without "." and ".."', async () => {
  const pages = [[{ filename: '.' }, { filename: '..' }, { filename: 'a' }], [{ filename: 'b' }]];
  const sftp = {
    opendir: (directory, cb) => cb(undefined, Buffer.from('dir')),
    readdir(where, cb) { const page = pages.shift(); page ? cb(undefined, page.map(entry => ({ ...entry, attrs: { mode: 0o100644, uid: 1, gid: 1, size: 1 } }))) : cb(Object.assign(new Error('eof'), { code: 1 })); },
    close: (handle, cb) => cb(),
  };
  assert.deepEqual(await createRemoteFilesystem({ session: session(), sftp, uid: 1, gid: 1 }).readdir('/x'), ['a', 'b']);
});

test('A4-2: an SFTP request the host never answers fails with REMOTE_TIMEOUT and closes the session', async () => {
  const silent = session();
  const sftp = { open() {}, opendir() {}, readlink() {}, realpath() {} };
  const filesystem = createRemoteFilesystem({ session: silent, sftp, uid: 1000, gid: 1000, timeoutMs: 50 });
  await assert.rejects(filesystem.open('/proc/1/stat'), { code: 'REMOTE_TIMEOUT' });
  await assert.rejects(filesystem.readdir('/proc'), { code: 'REMOTE_TIMEOUT' });
  await assert.rejects(filesystem.realpath('/srv'), { code: 'REMOTE_TIMEOUT' });
  assert.ok(silent.closed >= 1, 'the stuck session is closed');
});

test('A4-2: a read the host never answers fails with REMOTE_TIMEOUT', async () => {
  const sftp = { open: (file, flags, cb) => cb(undefined, Buffer.from('h')), read() {}, close: (handle, cb) => cb() };
  const handle = await createRemoteFilesystem({ session: session(), sftp, uid: 1, gid: 1, timeoutMs: 50 }).open('/proc/1/stat');
  await assert.rejects(handle.read(Buffer.alloc(16), 0, 16, null), { code: 'REMOTE_TIMEOUT' });
});

test('A4-2: an upload the host never answers fails instead of hanging', async () => {
  const sftp = { open() {}, close: (handle, cb) => cb(), unlink: (file, cb) => cb() };
  const files = createRemoteFiles({ sftp, filesystem: {}, timeoutMs: 50 });
  await assert.rejects(files.writeFileExclusive('/srv/x', Buffer.from('x')), error => ['REMOTE_TIMEOUT', 'REMOTE_UPLOAD_FAILED'].includes(error.code));
});
