import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { assertValidBaseGame } from './base-game-manager.mjs';

const folders = ['main', 'zone', 'mods', 'plugins', 'usermaps', 'players', 'logs'];
const copy = value => structuredClone(value);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function validId(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) fail('INSTANCE_ID_INVALID', 'Server-ID muss ein sicherer, eindeutiger Kleinbuchstabenname sein.');
  return value;
}
function validPort(value) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) fail('INSTANCE_PORT_INVALID', 'Server-Port muss eine ganze Zahl zwischen 1024 und 65535 sein.');
  return value;
}
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
async function noLink(file, { missing = false } = {}) {
  try { if ((await fs.lstat(file)).isSymbolicLink()) fail('INSTANCE_PATH_ALIAS_BLOCKED', `Verknüpfung/Junction ist für Instanzpfade nicht zulässig: ${file}`); }
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
    socket.once('error', error => { socket.close(); reject(Object.assign(new Error(`UDP-Port ${port} ist nicht verfügbar: ${error.message}`), { code: 'INSTANCE_PORT_UNAVAILABLE' })); });
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
    if (raw.version !== 1 || !Array.isArray(raw.instances)) fail('INSTANCE_REGISTRY_INVALID', 'Ungültige Version oder Struktur der Instanzliste.');
    const loaded = new Map();
    const ports = new Set();
    for (const value of raw.instances) {
      const instance = this.model(value);
      if (value.homePath !== instance.homePath || value.configPath !== instance.configPath || value.savePath !== instance.savePath) fail('INSTANCE_REGISTRY_INVALID', 'Gespeicherte Instanzpfade stimmen nicht mit dem verwalteten Home überein.');
      if (loaded.has(instance.id) || ports.has(instance.port)) fail('INSTANCE_REGISTRY_INVALID', 'Doppelte ID oder Port in der gespeicherten Instanzliste.');
      loaded.set(instance.id, instance); ports.add(instance.port);
    }
    this.instances = loaded; this.ready = true;
  }
  model(input) {
    const id = validId(input?.id);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /["\\\x00-\x1f\x7f]/.test(input.name)) fail('INSTANCE_NAME_INVALID', 'Ungültiger Servername.');
    const platform = input.platform;
    if (!['windows', 'linux'].includes(platform)) fail('INSTANCE_PLATFORM_INVALID', 'Ungültige Serverplattform.');
    const executablePath = input.serverCore?.executablePath;
    const expected = platform === 'windows' ? 'cod4x18_dedrun.exe' : 'cod4x18_dedrun';
    if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath) || (platform === 'linux' ? path.basename(executablePath) : path.basename(executablePath).toLowerCase()) !== expected || /[\x00-\x1f]/.test(executablePath)) fail('INSTANCE_CORE_INVALID', 'Nur der passende Dedicated Core darf ausgewählt werden.');
    if (!['21.2', '21.3', '21.4', '21.5'].includes(input.serverCore.version)) fail('INSTANCE_CORE_VERSION_INVALID', 'Nicht unterstützte Core-Version.');
    if (typeof input.basePath !== 'string' || !path.isAbsolute(input.basePath) || /[\x00-\x1f]/.test(input.basePath)) fail('INSTANCE_BASEPATH_INVALID', 'BaseGame muss ein absoluter Pfad sein.');
    const homePath = path.join(this.root, id);
    if (input.homePath !== undefined && input.homePath !== homePath) fail('INSTANCE_HOME_INVALID', 'Homepath wird ausschließlich aus der Server-ID erzeugt.');
    const policy = input.credentialPolicy === undefined ? { join: 'unclassified', rcon: 'unclassified' } : input.credentialPolicy;
    const requirements = ['none', 'required', 'unclassified'];
    if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(key => !['join', 'rcon'].includes(key)) || !requirements.includes(policy.join) || (Object.hasOwn(policy, 'rcon') && !requirements.includes(policy.rcon))) fail('INSTANCE_CREDENTIAL_POLICY_INVALID', 'Ungültige gespeicherte Credential-Regel.');
    // Join-only registries predate RCON activation metadata. Never infer that
    // their encrypted vault lacks RCON credentials while it is locked.
    const rcon = Object.hasOwn(policy, 'rcon') ? policy.rcon : 'unclassified';
    return { id, name: input.name.trim(), platform, serverCore: { executablePath: path.resolve(executablePath), version: input.serverCore.version }, basePath: path.resolve(input.basePath), homePath, savePath: path.join(homePath, 'players'), configPath: path.join(homePath, 'main', 'server.cfg'), port: validPort(input.port), credentialPolicy: { join: policy.join, rcon }, rcon: { configured: false }, master: { configured: false }, plugins: [], b3: { enabled: false }, createdAt: input.createdAt || new Date().toISOString() };
  }
  ensureReady() { if (!this.ready) fail('INSTANCE_REGISTRY_UNAVAILABLE', 'Instanzliste ist nicht erfolgreich geladen.'); }
  list() { this.ensureReady(); return [...this.instances.values()].map(copy); }
  get(id) { this.ensureReady(); const value = this.instances.get(validId(id)); if (!value) fail('INSTANCE_NOT_FOUND', 'Serverinstanz nicht gefunden.'); return copy(value); }
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
  async setJoinRequirement(expected, join) {
    return this.setCredentialRequirement(expected, 'join', join);
  }
  async setCredentialRequirement(expected, kind, requirement) {
    return this.exclusive(async () => {
      if (!['join', 'rcon'].includes(kind) || !['none', 'required'].includes(requirement)) fail('INSTANCE_CREDENTIAL_POLICY_INVALID', 'Ungültige Credential-Regel.');
      const instance = this.get(expected?.id);
      if (instance.homePath !== expected.homePath || instance.createdAt !== expected.createdAt) fail('INSTANCE_IDENTITY_CONFLICT', 'Instanzidentität wurde geändert.');
      if (instance.credentialPolicy[kind] === requirement) return instance;
      const updated = { ...instance, credentialPolicy: { ...instance.credentialPolicy, [kind]: requirement } };
      const next = new Map(this.instances); next.set(instance.id, updated);
      // Publish only after the registry rename succeeds. No credential value is stored here.
      await this.persist(next);
      return copy(updated);
    });
  }
  async validatePaths(instance, { creating = false } = {}) {
    await assertValidBaseGame(instance.basePath);
    const coreStats = await fs.stat(instance.serverCore.executablePath);
    if (!coreStats.isFile() || coreStats.size === 0) fail('INSTANCE_CORE_INVALID', 'Dedicated Core fehlt oder ist leer.');
    await noLink(this.root, { missing: creating });
    await noLink(instance.homePath, { missing: creating });
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
    if (contains(baseReal, homeReal) || contains(homeReal, baseReal) || contains(coreReal, homeReal) || contains(homeReal, coreReal)) fail('INSTANCE_PATH_OVERLAP', 'Serverhome darf BaseGame oder Core-Verzeichnis nicht überlappen.');
    if (!contains(rootReal, homeReal)) fail('INSTANCE_PATH_ALIAS_BLOCKED', 'Serverhome liegt außerhalb des verwalteten Instanzverzeichnisses.');
    if (!creating) {
      for (const folder of folders) await noLink(path.join(instance.homePath, folder));
      await noLink(instance.configPath);
      if (!(await fs.stat(instance.configPath)).isFile()) fail('INSTANCE_CONFIG_INVALID', 'Serverkonfiguration fehlt.');
    }
  }
  async create(input) {
    return this.exclusive(async () => {
      // A new home (including a clone) never inherits credentials or their policy.
      const instance = this.model({ ...input, credentialPolicy: { join: 'none', rcon: 'none' } });
      if (this.instances.has(instance.id)) fail('INSTANCE_ID_CONFLICT', 'Server-ID ist bereits vorhanden.');
      if ([...this.instances.values()].some(value => value.port === instance.port)) fail('INSTANCE_PORT_CONFLICT', 'Port ist bereits für eine andere Instanz reserviert.');
      await this.validatePaths(instance, { creating: true });
      await this.checkPort(instance.port);
      await fs.mkdir(this.root, { recursive: true });
      try { await fs.mkdir(instance.homePath); }
      catch (error) { if (error.code === 'EEXIST') fail('INSTANCE_HOME_EXISTS', 'Zielverzeichnis existiert bereits; keine Übernahme oder Überschreibung.'); throw error; }
      try {
        for (const folder of folders) await fs.mkdir(path.join(instance.homePath, folder));
        await fs.writeFile(instance.configPath, `// Generated initial configuration; no credentials.\nset sv_hostname "${instance.name}"\nset net_port "${instance.port}"\nset g_log "logs/games_mp.log"\n`, { flag: 'wx', mode: 0o600 });
        const next = new Map(this.instances); next.set(instance.id, instance);
        await this.persist(next);
      } catch (error) {
        const recoveryRoot = path.join(this.root, '.recovery');
        await noLink(recoveryRoot, { missing: true });
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
    return this.create({ ...source, ...input, homePath: undefined, createdAt: undefined });
  }
  async archive(id) {
    return this.exclusive(async () => {
      const instance = this.get(id);
      await this.validatePaths(instance);
      const trash = path.join(this.root, '.trash');
      await noLink(trash, { missing: true });
      await fs.mkdir(trash, { recursive: true });
      const archivedHomePath = path.join(trash, `${id}-${crypto.randomUUID()}`);
      await fs.rename(instance.homePath, archivedHomePath);
      const next = new Map(this.instances); next.delete(id);
      try { await this.persist(next); }
      catch (error) { await fs.rename(archivedHomePath, instance.homePath); throw error; }
      return { id, archivedHomePath, recoverable: true };
    });
  }
}
