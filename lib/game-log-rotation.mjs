import fs from 'node:fs/promises';
import path from 'node:path';

// Audit 4.18.31 (S-7): the core appends to main/qconsole.log (+set logfile 2) and main/logs/games_mp.log
// (g_log) for ever; chat spam alone can fill the disk. Before each start a file above the limit becomes
// <name>.1 (the previous .1 is replaced), so at most about twice the limit stays per file.
export const GAME_LOG_LIMIT_BYTES = 64 * 1024 * 1024;
const GAME_LOGS = ['qconsole.log', path.join('logs', 'games_mp.log')];

export async function rotateGameLogs(mainDir, { limit = GAME_LOG_LIMIT_BYTES } = {}) {
  const rotated = [];
  for (const name of GAME_LOGS) {
    const file = path.join(mainDir, name);
    const stat = await fs.lstat(file).catch(() => null);
    // only regular files of the home; a link is never followed or moved
    if (!stat?.isFile() || stat.size <= limit) continue;
    // a file still held open (Windows) stays as it is; a log is never a reason to refuse a start
    if (await fs.rename(file, `${file}.1`).then(() => true, () => false)) rotated.push(name);
  }
  return rotated;
}
