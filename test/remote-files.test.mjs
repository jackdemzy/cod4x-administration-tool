import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRemoteFiles } from '../lib/remote-files.mjs';
import { createRemoteFilesystem } from '../lib/remote-linux-runtime.mjs';
import { createLoopbackServer } from './support/loopback-transport.mjs';

const skip = process.platform === 'linux' ? false : 'needs Linux';
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code, code);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { chunkBytes = 64 * 1024 } = {}) {
  const loopback = await createLoopbackServer();
  const local = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-remote-files-local-'));
  t.after(async () => { await loopback.cleanup(); await fs.rm(local, { recursive: true, force: true }); });
  const sftp = await loopback.session.sftp();
  const filesystem = createRemoteFilesystem({ session: loopback.session, sftp, uid: process.getuid(), gid: process.getgid() });
  return { loopback, local, sftp, files: createRemoteFiles({ sftp, filesystem, chunkBytes }) };
}

test('uploadFile copies the bytes exactly, in chunks, sets the exact mode and reports size and hash', { skip }, async t => {
  const { files, loopback, local } = await fixture(t);
  const bytes = crypto.randomBytes(1_300_000);
  const source = path.join(local, 'core'); await fs.writeFile(source, bytes);
  const target = loopback.path('uploaded');
  const result = await files.uploadFile(source, target, { mode: 0o755 });
  assert.deepEqual(result, { bytes: bytes.length, sha256: sha(bytes) });
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o755);
  assert.equal(await files.sha256(target), sha(bytes));
});

test('uploadFile never overwrites: an existing target is refused and left as it was', { skip }, async t => {
  const { files, loopback, local } = await fixture(t);
  const source = path.join(local, 'core'); await fs.writeFile(source, 'new');
  const target = loopback.path('existing'); await fs.writeFile(target, 'old');
  await rejects(files.uploadFile(source, target), 'REMOTE_UPLOAD_FAILED');
  assert.equal(await fs.readFile(target, 'utf8'), 'old');
});

test('a write failure half way removes the partial file', { skip }, async t => {
  const { files, loopback, local, sftp } = await fixture(t, { chunkBytes: 4096 });
  const source = path.join(local, 'core'); await fs.writeFile(source, crypto.randomBytes(50_000));
  const write = sftp.write.bind(sftp);
  let sent = 0;
  sftp.write = (handle, buffer, offset, length, position, cb) => {
    sent += length;
    if (sent > 10_000) return cb(Object.assign(new Error('Failure'), { code: 4 }));
    return write(handle, buffer, offset, length, position, cb);
  };
  const target = loopback.path('partial');
  await rejects(files.uploadFile(source, target), 'REMOTE_UPLOAD_FAILED');
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('a missing or unreadable local file is an upload failure and creates nothing remote', { skip }, async t => {
  const { files, loopback, local } = await fixture(t);
  await rejects(files.uploadFile(path.join(local, 'nope'), loopback.path('t')), 'REMOTE_UPLOAD_FAILED');
  await rejects(files.uploadFile(local, loopback.path('t2')), 'REMOTE_UPLOAD_FAILED');
  await assert.rejects(fs.stat(loopback.path('t')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(loopback.path('t2')), { code: 'ENOENT' });
});

test('sha256 of a remote file and of an empty file', { skip }, async t => {
  const { files, loopback } = await fixture(t);
  await fs.writeFile(loopback.path('empty'), '');
  assert.equal(await files.sha256(loopback.path('empty')), sha(Buffer.alloc(0)));
  await rejects(files.sha256(loopback.path('nope')), 'ENOENT');
});

test('readFile is bounded and returns the exact bytes', { skip }, async t => {
  const { files, loopback } = await fixture(t);
  const bytes = crypto.randomBytes(5000);
  await fs.writeFile(loopback.path('small'), bytes); await fs.writeFile(loopback.path('big'), Buffer.alloc(300_000, 1));
  assert.deepEqual(await files.readFile(loopback.path('small')), bytes);
  assert.deepEqual(await files.readFile(loopback.path('small'), { maxBytes: 5000 }), bytes);
  await rejects(files.readFile(loopback.path('small'), { maxBytes: 4999 }), 'REMOTE_FILE_TOO_LARGE');
  await rejects(files.readFile(loopback.path('big')), 'REMOTE_FILE_TOO_LARGE');
  await rejects(files.readFile(loopback.path('nope')), 'ENOENT');
});

test('writeFileExclusive creates a private file, refuses an existing one and cleans up on failure', { skip }, async t => {
  const { files, loopback, sftp } = await fixture(t);
  const target = loopback.path('cfg');
  await files.writeFileExclusive(target, Buffer.from('set x "1"\n'), { mode: 0o600 });
  assert.equal(await fs.readFile(target, 'utf8'), 'set x "1"\n');
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  await rejects(files.writeFileExclusive(target, Buffer.from('other')), 'REMOTE_UPLOAD_FAILED');
  assert.equal(await fs.readFile(target, 'utf8'), 'set x "1"\n');
  sftp.write = (handle, buffer, offset, length, position, cb) => cb(Object.assign(new Error('Failure'), { code: 4 }));
  await rejects(files.writeFileExclusive(loopback.path('failing'), Buffer.from('x')), 'REMOTE_UPLOAD_FAILED');
  await assert.rejects(fs.stat(loopback.path('failing')), { code: 'ENOENT' });
});

test('rename, unlink and chmod work and report a missing file as ENOENT', { skip }, async t => {
  const { files, loopback } = await fixture(t);
  await fs.writeFile(loopback.path('a'), 'x', { mode: 0o600 });
  await files.rename(loopback.path('a'), loopback.path('b'));
  await files.chmod(loopback.path('b'), 0o644);
  assert.equal((await fs.stat(loopback.path('b'))).mode & 0o777, 0o644);
  await files.unlink(loopback.path('b'));
  await assert.rejects(fs.stat(loopback.path('b')), { code: 'ENOENT' });
  await rejects(files.rename(loopback.path('a'), loopback.path('c')), 'ENOENT');
  await rejects(files.unlink(loopback.path('a')), 'ENOENT');
  await rejects(files.chmod(loopback.path('a'), 0o600), 'ENOENT');
});
