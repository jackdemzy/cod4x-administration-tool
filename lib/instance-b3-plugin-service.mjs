// Block 16b: B3 plugin files and operations per instance. Never imports or runs Python.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { b3Paths, safeDirectory } from './b3-config.mjs';
import { normalizedHash } from './b3-dependencies.mjs';
import { hashB3Module } from './b3-plugin-hash.mjs';
import { B3_PLUGIN_CATALOG, B3_FIXED_PLUGINS, isAvailable, modulePath } from './b3-plugin-catalog.mjs';
import { MAX_B3_PLUGINS, validB3PluginName } from './b3-plugin-registry.mjs';
import { renderB3PluginTemplate } from './b3-plugin-template.mjs';
import { MAX_B3_PLUGIN_TEXT_BYTES, checkB3PluginText, validateB3PluginIni, validateB3PluginXml, validateB3PluginCode } from './b3-plugin-validate.mjs';

const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code }, extra); };
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const EMPTY_SHA = sha(Buffer.alloc(0));

async function writePrivate(file, data, { exclusive = false } = {}) {
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
  try {
    if (exclusive) { await fs.link(temporary, file); await fs.rm(temporary, { force: true }); } else await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    if (error.code === 'EEXIST') fail('B3_PLUGIN_CONFLICT');
    throw error;
  }
}

// Reads a regular, non-symlink file; null when missing.
async function readRegular(file, limit = MAX_B3_PLUGIN_TEXT_BYTES) {
  let stats;
  try { stats = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  if (!stats.isFile() || stats.isSymbolicLink()) fail('B3_DIRECTORY_INVALID');
  if (stats.size > limit) fail('B3_PLUGIN_CONFIG_INVALID');
  return fs.readFile(file);
}

// A read must not follow a symlinked directory either; a missing directory just means "no files yet".
async function checkedDirectory(directory) {
  try { await fs.lstat(directory); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  await safeDirectory(directory, false);
  return true;
}

const extOf = file => (file && /\.(ini|xml)$/.exec(file)?.[1]) || null;

export class InstanceB3PluginService {
  constructor({ store, environment, catalog = B3_PLUGIN_CATALOG, exclusive = null, now = () => new Date() }) {
    Object.assign(this, { store, environment, catalog, externalExclusive: exclusive, now });
    this.queues = new Map();
  }

  entry(name) { return this.catalog.find(item => item.name === name) || null; }

  // Serializes writes per instance id; a failed write never poisons the queue.
  run(id, fn) {
    if (this.externalExclusive) return this.externalExclusive(id, fn);
    const previous = this.queues.get(id) || Promise.resolve();
    const result = previous.then(fn);
    const tail = result.then(() => {}, () => {});
    this.queues.set(id, tail);
    tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id); });
    return result;
  }

  async b3Path() {
    try { return (await this.environment.read())?.b3Path || null; } catch { return null; }
  }

  instance(id) { return this.store.get(id); }

  dirs(instance) {
    const base = b3Paths(instance).directory;
    return { base, plugins: path.join(base, 'plugins'), extplugins: path.join(base, 'extplugins') };
  }

  async prepareDirs(instance, ...which) {
    const dirs = this.dirs(instance);
    await safeDirectory(dirs.base, true);
    for (const key of which) await safeDirectory(dirs[key], true);
    return dirs;
  }

  configFile(instance, name, ext) { return path.join(this.dirs(instance).plugins, `${name}.${ext}`); }
  codeFile(instance, name) { return path.join(this.dirs(instance).extplugins, `${name}.py`); }

  async commit(id, records) { await this.store.setB3Plugins(id, records); }

  records(id) { return this.instance(id).b3Plugins.map(record => ({ ...record })); }

  async currentHash(instance, record, b3Path) {
    if (record.source === 'custom') {
      const dir = this.dirs(instance).extplugins;
      try { if (!(await checkedDirectory(dir))) return { ok: false, code: 'MISSING' }; } catch { return { ok: false, code: 'INVALID' }; }
      return hashB3Module(this.codeFile(instance, record.name));
    }
    const entry = this.entry(record.name);
    if (!entry || !b3Path) return { ok: false, code: 'MISSING' };
    return hashB3Module(modulePath(b3Path, entry));
  }

  async row(instance, name, b3Path) {
    const entry = this.entry(name);
    const record = instance.b3Plugins.find(item => item.name === name) || null;
    const requires = entry ? { plugins: [...entry.requiresPlugins], pythonModules: [...entry.pythonModules] } : { plugins: [], pythonModules: [] };
    const base = { name, source: record?.source || (entry ? 'shipped' : 'custom'), enabled: record?.enabled || false, sha256: null, expectedSha256: record?.sha256 || entry?.sha256 || null, configType: record?.configType || extOf(entry?.configTemplate), requires, reason: null };
    if (B3_FIXED_PLUGINS.includes(name)) return { ...base, source: 'fixed', enabled: false, state: 'UNAVAILABLE', expectedSha256: null, reason: 'B3_PLUGIN_FIXED' };
    if (entry && !isAvailable(entry)) return { ...base, enabled: false, state: 'UNAVAILABLE', reason: 'B3_PLUGIN_PARSER_UNSUPPORTED' };
    if (!record) {
      if (entry && !b3Path) return { ...base, state: 'MISSING', reason: 'B3_PLUGIN_MISSING' };
      return { ...base, state: 'DISABLED' };
    }
    const hashed = await this.currentHash(instance, record, b3Path);
    if (!hashed.ok) return { ...base, state: hashed.code === 'MISSING' ? 'MISSING' : 'INTEGRITY_MISMATCH', reason: hashed.code === 'MISSING' ? 'B3_PLUGIN_MISSING' : 'B3_PLUGIN_INTEGRITY_FAILED' };
    const row = { ...base, sha256: hashed.sha256 };
    if (record.source === 'shipped' && hashed.sha256 !== entry.sha256 && record.sha256 === entry.sha256) return { ...row, state: 'NOT_APPROVED', reason: 'B3_PLUGIN_NOT_APPROVED' };
    if (hashed.sha256 !== record.sha256) return { ...row, state: 'INTEGRITY_MISMATCH', reason: 'B3_PLUGIN_INTEGRITY_FAILED' };
    return { ...row, state: record.enabled ? 'ENABLED' : 'DISABLED' };
  }

  async list(id) {
    const instance = this.instance(id);
    const b3Path = await this.b3Path();
    const names = [...this.catalog.map(item => item.name), ...instance.b3Plugins.filter(item => item.source === 'custom').map(item => item.name), ...B3_FIXED_PLUGINS];
    const plugins = [];
    for (const name of names) plugins.push(await this.row(instance, name, b3Path));
    return { plugins, revision: instance.b3PluginsRevision };
  }

  async rowAfter(id, name) { return this.row(this.instance(id), name, await this.b3Path()); }

  // Path of the plugin's existing config file, or null. A symlinked or foreign
  // plugins directory throws (B3_DIRECTORY_INVALID) instead of being trusted.
  async existingConfig(instance, record) {
    if (!record.configType || !(await checkedDirectory(this.dirs(instance).plugins))) return null;
    const file = this.configFile(instance, record.name, record.configType);
    try {
      const stats = await fs.lstat(file);
      return stats.isFile() && !stats.isSymbolicLink() ? file : null;
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  }

  // Start plan (B3 start, before any file is written): checks every enabled
  // plugin and lists them in registry order for b3.xml. Disabled plugins are
  // never checked. `dependencies` is the fresh B3 dependency check.
  async plan(id, dependencies = null) {
    const instance = this.instance(id);
    const b3Path = dependencies?.environment?.b3Path || await this.b3Path();
    const present = new Set((dependencies?.results || []).filter(item => item.status === 'OK').map(item => item.id));
    const enabled = instance.b3Plugins.filter(record => record.enabled);
    const active = new Set([...B3_FIXED_PLUGINS, ...enabled.map(record => record.name)]);
    const blockers = [], plugins = [];
    for (const record of enabled) {
      const block = code => blockers.push({ code, plugin: record.name });
      const entry = record.source === 'custom' ? null : this.entry(record.name);
      const hashed = await this.currentHash(instance, record, b3Path);
      if (!hashed.ok) block(hashed.code === 'MISSING' ? 'B3_PLUGIN_MISSING' : 'B3_PLUGIN_INTEGRITY_FAILED');
      else if (hashed.sha256 !== record.sha256) block(entry && record.sha256 === entry.sha256 ? 'B3_PLUGIN_NOT_APPROVED' : 'B3_PLUGIN_INTEGRITY_FAILED');
      for (const module of entry?.pythonModules || []) if (!present.has(module)) block('B3_PLUGIN_DEPENDENCY_MISSING');
      for (const required of entry?.requiresPlugins || []) if (!active.has(required)) block('B3_PLUGIN_REQUIRES_PLUGIN');
      const configPath = await this.existingConfig(instance, record);
      // Custom plugins declare no catalog attributes; a recorded config type means one is expected.
      const requiresConfig = entry ? entry.requiresConfigFile : Boolean(record.configType);
      if (requiresConfig && !configPath) block('B3_PLUGIN_CONFIG_MISSING');
      plugins.push({ name: record.name, source: record.source, configPath, path: record.source === 'custom' ? this.dirs(instance).extplugins : null });
    }
    return { blockers, plugins, revision: instance.b3PluginsRevision };
  }

  // ---- enable / disable ----
  setEnabled(id, name, enabled) {
    return this.run(id, async () => {
      if (typeof enabled !== 'boolean') fail('B3_PLUGIN_REGISTRY_INVALID');
      const instance = this.instance(id);
      const records = this.records(id);
      const existing = records.find(item => item.name === name);
      if (existing?.source === 'custom') return this.toggleCustom(id, instance, records, existing, enabled);
      validB3PluginName(name); // throws NAME_INVALID / FIXED for fixed names
      const entry = this.entry(name);
      if (!entry) fail('B3_PLUGIN_UNKNOWN');
      if (!isAvailable(entry)) fail('B3_PLUGIN_FIXED');
      if (!enabled) {
        if (existing) { existing.enabled = false; await this.commit(id, records); }
        return this.rowAfter(id, name);
      }
      const b3Path = await this.b3Path();
      if (!b3Path) fail('B3_PLUGIN_MISSING');
      const hashed = await hashB3Module(modulePath(b3Path, entry));
      if (!hashed.ok) fail(hashed.code === 'MISSING' ? 'B3_PLUGIN_MISSING' : 'B3_PLUGIN_INTEGRITY_FAILED');
      let configType = existing?.configType ?? null;
      if (entry.configTemplate) {
        const ext = extOf(entry.configTemplate);
        await this.prepareDirs(instance, 'plugins');
        const target = this.configFile(instance, name, ext);
        if ((await readRegular(target)) === null) {
          const template = await readRegular(path.join(b3Path, ...entry.configTemplate.split('/')));
          if (!template) fail('B3_PLUGIN_CONFIG_MISSING');
          if (normalizedHash(template) !== entry.configTemplateSha256) fail('B3_PLUGIN_INTEGRITY_FAILED');
          await writePrivate(target, template, { exclusive: true });
        }
        configType = ext;
      }
      if (existing) { existing.enabled = true; existing.configType = configType; } else records.push({ name, source: 'shipped', enabled: true, sha256: entry.sha256, approvedAt: this.now().toISOString(), configType });
      await this.commit(id, records);
      return this.rowAfter(id, name);
    });
  }

  async toggleCustom(id, instance, records, record, enabled) {
    if (enabled) {
      const hashed = await this.currentHash(instance, record, null);
      if (!hashed.ok) fail(hashed.code === 'MISSING' ? 'B3_PLUGIN_MISSING' : 'B3_PLUGIN_INTEGRITY_FAILED');
    }
    record.enabled = enabled;
    await this.commit(id, records);
    return this.rowAfter(id, record.name);
  }

  // ---- config ----
  recordFor(id, name) {
    if (typeof name !== 'string') fail('B3_PLUGIN_NAME_INVALID');
    if (B3_FIXED_PLUGINS.includes(name)) fail('B3_PLUGIN_FIXED');
    const record = this.instance(id).b3Plugins.find(item => item.name === name);
    if (!record) fail('B3_PLUGIN_UNKNOWN');
    return record;
  }

  async readConfig(id, name) {
    const record = this.recordFor(id, name);
    const instance = this.instance(id);
    if (!record.configType) return { text: '', sha256: EMPTY_SHA, configType: null };
    if (!(await checkedDirectory(this.dirs(instance).plugins))) return { text: '', sha256: EMPTY_SHA, configType: record.configType };
    const buffer = await readRegular(this.configFile(instance, name, record.configType));
    if (!buffer) return { text: '', sha256: EMPTY_SHA, configType: record.configType };
    checkB3PluginText(buffer);
    return { text: buffer.toString('utf8'), sha256: sha(buffer), configType: record.configType };
  }

  saveConfig(id, name, { text, expectedSha256 } = {}) {
    return this.run(id, async () => {
      const record = this.recordFor(id, name);
      const instance = this.instance(id);
      checkB3PluginText(text);
      const configType = record.configType || (/^\s*</.test(text) ? 'xml' : 'ini');
      const checked = configType === 'xml' ? validateB3PluginXml(text) : validateB3PluginIni(text);
      if (!checked.ok) fail('B3_PLUGIN_CONFIG_INVALID', { line: checked.line });
      await this.prepareDirs(instance, 'plugins');
      const file = this.configFile(instance, name, configType);
      const current = await readRegular(file);
      if ((current ? sha(current) : EMPTY_SHA) !== expectedSha256) fail('B3_PLUGIN_CONFLICT');
      const data = Buffer.from(text, 'utf8');
      await writePrivate(file, data);
      const records = this.records(id);
      records.find(item => item.name === name).configType = configType;
      await this.commit(id, records);
      return { sha256: sha(data) };
    });
  }

  // ---- approval ----
  approve(id, name, sha256) {
    return this.run(id, async () => {
      const record = this.recordFor(id, name);
      if (record.source !== 'shipped') fail('B3_PLUGIN_UNKNOWN');
      const entry = this.entry(name);
      const b3Path = await this.b3Path();
      if (!entry || !b3Path) fail('B3_PLUGIN_MISSING');
      const hashed = await hashB3Module(modulePath(b3Path, entry));
      if (!hashed.ok) fail(hashed.code === 'MISSING' ? 'B3_PLUGIN_MISSING' : 'B3_PLUGIN_INTEGRITY_FAILED');
      if (sha256 !== hashed.sha256) fail('B3_PLUGIN_CONFLICT');
      const records = this.records(id);
      const target = records.find(item => item.name === name);
      target.sha256 = hashed.sha256;
      target.approvedAt = this.now().toISOString();
      await this.commit(id, records);
      return this.rowAfter(id, name);
    });
  }

  // ---- custom plugins ----
  createCustom(id, input = {}) {
    return this.run(id, async () => {
      const name = validB3PluginName(input.name);
      if (this.entry(name)) fail('B3_PLUGIN_NAME_INVALID');
      const instance = this.instance(id);
      if (instance.b3Plugins.some(item => item.name === name)) fail('B3_PLUGIN_CONFLICT');
      if (instance.b3Plugins.length >= MAX_B3_PLUGINS) fail('B3_PLUGIN_LIMIT');
      let code, config = null;
      if (input.from === 'template') ({ code, config } = renderB3PluginTemplate(name));
      else { code = input.code; validateB3PluginCode(name, code); }
      const dirs = await this.prepareDirs(instance, 'extplugins', ...(config ? ['plugins'] : []));
      const codeFile = path.join(dirs.extplugins, `${name}.py`);
      const configFile = path.join(dirs.plugins, `${name}.ini`);
      if (config && (await readRegular(configFile)) !== null) fail('B3_PLUGIN_CONFLICT');
      const data = Buffer.from(code, 'utf8');
      const created = [];
      try {
        await writePrivate(codeFile, data, { exclusive: true });
        created.push(codeFile);
        if (config) { await writePrivate(configFile, Buffer.from(config, 'utf8'), { exclusive: true }); created.push(configFile); }
        const records = this.records(id);
        records.push({ name, source: 'custom', enabled: false, sha256: sha(data), approvedAt: this.now().toISOString(), configType: config ? 'ini' : null });
        await this.commit(id, records);
      } catch (error) {
        for (const file of created) await fs.rm(file, { force: true }).catch(() => {});
        throw error;
      }
      return this.rowAfter(id, name);
    });
  }

  customRecord(id, name) {
    const record = this.recordFor(id, name);
    if (record.source !== 'custom') fail('B3_PLUGIN_UNKNOWN');
    return record;
  }

  async readCode(id, name) {
    this.customRecord(id, name);
    const instance = this.instance(id);
    if (!(await checkedDirectory(this.dirs(instance).extplugins))) fail('B3_PLUGIN_MISSING');
    const buffer = await readRegular(this.codeFile(instance, name));
    if (!buffer) fail('B3_PLUGIN_MISSING');
    checkB3PluginText(buffer, 'B3_PLUGIN_CODE_INVALID');
    return { code: buffer.toString('utf8'), sha256: sha(buffer) };
  }

  saveCode(id, name, { code, expectedSha256 } = {}) {
    return this.run(id, async () => {
      this.customRecord(id, name);
      const instance = this.instance(id);
      validateB3PluginCode(name, code);
      await this.prepareDirs(instance, 'extplugins');
      const file = this.codeFile(instance, name);
      const current = await readRegular(file);
      if (!current || sha(current) !== expectedSha256) fail('B3_PLUGIN_CONFLICT');
      const data = Buffer.from(code, 'utf8');
      await writePrivate(file, data);
      const records = this.records(id);
      const target = records.find(item => item.name === name);
      target.sha256 = sha(data);
      target.approvedAt = this.now().toISOString();
      await this.commit(id, records);
      return { sha256: target.sha256 };
    });
  }

  deleteCustom(id, name) {
    return this.run(id, async () => {
      const record = this.customRecord(id, name);
      const instance = this.instance(id);
      const dirs = await this.prepareDirs(instance, 'extplugins', 'plugins');
      const code = path.join(dirs.extplugins, `${name}.py`);
      if ((await readRegular(code, Infinity)) !== null) await fs.rm(code);
      if (record.configType) {
        const config = path.join(dirs.plugins, `${name}.${record.configType}`);
        if ((await readRegular(config)) !== null) await fs.rename(config, `${config}.bak`);
      }
      await this.commit(id, this.records(id).filter(item => item.name !== name));
      return { name };
    });
  }
}
