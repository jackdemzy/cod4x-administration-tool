import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { guardedChange } from './restore-guard.mjs';

// Block 21 (4.18.27): the standard server's installer writes archives through a restore point.
// Archives are unpacked into a private staging directory first; only regular files and directories
// are accepted. The point holds every target file an entry would overwrite (part "files") and the
// list of names the install creates, so a failed verify puts the target back byte-identical.

const require = createRequire(import.meta.url);
const tar = require('tar');
const AdmZip = require('adm-zip');
export const DEFAULT_RUNTIME_SUBJECT = 'default-runtime';
const fail = (code, extra) => { throw Object.assign(new Error(code), { code, ...extra }); };
const sha256Of = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function assertSafeChildPath(root, child) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, child);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) throw new Error('Unsafe path rejected');
  return resolved;
}

export async function extractArchive(file, destination) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.zip')) {
    const zip = new AdmZip(file);
    const entries = zip.getEntries();
    for (const entry of entries) assertSafeChildPath(destination, entry.entryName); // all names before the first write
    for (const entry of entries) {
      const out = assertSafeChildPath(destination, entry.entryName);
      if (entry.isDirectory) await fs.mkdir(out, { recursive: true });
      else {
        await fs.mkdir(path.dirname(out), { recursive: true });
        await fs.writeFile(out, entry.getData());
      }
    }
    return;
  }
  if (lower.endsWith('.tar') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    // Links are refused: a link entry could point the next entry outside the destination.
    // (Collected, never thrown inside the parser callback: that would be an uncaught exception.)
    const entries = [];
    await tar.t({ file, strict: true, onReadEntry: entry => { entries.push({ name: entry.path, type: entry.type }); } });
    if (entries.some(entry => !['File', 'OldFile', 'Directory'].includes(entry.type))) fail('INSTALL_ARCHIVE_INVALID');
    for (const entry of entries) assertSafeChildPath(destination, entry.name);
    await tar.x({ file, cwd: destination, strict: true, filter: (name, entry) => { try { assertSafeChildPath(destination, name); } catch { return false; } return !entry?.type || ['File', 'OldFile', 'Directory'].includes(entry.type); } });
    return;
  }
  await fs.copyFile(file, assertSafeChildPath(destination, path.basename(file)));
}

async function walk(root, relative = '', out = []) {
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { out.push({ name, directory: true, sha256: null }); await walk(root, name, out); }
    else if (entry.isFile()) out.push({ name, directory: false, sha256: sha256Of(await fs.readFile(path.join(root, ...name.split('/')))) });
    else fail('INSTALL_ARCHIVE_INVALID');
  }
  return out;
}

// Unpacks into a private staging directory; the caller removes it with cleanup().
export async function stageArchive(file) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-stage-'));
  const cleanup = () => fs.rm(directory, { recursive: true, force: true });
  try {
    await extractArchive(file, directory);
    return { directory, entries: (await walk(directory)).sort((a, b) => a.name.localeCompare(b.name)), cleanup };
  } catch (error) { await cleanup(); throw error; }
}

export async function listArchiveEntries(file) {
  const staged = await stageArchive(file);
  try { return staged.entries; } finally { await staged.cleanup(); }
}

// What exists at <target>/<name>: null, 'file' or 'directory'. A link anywhere on the way is refused.
async function existing(target, name) {
  let current = target;
  const segments = name.split('/');
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    const stats = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stats) return null;
    if (stats.isSymbolicLink()) fail('INSTALL_TARGET_INVALID');
    if (index < segments.length - 1 && !stats.isDirectory()) fail('INSTALL_TARGET_INVALID');
    if (index === segments.length - 1) {
      if (stats.isDirectory()) return { kind: 'directory' };
      if (stats.isFile()) return { kind: 'file', mode: stats.mode & 0o777 };
      fail('INSTALL_TARGET_INVALID');
    }
  }
  return null;
}

async function writeAtomic(file, bytes, mode) {
  const temporary = path.join(path.dirname(file), `.restore-${crypto.randomUUID()}`);
  await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try { await fs.chmod(temporary, mode & 0o755); await fs.rename(temporary, file); }
  catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
}

// Puts a "files" point back into target: captured files written back with their mode, files and then
// empty directories the change created removed. Names are checked again before the first write.
export async function restoreFilesPoint(target, point) {
  const { manifest } = point;
  const info = manifest.refs?.files;
  if (!info || !Array.isArray(info.created) || typeof info.modes !== 'object' || !info.modes) fail('RESTORE_POINT_INVALID');
  if (info.target !== undefined && info.target !== path.resolve(target)) fail('RESTORE_POINT_INVALID');
  const captured = manifest.files.filter(entry => entry.part === 'files');
  for (const name of [...captured.map(entry => entry.name), ...info.created]) {
    if (typeof name !== 'string') fail('RESTORE_POINT_INVALID');
    try { assertSafeChildPath(target, name); } catch { fail('RESTORE_POINT_INVALID'); }
  }
  for (const entry of captured) {
    const kind = await existing(target, entry.name);
    if (kind?.kind === 'directory') fail('RESTORE_POINT_INVALID');
    const file = path.join(target, ...entry.name.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeAtomic(file, point.file('files', entry.name), Number(info.modes[entry.name]) || 0o644);
  }
  const created = [...info.created].sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a));
  for (const name of created) {
    const kind = await existing(target, name);
    const file = path.join(target, ...name.split('/'));
    if (kind?.kind === 'file') await fs.unlink(file);
    else if (kind?.kind === 'directory') await fs.rmdir(file).catch(error => { if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error; });
  }
  return { restored: captured.length, removed: created.length };
}

// artifacts: downloaded and SHA-256-checked files. extraFiles: { name: Buffer } written after them
// (e.g. the install manifest). Returns { restorePointId, files }.
export async function installArtifacts({ artifacts, target, store, actor = null, audit = () => {}, extraFiles = {}, copy = (from, to) => fs.copyFile(from, to) }) {
  await fs.mkdir(target, { recursive: true });
  const staged = [];
  try {
    for (const artifact of artifacts) staged.push(await stageArchive(artifact));
    // Last writer wins per name, as with extracting the archives one after another.
    const plan = new Map();
    staged.forEach((stage, index) => { for (const entry of stage.entries) plan.set(entry.name, { ...entry, source: entry.directory ? null : path.join(stage.directory, ...entry.name.split('/')), index }); });
    for (const [name, bytes] of Object.entries(extraFiles)) {
      assertSafeChildPath(target, name);
      plan.set(name, { name, directory: false, sha256: sha256Of(bytes), bytes });
    }
    const files = [...plan.values()];
    // Checked before the point: a link or a file/directory clash in the target refuses the install.
    for (const entry of files) {
      assertSafeChildPath(target, entry.name);
      const kind = await existing(target, entry.name);
      if (entry.directory ? kind?.kind === 'file' : kind?.kind === 'directory') fail('INSTALL_TARGET_INVALID');
    }
    let created = [];
    return await guardedChange({
      store, subject: DEFAULT_RUNTIME_SUBJECT, action: 'core.change', actor, audit,
      capture: async () => {
        const entries = [], modes = {};
        created = [];
        for (const entry of files) {
          assertSafeChildPath(target, entry.name);
          const kind = await existing(target, entry.name);
          if (entry.directory ? kind?.kind === 'file' : kind?.kind === 'directory') fail('INSTALL_TARGET_INVALID');
          if (!kind) {
            // Missing parent directories are created too: record them so a rollback removes them.
            const segments = entry.name.split('/');
            for (let depth = 1; depth < segments.length; depth++) {
              const parent = segments.slice(0, depth).join('/');
              if (!created.includes(parent) && !await existing(target, parent)) created.push(parent);
            }
            created.push(entry.name);
          } else if (kind.kind === 'file') {
            entries.push({ part: 'files', name: entry.name, bytes: await fs.readFile(path.join(target, ...entry.name.split('/'))) });
            modes[entry.name] = kind.mode;
          }
        }
        return { entries, refs: { files: { target: path.resolve(target), created: [...new Set(created)], modes } }, parts: ['files'] };
      },
      change: async () => {
        for (const entry of files) {
          const out = path.join(target, ...entry.name.split('/'));
          if (entry.directory) { await fs.mkdir(out, { recursive: true }); continue; }
          await fs.mkdir(path.dirname(out), { recursive: true });
          if (entry.bytes) await fs.writeFile(out, entry.bytes);
          else await copy(entry.source, out);
        }
        return { files: files.filter(entry => !entry.directory).length };
      },
      verify: async () => {
        for (const entry of files) {
          if (entry.directory) continue;
          const kind = await existing(target, entry.name);
          if (kind?.kind !== 'file' || sha256Of(await fs.readFile(path.join(target, ...entry.name.split('/')))) !== entry.sha256) fail('INSTALL_VERIFY_FAILED');
        }
      },
      rollback: point => restoreFilesPoint(target, point),
    }).then(({ result, restorePointId }) => ({ ...result, restorePointId }));
  } finally {
    for (const stage of staged) await stage.cleanup();
  }
}

// The current state of the names a files point touches (for the safety point before a manual restore):
// existing files with their mode; names that do not exist count as created, so restoring the safety
// point removes them again.
export async function snapshotFiles(target, point) {
  const info = point.manifest.refs?.files;
  if (!info || !Array.isArray(info.created)) fail('RESTORE_POINT_INVALID');
  const names = [...new Set([...point.manifest.files.filter(entry => entry.part === 'files').map(entry => entry.name), ...info.created])];
  const entries = [], modes = {}, created = [];
  for (const name of names) {
    if (typeof name !== 'string') fail('RESTORE_POINT_INVALID');
    try { assertSafeChildPath(target, name); } catch { fail('RESTORE_POINT_INVALID'); }
    const kind = await existing(target, name);
    if (!kind) created.push(name);
    else if (kind.kind === 'file') { entries.push({ part: 'files', name, bytes: await fs.readFile(path.join(target, ...name.split('/'))) }); modes[name] = kind.mode; }
  }
  return { entries, refs: { files: { target: path.resolve(target), created, modes } }, parts: ['files'] };
}
