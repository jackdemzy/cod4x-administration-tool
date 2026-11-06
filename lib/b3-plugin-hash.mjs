import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizedHash } from './b3-dependencies.mjs';

// Block 16b: content hash of one B3 plugin module (a single .py file or a package
// directory). Static: reads bytes only, never imports or executes B3 code.
export const B3_MODULE_MAX_FILE_BYTES = 4 * 1024 * 1024;

const INVALID = Object.freeze({ ok: false, code: 'INVALID' });
const MISSING = Object.freeze({ ok: false, code: 'MISSING' });
// B3 writes these on import; they must not change a module's identity.
const skipped = name => /\.py[co]$/.test(name) || name === '__pycache__';

async function readRegular(file, stats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > B3_MODULE_MAX_FILE_BYTES) return null;
  return normalizedHash(await fs.readFile(file));
}

// Returns [{ relative, sha256 }] or null when anything under the package is unusable.
async function collectPackage(root, relative = '') {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (skipped(entry.name)) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    const stats = await fs.lstat(path.join(root, child));
    if (stats.isSymbolicLink()) return null;
    if (stats.isDirectory()) {
      const nested = await collectPackage(root, child);
      if (!nested) return null;
      found.push(...nested);
      continue;
    }
    const sha256 = await readRegular(path.join(root, child), stats);
    if (!sha256) return null;
    found.push({ relative: child, sha256 });
  }
  return found;
}

export async function hashB3Module(absPath) {
  let stats;
  try { stats = await fs.lstat(absPath); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return MISSING; return INVALID; }
  try {
    if (stats.isSymbolicLink()) return INVALID;
    if (stats.isDirectory()) {
      const files = await collectPackage(absPath);
      if (!files) return INVALID;
      files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
      const hash = crypto.createHash('sha256');
      for (const file of files) hash.update(`${file.relative}\0${file.sha256}\n`);
      return { ok: true, sha256: hash.digest('hex'), kind: 'package' };
    }
    const sha256 = await readRegular(absPath, stats);
    return sha256 ? { ok: true, sha256, kind: 'file' } : INVALID;
  } catch { return INVALID; }
}
