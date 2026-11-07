import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fsError, sftpError } from './remote-linux-runtime.mjs';

// Block 18: file transfer over SFTP. Uploads create the target exclusively (an existing file is
// never overwritten), send in sequential chunks and remove the partial file when anything fails.
const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };

export function createRemoteFiles({ sftp, filesystem, chunkBytes = 256 * 1024 }) {
  const call = (method, ...args) => new Promise((resolve, reject) => {
    try { sftp[method](...args, (error, value) => (error ? reject(sftpError(error)) : resolve(value))); }
    catch (error) { reject(fsError('EINVAL', error.message)); }
  });
  const writeAt = (handle, buffer, length, position) => new Promise((resolve, reject) => {
    sftp.write(handle, buffer, 0, length, position, error => (error ? reject(sftpError(error)) : resolve()));
  });
  const uploadFailed = cause => Object.assign(new Error('REMOTE_UPLOAD_FAILED'), { code: 'REMOTE_UPLOAD_FAILED', cause: cause?.code });

  // Creates `file` (exclusive) and lets `fill(handle)` write it. The file is removed again if a
  // failure happens after we created it; a file that already existed is never touched.
  async function createExclusive(file, mode, fill) {
    let handle, created = false;
    try {
      handle = await call('open', file, 'wx', { mode });
      created = true;
      const result = await fill(handle);
      await call('close', handle); handle = undefined;
      await call('chmod', file, mode); // the exact mode, whatever the server's umask did
      return result;
    } catch (error) {
      if (created) {
        try { if (handle) await call('close', handle); } catch { /* best effort */ }
        try { await call('unlink', file); } catch { /* best effort */ }
      }
      throw uploadFailed(error);
    }
  }

  return {
    // -> { bytes, sha256 } of what was sent
    async uploadFile(localFile, remoteFile, { mode = 0o600 } = {}) {
      let local;
      try {
        local = await fs.open(localFile, 'r');
        if (!(await local.stat()).isFile()) fail('REMOTE_UPLOAD_FAILED');
        return await createExclusive(remoteFile, mode, async handle => {
          const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(chunkBytes);
          let position = 0;
          for (;;) {
            const { bytesRead } = await local.read(buffer, 0, chunkBytes, position);
            if (!bytesRead) break;
            hash.update(buffer.subarray(0, bytesRead));
            await writeAt(handle, buffer, bytesRead, position);
            position += bytesRead;
          }
          return { bytes: position, sha256: hash.digest('hex') };
        });
      } catch (error) {
        throw error.code === 'REMOTE_UPLOAD_FAILED' ? error : uploadFailed(error);
      } finally { await local?.close(); }
    },
    async writeFileExclusive(remoteFile, data, { mode = 0o600 } = {}) {
      if (!Buffer.isBuffer(data)) fail('REMOTE_ARGUMENT_INVALID');
      await createExclusive(remoteFile, mode, async handle => {
        for (let position = 0; position < data.length; position += chunkBytes) {
          const part = data.subarray(position, position + chunkBytes);
          await writeAt(handle, part, part.length, position);
        }
      });
    },
    // A file larger than maxBytes is refused, not cut.
    async readFile(file, { maxBytes = 256 * 1024 } = {}) {
      const handle = await filesystem.open(file, 'r');
      try {
        const parts = [];
        let total = 0;
        for (;;) {
          const buffer = Buffer.alloc(Math.min(chunkBytes, maxBytes + 1 - total));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          total += bytesRead;
          if (total > maxBytes) fail('REMOTE_FILE_TOO_LARGE');
          parts.push(buffer.subarray(0, bytesRead));
        }
        return Buffer.concat(parts);
      } finally { await handle.close(); }
    },
    async sha256(file) {
      const handle = await filesystem.open(file, 'r');
      try {
        const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(chunkBytes);
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, chunkBytes, null);
          if (!bytesRead) break;
          hash.update(buffer.subarray(0, bytesRead));
        }
        return hash.digest('hex');
      } finally { await handle.close(); }
    },
    rename: (from, to) => call('rename', from, to),
    unlink: file => call('unlink', file),
    chmod: (file, mode) => call('chmod', file, mode),
  };
}
