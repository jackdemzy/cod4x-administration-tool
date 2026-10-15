import fs from 'node:fs/promises';
import path from 'node:path';

const LIMIT = 64 * 1024;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
// Read a bounded, fresh snapshot on API polling. Never mix file output with stdout.
// Only current vanilla instance homes are supported; no user-supplied log filename.
export async function readInstanceConsoleLog(homePath) {
  const result = { source: 'qconsole.log', status: 'waiting', text: '', truncated: false };
  if (typeof homePath !== 'string' || !path.isAbsolute(homePath)) return { ...result, status: 'blocked' };
  const home = path.resolve(homePath);
  const folder = path.join(home, 'main');
  const file = path.join(folder, 'qconsole.log');
  let handle;
  try {
    for (const target of [home, folder, file]) {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !samePath(await fs.realpath(target), target)) throw new Error('Console path alias blocked');
      if (target === file ? (!stat.isFile() || stat.nlink > 1) : !stat.isDirectory()) throw new Error('Invalid console file');
    }
    const before = await fs.lstat(file);
    handle = await fs.open(file, 'r');
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1 || before.dev !== opened.dev || before.ino !== opened.ino) throw new Error('Console file changed while opening');
    const start = Math.max(0, opened.size - LIMIT);
    const buffer = Buffer.alloc(Math.min(LIMIT, opened.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    // Recheck aliases after the read and do not expose a file redirected during it.
    for (const target of [home, folder, file]) {
      if ((await fs.lstat(target)).isSymbolicLink() || !samePath(await fs.realpath(target), target)) throw new Error('Console path changed');
    }
    const after = await fs.lstat(file);
    if (opened.dev !== after.dev || opened.ino !== after.ino) throw new Error('Console rotated during read');
    let retained = buffer.subarray(0, bytesRead);
    if (start > 0) {
      const firstNewline = retained.indexOf(10);
      retained = firstNewline < 0 ? Buffer.alloc(0) : retained.subarray(firstNewline + 1);
    }
    // Wait for complete lines to avoid split UTF-8 and partial secret labels.
    retained = retained.subarray(0, retained.lastIndexOf(10) + 1);
    let text = retained.toString('utf8').split(/(?<=\n)/).map(line =>
      /(?:password|passwd|rcon[_ -]?password|(?:master|auth|api|server)[_ -]?token|api[_ -]?key|secret|authorization)/i.test(line) ? '[sensitive log line hidden]\n' : line
    ).join('');
    // Redaction placeholders can be longer than input; enforce the bound again.
    let truncated = start > 0;
    if (Buffer.byteLength(text) > LIMIT) {
      const tail = Buffer.from(text).subarray(-LIMIT);
      text = tail.subarray(tail.indexOf(10) + 1).toString('utf8');
      truncated = true;
    }
    return { ...result, status: 'available', text, truncated };
  } catch (error) {
    return { ...result, status: error.code === 'ENOENT' ? 'waiting' : 'blocked' };
  } finally { if (handle) await handle.close(); }
}
