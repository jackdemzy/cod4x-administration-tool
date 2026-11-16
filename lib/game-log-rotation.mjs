import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Audit 4.18.31 (S-7): the core appends to main/qconsole.log (+set logfile 2) and main/logs/games_mp.log
// (g_log) for ever; chat spam alone can fill the disk. Before each start a file above the limit becomes
// <name>.1 (the previous .1 is replaced), so at most about twice the limit stays per file.
export const GAME_LOG_LIMIT_BYTES = 64 * 1024 * 1024;
const GAME_LOGS = ['qconsole.log', path.join('logs', 'games_mp.log')];

// Codex review (PR #73): O_NOFOLLOW and rename guard only the last path component, so a linked
// main/logs would lead both outside the home. A log whose folder is not a real directory is left alone.
async function parentIsDirectory(mainDir, file) {
  // main itself included (Codex review: a linked main would lead outside the home too)
  for (let dir = path.dirname(file); dir.length >= mainDir.length; dir = path.dirname(dir)) {
    const stat = await fs.lstat(dir).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
    if (dir === path.dirname(dir)) break;
  }
  return true;
}

export async function rotateGameLogs(mainDir, { limit = GAME_LOG_LIMIT_BYTES } = {}) {
  const rotated = [];
  for (const name of GAME_LOGS) {
    const file = path.join(mainDir, name);
    const stat = await fs.lstat(file).catch(() => null);
    // only regular files of the home; a link is never followed or moved
    if (!stat?.isFile() || stat.size <= limit || !(await parentIsDirectory(mainDir, file))) continue;
    // a file still held open (Windows) stays as it is; a log is never a reason to refuse a start
    if (await fs.rename(file, `${file}.1`).then(() => true, () => false)) rotated.push(name);
  }
  return rotated;
}

// Issue #67 (A4-8): the cap while a server keeps running. A log above the limit is copied to <name>.1
// and emptied in place; the core opened it for appending, so it goes on writing at the new end (a
// rename would not help, the core would keep writing into the renamed file). The log is opened once
// without following a link (where the platform has O_NOFOLLOW) and copied and emptied through that
// handle, so a file swapped in meanwhile is never touched. A failure leaves the log as it was.
export const GAME_LOG_CAP_INTERVAL_MS = 5 * 60 * 1000;
const NOFOLLOW = fs.constants?.O_NOFOLLOW || 0;

export async function capGameLogs(mainDir, { limit = GAME_LOG_LIMIT_BYTES } = {}) {
  const capped = [];
  for (const name of GAME_LOGS) {
    const file = path.join(mainDir, name);
    const before = await fs.lstat(file).catch(() => null);
    if (!before?.isFile() || before.size <= limit || !(await parentIsDirectory(mainDir, file))) continue;
    const handle = await fs.open(file, fs.constants.O_RDWR | NOFOLLOW).catch(() => null);
    if (!handle) continue;
    const temporary = `${file}.cap-${randomUUID()}`;
    let created = false;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) continue;
      const copy = await fs.open(temporary, 'wx', 0o600);
      created = true;
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        for (let position = 0; ;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          await copy.write(buffer, 0, bytesRead);
          position += bytesRead;
        }
      } finally { await copy.close(); }
      await fs.rename(temporary, `${file}.1`);
      created = false;
      await handle.truncate(0);
      capped.push(name);
    } catch { /* a log is never a reason to fail */ }
    finally {
      await handle.close();
      if (created) await fs.unlink(temporary).catch(() => {});
    }
  }
  return capped;
}
