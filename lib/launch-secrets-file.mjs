import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Security audit 4.18.26 (A2-1): secrets for a local core start travel in a private file
// the core reads with +exec, never as arguments (every local user can read a process's
// command line on Linux). The file lives in <homepath>/main for one start: created
// exclusively with 0600, removed as soon as the core reports "execing <file>", after a
// timeout, on any failure, and before the next start if a crash left it behind.
export const LAUNCH_FILE_PATTERN = /^launch-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.cfg$/;

export async function sweepLaunchFiles(mainDir) {
  let names;
  try { names = await fs.readdir(mainDir); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  const stale = names.filter(name => LAUNCH_FILE_PATTERN.test(name));
  await Promise.all(stale.map(name => fs.rm(path.join(mainDir, name), { force: true })));
  return stale.length;
}

// content is wiped after writing. Returns the file name to pass to +exec.
export async function writeLaunchFile(mainDir, content) {
  const name = `launch-${crypto.randomUUID()}.cfg`;
  try {
    await fs.mkdir(mainDir, { recursive: true });
    const handle = await fs.open(path.join(mainDir, name), 'wx', 0o600);
    try { await handle.writeFile(content); } finally { await handle.close(); }
    return name;
  } catch (error) {
    await fs.rm(path.join(mainDir, name), { force: true }).catch(() => {});
    throw error;
  } finally {
    content.fill(0);
  }
}

export async function removeLaunchFile(mainDir, name) {
  if (!LAUNCH_FILE_PATTERN.test(String(name))) return;
  await fs.rm(path.join(mainDir, name), { force: true });
}

// readOutput returns the core's recent console output (redacted text is fine).
export async function waitExecuted(readOutput, name, { timeoutMs = 15_000, pollMs = 100 } = {}) {
  for (const deadline = Date.now() + timeoutMs; ;) {
    try { if (String(await readOutput()).includes(`execing ${name}`)) return true; } catch { /* not readable yet */ }
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
