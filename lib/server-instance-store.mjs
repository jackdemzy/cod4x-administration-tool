import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { assertValidBaseGame } from './base-game-manager.mjs';
import { normalizeNetwork } from './instance-network.mjs';
import { normalizePluginRecords } from './plugin-manager.mjs';
import { normalizeB3Integration } from './b3-integration.mjs';
import { normalizeB3PluginRecords, normalizeB3PluginsRevision } from './b3-plugin-registry.mjs';

const folders = ['main', 'zone', 'mods', 'plugins', 'usermaps', 'players', 'logs'];
const copy = value => structuredClone(value);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function validId(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) fail('INSTANCE_ID_INVALID', 'Server ID must be a safe, unique lowercase name.');
  return value;
}
function validPort(value) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) fail('INSTANCE_PORT_INVALID', 'Server port must be a whole number between 1024 and 65535.');
  return value;
}
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
// Every path the store opens lies under its managed root (root + checked server ID). The check is
// repeated right before the file system call, so the guarantee holds at the call itself and does not
// rest on the callers alone (CodeQL js/path-injection on #66; test "hostile server IDs ...").
async function noLink(root, file, { missing = false } = {}) {
  const base = path.resolve(root), resolved = path.resolve(file);
  // A direct throw (not fail()), so static analysis sees that nothing past this line runs for such a path.
  let target = base;
  if (resolved !== base) {
    if (!resolved.startsWith(base + path.sep)) throw Object.assign(new Error('Path is outside the managed instance directory.'), { code: 'INSTANCE_PATH_ALIAS_BLOCKED' });
    target = resolved;
  }
  try { if ((await fs.lstat(target)).isSymbolicLink()) fail('INSTANCE_PATH_ALIAS_BLOCKED', `Links/junctions are not allowed for instance paths: ${target}`); }
  catch (error) { if (!(missing && error.code === 'ENOENT')) throw error; }
}
export async function resolveRealFuturePath(file) {
  let ancestor = path.resolve(file), suffix = '';
  while (true) {
    try { return path.join(await fs.realpath(ancestor), suffix); }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
      suffix = path.join(path.basename(ancestor), suffix);
      ancestor = path.dirname(ancestor);
    }
  }
}
export async function assertUdpPortAvailable(port) {
  validPort(port);
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  await new Promise((resolve, reject) => {
    socket.once('error', error => { socket.close(); reject(Object.assign(new Error(`UDP port ${port} is not available: ${error.message}`), { code: 'INSTANCE_PORT_UNAVAILABLE' })); });
    socket.bind({ port, address: '0.0.0.0', exclusive: true }, () => socket.close(resolve));
  });
}

// The registry reserves ports between instances. The UDP probe detects external users;
// it cannot keep an OS reservation while the Dedicated process binds the same port.
export class ServerInstanceStore {
  constructor({ root, registryFile, checkPort = assertUdpPortAvailable }) {
    this.root = path.resolve(root);
    this.registryFile = path.resolve(registryFile);
    this.checkPort = checkPort;
    this.instances = new Map();
    this.ready = false;
    this.queue = Promise.resolve();
  }
  async load() {
    this.ready = false;
    let raw;
    try { raw = JSON.parse(await fs.readFile(this.registryFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; raw = { version: 1, instances: [] }; }
    if (raw.version !== 1 || !Array.isArray(raw.instances)) fail('INSTANCE_REGISTRY_INVALID', 'Invalid version or structure of the instance list.');
    const loaded = new Map();
    const ports = new Set();
    for (const value of raw.instances) {
      const instance = this.model(value);
      if (value.homePath !== instance.homePath || value.configPath !== instance.configPath || value.savePath !== instance.savePath) fail('INSTANCE_REGISTRY_INVALID', 'Stored instance paths do not match the managed home.');
      if (loaded.has(instance.id) || ports.has(instance.port)) fail('INSTANCE_REGISTRY_INVALID', 'Duplicate ID or port in the stored instance list.');
      loaded.set(instance.id, instance); ports.add(instance.port);
    }
    this.instances = loaded; this.ready = true;
  }
  model(input) {
    const id = validId(input?.id);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /["\\\x00-\x1f\x7f]/.test(input.name)) fail('INSTANCE_NAME_INVALID', 'Invalid server name.');
    const platform = input.platform;
    if (!['windows', 'linux'].includes(platform)) fail('INSTANCE_PLATFORM_INVALID', 'Invalid server platform.');
    const executablePath = input.serverCore?.executablePath;
    const expected = platform === 'windows' ? 'cod4x18_dedrun.exe' : 'cod4x18_dedrun';
    if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath) || (platform === 'linux' ? path.basename(executablePath) : path.basename(executablePath).toLowerCase()) !== expected || /[\x00-\x1f]/.test(executablePath)) fail('INSTANCE_CORE_INVALID', 'Only the matching dedicated core may be selected.');
    if (!['21.2', '21.3', '21.4', '21.5'].includes(input.serverCore.version)) fail('INSTANCE_CORE_VERSION_INVALID', 'Unsupported core version.');
    // Audit 4.18.31 (F-1): no "+" either; the core would split the path into an extra command.
    if (typeof input.basePath !== 'string' || !path.isAbsolute(input.basePath) || /[\x00-\x1f+]/.test(input.basePath)) fail('INSTANCE_BASEPATH_INVALID', 'BaseGame must be an absolute path without "+".');
    const homePath = path.join(this.root, id);
    if (input.homePath !== undefined && input.homePath !== homePath) fail('INSTANCE_HOME_INVALID', 'The homepath is derived from the server ID only.');
    return { id, name: input.name.trim(), platform, serverCore: { executablePath: path.resolve(executablePath), version: input.serverCore.version }, basePath: path.resolve(input.basePath), homePath, savePath: path.join(homePath, 'players'), configPath: path.join(homePath, 'main', 'server.cfg'), port: validPort(input.port), network: normalizeNetwork(input.network), rcon: { configured: false }, master: { configured: false }, plugins: normalizePluginRecords(input.plugins, platform), b3: { enabled: false }, b3Integration: normalizeB3Integration(input.b3Integration), b3Plugins: normalizeB3PluginRecords(input.b3Plugins), b3PluginsRevision: normalizeB3PluginsRevision(input.b3PluginsRevision), createdAt: input.createdAt || new Date().toISOString() };
  }
  ensureReady() { if (!this.ready) fail('INSTANCE_REGISTRY_UNAVAILABLE', 'The instance list did not load.'); }
  list() { this.ensureReady(); return [...this.instances.values()].map(copy); }
  get(id) { this.ensureReady(); const value = this.instances.get(validId(id)); if (!value) fail('INSTANCE_NOT_FOUND', 'Server instance not found.'); return copy(value); }
  async exclusive(action) {
    const result = this.queue.then(() => { this.ensureReady(); return action(); });
    this.queue = result.catch(() => {}); return result;
  }
  async persist(next) {
    await fs.mkdir(path.dirname(this.registryFile), { recursive: true });
    const temp = `${this.registryFile}.tmp-${crypto.randomUUID()}`;
    await fs.writeFile(temp, JSON.stringify({ version: 1, instances: [...next.values()] }, null, 2), { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, this.registryFile);
    this.instances = next;
  }
  async validatePaths(instance, { creating = false } = {}) {
    await assertValidBaseGame(instance.basePath);
    const coreStats = await fs.stat(instance.serverCore.executablePath);
    if (!coreStats.isFile() || coreStats.size === 0) fail('INSTANCE_CORE_INVALID', 'Dedicated core is missing or empty.');
    await noLink(this.root, this.root, { missing: creating });
    await noLink(this.root, instance.homePath, { missing: creating });
    const baseReal = await fs.realpath(instance.basePath);
    let rootReal;
    try { rootReal = await fs.realpath(this.root); }
    catch (error) {
      if (!(creating && error.code === 'ENOENT')) throw error;
      // Find the real existing ancestor before creating any instance directory.
      let ancestor = path.dirname(this.root), suffix = path.basename(this.root);
      while (true) {
        try { rootReal = path.join(await fs.realpath(ancestor), suffix); break; }
        catch (cause) { if (cause.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw cause; suffix = path.join(path.basename(ancestor), suffix); ancestor = path.dirname(ancestor); }
      }
    }
    const homeReal = creating ? path.join(rootReal, instance.id) : await fs.realpath(instance.homePath);
    const coreReal = await fs.realpath(path.dirname(instance.serverCore.executablePath));
    if (contains(baseReal, homeReal) || contains(homeReal, baseReal) || contains(coreReal, homeReal) || contains(homeReal, coreReal)) fail('INSTANCE_PATH_OVERLAP', 'The server home must not overlap BaseGame or the core directory.');
    if (!contains(rootReal, homeReal)) fail('INSTANCE_PATH_ALIAS_BLOCKED', 'The server home is outside the managed instance directory.');
    if (!creating) {
      for (const folder of folders) await noLink(this.root, path.join(instance.homePath, folder));
      await noLink(this.root, instance.configPath);
      const configFile = path.resolve(instance.configPath), home = path.resolve(this.root);
      if (!configFile.startsWith(home + path.sep)) throw Object.assign(new Error('Path is outside the managed instance directory.'), { code: 'INSTANCE_PATH_ALIAS_BLOCKED' });
      if (!(await fs.stat(configFile)).isFile()) fail('INSTANCE_CONFIG_INVALID', 'Server configuration is missing.');
    }
  }
  async create(input) {
    return this.exclusive(async () => {
      const instance = this.model(input);
      if (this.instances.has(instance.id)) fail('INSTANCE_ID_CONFLICT', 'Server ID already exists.');
      if ([...this.instances.values()].some(value => value.port === instance.port)) fail('INSTANCE_PORT_CONFLICT', 'Port is already reserved for another instance.');
      await this.validatePaths(instance, { creating: true });
      await this.checkPort(instance.port);
      await fs.mkdir(this.root, { recursive: true });
      // A2-2 (security audit 4.18.26): logs in the home can hold typed B3 passwords; keep it private.
      try { await fs.mkdir(instance.homePath, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') fail('INSTANCE_HOME_EXISTS', 'Target directory already exists; nothing adopted or overwritten.'); throw error; }
      try {
        for (const folder of folders) await fs.mkdir(path.join(instance.homePath, folder));
        await fs.writeFile(instance.configPath, `// Generated initial configuration; no credentials.\nset sv_hostname "${instance.name}"\nset net_port "${instance.port}"\nset g_log "logs/games_mp.log"\n`, { flag: 'wx', mode: 0o600 });
        const next = new Map(this.instances); next.set(instance.id, instance);
        await this.persist(next);
      } catch (error) {
        const recoveryRoot = path.join(this.root, '.recovery');
        await noLink(this.root, recoveryRoot, { missing: true });
        await fs.mkdir(recoveryRoot, { recursive: true });
        await fs.rename(instance.homePath, path.join(recoveryRoot, `${instance.id}-${crypto.randomUUID()}`));
        throw error;
      }
      return copy(instance);
    });
  }
  async clone(id, input) {
    const source = this.get(id);
    // Clone definition, not logs, user data, arbitrary files or future credentials.
    // Public exposure is never inherited: it must be enabled per instance.
    // Plugin approvals are bound to files in the source home and are not cloned either.
    return this.create({ ...source, ...input, network: undefined, plugins: undefined, b3Plugins: undefined, b3PluginsRevision: undefined, homePath: undefined, createdAt: undefined });
  }
  async setNetwork(id, network) {
    return this.exclusive(async () => {
      const current = this.get(id);
      const instance = { ...current, network: normalizeNetwork(network) };
      const next = new Map(this.instances); next.set(id, instance);
      await this.persist(next);
      return copy(instance);
    });
  }
  async setB3Integration(id, settings) {
    const b3Integration = normalizeB3Integration(settings);
    return this.exclusive(async () => {
      const current = this.get(id);
      const instance = { ...current, b3Integration };
      const next = new Map(this.instances); next.set(id, instance);
      await this.persist(next);
      return copy(instance);
    });
  }
  // Always bumps the revision by exactly 1, even for an identical list (config saves use this to signal a change).
  async setB3Plugins(id, records) {
    const b3Plugins = normalizeB3PluginRecords(records);
    return this.exclusive(async () => {
      const current = this.get(id);
      const instance = { ...current, b3Plugins, b3PluginsRevision: current.b3PluginsRevision + 1 };
      const next = new Map(this.instances); next.set(id, instance);
      await this.persist(next);
      return copy(instance);
    });
  }
  async setPlugins(id, plugins) {
    return this.exclusive(async () => {
      const current = this.get(id);
      const instance = { ...current, plugins: normalizePluginRecords(plugins, current.platform) };
      const next = new Map(this.instances); next.set(id, instance);
      await this.persist(next);
      return copy(instance);
    });
  }
  // Block 21: puts back the whole record of a restore point. Same id and home only; the record passes
  // the same model checks as a new instance and keeps its port free of the other instances.
  // fields: only these fields of record replace today's values (read and written under the store lock).
  async #checkedRecord(id, record, fields = null) {
    const current = this.get(id);
    if (!record || typeof record !== 'object' || record.id !== id || record.homePath !== current.homePath) fail('INSTANCE_RECORD_INVALID', 'Restore point does not belong to this instance.');
    const model = this.model(fields ? { ...current, ...Object.fromEntries(fields.map(field => [field, record[field]])) } : record);
    const instance = { ...model, b3PluginsRevision: Math.max(current.b3PluginsRevision, model.b3PluginsRevision) + 1 };
    if ([...this.instances.values()].some(value => value.id !== id && value.port === instance.port)) fail('INSTANCE_PORT_CONFLICT', 'Port is already reserved for another instance.');
    await this.validatePaths(instance);
    return instance;
  }
  // The same checks as replaceRecord without writing (before a restore touches any file).
  async checkRecord(id, record, fields = null) {
    return this.exclusive(async () => { await this.#checkedRecord(id, record, fields); });
  }
  async replaceRecord(id, record, fields = null) {
    return this.exclusive(async () => {
      const instance = await this.#checkedRecord(id, record, fields);
      const next = new Map(this.instances); next.set(id, instance);
      await this.persist(next);
      return copy(instance);
    });
  }
  // Block 21: local core change. The new core passes the same rules as at creation.
  async setCore(id, serverCore) {
    return this.exclusive(async () => {
      const current = this.get(id);
      const instance = this.model({ ...current, serverCore });
      await this.validatePaths(instance);
      const next = new Map(this.instances); next.set(id, instance);
      await this.persist(next);
      return copy(instance);
    });
  }
  async archive(id) {
    return this.exclusive(async () => {
      const instance = this.get(id);
      await this.validatePaths(instance);
      const trash = path.join(this.root, '.trash');
      await noLink(this.root, trash, { missing: true });
      await fs.mkdir(trash, { recursive: true });
      const homePath = path.resolve(instance.homePath), archivedHomePath = path.resolve(trash, `${id}-${crypto.randomUUID()}`);
      if (!homePath.startsWith(this.root + path.sep) || !archivedHomePath.startsWith(this.root + path.sep)) fail('INSTANCE_HOME_INVALID', 'The instance home is outside the managed root.');
      await fs.rename(homePath, archivedHomePath);
      const next = new Map(this.instances); next.delete(id);
      try { await this.persist(next); }
      catch (error) { await fs.rename(archivedHomePath, homePath); throw error; }
      return { id, archivedHomePath, recoverable: true };
    });
  }
}
