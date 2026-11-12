import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Block 21 (4.18.27): restore points. One directory per point:
//   <root>/<subjectDir>/<pointId>/manifest.json and files/<part>/<name>
// written into a temporary directory and renamed into place, verified by hash before use.
// The store knows nothing about instances; adapters decide which file belongs to which part.

export const PARTS = Object.freeze(['record', 'config', 'plugins', 'b3files', 'b3sqlite', 'b3mysql', 'core', 'files']);
export const POINT_ID = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const SUBJECT = /^(?:(local|remote):([a-z][a-z0-9-]{0,47})|default-runtime)$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const sha256Of = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (code, extra) => { throw Object.assign(new Error(code), { code, ...extra }); };
const invalid = () => fail('RESTORE_POINT_INVALID');

export function validSubject(subject) {
  const match = typeof subject === 'string' ? SUBJECT.exec(subject) : null;
  if (!match || (match[2] && RESERVED.test(match[2]))) invalid();
  return subject;
}
export const subjectDirectory = subject => validSubject(subject).replace(':', '_');

// Relative names with "/" separators, every segment a plain file or directory name.
export function validEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 1024 || /[\x00-\x1f\\:]/.test(name)) invalid();
  const segments = name.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.length > 255)) invalid();
  return name;
}
const validPart = part => { if (!PARTS.includes(part)) invalid(); return part; };
const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function privateOk(stats, { directory = false } = {}) {
  if (stats.isSymbolicLink() || (directory ? !stats.isDirectory() : !stats.isFile())) return false;
  if (!directory && stats.nlink !== 1) return false;
  if (process.platform === 'linux' && (stats.uid !== process.getuid() || (stats.mode & 0o077))) return false;
  return true;
}

export class RestorePointStore {
  constructor({ root, now = () => new Date(), maxBytes = 268435456, maxAutomatic = 20, maxManual = 10 }) {
    if (typeof root !== 'string' || !root) fail('RESTORE_POINT_FAILED');
    Object.assign(this, { root: path.resolve(root), now, maxBytes, maxAutomatic, maxManual });
    this.writeFile = (file, bytes, options) => fs.writeFile(file, bytes, options); // replaceable in tests
    this.queues = new Map();
  }

  // One writer per subject, so capture, prune and the recovery mark never interleave.
  #serial(subject, action) {
    const previous = this.queues.get(subject) || Promise.resolve();
    const result = previous.then(action);
    this.queues.set(subject, result.catch(() => {}));
    return result;
  }

  async #subjectDir(subject, create = false) {
    const directory = path.join(this.root, subjectDirectory(subject));
    if (create) {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    }
    const stats = await fs.lstat(directory);
    if (!privateOk(stats, { directory: true })) invalid();
    return directory;
  }

  #pointId() {
    const stamp = this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    return `${stamp}-${crypto.randomBytes(4).toString('hex')}`;
  }

  async capture(subject, { action, actor = null, manual = false, entries = [], data = {}, refs = {}, parts: declared = [] } = {}) {
    validSubject(subject);
    if (typeof action !== 'string' || !/^[a-z0-9.]{1,64}$/.test(action) || !Array.isArray(entries)) invalid();
    const seen = new Set();
    let totalBytes = 0;
    const files = entries.map(entry => {
      validPart(entry?.part); validEntryName(entry.name);
      if (!Buffer.isBuffer(entry.bytes)) invalid();
      const key = `${entry.part}/${entry.name}`;
      if (seen.has(key)) invalid();
      seen.add(key);
      totalBytes += entry.bytes.length;
      return { part: entry.part, name: entry.name, bytes: entry.bytes.length, sha256: sha256Of(entry.bytes) };
    });
    if (!Array.isArray(declared)) invalid();
    for (const part of [...Object.keys(data), ...Object.keys(refs), ...declared]) validPart(part);
    if (totalBytes > this.maxBytes) fail('RESTORE_POINT_TOO_LARGE');
    const parts = [...new Set([...declared, ...files.map(file => file.part), ...Object.keys(data), ...Object.keys(refs)])].sort(); // a declared part may be empty
    return this.#serial(subject, async () => {
      let temporary = null;
      try {
        const directory = await this.#subjectDir(subject, true);
        const pointId = this.#pointId();
        const manifest = { version: 1, subject, pointId, action, actor: typeof actor === 'string' ? actor : null, manual: manual === true, createdAt: this.now().toISOString(), parts, files, data, refs, totalBytes };
        temporary = path.join(directory, `.tmp-${crypto.randomUUID()}`);
        await fs.mkdir(temporary, { mode: 0o700 });
        for (const entry of entries) {
          const target = path.join(temporary, 'files', entry.part, ...entry.name.split('/'));
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await this.writeFile(target, entry.bytes, { flag: 'wx', mode: 0o600 });
        }
        await this.writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, path.join(directory, pointId));
        temporary = null;
        await this.#prune(subject, directory);
        return { pointId, manifest };
      } catch (error) {
        if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
        if (String(error.code).startsWith('RESTORE_POINT_')) throw error;
        fail('RESTORE_POINT_FAILED', { cause: error.code || null });
      }
    });
  }

  // Manifest and directory checks plus file sizes; `hash` re-reads and hashes every file.
  async #load(subject, pointId, { hash }) {
    if (typeof pointId !== 'string' || !POINT_ID.test(pointId)) invalid();
    let directory;
    try { directory = await this.#subjectDir(subject); }
    catch (error) { if (error.code === 'ENOENT') fail('RESTORE_POINT_NOT_FOUND'); throw error; }
    // The directory name comes from the listing, never from the request (the id is checked above too).
    const name = (await fs.readdir(directory)).find(entry => entry === pointId);
    if (!name) fail('RESTORE_POINT_NOT_FOUND');
    const pointDir = path.join(directory, name);
    const stats = await fs.lstat(pointDir).catch(error => { if (error.code === 'ENOENT') fail('RESTORE_POINT_NOT_FOUND'); throw error; });
    if (!privateOk(stats, { directory: true })) invalid();
    try {
      const manifestFile = path.join(pointDir, 'manifest.json');
      const manifestStats = await fs.lstat(manifestFile);
      if (!privateOk(manifestStats) || manifestStats.size > MAX_MANIFEST_BYTES) invalid();
      const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(manifestFile)));
      if (manifest?.version !== 1 || manifest.subject !== subject || manifest.pointId !== pointId || !isoTime(manifest.createdAt) || typeof manifest.action !== 'string') invalid();
      if (!Array.isArray(manifest.files) || !Array.isArray(manifest.parts) || !manifest.data || typeof manifest.data !== 'object' || !manifest.refs || typeof manifest.refs !== 'object') invalid();
      manifest.parts.forEach(validPart);
      for (const part of [...Object.keys(manifest.data), ...Object.keys(manifest.refs)]) validPart(part);
      const contents = new Map();
      let total = 0;
      const filesRoot = path.join(pointDir, 'files');
      for (const entry of manifest.files) {
        validPart(entry?.part); validEntryName(entry.name);
        if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[0-9a-f]{64}$/.test(entry.sha256)) invalid();
        const key = `${entry.part}/${entry.name}`;
        if (contents.has(key)) invalid();
        const file = path.resolve(filesRoot, entry.part, ...entry.name.split('/'));
        if (!file.startsWith(filesRoot + path.sep)) invalid();
        const relative = path.relative(filesRoot, file);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) invalid();
        const fileStats = await fs.lstat(file);
        if (!privateOk(fileStats) || fileStats.size !== entry.bytes) invalid();
        if (await fs.realpath(file) !== path.join(await fs.realpath(filesRoot), relative)) invalid(); // no linked directory on the way
        total += entry.bytes;
        if (hash) {
          const bytes = await fs.readFile(file);
          if (bytes.length !== entry.bytes || sha256Of(bytes) !== entry.sha256) invalid();
          contents.set(key, bytes);
        } else contents.set(key, null);
      }
      if (total !== manifest.totalBytes || total > this.maxBytes) invalid();
      return { manifest, contents };
    } catch (error) {
      if (error.code === 'RESTORE_POINT_INVALID') throw error;
      invalid();
    }
  }

  async read(subject, pointId) {
    validSubject(subject);
    const { manifest, contents } = await this.#load(subject, pointId, { hash: true });
    return {
      manifest,
      file(part, name) {
        const bytes = contents.get(`${part}/${name}`);
        if (!bytes) invalid();
        return Buffer.from(bytes);
      },
    };
  }

  async list(subject) {
    validSubject(subject);
    let directory;
    try { directory = await this.#subjectDir(subject); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const names = (await fs.readdir(directory)).filter(name => POINT_ID.test(name)).sort().reverse();
    const result = [];
    for (const pointId of names) {
      try {
        const { manifest } = await this.#load(subject, pointId, { hash: false });
        result.push({ pointId, action: manifest.action, manual: manifest.manual === true, createdAt: manifest.createdAt, parts: manifest.parts, totalBytes: manifest.totalBytes, actor: manifest.actor, valid: true });
      } catch { result.push({ pointId, action: null, manual: false, createdAt: null, parts: [], totalBytes: null, actor: null, valid: false }); }
    }
    return result;
  }

  async #prune(subject, directory) {
    const pinned = (await this.#readRecovery(directory).catch(() => null))?.pointId || null; // a broken mark must not block the restore that clears it
    const points = await this.list(subject);
    const automatic = points.filter(point => !point.manual && point.pointId !== pinned);
    const manual = points.filter(point => point.manual && point.pointId !== pinned);
    const remove = [...automatic.slice(this.maxAutomatic), ...manual.slice(this.maxManual)];
    for (const point of remove) await fs.rm(path.join(directory, point.pointId), { recursive: true, force: true });
  }

  async #readRecovery(directory) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(directory, 'recovery.json'), 'utf8'));
      return value && POINT_ID.test(value.pointId) ? { pointId: value.pointId, markedAt: value.markedAt } : null;
    } catch (error) { if (error.code === 'ENOENT') return null; invalid(); }
  }
  async recovery(subject) {
    try { return await this.#readRecovery(await this.#subjectDir(subject)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async markRecovery(subject, pointId) {
    if (typeof pointId !== 'string' || !POINT_ID.test(pointId)) invalid();
    return this.#serial(subject, async () => {
      const directory = await this.#subjectDir(subject, true);
      const file = path.join(directory, 'recovery.json'), temporary = `${file}.tmp-${crypto.randomUUID()}`;
      await fs.writeFile(temporary, JSON.stringify({ pointId, markedAt: this.now().toISOString() }), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    });
  }
  async clearRecovery(subject) {
    validSubject(subject);
    return this.#serial(subject, async () => {
      try { await fs.unlink(path.join(await this.#subjectDir(subject), 'recovery.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    });
  }
}
