import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// CoD4x_Server src/plugin_handler.c: "loadPlugin <name>" reads plugins/<name>DLL_EXT
// via FS_SV_ReadFile (fs_homepath first), verifies it, copies it to
// <fs_homepath>/plugin.<name>.tmp and loads that copy. DLL_EXT is ".dll" on
// Windows and ".so" on Linux (q_platform.h). MAX_PLUGINS is 16, one slot is kept.
// The plugin name buffer is 64 bytes including "plugins/%s.dynlib" (+18).
const NAME = /^[A-Za-z0-9_]{1,40}$/;
const MAX_ENABLED = 15;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 128;
const SHA256 = /^[a-f0-9]{64}$/;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const fail = (code, details) => { throw Object.assign(new Error(code), { code, ...details }); };
export const pluginExtension = platform => platform === 'windows' ? '.dll' : '.so';

// CONTROL catalog of plugins with known source. No official hashes are published,
// so integrity is pinned per instance when the operator installs/approves a file.
// b3hide dvars: plugins/cod4x_b3hide/b3hide.c (Plugin_Cvar_Register*).
export const PLUGIN_CATALOG = Object.freeze({
  b3hide: Object.freeze({
    fullName: 'CoD4x B3 hide', source: 'https://github.com/callofduty4x/CoD4x_Server/tree/master/plugins/cod4x_b3hide', platforms: Object.freeze(['windows', 'linux']),
    dependencies: Object.freeze([Object.freeze({ kind: 'b3', required: false, note: 'Only useful together with B3 and b3plugin_auth (roadmap blocks 11-16).' })]),
    config: Object.freeze({
      b3Prefix: Object.freeze({ type: 'text', pattern: '^[!@#$%&*.,:?=~-]{1,4}$', default: '!' }),
      b3Hide: Object.freeze({ type: 'integer', min: 0, max: 1, default: '1' }),
      b3HideLvl: Object.freeze({ type: 'integer', min: 0, max: 100, default: '20' }),
    }),
  }),
});

export function validPluginName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) fail('PLUGIN_NAME_INVALID');
  return name;
}

function validConfig(name, config) {
  const schema = PLUGIN_CATALOG[name.toLowerCase()]?.config || {};
  if (config === undefined || config === null) return {};
  if (typeof config !== 'object' || Array.isArray(config)) fail('PLUGIN_CONFIG_INVALID');
  const result = {};
  for (const [key, raw] of Object.entries(config)) {
    const definition = Object.hasOwn(schema, key) ? schema[key] : null;
    const value = typeof raw === 'number' ? String(raw) : raw;
    if (!definition || typeof value !== 'string') fail('PLUGIN_CONFIG_INVALID');
    if (definition.type === 'integer' && (!/^(0|[1-9][0-9]{0,3})$/.test(value) || Number(value) < definition.min || Number(value) > definition.max)) fail('PLUGIN_CONFIG_INVALID');
    if (definition.type === 'text' && !new RegExp(definition.pattern).test(value)) fail('PLUGIN_CONFIG_INVALID');
    result[key] = value;
  }
  return result;
}

// Registry records live in the instance definition (ServerInstanceStore).
export function normalizePluginRecords(records, platform) {
  if (records === undefined || records === null) return [];
  if (!Array.isArray(records) || records.length > MAX_FILES) fail('PLUGIN_REGISTRY_INVALID');
  const names = new Set();
  const result = records.map(record => {
    if (!record || typeof record !== 'object') fail('PLUGIN_REGISTRY_INVALID');
    const name = validPluginName(record.name);
    if (names.has(name.toLowerCase()) || record.platform !== platform || !SHA256.test(record.sha256 || '') || typeof record.enabled !== 'boolean' ||
        typeof record.approvedAt !== 'string' || !Number.isFinite(Date.parse(record.approvedAt))) fail('PLUGIN_REGISTRY_INVALID');
    names.add(name.toLowerCase());
    return { name, platform, sha256: record.sha256, bytes: Number.isSafeInteger(record.bytes) ? record.bytes : null, enabled: record.enabled, approvedAt: record.approvedAt, source: record.source === 'installed' ? 'installed' : 'approved', config: validConfig(name, record.config) };
  });
  if (result.filter(record => record.enabled).length > MAX_ENABLED) fail('PLUGIN_LIMIT');
  return result;
}

async function pluginDirectory(instance) {
  const directory = path.join(instance.homePath, 'plugins');
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(await fs.realpath(directory), path.resolve(directory))) fail('PLUGIN_DIRECTORY_INVALID');
  return directory;
}

async function hashRegularFile(file) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return { valid: false, code: 'PLUGIN_FILE_UNSAFE' };
  if (before.size < 100 || before.size > MAX_BYTES) return { valid: false, code: 'PLUGIN_FILE_SIZE_INVALID' };
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev) return { valid: false, code: 'PLUGIN_FILE_CHANGED' };
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead)); total += bytesRead;
      if (total > MAX_BYTES) return { valid: false, code: 'PLUGIN_FILE_SIZE_INVALID' };
    }
    const after = await fs.lstat(file);
    if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || total !== before.size) return { valid: false, code: 'PLUGIN_FILE_CHANGED' };
    return { valid: true, sha256: digest.digest('hex'), bytes: total };
  } finally { await handle.close(); }
}

// Discovery of <home>/plugins: names, platform extension, SHA-256. Never loads.
export async function discoverPlugins(instance) {
  let directory;
  try { directory = await pluginDirectory(instance); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const ext = pluginExtension(instance.platform), other = pluginExtension(instance.platform === 'windows' ? 'linux' : 'windows');
  const found = [];
  let scanned = 0;
  for await (const entry of await fs.opendir(directory)) {
    if (++scanned > MAX_FILES) fail('PLUGIN_DIRECTORY_LIMIT');
    const lower = entry.name.toLowerCase();
    const matching = lower.endsWith(ext), foreign = lower.endsWith(other);
    if (!matching && !foreign) continue;
    const name = entry.name.slice(0, -(matching ? ext : other).length);
    const record = { name, file: entry.name, platformMatch: matching };
    if (!NAME.test(name)) { found.push({ ...record, valid: false, code: 'PLUGIN_NAME_INVALID' }); continue; }
    if (!matching) { found.push({ ...record, valid: false, code: 'PLUGIN_WRONG_PLATFORM' }); continue; }
    // Windows names are case-insensitive; Linux requires the exact file name.
    found.push({ ...record, ...await hashRegularFile(path.join(directory, entry.name)) });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// Per plugin: NOT_APPROVED, DISABLED, ENABLED, INTEGRITY_MISMATCH, MISSING, WRONG_PLATFORM, INVALID.
export function describePlugins(records, discovered) {
  const key = name => name.toLowerCase();
  const files = new Map(discovered.filter(file => file.platformMatch).map(file => [key(file.name), file]));
  const result = records.map(record => {
    const file = files.get(key(record.name));
    const catalog = PLUGIN_CATALOG[key(record.name)] || null;
    const base = { name: record.name, registered: true, enabled: record.enabled, pinnedSha256: record.sha256, approvedAt: record.approvedAt, config: record.config, catalog: catalog ? { fullName: catalog.fullName, source: catalog.source, dependencies: catalog.dependencies, configSchema: catalog.config } : null };
    if (!file) return { ...base, state: 'MISSING', sha256: null };
    if (!file.valid) return { ...base, state: 'INVALID', sha256: null, code: file.code };
    if (file.sha256 !== record.sha256) return { ...base, state: 'INTEGRITY_MISMATCH', sha256: file.sha256 };
    return { ...base, state: record.enabled ? 'ENABLED' : 'DISABLED', sha256: file.sha256, bytes: file.bytes };
  });
  for (const file of discovered) {
    if (file.platformMatch && records.some(record => key(record.name) === key(file.name))) continue;
    const catalog = PLUGIN_CATALOG[key(file.name)] || null;
    result.push({ name: file.name, file: file.file, registered: false, enabled: false, pinnedSha256: null, state: !file.platformMatch ? 'WRONG_PLATFORM' : file.valid ? 'NOT_APPROVED' : 'INVALID', sha256: file.sha256 || null, bytes: file.bytes || null, code: file.code || null,
      catalog: catalog ? { fullName: catalog.fullName, source: catalog.source, dependencies: catalog.dependencies, configSchema: catalog.config } : null });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// Launch gate: every enabled plugin must exist with its pinned hash, otherwise
// the start is blocked (fail closed) before anything is spawned.
export async function pluginLaunchArguments(instance) {
  const records = normalizePluginRecords(instance.plugins, instance.platform).filter(record => record.enabled);
  if (!records.length) return { args: [], plugins: [] };
  const states = describePlugins(records, await discoverPlugins(instance));
  // Only registered plugins gate the start; foreign-platform files are informational.
  const broken = states.filter(state => state.registered && state.state !== 'ENABLED');
  if (broken.length) fail(broken.some(state => state.state === 'INTEGRITY_MISMATCH') ? 'PLUGIN_INTEGRITY_FAILED' : 'PLUGIN_MISSING', { plugins: broken.map(state => ({ name: state.name, state: state.state })) });
  const args = [];
  for (const record of records) {
    args.push('+loadPlugin', record.name);
    // Plugin dvars after loading; the plugin registers them in OnInit.
    for (const [cvar, value] of Object.entries(record.config)) args.push('+set', cvar, value);
  }
  return { args, plugins: records.map(record => ({ name: record.name, sha256: record.sha256 })) };
}

// Install from a local file (no download): copy without overwrite, pin SHA-256.
export async function installPluginFile(instance, sourcePath) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || /[\x00-\x1f]/.test(sourcePath)) fail('PLUGIN_SOURCE_INVALID');
  const ext = pluginExtension(instance.platform);
  const base = path.basename(sourcePath);
  if (!base.toLowerCase().endsWith(ext)) fail('PLUGIN_WRONG_PLATFORM');
  const name = validPluginName(base.slice(0, -ext.length));
  const source = await hashRegularFile(path.resolve(sourcePath)).catch(() => ({ valid: false, code: 'PLUGIN_SOURCE_INVALID' }));
  if (!source.valid) fail(source.code === 'PLUGIN_FILE_SIZE_INVALID' ? source.code : 'PLUGIN_SOURCE_INVALID');
  const directory = await pluginDirectory(instance);
  const target = path.join(directory, name + ext);
  const existing = await discoverPlugins(instance);
  // Only a same-platform file conflicts; a foreign .so/.dll of the same name does not.
  if (existing.some(file => file.platformMatch && file.name.toLowerCase() === name.toLowerCase())) fail('PLUGIN_EXISTS');
  const temporary = path.join(directory, `.install-${crypto.randomUUID()}`);
  let created = false;
  try {
    await fs.copyFile(path.resolve(sourcePath), temporary, fs.constants.COPYFILE_EXCL); created = true;
    const copied = await hashRegularFile(temporary);
    if (!copied.valid || copied.sha256 !== source.sha256) fail('PLUGIN_INSTALL_VERIFY_FAILED');
    // link is exclusive: it never replaces a file that appeared meanwhile.
    try { await fs.link(temporary, target); } catch (error) { if (error.code === 'EEXIST') fail('PLUGIN_EXISTS'); throw error; }
  } finally { if (created) await fs.unlink(temporary).catch(() => {}); }
  const installed = await hashRegularFile(target);
  if (!installed.valid || installed.sha256 !== source.sha256) fail('PLUGIN_INSTALL_VERIFY_FAILED');
  return { name, sha256: installed.sha256, bytes: installed.bytes };
}

// Removal never deletes: the file moves to plugins/.removed/ for recovery.
export async function retirePluginFile(instance, name) {
  validPluginName(name);
  const directory = await pluginDirectory(instance);
  const file = (await discoverPlugins(instance)).find(entry => entry.platformMatch && entry.name.toLowerCase() === name.toLowerCase());
  if (!file) return null;
  const archive = path.join(directory, '.removed');
  try { await fs.mkdir(archive, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stats = await fs.lstat(archive);
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail('PLUGIN_DIRECTORY_INVALID');
  const target = path.join(archive, `${file.file}.${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.rename(path.join(directory, file.file), target);
  return { archivedAs: path.basename(target) };
}

// Load outcome per plugin from the exact plugin_handler.c console messages.
export function classifyPluginLog(text) {
  const result = {};
  const rules = [
    [/Plugin (\S+) loaded successfully/, 'LOADED'],
    [/No such file found: plugins\/([A-Za-z0-9_]+)\./, 'NOT_FOUND'],
    [/plugins\/([A-Za-z0-9_]+)\.\w+ is not a plugin file or is corrupt/, 'REJECTED_INVALID'],
    [/plugin\.([A-Za-z0-9_]+)\.tmp checksum missmatch/, 'SECUREMODE_REJECTED'],
    [/Failed to load the plugin .*plugin\.([A-Za-z0-9_]+)\.tmp/, 'LOAD_FAILED'],
  ];
  for (const line of String(text || '').split(/\r?\n/)) {
    for (const [pattern, state] of rules) {
      const match = pattern.exec(line);
      if (match) { result[match[1].toLowerCase()] = state; break; }
    }
  }
  return result;
}

// "pluginInfo <name>" response: "^2Plugin version:^7\n<major>.<minor>".
export function parsePluginInfoVersion(text) {
  const match = /Plugin version:\^?7?\s*\n\s*(\d{1,5}\.\d{1,5})/.exec(String(text || '').replace(/\r/g, ''));
  return match ? match[1] : null;
}
