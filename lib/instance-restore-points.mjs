import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Block 21 (4.18.27): which files of a local instance belong to which restore-point part, and how
// they are put back. Never captured: the vault, b3/b3.xml and b3/plugin_auth.ini (B3 writes both from
// the vault on every start), logs, players, zone, mods, usermaps, the BaseGame.

export const PARTS_BY_ACTION = Object.freeze({
  'config.change': ['record', 'config'],
  'plugin.change': ['record', 'plugins'],
  'b3.plugin.change': ['record', 'b3files'],
  'b3.migration': ['record', 'b3files'],
  'core.change': ['record', 'core'],
  'restore.safety': ['record', 'config', 'plugins', 'b3files', 'b3sqlite', 'core'],
  manual: ['record', 'config', 'plugins', 'b3files', 'b3sqlite', 'core'],
});
const MAX_DIRECTORY_FILES = 512;
const fail = (code, extra) => { throw Object.assign(new Error(code), { code, ...extra }); };
const invalid = () => fail('RESTORE_POINT_INVALID');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sha256Of = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Directories a part may write into (relative to the home, "/" separated), and whether files there
// that the point does not hold are moved aside on restore.
const SINGLE = { config: ['main/server.cfg'], b3sqlite: ['b3/b3.db'], b3files: ['b3/database.json'] };
const DIRECTORIES = { plugins: ['plugins'], b3files: ['b3/plugins', 'b3/extplugins'] };
const PLUGIN_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,120}\.(dll|so)$/i;
const B3_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,120}$/;

function fileAllowed(part, name) {
  if (SINGLE[part]?.includes(name)) return true;
  const slash = name.lastIndexOf('/');
  const directory = name.slice(0, slash), file = name.slice(slash + 1);
  if (!DIRECTORIES[part]?.includes(directory)) return false;
  return part === 'plugins' ? PLUGIN_FILE.test(file) : B3_FILE.test(file) && !file.startsWith('.');
}

// The directory exists, is no link and is where it claims to be.
async function realDirectory(directory) {
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(await fs.realpath(directory), path.resolve(directory))) invalid();
  return directory;
}
async function readRegular(file) {
  let stats;
  try { stats = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) invalid();
  return fs.readFile(file);
}
async function listDirectory(home, relative, part) {
  const directory = path.join(home, ...relative.split('/'));
  try { await realDirectory(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const names = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (names.length > MAX_DIRECTORY_FILES) fail('RESTORE_POINT_TOO_LARGE');
    const name = `${relative}/${entry.name}`;
    if (entry.isFile() && fileAllowed(part, name)) names.push(name);
  }
  return names.sort();
}

export async function collectInstanceParts(instance, parts) {
  const entries = [], data = {}, refs = {};
  const home = instance.homePath;
  for (const part of parts) {
    if (part === 'record') data.record = structuredClone(instance);
    else if (part === 'core') {
      const bytes = await fs.readFile(instance.serverCore.executablePath).catch(() => null);
      refs.core = { executablePath: instance.serverCore.executablePath, version: instance.serverCore.version, sha256: bytes ? sha256Of(bytes) : null };
    } else {
      const names = [...(SINGLE[part] || []), ...(await Promise.all((DIRECTORIES[part] || []).map(directory => listDirectory(home, directory, part)))).flat()];
      if (!SINGLE[part] && !DIRECTORIES[part]) invalid();
      for (const name of names) {
        const bytes = await readRegular(path.join(home, ...name.split('/')));
        if (bytes) entries.push({ part, name, bytes });
      }
    }
  }
  return { entries, data, refs };
}

// True when restoring these parts of the point puts code back (Block 20 rule: code needs server.code).
export function pointBringsCode(manifest, parts) {
  const chosen = parts.filter(part => manifest.parts.includes(part));
  if (chosen.some(part => ['plugins', 'core', 'files'].includes(part))) return true;
  return chosen.includes('b3files') && manifest.files.some(entry => entry.part === 'b3files' && entry.name.startsWith('b3/extplugins/'));
}

async function moveAside(home, relative, stamp) {
  const file = path.join(home, ...relative.split('/'));
  const archive = path.join(path.dirname(file), '.removed');
  await fs.mkdir(archive, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await realDirectory(archive);
  await fs.rename(file, path.join(archive, `${path.basename(file)}.${stamp}`));
}
async function writeAtomic(file, bytes) {
  const temporary = path.join(path.dirname(file), `.restore-${crypto.randomUUID()}`);
  await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
}

// Puts the chosen parts of a verified point back. Every name is checked against the part's allowed
// files before the first write; files the point does not hold are moved to .removed, never deleted.
export async function restoreInstanceParts(instance, point, parts, { store, now = () => new Date() }) {
  const { manifest } = point;
  if (manifest.data.record && manifest.data.record.id !== instance.id) invalid();
  const chosen = parts.filter(part => manifest.parts.includes(part));
  const files = manifest.files.filter(entry => chosen.includes(entry.part));
  for (const entry of files) if (!fileAllowed(entry.part, entry.name)) invalid();
  const home = instance.homePath;
  await realDirectory(home);
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const restored = [], skipped = parts.filter(part => !manifest.parts.includes(part));
  for (const part of chosen) {
    if (part === 'record' || part === 'core' || part === 'b3mysql') continue;
    const wanted = new Set(files.filter(entry => entry.part === part).map(entry => entry.name));
    const present = [...(SINGLE[part] || []).filter(Boolean), ...(await Promise.all((DIRECTORIES[part] || []).map(directory => listDirectory(home, directory, part)))).flat()];
    for (const name of present) {
      if (wanted.has(name)) continue;
      if (await readRegular(path.join(home, ...name.split('/'))) !== null) await moveAside(home, name, stamp);
    }
    for (const name of wanted) {
      const file = path.join(home, ...name.split('/'));
      const relative = path.relative(home, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) invalid();
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await realDirectory(path.dirname(file));
      const current = await readRegular(file);
      const bytes = point.file(part, name);
      if (!current || !current.equals(bytes)) await writeAtomic(file, bytes);
    }
    restored.push(part);
  }
  // The record last: it names the plugin files and the core that are now in place.
  if (chosen.includes('record') || chosen.includes('core')) {
    const record = manifest.data.record;
    if (!record) invalid();
    await store.replaceRecord(instance.id, record);
    if (chosen.includes('record')) restored.push('record');
    if (chosen.includes('core')) restored.push('core');
  }
  return { restored, skipped };
}
